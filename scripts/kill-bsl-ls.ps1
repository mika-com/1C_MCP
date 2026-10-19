<#
.SYNOPSIS
    Завершить зависшие процессы BSL Language Server (1c-bsl, bsl-autocheck, bsl-check) ТЕКУЩЕГО пользователя в ТЕКУЩЕМ сеансе.
.DESCRIPTION
    На сервере с несколькими RDP-сеансами трогает только свои процессы: владелец (Win32_Process.GetOwner)
    совпадает с текущим пользователем и SessionId совпадает с сеансом этого окна. Процессы других
    пользователей не завершаются, даже если скрипт запущен от администратора.
    -AllUsers — все сеансы и пользователи; только явно и только в окне «от имени администратора».
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1 -DryRun
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Вывод для человека')]
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$AllUsers
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'кодировка' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$me = $identity.Name.ToLowerInvariant()
$mySession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($AllUsers) {
    $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host '-AllUsers требует окна PowerShell «от имени администратора». Без флага завершаются только ваши процессы.' -ForegroundColor Red
        exit 1
    }
    Write-Host 'ВНИМАНИЕ: -AllUsers — будут завершены процессы BSL LS ВСЕХ пользователей и сеансов.' -ForegroundColor Yellow
}

$pattern = 'bsl-language-server|[\\/]mcp[\\/]bsl-ls\.mjs'
$candidates = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'kill-bsl-ls' -and $_.ProcessId -ne $PID })
$procs = @()
$skipped = 0
foreach ($p in $candidates) {
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue
    $ownerName = if ($owner -and $owner.User) { "$($owner.Domain)\$($owner.User)".ToLowerInvariant() } else { '' }
    if ($AllUsers -or ($ownerName -eq $me -and $p.SessionId -eq $mySession)) {
        $p | Add-Member -NotePropertyName Owner -NotePropertyValue $ownerName -Force
        $procs += $p
    } else { $skipped++ }
}

Write-Host "Пользователь: $me, сеанс: $mySession"
if ($procs.Count -eq 0) {
    Write-Host 'Ваших процессов BSL LS не найдено.' -ForegroundColor Green
} else {
    $mb = [math]::Round(($procs | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
    Write-Host "Найдено процессов BSL LS: $($procs.Count), память ~$mb МБ" -ForegroundColor Yellow
    foreach ($p in $procs) {
        $cmd = $p.CommandLine
        if ($cmd.Length -gt 120) { $cmd = $cmd.Substring(0, 120) }
        Write-Host ("  {0}`tсеанс {1}`t{2}`t{3} МБ`t{4}" -f $p.ProcessId, $p.SessionId, $p.Owner, [math]::Round($p.WorkingSetSize / 1MB), $cmd)
    }
    if (-not $DryRun) {
        foreach ($p in $procs) { & taskkill.exe /T /F /PID $p.ProcessId *> $null }
        Write-Host 'Завершены.' -ForegroundColor Green
    }
}
if ($skipped -gt 0) { Write-Host "Процессов других пользователей/сеансов: $skipped — не тронуты." -ForegroundColor Gray }
if (-not $DryRun) {
    # lock-файлы 1c-bsl — только свои (каталог пользователя)
    Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA '1c-opencode\bsl-ls') -Recurse -Force -ErrorAction SilentlyContinue
}
