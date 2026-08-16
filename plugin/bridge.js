/**
 * 视觉桥核心编排:读字节(经 ctx.fs,与官方 read_image 同一沙箱解析)→ 缓存 → 后端 → 文本。
 *
 * 路径解析照抄官方 read_image(出处:$DSH/dsh-tool-fs/lib/index.js:1015-1018):
 *   ctx.fs.resolve(path, { cwd, signal }) → ctx.fs.stat → ctx.fs.readBytes(target, signal, byteCap)
 * 这样相对路径按会话工作目录解析、路径受沙箱约束,与原生 read_image 行为一致。
 */

import { basename, extname } from 'node:path';
import { sha256Hex, TtlCache } from './cache.js';
import { createBackend } from './backends/index.js';
import { bytesToDataUrl } from './backends/common.js';

/** read_image 接受的扩展名 ↔ mediaType(照抄官方 IMAGE_EXTENSIONS)。 */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 未挂载 attachments 服务时的兜底字节上限(官方取附件限额的最小值)。 */
const DEFAULT_BYTE_CAP = 15 * 1024 * 1024;

/** 结果包装:读到的文本在会话里的稳定标记格式(借鉴 deepseek-v4-for-copilot 的 MIT 实现)。 */
export const IMAGE_DESCRIPTION_PREFIX = '[Image Description: ';
export const IMAGE_DESCRIPTION_SUFFIX = ']';
export const IMAGE_DESCRIPTION_UNAVAILABLE = '[Image Description unavailable]';

/**
 * 经 ctx.fs 读取图片字节(与官方 read_image 同一路径解析与沙箱)。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @param {string} filePath 模型提供的原始路径
 * @returns {Promise<{ bytes: Uint8Array; mediaType: string; displayPath: string }>}
 */
export async function readImageBytes(ctx, exec, filePath) {
  const cwd = exec.agent?.session?.header?.cwd;
  const resolveOpts =
    cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal };
  const target = await ctx.fs.resolve(filePath, resolveOpts);
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) throw new Error(`cannot read "${filePath}": not found`);
  if (info.type !== 'file') throw new Error(`cannot read "${filePath}": not a regular file`);
  const mediaType = IMAGE_EXTENSIONS[extname(target.displayPath).toLowerCase()];
  if (mediaType === undefined) {
    throw new Error(`cannot read "${filePath}": only PNG/JPEG/WebP/GIF images are accepted`);
  }
  const attachments = ctx.get('attachments');
  const limits = attachments?.imageLimits;
  const byteCap = limits
    ? Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)
    : DEFAULT_BYTE_CAP;
  const bytes = await ctx.fs.readBytes(target, exec.signal, byteCap);
  return { bytes, mediaType, displayPath: target.displayPath };
}

/**
 * 执行一次视觉桥(核心,后端可注入):读图 → 缓存命中直接返回,否则调用后端并写入缓存。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @param {{ file_path: string; mode?: 'ocr'|'describe'|'vqa'; question?: string }} args
 * @param {{ id: string, convert(req): Promise<{ text: string; model: string; latencyMs?: number }> }} backend
 * @param {TtlCache} cache
 * @returns {Promise<{ text: string; mode: string; source: string; cached: boolean; latencyMs?: number; displayPath: string }>}
 */
export async function runBridgeWithBackend(ctx, exec, args, backend, cache) {
  const { bytes, mediaType, displayPath } = await readImageBytes(ctx, exec, args.file_path);
  const mode = args.mode ?? 'describe';
  const question = String(args.question ?? '').trim();
  const backendRoute = `${backend.id}:${backend.opts?.visionProvider ?? ''}/${backend.opts?.visionModel ?? backend.model ?? ''}`;
  const key = `vision-bridge-v2:${backendRoute}:${sha256Hex(bytes)}:${mode}:${question}`;

  const hit = cache.get(key);
  if (hit !== undefined) {
    return { ...hit, cached: true, displayPath };
  }

  const result = await backend.convert({
    imageBase64: bytesToDataUrl(bytes, mediaType),
    mimeType: mediaType,
    mode,
    question: question || undefined,
    signal: exec.signal,
    // harness 后端要原始字节 + 上下文(走 attachments + ctx.llm,不自己发 HTTP);
    // 其余后端忽略这三个字段。
    bytes,
    displayName: basename(displayPath),
    ctx,
    exec,
  });

  const entry = {
    text: result.text,
    mode,
    source: `${backend.id}:${result.model}`,
    latencyMs: result.latencyMs,
  };
  cache.set(key, entry);
  return { ...entry, cached: false, displayPath };
}

/**
 * 执行一次视觉桥(按配置实例化后端)。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @param {{ file_path: string; mode?: 'ocr'|'describe'|'vqa'; question?: string }} args
 * @param {object} backendConfig 合并后的后端配置(见 index.js)
 * @param {TtlCache} cache
 */
export async function runBridge(ctx, exec, args, backendConfig, cache) {
  const backend = createBackend(backendConfig);
  return runBridgeWithBackend(ctx, exec, args, backend, cache);
}

/** 组装模型可见的桥接结果文本(与官方 read_image 的 envelope 同风格,标记为 bridged)。 */
export function renderEnvelope(filePath, value) {
  const description =
    value.text?.trim() || IMAGE_DESCRIPTION_UNAVAILABLE;
  const body = `${IMAGE_DESCRIPTION_PREFIX}${description}${IMAGE_DESCRIPTION_SUFFIX}`;
  return (
    `<path>${value.displayPath ?? filePath}</path>\n` +
    `<type>vision-bridged</type>\n` +
    `<mode>${value.mode}</mode>\n` +
    `<source>${value.source}</source>\n` +
    `<cached>${String(value.cached)}</cached>\n` +
    `<content>\n${body}\n</content>\n` +
    `(当前模型为纯文本模型,图片已由视觉代理 ${value.source} 描述为文本)`
  );
}
