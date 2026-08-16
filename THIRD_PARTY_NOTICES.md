# Third-party notices

本项目是独立的非官方社区项目。

## DeepSeek Harness

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Packages consulted: `@deepseek-ai/dsh-tool-fs`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`
- Package metadata license: MIT

实现过程中参考了 Harness 的 `read_image` 能力判断、文件沙箱解析、工具分发结果和 LLM Adapter 接口。相关上游包的本地元数据显示版本为 `0.1.0-rc.6`、许可证为 MIT。

## deepseek-v4-for-copilot

- Repository: https://github.com/Vizards/deepseek-v4-for-copilot
- License: MIT

本项目参考了其“将图片交给另一个视觉模型，再把文字描述交回纯文本 DeepSeek”的透明视觉代理思路，以及 `[Image Description: ...]` 的文本标记形式。

Upstream license notice:

```text
MIT License

Copyright (c) 2026 Vizards

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## deepseek-harness-studio

- Repository: https://github.com/fufankeji/deepseek-harness-studio

2.0 的独立视觉入口、Host 图片准入和结构化视觉观察方案参考了该项目的公开架构。当前实现重新编写，并将视觉路由改为从 Harness 模型目录动态选择。

## OpenCode protocol evidence

- Issue: https://github.com/anomalyco/opencode/issues/26775

该 issue 被引用为“模型能力元数据与协议层准入可能不一致”的公开案例。引用不表示本项目复用了 OpenCode 代码，也不表示 issue 中的第三方模型条目能够证明 DeepSeek 官方 API 的服务端能力。

所有第三方项目的名称与商标归各自权利人所有。上述引用不表示这些项目对本仓库提供背书。
