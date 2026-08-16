# Changelog

## 2.0.0-preview.1 - 2026-08-16

### Changed

- 删除会污染主模型选择器的 `vision-bridge` shim Provider；
- 在输入框左侧和常规设置中增加独立「视觉增强」入口；
- 视觉模型来自 Harness 模型目录，并按 `inputModalities: image` 过滤；
- 视觉路由和开关改由 Host 设置持久化；
- 直接上传图片时自动生成 `<vision_observation>`，再交给原 Provider/模型；
- 缓存键加入视觉 Provider、模型和提示词版本。

### Host integration

- 新增针对 DeepSeek Harness `0.1.0-rc.6` 的精确签名补丁；
- 视觉增强开启时放行纯文本主模型会话的图片准入；
- 模型目录 API 额外返回 `inputModalities`；
- 支持幂等安装、旧配置迁移、原文件备份和显式回滚。

### Fixed

- 不再修改 Agent Loop 深度冻结的 `options.messages`；
- 转换完成后通过克隆请求调用原主模型；
- 增加一次性内部转发保护，防止克隆请求递归进入视觉编排；
- 增加冻结请求和真实中间件递归回归测试；
- 工具路径缓存加入视觉路由身份，切换视觉模型不会误用旧观察。

### Protocol evidence

- 收录 [anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775)：OpenCode v0.99.1 的模型条目声明 image，但 OpenAI Chat 协议在请求发出前只允许 text；
- 对照 DeepSeek 官方 Chat Completions、Anthropic API 和 Copilot 集成文档：当前官方公开 API 仍把 V4 图片输入标为不支持或 text-only；
- 因而该 issue 被记录为“能力元数据与协议准入不一致”的证据，不作为 DeepSeek 官方 API 已开放原生视觉的证明。

### Validation

- 全部离线单元测试通过；
- 本机 rc.6 Host 补丁安装和幂等检查通过；
- Web 独立选择器、主模型列表清理、设置持久化和 HTTP 启动检查通过；
- 未在自动测试中发送用户图片或触发付费视觉调用。

### Known issues

- Host 补丁针对 rc.6 内部代码，Harness 升级后可能需要适配；
- 当前只有一个视觉路由，没有自动故障切换；
- `read_image` 兜底仍会以失败样式渲染；
- 模型目录声明 `image` 只是准入信号，不等同于服务端能力保证。

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
