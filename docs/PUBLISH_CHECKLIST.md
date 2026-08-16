# GitHub 发布清单

代码推送到 GitHub 后：

- [ ] 检查草稿 PR 的完整差异；
- [ ] 确认 GitHub Actions 的 Node.js 20、22 测试通过；
- [ ] 合并后创建 `v2.0.0-preview.1` Pre-release；
- [ ] 在 Release Notes 中链接 `CHANGELOG.md`、`docs/DEVELOPMENT.md` 与 `docs/KNOWN_ISSUES.md`；
- [ ] 确认 README 保留 [anomalyco/opencode#26775](https://github.com/anomalyco/opencode/issues/26775) 以及对应的官方 API 文档边界；
- [ ] 保留 `dsh-plugin`、`deepseek-harness`、`multimodal`、`image-understanding`、`ocr`、`nodejs` topics；
- [ ] 保持 Secret scanning 与 Push protection 开启。

发布前本地检查：

```bash
npm test
git diff --check
git status
git diff --cached
git ls-files
```
