/**
 * 能力判断测试:routeSupportsImage 的四种情形。
 */

import { routeSupportsImage } from '../plugin/capability.js';
import { assert, fakeCtx, fakeExec } from './helpers.mjs';

async function main() {
  // 1) inputModalities 显式含 image → true(原生视觉路由直通)
  {
    const ctx = fakeCtx({ llm: fakeLlm(['text', 'image']) });
    const exec = fakeExec({ name: 'read_image' });
    assert((await routeSupportsImage(ctx, exec)) === true, 'image 路由应返回 true');
    console.log('ok 1: 原生视觉路由 → true');
  }

  // 2) 纯文本路由(deepseek)→ false(走桥接)
  {
    const ctx = fakeCtx({ llm: fakeLlm(['text']) });
    const exec = fakeExec({ name: 'read_image' });
    assert((await routeSupportsImage(ctx, exec)) === false, '纯文本路由应返回 false');
    console.log('ok 2: 纯文本路由 → false');
  }

  // 3) inputModalities 缺省(未知)→ false(与官方闸门一致:保守拒绝)
  {
    const ctx = fakeCtx({ llm: fakeLlm(undefined) });
    const exec = fakeExec({ name: 'read_image' });
    assert((await routeSupportsImage(ctx, exec)) === false, '未知能力应返回 false');
    console.log('ok 3: 未知能力 → false');
  }

  // 4) llm 服务不可用 → false(不抛错)
  {
    const ctx = fakeCtx({ llm: undefined });
    const exec = fakeExec({ name: 'read_image' });
    assert((await routeSupportsImage(ctx, exec)) === false, 'llm 缺失应返回 false');
    console.log('ok 4: llm 缺失 → false');
  }

  console.log('\ncapability 测试全部通过 ✅');
}

function fakeLlm(inputModalities) {
  return {
    async resolveModelInfo() {
      return { inputModalities };
    },
  };
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
