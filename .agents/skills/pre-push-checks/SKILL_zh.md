---
name: pre-push-checks
description: Use before pushing, opening a pull request, or claiming a change is verified, to select the smallest checks that cover the outgoing diff instead of rerunning the whole suite.
---

# 推送前的检查

*[English](SKILL.md)*

覆盖这次改动的检查，每项跑一遍就够。其余的归 CI。

下面几种情况，打开 [references/check-selection.md](references/check-selection.md)：下面的映射对不上；某项检查失败了，要判断它算不算这次的范围；改动跨过了你没预料到的边界。

## 1. 弄清要推走什么

```sh
git status --short --branch
git diff --stat <base>...HEAD
```

已暂存的、未暂存的、已提交但基线没有的，都算进来。从半份 diff 里挑出来的检查，证明不了其余部分。

## 2. 改动路径对应哪项检查

| 改动的路径 | 检查 |
| --- | --- |
| 任何 `*.md`、`AGENTS.md`、`.agents/notes/**` | `node scripts/check-docs.mjs` |
| 一个源文件和它的测试 | 该文件的聚焦测试 |
| 共用的辅助函数、公开签名、配置项、序列化格式 | 包级测试套件，外加类型检查 |
| 依赖清单、构建配置、入口文件 | 先构建，再把构建产物手动跑一遍 |
| 什么都没改 | 不检查。直说，别凭空造一项 |

## 3. 每项检查只跑一遍，记下结果

命令原样报，返回结果原样报。「应该能过」不算证据。

## 4. 停止规则

- 检查没过，就别推。修好它，或者带着输出报上来，不许声称改动已验证。
- 这项环境里跑不了的检查，带上原因报上来。不许偷偷换成更弱的一项。
- 别因为一次通过「感觉不踏实」就重跑。diff 没变，结果就算数。

## 5. 交接

跑过哪些检查、结果如何、哪些你选择不跑，都说明白。评审不该替你重建证据。
