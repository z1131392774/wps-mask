# Copy: one sentence per state, no explanatory tail

*[中文](2026-11-24-copy-one-sentence_zh.md)*

## Problem

The empty state carried two lines: "在表格里选一块区域" followed by "整列、整行或任意一块都行；选好后这里会自动列出每一列". The second line was a patch on the first — reassurance that "a region" meant anything, plus a promise about what happens next. The user's rule: do not append explanations to copy; if one sentence cannot say it clearly, the sentence is wrong.

Measured against that rule, nearly every string in the pane was over budget:

- The leave-alone hint read "保持原值，不做处理" — a tautology.
- The mixed-mode hint was a five-item specification of shape handling, printed inside a panel.
- A grey "越大越平缓" sat beside the λ field — the label's job, done by a footnote.
- The status line read "已映射 2 列 / 5 格，跳过 6 格已映射（姓名、手机号）；新建 4 条映射，记得保存文档" — four numbers, two actions and a reminder in one sentence.
- "已按数据类型重新识别（忽略上次设置）" — a parenthetical annotating its own sentence.
- The capacity error ran two sentences plus an instruction.

## Decision

One sentence per state, carrying everything the state needs; if a second sentence is required for it to make sense, rewrite the first.

| Where | Before | After |
|---|---|---|
| Empty state | 在表格里选一块区域 / 整列、整行或任意一块都行；选好后这里会自动列出每一列 | 在表格里选中要脱敏的区域 |
| One cell | 选中的格子太少 / 至少要选两个单元格。勾了「首行是表头」时… | 至少选中两个单元格 |
| Phone hint | 生成 11 位合法手机号，列内不重复 | 换成合法的 11 位手机号 |
| Mixed hint | 每个值按它自己的形态换：手机号仍是…，邮箱只换…，固话保留…（five items） | 每个值换成同形态的假值 |
| Mask done | 已映射 2 列 / 5 格，跳过 6 格已映射（姓名、手机号）；新建 4 条映射，记得保存文档 | 已映射 5 格，跳过 6 格，记得保存文档 |
| Already masked | 这个区域已经映射过（跳过 11 格），没有可处理的新数据。要基于当前值再映射一次，请先反映射 | 这个区域已经映射过，先反映射再映射 |
| Interval too small | 第 G 列（工号）有 41 个不同值，但区间只有 40 个整数可取。请…放宽，或设为「不处理」 | G 列（工号）的区间只有 40 个整数，装不下 41 个不同值，请放宽区间或设为「不处理」 |

Detail moved into the help dialog, the one place where long explanation belongs and which the user opens on purpose. Distributions, suffix width, the tight-interval permutation, header semantics and the key boundary each became a single declarative line.

The empty state also lost its two-level structure: with one sentence there is no hierarchy to express, so it is a single muted line rather than a bold title over a grey subtitle.

## Alternatives considered

**Keep the subtitle but make it shorter.** Rejected: the two-line shape itself says "statement above, explanation below", and that hierarchy is what made the copy feel padded. That shape is exactly what the user objected to.

**Leave the five mixed shapes in the card.** Rejected: the card is an operation panel, not a specification. "Same shape" plus the sample line says enough; the full table lives in the README.

**Keep column count and created-mapping count in the status.** Rejected: the column count is visible in the cards, and the number of new mappings informs no decision. What matters is how many cells changed, how many were skipped, and that the document needs saving.

**Make errors state the problem only, with no remedy.** Rejected: an error must point at the next step, so the remedy stays in the same sentence, joined by a comma rather than a full stop.

## Consequences

`AGENTS.md` gained a line: every state gets one sentence, and an explanatory tail means the sentence is wrong.

Five panel assertions changed with the copy, and `showEmpty` now emits a single line, so the `.empty-t` and `.empty-d` rules are gone.

One side effect is worth recording: the status line no longer names which columns were skipped, so a user who wants to know must read the cards. That is the price of one sentence; if it turns out to matter, the right fix is a mark on the card, not the list pushed back into the status bar.
