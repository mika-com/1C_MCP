# install-windows.ps1 — установка навыков 1С для goose (Desktop и CLI) на Windows
# Запуск: двойной щелчок по install-windows.cmd в корне распакованного архива.
#
# Что делает:
#   1. Копирует плагин (эту папку) в %USERPROFILE%\.agents\plugins\1c — оттуда его берёт goose.
#   2. Находит Git Bash и прописывает GOOSE_SHELL: навыки пишут команды для bash, а goose на
#      Windows по умолчанию использует cmd.
#   3. Ставит GOOSE_DEFAULT_EXTENSION_TIMEOUT=3600, чтобы долгие операции с базой не обрывались
#      через 5 минут, и включает UTF-8 для Python (PYTHONUTF8, PYTHONIOENCODING).
#   4. Проверяет Node.js (форма вопросов, поиск по выгрузке, web-test, хук защиты).
#   5. Скачивает BSL Language Server (~170 МБ, со встроенной Java) в %USERPROFILE%\.agents\tools —
#      проверка BSL-кода (навык bsl-check) и MCP-сервер bsl. -NoBslLs — пропустить, -UpdateBslLs — обновить.
#   6. Копирует рецепты этапов работы в %USERPROFILE%\.agents\recipes (библиотека рецептов goose).
# Повторный запуск обновляет плагин до версии из этой папки.
param(
    [string]$Target = (Join-Path $env:USERPROFILE '.agents\plugins\1c'),
    [switch]$NoEnv,
    [switch]$NoBslLs,
    [switch]$UpdateBslLs
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

Say ''
Say '=== Навыки 1С для goose: установка ===' 'Cyan'
Say ''

if (-not (Test-Path (Join-Path $source 'plugin.json'))) {
    Say "Ошибка: не найден plugin.json в $source. Запускайте install-windows.cmd из распакованного архива." 'Red'
    exit 1
}

# --- 1. Плагин --------------------------------------------------------------
$srcFull = (Resolve-Path $source).Path.TrimEnd('\')
$dstFull = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
if ($srcFull -ieq $dstFull) {
    Say "[1/6] Плагин уже на месте: $dstFull" 'Green'
} else {
    if (Test-Path $dstFull) {
        Remove-Item -LiteralPath $dstFull -Recurse -Force
    }
    New-Item -ItemType Directory -Path $dstFull -Force | Out-Null
    Get-ChildItem -LiteralPath $srcFull -Force |
        Where-Object { $_.Name -notin @('.git', 'node_modules', 'tools', 'build', 'base') } |
        Copy-Item -Destination $dstFull -Recurse -Force
    Say "[1/6] Плагин установлен: $dstFull" 'Green'
}

# --- 2. Git Bash -> GOOSE_SHELL --------------------------------------------
$bash = $null
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    # ...\Git\cmd\git.exe или ...\Git\bin\git.exe -> ...\Git\bin\bash.exe
    $gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
    if ($gitRoot) {
        $cand = Join-Path $gitRoot 'bin\bash.exe'
        if (Test-Path $cand) { $bash = $cand }
    }
}
if (-not $bash) {
    $roots = @()
    if ($env:ProgramFiles) { $roots += Join-Path $env:ProgramFiles 'Git' }
    if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA 'Programs\Git' }
    foreach ($root in $roots) {
        $cand = Join-Path $root 'bin\bash.exe'
        if (Test-Path $cand) { $bash = $cand; break }
    }
}

if ($NoEnv) {
    Say '[2/6] Переменные окружения не трогаю (-NoEnv)' 'Yellow'
} elseif ($bash) {
    [Environment]::SetEnvironmentVariable('GOOSE_SHELL', $bash, 'User')
    Say "[2/6] GOOSE_SHELL = $bash" 'Green'
} else {
    Say '[2/6] Git Bash не найден. Установите Git for Windows (https://git-scm.com/download/win)' 'Red'
    Say '      и запустите установку ещё раз. Без него навыки на Windows работать не будут.' 'Red'
}

