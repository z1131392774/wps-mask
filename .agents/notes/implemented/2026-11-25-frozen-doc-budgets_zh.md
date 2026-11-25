# 决策记录：冻结文档预算

Status: implemented

*[English](2026-11-25-frozen-doc-budgets.md)*

## 问题

文档门禁在结构层面是有效的——双语配对、链接、锚点、固定笔记头、清单自校验——但它管的字数是失效的：手册每长一截，上限就跟着抬一次。`wps-mask-addon/README.md` 在六次改动里从 1600 单位涨到 3840，最后 11 个受管文件里有 4 个处在 95%–100%。上限记录的是历史，不是刹车；「实在放不下再抬上限」变成了第一反应。

## 决策

上限冻结。`wps-mask-addon/README.md` 封顶 2000 单位，`wps-mask-addon/AGENTS.md` 封顶 400；溢出的内容拆进四个新的受管页面：[脱敏行为](../../../wps-mask-addon/docs/behavior_zh.md) 1200、[存储](../../../wps-mask-addon/docs/storage_zh.md) 1000、[验证](../../../wps-mask-addon/docs/verification_zh.md) 1200、[实现细节](../../../wps-mask-addon/docs/implementation_zh.md) 600，创建时即冻结。`docs/AGENTS.md` 写明规则：文件超预算时，要么把溢出内容移进新的受管页面（自带上限），要么压缩；抬上限属于要写决策记录的产品决定，不是日常编辑。manifest 里的 `_budgetReasons` 保留过去抬升的理由，从现在起记录冻结。本仓库与 DeepSeek `agents-template` 共享的九项上限——根 `AGENTS.md` 1200、根 `README.md` 700、`docs/AGENTS.md` 1300、`docs/adopting.md` 900、`docs/development.md` 900、`.agents/notes/README.md` 900、两个 skill 文件 500 与 600、`scripts/AGENTS.md` 400——按模板 manifest 原样保留，不因本仓库内容重新调参；模板里没有的 add-on 条目才属于本项目的产品决定。

## 曾考虑的替代方案

**继续「写理由就能抬上限」。** 否决：一周内抬了六次，说明理由永远找得到；机制只是在事后让增长可见。

**取消字数预算，交给 review 把关。** 否决：长度会悄悄漂移，等到读者发现时已经要动手拆分。

**按当前体积自动推导上限。** 否决：等于把棘轮多转一圈，还把「抬升」写进了本该抵抗它的工具里。

## 后果

受管总预算从 4,490 涨到 6,400：五个页面各自要为标题、开头的互链和孪生链接付出成本，而总量本来就不是约束，逐页诚实才是。冻结之后新增内容只有三个出口：替换旧文字、新建一个受管页面（连同它的孪生和冻结上限）、或删除。持续贴着上限的文件是「该拆了」的信号，不是「该抬了」。在新页面还有余量之前，上限只许下调：新增内容不能靠抬上限来容纳。结构检查不变，`npm run check` 仍会在超预算、缺孪生、链接出仓库时失败。
