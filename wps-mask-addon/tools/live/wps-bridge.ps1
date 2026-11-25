# tools/live/wps-bridge.ps1
#
# 真机自动化的桥：一个长驻的 PowerShell 进程，按行收发 JSON，替 Node 侧驱动 WPS 表格。
# 为什么是 PowerShell：本仓库加载项不带任何依赖，桥也不该多装东西；PowerShell 自带 COM
# 绑定和 UIAutomation 客户端，Windows 上一定有。
#
# 协议：stdin 每行一个请求 {"id":1,"op":"open","args":{...}}
#       stdout 每行一个回应 {"id":1,"ok":true,"data":{...}} 或 {"id":1,"ok":false,"error":"..."}
# 只做搬运和取数，断言全部在 Node 侧 —— 好让判定逻辑能被普通测试覆盖，不必开 WPS。
#
# 由 probe.mjs 拉起。不碰 COM 的往返可以单独试：
#   '{"id":1,"op":"hello"}' | pwsh -NoProfile -File tools/live/wps-bridge.ps1
#   '{"id":1,"op":"echo","args":{"text":"脱敏映射表"}}' | pwsh -NoProfile -File tools/live/wps-bridge.ps1
# 这两条只验「桥能起、UTF-8 两边没坏」，不需要 WPS；碰宿主的 op 才需要。

$ErrorActionPreference = 'Stop'
# 两侧都按 UTF-8 走：中文表名、中文提示在默认代码页下会被换成问号，之后所有比对都失真。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }
$script:App = $null
$script:In = [Console]::In
$script:Out = [Console]::Out

function Send-Json($obj) {
    $script:Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
    $script:Out.Flush()
}

function Get-App {
    if ($script:App) { return $script:App }
    $errs = @()
    foreach ($progId in @('Ket.Application', 'KET.Application', 'et.Application')) {
        try {
            $script:App = New-Object -ComObject $progId
            return $script:App
        } catch {
            $errs += ($progId + ': ' + $_.Exception.Message.Split([Environment]::NewLine)[0])
        }
    }
    throw ('没有可用的 WPS 表格 COM 接口 —— ' + ($errs -join ' | '))
}

# 工作簿一律用 args.book 指定，工作表用 args.sheet。
# 曾经两者都叫 name，结果"给新表起名"的参数被当成"找哪个工作簿"，报了句毫无关系的错。
function Get-Workbook($a) {
    $app = Get-App
    if ($a -and $a.book) {
        $want = [string]$a.book
        $names = @()
        for ($i = 1; $i -le $app.Workbooks.Count; $i++) {
            $wb = $app.Workbooks.Item($i)
            if ([string]$wb.Name -eq $want) { return $wb }
            $names += [string]$wb.Name
        }
        throw ('没有名为 ' + $want + ' 的已打开工作簿（当前有：' + ($names -join '、') + '）')
    }
    if ($app.Workbooks.Count -lt 1) { throw '当前没有打开的工作簿' }
    return $app.ActiveWorkbook
}

function Get-Sheet($wb, $a) {
    $name = $null
    if ($a -and $a.sheet) { $name = [string]$a.sheet }
    if (-not $name) { return $wb.ActiveSheet }
    for ($i = 1; $i -le $wb.Worksheets.Count; $i++) {
        $ws = $wb.Worksheets.Item($i)
        if ([string]$ws.Name -eq $name) { return $ws }
    }
    throw ('没有名为 ' + $name + ' 的工作表')
}

# 取值统一成「数组的数组」。COM 给的二维数组是 1 基的，用 $v[$r,$c] 下标取，
# 不用 GetValue —— 后者按 0 基算，单行/单列时又会退化成一维，两种都不是我们要的形状。
function Read-Rows($value, $rows, $cols) {
    # 整片空区域 COM 会回 $null，这时按空格子报，让 Node 侧照常比对而不是拿到异常
    if ($null -eq $value) {
        $blank = @()
        for ($r = 1; $r -le $rows; $r++) {
            $row = @()
            for ($c = 1; $c -le $cols; $c++) { $row += '' }
            $blank += , $row
        }
        return , $blank
    }
    if ($rows -eq 1 -and $cols -eq 1) { return , @(@($value)) }
    $out = @()
    for ($r = 1; $r -le $rows; $r++) {
        $row = @()
        for ($c = 1; $c -le $cols; $c++) {
            $row += $value[$r, $c]
        }
        $out += , $row
    }
    return , $out
}

