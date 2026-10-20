<#
.SYNOPSIS
    Проверка LM Studio (или другого OpenAI-совместимого сервера) для семантического поиска 1c-search.

.DESCRIPTION
    1. GET /v1/models — сервер отвечает, загружены ли модели с нужными идентификаторами.
    2. POST /v1/embeddings — эмбеддинги: размерность, запрос (с инструкцией Qwen3-Embedding) ближе к подходящему
       фрагменту кода, чем к неподходящему. Для Qwen3-Embedding к каждому входу дописывается <|endoftext|>, как
       это делает 1c-search (пулинг по последнему токену; -AppendEos / SEMANTIC_EMBED_APPEND_EOS).
    3. Реранкер:
       lmstudio-logprobs — POST /v1/responses с промптом Qwen3-Reranker на подходящей и неподходящей паре,
         P(yes) из logprobs первого токена (ждём > 0.5 и < 0.5; хорошо — > 0.8 и < 0.2);
       rerank-api — POST /v1/rerank (llama-server --reranking и др.).
    Печатает итог и что делать. Токен API (если в LM Studio включён Require Authentication) — переменная
    среды LMSTUDIO_API_KEY; скрипт его не печатает и никуда не записывает.
    Код возврата: 0 — всё работает, 1 — эмбеддинги работают, реранкер нет, 2 — эмбеддинги не работают.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\check-lmstudio.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\check-lmstudio.ps1 -RerankBackend rerank-api -RerankUrl http://127.0.0.1:8081/v1
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Интерактивная проверка: цветной вывод для человека')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'TimeoutSec', Justification = 'Используется в Invoke-Api (область видимости скрипта)')]
[CmdletBinding()]
param(
    [string]$BaseUrl,
    [string]$EmbedModel,
    [string]$RerankModel,
    [ValidateSet('lmstudio-logprobs', 'rerank-api', 'none', '')][string]$RerankBackend = '',
    [string]$RerankUrl,
    # auto — дописывать <|endoftext|> для моделей qwen3-embedding (как 1c-search); true/false — всегда/никогда
    [ValidateSet('auto', 'true', 'false', '')][string]$AppendEos = '',
    [ValidateRange(5, 600)][int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'Кодировку консоли сменить не удалось' }

function Get-FirstValue { param([object[]]$Values) foreach ($v in $Values) { if ($v) { return [string]$v } } return '' }
$BaseUrl = (Get-FirstValue @($BaseUrl, $env:SEMANTIC_BASE_URL, $env:LMSTUDIO_BASE_URL, 'http://127.0.0.1:1234/v1')).TrimEnd('/')
$EmbedModel = Get-FirstValue @($EmbedModel, $env:SEMANTIC_EMBED_MODEL, 'qwen3-embedding-4b')
$RerankModel = Get-FirstValue @($RerankModel, $env:SEMANTIC_RERANK_MODEL, 'qwen3-reranker-4b')
$RerankBackend = Get-FirstValue @($RerankBackend, $env:SEMANTIC_RERANK_BACKEND, 'lmstudio-logprobs')
$RerankUrl = (Get-FirstValue @($RerankUrl, $env:SEMANTIC_RERANK_URL, $BaseUrl)).TrimEnd('/')
$eosMode = (Get-FirstValue @($AppendEos, $env:SEMANTIC_EMBED_APPEND_EOS, 'auto')).ToLowerInvariant()
$eosToken = Get-FirstValue @($env:SEMANTIC_EMBED_EOS_TOKEN, '<|endoftext|>')
$eos = switch -Regex ($eosMode) {
    '^auto$' { if ($EmbedModel -match '(?i)qwen3[-_. ]?embedding') { $eosToken } else { '' } }
    '^(0|false|no|off)$' { '' }
    default { $eosToken }
}
function Add-EosToken([string]$Text) { if (-not $eos -or $Text.TrimEnd().EndsWith($eos)) { return $Text } return $Text.TrimEnd() + $eos }

function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Bad([string]$Text) { Write-Host "  [!!] $Text" -ForegroundColor Red }
function Write-Note([string]$Text) { Write-Host "       $Text" -ForegroundColor Gray }

function Invoke-Api {
    param([string]$Method, [string]$Url, $Body)
    $headers = @{}
    if ($env:LMSTUDIO_API_KEY) { $headers['Authorization'] = "Bearer $($env:LMSTUDIO_API_KEY)" }
    $req = @{ Method = $Method; Uri = $Url; Headers = $headers; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
    if ($null -ne $Body) {
        $req.ContentType = 'application/json; charset=utf-8'
        $req.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    }
    try {
        $r = Invoke-WebRequest @req
        $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
        return [pscustomobject]@{ Ok = $true; Status = [int]$r.StatusCode; Error = ''; Body = $text; Json = ($text | ConvertFrom-Json) }
    } catch {
        $status = 0; $body = ''
        $resp = $_.Exception.Response
        if ($resp) { try { $status = [int]$resp.StatusCode } catch { $status = 0 } }
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $body = $_.ErrorDetails.Message }
        elseif ($resp -and ($resp | Get-Member -Name GetResponseStream -ErrorAction SilentlyContinue)) {
            try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $body = '' }
        }
        return [pscustomobject]@{ Ok = $false; Status = $status; Error = $_.Exception.Message; Body = $body; Json = $null }
    }
}

