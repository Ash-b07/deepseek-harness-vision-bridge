/**
 * 2.0 自动视觉编排层。
 *
 * 它不是 Provider，也不会出现在主模型目录中。启用后，llm/stream 在真正调用
 * 纯文本模型前把消息中的图片交给独立配置的视觉模型，再用文本观察结果替换图片。
 * 原生支持 image 的主模型保持直通。
 */

import { createHash } from 'node:crypto';
import { buildPrompt } from './backends/common.js';
import { TtlCache } from './cache.js';

export const AUTO_BRIDGE_PROMPT_VERSION = 'vision-observation-v2';

function routeKey(route) {
  return `${route?.provider ?? ''}/${route?.model ?? ''}`;
}

function sameRoute(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model;
}

/** 消息数组里是否仍含图片块（含 tool-result 等嵌套 content）。 */
export function containsImage(value) {
  if (Array.isArray(value)) return value.some(containsImage);
  if (value === null || typeof value !== 'object') return false;
  if (value.type === 'image') return true;
  if (Array.isArray(value.content) && containsImage(value.content)) return true;
  if (value.result !== undefined && containsImage(value.result)) return true;
  return false;
}

/** 取图片同一条消息里的文字，作为视觉问答上下文。 */
function questionOf(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4_000);
}

function observationPrompt(question) {
  if (!question) return buildPrompt('describe');
  return (
    '请分析图片，并优先提取回答下方用户请求所需的视觉事实。' +
    '先给出可核验的关键内容；有文字时准确抄录；不要替主模型执行图片之外的任务。' +
    '控制在 500 字以内。\n\n用户请求：\n' +
    question
  );
}

function attachmentIdentity(attachment) {
  const raw = JSON.stringify(attachment ?? null);
  return createHash('sha256').update(raw).digest('hex');
}

async function collectText(stream, route) {
  let text = '';
  let fallback = '';
  let failure;
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += String(chunk.text ?? '');
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) {
        fallback += String(chunk.block.text ?? '');
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        failure = chunk.reason.failure;
      }
    }
  } catch (error) {
    failure = {
      code: error?.code ?? 'LLM_STREAM_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (failure) {
    const unsupported =
      failure.code === 'UNSUPPORTED_CONTENT' ||
      /image input|image content|does not support image/i.test(String(failure.message));
    if (unsupported) {
      throw new Error(
        `视觉模型 ${routeKey(route)} 未声明图片输入能力；请在模型配置中加入 input: [text, image]。`,
      );
    }
    throw new Error(`视觉模型 ${routeKey(route)} 调用失败：${failure.message}`);
  }
  const result = (text || fallback).trim();
  if (!result) throw new Error(`视觉模型 ${routeKey(route)} 返回了空内容`);
  return result;
}

/**
 * 创建全局 llm/stream 监听器。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ get(): { enabled?: boolean, route?: {provider?: string, model?: string}, maxTokens?: number } }} settings
 * @param {{ ttlMs?: number }} [options]
 */
export function createAutoVisionHook(ctx, settings, options = {}) {
  const cache = new TtlCache({ ttlMs: options.ttlMs });
  // Agent Loop 发布的 GenerateOptions 会被深度冻结，中间件只能读。
  // 转换后用一份新请求重新进入 LLM runtime；WeakSet 只跳过这一次
  // 内部主模型调用，避免重复视觉编排。
  const forwardedRequests = new WeakSet();
  let messageSeq = 0;

  async function describe(image, question, route, signal, maxTokens) {
    const attachment = image?.attachment;
    if (attachment === undefined) throw new Error('视觉增强收到不含 attachment 引用的图片块');
    const cacheKey = [
      AUTO_BRIDGE_PROMPT_VERSION,
      routeKey(route),
      attachmentIdentity(attachment),
      question,
    ].join(':');
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;

    const message = {
      id: `vision-observation-${++messageSeq}`,
      role: 'user',
      content: [
        { type: 'image', attachment },
        { type: 'text', text: observationPrompt(question) },
      ],
      source: { kind: 'plugin', plugin: 'vision-bridge' },
    };
    const result = await collectText(
      ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [message],
        ...(maxTokens ? { maxTokens } : {}),
        signal,
      }),
      route,
    );
    cache.set(cacheKey, result);
    return result;
  }

  async function transformValue(value, question, route, signal, maxTokens) {
    if (Array.isArray(value)) {
      const transformed = [];
      for (const entry of value) {
        transformed.push(await transformValue(entry, question, route, signal, maxTokens));
      }
      return transformed;
    }
    if (value === null || typeof value !== 'object') return value;
    if (value.type === 'image') {
      const observation = await describe(value, question, route, signal, maxTokens);
      return {
        type: 'text',
        text:
          `<vision_observation provider="${route.provider}" model="${route.model}" ` +
          `prompt_version="${AUTO_BRIDGE_PROMPT_VERSION}">\n${observation}\n</vision_observation>`,
      };
    }
    let next = value;
    if (Array.isArray(value.content) && containsImage(value.content)) {
      next = {
        ...next,
        content: await transformValue(value.content, question, route, signal, maxTokens),
      };
    }
    if (value.result !== undefined && containsImage(value.result)) {
      next = {
        ...next,
        result: await transformValue(value.result, question, route, signal, maxTokens),
      };
    }
    return next;
  }

  return function autoVisionHook(options, next) {
    if (forwardedRequests.has(options)) return next();

    const current = settings.get();
    const route = current?.route;
    if (
      current?.enabled !== true ||
      !route?.provider ||
      !route?.model ||
      sameRoute(options, route) ||
      !containsImage(options.messages)
    ) {
      return next();
    }

    return (async function* () {
      let info;
      try {
        info = await ctx.llm.resolveModelInfo(options.provider, options.model);
      } catch {
        info = undefined;
      }
      if (info?.inputModalities?.includes('image')) {
        yield* next();
        return;
      }

      const messages = [];
      for (const message of options.messages) {
        if (!containsImage(message)) {
          messages.push(message);
          continue;
        }
        messages.push(
          await transformValue(
            message,
            questionOf(message),
            route,
            options.signal,
            current.maxTokens,
          ),
        );
      }
      const forwarded = { ...options, messages };
      forwardedRequests.add(forwarded);
      yield* ctx.llm.stream(forwarded);
    })();
  };
}
