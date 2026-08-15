/**
 * 后端选择器。
 *
 * 1.0(用户确认):只用 DSH 已配置的模型 —— 唯一后端是 harness(经 ctx.llm.stream
 * 调 settings.yaml 里已配置的路由,如 opencode / mimo-v2.5-free)。
 * 之前按 GLM/Ollama 外部 HTTP 后端写的版本已按用户要求移除,不再保留。
 */

import { HarnessVisionBackend } from './harness.js';

/**
 * @param {object} cfg 合并后的插件配置(见 index.js buildBackendConfig)
 * @returns {HarnessVisionBackend}
 */
export function createBackend(cfg) {
  return new HarnessVisionBackend({
    visionProvider: cfg.visionProvider,
    visionModel: cfg.visionModel,
    maxTokens: cfg.maxTokens,
  });
}
