# DeepSeek Harness Vision Bridge

一个仍在探索中的 DeepSeek Harness 视觉桥插件：让纯文本 DeepSeek 模型把图片交给 Harness 中已经配置好的多模态模型，再用返回的文字继续推理。

> [!WARNING]
> 这是 `1.0 Preview`，不是成熟插件。它已经跑通了工具调用和图片上传两条链路，但仍有重复识别历史图片、免费视觉模型限流、单后端无自动回退等问题。这个仓库会保留这些问题和解决过程，而不只展示最后结果。

本项目是非官方社区实验，与 DeepSeek 官方无隶属或背书关系。

## 为什么做这个

DeepSeek V4 Flash / Pro 在 Harness 中是纯文本路由。遇到图片时，原有行为通常只有两种：

- 当前路由声明支持图片：正常放行；
- 当前路由不支持图片：拒绝并提示切换模型。

我希望保留 DeepSeek 的推理、工具调用和长上下文，只在需要看图时借用另一个视觉模型，因此尝试加入第三条路径：

```text
图片输入
   │
   ├─ 当前模型原生支持图片 ──> 原样放行
   │
   └─ 当前模型是纯文本模型 ──> 视觉模型生成文字描述 ──> DeepSeek 继续推理
```

更完整的试错过程见 [开发过程](docs/DEVELOPMENT.md)。当前缺陷见 [已知问题](docs/KNOWN_ISSUES.md)。

## 1.0 Preview 已实现

- `vision_bridge` 工具：支持 `describe`、`ocr`、`vqa` 三种模式；
- `read_image` 兜底：纯文本路由调用内建图片工具时，尝试返回视觉模型生成的文字；
- 上传适配器：提供 `vision-bridge` 路由，允许上传图片，并在转发给 DeepSeek 前把图片替换为文字描述；
- 模态感知：原生支持图片的模型不经过桥接；
- 工具路径缓存：按图片 SHA256、模式和问题缓存 6 小时；
- 零运行时依赖：插件主体使用 ESM 和 Node.js 内建模块。

需要特别说明：目前缓存只完整覆盖 `vision_bridge` / `read_image` 工具路径，尚未覆盖上传适配器中的历史图片转换。

## 工作方式

插件有两个入口：

### 1. 显式工具

纯文本模型可以调用：

```text
vision_bridge(file_path, mode, question?)
```

这是当前最干净的路径，因为工具拥有自己的输入、输出 Schema 和渲染逻辑。

### 2. 上传图片

插件注册 `vision-bridge` provider，并镜像 `deepseek-official` 的模型目录。该 provider 对外声明支持图片，在 `stream()` 中执行：

```text
图片附件 -> 已配置的视觉模型 -> [Image Description: ...] -> deepseek-official
```

## 安装

前提：已经安装并初始化 DeepSeek Harness Web Profile。

```bash
git clone <your-repository-url>
cd deepseek-harness-vision-bridge
./install-plugin.sh
```

安装脚本会：

1. 将 `plugin/` 链接到 `~/.dsh/profiles/web/node_modules/vision-bridge`；
2. 备份并更新 `~/.dsh/profiles/web/cordis.patch.yml`；
3. 提示你重启 Harness。

脚本会修改本地 Harness Profile，运行前建议先阅读 [install-plugin.sh](install-plugin.sh)。

## 配置视觉模型

插件不会自带 API Key，也不会直接绑定某家视觉服务。它复用 Harness `settings.yaml` 中已经配置好的模型路由。

复制示例配置：

```bash
cp config.local.json.example config.local.json
```

```json
{
  "visionProvider": "opencode",
  "visionModel": "mimo-v2.5-free",
  "maxTokens": null,
  "cacheTtlMs": 21600000
}
```

目标模型必须在 Harness 模型目录中声明图片输入，例如：

```yaml
llm-pi-ai:
  providers:
    opencode:
      models:
        - id: mimo-v2.5-free
          input: [text, image]
```

这里的声明只表示“允许发送图片”，并不能证明服务端模型一定支持视觉能力。

## 使用

显式读取本地图片：

```text
请用 vision_bridge 看一下 /absolute/path/to/image.png
```

直接上传图片时，在 Harness 中选择：

```text
vision-bridge / deepseek-v4-flash
```

也可以把它设置为新会话默认模型：

```yaml
agent-default-model:
  provider: vision-bridge
  model: deepseek-v4-flash
```

## 测试

测试不访问网络，使用假的 Harness 上下文和模型流：

```bash
npm test
```

当前覆盖能力判断、缓存、工具 Schema、`read_image` 钩子、Harness 后端和上传适配器。

## 隐私与成本

- 图片会发送到你配置的视觉模型服务商；
- 免费模型可能限流，付费模型可能产生费用；
- 敏感图片应使用可信服务或本地视觉模型；
- 不要把 API Key 写进 `config.local.json.example` 或提交到 Git。

## 社区与支持

- 欢迎通过 [GitHub Discussions](../../discussions) 提交使用反馈、分享视觉模型配置或报告问题；
- 如果问题可能包含 API Key、内部图片或其他敏感信息，请先脱敏，不要直接发布到公开讨论区；
- 本仓库使用 `dsh-plugin` topic，方便在 DeepSeek Harness 插件生态中被发现。

## Roadmap

- 为上传适配器增加图片指纹缓存，避免多轮会话重复识别历史图片；
- 支持多个视觉路由自动回退；
- 按 429、鉴权、超时和格式错误区分处理；
- 改善失败时的会话体验；
- 补充真实环境兼容性测试。

## 开源说明

项目使用 MIT License。实现过程参考了 DeepSeek Harness 的插件与工具接口，以及 `deepseek-v4-for-copilot` 的透明视觉代理思路，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
