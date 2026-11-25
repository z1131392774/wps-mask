# wps-mask-addon

*[English](README.md)*

WPS 表格加载项：把选中区域的数据替换成看似真实的假数据，映射关系加密保存在工作簿里，需要时一键还原原值。本仓库还包含约束加载项改动方式的指令文档。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `wps-mask-addon/` | 加载项本体。产品手册见 [README.md](wps-mask-addon/README.md)，目录规则见 [AGENTS.md](wps-mask-addon/AGENTS.md) |
| `wps-mask-addon/test/` | Node 脚本：基于 mock 对象模型的引擎测试、与 `node:crypto` 比对的 AES 测试、在 jsdom 中运行的功能区与任务窗格测试，以及真机探查用的桥 |
| `AGENTS.md` | agent 的常驻规则，每次会话开始时阅读 |
| `docs/` | 标准：[指令与文档结构](docs/AGENTS.md)、[改动与验证方法](docs/development.md)、[在其他仓库复用这套目录](docs/adopting.md) |
| `.agents/notes/` | 决策记录：为什么这样选、否决了什么方案、代价是什么 |
| `.agents/skills/` | 仅在描述匹配任务时加载的操作流程：[推送前检查](.agents/skills/pre-push-checks/SKILL.md) |
| `scripts/check-docs.mjs` | 文档检查：词数预算、双语配对、链接、锚点、决策记录头部、末尾换行 |

## 检查与测试

```sh
npm run check                              # 文档检查，不用装依赖
node wps-mask-addon/test/engine.test.js    # 映射引擎
node wps-mask-addon/test/aes.test.js       # 加密算法，与 node:crypto 比对
npm install                                # 测试依赖 jsdom，面板与辅助函数测试需要
node wps-mask-addon/test/ribbon.test.js    # 功能区回调与标记边框
node wps-mask-addon/test/taskpane.test.js  # 任务窗格，在 jsdom 中运行
node wps-mask-addon/test/utils.test.js     # 公共辅助函数：状态栏、错误文案、取应用对象
node wps-mask-addon/test/rpc.test.mjs      # 真机探查与 Node 之间的桥
```

`npm test` 按上面的顺序一次跑完六个测试文件。

安装加载项：把 `wps-mask-addon/wpsmask_1.0.0/` 和 `wps-mask-addon/publish.xml` 复制到 `%APPDATA%\kingsoft\wps\jsaddons`，重启 WPS。安装步骤、功能对照表和尚未在真机验证的部分见[产品手册](wps-mask-addon/README.md)。

## 两个配置细节

- 根 `package.json` 不声明 `"type"`：检查脚本使用 `.mjs` 后缀，始终按 ESM 加载；测试脚本是 CommonJS，一旦写上 `"type": "module"` 就无法加载。
- `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接。Windows 上需要开启开发者模式，或用 `New-Item -ItemType SymbolicLink` 创建；直接复制会导致两份文件内容不同步。
