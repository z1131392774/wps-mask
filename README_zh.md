# wps-mask-addon

*[English](README.md)*

一个 WPS 表格加载项：把选中区域里的数据换成看着像真的假数据，映射关系加密存进工作簿，随时一键还原原值。本仓库同时承载约束这个加载项怎么改的指令体系。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `wps-mask-addon/` | 加载项本体。产品手册见 [README.md](wps-mask-addon/README.md)，目录规则见 [AGENTS.md](wps-mask-addon/AGENTS.md) |
| `wps-mask-addon/test/` | Node 脚本：mock 对象模型上的引擎逻辑、与 `node:crypto` 比对的 AES、jsdom 里跑的任务窗格 |
| `AGENTS.md` | agent 的常驻规则，每次会话先读 |
| `docs/` | 标准：[指令与文档结构](docs/AGENTS.md)、[改动怎么做怎么验](docs/development.md)、[把这套树播种到别处](docs/adopting.md) |
| `.agents/notes/` | 决策记录：为什么选它、否掉了什么、代价是什么 |
| `.agents/skills/` | 只在描述匹配时才加载的流程：[推送前检查](.agents/skills/pre-push-checks/SKILL.md) |
| `scripts/check-docs.mjs` | 文档门禁：词数预算、双语配对、链接、锚点、行尾换行 |

## 跑起来

```sh
npm run check                              # 文档门禁，不用装依赖
node wps-mask-addon/test/engine.test.js    # 映射引擎
node wps-mask-addon/test/aes.test.js       # 加密算法，与 node:crypto 比对
npm i jsdom --no-save                      # 仅面板测试需要
node wps-mask-addon/test/taskpane.test.js  # 任务窗格，跑在 jsdom 里
```

装加载项本体的办法：把 `wps-mask-addon/wpsmask_1.0.0/` 和 `publish.xml` 拷进 `%APPDATA%\kingsoft\wps\jsaddons`，重启 WPS。安装步骤、功能对照表、以及还没在真机上验证的部分，都在[产品手册](wps-mask-addon/README.md)里。

## 两个机械事实

- 根 `package.json` 不声明 `"type"`：门禁是 `.mjs`，本来就走 ESM；而测试脚本是 CommonJS，写上 `"type": "module"` 就加载不起来。
- `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接。Windows 上要么开开发者模式，要么用 `New-Item -ItemType SymbolicLink` 建；直接复制一份会漂移。
