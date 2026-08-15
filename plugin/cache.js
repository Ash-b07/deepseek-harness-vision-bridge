/**
 * 内存 TTL 缓存 —— 同一张图(按 sha256)+ 同一模式 + 同一问题,只调一次视觉后端。
 *
 * 设计约束(01-任务简报 §2「最少 token / 最高性价比」):
 *   - 能缓存就绝不重复转换同一张图;
 *   - 键 = sha256(图片字节) + mode + question,天然包含图片内容指纹;
 *   - 进程内 Map + 过期时间 + 条数上限,插件卸载自动丢弃。
 */

import { createHash } from 'node:crypto';

/** 图片字节 → sha256 hex(缓存键的一部分)。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class TtlCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] 条目存活时间,默认 6 小时
   * @param {number} [opts.maxEntries] 最大条数,超出后逐出最旧条目,默认 200
   */
  constructor({ ttlMs = 6 * 60 * 60 * 1000, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, { value: unknown; expiresAt: number }>} */
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key); // 重插保证 LRU 顺序
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}
