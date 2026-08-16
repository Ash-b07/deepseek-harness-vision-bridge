/**
 * vision-bridge · DeepSeek Harness 视觉增强 2.0。
 *
 * 目标:纯文本模型(deepseek-v4-flash / deepseek-v4-pro)在任务推理中
 * 遇到图片时「无体感」地调用 DSH 里**已经配置好的视觉模型**(如 opencode/mimo-v2.5-free):
 *
 *   1. 上传图片入口(llm/stream):图片 → 独立视觉模型 → observation 文本 → 原主模型;
 *   2. read_image 拦截钩子(tools/execute):
 *      - 模型声明支持 image → return next(),原生直通,零开销、插件完全透明;
 *      - 纯文本路由 → 插件接管:读图 → 经 ctx.llm 调已配置的视觉模型 → 文本描述喂回模型,
 *        模型拿到的是一段文字,而不是「当前模型不支持图片」的报错。
 *   3. vision_bridge 显式工具:
 *      模型可主动调用,支持 mode=ocr / describe / vqa。
 *
 * 关键实现约束(踩坑后修正,勿回退):
 *   - tools/execute 钩子对 read_image 只能返回**失败结果**(isError: true):成功结果会被
 *     normalizeDispatchResult() 用 read_image 自己的 output.schema 重新校验/渲染
 *     (dsh-tools/lib/index.js:3429-3444),value 必然违规 → ToolOutputError 崩掉整轮;
 *     失败结果才原样透传 content。桥接文本挂在失败结果的 content 上。
 *   - ctx.tools.register() 是原始注册口,parameters 必须是完整对象根 JSON Schema
 *     (type/required/properties),不能用 {名字: 规格} 属性表写法,否则发给模型的
 *     function schema 缺 type,DeepSeek 侧会拒掉整轮请求。
 *
 * 加载方式:profile 的 cordis.patch.yml(见 视觉插件/install-plugin.sh)。
 * 配置:patch 行 config 优先 > 视觉插件/config.local.json > 默认值。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeSupportsImage } from './capability.js';
import { renderEnvelope, runBridge } from './bridge.js';
import { VISION_MODES } from './backends/common.js';
import { createAutoVisionHook } from './auto-bridge.js';
import { TtlCache } from './cache.js';

/** Cordis 插件名(loader 诊断用)。 */
export const name = 'vision-bridge';

/** 声明依赖的服务:llm(能力判断)/ tools(注册)/ fs(读字节);attachments 可选。 */
export const inject = ['llm', 'tools', 'fs', 'settings'];

