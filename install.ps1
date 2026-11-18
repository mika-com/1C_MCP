<#
.SYNOPSIS
    Установка агента 1С для OpenCode v2 на Windows одной командой.

.DESCRIPTION
    1. Проверяет и при необходимости ставит через winget: Git, Node.js LTS (>= 20), Python 3,
       Java 17+ (для BSL LS в виде jar; Windows-сборка BSL LS несёт свою JRE), по флагу — OpenCode Desktop.
    2. Источник — папка, где лежит этот скрипт (скачанный ZIP или клон репозитория). Её нельзя удалять и
       переносить после установки: MCP-серверы и плагин bsl-autocheck запускаются из неё.
    3. Ставит навыки, агентов и команды: глобально в %USERPROFILE%\.config\opencode или в проект (-Project),
       регистрирует MCP-серверы в %USERPROFILE%\.config\opencode\opencode.json (запись lsp.bsl прежних версий
       удаляется) и плагин bsl-autocheck — проверку BSL после каждой правки (plugins\bsl-autocheck.js).
       Там же default_agent = "1c" (агент по умолчанию), только если default_agent ещё не задан;
       -Uninstall убирает его, только если он равен "1c".
    4. Скачивает BSL Language Server в %USERPROFILE%\.config\opencode\tools\bsl-language-server.
    5. Ставит Playwright и Chromium для навыка web-test.
    6. Находит установленную платформу 1С для синтакс-помощника 1c-help (справка читается локально,
       в проект не входит); переопределение — переменная V8_HELP_PATH (каталог bin платформы).
    7. -WithSemantic: семантический поиск 1c-search через LM Studio (docs\semantic-search.md) — переменные среды
       SEMANTIC_*, раздел semanticSearch в новом .v8-project.json проекта, проверка scripts\check-lmstudio.ps1.
       С -Machine — общее хранилище векторов C:\ProgramData\1c-opencode\semantic для всех пользователей.
       Токен API LM Studio установщик не спрашивает и не записывает: LMSTUDIO_API_KEY задаёт сам пользователь.
    Повторный запуск безопасен: уже установленное пропускается. Обновление — git pull (или новый ZIP) и повторный запуск.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
    install.cmd -Project D:\1c\my-config
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Project D:\1c\my-config -WithVrunner
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
.EXAMPLE
    # семантический поиск через LM Studio на этой машине (127.0.0.1:1234)
    install.cmd -Project D:\1c\my-config -WithSemantic
.EXAMPLE
    # Сервер с несколькими пользователями (RDP), окно «от имени администратора», один раз:
    powershell -ExecutionPolicy Bypass -File install.ps1 -Machine -Users 6
    # затем каждый пользователь в своём сеансе (без прав администратора):
    powershell -ExecutionPolicy Bypass -File C:\ProgramData\1c-opencode\repo\install.ps1

.NOTES
    По умолчанию установка ПОЛЬЗОВАТЕЛЬСКАЯ: %USERPROFILE%\.config\opencode, переменные среды пользователя,
    pip --user, winget --scope user (если пакет его поддерживает), браузеры Playwright в профиле пользователя.
    -Machine (нужны права администратора) готовит общие инструменты для всех пользователей сервера:
    Git/Node.js/Python/Java через winget --scope machine, BSL LS, Chromium для Playwright и копию репозитория
    в C:\ProgramData\1c-opencode (только чтение для пользователей). Навыки и MCP каждый пользователь
    регистрирует себе сам, запустив install.ps1 из общей копии.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Интерактивный установщик: цветной вывод для человека')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Внутренние функции установщика')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '', Justification = 'Параметры Semantic* используются во внутренних функциях (область видимости скрипта)')]