function Get-Cosine([double[]]$A, [double[]]$B) {
    $dot = 0.0; $na = 0.0; $nb = 0.0
    for ($i = 0; $i -lt [math]::Min($A.Length, $B.Length); $i++) { $dot += $A[$i] * $B[$i]; $na += $A[$i] * $A[$i]; $nb += $B[$i] * $B[$i] }
    if ($na -eq 0 -or $nb -eq 0) { return 0 }
    return $dot / [math]::Sqrt($na * $nb)
}

$query = 'где проверяется кредитный лимит контрагента при оформлении заказа'
$docPos = "Модуль: ОбщийМодуль.ПродажиСервер`n// Проверяет, не превышен ли кредитный лимит контрагента при оформлении заказа.`n" +
    "Функция ПроверитьКредитныйЛимит(Контрагент, СуммаЗаказа) Экспорт`n`tЛимит = Контрагент.КредитныйЛимит;`n" +
    "`tЗадолженность = ВзаиморасчетыСервер.Задолженность(Контрагент);`n`tВозврат Задолженность + СуммаЗаказа <= Лимит;`nКонецФункции"
$docNeg = "Модуль: Документ.РеализацияТоваров.МодульМенеджера`n// Формирует печатную форму товарной накладной.`n" +
    "Процедура ПечатьТоварнойНакладной(ТабличныйДокумент, Ссылка) Экспорт`n`tМакет = ПолучитьМакет(`"ТоварнаяНакладная`");`n" +
    "`tТабличныйДокумент.Вывести(Макет.ПолучитьОбласть(`"Шапка`"));`nКонецПроцедуры"
$queryInstruction = 'Given a description of functionality in a 1C:Enterprise configuration, retrieve the BSL procedures, functions and metadata objects that implement it'
$rerankInstruction = 'Given a search query about a 1C:Enterprise configuration, judge whether the BSL code fragment or metadata object implements or directly answers the query'
$rerankSystem = 'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".'

Write-Host ''
Write-Host "=== Проверка сервера моделей для 1c-search: $BaseUrl ===" -ForegroundColor Cyan
Write-Host "    эмбеддинги: $EmbedModel ($(if ($eos) { "с EOS $eos" } else { 'без EOS' })); реранкер: $RerankBackend$(if ($RerankBackend -ne 'none') { " ($RerankModel, $RerankUrl)" })"
if ($env:LMSTUDIO_API_KEY) { Write-Note 'Токен API: задан (LMSTUDIO_API_KEY)' } else { Write-Note 'Токен API: не задан (нужен, только если в LM Studio включено Require Authentication)' }

# ---------- 1. /models ----------
Write-Host ''
Write-Host '1. Сервер и модели' -ForegroundColor Cyan
$m = Invoke-Api -Method GET -Url "$BaseUrl/models"
if (-not $m.Ok) {
    Write-Bad "Сервер не отвечает: $($m.Error) $($m.Body)"
    if ($m.Status -eq 401 -or $m.Status -eq 403) { Write-Note 'Включена авторизация: задайте переменную среды LMSTUDIO_API_KEY (токен из LM Studio → Developer → Server Settings → Manage Tokens).' }
    else { Write-Note 'Запустите сервер LM Studio: lms server start --bind 127.0.0.1 --port 1234 (или вкладка Developer → Status: Running).' }
    Write-Host ''
    Write-Host 'ИТОГ: сервер недоступен — 1c-search будет искать только по ключевым словам.' -ForegroundColor Red
    exit 2
}
$ids = @($m.Json.data | ForEach-Object { $_.id })
Write-Ok "Сервер отвечает, моделей в /models: $($ids.Count)"
foreach ($want in @($EmbedModel, $(if ($RerankBackend -ne 'none') { $RerankModel }))) {
    if (-not $want) { continue }
    if ($ids -contains $want) { Write-Ok "Есть идентификатор $want" }
    else { Write-Bad "Нет идентификатора $want — загрузите модели: powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1" }
}

