# 交接：把剩下三条真机条目测掉

*[English](HANDOFF.md)*

Status: 交接文档，写给能创建 COM 对象的执行者。

这个仓库是一个 WPS 表格加载项（数据脱敏）。绝大多数逻辑跑在 mock 上验证，**三条只有真机才能回答的问题还没答案**。你手上有 COM，这几条就是你的活。文档其余部分都在说：哪些已经量过（别再量）、怎么量剩下的、量完写到哪。

---

## 一、已实测的事实

环境：WPS 表格 **12.1.0.29161**（`C:\Users\Administrator\AppData\Local\Kingsoft\WPS Office\12.1.0.29161\office6`），Windows Server 2022，2026-11-25 两次完整探查得出。别重复验证，直接当前提用。

| 事实 | 结论 |
| --- | --- |
| ProgID | `Ket.Application` 可用；`app.Name` 返回 `Microsoft Excel 12.0`（WPS 伪装成 Excel 的兼容实现） |
| 主窗口 UIA 类名 | **`KPromeMainWindow`**（标题「WPS Office」）。`KetMainFrame` / `XLMAIN` / `OpusApp` 都不存在 |
| 功能区可达性 | `CommandBars` 有 186 条，**没有一条**是加载项的；UIA 在 `KPromeMainWindow` 下**列不出任何 Tab/TabItem**（WPS 功能区是自绘的） |
| `Worksheets.Add(undefined, 末表)` | **可用**：先试 `[System.Reflection.Missing]::Value` 即成功，新表落在末尾 |
| 隐藏工作表 | `Visible = 2` 可设，**活动表也能直接隐藏**（Excel 会拒绝，WPS 不会） |
| 隐藏表存盘重开 | 通过：重开后 `Visible` 仍是 2，密文原样读回 |
| 受保护工作表写入 | 被宿主拒绝（错误码 `0x8FE30C28`） |
| 只读文档 `Save()` | **既不抛错也不写盘**（mtime 不变），但写入仍进入内存 |
| 合并单元格非锚点写入 | **不报错也不生效**，读回是 `[[null, null]]` |
| 晚绑定 `Range.Value2 = 数组` | **被拒**，一维二维都一样：`Unable to cast object of type 'System.Object[,]' to type 'System.String'`；单格赋值与整片读回都正常（读 10 万格 72ms） |
| `CreateTaskPane` | **不在 COM 对象上**（`System.__ComObject` 没有这个方法）。它在加载项自己的 JS API 面上，晚绑定看不到不等于宿主没有 |

---

## 二、还剩三条，以及为什么我测不了

### 1. 十万行性能 + 数组写入是否可用（条目 6，最重要）

这条不只是性能。engine 的写单元格是整列数组赋值（`engine.js:1577 writeColumn`：`rng.Value2 = arr`），**如果 WPS 不接受数组，脱敏会整批失败**。所以要先回答“收不收数组”，再谈快慢。

我测不了的原因不是没有 COM，而是 **PowerShell 的晚绑定不传 SAFEARRAY**。换一个宿主语言就能传：

- **Python + pywin32**：`ws.Range(ws.Cells(1,1), ws.Cells(n,1)).Value2 = tuple((v,) for v in values)`
- **C#**：`Add-Type` 后 `object[,]` 直接赋给 `dynamic` 的 `Value2`
- **VBScript/JScript（cscript）**：`rng.Value2 = arr` 也能过

要测三件事，结果都记下来：
1. 一次给一列（10 万行）赋 `object[]`/`tuple` 是否成功、耗时多少毫秒。
2. 一次给 N 行 × 3 列赋二维数组是否成功、耗时。
3. 整片读回 `Value2` 的形状（是 `(n,1)` 还是退化成一维）——engine 的 `to2D()` 依赖这个。

### 2. 面板能不能拿到 `window.Application`（条目 2）

面板是 HTML 页面（`wpsmask_1.0.0/taskpane/index.html`），由 `CreateTaskPane(file://…)` 打开；它靠 `window.Application` 拿宿主对象。拿不到时面板会显示「未取到 WPS 应用对象」。

从 COM 侧测不了（原因见上：`CreateTaskPane` 不在这条通道上）。可选做法，按成本排：

1. **最快**：人点一次功能区「数据脱敏 → 面板」，看显示什么。一句话就能定死。
2. 如果一定要程序化：尝试从 **`wps.exe` 暴露的另一个对象**取值——有人用 `Ket.Application` 之外的名字（`KET.Application`、`et.Application`、`WPS.Application`）都能拿到对象，但 `CreateTaskPane` 依然不在这条晚绑定面上。**别在这上面花超过二十分钟**，人眼看一眼更快。
3. 如果确实拿不到：改由宿主页执行——`ribbon.js` 里的 `MaskQuickApply` / `MaskQuickRevert` 已经调用同一套引擎，面板可以退化成只读说明页。

### 3. `CreateTaskPane` 是否接受 `file://` 形式（条目 3）

与上一条同因。**如果第 2 条能成，这条顺便就有了**：拿到的 pane 对象 `Visible = true` 成功、`ID` 非空、`GetTaskPane(id)` 能取回，就算通过。桥里已经有 `pane` op，参数 `{ url, visible }`，返回 `{ id, visible, reopenVisible, url }`。

---

## 三、现成的工具，直接用

```sh
cd D:\workspace\wps-mask
npm run live:probe        # 只跑机器判定项，不开窗口
npm run live:probe:all    # 加显示窗口、弹窗格、十万行
npm run live:probe:log    # 同上，并把结果写进 probe.log
```

`tools/live/` 下的四个文件：

