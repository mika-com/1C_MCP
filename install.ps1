<#
.SYNOPSIS
    Установка агента 1С для OpenCode v2 на Windows одной командой.

.DESCRIPTION
    1. Проверяет и при необходимости ставит через winget: Git, Node.js LTS (>= 20), Python 3,
       Java 17+ (для BSL LS в виде jar; Windows-сборка BSL LS несёт свою JRE), по флагу — OpenCode Desktop.
    2. Источник — папка, где лежит этот скрипт (скачанный ZIP или клон репозитория). Её нельзя удалять и
       переносить после установки: MCP-серверы и LSP запускаются из неё.
    3. Ставит навыки, агентов и команды: глобально в %USERPROFILE%\.config\opencode или в проект (-Project),
       регистрирует MCP-серверы и LSP bsl в %USERPROFILE%\.config\opencode\opencode.json.
    4. Скачивает BSL Language Server в %USERPROFILE%\.config\opencode\tools\bsl-language-server.
    5. Ставит Playwright и Chromium для навыка web-test.
    Повторный запуск безопасен: уже установленное пропускается. Обновление — git pull (или новый ZIP) и повторный запуск.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
    install.cmd -Project D:\1c\my-config
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Project D:\1c\my-config -WithVrunner
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Интерактивный установщик: цветной вывод для человека')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Внутренние функции установщика')]
[CmdletBinding()]
param(
    # Каталог 1С-проекта; без него установка глобальная (%USERPROFILE%\.config\opencode)
    [string]$Project,
    [switch]$NoBrowser,
    [switch]$NoBslLs,
    [switch]$WithVrunner,
    [switch]$WithDesktop,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { Write-Verbose 'Кодировку консоли сменить не удалось' }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$script:Warnings = New-Object System.Collections.Generic.List[string]
$OpenCodeHome = Join-Path $env:USERPROFILE '.config\opencode'
$InstallDir = $PSScriptRoot
if (-not $InstallDir -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts\opencode_port.py'))) {
    Write-Host '[ОШИБКА] Запускайте install.ps1 из папки скачанного проекта: powershell -ExecutionPolicy Bypass -File .\install.ps1' -ForegroundColor Red
    throw 'install.ps1 запущен не из папки проекта'
}

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    [OK] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Write-Warn([string]$Text) { Write-Host "    [!] $Text" -ForegroundColor Yellow; $script:Warnings.Add($Text) }
function Stop-Install([string]$Text) { Write-Host ''; Write-Host "[ОШИБКА] $Text" -ForegroundColor Red; throw $Text }

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Invoke-Native {
    # Запуск внешней программы с проверкой кода возврата
    param([string]$File, [string[]]$Arguments, [switch]$AllowFail)
    & $File @Arguments | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFail) { Stop-Install "$File $($Arguments -join ' ') завершился с кодом $code" }
    return $code
}

function Install-WingetPackage([string]$Id, [string]$Title) {
    if (-not (Test-Command 'winget')) {
        Stop-Install "$Title не найден, а winget недоступен. Установите «Установщик приложений» (App Installer) из Microsoft Store или поставьте $Title вручную и запустите скрипт снова."
    }
    Write-Info "Устанавливаю $Title через winget ($Id) ..."
    & winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    # -1978335189: уже установлено, обновлений нет
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        Stop-Install "winget не смог установить $Title (код $LASTEXITCODE). Поставьте вручную и запустите скрипт снова."
    }
    Update-SessionPath
}

function Get-NodeMajor {
    if (-not (Test-Command 'node')) { return 0 }
    $v = (& node --version 2>$null) -replace '^v', ''
    if ($v -match '^(\d+)') { return [int]$Matches[1] }
    return 0
}

function Get-PythonCommand {
    # Заглушка Microsoft Store (WindowsApps\python.exe) не годится: проверяем реальный запуск
    foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
        if (-not (Test-Command $c[0])) { continue }
        $extra = @($c | Select-Object -Skip 1)
        $out = & $c[0] @extra -c 'import sys; print(sys.version_info[0])' 2>$null
        if ($LASTEXITCODE -eq 0 -and "$out".Trim() -eq '3') { return , $c }
    }
    return $null
}

function Get-JavaMajor {
    if (-not (Test-Command 'java')) { return 0 }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $text = (& java -version 2>&1 | Out-String)
    $ErrorActionPreference = $prev
    if ($text -match 'version "1\.(\d+)') { return [int]$Matches[1] }
    if ($text -match 'version "(\d+)') { return [int]$Matches[1] }
    return 0
}

function Invoke-Python([string[]]$Arguments) {
    $py = $script:PythonCmd
    $extra = @($py | Select-Object -Skip 1)
    Invoke-Native -File $py[0] -Arguments ($extra + $Arguments) | Out-Null
}

function Get-TargetArgument {
    if ($Project) { return @('--project-dir', $script:ProjectPath) }
    return @('--global')
}

