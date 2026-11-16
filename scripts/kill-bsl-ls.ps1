<#
.SYNOPSIS
    Завершить зависшие процессы BSL Language Server (1c-bsl, bsl-autocheck, bsl-check) ТЕКУЩЕГО пользователя в ТЕКУЩЕМ сеансе.
.DESCRIPTION
    Тонкая обёртка над кроссплатформенным scripts\kill-bsl-ls.mjs.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$AllUsers
)

$nodeArgs = @((Join-Path $PSScriptRoot 'kill-bsl-ls.mjs'))
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($AllUsers) { $nodeArgs += '--all-users' }
& node @nodeArgs
exit $LASTEXITCODE
