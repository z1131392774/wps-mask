# 采用这套体系

*[English](adopting.md)*

两种起点。新仓库还没有任何规则，agent 得先拿到模板才能写代码。已有的仓库里躺着规则必须描述的事实，所以接入是先审计，后拷贝。

两条路终点相同：一份短的根文件、一道让它保持诚实的门禁、一份住在使用处的细节。

## 新仓库

启动问题是个圈：仓库还没有指令，agent 却需要指令。破圈的办法是把模板和命令递给 agent，不是让它自己发明约定。

1. 从这棵树给仓库播种。

```sh
git clone <template-repo> my-project
cd my-project
rm -rf .git
git init
```

想加进一个已有的空目录，就连点文件一起拷过去：

```sh
cp -R <template>/. my-project/
```

2. 让 agent 拿跑过的命令填好**项目事实**，删掉不适用的规则，再跑 `npm run check`。

3. 像审第一次提交那样审结果。三项事实和删掉的规则，是本项目决策的所在。

### 给 agent 的简报

把它当第一条消息粘贴出去，路径换成真的。它管用，因为每一步都落到证据上。

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

别成套拷贝规则。其中大半描述的是一座不存在的项目，而错的规则比缺的规则更糟：它教 agent 少信这份文件。

**第 1 步——记录现实。** 拷 `AGENTS.md`、`CLAUDE.md`、`docs/AGENTS.md`、`docs/development.md`、`scripts/`、`package.json` 和 `.github/`。三项事实填上今天能跑的命令。凡是对不上本仓库实情的规则，全删。跑 `npm run check`。

**第 2 步——按当前大小定预算。** 手里的文档已经很长，就把每份的上限设成它当前的词数再加一成上下，然后边精简边降。上限低于当前大小，会逼你删没想清楚的东西，而最先删掉的往往是顶要紧的那条规则。

**第 3 步——决策记录从下一个决定开始。** 别为过去的选择补决策记录。当时的备选方案你早忘了，只好编；编出来的理由是一句假话，比所有能纠正它的人都活得长。预期：第一份真正的记录一个月内就会出现，通常是关于某个依赖或某种格式的选择。

**第 4 步——重复两遍再写成技能。** 同一套步骤解释过两遍（「推送前跑哪些检查？」「怎么发版？」），就挪进 `.agents/skills/<name>/SKILL.md`。解释一遍是对话，解释两遍是流程。

**第 5 步——目录攒够了规则才有子目录文件。** 一个目录攒出三条规则，或一条规则老是翻不出来，这个目录就挣到一个 `AGENTS.md`。

## 两个机械细节

符号链接的 `CLAUDE.md` 只有 Git 按符号链接存储才能活着走过 clone；Windows 上要么开开发者模式，要么用 `New-Item -ItemType SymbolicLink -Path CLAUDE.md -Target AGENTS.md` 建。

从第一次提交起就让门禁保持绿。第一周的红门禁，第二周会变成无视它的习惯，再往后文件的承诺就只是装饰。

## 双语留还是撤

这里的每份文档都出两遍：一份英文源稿，一份 `_zh.md` 孪生。孪生缺失、孪生不回链、任一侧超出预算，`check-docs.mjs` 都报错。过期的孪生比没有更糟。

选一种状态，门禁在同一次提交里跟着改：

- **两种语言都留。** 配对规则不动。译文从英文源稿出，让 subagent 译，再拿 `docs/AGENTS.md` 的写作规则验收。语序照搬英文的孪生，不及格。
- **只留一种语言。** 删掉孪生，`check-docs.mjs` 里的 `zhMultiplier` 和配对检查一并去掉，`AGENTS.md` 和 `docs/AGENTS.md` 里的规则也删。门禁其余部分原样留着；预算和链接还值得留。
- **暂时只留一种。** 缺的孪生列进 `doc-budgets.json` 的 `excludePairs`。豁免摆在明处，孪生补齐那天就撤。

## 该预期什么

第一版会错在规则太多。这是正常的失败：规则写在为它们撑腰的事故之前。纠偏的办法是删，不是加，就发生在 agent 做出你没预料到的事的头一个月。根文件稳定下来之前，预留两三轮修订。

再往后维护量很小：事故暴露一条规则就加一条，文件逼近预算就把一段往下挪，每次推送前跑 `npm run check`。