# ---------- 2. Эмбеддинги ----------
Write-Host ''
Write-Host '2. Эмбеддинги (/v1/embeddings)' -ForegroundColor Cyan
$embOk = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
if ($eos) { Write-Note "EOS: к каждому входу дописывается $eos (appendEos=$eosMode) — как в 1c-search (против предупреждения LM Studio «last token … is not SEP»)" }
else { Write-Note "EOS: не дописывается (appendEos=$eosMode, модель $EmbedModel)" }
$e = Invoke-Api -Method POST -Url "$BaseUrl/embeddings" -Body @{ model = $EmbedModel; input = @((Add-EosToken "Instruct: $queryInstruction`nQuery: $query"), (Add-EosToken $docPos), (Add-EosToken $docNeg)) }
$sw.Stop()
if (-not $e.Ok) {
    Write-Bad "Ошибка: $($e.Error) $($e.Body)"
    Write-Note 'Проверьте, что модель загружена с идентификатором и её Domain Type — Text Embedding (My Models → ⚙️).'
} else {
    $vecs = @($e.Json.data | Sort-Object index | ForEach-Object { , [double[]]$_.embedding })
    $dim = $vecs[0].Length
    $cp = Get-Cosine $vecs[0] $vecs[1]; $cn = Get-Cosine $vecs[0] $vecs[2]
    Write-Ok ("Размерность {0}, {1} мс на 3 текста" -f $dim, $sw.ElapsedMilliseconds)
    if ($dim -lt 1024) { Write-Bad "Размерность $dim меньше 1024 (по умолчанию 1c-search берёт первые 1024): задайте SEMANTIC_EMBED_DIM=$dim" }
    if ($cp -gt $cn) { Write-Ok ("Похожесть: подходящий фрагмент {0:N3} > неподходящий {1:N3}" -f $cp, $cn); $embOk = $true }
    else { Write-Bad ("Похожесть: подходящий {0:N3} <= неподходящий {1:N3} — это не эмбеддинговая модель или неверный Domain Type" -f $cp, $cn) }
}

# ---------- 3. Реранкер ----------
Write-Host ''
Write-Host "3. Реранкер ($RerankBackend)" -ForegroundColor Cyan
$rrOk = $false
function Get-YesProbability([string]$Doc, [int]$MaxOut) {
    $body = @{
        model = $RerankModel; temperature = 0; max_output_tokens = $MaxOut; top_logprobs = 20; store = $false
        include = @('message.output_text.logprobs')
        input = @(@{ role = 'system'; content = $rerankSystem }, @{ role = 'user'; content = "<Instruct>: $rerankInstruction`n<Query>: $query`n<Document>: $Doc" })
    }
    $r = Invoke-Api -Method POST -Url "$RerankUrl/responses" -Body $body
    if (-not $r.Ok) { return [pscustomobject]@{ P = $null; Error = "$($r.Error) $($r.Body)"; Status = $r.Status; First = '' } }
    $first = $null; $text = ''
    foreach ($item in @($r.Json.output)) {
        if ($item.type -eq 'reasoning') { return [pscustomobject]@{ P = $null; Error = 'think'; Status = 200; First = '<think>' } }
        if ($item.type -ne 'message') { continue }
        foreach ($c in @($item.content)) { $text = [string]$c.text; if ($c.logprobs) { $first = @($c.logprobs)[0]; break } }
    }
    if (-not $first) {
        if ($text -match '^\s*<think') { return [pscustomobject]@{ P = $null; Error = 'think'; Status = 200; First = '<think>' } }
        return [pscustomobject]@{ P = $null; Error = 'nologprobs'; Status = 200; First = $text }
    }
    if ([string]$first.token -match '^\s*<think') { return [pscustomobject]@{ P = $null; Error = 'think'; Status = 200; First = '<think>' } }
    $ly = $null; $ln = $null; $seen = @{}
    foreach ($t in @($first) + @($first.top_logprobs)) {
        if (-not $t -or $seen.ContainsKey([string]$t.token)) { continue }
        $seen[[string]$t.token] = 1
        $tok = ([string]$t.token).Trim().ToLowerInvariant()
        if ($tok -eq 'yes') { $ly = if ($null -eq $ly) { [double]$t.logprob } else { [math]::Log([math]::Exp($ly) + [math]::Exp([double]$t.logprob)) } }
        elseif ($tok -eq 'no') { $ln = if ($null -eq $ln) { [double]$t.logprob } else { [math]::Log([math]::Exp($ln) + [math]::Exp([double]$t.logprob)) } }
    }
    if ($null -eq $ly -and $null -eq $ln) { return [pscustomobject]@{ P = $null; Error = 'noyesno'; Status = 200; First = [string]$first.token } }
    if ($null -eq $ly) { $ly = -10 }; if ($null -eq $ln) { $ln = -10 }
    return [pscustomobject]@{ P = 1 / (1 + [math]::Exp($ln - $ly)); Error = ''; Status = 200; First = [string]$first.token }
}

