# install-windows.ps1 — установка навыков 1С для OpenCode на Windows
# Запуск: двойной щелчок по install-windows.cmd в корне распакованного архива.
#
# Что делает:
#   1. Копирует репозиторий в %USERPROFILE%\.config\opencode\1c-skills.
#   2. Копирует все навыки в %USERPROFILE%\.config\opencode\skills.
#   3. Регистрирует MCP-серверы 1c-ask, 1c-search, 1c-bsl в opencode.json.
#   4. Включает UTF-8 для Python.
#   5. При необходимости ставит BSL Language Server.
param(
    [string]$RepoTarget = (Join-Path $env:USERPROFILE '.config\opencode\1c-skills'),
    [string]$SkillsTarget = (Join-Path $env:USERPROFILE '.config\opencode\skills'),
    [switch]$NoEnv,
    [switch]$NoBslLs,
    [switch]$UpdateBslLs
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

Say ''
Say '=== Навыки 1С для OpenCode: установка ===' 'Cyan'
Say ''

if (-not (Test-Path (Join-Path $source 'skills'))) {
    Say "Ошибка: не найден каталог skills в $source. Запускайте install-windows.cmd из распакованного архива." 'Red'
    exit 1
}

function Copy-Repo([string]$from, [string]$to) {
    $srcFull = (Resolve-Path $from).Path.TrimEnd('\')
    $dstFull = [System.IO.Path]::GetFullPath($to).TrimEnd('\')
    if ($srcFull -ieq $dstFull) {
        Say "[1/5] Репозиторий уже на месте: $dstFull" 'Green'
        return $dstFull
    }
    if (Test-Path $dstFull) {
        Remove-Item -LiteralPath $dstFull -Recurse -Force
    }
    New-Item -ItemType Directory -Path $dstFull -Force | Out-Null
    Get-ChildItem -LiteralPath $srcFull -Force |
        Where-Object { $_.Name -notin @('.git', 'node_modules', 'tools', 'build', 'base') } |
        Copy-Item -Destination $dstFull -Recurse -Force
    Say "[1/5] Репозиторий установлен: $dstFull" 'Green'
    return $dstFull
}

function Copy-Skills([string]$repoDir, [string]$dstRoot) {
    $skillsSrc = Join-Path $repoDir 'skills'
    New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null
    $list = Get-ChildItem -LiteralPath $skillsSrc -Directory
    foreach ($skill in $list) {
        $dst = Join-Path $dstRoot $skill.Name
        if (Test-Path $dst) {
            Remove-Item -LiteralPath $dst -Recurse -Force
        }
        Copy-Item -LiteralPath $skill.FullName -Destination $dst -Recurse -Force
    }
    Say "[2/5] Навыки установлены ($($list.Count)): $dstRoot" 'Green'
}

$repoDir = Copy-Repo $source $RepoTarget
Copy-Skills $repoDir $SkillsTarget

if (-not $NoEnv) {
    [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'User')
    [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'User')
    Say '[3/5] Python переведён в режим UTF-8' 'Green'
} else {
    Say '[3/5] Переменные окружения не трогаю (-NoEnv)' 'Yellow'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Say "[4/5] Node.js найден: $(& node --version)" 'Green'
    $reg = Join-Path $repoDir 'mcp\register-opencode-mcp.mjs'
    if (Test-Path $reg) {
        $out = & node $reg 2>&1
        if ($LASTEXITCODE -eq 0) { Say "      $out" 'Green' }
        else { Say "      Не удалось обновить opencode.json: $out" 'Red' }
    }
} else {
    Say '[4/5] Node.js не найден. MCP-серверы 1c-ask/1c-search/1c-bsl не зарегистрированы.' 'Yellow'
    Say '      Установите Node.js 18+ и выполните: node mcp\register-opencode-mcp.mjs' 'Yellow'
}

$bslDir = Join-Path $env:USERPROFILE '.config\opencode\tools\bsl-language-server'
$bslExe = Join-Path $bslDir 'bsl-language-server\bsl-language-server.exe'
if ($NoBslLs) {
    Say '[5/5] BSL Language Server: пропущено (-NoBslLs)' 'Yellow'
} elseif ((Test-Path $bslExe) -and -not $UpdateBslLs) {
    Say "[5/5] BSL Language Server уже установлен: $bslExe" 'Green'
} else {
    Say '[5/5] Скачиваю BSL Language Server (около 170 МБ, один раз)...' 'Gray'
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
        Say '      Навыки работают и без него, кроме проверки кода (bsl-check).' 'Yellow'
    }
}

Say ''
Say 'Готово.' 'Cyan'
Say 'Перезапустите OpenCode, чтобы он перечитал глобальные skills и opencode.json.'
Say 'Навыки лежат в %USERPROFILE%\.config\opencode\skills, MCP — в %USERPROFILE%\.config\opencode\opencode.json.'
if (-not $node) { exit 2 }
