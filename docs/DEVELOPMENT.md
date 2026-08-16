# 开发过程：从“让模型看图”到视觉桥

这不是一条一次成功的实现路线。1.0 的价值更多在于验证了 DeepSeek Harness 中图片输入、工具分发、适配器和模型能力声明之间的真实关系。

## 0. 最初目标

目标不是把 DeepSeek 换成视觉模型，而是：

1. 主模型始终使用 DeepSeek；
2. 只有遇到图片时才调用视觉模型；
3. 视觉模型只返回文字事实，最终分析仍由 DeepSeek 完成；
4. 尽量不引入额外代理进程和独立聊天界面。

## 1. 第一条路：独立视觉 MCP

最早尝试过把视觉能力做成独立 MCP 工具。它能够读图，但存在几个体验问题：

- 模型必须主动选择正确工具；
- 上传图片不会自动触发 MCP；
- MCP 自己管理服务地址和凭据，与 Harness 已有模型配置重复；
- 它解决了“有工具可用”，但没有解决“图片自然进入会话”。

这次尝试没有完全浪费，它确认了“视觉模型生成文本，再交给 DeepSeek”这条基本链路可行。

## 2. 第二条路：注册 `vision_bridge` 工具

接下来把视觉调用直接放进 Harness 插件，并注册 `vision_bridge`。

第一个严重问题来自工具 Schema。`ctx.tools.register()` 是底层注册入口，不会把参数属性表自动编译成 JSON Schema。如果没有对象根节点：

```json
{
  "type": "object",
  "properties": {}
}
```

DeepSeek 会在发送整轮请求时拒绝 function schema。结果不是“工具调用失败”，而是这个工具存在期间每轮对话都可能失败。

解决方式是手写完整对象根 Schema，并为这个契约增加测试。

## 3. 第三条路：拦截 `read_image`

为了让模型即使错误调用内建 `read_image` 也能拿到描述，插件加入了 `tools/execute` 钩子。

这里出现了一个反直觉问题：钩子替内建工具返回成功结果时，Harness 会继续使用 `read_image` 自己的输出 Schema 和渲染器处理它。视觉桥返回的是文字，而 `read_image` 期望自己的图片结果，因此成功结果反而会再次失败。

当前 1.0 的折中方案是：

- 在失败结果的 `content` 中携带完整图片描述；
- 明确告诉模型不要重试 `read_image`；
- 引导后续使用 `vision_bridge`。

代价是 UI 会显示红色工具结果。它不够漂亮，但真实反映了当前 Harness 工具分发接口的边界。

## 4. 第四条路：解决上传预检

工具桥仍然无法解决拖拽上传，因为图片在模型开始推理前就会经过能力预检。纯文本 DeepSeek 路由没有声明 `image`，所以请求在插件工具运行前已经被拦截。

为此 1.0 注册了一个新的 `vision-bridge` provider：

1. 镜像 `deepseek-official` 的模型；
2. 对外声明 `text + image`；
3. 在 `stream()` 中把图片块转换成文本；
4. 把纯文本消息转发给真正的 `deepseek-official`。

这条路打通了上传，但也意味着用户需要选择 `vision-bridge / deepseek-v4-flash`，或者把它设为默认路由。

## 5. 免费视觉模型 429

端到端链路跑通后，免费视觉路由出现了 `429 Rate limit exceeded`。

检查实现后发现问题不只有免费额度：上传适配器每轮都会扫描完整消息历史；只要历史中还存在图片块，就会再次调用视觉模型。工具桥的 SHA256 缓存没有覆盖这条 shim 路径。

因此同一张图片可能在后续追问、工具循环和重试中被重复识别，最终放大限流问题。

这个问题在 1.0 中被保留为已知缺陷，因为它恰好说明：

- 单元测试通过不代表真实多轮会话正确；
- 缓存必须放在所有入口共享的编排层；
- 免费模型的限流只是表象，重复调用才是需要先修的根因；
- “让用户换模型”不应该成为路由故障的最终交互。

## 6. 1.0 做到了什么

1.0 证明了三件事：

- Harness 可以通过自定义工具为纯文本模型补充视觉上下文；
- 新 provider 适配器可以绕过上传预检并在转发前转换图片；
- 视觉调用可以复用 Harness 已配置的 provider/model，而不是在插件中再维护一套 Key。

它还没有解决自动回退、跨入口缓存和完全无错误提示。后续版本会先修重复识图，再考虑多路由与熔断。

## 7. 2.0：从 shim Provider 改为独立视觉入口

1.0 虽然打通了上传，但把 `vision-bridge` 放进主模型选择器，用户必须在“DeepSeek”和“桥接后的 DeepSeek”之间手动切换。2.0 借鉴 `deepseek-harness-studio` 的交互，把视觉路由拆成输入框左侧的独立选择点：

- 主模型仍是原来的 Provider/模型；
- 视觉入口只展示声明了 image 输入能力的模型；
- 开关和视觉路由通过 Host settings 持久化；
- Host 只负责图片准入和返回模型模态元数据；
- 全局模型流在必要时生成结构化 `vision_observation`。

旧 shim Provider 因此被删除，主模型列表不再出现 `vision-bridge` 分组。

## 8. 深度冻结请求故障与修复

第一版自动编排直接执行 `options.messages = messages`。真实 Agent Loop 会深度冻结完整请求，这导致：

```text
Cannot assign to read only property 'messages' of object '#<Object>'
```

Harness 的 `llm/stream` 中间件契约明确要求监听器只读 loop-built request。修复方式不是尝试解冻，而是：

1. 保持原请求完全不变；
2. 视觉模型生成观察文本；
3. 创建一份保留原 Provider、模型、推理参数和 signal 的克隆请求；
4. 克隆请求携带替换后的纯文本 messages；
5. 用 WeakSet 只绕过这一次内部编排，再进入原 LLM runtime。

回归测试使用深度冻结对象复现真实边界，并让内部调用再次经过同一中间件，确认视觉适配器和主模型适配器各调用一次、不会递归。

## 9. 模型声明、协议准入和官方能力不是一回事

[anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775) 报告：OpenCode v0.99.1 的模型条目把 `deepseek-v4-flash` 标为 text+image，但 OpenAI Chat 协议在客户端只允许 text，所以图片请求没有发到服务端。

这证明了“模型目录元数据”和“协议层准入”可能矛盾。但继续核对 DeepSeek 官方文档后，Chat Completions 的 user content 仍是文本字符串，Anthropic 兼容表把 image 标为不支持，官方 Copilot 集成也使用外部视觉模型代理图片。因此 2.0 不把 OpenCode 条目当作 DeepSeek 官方原生视觉已经开放的证据，而把它记录为链路能力判断必须分层的案例。