/** Host 与 Client 共用的持久设置命名空间。 */
export const VISION_SETTINGS_NAMESPACE = 'vision-bridge';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** 读取视觉插件/config.local.json(已 gitignore)。 */
function loadLocalConfig() {
  try {
    const path = join(PLUGIN_DIR, '..', 'config.local.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** 合并 patch 行 config(优先)与 config.local.json(其次)与默认值。 */
function mergeConfig(patchConfig) {
  const local = loadLocalConfig();
  return {
    enabled: true,
    // 视觉桥后端 = DSH 已配置的模型路由(settings.yaml 的 llm-pi-ai 下)
    visionProvider: 'opencode',
    visionModel: 'mimo-v2.5-free',
    maxTokens: undefined, // 不设即用该模型在 settings.yaml 里配置的默认值
    cacheTtlMs: 6 * 60 * 60 * 1000,
    ...local,
    ...patchConfig,
  };
}

/**
 * 注册视觉增强的持久设置。Schemastery 从 profile 的模块图解析，插件目录无需复制依赖。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof mergeConfig>} cfg
 */
function registerVisionSettings(ctx, cfg) {
  const initial = {
    enabled: cfg.enabled !== false,
    route: {
      provider: String(cfg.visionProvider || 'opencode'),
      model: String(cfg.visionModel || 'mimo-v2.5-free'),
    },
    ...(cfg.maxTokens ? { maxTokens: Number(cfg.maxTokens) } : {}),
  };
  // settings 是可热重载的服务，必须通过 ctx.inject 挂接；apply 时直接 ctx.get/ctx.settings
  // 可能尚未拿到它。source 在服务缺席时仍回退到组合配置。
  let source = () => initial;
  ctx.inject(['settings'], (sctx) => {
    const require = createRequire(sctx.baseUrl ?? ctx.baseUrl ?? import.meta.url);
    const loaded = require('@deepseek-ai/schemastery');
    const Schema = loaded.default ?? loaded;
    const schema = Schema.object({
      enabled: Schema.boolean(),
      route: Schema.object({
        provider: Schema.string(),
        model: Schema.string(),
      }),
      maxTokens: Schema.number(),
    });
    const scope = sctx.settings.register(VISION_SETTINGS_NAMESPACE, schema, {
      base: initial,
      applies: 'live',
      validate(value) {
        if (!value?.route?.provider?.trim() || !value?.route?.model?.trim()) {
          throw new TypeError('视觉增强需要有效的 provider/model 路由');
        }
        if (value.maxTokens !== undefined && (!Number.isInteger(value.maxTokens) || value.maxTokens <= 0)) {
          throw new TypeError('maxTokens 必须是正整数');
        }
      },
    });
    source = () => scope.get();
    sctx.effect(() => () => {
      source = () => initial;
    });
  });
  return { get: () => source() };
}

/** 组装后端配置(harness 后端:复用 settings.yaml 的路由,插件零 Key)。 */
function buildBackendConfig(cfg) {
  return {
    visionProvider: cfg.visionProvider,
    visionModel: cfg.visionModel,
    maxTokens: cfg.maxTokens,
  };
}

/** 模型可见的 vision_bridge 工具说明。 */
const VISION_BRIDGE_DESCRIPTION =
  '对图片执行视觉理解(OCR 文字提取 / 场景描述 / 视觉问答),返回文本结果。' +
  '当前模型不支持图片输入时,这是读取图片内容的正确入口:read_image 会被官方闸门拒绝,' +
  '本工具则把图片交给视觉模型、只把文字喂回来。' +
  'mode=describe 返回场景描述(默认),mode=ocr 返回图片中的全部文字,mode=vqa 需配合 question 参数。';

/**
 * Cordis apply:注册工具 + 挂 read_image 拦截钩子。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [patchConfig] cordis.patch.yml 中该行的 config(可选)
 */
export function apply(ctx, patchConfig = {}) {
  const cfg = mergeConfig(patchConfig);
  const visionSettings = registerVisionSettings(ctx, cfg);
  const cache = new TtlCache({ ttlMs: cfg.cacheTtlMs });
  const backendConfig = () => {
    const current = visionSettings.get();
    return buildBackendConfig({
      visionProvider: current.route.provider,
      visionModel: current.route.model,
      maxTokens: current.maxTokens,
    });
  };

  // ── 0) 自动上传桥接:不是 Provider,不会污染主模型目录 ───────────────────
  ctx.on(
    'llm/stream',
    createAutoVisionHook(ctx, visionSettings, { ttlMs: cfg.cacheTtlMs }),
    { global: true },
  );

  // ── 1) 显式工具 vision_bridge ─────────────────────────────────────────────
  ctx.tools.register({
    name: 'vision_bridge',
    description: VISION_BRIDGE_DESCRIPTION,
    // 注意:ctx.tools.register() 是「原始」注册口,parameters 必须已经是一份
    // 对象根 JSON Schema(官方内建工具走 defineTool(),由它把 {名字: 规格} 的
    // 属性表编译成 JSON Schema)。这里直接手写 Schema —— 若退回属性表写法,
    // 发给模型的 function schema 就没有 type,DeepSeek 侧会以
    // `Invalid schema for function 'vision_bridge': ... got 'type: null'` 拒掉整轮请求。
    parameters: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: {
          type: 'string',
          description: '图片文件路径(绝对路径,或相对当前会话工作目录)',
        },
        mode: {
          type: 'string',
          enum: ['ocr', 'describe', 'vqa'],
          description: '视觉任务模式:ocr=提取文字 / describe=场景描述(默认) / vqa=视觉问答',
        },
        question: {
          type: 'string',
          description: 'mode=vqa 时的具体问题(可选)',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'mode', 'source'],
        properties: {
          text: { type: 'string' },
          mode: { type: 'string' },
          source: { type: 'string' },
          cached: { type: 'boolean' },
          latencyMs: { type: 'integer' },
        },
      },
      render: (args, value) => [
        { type: 'text', text: renderEnvelope(String(args.file_path ?? ''), value) },
      ],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // 原始注册口不做参数校验(defineTool 才校验),这里自己收口一次
      const filePath = String(args?.file_path ?? '').trim();
      if (!filePath) throw new Error('vision_bridge: file_path 必填,应为图片文件路径');
      const mode = VISION_MODES.includes(args?.mode) ? args.mode : 'describe';
      const question = args?.question === undefined ? undefined : String(args.question);
      const value = await runBridge(
        ctx,
        exec,
        { file_path: filePath, mode, question },
        backendConfig(),
        cache,
      );
      return { text: value.text, mode, source: value.source, cached: value.cached };
    },
  });

  // ── 2) read_image 拦截钩子(tools/execute,around 分发)─────────────────────
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'read_image') return next(); // 只关心 read_image,其余放行
    if (await routeSupportsImage(ctx, exec)) return next(); // 原生支持:零开销直通

    // 纯文本路由:原生 read_image 必然被官方闸门拒绝 → 插件接管,跑视觉桥
    const filePath = String(exec.arguments?.file_path ?? '');
    if (!filePath.trim()) return next(); // 参数无效:交给官方工具报错

    try {
      const value = await runBridge(
        ctx,
        exec,
        { file_path: filePath, mode: 'describe' },
        backendConfig(),
        cache,
      );
      // 这里只能返回 isError 结果 —— 不是偷懒,是注册表的硬约束:
      // tools/execute 钩子返回的「成功」结果会被 normalizeDispatchResult() 拿去重跑
      // createSuccessResult(exec, read_image 定义, value)(dsh-tools/lib/index.js:3429),
      // 也就是拿 read_image 自己的 output.schema 校验我们的 value(必然违规 → ToolOutputError),
      // 就算凑齐 {path,image} 骗过校验,render 也是 read_image 的 → 产出 ImageBlock →
      // 纯文本模型的适配器在下一次请求直接拒掉整轮。失败结果则原样透传 content(同文件 :3431),
      // 所以「桥接文本」只能挂在失败结果上。
      // 模型侧体验:调用标红,但拿到的是完整图片描述 + 下一步指引,不需要重试。
      // 真正干净的入口是 vision_bridge(成功结果 + 本插件自己的 schema/render)。
      return {
        isError: true,
        error: {
          message: `read_image bridged by vision-bridge (${value.source})`,
          info: { name: 'VisionBridged', code: 'VISION_BRIDGED' },
        },
        content: [
          {
            type: 'text',
            text:
              'read_image 在当前模型上不可用(该模型未声明图片输入),已由 vision-bridge 自动改用视觉模型' +
              '把这张图转成文本 —— 下面就是图片内容,可直接使用,不要重试 read_image。\n' +
              '后续图片请直接调用 vision_bridge 工具(mode=describe/ocr/vqa),那条路是正常返回。\n\n' +
              renderEnvelope(filePath, value),
          },
        ],
      };
    } catch (err) {
      const message = `vision bridge failed: ${err instanceof Error ? err.message : String(err)}`;
      return {
        isError: true,
        error: { message, info: { name: 'VisionBridgeError', code: 'VISION_BRIDGE_FAILED' } },
        content: [{ type: 'text', text: message }],
      };
    }
  });
}