- **`wps-bridge.ps1`** —— 常驻进程，按行收发 JSON：stdin `{"id","op","args"}`，stdout `{"id","ok","data"|"error"}`。它只做搬运，不下判断。手工试一个 op：
  `'{"id":1,"op":"app"}' | pwsh -NoProfile -File wps-mask-addon/tools/live/wps-bridge.ps1`
- **`rpc.mjs`** —— Node 侧传输：分帧、按 op 超时、id 配对、桥退出时拒掉所有未决调用。只做传输，所以能脱离 WPS 测（`test/rpc.test.mjs`）。
- **`log.mjs`** —— `--log` 的旁路，屏幕上打什么就写什么。
- **`probe.mjs`** —— 按依赖顺序问七条，一行一个结论，末尾打印可贴回手册的表。

**op 一览**（参数名已经踩过坑，照这个用）：

| op | args | 说明 |
| --- | --- | --- |
| `hello` / `echo` | `text` | 不碰 COM；验桥和 UTF-8 |
| `show` | `visible` | 显示/隐藏窗口 |
| `app` | — | 版本、路径、已开工作簿数、TaskPane 相关成员 |
| `newbook` | `visible` | 新建工作簿，返回 `name` |
| `open` | `path`, `readOnly`, `visible` | 返回 `name`、`readOnly` |
| `addsheet` | **`book`**, **`sheet`**, `visible`, `marker`, `style` | `style: 'plain'` 用无参 `Add()`；默认复刻 engine 形态 |
| `set` | `book`, `sheet`, `r`, `c`, `rows` | `rows` 是数组的数组 |
| `read` | `book`, `sheet`, `r`, `c`, `rows`, `cols` | 返回 `{ rows }`，**单格可能折成裸值** |
| `sheets` | `book` | 名字、可见性、序号 |
| `setvisible` | `book`, `sheet`, `visible` | |
| `activate` | `book`, `sheet` 或 `index` | |
| `protect` | `book`, `sheet`, `password`, `off` | |
| `merge` | `book`, `sheet`, `r1`, `c1`, `r2`, `c2` | |
| `stat` | `path` | `mtime`、`size`，判断“保存到底写了没” |
| `save` | `book`, `as` | 返回新 `name`（`SaveAs` 后名字会变！）、`saved`、`mtime` |
| `close` / `quit` | `book` | |
| `controls` | — | `items`（加载项控件）、`bars`（工具条名）、`barTotal` |
| `uia` / `uiaribbon` | — | 顶层窗口列表 / 功能区的选项卡与按钮 |
| `pane` | `url`, `visible` | 建任务窗格 |
| `bench` | `book`, `rows`, `cols` | 一维列写入与二维整块写入各计一次，被拒也记原因 |
| `invoke` | `id`/`tag`/`caption` | 按名字执行 CommandBars 控件（**加载项按钮在这里找不到**） |

---

## 四、量完之后写哪儿

手册 `wps-mask-addon/README_zh.md` 第五节有一张「真机实测」表，英文孪生是 `README.md`。**中英两半必须同时改**，`npm run check` 会检查配对、预算和链接。

判词只有四种：通过 / 不通过 / 未测 / 待人工。**不要把“测不了”写成“不通过”**——这一轮已经因此产生过三个错误结论（单格读回被折平、`KetMainFrame` 不存在、`CreateTaskPane` 不在 COM 面）。

如果某条是 **不通过**，对应改这里：

| 现象 | 该改的地方 |
| --- | --- |
| 建隐藏表失败 | `engine.js:561`，`Add(undefined, 末表)` 没有退路 |
| 数组写入被拒 | `engine.js:1577 writeColumn` 与 `:1565` 附近的分块写入 |
| 只读文档能脱敏 | `engine.js:797 saveVault` 开头已有 `ReadOnly` 拒绝，检查是否被绕过 |
| 合并单元格静默丢写 | `engine.js:1562 checkWritten` 的读回校验（已能发现并回滚） |
| 面板拿不到宿主对象 | `ribbon.js:76` 的 `CreateTaskPane`；操作改走 `MaskQuickApply` / `MaskQuickRevert` |

---

## 五、别做的事

- **别改 `test/mock-wps.js` 去迁就真机。** mock 描述的是契约；真机不一样就说明契约错了，改 `engine.js` 并补测试。
- **别把 `probe*.log` 提交**（已进 `.gitignore`，里面有本机路径）。
- **别在 `%APPDATA%\kingsoft\wps\jsaddons\` 里改文件。** 那是指向工作树的目录联接，改工作树就会生效；`tools/link-addon.ps1 -Rollback` 可撤销。
- **别用 `name` 指工作簿。** 这个参数名曾经同时表示“工作簿”和“新表名”，导致建表报“找不到叫探针表的工作簿”。
- **别相信 UIA 能点按钮。** 功能区是自绘的，UIA 列不出选项卡；能做的只有人点，或在加载项内部跑。
- **别声称验证过没验证的东西。** 这轮已经修过三次“文档说了但没量”的表述。

---

## 六、最省事的下一步

1. 跑 `npm run live:probe:log`，确认基线还是这张表（若变了，先解释差异再继续）。
2. 用 Python/pywin32 或 C# 补测**数组写入**（条目 6）——这是唯一可能推翻架构的一条。
3. 人点一次面板，定条目 2；顺带把条目 3 的 `pane` op 跑一次。
4. 结果回填两张 README，`npm test && npm run check`，提交。

开工前如果想先看这套东西为什么长成这样，读 `.agents/notes/implemented/2026-11-25-live-probe_zh.md`。
