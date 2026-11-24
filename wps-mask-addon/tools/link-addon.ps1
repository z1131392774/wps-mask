<#
.SYNOPSIS
    Point the installed add-in folder at this working tree instead of copying files.

.DESCRIPTION
    Creates a directory junction (mklink /J equivalent) at
    %APPDATA%\kingsoft\wps\jsaddons\wpsmask_1.0.0 pointing at .
    A junction needs no elevation and no developer mode, and it is followed by
    ordinary file APIs, which is what an add-in loader uses.

    The existing real folder is renamed to <name>.bak-<timestamp> rather than
    deleted, so -Rollback can put it back.

.PARAMETER Source
    Folder to link to. Defaults to ..\wpsmask_1.0.0 relative to this script.

.PARAMETER Rollback
    Remove the junction and restore the newest backup folder.

.EXAMPLE
    pwsh -File tools/link-addon.ps1

.EXAMPLE
    pwsh -File tools/link-addon.ps1 -Rollback
#>
[CmdletBinding()]
param(
    [string]$Source,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$name = 'wpsmask_1.0.0'
$jsaddons = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$target = Join-Path $jsaddons $name

if (-not $Source) {
    $Source = Join-Path (Split-Path -Parent $PSScriptRoot) $name
}

if (-not (Test-Path -LiteralPath $jsaddons)) {
    throw "Add-in directory not found: $jsaddons (start WPS Spreadsheet once so it is created)"
}

$existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue

function Remove-LinkOnly([string]$path) {
    # Directory.Delete removes the reparse point itself; Remove-Item -Recurse can
    # walk into the target and delete real files.
    [System.IO.Directory]::Delete($path)
}

if ($Rollback) {
    if ($existing -and $existing.LinkType) {
        Remove-LinkOnly $target
        Write-Host "junction removed: $target"
    }
    $backup = Get-ChildItem -LiteralPath $jsaddons -Force -Directory -Filter "$name.bak-*" |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($backup) {
        Rename-Item -LiteralPath $backup.FullName -NewName $name
        Write-Host "restored real folder: $($backup.Name) -> $name"
    } else {
        Write-Host "no backup folder found; nothing to restore"
    }
    exit 0
}

$src = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path -LiteralPath (Join-Path $src 'ribbon.xml'))) {
    throw "$src does not look like the add-in (ribbon.xml missing)"
}

if ($existing -and $existing.LinkType) {
    Write-Host "already a $($existing.LinkType) -> $($existing.Target)"
    if ($existing.Target -ne $src) {
        Write-Host "warning: it points somewhere else; run with -Rollback then again to retarget"
    }
    exit 0
}

if ($existing) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupName = "$name.bak-$stamp"
    try {
        Rename-Item -LiteralPath $target -NewName $backupName
    } catch {
        throw "Cannot rename the installed folder, most likely because WPS is running: $($_.Exception.Message)`nClose WPS completely and run this script again."
    }
    Write-Host "backed up: $backupName"
}

New-Item -ItemType Junction -Path $target -Target $src | Out-Null
Write-Host "junction created: $target -> $src"

$probe = Join-Path $target 'js\engine.js'
if (-not (Test-Path -LiteralPath $probe)) {
    throw "junction created but $probe is not readable; run with -Rollback"
}
$count = (Get-ChildItem -LiteralPath $target -Recurse -File).Count
Write-Host "verified: $count files readable through the link"
Write-Host "restart WPS Spreadsheet for the new code to load"