function Find-Controls($app, $filter) {
    $hits = @()
    try { $bars = $app.CommandBars } catch { return $null }
    if (-not $bars) { return $null }
    if (-not $filter) {
        # 只认加载项自己的标记。早先写成 wpsmask|Mask|脱敏|映射，结果把 Excel 自带的
        # 「List/XML 映射属性」也算了进来 —— 假阳性比找不到更坏，它会让"通过"变成谎话。
        $filter = 'wpsmask|脱敏|btnMask|MaskPane|MaskQuick|MaskRevert'
    }
    for ($i = 1; $i -le $bars.Count; $i++) {
        $bar = $bars.Item($i)
        $ctrlCount = 0
        try { $ctrlCount = $bar.Controls.Count } catch { continue }
        for ($j = 1; $j -le $ctrlCount; $j++) {
            $c = $bar.Controls.Item($j)
            $rec = @{}
            foreach ($k in @('Id', 'Tag', 'Caption', 'TooltipText', 'Visible', 'Enabled')) {
                try { $rec[$k] = [string]$c.$k } catch { }
            }
            $blob = (@($rec.Values) -join ' ')
            if ($blob -notmatch $filter) { continue }
            $rec['bar'] = [string]$bar.Name
            $hits += , $rec
        }
    }
    return , $hits
}

# 工具条名字里带这些词的，说明宿主把加载项那一页构建出来了（publish.xml 被接受），
# 哪怕它的按钮不在 Controls 里 —— 这两件事必须分开问。
function Find-Bars($app) {
    $out = @()
    $total = $null
    try { $bars = $app.CommandBars } catch { return @{ total = $null; named = $out } }
    if (-not $bars) { return @{ total = $null; named = $out } }
    try { $total = [int]$bars.Count } catch { }
    for ($i = 1; $i -le $bars.Count; $i++) {
        $nm = $null
        try { $nm = [string]$bars.Item($i).Name } catch { continue }
        if ($nm -match '脱敏|wpsmask|加载项|AddIns|Add-Ins') { $out += $nm }
    }
    return @{ total = $total; named = $out }
}

function Find-Control($app, $wanted) {
    $all = Find-Controls $app $null
    if ($null -eq $all) { return $null }
    foreach ($c in $all) {
        foreach ($k in @('Id', 'Tag', 'Caption')) {
            if ($c[$k] -and [string]$c[$k] -eq $wanted) { return $c }
        }
    }
    return $null
}

# UIA 只在真要用的时候才加载：装不上就报清楚，而不是让整个桥起不来。
$script:UiaError = $null
function Ensure-Uia {
    if ('ok' -eq $script:UiaError) { return $true }
    if ($script:UiaError) { return $false }
    try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $script:UiaError = 'ok'
        return $true
    } catch {
        $script:UiaError = $_.Exception.Message
        return $false
    }
}

function Get-MainWindow {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($cls in @('KetMainFrame', 'XLMAIN', 'ETMainFrame', 'OpusApp')) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
        $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($w) { return @{ el = $w; cls = $cls } }
    }
    return $null
}

function Get-ElementsByType($el, $type, $limit) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $found = @()
    try { $found = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) } catch { return , @() }
    $out = @()
    for ($i = 0; $i -lt $found.Count -and $out.Count -lt $limit; $i++) {
        $out += , $found.Item($i)
    }
    return , $out
}

