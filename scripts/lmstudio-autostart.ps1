<#
.SYNOPSIS
    Необязательно: автозапуск сервера LM Studio (llmster) при старте Windows и загрузка моделей 1c-search.

.DESCRIPTION
    -Register   (окно «от имени администратора», под пользователем-владельцем LM Studio) — создаёт задачу планировщика
                «1c-agent LM Studio» с триггером «при запуске системы» от имени этого пользователя (Windows спросит его
                пароль: задача работает и без входа пользователя). Задача выполняет этот же скрипт с -Run.
    -Run        lms daemon up → lms server start --bind 127.0.0.1 --port <Port> → scripts\lmstudio-load.ps1.
    -Unregister удаляет задачу.
    Сервер слушает только 127.0.0.1: он доступен всем сеансам RDP этой машины и не виден из сети.
    Официальная документация LM Studio описывает автозапуск llmster только для Linux (systemd); на Windows это
    обычная задача планировщика. Если в неинтерактивном сеансе что-то не работает — используйте вариант из
    документации LM Studio: «Run the LLM server on login» в настройках приложения (docs\semantic-search.md).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\lmstudio-autostart.ps1 -Register
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\lmstudio-autostart.ps1 -Run
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Интерактивный скрипт: цветной вывод для человека')]
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Run')]
param(
    [Parameter(ParameterSetName = 'Register')][switch]$Register,
    [Parameter(ParameterSetName = 'Unregister')][switch]$Unregister,
    [Parameter(ParameterSetName = 'Run')][switch]$Run,
    [ValidateRange(1, 65535)][int]$Port = 1234,
    [string]$TaskName = '1c-agent LM Studio'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'Кодировку консоли сменить не удалось' }

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister-ScheduledTask')) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Задача «$TaskName» удалена." }
    } else { Write-Host "Задачи «$TaskName» нет." }
    exit 0
}

if ($Register) {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'Нужно окно PowerShell «от имени администратора» (задача с триггером при запуске системы).' -ForegroundColor Red; exit 2
    }
    $self = $PSCommandPath
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -Run -Port $Port" -WorkingDirectory (Split-Path $self)
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT1M'
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Пароль владельца LM Studio — задача запускается без входа в систему'
    if ($PSCmdlet.ShouldProcess($TaskName, 'Register-ScheduledTask')) {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName `
            -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
        Write-Host "Задача «$TaskName» создана: при запуске Windows (через 1 мин) — lms daemon up, сервер 127.0.0.1:$Port, загрузка моделей." -ForegroundColor Green
        Write-Host "Проверить сейчас: Start-ScheduledTask -TaskName '$TaskName'"
    }
    exit 0
}

# -Run (набор параметров по умолчанию)
if (-not ($Run -or $PSCmdlet.ParameterSetName -eq 'Run')) { exit 0 }
$lms = (Get-Command lms -ErrorAction SilentlyContinue).Source
if (-not $lms) { $lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe' }
if (-not (Test-Path -LiteralPath $lms)) { Write-Host "lms не найден ($lms)." -ForegroundColor Red; exit 2 }
if ($PSCmdlet.ShouldProcess('llmster', 'lms daemon up; lms server start')) {
    & $lms daemon up | Out-Host
    & $lms server start --bind 127.0.0.1 --port $Port | Out-Host
    & (Join-Path $PSScriptRoot 'lmstudio-load.ps1')
    exit $LASTEXITCODE
}
