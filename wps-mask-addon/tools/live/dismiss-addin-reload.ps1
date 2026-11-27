# tools/live/dismiss-addin-reload.ps1
#
# WPS 在加载项文件变化后会弹「加载项 wpsmask 已经被修改，是否继续加载？」。
# 这个模态框会挡住 COM 调用，无人值守的探查就会一直等下去。
# 这个进程只回答这一种弹窗：WPS 主窗口里的重载确认，或独立的 Qt 弹窗；
# 正文必须包含加载项名，按钮是「确定」或默认按钮；其他弹窗一律不点。
# 由 probe.mjs 在桥起来之后、第一次 COM 调用之前拉起，探查结束随桥一起杀掉。
param([int]$Seconds = 900)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Error.WriteLine('UIAutomation 不可用：' + $_.Exception.Message)
    exit 0
}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WpsReloadWindows {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
'@

# 加载项名来自 publish.xml 的 <jsplugin name="wpsmask" ...>，是 ASCII，不受脚本编码影响。
$addinName = 'wpsmask'
# 「确定」和弹窗里那层「WPS 表格」窗口名用码点拼出来：
# Windows PowerShell 5.1 按 ANSI 读 UTF-8 脚本时，中文字面量会坏。
$okText = [string]::Concat([char]0x786E, [char]0x5B9A)
$promptWindowName = 'WPS ' + [string][char]0x8868 + [string][char]0x683C

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

$deadline = (Get-Date).AddSeconds($Seconds)
$seen = @{}
$warned = @{}
while ((Get-Date) -lt $deadline) {
    $script:candidates = @()
    [WpsReloadWindows]::EnumWindows({ param($h, $l)
        if (-not [WpsReloadWindows]::IsWindowVisible($h)) { return $true }
        $cls = New-Object Text.StringBuilder 256
        [void][WpsReloadWindows]::GetClassName($h, $cls, 256)
        # 加载项重载提示长在 XLMAIN 主窗口内部；Qt5QWindow 也留着，别的版本可能换成独立弹窗。
        if ($cls.ToString() -notin @('XLMAIN', 'Qt5QWindow')) { return $true }
        $procId = 0
        [void][WpsReloadWindows]::GetWindowThreadProcessId($h, [ref]$procId)
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'wps') {
            $script:candidates += [pscustomobject]@{ H = $h; Class = $cls.ToString() }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null

    foreach ($cand in $script:candidates) {
        $h = $cand.H
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
            if (-not $root) { continue }

            # 只扫重载确认那一层，不碰整棵主窗口树：XLMAIN 里有几千个元素，
            # 全量 FindAll 会慢到弹窗都点完了，功能区和 UIA 已经拿到空结果。
            $scopes = @()
            if ($cand.Class -eq 'Qt5QWindow') {
                $scopes += $root
            } else {
                $winCond = New-Object System.Windows.Automation.AndCondition(
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::Window)),
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::NameProperty,
                        $promptWindowName)))
                $prompt = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $winCond)
                if ($prompt) { $scopes += $prompt }
            }
            if ($scopes.Count -eq 0) { continue }

            foreach ($scope in $scopes) {
                $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition)
                $text = ''
                foreach ($e in $all) {
                    $name = $e.Current.Name
                    if ($name) { $text += ' ' + $name }
                }
                if ($text -notmatch [regex]::Escape($addinName)) { continue }
                $key = [string]$h + '|' + $text
                if ($seen.ContainsKey($key)) { continue }

                $button = $null
                foreach ($e in $all) {
                    if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
                    $isDefault = $false
                    try { $isDefault = [bool]$e.Current.IsDefault } catch { $isDefault = $false }
                    if ($e.Current.Name -eq $okText -or $isDefault) { $button = $e; break }
                }
                if (-not $button) {
                    [Console]::Error.WriteLine('找到加载项弹窗，但没有「确定」或默认按钮')
                    continue
                }
                $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                $seen[$key] = $true
                $short = $text.Trim()
                if ($short.Length -gt 160) { $short = $short.Substring(0, 160) }
                [Console]::Out.WriteLine('dismissed: ' + $short)
                [Console]::Out.Flush()
                break
            }
        } catch {
            # 枚举和点击之间窗口被关掉是正常的；只有窗口还活着才值得记一行，且同一窗口只记一次
            $alive = $false
            try { $alive = [WpsReloadWindows]::IsWindow($h) -and [WpsReloadWindows]::IsWindowVisible($h) } catch { $alive = $false }
            $key = [string]$h
            if ($alive -and -not $warned.ContainsKey($key)) {
                $warned[$key] = $true
                [Console]::Error.WriteLine('处理弹窗失败：' + $_.Exception.Message)
            }
        }
    }
    Start-Sleep -Milliseconds 500
}