[CmdletBinding()]
param(
    # Каталог 1С-проекта; без него установка глобальная (%USERPROFILE%\.config\opencode)
    [string]$Project,
    [switch]$NoBrowser,
    [switch]$NoBslLs,
    [switch]$WithVrunner,
    [switch]$WithDesktop,
    [switch]$Uninstall,
    # Общие инструменты для всех пользователей сервера (RDP); нужны права администратора
    [switch]$Machine,
    # Сколько пользователей одновременно работают на сервере — для расчёта памяти JVM BSL LS
    [ValidateRange(1, 200)][int]$Users = 0,
    # Семантический поиск 1c-search через LM Studio / OpenAI-совместимый сервер (docs\semantic-search.md)
    [switch]$WithSemantic,
    [string]$SemanticUrl = 'http://127.0.0.1:1234/v1',
    [string]$SemanticEmbedModel = 'qwen3-embedding-4b',
    [string]$SemanticRerankModel = 'qwen3-reranker-4b',
    [ValidateSet('lmstudio-logprobs', 'rerank-api', 'none')][string]$SemanticRerankBackend = 'lmstudio-logprobs'
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
$SharedRoot = Join-Path $env:ProgramData '1c-opencode'
$SharedBslLs = Join-Path $SharedRoot 'tools\bsl-language-server'
$SharedBrowsers = Join-Path $SharedRoot 'ms-playwright'
$SharedPwVersionFile = Join-Path $SharedRoot 'playwright-version.txt'
$SharedSemanticStore = Join-Path $SharedRoot 'semantic'
$SemanticEnvVars = @('SEMANTIC_SEARCH', 'SEMANTIC_BASE_URL', 'SEMANTIC_EMBED_MODEL', 'SEMANTIC_RERANK_MODEL', 'SEMANTIC_RERANK_BACKEND')
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
    $common = @('install', '--id', $Id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    if ($Machine) {
        Write-Info "Устанавливаю $Title для всех пользователей (winget --scope machine, $Id) ..."
        & winget @common --scope machine | Out-Host
    } else {
        # Сначала для текущего пользователя; если пакет так не ставится — обычная установка (может спросить UAC)
        Write-Info "Устанавливаю $Title для текущего пользователя (winget --scope user, $Id) ..."
        & winget @common --scope user | Out-Host
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
            Write-Info "Пакет $Id не поддерживает установку для пользователя — ставлю обычным способом (может появиться запрос UAC) ..."
            & winget @common | Out-Host
        }
    }
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

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RamGb {
    try { return [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch { return 8 }
}

function Get-SessionCount {
    # Сеансы пользователей на сервере (RDP + консоль); минимум 1
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& quser 2>$null | Select-Object -Skip 1)
        if ($lines.Count -gt 0) { return $lines.Count }
    } catch { Write-Verbose 'quser недоступен' }
    finally { $ErrorActionPreference = $prev }
    return 1
}

function Get-XmxForUser([int]$RamGb, [int]$UserCount) {
    # Под JVM BSL LS всех пользователей — не больше половины ОЗУ; на одного 1–4 ГБ
    $per = [math]::Floor(($RamGb / 2) / [math]::Max($UserCount, 1))
    $per = [math]::Min([math]::Max($per, 1), 4)
    return "${per}g"
}

function Find-V8HelpDir {
    # Каталоги bin установленных платформ 1С со справкой (shcntx_ru.hbk), новые — первыми
    $roots = @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { Join-Path $_ '1cv8' }
    if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA 'Programs\1cv8' }
    $found = foreach ($r in ($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $r)) { continue }
        Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | ForEach-Object {
                $bin = Join-Path $_.FullName 'bin'
                if (Test-Path -LiteralPath (Join-Path $bin 'shcntx_ru.hbk')) { [pscustomobject]@{ Version = [version]$_.Name; Path = $bin } }
            }
    }
    @($found | Sort-Object Version -Descending)
}

function Get-TargetArgument {
    if ($Project) { return @('--project-dir', $script:ProjectPath) }
    return @('--global')
}

function Set-SemanticEnvironment([string]$Scope) {
    # Только несекретные настройки; значения по умолчанию не пишем, чтобы .v8-project.json проекта мог их менять
    $pairs = [ordered]@{ SEMANTIC_SEARCH = '1' }
    if ($SemanticUrl -ne 'http://127.0.0.1:1234/v1') { $pairs.SEMANTIC_BASE_URL = $SemanticUrl.TrimEnd('/') }
    if ($SemanticEmbedModel -ne 'qwen3-embedding-4b') { $pairs.SEMANTIC_EMBED_MODEL = $SemanticEmbedModel }
    if ($SemanticRerankModel -ne 'qwen3-reranker-4b') { $pairs.SEMANTIC_RERANK_MODEL = $SemanticRerankModel }
    if ($SemanticRerankBackend -ne 'lmstudio-logprobs') { $pairs.SEMANTIC_RERANK_BACKEND = $SemanticRerankBackend }
    foreach ($k in $pairs.Keys) {
        [Environment]::SetEnvironmentVariable($k, $pairs[$k], $Scope)
        Set-Item -Path "Env:$k" -Value $pairs[$k]
    }
    Write-Ok ("Переменные ($Scope): " + (($pairs.Keys | ForEach-Object { "$_=$($pairs[$_])" }) -join ', '))
}