function Invoke-Op($op, $a) {
    switch ($op) {
        'hello' {
            return @{ ps = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString }
        }
        'echo' {
            # 不碰 COM 的往返测试：用来单独确认"桥能起、UTF-8 两边都没坏"，
            # 在拿不到 WPS 的机器上也跑得起来。
            return @{ text = [string]$a.text; len = ([string]$a.text).Length }
        }
        'show' {
            $app = Get-App
            $app.Visible = [bool]$a.visible
            $now = $null
            try { $now = [bool]$app.Visible } catch { }
            return @{ visible = $now }
        }
        'app' {
            $app = Get-App
            # 顺手报告宿主到底暴露了哪些成员：任务窗格和功能区在有的版本上是"属性不存在"，
            # 不是"调用失败"，这两种情况对排查意味着完全不同的结论。
            $members = @()
            try {
                $members = @($app | Get-Member -MemberType Method |
                    ForEach-Object { $_.Name } |
                    Where-Object { $_ -match 'TaskPane|PluginStorage|CommandBars' } |
                    Sort-Object -Unique)
            } catch { $members = @() }
            return @{
                name      = [string]$app.Name
                version   = [string]$app.Version
                build     = [string]$app.Build
                path      = [string]$app.Path
                workbooks = [int]$app.Workbooks.Count
                members   = $members
            }
        }
        'newbook' {
            $app = Get-App
            if ($a.visible) { try { $app.Visible = $true } catch { } }
            $wb = $app.Workbooks.Add()
            return @{ name = [string]$wb.Name }
        }
        'pane' {
            $app = Get-App
            if (-not $a.url) { throw 'pane 需要 args.url' }
            if ($a.visible) { try { $app.Visible = $true } catch { } }
            $pane = $app.CreateTaskPane([string]$a.url)
            $id = $null
            try { $id = [string]$pane.ID } catch { }
            $vis = $false
            $visErr = $null
            try { $pane.Visible = $true; $vis = [bool]$pane.Visible } catch { $visErr = $_.Exception.Message }
            # 拿回来再问一次：宿主记住的窗格能不能按 ID 找回来（加载项开关面板就靠这个）
            $again = $null
            try { $p = $app.GetTaskPane($id); if ($p) { $again = [bool]$p.Visible } } catch { $again = $null }
            return @{ id = $id; visible = $vis; visibleError = $visErr; reopenVisible = $again; url = [string]$a.url }
        }
        'bench' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $rows = 100000
            $cols = 3
            if ($a.rows) { $rows = [int]$a.rows }
            if ($a.cols) { $cols = [int]$a.cols }
            $arr = New-Object 'object[,]' $rows, $cols
            for ($i = 0; $i -lt $rows; $i++) {
                for ($j = 0; $j -lt $cols; $j++) { $arr[$i, $j] = ('r' + $i + 'c' + $j) }
            }
            $rng = $ws.Range($ws.Cells.Item(1, 1), $ws.Cells.Item($rows, $cols))
            $w = [Diagnostics.Stopwatch]::StartNew()
            $rng.Value2 = $arr
            $w.Stop()
            $r = [Diagnostics.Stopwatch]::StartNew()
            $back = $rng.Value2
            $r.Stop()
            $shape = -1
            try { $shape = [int]$back.GetLength(0) * [int]$back.GetLength(1) } catch { $shape = -1 }
            return @{
                rows = $rows; cols = $cols; cells = $shape
                writeMs = $w.ElapsedMilliseconds; readMs = $r.ElapsedMilliseconds
            }
        }
        'merge' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $rng = $ws.Range($ws.Cells.Item([int]$a.r1, [int]$a.c1), $ws.Cells.Item([int]$a.r2, [int]$a.c2))
            $rng.Merge()
            return @{ sheet = [string]$ws.Name; first = [string]$rng.Address() }
        }
        'setvisible' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $ws.Visible = [int]$a.visible
            $after = $null
            try { $after = [int]$ws.Visible } catch { }
            return @{ sheet = [string]$ws.Name; visible = $after }
        }
        'controls' {
            $app = Get-App
            $items = Find-Controls $app $null
            $bars = Find-Bars $app
            return @{
                supported = ($null -ne $items)
                items     = $items
                bars      = $bars.named
                barTotal  = $bars.total
            }
        }
        'uia' {
            # 报告 UIA 能不能加载、能看到哪些顶层窗口。
            # 不猜类名：把实际看到的类名和标题报出来，下次要找的线索就是它。
            if (-not (Ensure-Uia)) { return @{ supported = $false; error = $script:UiaError } }
            $root = [System.Windows.Automation.AutomationElement]::RootElement
            $win = Get-MainWindow
            $windows = @()
            $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $all.Count; $i++) {
                $e = $all.Item($i)
                $cn = ''
                $nm = ''
                try { $cn = [string]$e.Current.ClassName } catch { }
                try { $nm = [string]$e.Current.Name } catch { }
                if (-not $cn -and -not $nm) { continue }
                if (-not (($cn + ' ' + $nm) -match 'WPS|Excel|Ket|Kingsoft|表格|工作簿|et\.exe|wps\.exe')) { continue }
                $windows += , @{ cls = $cn; title = $nm }
                if ($windows.Count -ge 10) { break }
            }
            return @{
                supported    = $true
                window       = $(if ($win) { [string]$win.el.Current.Name } else { $null })
                matchedClass = $(if ($win) { $win.cls } else { $null })
                windows      = $windows
            }
        }
        'uiaribbon' {
            # 加载项加的选项卡和按钮，在 UIA 里看不看得见。看得见才谈得上"程序去点它"。
            # 只在功能区范围内找：整窗 FindAll Descendants 会把表格里每个格子都算进来。
            if (-not (Ensure-Uia)) { return @{ supported = $false; error = $script:UiaError } }
            $win = Get-MainWindow
            if (-not $win) { return @{ supported = $true; window = $null; tabs = @(); toolbars = @() } }
            $tabEls = @()
            $tabEls += Get-ElementsByType $win.el ([System.Windows.Automation.ControlType]::Tab) 40
            $tabEls += Get-ElementsByType $win.el ([System.Windows.Automation.ControlType]::TabItem) 40
            $tabs = @()
            foreach ($t in $tabEls) {
                $tabName = ''
                try { $tabName = [string]$t.Current.Name } catch { }
                $buttons = @()
                foreach ($b in (Get-ElementsByType $t ([System.Windows.Automation.ControlType]::Button) 40)) {
                    $bn = ''
                    try { $bn = [string]$b.Current.Name } catch { }
                    if ($bn -and $buttons.Count -lt 15) { $buttons += $bn }
                }
                $tabs += , @{ name = $tabName; buttonCount = $buttons.Count; buttons = $buttons }
            }
            $toolbars = @()
            foreach ($tb in (Get-ElementsByType $win.el ([System.Windows.Automation.ControlType]::ToolBar) 6)) {
                $tn = ''
                try { $tn = [string]$tb.Current.Name } catch { }
                $c = (Get-ElementsByType $tb ([System.Windows.Automation.ControlType]::Button) 60).Count
                $toolbars += , @{ name = $tn; buttons = $c }
            }
            return @{ supported = $true; window = [string]$win.el.Current.Name; cls = $win.cls; tabs = $tabs; toolbars = $toolbars }
        }
        'open' {
            $app = Get-App
            if (-not $a.path) { throw 'open 需要 args.path' }
            if ($a.visible) { $app.Visible = $true }
            $ro = $false
            if ($a.readOnly) { $ro = $true }
            if ($ro) {
                # UpdateLinks=0, ReadOnly=true —— 用来验「打开只读副本后保存会不会被宿主拒绝」
                $wb = $app.Workbooks.Open([string]$a.path, 0, $true)
            } else {
                $wb = $app.Workbooks.Open([string]$a.path)
            }
            $isRo = $null
            try { $isRo = [bool]$wb.ReadOnly } catch { }
            return @{ name = [string]$wb.Name; sheets = [int]$wb.Worksheets.Count; readOnly = $isRo; path = [string]$wb.FullName }
        }
        'select' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $ws.Activate()
            $rng = $ws.Range($ws.Cells.Item([int]$a.r1, [int]$a.c1), $ws.Cells.Item([int]$a.r2, [int]$a.c2))
            $rng.Select()
            return @{ sheet = [string]$ws.Name; r1 = [int]$a.r1; c1 = [int]$a.c1; r2 = [int]$a.r2; c2 = [int]$a.c2 }
        }
        'set' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $rows = @($a.rows)
            $r = 1
            $c = 1
            if ($a.r) { $r = [int]$a.r }
            if ($a.c) { $c = [int]$a.c }
            $nRows = $rows.Count
            $nCols = @($rows[0]).Count
            $rng = $ws.Range($ws.Cells.Item($r, $c), $ws.Cells.Item(($r + $nRows - 1), ($c + $nCols - 1)))
            if ($nRows -eq 1 -and $nCols -eq 1) {
                $rng.Value2 = @($rows[0])[0]
            } else {
                $arr = New-Object 'object[,]' $nRows, $nCols
                for ($i = 0; $i -lt $nRows; $i++) {
                    $line = @($rows[$i])
                    for ($j = 0; $j -lt $nCols; $j++) { $arr[$i, $j] = $line[$j] }
                }
                $rng.Value2 = $arr
            }
            return @{ rows = $nRows; cols = $nCols; r = $r; c = $c }
        }
        'read' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            $nRows = [int]$a.rows
            $nCols = [int]$a.cols
            $r0 = [int]$a.r
            $c0 = [int]$a.c
            $rng = $ws.Range($ws.Cells.Item($r0, $c0), $ws.Cells.Item(($r0 + $nRows - 1), ($c0 + $nCols - 1)))
            return @{ rows = (Read-Rows $rng.Value2 $nRows $nCols) }
        }
        'sheets' {
            $wb = Get-Workbook $a
            $list = @()
            for ($i = 1; $i -le $wb.Worksheets.Count; $i++) {
                $ws = $wb.Worksheets.Item($i)
                $vis = $null
                try { $vis = [int]$ws.Visible } catch { }
                $list += , @{ name = [string]$ws.Name; visible = $vis; index = $i }
            }
            return @{ items = $list }
        }
        'invoke' {
            $app = Get-App
            $wanted = $null
            if ($a.id) { $wanted = [string]$a.id }
            if (-not $wanted -and $a.tag) { $wanted = [string]$a.tag }
            if (-not $wanted -and $a.caption) { $wanted = [string]$a.caption }
            if (-not $wanted) { throw 'invoke 需要 args.id / args.tag / args.caption 之一' }
            $hit = Find-Control $app $wanted
            if (-not $hit) { throw ('功能区里没找到控件：' + $wanted) }
            # 找得到还不够：真正执行要拿到 COM 控件对象，这里重扫一次并 Execute
            $bars = $app.CommandBars
            for ($i = 1; $i -le $bars.Count; $i++) {
                $bar = $bars.Item($i)
                $ctrlCount = 0
                try { $ctrlCount = $bar.Controls.Count } catch { continue }
                for ($j = 1; $j -le $ctrlCount; $j++) {
                    $c = $bar.Controls.Item($j)
                    $probe = @()
                    foreach ($k in @('Id', 'Tag', 'Caption')) {
                        try { $probe += [string]$c.$k } catch { }
                    }
                    if ($probe -contains $wanted) {
                        $c.Execute()
                        return @{ matched = $wanted; bar = [string]$bar.Name }
                    }
                }
            }
            throw ('控件找到了但执行时又没对上：' + $wanted)
        }
        'addsheet' {
            $wb = Get-Workbook $a
            # 加载项建映射表用的就是 engine 这一形态：Add(undefined, 最后一张表)。
            # JS 里的 undefined 过 COM 变成"省略参数"，PowerShell 侧有两种送法，都要试，
            # 因为哪一版 WPS 认哪一种没有文档；把"哪种送法成功"报出来才是这次探查的产出。
            $form = 'engine:Missing'
            $errors = @()
            $ws = $null
            if ($a.style -eq 'plain') {
                $form = 'plain:Add()'
                $ws = $wb.Worksheets.Add()
            } else {
                $lastIndex = $wb.Worksheets.Count
                $last = $wb.Worksheets.Item($lastIndex)
                try {
                    $ws = $wb.Worksheets.Add([System.Reflection.Missing]::Value, $last)
                } catch {
                    $errors += ('Missing: ' + $_.Exception.Message.Split([Environment]::NewLine)[0])
                    $form = 'engine:null'
                    try {
                        $ws = $wb.Worksheets.Add($null, $last)
                    } catch {
                        $errors += ('null: ' + $_.Exception.Message.Split([Environment]::NewLine)[0])
                        $form = 'plain:Add()'
                        $ws = $wb.Worksheets.Add()
                    }
                }
            }
            if (-not $ws) { throw ('建工作表失败 —— ' + ($errors -join ' | ')) }
            if ($a.sheet) { $ws.Name = [string]$a.sheet }
            if ($a.visible) { $ws.Visible = [int]$a.visible }
            if ($a.marker) { $ws.Cells.Item(1, 1).Value2 = [string]$a.marker }
            $index = $null
            try { $index = [int]$ws.Index } catch { }
            $lastNow = [int]$wb.Worksheets.Count
            return @{
                name = [string]$ws.Name; index = $index; last = $lastNow
                form = $form; errors = $errors
            }
        }
        'protect' {
            $wb = Get-Workbook $a
            $ws = Get-Sheet $wb $a
            if ($a.off) { $ws.Unprotect($a.password) } else { $ws.Protect($a.password) }
            return @{ sheet = [string]$ws.Name; protected = [bool]$ws.ProtectContents }
        }
        'save' {
            $wb = Get-Workbook $a
            if ($a.as) { $wb.SaveAs([string]$a.as) } else { $wb.Save() }
            # SaveAs 之后 Name 就变了（工作簿1 → probe.xlsx），要把它带回去，否则下一步按旧名找不到
            return @{ path = [string]$wb.FullName; name = [string]$wb.Name }
        }
        'activate' {
            $wb = Get-Workbook $a
            if ($a.index) { $ws = $wb.Worksheets.Item([int]$a.index) } else { $ws = Get-Sheet $wb $a }
            $ws.Activate()
            return @{ active = [string]$wb.ActiveSheet.Name }
        }
        'close' {
            $wb = Get-Workbook $a
            $wb.Close($false)
            return @{ closed = $true }
        }
        'quit' {
            if ($script:App) { $script:App.Quit() }
            return @{ quit = $true }
        }
        default { throw ('未知 op：' + $op) }
    }
}

while ($true) {
    $line = $script:In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $data = Invoke-Op ([string]$req.op) $req.args
        Send-Json @{ id = $id; ok = $true; data = $data }
    } catch {
        Send-Json @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
