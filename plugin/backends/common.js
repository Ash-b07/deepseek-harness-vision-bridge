/**
 * 视觉后端公共部分:模式枚举 + 模式提示词。
 *
 * 提示词设计(对齐「最少 token / 最高性价比」):
 *   - ocr:纯文字提取,输出最省;
 *   - describe:≤200 字场景描述(默认,read_image 拦截走这个);
 *   - vqa:只带问题,精准回答。
 */

/** 桥接模式 */
export const VISION_MODES = ['ocr', 'describe', 'vqa'];

/** 按模式生成用户提示词 —— 输出长度控制的入口。 */
export function buildPrompt(mode, question) {
  switch (mode) {
    case 'ocr':
      return '请只输出图片中出现的所有文字,按原始顺序逐行保留;不要翻译、不要解释、不要添加任何格式或评论。';
    case 'vqa':
      return (
        '请根据图片内容直接回答下面的问题,简洁准确,不要多余铺垫。问题:' +
        String(question?.trim() || '这张图片里有什么?')
      );
    case 'describe':
    default:
      return '请用简洁的中文描述这张图片的内容(主体、场景、关键细节),200 字以内,不要推测图中不存在的信息。';
  }
}

/** Uint8Array → data URL(bridge.js 以 imageBase64 字段传给后端;harness 后端忽略之)。 */
export function bytesToDataUrl(bytes, mimeType) {
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}