function Write-SemanticProjectConfig([string]$Dir) {
    $f = Join-Path $Dir '.v8-project.json'
    $section = [ordered]@{ semanticSearch = [ordered]@{ enabled = 'auto'; baseUrl = $SemanticUrl.TrimEnd('/'); embedModel = $SemanticEmbedModel
            rerankBackend = $SemanticRerankBackend; rerankModel = $SemanticRerankModel; topK = 10 } }
    if (-not (Test-Path -LiteralPath $f)) {
        $json = $section | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText($f, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "Создан $f (раздел semanticSearch)"
    } elseif ((Get-Content -LiteralPath $f -Raw -Encoding UTF8) -match '"semanticSearch"') {
        Write-Ok "В $f уже есть раздел semanticSearch — не трогаю"
    } else {
        # существующий файл с базами и паролями не переписываем — только подсказка
        Write-Info "Добавьте в $f (необязательно; без раздела действуют значения по умолчанию):"
        Write-Host (($section | ConvertTo-Json -Depth 5) -replace '^\{\s*', '' -replace '\s*\}$', '') -ForegroundColor Gray
    }
}

function Invoke-SemanticCheck {
    $check = Join-Path $InstallDir 'scripts\check-lmstudio.ps1'
    $code = Invoke-Native -File 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $check, '-BaseUrl', $SemanticUrl,
        '-EmbedModel', $SemanticEmbedModel, '-RerankModel', $SemanticRerankModel, '-RerankBackend', $SemanticRerankBackend) -AllowFail
    switch ($code) {
        0 { Write-Ok 'LM Studio: эмбеддинги и реранкер работают' }
        1 { Write-Warn 'LM Studio: эмбеддинги работают, реранкер — нет (поиск будет без переранжирования). См. вывод выше и docs\semantic-search.md.' }
        default { Write-Warn 'LM Studio недоступен или модели не загружены — 1c-search будет искать по ключевым словам, пока сервер не заработает. docs\semantic-search.md' }
    }
}

Write-Host ''
Write-Host '=== Агент 1С для OpenCode v2: установка для Windows ===' -ForegroundColor Cyan
Write-Info "Источник: $InstallDir"
if ($Project) {
    if (-not (Test-Path -LiteralPath $Project -PathType Container)) { Stop-Install "Каталог проекта не найден: $Project" }
    $script:ProjectPath = (Resolve-Path -LiteralPath $Project).Path
    Write-Info "Режим: в проект $script:ProjectPath"
} elseif ($Machine) {
    Write-Info "Режим: общие инструменты для всех пользователей ($SharedRoot)"
} else {
    Write-Info "Режим: для текущего пользователя ($env:USERNAME, $OpenCodeHome)"
}
if ($Machine -and -not (Test-Admin)) { Stop-Install '-Machine требует окна PowerShell «от имени администратора».' }
if ($Machine -and ($Project -or $Uninstall)) { Stop-Install '-Machine не сочетается с -Project и -Uninstall.' }

