# AGENTS.md —— GitHub Actions

*[English](AGENTS.md)*

- **两个作业，两种用途。** `docs` 跑 `npm run check`；`tests` 在 Node 22 下装 `jsdom` 后跑三个测试脚本。文档不变量归门禁脚本，不归工作流步骤；需要另一个 Node 版本或安装步骤的检查，才在这里单开作业。
- **门禁不带安装步骤。** 门禁只导入 Node 标准库，`docs` 作业因此跳过 `npm ci` 和缓存。往门禁加依赖，意味着同一次改动里要给那个作业加一步安装。
- **工作流改完，先在 pull request 上验一遍。** 没跑过就发的改动，语法和权限都是未知数。开 pull request，盯作业跑完，再合并。
