<#
.SYNOPSIS
    Загрузить в LM Studio модели для семантического поиска 1c-search с постоянными идентификаторами и без TTL.

.DESCRIPTION
    Запускать под пользователем, у которого установлен LM Studio (сервер один на всю машину; остальные
    пользователи RDP ходят к нему по http://127.0.0.1:1234 и LM Studio себе не ставят).
    1. Находит lms (PATH или %USERPROFILE%\.lmstudio\bin\lms.exe).
    2. Ищет скачанные модели по ключу (-EmbedKey / -RerankKey) или по образцу имени (qwen3-embedding-4b, qwen3-reranker-4b).
    3. Если модель с нужным идентификатором ещё не загружена — lms load <ключ> --identifier <id> --context-length N --gpu max
       без --ttl: загруженные так модели не выгружаются по таймеру и не вытесняются JIT-загрузкой других моделей.
    -Unload выгружает обе модели. -EstimateOnly печатает оценку памяти и ничего не загружает.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1 -EstimateOnly
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1 -RerankKey devquasar/qwen.qwen3-reranker-4b-gguf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Интерактивный скрипт: цветной вывод для человека')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$EmbedKey,
    [string]$RerankKey,
    [string]$EmbedId = 'qwen3-embedding-4b',
    [string]$RerankId = 'qwen3-reranker-4b',
    [string]$EmbedPattern = 'qwen3[-_.]?embedding[-_.]?4b',
    [string]$RerankPattern = 'qwen3[-_.]?reranker[-_.]?4b',
    [ValidateRange(512, 131072)][int]$EmbedContext = 8192,
    [ValidateRange(512, 131072)][int]$RerankContext = 8192,
    [string]$Gpu = 'max',
    [switch]$NoRerank,
    [switch]$Unload,
    [switch]$EstimateOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'Кодировку консоли сменить не удалось' }

function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Bad([string]$Text) { Write-Host "  [!!] $Text" -ForegroundColor Red }
function Write-Note([string]$Text) { Write-Host "       $Text" -ForegroundColor Gray }

function Find-LmsExecutable {
    $c = Get-Command lms -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @((Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'), (Join-Path $env:USERPROFILE '.cache\lm-studio\bin\lms.exe'))) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

$lms = Find-LmsExecutable
if (-not $lms) {
    Write-Bad 'lms не найден. Запустите LM Studio один раз под этим пользователем (lms ставится вместе с ним) или установите llmster: irm https://lmstudio.ai/install.ps1 | iex'
    exit 2
}
Write-Host "lms: $lms" -ForegroundColor Cyan

function Invoke-LmsJson([string[]]$Arguments) {
    $out = & $lms @Arguments 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { throw "lms $($Arguments -join ' ') завершился с кодом $LASTEXITCODE" }
    $start = $out.IndexOfAny([char[]]'[{')
    if ($start -lt 0) { return @() }
    return @($out.Substring($start) | ConvertFrom-Json)
}

function Get-ModelKey($Entry) {
    foreach ($p in @('modelKey', 'key', 'path', 'id')) { if ($Entry.$p) { return [string]$Entry.$p } }
    return ''
}

$loaded = @()
try { $loaded = @(Invoke-LmsJson @('ps', '--json') | ForEach-Object { $_ } | ForEach-Object { [string]$_.identifier }) } catch { Write-Note "lms ps: $($_.Exception.Message)" }

if ($Unload) {
    foreach ($id in @($EmbedId, $RerankId)) {
        if ($loaded -contains $id) {
            if ($PSCmdlet.ShouldProcess($id, 'lms unload')) { & $lms unload $id | Out-Host; Write-Ok "Выгружена $id" }
        } else { Write-Note "$id не загружена" }
    }
    exit 0
}

$all = @()
try { $all = @(Invoke-LmsJson @('ls', '--json') | ForEach-Object { $_ }) } catch { Write-Bad "lms ls --json: $($_.Exception.Message)"; exit 2 }

function Resolve-Model([string]$Key, [string]$Pattern, [string]$Title) {
    if ($Key) { return $Key }
    $hits = @($all | Where-Object { ($_ | ConvertTo-Json -Compress -Depth 5) -match $Pattern })
    if ($hits.Count -eq 0) {
        Write-Bad "$Title не найдена среди скачанных моделей (образец $Pattern). Скачайте её (см. docs\semantic-search.md) или укажите ключ из lms ls."
        return $null
    }
    # предпочитаем Q8_0, если вариантов несколько
    $best = @($hits | Sort-Object { if (($_ | ConvertTo-Json -Compress -Depth 5) -match 'q8_0') { 0 } else { 1 } })[0]
    return Get-ModelKey $best
}

$plan = @(@{ Title = 'Модель эмбеддингов'; Key = (Resolve-Model -Key $EmbedKey -Pattern $EmbedPattern -Title 'Модель эмбеддингов'); Id = $EmbedId; Ctx = $EmbedContext })
if (-not $NoRerank) { $plan += @{ Title = 'Реранкер'; Key = (Resolve-Model -Key $RerankKey -Pattern $RerankPattern -Title 'Реранкер'); Id = $RerankId; Ctx = $RerankContext } }

$failed = $false
foreach ($m in $plan) {
    if (-not $m.Key) { $failed = $true; continue }
    if ($loaded -contains $m.Id -and -not $EstimateOnly) { Write-Ok "$($m.Title): уже загружена как $($m.Id)"; continue }
    $loadArgs = @('load', $m.Key, '--identifier', $m.Id, '--context-length', [string]$m.Ctx, '--gpu', $Gpu)
    if ($EstimateOnly) { $loadArgs = @('load', '--estimate-only', $m.Key, '--context-length', [string]$m.Ctx, '--gpu', $Gpu) }
    if (-not $PSCmdlet.ShouldProcess($m.Key, "lms $($loadArgs -join ' ')")) { continue }
    Write-Note "lms $($loadArgs -join ' ')"
    & $lms @loadArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Bad "$($m.Title): lms load завершился с кодом $LASTEXITCODE"; $failed = $true }
    elseif (-not $EstimateOnly) { Write-Ok "$($m.Title): $($m.Key) → идентификатор $($m.Id), без TTL" }
}
if (-not $EstimateOnly) {
    Write-Host ''
    Write-Note 'Проверка: powershell -ExecutionPolicy Bypass -File scripts\check-lmstudio.ps1'
    Write-Note 'Реранкер должен быть загружен как LLM (Domain Type: LLM) и со своим шаблоном — docs\semantic-search.md, шаги 3–4.'
}
if ($failed) { exit 1 }
exit 0
