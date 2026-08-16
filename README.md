# DeepSeek Harness Vision Bridge

DeepSeek Harness 的独立视觉增强插件：主模型继续使用 DeepSeek，图片交给 Harness 中另行选择的多模态模型，视觉结果再以结构化文本送回主模型。

> [!WARNING]
> 这是面向 DeepSeek Harness `0.1.0-rc.6` 的 `2.0 Preview`。安装器会对本机 Host 包做带签名校验、原始备份和回滚能力的兼容补丁。Harness 升级后应先检查补丁兼容性。

本项目是非官方社区实验，与 DeepSeek 官方无隶属或背书关系。

## 从问题到解法：我如何完成这次迭代

这个版本不只是增加一个视觉按钮，而是一次完整的问题拆解和工程闭环：

| 阶段 | 我观察到的问题 | 我做出的判断与行动 |
|---|---|---|
| 产品体验 | shim Provider 让主模型选择器出现重复的 `vision-bridge` 分组 | 把“负责推理的主模型”和“负责看图的视觉模型”拆成两个独立选择点 |
| 宿主边界 | 图片在插件运行前就被 Harness 能力闸门拒绝 | 不伪装 Provider；只对 Host 的图片准入和模型模态目录做最小补丁 |
| 运行时故障 | 实机报错 `Cannot assign to read only property 'messages'` | 追到 Agent Loop 深度冻结契约，放弃原地修改，改为克隆请求重新进入原模型链路 |
| 递归风险 | 内部主模型调用会再次触发同一个全局钩子 | 用一次性 WeakSet 标记克隆请求，并增加真实中间件递归回归测试 |
| 能力判断 | OpenCode 条目声明 image，但协议层只允许 text | 把“模型元数据、客户端协议、官方 API”分层查证，不把单一配置声明当成服务端事实 |
| 发布验证 | 单元测试通过不等于本机 Host 集成正确 | 同时验证语法、Host 补丁签名、幂等安装、UI 模型过滤、设置持久化、HTTP 启动和 GitHub Actions |

完整案例分析见 [从 shim 到独立视觉编排：一次约束驱动的问题解决](docs/CASE_STUDY.md)。开发过程保留了失败方案、错误现场、证据和决策，而不只展示最终代码。

## 2.0 的交互变化

- 主模型选择器不再注册或显示 `vision-bridge` Provider；
- 输入框左侧新增独立的「视觉增强」选择点；
- 只列出模型目录中声明了 `image` 输入能力的真实模型；
- 视觉开关和模型路由保存在 Host 设置中，切换会话后仍然有效；
- DeepSeek Provider、模型、推理强度和工具链保持不变。

```text
图片 + 同轮用户问题
        ↓
独立选择的多模态模型
        ↓
<vision_observation>可核验的视觉观察</vision_observation>
        ↓
当前主模型（例如 DeepSeek V4 Flash）
```

如果当前主模型本身确实声明并支持图片输入，插件会直接放行，不增加桥接调用。

## 为什么仍然需要视觉桥

截至 2026-08-16，公开资料存在一组容易混淆的信号：

- [anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775) 记录：OpenCode v0.99.1 的 `deepseek-v4-flash` 模型条目声明 `input: [text, image]`，但 `OpenAI Chat` 协议在客户端把用户内容硬编码为 text-only，因此图片在发出网络请求前被拒绝；
- DeepSeek 官方 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) 当前把 user message 的 `content` 定义为文本字符串，没有 `image_url` 输入结构；
- DeepSeek 官方 [Anthropic API 兼容表](https://api-docs.deepseek.com/guides/anthropic_api/) 明确把 `content: type=image` 标为不支持；
- DeepSeek 官方 [GitHub Copilot 集成说明](https://api-docs.deepseek.com/quick_start/agent_integrations/github_copilot/) 将 V4 描述为 text-only，图片由另一个 Copilot 视觉模型代看后转成文字。

因此，#26775 能证明 OpenCode 的“模型条目与协议能力”不一致，但不能单独证明 DeepSeek 官方 API 已开放原生图片输入。这个插件采用保守做法：只有模型目录和实际协议链路都允许图片时才直通，否则使用显式选择的视觉模型桥接。

## 安装

前提：已安装并初始化 DeepSeek Harness Web Profile。

```bash
git clone https://github.com/Ash-b07/deepseek-harness-vision-bridge.git
cd deepseek-harness-vision-bridge
./install-plugin.sh
```

安装器会：

1. 将 `plugin/` 链接到 Web Profile；
2. 给当前 rc.6 的 `dsh-host-apiproxy` 安装最小 Host 补丁；
3. 以标准双端 package 加载插件；
4. 迁移 1.0 的旧 shim 加载项；
5. 为每个 Host 文件保留 `.vision-bridge-v2.original` 备份。

Host 补丁只负责两项宿主能力：

- 视觉增强开启时，允许纯文本主模型所在会话接收图片；
- 模型目录返回 `inputModalities`，供独立选择器过滤。

补丁按精确代码签名安装；签名不一致时会在写入前失败。

重启：

```bash
dsh web
```

看到 `dsh web: http://127.0.0.1:3080` 即表示实例已启动。不要重复运行第二个实例，否则会出现 `EADDRINUSE`。

## 配置和使用

首次安装的默认配置：

```json
{
  "enabled": true,
  "visionProvider": "opencode",
  "visionModel": "mimo-v2.5-free",
  "maxTokens": null,
  "cacheTtlMs": 21600000
}
```

重启后，在输入框左侧打开「视觉增强」，选择例如 `opencode / MiMo V2.5 Free`。目标模型必须在 Harness 模型配置中声明：

```yaml
input: [text, image]
```

插件复用 Harness 已有的 Provider、API Key、base URL、重试和计费链路，不保存额外密钥。

## 三条视觉路径

| 路径 | 行为 |
|---|---|
| 直接上传图片 | 自动生成视觉观察，再用克隆请求调用当前主模型；2.0 的正常路径 |
| 主模型调用 `vision_bridge` | 显式 OCR、描述或视觉问答 |
| 主模型调用 `read_image` | 纯文本模型下兜底；受官方工具输出契约限制，会显示为带描述的失败结果 |

同一图片、问题、视觉路由和提示词版本在 6 小时内复用观察缓存。切换视觉模型会产生不同缓存键。

Agent Loop 的模型请求会被深度冻结。本次修复不再原地改写 `options.messages`：它生成一份只含文本观察的克隆请求，再调用原 Provider/模型，并通过一次性保护避免递归编排。

## 回滚 Host 补丁

```bash
node host-patch.mjs --revert \
  ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js \
  ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js
```

回滚后，纯文本主模型的直接图片上传会恢复为官方拒绝行为。

## 测试

```bash
npm test
```

测试不访问网络，覆盖能力判断、缓存、工具 Schema、`read_image` 兜底、Harness 后端、深度冻结请求和内部转发防递归。

## 隐私与成本

- 图片会发送到你选择的视觉模型服务商；
- 免费模型可能限流，付费模型可能产生费用；
- 敏感图片应使用可信服务或本地视觉模型；
- 不要把 API Key 写进仓库配置。

## 设计来源

- [fufankeji/deepseek-harness-studio](https://github.com/fufankeji/deepseek-harness-studio)：独立视觉入口、Host 图片准入、模型流编排和结构化视觉观察；
- [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)：透明视觉代理与图片描述回填思路；
- [anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775)：模型能力元数据与协议层准入不一致的案例。

详细演进见 [开发过程](docs/DEVELOPMENT.md)，限制见 [已知问题](docs/KNOWN_ISSUES.md)。

## License

MIT
