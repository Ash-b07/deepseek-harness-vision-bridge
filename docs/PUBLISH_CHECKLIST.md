# GitHub 发布清单

代码推送到 GitHub 后，完成以下仓库侧设置：

- [ ] 将仓库可见性设为 Public；
- [ ] 启用 GitHub Discussions；
- [ ] 检查 README 中的 Discussions 链接；
- [ ] 添加 `dsh-plugin` topic；
- [ ] 添加辅助 topics：`deepseek-harness`、`deepseek`、`multimodal`、`image-understanding`、`ocr`、`nodejs`；
- [ ] 启用 Secret scanning 与 Push protection；
- [ ] 确认 GitHub Actions 的 Node.js 20、22 测试通过；
- [ ] 将首次 Release 标记为 `v1.0.0-preview.1` 和 Pre-release；
- [ ] 在 Release Notes 中链接 `docs/DEVELOPMENT.md` 与 `docs/KNOWN_ISSUES.md`。

发布前本地检查：

```bash
npm test
git status
git diff --cached
git ls-files
```
