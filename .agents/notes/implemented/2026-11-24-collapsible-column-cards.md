# Collapsible column cards, and a way to look at the pane

*[中文](2026-11-24-collapsible-column-cards_zh.md)*

## Problem

The panel rendered one fully expanded card per column. A ten-column sheet — the ordinary case — became roughly 1,300 px of scrolling in a 300 px-wide pane, so the user could not see which columns exist, which type each was detected as, or what a value would look like, without scrolling past cards they did not care about. The parameters of a column nobody needed to touch occupied the same space as the actions. Beyond layout, three defects were visible in the render: metadata sat at 3.0–3.2:1 contrast, buttons and links had no visible keyboard focus, and an empty selection showed the same sentence twice, once in the list area and once in the status line.

## Decision

Split each card into a header that always shows name, mapping mode and a sample value, and a parameter body that opens on demand. Columns default to open when there are three or fewer — where a collapse would only cost clicks — and to closed otherwise, with one 展开全部 button for the whole list. The header row itself is the hit area; the caret is a real button so keyboard users can reach it, and it carries `aria-expanded`. The mode dropdown lost its "映射为" prefix (repeated ten times it was noise, and the panel title and primary button already say what the dropdown means), options read 手机号 / 数字 / 文本 / 不处理.

Visually the pane keeps its incumbent language — white cards, one blue accent, native controls — and only tightens it: a single cool-grey palette with contrast measured on the rendered backgrounds, one radius scale (8 container / 6 control / 4 chip), one spacing scale, focus rings instead of `outline: none`, and status messages as tinted banners with a left rule so success and failure no longer look like a slightly different shade of grey. `flex` `gap`, CSS variables and grid were removed, because the pane's embedded browser version is unknown and those fail silently.

## Alternatives considered

**Leave the flat list and rely on scrolling.** Rejected: the pane's job is choosing which columns to mask, and that decision needs the whole column set on screen at once.

**One page per column (a list view that pushes a detail view).** Rejected: back-and-forth navigation in a 300 px pane, and it hides the overview behind a click for every column rather than for the few that need parameters.

**Accordion with only one card open at a time.** Rejected: comparing two columns' settings becomes a memory task, and users legitimately want 月薪 and 订单号 open together.

**Tabs per column.** Rejected: tab strips do not scale past about five items, and the ten-column case is exactly the one that breaks.

**Keep the ratio of open cards but shorten the parameter area (hide row labels, icon-only controls).** Rejected: unlabelled number inputs in a masking tool invite the wrong edit, and the parameters are the part that needs words.

## Consequences

The pane now has a layout that a test cannot see, so `tools/preview-pane.mjs` renders it against the mock object model with a ten-column workbook and exposes state switches (`?open=`, `?noselect`, `?mask`); screenshots at 260/300/380 px are the evidence, and the directory rules require them for UI changes. The tool and its output are gitignored, and it stubs `module` so the CommonJS test mock can load in a browser. Behaviour is untouched: the same `data-i`, `.mode`, `.dist`, `.f-*`, `.samp` and `#status` hooks remain, so the jsdom regression still passes unchanged. Two states gained real handling — no selection disables both write actions, and an empty parameter area now says what to do instead of echoing the error.
