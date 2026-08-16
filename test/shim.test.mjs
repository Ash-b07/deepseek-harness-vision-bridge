/**
 * 2.0 自动视觉编排测试。文件名保留为 shim.test 兼容旧的测试命令，
 * 实际断言已经确保不再创建 shim Provider。
 */

import { containsImage, createAutoVisionHook } from '../plugin/auto-bridge.js';
import { assert } from './helpers.mjs';

const route = { provider: 'opencode', model: 'mimo-v2.5-free' };
const image = {
  type: 'image',
  attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
};

function fakeRuntime({ enabled = true, native = false } = {}) {
  const visionCalls = [];
  const mainCalls = [];
  const ctx = {
    llm: {
      async resolveModelInfo(provider) {
        return { inputModalities: provider === 'deepseek-official' && !native ? ['text'] : ['text', 'image'] };
      },
      stream(options) {
        const target = options.provider === route.provider && options.model === route.model
          ? visionCalls
          : mainCalls;
        target.push(options);
        return (async function* () {
          yield {
            type: 'text-delta',
            text: target === visionCalls ? '图片中有一只猫和“你好”两个字。' : '主模型回答',
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const settings = { get: () => ({ enabled, route }) };
  return { ctx, settings, visionCalls, mainCalls };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function consume(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function main() {
  assert(containsImage([{ type: 'tool-result', result: { content: [image] } }]), '应识别嵌套图片');
  assert(!containsImage([{ type: 'text', text: 'hello' }]), '纯文本不应误判');
  console.log('ok 1: 递归图片检测');

  {
    const runtime = fakeRuntime();
    const options = deepFreeze({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [{ id: 'u1', role: 'user', content: [image, { type: 'text', text: '图里写了什么？' }] }],
      signal: new AbortController().signal,
    });
    const hook = createAutoVisionHook(runtime.ctx, runtime.settings);
    const chunks = await consume(
      hook(options, () => {
        throw new Error('需转换的冻结请求不应原地续传');
      }),
    );
    assert(runtime.visionCalls.length === 1, '应调用一次视觉模型');
    assert(runtime.visionCalls[0].provider === route.provider, '视觉调用应走独立 route');
    assert(runtime.visionCalls[0].messages[0].content[1].text.includes('图里写了什么'), '视觉提示应带同轮问题');
    assert(runtime.mainCalls.length === 1, '应用克隆请求调用一次原主模型');
    const downstream = runtime.mainCalls[0];
    assert(downstream !== options, '不应原地改写 Agent Loop 的冻结请求');
    assert(downstream.provider === 'deepseek-official', '主模型 provider 不应变成 vision-bridge');
    assert(downstream.model === 'deepseek-v4-flash', '主模型 id 不应改变');
    assert(!containsImage(downstream.messages), '下游纯文本模型不应再收到图片块');
    const observation = downstream.messages[0].content[0].text;
    assert(observation.includes('<vision_observation'), '应注入结构化视觉观察');
    assert(observation.includes('图片中有一只猫'), '观察应包含视觉模型结果');
    assert(chunks[0].text === '主模型回答', '主模型流应原样透传');
    console.log('ok 2: 冻结请求→视觉观察→克隆请求调用原主模型');
  }

  {
    const runtime = fakeRuntime();
    const hook = createAutoVisionHook(runtime.ctx, runtime.settings);
    for (let i = 0; i < 2; i += 1) {
      const options = {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        messages: [{ id: `u${i}`, role: 'user', content: [image, { type: 'text', text: '描述图片' }] }],
        signal: new AbortController().signal,
      };
      await consume(hook(options, () => (async function* () {})()));
    }
    assert(runtime.visionCalls.length === 1, '相同观察请求应命中缓存');
    console.log('ok 3: route + attachment + question + promptVersion 缓存');
  }

  {
    const runtime = fakeRuntime({ native: true });
    const hook = createAutoVisionHook(runtime.ctx, runtime.settings);
    const options = {
      provider: 'native-vision',
      model: 'vision-pro',
      messages: [{ id: 'u1', role: 'user', content: [image] }],
    };
    let downstreamHasImage = false;
    await consume(
      hook(options, () => {
        downstreamHasImage = containsImage(options.messages);
        return (async function* () {})();
      }),
    );
    assert(runtime.visionCalls.length === 0, '原生视觉路由不应调用桥接模型');
    assert(downstreamHasImage, '原生视觉路由应保留图片');
    console.log('ok 4: 原生视觉主模型零开销直通');
  }

  {
    const runtime = fakeRuntime({ enabled: false });
    const hook = createAutoVisionHook(runtime.ctx, runtime.settings);
    const options = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [{ id: 'u1', role: 'user', content: [image] }],
    };
    let called = false;
    await consume(hook(options, () => {
      called = true;
      return (async function* () {})();
    }));
    assert(called && runtime.visionCalls.length === 0, '关闭时应完全透传');
    console.log('ok 5: 关闭视觉增强后透传');
  }

  {
    const adapterCalls = [];
    let recursiveHook;
    const ctx = {
      llm: {
        async resolveModelInfo(provider) {
          return { inputModalities: provider === route.provider ? ['text', 'image'] : ['text'] };
        },
        stream(options) {
          return recursiveHook(options, () => {
            adapterCalls.push(options);
            return (async function* () {
              yield {
                type: 'text-delta',
                text: options.provider === route.provider ? '视觉观察' : '主模型结果',
              };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          });
        },
      },
    };
    recursiveHook = createAutoVisionHook(ctx, { get: () => ({ enabled: true, route }) });
    const frozen = deepFreeze({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [{ id: 'u-recursive', role: 'user', content: [image] }],
    });
    const chunks = await consume(ctx.llm.stream(frozen));
    assert(adapterCalls.length === 2, '应各调用一次视觉适配器和主模型适配器');
    assert(adapterCalls[0].provider === route.provider, '第一次适配器调用应为视觉路由');
    assert(adapterCalls[1].provider === 'deepseek-official', '第二次适配器调用应为原主模型');
    assert(chunks[0].text === '主模型结果', '内部克隆请求不应再次进入视觉编排');
    console.log('ok 6: 内部克隆请求只绕过一次编排，无递归');
  }

  console.log('\nauto bridge 测试全部通过 ✅');
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
