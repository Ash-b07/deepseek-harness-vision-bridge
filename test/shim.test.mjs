/**
 * 2.0 适配器 shim 测试:vision-bridge 路由的目录镜像 / 流式转换 / 无图直通。
 */

import { createVisionBridgeAdapter } from '../plugin/shim.js';
import { assert, TINY_PNG } from './helpers.mjs';

/** 构造一个路由感知的假 llm(按 provider 分流)。 */
function fakeLlm({ visionOk = true, forwarded } = {}) {
  const visionCalls = [];
  const forwardCalls = [];
  const llm = {
    visionCalls,
    forwardCalls,
    async resolveModelInfo(provider, model) {
      if (provider === 'deepseek-official') {
        return {
          provider,
          id: model,
          name: model === 'deepseek-v4-flash' ? 'DeepSeek V4 Flash' : model,
          inputModalities: ['text'],
          context: { contextWindow: 1_000_000 },
          defaultMaxTokens: 256_000,
        };
      }
      return undefined;
    },
    async listModels(provider) {
      if (provider === 'deepseek-official') {
        return [
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
        ];
      }
      return [];
    },
    async *stream(options) {
      if (options.provider === 'opencode') {
        visionCalls.push(options);
        if (!visionOk) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'pi-ai model "mimo-v2.5-free" does not support image input',
                code: 'UNSUPPORTED_CONTENT',
              },
            },
          };
          return;
        }
        yield { type: 'text-delta', index: 0, text: '一张猫的截图。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (options.provider === 'deepseek-official') {
        forwardCalls.push(options);
        if (forwarded) forwarded.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'reasoning-delta', index: 0, text: '思考中' };
        yield { type: 'text-delta', index: 0, text: '这是DeepSeek的回答。' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      throw new Error(`未知 provider:${options.provider}`);
    },
  };
  return llm;
}

function fakeAttachments() {
  return {
    async readImage() {
      return { bytes: TINY_PNG, ref: { attachmentId: 'a1' } };
    },
  };
}

/** 构造假 ctx(带 llm / attachments)。 */
function fakeCtx(llm, attachments) {
  return {
    llm,
    attachments,
    get(name) {
      return name === 'llm' ? llm : name === 'attachments' ? attachments : undefined;
    },
  };
}

const CFG = { visionProvider: 'opencode', visionModel: 'mimo-v2.5-free' };

async function main() {
  // 1) 目录镜像:全部模型声明 image,id/name 与 deepseek-official 一致
  {
    const llm = fakeLlm();
    const adapter = createVisionBridgeAdapter(fakeCtx(llm, fakeAttachments()), CFG);
    const models = await adapter.listModels('vision-bridge');
    assert(models.length === 2, '应镜像 2 个模型');
    assert(models.every((m) => m.inputModalities.includes('image')), '所有镜像模型应声明 image');
    assert(models[0].id === 'deepseek-v4-flash' && models[0].name === 'DeepSeek V4 Flash', '应镜像 id/name');
    assert(models[0].context?.contextWindow === 1_000_000, '应镜像 contextWindow');
    console.log('ok 1: 目录镜像(全部声明 image)');
  }

  // 2) resolveModel:能力 + 元数据镜像
  {
    const llm = fakeLlm();
    const adapter = createVisionBridgeAdapter(fakeCtx(llm, fakeAttachments()), CFG);
    const info = await adapter.resolveModel('vision-bridge', 'deepseek-v4-flash');
    assert(info.inputModalities.includes('image'), '应声明 image');
    assert(info.name === 'DeepSeek V4 Flash', '应镜像名称');
    assert(info.defaultMaxTokens === 256_000, '应镜像 defaultMaxTokens');
    console.log('ok 2: resolveModel 镜像 + image 能力');
  }

  // 3) 流式转换:图片块 → 文本描述,转发给 deepseek-official
  {
    const llm = fakeLlm();
    const adapter = createVisionBridgeAdapter(fakeCtx(llm, fakeAttachments()), CFG);
    const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
    const messages = [
      { id: 'm1', role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    ];
    const collected = [];
    for await (const chunk of adapter.stream({
      provider: 'vision-bridge',
      model: 'deepseek-v4-flash',
      messages,
      system: 'sys',
      signal: new AbortController().signal,
    })) {
      collected.push(chunk);
    }
    // 视觉模型被调用一次
    assert(llm.visionCalls.length === 1, '应调用一次视觉模型');
    assert(llm.visionCalls[0].provider === 'opencode' && llm.visionCalls[0].model === 'mimo-v2.5-free', '应打给已配置视觉路由');
    // 转发:provider 换成 deepseek-official,消息里图片块被替换为文本
    assert(llm.forwardCalls.length === 1, '应转发一次');
    const fwd = llm.forwardCalls[0];
    assert(fwd.provider === 'deepseek-official', '转发目标应为 deepseek-official');
    assert(fwd.messages[0].content.length === 1, '图片块应被替换');
    assert(fwd.messages[0].content[0].type === 'text', '替换后应为文本块');
    assert(fwd.messages[0].content[0].text.includes('[Image Description: 一张猫的截图。]'), '应含描述文本');
    // 流式块透传(含 DeepSeek 的回答)
    const text = collected.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert(text.includes('这是DeepSeek的回答。'), 'DeepSeek 的文本应透传');
    console.log('ok 3: 图片块→文本→转发 deepseek-official');
  }

  // 4) 无图直通:不调视觉模型,消息原样转发
  {
    const llm = fakeLlm();
    const adapter = createVisionBridgeAdapter(fakeCtx(llm, fakeAttachments()), CFG);
    const messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } },
    ];
    const collected = [];
    for await (const chunk of adapter.stream({
      provider: 'vision-bridge',
      model: 'deepseek-v4-flash',
      messages,
      signal: new AbortController().signal,
    })) {
      collected.push(chunk);
    }
    assert(llm.visionCalls.length === 0, '无图不应调用视觉模型');
    assert(llm.forwardCalls.length === 1, '应转发一次');
    assert(llm.forwardCalls[0].messages === messages, '无图时消息应原样转发');
    console.log('ok 4: 无图直通(零开销)');
  }

  // 5) 视觉模型不支持图片 → 可操作报错
  {
    const llm = fakeLlm({ visionOk: false });
    const adapter = createVisionBridgeAdapter(fakeCtx(llm, fakeAttachments()), CFG);
    const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
    const messages = [
      { id: 'm1', role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    ];
    let err;
    try {
      for await (const _chunk of adapter.stream({
        provider: 'vision-bridge',
        model: 'deepseek-v4-flash',
        messages,
        signal: new AbortController().signal,
      })) {
        /* 收集即触发 */
      }
    } catch (e) {
      err = e;
    }
    assert(err instanceof Error, '应抛错');
    assert(err.message.includes('input: [text, image]'), `应提示声明能力,实际:${err.message}`);
    assert(llm.forwardCalls.length === 0, '失败时不应转发');
    console.log('ok 5: 视觉模型能力缺失 → 可操作报错(不转发)');
  }

  console.log('\nshim 测试全部通过 ✅');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
