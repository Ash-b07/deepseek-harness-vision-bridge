/**
 * Harness 视觉后端 —— 视觉桥唯一后端(用户确认:只用 DSH 已配置的模型)。
 *
 * 原理:不自己发任何 HTTP 请求,而是复用 DSH 自己的模型运行时:
 *   1. 把图片字节经附件服务落成 durable ref(attachments.saveImage);
 *   2. 用 ctx.llm.stream() 向「settings.yaml 里已配置的路由/模型」(默认
 *      opencode / mimo-v2.5-free)发一条含图片块 + 模式提示词的用户消息;
 *   3. 收集 text-delta(以及无 delta 时的 block-end 兜底)文本返回 —— 走的是
 *      pi-ai 适配器,与用户自己选中该模型聊天完全同一条链路(API Key、配额、
 *      计费口径都复用,插件零 Key)。
 *
 * 能力闸门:不做 resolveModelInfo 前置判断 —— pi-ai 的 stream() 本身就会在模型
 * 未声明 image 输入时以 UNSUPPORTED_CONTENT 失败(dsh-llm-pi-ai/lib/index.js:827),
 * 以该 finish-error 为准,翻译成可操作报错(提示在 settings.yaml 补 input: [text, image])。
 */

import { buildPrompt } from './common.js';

let messageSeq = 0;

export class HarnessVisionBackend {
  constructor(opts = {}) {
    /** @type {{ visionProvider?: string; visionModel?: string; maxTokens?: number }} */
    this.opts = opts;
  }

  get id() {
    return 'harness';
  }

  /**
   * @param {object} req bridge.js 传入的请求(含原始字节与执行上下文)
   * @param {Uint8Array} req.bytes 图片字节
   * @param {string} req.mimeType 图片 mediaType
   * @param {string} [req.displayName] 展示名
   * @param {import('@deepseek-ai/cordis').Context} req.ctx 插件上下文
   * @param {import('@deepseek-ai/dsh-tools').ToolExecution} req.exec 工具执行上下文
   * @param {'ocr'|'describe'|'vqa'} req.mode 模式
   * @param {string} [req.question] vqa 问题
   * @returns {Promise<{ text: string; provider: string; model: string; latencyMs: number }>}
   */
  async convert(req) {
    const started = Date.now();
    const { ctx, exec } = req;
    const provider = this.opts.visionProvider;
    const model = this.opts.visionModel;

    if (!provider || !model) {
      throw new Error(
        'harness 视觉后端配置缺失:请配置 visionProvider 与 visionModel ' +
          '(默认 opencode / mimo-v2.5-free,即 settings.yaml 的 llm-pi-ai 下已配置的路由)。',
      );
    }

    const attachments = ctx.get('attachments');
    if (!attachments) {
      throw new Error(
        'harness 视觉后端需要附件服务已挂载(attachments);请确认 profile 已启用 dsh-attachment-local。',
      );
    }

    // 1) 图片字节 → durable 附件引用(与官方 read_image 同一落盘路径)
    const ref = await attachments.saveImage({
      data: req.bytes,
      mediaType: req.mimeType,
      ...(req.displayName ? { name: req.displayName } : {}),
    });

    // 2) 走 DSH 模型运行时:图片块在前、提示词在后,消息标明插件来源
    const prompt = buildPrompt(req.mode, req.question);
    const message = {
      id: `vision-bridge-${++messageSeq}`,
      role: 'user',
      content: [
        { type: 'image', attachment: ref },
        { type: 'text', text: prompt },
      ],
      source: { kind: 'plugin', plugin: 'vision-bridge' },
    };

    // 3) 收集文本;流式失败(pi-ai 抛错或 finish-error)翻译成可操作报错
    let text = '';
    let failure;
    try {
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        messages: [message],
        ...(this.opts.maxTokens ? { maxTokens: this.opts.maxTokens } : {}),
        signal: exec.signal,
      })) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text === '') {
          text = String(chunk.block.text ?? '');
        } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          failure = chunk.reason.failure;
        }
      }
    } catch (err) {
      failure = {
        message: err instanceof Error ? err.message : String(err),
        code: err?.code ?? 'LLM_STREAM_FAILED',
      };
    }

    if (failure) {
      const isImageUnsupported =
        failure.code === 'UNSUPPORTED_CONTENT' ||
        /image input|image content|does not support image/i.test(failure.message);
      if (isImageUnsupported) {
        throw new Error(
          `视觉模型 ${provider}/${model} 不支持图片输入(pi-ai 报 ${failure.code})。` +
            `若该模型确实支持图片,请在 settings.yaml 的 llm-pi-ai 配置里为其补 input: [text, image]` +
            `(pi-ai 按模型目录声明能力,未声明时默认仅 text)。`,
        );
      }
      throw new Error(`视觉模型调用失败(${provider}/${model}):${failure.message}`);
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(`视觉模型 ${provider}/${model} 返回空内容,请检查模型是否可用`);
    }

    return {
      text: trimmed,
      provider: this.id,
      model: `${provider}/${model}`,
      latencyMs: Date.now() - started,
    };
  }
}
