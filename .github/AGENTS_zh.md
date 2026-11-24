# AGENTS.md —— GitHub Actions

*[English](AGENTS.md)*

- **两个作业，两种用途。** `docs` 运行 `npm run check`；`tests` 先用 `npm ci` 装好测试依赖（`jsdom`），再在 Node 22 下运行 `npm test`。文档不变量归检查脚本，不归工作流步骤；需要另一个 Node 版本或安装步骤的检查，才在这里单开作业。
- **检查不需要安装步骤。** 脚本只导入 Node 标准库，`docs` 作业因此跳过 `npm ci` 和缓存。给脚本加依赖，意味着同一次改动里要给那个作业加一步安装。
- **工作流改完，先在 pull request 上验证。** 未运行就合并的改动，语法和权限都是未知数。开 pull request，确认作业通过后，再合并。
