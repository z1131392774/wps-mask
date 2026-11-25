# AGENTS.md — wps-mask-addon

*[English](AGENTS.md)*

加载项自身的规则。常驻规则在[根文件](../AGENTS_zh.md)；产品手册在 [README_zh.md](README_zh.md)；规则背后的细节在 [docs/implementation_zh.md](docs/implementation_zh.md)。

- **只通过 `MaskGetApp()` 取宿主。** 加载项里没有裸的 `Range("A1")`：每个对象都从该函数返回的宿主上取。
- **数组一律用 `Array.isArray` 判断。** 宿主值跨 realm：`instanceof Array` 为 false，二维区域会塌缩成一个单元格。
- **整块数据走 `Value2`。** 读进二维数组、在 JS 里变换、一次赋值写回；逐格循环慢得多，失败时还会留下半状态。`checkWritten()` 会重读，宿主静默丢弃写入时直接报错。
- **映射必须一对一——经 `keyOf()`——否则抛错。** 两个原值共用一个假值会让反映射有歧义。容量、置换与跨度保护见[一对一映射](docs/implementation_zh.md#一对一映射)；失败要报出列字母与表头。
- **混合列按单元格分类。** `shapeOf()` 返回手机号/邮箱/固话/纯数字/字母数字/文本，`genMixed` 保持该形态；新增形态需要 `shapeOf` 分支、生成器，以及一条断言什么必须保住的测试（[混合列形态](docs/implementation_zh.md#混合列形态)）。
- **映射表是文件格式。** `M1:`、`sigOf()`、`KEY_TEXT` 会被已有文档读取；改动就要在同一改动里加版本字段和迁移。桶的保留、迁移与保存规则见[映射表格式](docs/implementation_zh.md#映射表格式)。
- **标记边框是映射表的一部分。** `marks` 是映射表字段，随版本/迁移规则走；颜色用 RGB 打包整数，绝不用十六进制。内部实现见[标记边框](docs/implementation_zh.md#标记边框)。
- **`engine.js` 保持宿主无关。** 无 DOM、无 `window`、无顶层 `require`：面板、宿主页和 Node 里不改编就能跑。`aes.js` 不用 `crypto`。
- **改行为就跑测试。** `node test/engine.test.js` 与 `node test/aes.test.js` 覆盖引擎；可点击或可见的改动跑 `test/ribbon.test.js`、`test/taskpane.test.js` 与 `test/utils.test.js`（jsdom）。
- **AES 密钥是混淆，不是凭据。** `KEY_TEXT` 是常量；改成口令或环境变量必须在同一改动里更换存储格式。
- **只改这里，永远不直接改 `%APPDATA%`。** `tools/link-addon.ps1` 把已安装的 `jsaddons\wpsmask_1.0.0` 联接到本目录；`-Rollback` 恢复 `.bak-<时间戳>`。
- **真机答案在 `tools/live/HANDOFF.md`。** WPS 12.1 的实测结论、测法与 COM 陷阱；`npm run live:probe:log` 复现可机器判定的部分。
- **UI 改动要在真实渲染里看。** jsdom 只证明行为，不证明布局：用 `node tools/preview-pane.mjs` 在 260、300、380 px 三个宽度看。规则见[面板与功能区渲染](docs/implementation_zh.md#面板与功能区渲染)。
