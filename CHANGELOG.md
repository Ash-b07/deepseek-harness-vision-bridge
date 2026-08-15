# Changelog

## 1.0.0-preview.1 - 2026-08-15

### Added

- `vision_bridge` 图片描述、OCR 和视觉问答工具；
- 纯文本路由下的 `read_image` 兜底桥接；
- 声明图片能力并转发给官方 DeepSeek 的上传适配器；
- Harness 已配置视觉模型后端；
- 工具路径 SHA256 + TTL 缓存；
- 无网络单元测试。

### Known issues

- 上传适配器没有复用工具路径缓存；
- 同一历史图片可能被重复识别；
- 视觉路由 429 或故障时没有自动回退；
- `read_image` 兜底在 UI 中显示为失败结果。
