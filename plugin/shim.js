/**
 * vision-bridge · 2.0 适配器 shim —— 让「上传图片」也走桥接,达成真正的无体感。
 *
 * 背景:1.0 只覆盖了 read_image 工具入口;用户直接拖图上传时,客户端预检在模型介入
 * 之前就按路由的 inputModalities 拦截(MODEL_DOES_NOT_SUPPORT_IMAGES)。要让上传放行,
 * 唯一干净的办法是让**路由自己声明 image 能力**——这就是本 shim:
 *
 *   - 注册一条新 provider 路由 `vision-bridge`,声明 inputModalities: ['text', 'image'];
 *   - 会话切到该路由后:上传预检放行、read_image 闸门放行(原生路径);
 *   - 本适配器的 stream() 在把消息转发给 DeepSeek 之前,把每个图片块经
 *     ctx.llm 调「已配置的视觉模型」(默认 opencode/mimo-v2.5-free)转成文本描述,
 *     再以纯文本消息转发给 deepseek-official 同名模型(复用官方适配器,含 attribution)。
 *
 * 实现约束:
 *   - 零运行时依赖:不 import @deepseek-ai/*(插件经符号链接加载,真实路径在工作区,
 *     node_modules 解析不到),registerAdapter 接受纯对象(无 instanceof 检查),
 *     stream() 直接鸭子调用;
 *   - 转发用 ctx.llm.stream 而不是自己发 HTTP:复用官方 deepseek 适配器的
 *     鉴权/重试/attribution/流式协议,不重复造轮子;
 *   - 图片块转换复用 vision 模型链路:与 vision_bridge 工具、read_image 桥接同一套
 *     ctx.llm.stream(opencode/mimo)调用,同一份能力报错翻译。
 */

import { buildPrompt } from './backends/common.js';

/** 转发目标:deepseek-official 上的同名模型(用户切到 vision-bridge 路由时选同一个模型 id)。 */
const INNER_PROVIDER = 'deepseek-official';

/**
 * 构造 vision-bridge 适配器(纯对象,鸭子类型满足 LlmAdapter 接口)。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ visionProvider?: string; visionModel?: string }} cfg
 * @returns {{ providerInfo(p): object, providerRetryPolicy(): undefined, listModels(p): Promise<object[]>, resolveModel(p,m): Promise<object>, stream(options): AsyncIterable<object> }}
 */
export function createVisionBridgeAdapter(ctx, cfg) {
  const visionProvider = cfg.visionProvider ?? 'opencode';
  const visionModel = cfg.visionModel ?? 'mimo-v2.5-free';

  /** 把一个 durable 图片附件引用转成文本描述(走 DSH 已配置的视觉模型)。 */
  async function describeAttachment(ref, signal) {
    const attachments = ctx.get('attachments');
    if (!attachments) {
      throw new Error(
        'vision-bridge shim:需要附件服务已挂载(attachments);请确认 profile 已启用 dsh-attachment-local。',
      );
    }
    const message = {
      id: `vision-bridge-shim-${Math.random().toString(36).slice(2, 10)}`,
      role: 'user',
      content: [
        { type: 'image', attachment: ref },
        { type: 'text', text: buildPrompt('describe') },
      ],
      source: { kind: 'plugin', plugin: 'vision-bridge' },
    };

    let text = '';
    let failure;
    try {
      for await (const chunk of ctx.llm.stream({
        provider: visionProvider,
        model: visionModel,
        messages: [message],
        signal,
      })) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
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
          `视觉模型 ${visionProvider}/${visionModel} 不支持图片输入(pi-ai 报 ${failure.code})。` +
            `若该模型确实支持图片,请在 settings.yaml 的 llm-pi-ai 配置里为其补 input: [text, image]。`,
        );
      }
      throw new Error(`视觉模型调用失败(${visionProvider}/${visionModel}):${failure.message}`);
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(`视觉模型 ${visionProvider}/${visionModel} 返回空内容,请检查模型是否可用`);
    }
    return trimmed;
  }

  /** 把一条消息里的图片块逐个替换为文本描述(保持其它块原样)。 */
  async function convertImageBlocks(blocks, signal) {
    const out = [];
    for (const block of blocks) {
      if (block?.type !== 'image') {
        out.push(block);
        continue;
      }
      const description = await describeAttachment(block.attachment, signal);
      out.push({ type: 'text', text: `[Image Description: ${description}]` });
    }
    return out;
  }

  /** 镜像 deepseek-official 同名模型的元数据,并显式声明 image 能力。 */
  async function mirrorInnerModel(model) {
    let inner;
    try {
      inner = await ctx.llm.resolveModelInfo(INNER_PROVIDER, model, undefined);
    } catch {
      inner = undefined;
    }
    return {
      provider: 'vision-bridge',
      id: model,
      name: inner?.name ?? model,
      inputModalities: ['text', 'image'],
      ...(inner?.context ? { context: inner.context } : {}),
      ...(inner?.defaultMaxTokens !== undefined ? { defaultMaxTokens: inner.defaultMaxTokens } : {}),
      ...(inner?.reasoning ? { reasoning: inner.reasoning } : {}),
    };
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: 'vision-bridge' };
    },

    providerRetryPolicy() {
      return undefined; // 使用默认重试策略
    },

    /** 广告目录:镜像 deepseek-official 全部模型 + image 能力(advisory)。 */
    async listModels() {
      let innerModels = [];
      try {
        innerModels = await ctx.llm.listModels(INNER_PROVIDER);
      } catch {
        innerModels = [];
      }
      if (innerModels.length === 0) {
        return [await mirrorInnerModel('deepseek-v4-flash')];
      }
      return Promise.all(innerModels.map((m) => mirrorInnerModel(m.id)));
    },

    async resolveModel(provider, model) {
      return mirrorInnerModel(model);
    },

    /**
     * 唯一必实现:图片块 → 文本 → 转发 deepseek-official。
     * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
     */
    async *stream(options) {
      const hasImage = options.messages.some((message) =>
        message.content.some((block) => block?.type === 'image'),
      );

      let messages = options.messages;
      if (hasImage) {
        messages = [];
        for (const message of options.messages) {
          if (message.content.some((block) => block?.type === 'image')) {
            messages.push({
              ...message,
              content: await convertImageBlocks(message.content, options.signal),
            });
          } else {
            messages.push(message);
          }
        }
      }

      // 转发给官方 DeepSeek 适配器(鉴权/重试/attribution/流式协议全部复用)
      const forwarded = { ...options, provider: INNER_PROVIDER, messages };
      yield* ctx.llm.stream(forwarded);
    },
  };
}
