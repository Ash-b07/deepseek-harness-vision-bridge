/**
 * 视觉桥核心测试:readImageBytes / runBridgeWithBackend / 缓存 / 信封渲染。
 */

import { readImageBytes, runBridgeWithBackend, renderEnvelope, IMAGE_DESCRIPTION_PREFIX } from '../plugin/bridge.js';
import { TtlCache } from '../plugin/cache.js';
import { assert, fakeCtx, fakeExec, TINY_PNG } from './helpers.mjs';

/** 假后端:记录调用次数,返回固定文本。 */
function stubBackend({ text = '一张截图,包含一个按钮', fail = false } = {}) {
  const backend = {
    id: 'stub',
    model: 'stub-vision',
    calls: 0,
    async convert(req) {
      backend.calls += 1;
      if (fail) throw new Error('stub backend down');
      return { text, model: backend.model, latencyMs: 42 };
    },
  };
  return backend;
}

async function main() {
  // 1) readImageBytes:通过 ctx.fs 读到字节 + mediaType
  {
    const ctx = fakeCtx();
    const exec = fakeExec({ name: 'read_image' });
    const { bytes, mediaType, displayPath } = await readImageBytes(ctx, exec, '/tmp/a.png');
    assert(Buffer.from(bytes).equals(TINY_PNG), '字节应与假 fs 一致');
    assert(mediaType === 'image/png', `mediaType 应为 image/png,实际 ${mediaType}`);
    assert(displayPath === '/tmp/a.png', 'displayPath 应透传');
    console.log('ok 1: readImageBytes 读取 + mediaType 推断');
  }

  // 2) readImageBytes:非图片扩展名 → 报错
  {
    const ctx = fakeCtx();
    const exec = fakeExec({ name: 'read_image' });
    let threw = false;
    try {
      await readImageBytes(ctx, exec, '/tmp/a.txt');
    } catch (err) {
      threw = true;
      assert(/only PNG\/JPEG\/WebP\/GIF/.test(err.message), '应提示仅支持图片格式');
    }
    assert(threw, '非图片路径应抛错');
    console.log('ok 2: 非图片扩展名拒绝');
  }

  // 3) runBridgeWithBackend:成功路径 + 结果形状
  {
    const ctx = fakeCtx();
    const exec = fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } });
    const cache = new TtlCache();
    const backend = stubBackend();
    const value = await runBridgeWithBackend(ctx, exec, { file_path: '/tmp/a.png', mode: 'describe' }, backend, cache);
    assert(backend.calls === 1, '后端应被调用一次');
    assert(value.cached === false, '首次应未命中缓存');
    assert(value.source === 'stub:stub-vision', `source 应为 stub:stub-vision,实际 ${value.source}`);
    assert(value.text.length > 0, 'text 不应为空');
    console.log('ok 3: 桥接成功路径');
  }

  // 4) 缓存:同一张图第二次调用不重复调后端
  {
    const ctx = fakeCtx();
    const exec = fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } });
    const cache = new TtlCache();
    const backend = stubBackend({ text: 'A' });
    await runBridgeWithBackend(ctx, exec, { file_path: '/tmp/a.png', mode: 'describe' }, backend, cache);
    const second = await runBridgeWithBackend(ctx, exec, { file_path: '/tmp/a.png', mode: 'describe' }, backend, cache);
    assert(backend.calls === 1, '缓存命中时不应再次调用后端');
    assert(second.cached === true, '第二次应命中缓存');
    assert(second.text === 'A', '命中缓存应返回相同文本');
    // 不同 mode → 不同缓存键
    await runBridgeWithBackend(ctx, exec, { file_path: '/tmp/a.png', mode: 'ocr' }, backend, cache);
    assert(backend.calls === 2, '不同 mode 应再次调用后端');
    console.log('ok 4: 缓存命中 + 按 mode 分键');
  }

  // 5) 后端失败 → 错误向上抛(由调用方转为失败结果)
  {
    const ctx = fakeCtx();
    const exec = fakeExec({ name: 'read_image', args: { file_path: '/tmp/a.png' } });
    const cache = new TtlCache();
    const backend = stubBackend({ fail: true });
    let threw = false;
    try {
      await runBridgeWithBackend(ctx, exec, { file_path: '/tmp/a.png', mode: 'describe' }, backend, cache);
    } catch (err) {
      threw = true;
      assert(/stub backend down/.test(err.message), '应透传后端错误');
    }
    assert(threw, '后端失败应抛错');
    console.log('ok 5: 后端失败透传');
  }

  // 6) 信封渲染:包含标记与描述
  {
    const envelope = renderEnvelope('/tmp/a.png', {
      text: '描述内容',
      mode: 'describe',
      source: 'glm:glm-4.6v-flash',
      cached: false,
      displayPath: '/tmp/a.png',
    });
    assert(envelope.includes('<type>vision-bridged</type>'), '应标记 vision-bridged');
    assert(envelope.includes(IMAGE_DESCRIPTION_PREFIX + '描述内容]'), '应包含 [Image Description: ...]');
    assert(envelope.includes('<source>glm:glm-4.6v-flash</source>'), '应包含 source');
    console.log('ok 6: 信封渲染');
  }

  console.log('\nbridge 测试全部通过 ✅');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