Write-Host ''
Write-Host '=== Агент 1С для OpenCode v2: установка для Windows ===' -ForegroundColor Cyan
Write-Info "Источник: $InstallDir"
if ($Project) {
    if (-not (Test-Path -LiteralPath $Project -PathType Container)) { Stop-Install "Каталог проекта не найден: $Project" }
    $script:ProjectPath = (Resolve-Path -LiteralPath $Project).Path
    Write-Info "Режим: в проект $script:ProjectPath"
} else {
    Write-Info "Режим: глобально ($OpenCodeHome)"
}

# ---------- Удаление ----------
if ($Uninstall) {
    Write-Step 'Удаление навыков, агентов, команд и MCP/LSP'
    $script:PythonCmd = Get-PythonCommand
    $porter = Join-Path $InstallDir 'scripts\opencode_port.py'
    if (-not $script:PythonCmd) { Stop-Install 'Python 3 не найден — удаление выполняет scripts\opencode_port.py.' }
    if (-not (Test-Path -LiteralPath $porter)) { Stop-Install "Не найден $porter." }
    Invoke-Python (@($porter, 'uninstall') + (Get-TargetArgument))
    Write-Ok 'Готово.'
    Write-Info "Не удалялись (удалите вручную при необходимости): папка проекта $InstallDir,"
    Write-Info "$OpenCodeHome\tools\bsl-language-server, $OpenCodeHome\node_modules (Playwright), программы из winget."
    return
}

# ---------- 1. Зависимости ----------
Write-Step '1/6 Проверка программ (Git, Node.js, Python, Java)'
Update-SessionPath
if (Test-Command 'git') { Write-Ok ((& git --version) -join ' ') } else { Install-WingetPackage 'Git.Git' 'Git' }
if (-not (Test-Command 'git')) { Stop-Install 'Git установлен, но не найден в PATH. Откройте новое окно PowerShell и запустите скрипт снова.' }

$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 20) { Write-Ok "Node.js $(& node --version)" }
else {
    if ($nodeMajor -gt 0) { Write-Info "Node.js $nodeMajor устарел, нужна версия 20+" }
    Install-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    if ((Get-NodeMajor) -lt 20) { Stop-Install 'Node.js 20+ не найден после установки. Откройте новое окно PowerShell и запустите скрипт снова.' }
    Write-Ok "Node.js $(& node --version)"
}

$script:PythonCmd = Get-PythonCommand
if (-not $script:PythonCmd) {
    Install-WingetPackage 'Python.Python.3.12' 'Python 3.12'
    $script:PythonCmd = Get-PythonCommand
    if (-not $script:PythonCmd) { Stop-Install 'Python 3 не найден после установки. Откройте новое окно PowerShell и запустите скрипт снова.' }
}
$pyExtra = @($script:PythonCmd | Select-Object -Skip 1)
Write-Ok ("Python: " + ((& $script:PythonCmd[0] @pyExtra --version) -join ' '))

if (-not $NoBslLs) {
    $javaMajor = Get-JavaMajor
    if ($javaMajor -ge 17) { Write-Ok "Java $javaMajor" }
    else {
        Install-WingetPackage 'EclipseAdoptium.Temurin.21.JRE' 'Java 21 (Temurin JRE)'
        $javaMajor = Get-JavaMajor
        if ($javaMajor -ge 17) { Write-Ok "Java $javaMajor" }
        else { Write-Warn 'Java 17+ не найдена в PATH (нужна только для BSL LS в виде jar; Windows-сборка BSL LS работает со своей JRE).' }
    }
}

if ($WithDesktop) {
    $desktop = Join-Path $env:LOCALAPPDATA 'OpenCode'
    if (Test-Path -LiteralPath $desktop) { Write-Ok "OpenCode Desktop уже установлен ($desktop)" }
    else { Install-WingetPackage 'SST.OpenCodeDesktop' 'OpenCode Desktop' }
}

# ---------- 2. Папка проекта ----------
Write-Step "2/6 Папка проекта $InstallDir"
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'skills'))) { Stop-Install "В $InstallDir нет каталога skills — скачайте проект целиком." }
# Файлы из скачанного ZIP помечены как «из интернета» — снимаем пометку, чтобы скрипты навыков запускались
try {
    Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Include '*.ps1', '*.psm1', '*.cmd' -ErrorAction SilentlyContinue |
        Unblock-File -ErrorAction SilentlyContinue
} catch { Write-Verbose 'Unblock-File недоступен' }
if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
    Write-Ok "Клон git, коммит $((& git -C $InstallDir rev-parse --short HEAD 2>$null))"
} else {
    Write-Ok 'Распакованный архив.'
}
Write-Info 'Не удаляйте и не переносите эту папку: MCP-серверы и LSP запускаются из неё.'

