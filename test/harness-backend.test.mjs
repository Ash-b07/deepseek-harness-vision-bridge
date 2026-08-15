/**
 * harness 后端测试:复用 DSH 已配置路由(ctx.llm + attachments),不自己发 HTTP。
 */

import { runBridge } from '../plugin/bridge.js';
import { assert, fakeCtx, fakeExec, TINY_PNG } from './helpers.mjs';

/** 假 attachments 服务(记录被保存的图片)。 */
function fakeAttachments(saved) {
  return {
    imageLimits: { maxImageBytes: 5_000_000, maxMessageImageBytes: 5_000_000 },
    async saveImage(input) {
      saved.push(input);
      return {
        attachmentId: 'att-1',
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      };
    },
  };
}

/** 假 llm 服务:记录请求,按脚本吐 StreamChunk。 */
function fakeLlmStream(chunks, seen) {
  return {
    async resolveModelInfo() {
      return { inputModalities: ['text'] };
    },
    stream(options) {
      seen.push(options);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const HARNESS_CFG = {
  backend: 'harness',
  visionProvider: 'opencode',
  visionModel: 'mimo-v2.5-free',
  maxTokens: 512,
  timeoutMs: 30_000,
};

async function main() {
  // 1) 成功路径:图片落附件 → ctx.llm.stream → 文本回给主模型
  {
    const saved = [];
    const seen = [];
    const ctx = fakeCtx({
      llm: fakeLlmStream(
        [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '一张' },
          { type: 'text-delta', index: 0, text: '截图。' },
          { type: 'usage', usage: { inputTokens: 100, outputTokens: 8 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        seen,
      ),
      attachments: fakeAttachments(saved),
    });
    const value = await runBridge(
      ctx,
      fakeExec({ name: 'vision_bridge', args: {} }),
      { file_path: '/tmp/shot.png', mode: 'describe' },
      HARNESS_CFG,
      new Map0(),
    );

    assert(value.text === '一张截图。', '应拼接 text-delta');
    assert(value.source === 'harness:opencode/mimo-v2.5-free', `source 应带路由,实际 ${value.source}`);
    assert(saved.length === 1 && saved[0].mediaType === 'image/png', '图片应经 attachments 落附件');
    assert(saved[0].name === 'shot.png', '附件名应取文件名');

    const request = seen[0];
    assert(request.provider === 'opencode' && request.model === 'mimo-v2.5-free', '应打给已配置路由');
    assert(request.maxTokens === 512, 'maxTokens 应透传');
    const content = request.messages[0].content;
    assert(content[0].type === 'image' && content[0].attachment.attachmentId === 'att-1', '首块应为图片引用');
    assert(content[1].type === 'text' && content[1].text.includes('描述'), '次块应为 describe 提示词');
    assert(request.messages[0].source.plugin === 'vision-bridge', '消息来源应标插件');
    console.log('ok 1: harness 后端成功路径(附件 + ctx.llm.stream)');
  }

  // 2) block-end 兜底(适配器只发整块,不发 delta)
  {
    const ctx = fakeCtx({
      llm: fakeLlmStream(
        [
          { type: 'block-end', index: 0, block: { type: 'text', text: '整块文本' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        [],
      ),
      attachments: fakeAttachments([]),
    });
    const value = await runBridge(
      ctx,
      fakeExec({ name: 'vision_bridge', args: {} }),
      { file_path: '/tmp/shot.png', mode: 'ocr' },
      HARNESS_CFG,
      new Map0(),
    );
    assert(value.text === '整块文本', 'block-end 应作为兜底文本来源');
    console.log('ok 2: block-end 兜底');
  }

  // 3) 模型没声明 image 输入 → finish error → 可操作报错
  {
    const ctx = fakeCtx({
      llm: fakeLlmStream(
        [
          {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'pi-ai model "mimo-v2.5-free" does not support image input',
                code: 'UNSUPPORTED_CONTENT',
              },
            },
          },
        ],
        [],
      ),
      attachments: fakeAttachments([]),
    });
    const err = await runBridge(
      ctx,
      fakeExec({ name: 'vision_bridge', args: {} }),
      { file_path: '/tmp/shot.png', mode: 'describe' },
      HARNESS_CFG,
      new Map0(),
    ).catch((e) => e);
    assert(err instanceof Error, '应抛错');
    assert(err.message.includes('input: [text, image]'), `报错应提示 settings.yaml 声明,实际:${err.message}`);
    console.log('ok 3: 模型未声明 image 输入 → 可操作报错');
  }

  // 4) 缺 attachments 服务 → 指路其它后端
  {
    const ctx = fakeCtx({ llm: fakeLlmStream([], []) }); // 不挂 attachments
    const err = await runBridge(
      ctx,
      fakeExec({ name: 'vision_bridge', args: {} }),
      { file_path: '/tmp/shot.png', mode: 'describe' },
      HARNESS_CFG,
      new Map0(),
    ).catch((e) => e);
    assert(err.message.includes('attachments'), `应报缺 attachments,实际:${err.message}`);
    console.log('ok 4: 缺 attachments → 可操作报错');
  }

  // 5) 没配 visionProvider / visionModel → 明确报配置缺失
  {
    const ctx = fakeCtx({ llm: fakeLlmStream([], []), attachments: fakeAttachments([]) });
    const err = await runBridge(
      ctx,
      fakeExec({ name: 'vision_bridge', args: {} }),
      { file_path: '/tmp/shot.png', mode: 'describe' },
      { backend: 'harness' },
      new Map0(),
    ).catch((e) => e);
    assert(err.message.includes('visionProvider'), `应报配置缺失,实际:${err.message}`);
    console.log('ok 5: 缺路由配置 → 可操作报错');
  }

  console.log('\nharness 后端测试全部通过 ✅');
}

/** 极简缓存桩:与 TtlCache 同接口(get/set),每个用例独立一份。 */
class Map0 {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    return this.store.get(key);
  }
  set(key, value) {
    this.store.set(key, value);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
