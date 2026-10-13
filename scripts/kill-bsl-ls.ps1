<#
.SYNOPSIS
    Завершить зависшие процессы BSL Language Server (1c-bsl, bsl-lsp, bsl-check) на Windows.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1 -DryRun
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Вывод для человека')]
[CmdletBinding()]
param([switch]$DryRun)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'кодировка' }
$pattern = 'bsl-language-server|[\\/]mcp[\\/]bsl-ls\.mjs|[\\/]lsp[\\/]bsl-lsp\.mjs'
$procs = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $pattern -and $_.CommandLine -notmatch 'kill-bsl-ls' -and $_.ProcessId -ne $PID })
if ($procs.Count -eq 0) {
    Write-Host 'Процессов BSL LS не найдено.' -ForegroundColor Green
} else {
    $mb = [math]::Round(($procs | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
    Write-Host "Найдено процессов BSL LS: $($procs.Count), память ~$mb МБ" -ForegroundColor Yellow
    foreach ($p in $procs) {
        $cmd = $p.CommandLine
        if ($cmd.Length -gt 140) { $cmd = $cmd.Substring(0, 140) }
        Write-Host ("  {0}`t{1} МБ`t{2}" -f $p.ProcessId, [math]::Round($p.WorkingSetSize / 1MB), $cmd)
    }
    if (-not $DryRun) {
        foreach ($p in $procs) { & taskkill.exe /T /F /PID $p.ProcessId *> $null }
        Write-Host 'Завершены.' -ForegroundColor Green
    }
}
if (-not $DryRun) {
    Remove-Item -LiteralPath (Join-Path $env:TEMP '1c-bsl-ls') -Recurse -Force -ErrorAction SilentlyContinue
}