# ---------- 3. Python-зависимости ----------
Write-Step '3/6 Python-зависимости навыков (lxml, Pillow, psutil)'
$req = Join-Path $InstallDir 'requirements.txt'
$py = $script:PythonCmd
$code = Invoke-Native -File $py[0] -Arguments ($pyExtra + @('-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', '-r', $req)) -AllowFail
if ($code -eq 0) { Write-Ok 'Установлены.' } else { Write-Warn 'pip не смог поставить зависимости — нужны только для .py-рантайма навыков (pip install --user -r requirements.txt).' }

# ---------- 4. Навыки, агенты, команды, MCP, LSP ----------
Write-Step '4/6 Навыки, агенты, команды, MCP-серверы и LSP'
$porter = Join-Path $InstallDir 'scripts\opencode_port.py'
$installArgs = @($porter, 'install') + (Get-TargetArgument)
if ($WithVrunner) { $installArgs += '--vrunner' }
if ($NoBslLs) { $installArgs += '--no-lsp' }
Invoke-Python $installArgs
Write-Ok "MCP и LSP записаны в $OpenCodeHome\opencode.json"

# ---------- 5. BSL Language Server ----------
Write-Step '5/6 BSL Language Server'
if ($NoBslLs) { Write-Info 'Пропущено (-NoBslLs).' }
else {
    $bslDir = Join-Path $OpenCodeHome 'tools\bsl-language-server'
    $found = @(Get-ChildItem -LiteralPath $bslDir -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'bsl-language-server.exe' -or $_.Name -like 'bsl-language-server*.jar' })
    if ($env:BSL_LS_PATH) { Write-Ok "Используется BSL_LS_PATH = $env:BSL_LS_PATH" }
    elseif ($found.Count -gt 0) { Write-Ok "Уже установлен: $($found[0].FullName) (обновить: node `"$InstallDir\own-skills\bsl-check\scripts\bsl-check.mjs`" -Install)" }
    else {
        $code = Invoke-Native -File 'node' -Arguments @((Join-Path $InstallDir 'own-skills\bsl-check\scripts\bsl-check.mjs'), '-Install') -AllowFail
        if ($code -eq 0) { Write-Ok "Установлен в $bslDir" } else { Write-Warn 'BSL LS не установлен (сеть?). Повторите позже: node own-skills\bsl-check\scripts\bsl-check.mjs -Install' }
    }
}

if (-not $NoBslLs) {
    # Память JVM для больших конфигураций (BSL LS), если пользователь не задал сам
    if (-not [Environment]::GetEnvironmentVariable('BSL_LS_XMX', 'User') -and -not $env:BSL_LS_XMX) {
        $ramGb = 8
        try { $ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch { Write-Verbose 'ОЗУ не определено' }
        $xmx = if ($ramGb -ge 32) { '6g' } elseif ($ramGb -ge 16) { '4g' } else { '2g' }
        [Environment]::SetEnvironmentVariable('BSL_LS_XMX', $xmx, 'User')
        Write-Ok "BSL_LS_XMX=$xmx (ОЗУ ~$ramGb ГБ; переменная пользователя, действует в новых сеансах OpenCode)"
    }
    Write-Info 'Зависшие процессы BSL LS: powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1'
}

# ---------- 6. Playwright + Chromium ----------
Write-Step '6/6 Playwright и Chromium для web-test'
if ($NoBrowser) { Write-Info 'Пропущено (-NoBrowser).' }
else {
    $prefix = if ($Project) { Join-Path $script:ProjectPath '.opencode' } else { $OpenCodeHome }
    $code = Invoke-Native -File 'npm' -Arguments @('install', '--prefix', $prefix, '--no-fund', '--no-audit', '--loglevel=error', 'playwright@^1.50.0') -AllowFail
    if ($code -eq 0) {
        $code = Invoke-Native -File 'npx' -Arguments @('--prefix', $prefix, 'playwright', 'install', 'chromium') -AllowFail
    }
    if ($code -eq 0) { Write-Ok "Playwright в $prefix\node_modules, Chromium скачан." }
    else { Write-Warn "Playwright/Chromium не установлены. Повторите: npm install --prefix `"$prefix`" playwright@^1.50.0; npx --prefix `"$prefix`" playwright install chromium" }
}

# ---------- Итог ----------
Write-Host ''
Write-Host '=== Готово ===' -ForegroundColor Green
if ($Project) { Write-Info "Откройте в OpenCode каталог $script:ProjectPath и выберите агента «1c»." }
else { Write-Info 'Откройте в OpenCode каталог 1С-проекта (XML-выгрузка) и выберите агента «1c».' }
Write-Info 'Параметры баз — в .v8-project.json проекта (навык db-list). Обновление — git pull (или новый ZIP в ту же папку) и повторный запуск.'
if ($script:Warnings.Count -gt 0) {
    Write-Host ''
    Write-Host 'Предупреждения:' -ForegroundColor Yellow
    foreach ($w in $script:Warnings) { Write-Host "  - $w" -ForegroundColor Yellow }
}
