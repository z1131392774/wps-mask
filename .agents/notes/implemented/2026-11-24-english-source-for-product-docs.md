# English source for the product manual

*[中文](2026-11-24-english-source-for-product-docs_zh.md)*

## Problem

Every hand-written document in this repository is English-source with a Chinese twin, and the gate enforces the pair. The product manual arrived the other way round: written in Chinese for Chinese users of WPS, with no English half. Applying the standard therefore forced a choice for `wps-mask-addon/README.md` alone — translate it and keep the pair, or exempt it from pairing — and the manual is the one document users read, so the wrong answer here teaches the wrong lesson about every other file.

## Decision

English is the source for the manual too. `wps-mask-addon/README.md` holds the English text and `README_zh.md` the Chinese, and the pair obeys the same link, budget, and staleness rules as everything else. No file is exempted: `excludePairs` stays empty.

## Alternatives considered

**Exempt the manual through `excludePairs`.** Rejected: the standard reserves exemptions for generated files. A hand-written document that keeps a twin but skips the pair rules is exactly the drift the rule exists to prevent, and the exemption would also drop its link and anchor checking.

**Make Chinese the source and suffix the English copy `_en.md`.** Rejected: the gate, its slug function, and every document in the tree assume `_zh.md` names the translation. Inverting the direction for one directory means editing the gate and every inbound link to buy nothing a translation does not already give.

**Keep a single language and drop the bilingual rule.** Rejected: that is a repository-wide change — deleting the twins, the pairing code, and the writing rules — taken to solve one file.

## Consequences

The Chinese manual is now a translation and must be refreshed whenever the English moves; the gate fails a twin whose English half was committed later. The gate does not catch the reverse: a Chinese-only edit passes, because it only compares which half was touched last. Chinese wording changes therefore land together with a matching English change, or the pair quietly acquires two versions of the same fact.
