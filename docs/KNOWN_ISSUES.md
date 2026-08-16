# 2.0 Preview 已知问题

## 1. Host 补丁绑定 DeepSeek Harness rc.6

独立视觉入口需要宿主在图片准入阶段读取插件设置，并让模型目录返回 `inputModalities`。当前实现对 `0.1.0-rc.6` 的已安装文件做精确签名补丁。

安装器在签名不匹配时会拒绝写入，并保留 `.vision-bridge-v2.original` 备份。Harness 升级后应先运行补丁检查，不要假定兼容。

## 2. 模型能力元数据可能与协议或服务端不一致

`input: [text, image]` 只决定独立选择器是否展示该模型，并不能证明最终服务端接受图片。

[anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775) 正好展示了这种不一致：模型条目声明 image，但 OpenAI Chat 协议只允许 text。另一方面，DeepSeek 官方当前公开文档仍把 V4 的图片输入描述为不支持或 text-only。因此本插件不会把第三方模型目录声明当成 DeepSeek 官方原生视觉能力证明。

## 3. 只有一个视觉后端

当前设置只有一组 `provider + model`。429、超时、鉴权失败或服务故障不会自动切换备用模型。

## 4. `read_image` 兜底会显示红色

这是 Harness 工具输出协议的折中。桥接描述仍会放进工具结果内容，但 UI 会把它显示为失败调用。正常路径是直接上传图片或显式使用 `vision_bridge`。

## 5. 图片会离开主模型服务商

视觉增强会把图片发送给用户选择的视觉 Provider。免费模型可能限流，付费模型可能产生费用；敏感图片应使用可信服务或本地模型。

## 6. CI 不执行真实模型调用

单元测试使用假的 Harness 上下文和流，不消耗额度。发布前完成了本机 UI 与启动检查，但不会自动上传用户图片验证外部视觉服务。
