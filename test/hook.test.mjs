/**
 * 插件接线测试:apply() 注册的工具定义 + tools/execute 拦截钩子的四种场景。
 */

import { apply } from '../plugin/index.js';
import { assert, assertObjectJsonSchema, fakeCtx, fakeExec, TINY_PNG } from './helpers.mjs';

function fakeLlm(inputModalities) {
  return {
    async resolveModelInfo() {
      return { inputModalities };
    },
    registerAdapter() {
      return { dispose() {}, replace() {} };
    },
  };
}

async function main() {
  // 0) apply 正常执行:注册了 vision_bridge 工具 + 挂上了 tools/execute 钩子
  const ctx = fakeCtx({ llm: fakeLlm(['text']) });
  apply(ctx, { backend: 'ollama', ollamaBaseURL: 'http://127.0.0.1:1' }); // 故意用不可达地址
  assert(ctx.registeredTools.length === 1, '应注册 1 个工具');
  assert(ctx.registeredTools[0].name === 'vision_bridge', '工具名应为 vision_bridge');
  assert(typeof ctx.handlers['tools/execute'] === 'function', '应挂上 tools/execute 钩子');
  console.log('ok 0: apply 接线(vision_bridge 工具 + 钩子)');

  // 1) vision_bridge 工具定义形状
  //    ctx.tools.register() 不做 schema 编译:parameters 必须已经是对象根 JSON Schema,
  //    否则发给模型的 function schema 没有 type,DeepSeek 侧整轮请求被 INVALID_REQUEST 拒掉。
  {
    const tool = ctx.registeredTools[0];
    assertObjectJsonSchema(tool.parameters, 'parameters');
    assert(tool.parameters.required.includes('file_path'), 'file_path 应在 required 里');
    const mode = tool.parameters.properties.mode;
    assert(Array.isArray(mode.enum) && mode.enum.length === 3, 'mode 应有 3 个枚举');
    assertObjectJsonSchema(tool.output.schema, 'output.schema');
    assert(typeof tool.execute === 'function', '应有 execute');
    const blocks = tool.output.render({ file_path: '/tmp/a.png' }, { text: 'x', mode: 'describe', source: 'glm:m' });
    assert(blocks[0].type === 'text' && blocks[0].text.includes('vision-bridged'), 'render 应产出 bridged 文本块');
    console.log('ok 1: vision_bridge 工具定义');
  }

  // 2) 非 read_image 调用 → 透传 next()
  {
    const hook = ctx.handlers['tools/execute'];
    let nextCalled = false;
    const result = await hook(
      fakeExec({ name: 'read', args: { file_path: '/tmp/a.txt' } }),
      async () => {
        nextCalled = true;
        return { isError: false, value: 1, content: [] };
      },
    );
    assert(nextCalled === true, '非 read_image 应调用 next');
    assert(result.value === 1, '应透传 next 结果');
    console.log('ok 2: 非 read_image 透传');
  }

  // 3) read_image + 原生视觉路由 → 透传 next()(零开销直通)
  {
    const ctx2 = fakeCtx({ llm: fakeLlm(['text', 'image']) });
    apply(ctx2, {});
    const hook = ctx2.handlers['tools/execute'];
    let nextCalled = false;
    const result = await hook(
      fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } }),
      async () => {
        nextCalled = true;
        return { isError: false, value: { path: '/tmp/a.png' }, content: [] };
      },
    );
    assert(nextCalled === true, '原生视觉路由应透传,不桥接');
    assert(result.value.path === '/tmp/a.png', '应透传原生结果');
    console.log('ok 3: 原生视觉路由直通(零桥接)');
  }

  // 3.5) read_image + 纯文本路由 + 桥接成功 → 结果必须是「带描述的失败结果」
  //      注册表约束:钩子返回的成功结果会被拿 read_image 自己的 output.schema 重新校验
  //      (dsh-tools normalizeDispatchResult → createSuccessResult),给什么 value 都过不了;
  //      失败结果才原样透传 content。所以桥接文本只能挂在 isError 上。
  {
    // 用 harness 后端当桩:假 llm + 假 attachments,不发网络
    const ctxBridge = fakeCtx({
      llm: {
        ...fakeLlm(['text']),
        stream: () =>
          (async function* () {
            yield { type: 'text-delta', index: 0, text: '一只猫。' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })(),
      },
      attachments: {
        imageLimits: { maxImageBytes: 5e6, maxMessageImageBytes: 5e6 },
        async saveImage(input) {
          return { attachmentId: 'a1', mediaType: input.mediaType, bytes: 1, width: 1, height: 1 };
        },
      },
    });
    apply(ctxBridge, {
      backend: 'harness',
      visionProvider: 'opencode',
      visionModel: 'vision-model',
    });
    const result = await ctxBridge.handlers['tools/execute'](
      fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } }),
      async () => {
        throw new Error('官方闸门不应被调用');
      },
    );
    assert(result.isError === true, '桥接结果必须是失败结果(成功结果会被 read_image schema 拒掉)');
    assert(result.value === undefined, '失败结果不得带 value');
    assert(result.error.info.code === 'VISION_BRIDGED', '错误码应标明是桥接');
    const text = result.content[0].text;
    assert(text.includes('[Image Description: 一只猫。]'), '内容应带图片描述');
    assert(text.includes('vision_bridge'), '内容应指引后续走 vision_bridge');
    assert(text.includes('不要重试'), '内容应劝阻重试 read_image');
    console.log('ok 3.5: 纯文本路由桥接 → 带描述的失败结果(符合注册表约束)');
  }

  // 4) read_image + 纯文本路由 + 后端不可用 → 失败结果(可操作报错)
  {
    const ctx3 = fakeCtx({ llm: fakeLlm(['text']) });
    apply(ctx3, { backend: 'ollama', ollamaBaseURL: 'http://127.0.0.1:1' });
    const hook = ctx3.handlers['tools/execute'];
    const result = await hook(
      fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } }),
      async () => {
        throw new Error('官方闸门不应被调用');
      },
    );
    assert(result.isError === true, '后端失败应返回 isError');
    assert(result.error.message.includes('vision bridge failed'), '错误信息应带前缀');
    assert(result.error.info.code === 'VISION_BRIDGE_FAILED', '错误码应为 VISION_BRIDGE_FAILED');
    console.log('ok 4: 纯文本路由桥接失败 → 失败结果(不抛给官方闸门)');
  }

  // 5) read_image + 纯文本路由 + 参数为空 → 透传给官方工具报参数错误
  {
    const ctx4 = fakeCtx({ llm: fakeLlm(['text']) });
    apply(ctx4, {});
    const hook = ctx4.handlers['tools/execute'];
    let nextCalled = false;
    await hook(fakeExec({ name: 'read_image', args: {} }), async () => {
      nextCalled = true;
      return { isError: true, error: { message: 'file_path must be a non-empty string' }, content: [] };
    });
    assert(nextCalled === true, '空参数应透传给官方工具');
    console.log('ok 5: 空参数透传');
  }

  console.log('\nhook 测试全部通过 ✅');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
