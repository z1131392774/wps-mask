# AGENTS.md —— 一套最小可用的指令体系

*[English](AGENTS.md)*

本文件是在本仓库工作的 agent 的常驻规则，每次会话开始先读它。规则背后的标准另有两份：指令与文档的组织方式，看 [docs/AGENTS.md](docs/AGENTS.md)；改动怎么做、怎么验证，看 [docs/development.md](docs/development.md)。第一次动手前，先读相关的那份。

这里的规则刻意写短。背景、例子、操作步骤归链接指向的归属，不进本文件。

本文件与更近的 `AGENTS.md` 不一致时，以更近的那份为准，范围限它自己目录下的路径。本文件没交代的事，由那两份文档决定。

## 项目事实

- Stack: JavaScript（ES5 写法、无打包器）+ WPS JSAPI；测试脚本用 Node 22；加载项本身不带任何依赖
- Verify: `node wps-mask-addon/test/engine.test.js`、`node wps-mask-addon/test/aes.test.js`、`npm i jsdom` 后 `node wps-mask-addon/test/taskpane.test.js`；文档改动运行 `npm run check`。没有 lint，也没有 typecheck
- Build: 无——加载项是纯文件，复制到 `%APPDATA%\kingsoft\wps\jsaddons` 即生效

## 动手之前

- **动手前，先用一条短消息说清任务和计划。** 请求有两种合理读法时，问清楚要哪一种。假设错误的代价高于提问。
- **先看工作区。** `git status` 和相关文件能告诉你有没有人正在修改。不熟悉的、未提交的改动都视为用户的工作：阅读它们，不要为了方便自己而还原、格式化或删除。
- **添加任何东西之前，先找到它现有的归属。** 搜一遍覆盖这块的函数、配置项、测试或文档。在它上面扩展，或者说明为什么需要第二份。重复的机制会双倍增加维护成本，且容易逐渐不一致（[层级](docs/AGENTS.md#the-tier-model)）。

## 改动纪律

- **一次改动，一个目的。** 修 bug 不捎带重构，加功能不捎带升级依赖。不相干的工作拆开，各自提交，或各自发 PR。
- **用能彻底解决问题的最小 diff。** 不顺手格式化，不改无关命名，不为不存在的调用方提前抽象（[改动纪律](docs/development.md#change-discipline)）。
- **与周边代码保持一致。** 命名、错误处理、日志、测试布局，都按文件里已有的写法来，即使你有别的偏好。在既有代码库里，一致性优先于个人偏好。
- **就近大声失败。** 非法输入在入口处拒绝；不要悄悄替换默认值、吞掉错误、带着不完整的状态继续执行。每个空的 `catch` 都要写明忽略了什么错误、为什么（[失败处理](docs/development.md#failure-and-error-handling)）。
- **把接口当合同。** 改公开函数、CLI 参数、配置项、文件格式或传输字段，影响的是 diff 之外的调用方：所有使用方、所有引用，都在同一次改动里更新。
- **在改动合并后仍然有效的决策，写成决策记录。** 提案放在 `proposed/`，已实施的决策放在 `implemented/`；更新持有该决策的那份记录，不要另起一份（[格式](.agents/notes/README.md)）。
- **绝不提交密钥。** 代码、测试、夹具、日志、提交信息里都不放密钥、令牌、凭据、`.env` 内容。

## 验证

- **运行能覆盖本次改动的最小检查**，改动跨越边界时再扩大范围。如实报告命令和结果。没有运行过的检查不许声称运行过（[验证阶梯](docs/development.md#verification-ladder)、[推送前的挑选](.agents/skills/pre-push-checks/SKILL.md)）。文档改动运行 `npm run check`。
- **测试写行为，不写实现。** 行为变了，同一个提交里更新它的测试；只断言旧实现的测试要替换，PR 里说明原因。
- **交出去之前，自己过一遍 diff。** 对着[审查清单](docs/development.md#review-checklist)把 `git diff` 从头读到尾。残留的调试输出、死代码、写了一半的注释，都是缺陷。

## 汇报

- **说清做了什么、验证了什么、还有什么不确定。** 写明文件名和命令。不要叙述探索过程，用户要的是结果和证据。
- **失败就直说，并停掉依赖它的后续工作。** 检查未通过、结果未知时，把输出展示出来。不要悄悄降级，不要盲目重试。
- **规则没覆盖到的情况，问。** 一句简短的提问，好过凭空发明的惯例。

## 知识的归属

规则能放多深就放多深，同时保证需要它的人读得到；[层级模型](docs/AGENTS.md#the-tier-model)给每一层起了名字。只在特定时刻使用的操作步骤，放 [`.agents/skills/`](.agents/skills/pre-push-checks/SKILL.md)，描述匹配任务时再加载。决策放 [`.agents/notes/`](.agents/notes/README.md)。

只有每次会话都用得上的规则，才加进本文件。否则放到它该在的归属，并链接一次。

## 文档语言

英文是源稿；每份文档旁边放一份中文译文，文件名以 `_zh.md` 结尾，两边互相链接。缺少译文时，`npm run check` 会报错，单一语言的文档无法提交。[双语规则](docs/AGENTS.md#bilingual-documents)说明了译文能改什么、不能改什么。
