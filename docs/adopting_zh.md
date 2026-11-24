# 采用这套体系

*[English](adopting.md)*

两种起点。新仓库还没有任何规则，agent 需要先拿到模板才能写代码。已有的仓库已经包含规则必须描述的事实，所以接入时先审计，后复制。

两条路终点相同：一份简短的根文件、一套强制执行它的检查、存放在使用处的细节。

## 新仓库

启动问题是个循环：仓库还没有指令，agent 却需要指令。打破循环的办法是把模板和命令交给 agent，不要让它自己发明约定。

1. 把这棵目录树复制进仓库。

```sh
git clone <template-repo> my-project
cd my-project
rm -rf .git
git init
```

如果要加进一个已有的空目录，就连隐藏文件一起复制：

```sh
cp -R <template>/. my-project/
```

2. 让 agent 用实际运行过的命令填好**项目事实**，删掉不适用的规则，再运行 `npm run check`。

3. 像审查第一次提交那样审查结果。三项事实和删掉的规则，是本项目决策的所在。

### 给 agent 的指令

把下面这段作为第一条消息粘贴，路径替换为实际路径。它有效，因为每一步都有可检查的结果。

```text
Bootstrap this repository's agent instructions from <path-to-template>.

Copy AGENTS.md, CLAUDE.md, docs/, .agents/, scripts/, .github/, and package.json
to the repository root, then work in this order:

1. Inspect the repository and determine the real stack, test, lint, typecheck,
   and build commands. Prefer commands that already exist in the project.
2. Replace the three lines under "Project facts". Run each command once. Never
   record a command you have not run.
3. Delete every rule that does not apply here, and say which ones you deleted
   and why. Do not add rules yet; the first rules come from real incidents.
4. Run `npm run check` and report its exact output.
5. Commit everything as one change titled "Add agent instructions".
```

## 已有的仓库

不要成套复制规则。其中大半描述的是一个不存在的项目，而错误的规则比缺失的规则更糟：它会让 agent 不再信任这份文件。

**第 1 步——记录现状。** 复制 `AGENTS.md`、`CLAUDE.md`、`docs/AGENTS.md`、`docs/development.md`、`scripts/`、`package.json` 和 `.github/`。三项事实填上今天能运行的命令。凡是对不上本仓库实情的规则，全部删除。运行 `npm run check`。

**第 2 步——按当前大小定预算。** 如果文档已经很长，把每份的上限设为当前词数加约 10%，然后边精简边下调。上限低于当前大小，会逼你删掉没想清楚的内容，而最先删掉的往往是最重要的那条规则。

**第 3 步——决策记录从下一个决定开始。** 不要为过去的选择补写决策记录。当时的备选方案已经忘了，只能编造；编造的理由是一句假话，比所有能纠正它的人都活得长。第一份真正的记录通常在一个月内出现，内容一般是某个依赖或某种格式的选择。

**第 4 步——重复两遍再写成技能。** 同一套步骤解释过两遍（「推送前运行哪些检查？」「怎么发版？」），就移进 `.agents/skills/<name>/SKILL.md`。解释过两遍的流程，值得单独写一份文件。

**第 5 步——目录攒够了规则才有子目录文件。** 一个目录有了三条规则，或一条规则反复被忽略，这个目录就需要一个 `AGENTS.md`。

## 两个配置细节

符号链接的 `CLAUDE.md` 只有 Git 按符号链接存储时才能在 clone 后保留；Windows 上需要开启开发者模式，或用 `New-Item -ItemType SymbolicLink -Path CLAUDE.md -Target AGENTS.md` 创建。

从第一次提交起就保持检查通过。第一周失败的检查，第二周就会变成被无视的检查，文件里的规则也就失去了约束力。

## 双语留还是撤

这里的每份文档都有两份：一份英文源稿，一份 `_zh.md` 译文。译文缺失、译文不互链、任一侧超出预算，`check-docs.mjs` 都会报错。过期的译文比没有更糟。

选一种状态，检查脚本在同一次提交里跟着改：

- **两种语言都留。** 配对规则不动。由 subagent 从英文源稿翻译，再按 `docs/AGENTS.md` 的写作规则验收。语序照搬英文的译文，读起来就是机器翻译。
- **只留一种语言。** 删掉译文，`check-docs.mjs` 里的 `zhMultiplier` 和配对检查一并去掉，`AGENTS.md` 和 `docs/AGENTS.md` 里的规则也删。其余检查保持不变；预算和链接仍然需要。
- **暂时只留一种。** 缺的译文列进 `doc-budgets.json` 的 `excludePairs`。豁免是显式可见的，译文补齐后就移除。

## 该预期什么

第一版的问题会是规则太多。这是常见的失败：规则写在支撑它们的事故之前。纠正的办法是删，不是加，发生在 agent 做出你没预料到的事的头一个月。根文件稳定下来之前，预留两三轮修订。

再往后维护量很小：事故暴露一条规则就加一条，文件逼近预算就把一段移到下一层，每次推送前运行 `npm run check`。