if ($RerankBackend -eq 'none') {
    Write-Note 'Переранжирование выключено (SEMANTIC_RERANK_BACKEND=none).'
    $rrOk = $true
} elseif ($RerankBackend -eq 'rerank-api') {
    $r = Invoke-Api -Method POST -Url "$RerankUrl/rerank" -Body @{ model = $RerankModel; query = $query; documents = @($docPos, $docNeg); top_n = 2 }
    if (-not $r.Ok) { Write-Bad "Ошибка /rerank: $($r.Error) $($r.Body)"; Write-Note 'llama-server: --reranking (или reranking = true, pooling = rank в models.ini) и GGUF с cls.output.weight.' }
    else {
        $res = @($r.Json.results) + @($r.Json.data) | Where-Object { $_ }
        $sp = ($res | Where-Object { $_.index -eq 0 } | Select-Object -First 1).relevance_score
        $sn = ($res | Where-Object { $_.index -eq 1 } | Select-Object -First 1).relevance_score
        if ($sp -gt $sn) { Write-Ok ("Подходящий {0:N3} > неподходящий {1:N3}" -f $sp, $sn); $rrOk = $true }
        else { Write-Bad ("Подходящий {0:N3} <= неподходящий {1:N3} — оценки бессмысленны (GGUF без cls.output.weight?)" -f $sp, $sn) }
    }
} else {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $maxOut = 1
    $pos = Get-YesProbability $docPos $maxOut
    if ($null -eq $pos.P -and $pos.Status -eq 400 -and ($pos.Error -match 'max_output_tokens|max.?tokens|minimum|at least')) {
        Write-Note 'Сервер не принимает max_output_tokens=1 — повторяю с 16 (1c-search делает так же).'
        $maxOut = 16
        $pos = Get-YesProbability $docPos $maxOut
    }
    $neg = if ($null -ne $pos.P) { Get-YesProbability $docNeg $maxOut } else { $null }
    $sw.Stop()
    if ($null -eq $pos.P) {
        switch ($pos.Error) {
            'think' {
                Write-Bad 'Реранкер начинает ответ с <think>: в LM Studio не задан шаблон реранкера.'
                Write-Note 'My Models → Qwen3-Reranker-4B → ⚙️ → Prompt Template → Jinja: вставьте шаблон из docs\semantic-search.md (шаг 4).'
            }
            'nologprobs' {
                Write-Bad "LM Studio не вернул logprobs (ответ: «$($pos.First)»)."
                Write-Note 'Нужны LM Studio 0.3.39+ и движок llama.cpp 2.0.1+: lms runtime update llama.cpp. Модель должна быть загружена как LLM (Domain Type: LLM).'
            }
            'noyesno' {
                Write-Bad "Первый токен «$($pos.First)», а не yes/no — проверьте шаблон и что загружен именно Qwen3-Reranker."
            }
            default {
                Write-Bad "Ошибка /v1/responses: $($pos.Error)"
                Write-Note 'Проверьте идентификатор модели (lms ps) и что она загружена как LLM (Domain Type: LLM, не Text Embedding).'
            }
        }
    } elseif ($null -eq $neg -or $null -eq $neg.P) {
        Write-Bad "Вторая пара не оценена: $($neg.Error)"
    } else {
        Write-Note ("P(yes): подходящий {0:N3}, неподходящий {1:N3}; {2} мс на 2 пары" -f $pos.P, $neg.P, $sw.ElapsedMilliseconds)
        if ($pos.P -gt 0.5 -and $neg.P -lt 0.5) {
            $rrOk = $true
            if ($pos.P -gt 0.8 -and $neg.P -lt 0.2) { Write-Ok 'Реранкер различает пары уверенно.' } else { Write-Ok 'Реранкер различает пары (не очень уверенно — проверьте квантизацию/шаблон).' }
        } else { Write-Bad 'Реранкер не различает пары: проверьте шаблон (шаг 4) и модель.' }
    }
}

Write-Host ''
if ($embOk -and $rrOk) { Write-Host 'ИТОГ: всё работает — семантический поиск с переранжированием.' -ForegroundColor Green; exit 0 }
if ($embOk) { Write-Host 'ИТОГ: эмбеддинги работают, реранкер — нет: 1c-search будет искать по смыслу без переранжирования (или задайте SEMANTIC_RERANK_BACKEND=none).' -ForegroundColor Yellow; exit 1 }
Write-Host 'ИТОГ: эмбеддинги не работают — 1c-search будет искать только по ключевым словам.' -ForegroundColor Red
exit 2