# --- 3. Таймаут и кодировка --------------------------------------------------
if (-not $NoEnv) {
    [Environment]::SetEnvironmentVariable('GOOSE_DEFAULT_EXTENSION_TIMEOUT', '3600', 'User')
    # Python в режиме UTF-8: иначе print() русского текста в консоли goose падает на cp1251.
    [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'User')
    [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'User')
    Say '[3/6] GOOSE_DEFAULT_EXTENSION_TIMEOUT = 3600 (1 час на команду), Python в режиме UTF-8' 'Green'
}

# --- 4. Node.js --------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Say "[4/6] Node.js найден: $(& node --version)" 'Green'
    $ask = Join-Path $dstFull 'mcp\ask-user.mjs'
    if (Test-Path $ask) {
        $check = & node $ask --selftest 2>&1
        if ($LASTEXITCODE -eq 0) { Say "      Форма вопросов: $check" 'Green' }
        else { Say "      Форма вопросов не запускается: $check" 'Red' }
    }
} else {
    Say '[4/6] Node.js не найден. Он нужен для формы вопросов (ask_user), работы через браузер' 'Yellow'
    Say '      (web-test) и защиты типовых конфигураций. Скачайте LTS-версию: https://nodejs.org' 'Yellow'
}

# --- 5. BSL Language Server -----------------------------------------------------
$bslDir = Join-Path $env:USERPROFILE '.agents\tools\bsl-language-server'
$bslExe = Join-Path $bslDir 'bsl-language-server\bsl-language-server.exe'
if ($NoBslLs) {
    Say '[5/6] BSL Language Server: пропущено (-NoBslLs)' 'Yellow'
} elseif ((Test-Path $bslExe) -and -not $UpdateBslLs) {
    Say "[5/6] BSL Language Server уже установлен: $bslExe" 'Green'
} else {
    Say '[5/6] Скачиваю BSL Language Server (около 170 МБ, один раз)...' 'Gray'
    $zip = Join-Path $env:TEMP 'bsl-language-server_win.zip'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/1c-syntax/bsl-language-server/releases/latest/download/bsl-language-server_win.zip' -OutFile $zip
        New-Item -ItemType Directory -Path $bslDir -Force | Out-Null
        $old = Join-Path $bslDir 'bsl-language-server'
        if (Test-Path $old) { Remove-Item -LiteralPath $old -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $bslDir -Force
        Remove-Item -LiteralPath $zip -Force
        if (Test-Path $bslExe) { Say "      BSL Language Server установлен: $bslExe" 'Green' }
        else { Say "      Архив распакован, но $bslExe не найден" 'Red' }
    } catch {
        Say "      Не удалось скачать BSL Language Server: $($_.Exception.Message)" 'Yellow'
        Say '      Навыки работают и без него, кроме проверки кода (bsl-check). Повторите установку позже.' 'Yellow'
    }
}

# --- 6. Рецепты ------------------------------------------------------------------
$recipesSrc = Join-Path $dstFull 'goose\recipes'
$recipesDst = Join-Path $env:USERPROFILE '.agents\recipes'
if (Test-Path $recipesSrc) {
    New-Item -ItemType Directory -Path $recipesDst -Force | Out-Null
    $list = Get-ChildItem -LiteralPath $recipesSrc -Filter '*.yaml'
    $list | Copy-Item -Destination $recipesDst -Force
    Say "[6/6] Рецепты этапов работы ($($list.Count)): $recipesDst" 'Green'
}

Say ''
Say 'Готово.' 'Cyan'
Say 'Полностью закройте goose (и в области уведомлений) и запустите снова, чтобы он увидел настройки.'
Say 'В goose: «Навыки» в меню слева — там должны появиться навыки 1С (epf-init, meta-info и др.),'
Say '«Рецепты» — четыре рецепта «1С: …» (анализ, доработка, загрузка в базу, проверка в браузере).'
if (-not $bash -or -not $node) { exit 2 }