# ---------- Удаление ----------
if ($Uninstall) {
    Write-Step 'Удаление навыков, агентов, команд, плагина и MCP'
    $script:PythonCmd = Get-PythonCommand
    $porter = Join-Path $InstallDir 'scripts\opencode_port.py'
    if (-not $script:PythonCmd) { Stop-Install 'Python 3 не найден — удаление выполняет scripts\opencode_port.py.' }
    if (-not (Test-Path -LiteralPath $porter)) { Stop-Install "Не найден $porter." }
    Invoke-Python (@($porter, 'uninstall') + (Get-TargetArgument))
    foreach ($k in $SemanticEnvVars) {
        if ([Environment]::GetEnvironmentVariable($k, 'User')) { [Environment]::SetEnvironmentVariable($k, $null, 'User'); Write-Info "Удалена переменная $k" }
    }
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

# Общий BSL LS (после -Machine) несёт свою JRE — Java пользователю не нужна
if (-not $NoBslLs -and ($Machine -or -not [Environment]::GetEnvironmentVariable('BSL_LS_PATH', 'Machine'))) {
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

# ---------- Общая установка (-Machine) ----------
if ($Machine) {
    Write-Step "Общая копия репозитория: $SharedRoot\repo"
    $sharedRepo = Join-Path $SharedRoot 'repo'
    New-Item -ItemType Directory -Force -Path $SharedRoot | Out-Null
    if ([IO.Path]::GetFullPath($InstallDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($sharedRepo).TrimEnd('\')) {
        & robocopy.exe $InstallDir $sharedRepo /MIR /NFL /NDL /NJH /NJS /NP /XD node_modules __pycache__ .git | Out-Null
        if ($LASTEXITCODE -ge 8) { Stop-Install "robocopy не смог скопировать репозиторий (код $LASTEXITCODE)" }
    }
    try {
        Get-ChildItem -LiteralPath $sharedRepo -Recurse -File -Include '*.ps1', '*.psm1', '*.cmd' -ErrorAction SilentlyContinue |
            Unblock-File -ErrorAction SilentlyContinue
    } catch { Write-Verbose 'Unblock-File недоступен' }
    # Только чтение для пользователей; полный доступ — администраторам и SYSTEM (SID, не зависят от языка Windows)
    & icacls.exe $SharedRoot /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /T /C /Q | Out-Null
    Write-Ok "Скопирован, права: пользователи — чтение, администраторы — полный доступ"

    if (-not $NoBslLs) {
        Write-Step "BSL Language Server для всех: $SharedBslLs"
        $exe = Join-Path $SharedBslLs 'bsl-language-server\bsl-language-server.exe'
        if (Test-Path -LiteralPath $exe) { Write-Ok "Уже установлен: $exe" }
        else {
            $zip = Join-Path $env:TEMP "bsl-ls-$PID.zip"
            Write-Info 'Скачиваю bsl-language-server_win.zip (~170 МБ) ...'
            Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/1c-syntax/bsl-language-server/releases/latest/download/bsl-language-server_win.zip' -OutFile $zip
            New-Item -ItemType Directory -Force -Path $SharedBslLs | Out-Null
            Expand-Archive -LiteralPath $zip -DestinationPath $SharedBslLs -Force
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            Write-Ok "Установлен: $SharedBslLs"
        }
        [Environment]::SetEnvironmentVariable('BSL_LS_PATH', $SharedBslLs, 'Machine')
        $userCount = if ($Users -gt 0) { $Users } else { [math]::Max((Get-SessionCount), 2) }
        $xmx = Get-XmxForUser (Get-RamGb) $userCount
        [Environment]::SetEnvironmentVariable('BSL_LS_XMX', $xmx, 'Machine')
        Write-Ok "BSL_LS_PATH и BSL_LS_XMX=$xmx (ОЗУ ~$(Get-RamGb) ГБ на $userCount польз.) — переменные машины"
    }

    if (-not $NoBrowser) {
        Write-Step "Chromium для Playwright для всех: $SharedBrowsers"
        $pwPrefix = Join-Path $SharedRoot 'node'
        $env:PLAYWRIGHT_BROWSERS_PATH = $SharedBrowsers
        $code = Invoke-Native -File 'npm' -Arguments @('install', '--prefix', $pwPrefix, '--no-fund', '--no-audit', '--loglevel=error', 'playwright@^1.50.0') -AllowFail
        if ($code -eq 0) { $code = Invoke-Native -File 'npx' -Arguments @('--prefix', $pwPrefix, 'playwright', 'install', 'chromium') -AllowFail }
        if ($code -eq 0) {
            $pwVer = (& node -p "require(process.argv[1]).version" (Join-Path $pwPrefix 'node_modules\playwright\package.json'))
            Set-Content -LiteralPath $SharedPwVersionFile -Value $pwVer -Encoding ASCII
            [Environment]::SetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', $SharedBrowsers, 'Machine')
            & icacls.exe $SharedRoot /grant:r '*S-1-5-32-545:(OI)(CI)RX' /T /C /Q | Out-Null
            Write-Ok "Chromium для Playwright $pwVer; PLAYWRIGHT_BROWSERS_PATH — переменная машины"
        } else { Write-Warn 'Playwright/Chromium для всех не установлены — пользователи поставят себе сами.' }
    }

    if ($WithSemantic) {
        # После icacls выше: общий каталог векторов — изменение для пользователей (векторы считаются один раз на всех)
        Write-Step "Общее хранилище семантического индекса: $SharedSemanticStore"
        New-Item -ItemType Directory -Force -Path $SharedSemanticStore | Out-Null
        & icacls.exe $SharedSemanticStore /grant:r '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null
        [Environment]::SetEnvironmentVariable('SEMANTIC_STORE_DIR', $SharedSemanticStore, 'Machine')
        Write-Ok 'SEMANTIC_STORE_DIR — переменная машины; пользователи: изменение (только этот каталог)'
        Set-SemanticEnvironment 'Machine'
        Invoke-SemanticCheck
    }

    Write-Host ''
    Write-Host '=== Общая установка готова ===' -ForegroundColor Green
    Write-Info 'Каждый пользователь в СВОЁМ сеансе (без прав администратора) выполняет один раз:'
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$sharedRepo\install.ps1`"" -ForegroundColor Cyan
    Write-Info "Не переносите и не удаляйте $SharedRoot — MCP-серверы пользователей запускаются оттуда."
    Write-Info 'Обновление: новая версия в исходную папку и повторный запуск с -Machine (пользователям — повторить свою установку).'
    if ($script:Warnings.Count -gt 0) { foreach ($w in $script:Warnings) { Write-Host "  - $w" -ForegroundColor Yellow } }
    return
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
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $sha = (& git -c safe.directory=* -C $InstallDir rev-parse --short HEAD 2>$null)
    $ErrorActionPreference = $prev
    Write-Ok "Клон git$(if ($sha) { ", коммит $sha" } else { '' })"
} else {
    Write-Ok 'Распакованный архив.'
}
Write-Info 'Не удаляйте и не переносите эту папку: MCP-серверы и плагин bsl-autocheck запускаются из неё.'

# ---------- 3. Python-зависимости ----------
Write-Step '3/6 Python-зависимости навыков (lxml, Pillow, psutil)'
$req = Join-Path $InstallDir 'requirements.txt'
$py = $script:PythonCmd
$code = Invoke-Native -File $py[0] -Arguments ($pyExtra + @('-m', 'pip', 'install', '--user', '--quiet', '--disable-pip-version-check', '-r', $req)) -AllowFail
if ($code -eq 0) { Write-Ok 'Установлены.' } else { Write-Warn 'pip не смог поставить зависимости — нужны только для .py-рантайма навыков (pip install --user -r requirements.txt).' }

# ---------- 4. Навыки, агенты, команды, MCP, плагин ----------
Write-Step '4/6 Навыки, агенты, команды, MCP-серверы и плагин bsl-autocheck'
$porter = Join-Path $InstallDir 'scripts\opencode_port.py'
$installArgs = @($porter, 'install') + (Get-TargetArgument)
if ($WithVrunner) { $installArgs += '--vrunner' }
if ($NoBslLs) { $installArgs += '--no-autocheck' }
Invoke-Python $installArgs
Write-Ok "MCP записаны в $OpenCodeHome\opencode.json (старая запись lsp.bsl удалена, если была)"
Write-Ok 'Агент по умолчанию — 1c (default_agent), если вы не задали свой.'
if (-not $NoBslLs) { Write-Ok 'Плагин bsl-autocheck: после каждой правки .bsl/.os агент получает ошибки BSL LS (отключить: BSL_AUTOCHECK=0)' }
Write-Ok 'Плагин shell-guard: COM, интерактивный 1cv8 и загрузка конфигурации вне навыков db-* блокируются (отключить: shellGuard.enabled=false)'

# ---------- 5. BSL Language Server ----------
Write-Step '5/6 BSL Language Server'
if ($NoBslLs) { Write-Info 'Пропущено (-NoBslLs).' }
else {
    $bslDir = Join-Path $OpenCodeHome 'tools\bsl-language-server'
    $found = @(Get-ChildItem -LiteralPath $bslDir -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'bsl-language-server.exe' -or $_.Name -like 'bsl-language-server*.jar' })
    $machineBsl = [Environment]::GetEnvironmentVariable('BSL_LS_PATH', 'Machine')
    if ($machineBsl -and -not $env:BSL_LS_PATH) { $env:BSL_LS_PATH = $machineBsl }
    if ($env:BSL_LS_PATH) { Write-Ok "Используется общий/заданный BSL LS: BSL_LS_PATH = $env:BSL_LS_PATH" }
    elseif ($found.Count -gt 0) { Write-Ok "Уже установлен: $($found[0].FullName) (обновить: node `"$InstallDir\skills\bsl-check\scripts\bsl-check.mjs`" -Install)" }
    else {
        $code = Invoke-Native -File 'node' -Arguments @((Join-Path $InstallDir 'skills\bsl-check\scripts\bsl-check.mjs'), '-Install') -AllowFail
        if ($code -eq 0) { Write-Ok "Установлен в $bslDir" } else { Write-Warn 'BSL LS не установлен (сеть?). Повторите позже: node skills\bsl-check\scripts\bsl-check.mjs -Install' }
    }
}

if (-not $NoBslLs) {
    # Память JVM для больших конфигураций (BSL LS), если пользователь не задал сам
    # Учитываем, что на сервере могут работать несколько пользователей (RDP): ОЗУ/2 делится на число сеансов
    if (-not [Environment]::GetEnvironmentVariable('BSL_LS_XMX', 'User') -and -not $env:BSL_LS_XMX) {
        $ramGb = Get-RamGb
        $userCount = if ($Users -gt 0) { $Users } else { Get-SessionCount }
        $xmx = Get-XmxForUser $ramGb $userCount
        [Environment]::SetEnvironmentVariable('BSL_LS_XMX', $xmx, 'User')
        Write-Ok "BSL_LS_XMX=$xmx (ОЗУ ~$ramGb ГБ, сеансов $userCount; переменная пользователя, действует в новых сеансах OpenCode)"
    } else { Write-Ok "BSL_LS_XMX уже задана: $([Environment]::GetEnvironmentVariable('BSL_LS_XMX', 'User'))$env:BSL_LS_XMX" }
    Write-Info 'Зависшие процессы BSL LS: powershell -ExecutionPolicy Bypass -File scripts\kill-bsl-ls.ps1'
}

# ---------- Синтакс-помощник 1c-help ----------
# Справка 1С не входит в проект: 1c-help читает её из установленной платформы (shcntx_ru.hbk и др. в каталоге bin).
$helpOverride = [Environment]::GetEnvironmentVariable('V8_HELP_PATH', 'User')
if (-not $helpOverride) { $helpOverride = $env:V8_HELP_PATH }
if ($helpOverride) {
    if (Test-Path -LiteralPath $helpOverride) { Write-Ok "Синтакс-помощник 1c-help: V8_HELP_PATH = $helpOverride" }
    else { Write-Warn "V8_HELP_PATH = $helpOverride — путь не существует, 1c-help не найдёт справку." }
} else {
    $v8Help = @(Find-V8HelpDir)
    if ($v8Help.Count -gt 0) {
        Write-Ok "Синтакс-помощник 1c-help: платформа $($v8Help[0].Version) ($($v8Help[0].Path))"
        Write-Info 'Версия выбирается сама: v8path из .v8-project.json проекта или самая новая установленная. Закрепить другую — переменная V8_HELP_PATH (каталог bin).'
    } else {
        Write-Warn ("Платформа 1С со справкой (shcntx_ru.hbk) не найдена — 1c-help не сможет отвечать. Укажите каталог bin платформы: " +
            "[Environment]::SetEnvironmentVariable('V8_HELP_PATH', 'C:\Program Files\1cv8\8.3.xx.xxxx\bin', 'User')")
    }
}
Write-Info "Индекс справки строится при первом обращении и хранится в $env:LOCALAPPDATA\1c-opencode\help-cache"

# ---------- Семантический поиск 1c-search (LM Studio) ----------
if ($WithSemantic) {
    Write-Step 'Семантический поиск 1c-search (LM Studio)'
    Set-SemanticEnvironment 'User'
    if ($Project) { Write-SemanticProjectConfig $script:ProjectPath }
    $machineStore = [Environment]::GetEnvironmentVariable('SEMANTIC_STORE_DIR', 'Machine')
    if ($machineStore) { Write-Ok "Общее хранилище векторов: $machineStore" } else { Write-Info "Хранилище векторов: $env:LOCALAPPDATA\1c-opencode\semantic (своё у пользователя)" }
    if ([Environment]::GetEnvironmentVariable('LMSTUDIO_API_KEY', 'User') -or $env:LMSTUDIO_API_KEY) { Write-Ok 'LMSTUDIO_API_KEY задан' }
    else { Write-Info "Если в LM Studio включено Require Authentication: [Environment]::SetEnvironmentVariable('LMSTUDIO_API_KEY', '<токен>', 'User')" }
    Invoke-SemanticCheck
    $buildRoot = if ($Project) { $script:ProjectPath } else { '<папка проекта>' }
    Write-Info "Первое построение индекса (долго на большой конфигурации; можно и не ждать — построится в фоне при первом поиске):"
    Write-Host "    node `"$InstallDir\mcp\code-search.mjs`" --semantic-build --root `"$buildRoot`"" -ForegroundColor Cyan
}

# ---------- 6. Playwright + Chromium ----------
Write-Step '6/6 Playwright и Chromium для web-test'
if ($NoBrowser) { Write-Info 'Пропущено (-NoBrowser).' }
else {
    $prefix = if ($Project) { Join-Path $script:ProjectPath '.opencode' } else { $OpenCodeHome }
    # Общий Chromium (после install.ps1 -Machine): ставим ту же версию Playwright и браузер не качаем
    $pwSpec = 'playwright@^1.50.0'
    $sharedPw = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', 'Machine')
    $useShared = $sharedPw -and (Test-Path -LiteralPath $SharedPwVersionFile) -and
        -not [Environment]::GetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', 'User')
    if ($useShared) { $pwSpec = "playwright@$((Get-Content -LiteralPath $SharedPwVersionFile -TotalCount 1).Trim())" }
    $code = Invoke-Native -File 'npm' -Arguments @('install', '--prefix', $prefix, '--no-fund', '--no-audit', '--loglevel=error', $pwSpec) -AllowFail
    if ($code -eq 0 -and $useShared) {
        Write-Ok "Общий Chromium: $sharedPw ($pwSpec)"
    } elseif ($code -eq 0) {
        # Браузеры — в профиль пользователя (%LOCALAPPDATA%\ms-playwright), общий каталог не трогаем
        if ($sharedPw) {
            $own = Join-Path $env:LOCALAPPDATA 'ms-playwright'
            [Environment]::SetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', $own, 'User')
            $env:PLAYWRIGHT_BROWSERS_PATH = $own
        }
        $code = Invoke-Native -File 'npx' -Arguments @('--prefix', $prefix, 'playwright', 'install', 'chromium') -AllowFail
    }
    if ($code -eq 0) { Write-Ok "Playwright в $prefix\node_modules, Chromium готов." }
    else { Write-Warn "Playwright/Chromium не установлены. Повторите: npm install --prefix `"$prefix`" playwright@^1.50.0; npx --prefix `"$prefix`" playwright install chromium" }
}

# ---------- Итог ----------
Write-Host ''
Write-Host '=== Готово ===' -ForegroundColor Green
if ($Project) { Write-Info "Откройте в OpenCode каталог $script:ProjectPath — агент «1c» выбран по умолчанию (если был задан свой default_agent, выберите «1c» вручную)." }
else { Write-Info 'Откройте в OpenCode каталог 1С-проекта (XML-выгрузка) — агент «1c» выбран по умолчанию (если был задан свой default_agent, выберите «1c» вручную).' }
Write-Info 'Параметры баз — в .v8-project.json проекта (навык db-list). Обновление — git pull (или новый ZIP в ту же папку) и повторный запуск.'
if ($script:Warnings.Count -gt 0) {
    Write-Host ''
    Write-Host 'Предупреждения:' -ForegroundColor Yellow
    foreach ($w in $script:Warnings) { Write-Host "  - $w" -ForegroundColor Yellow }
}
