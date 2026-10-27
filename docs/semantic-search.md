# Семантический поиск 1c-search через LM Studio

`semantic_search` в MCP `1c-search` ищет код и объекты 1С **по смыслу**: «где проверяется лимит кредита»,
«как считается скидка по карте», «где заполняется табличная часть при вводе на основании». Конфигурация режется на
фрагменты (процедура/функция с комментарием и директивами, плюс объекты метаданных: имя, синоним, реквизиты),
фрагменты превращаются в векторы моделью эмбеддингов, запрос сравнивается с ними по косинусу, результат
смешивается с поиском по ключевым словам (RRF) и переранжируется моделью-реранкером.

Всё считается **локально** в LM Studio — код никуда не уходит. Без LM Studio инструмент работает по ключевым словам
и пишет одну строку `[!] …` о причине; агент от этого не зависает и не падает.

| | Модель | Репозиторий (GGUF) | Идентификатор в LM Studio | VRAM (Q8_0) |
|-|--------|--------------------|---------------------------|-------------|
| эмбеддинги | Qwen3-Embedding-4B | `Qwen/Qwen3-Embedding-4B-GGUF` | `qwen3-embedding-4b` | ~4,5 ГБ |
| реранкер | Qwen3-Reranker-4B | `DevQuasar/Qwen.Qwen3-Reranker-4B-GGUF` | `qwen3-reranker-4b` | ~4,5 ГБ + контекст |

Нужен LM Studio **0.3.39 или новее** (рассчитано на 0.4.x, в том числе 0.4.26; проверено на имитации сервера в тестах — на настоящем LM Studio ещё не запускалось) с CLI `lms`. Модели — Apache-2.0, в репозиторий не входят.
Слабее железо — берите `Qwen3-Embedding-0.6B` и `Qwen3-Reranker-0.6B` (те же шаги, другие идентификаторы в настройках).

## Шаг 1. Скачайте модели

LM Studio → Discover (🔍) → найдите и скачайте квантование **Q8_0**:

- `Qwen/Qwen3-Embedding-4B-GGUF` → `Qwen3-Embedding-4B-Q8_0.gguf`;
- `DevQuasar/Qwen.Qwen3-Reranker-4B-GGUF` → `Qwen.Qwen3-Reranker-4B.Q8_0.gguf`.

Или из консоли: `lms get Qwen/Qwen3-Embedding-4B-GGUF` (выберите Q8_0), `lms get DevQuasar/Qwen.Qwen3-Reranker-4B-GGUF`.

## Шаг 2. Настройки сервера

LM Studio → Developer (вкладка с `</>`) → Settings сервера:

1. **Server Port** — 1234 (по умолчанию).
2. **Serve on Local Network — выключено.** Сервер слушает только 127.0.0.1: на RDP-сервере его видят все
   пользователи этой машины, но не сеть. Из консоли: `lms server start --bind 127.0.0.1 --port 1234`.
3. **JIT models auto-evict** (в 0.3.x — «Only Keep Last JIT Loaded Model»; подпись: «Ensure at most 1 model is
   loaded via JIT at any given time») — **выключите**: иначе модель, подгруженная по запросу (JIT), выгрузит
   другую такую же, и каждый поиск будет ждать загрузки. Модели, загруженные `lms load` (шаг 5), auto-evict
   не затрагивает, но выключить всё равно стоит — на случай, если одна из них не загружена заранее.
4. **Idle TTL** у JIT-моделей по умолчанию 60 мин; модели, загруженные `lms load` без `--ttl` (шаг 5), по простою
   не выгружаются — остаются в памяти, пока их не выгрузят явно.
5. **Require Authentication** (необязательно, рекомендуется на общем сервере): создайте токен
   (Developer → Server Settings → Manage Tokens; токены — с LM Studio 0.4.0) и сохраните его **в переменной среды пользователя**, не в файлах проекта:

   ```powershell
   [Environment]::SetEnvironmentVariable('LMSTUDIO_API_KEY', '<токен>', 'User')
   ```

   Откройте OpenCode заново, чтобы переменная подхватилась. `1c-search` читает токен только из `LMSTUDIO_API_KEY`
   (поле `apiKey` в `.v8-project.json` игнорируется). На RDP-сервере токен нужен каждому пользователю.

## Шаг 3. Domain Type

LM Studio определяет назначение модели по метаданным GGUF и иногда ошибается (обе модели — архитектура qwen3).
My Models → модель → ⚙️ → **Override Domain Type**:

- Qwen3-Embedding-4B → **Text Embedding** (иначе `/v1/embeddings` ответит, что модель не для эмбеддингов);
- Qwen3-Reranker-4B → **LLM** (реранкер работает как языковая модель: отвечает «yes»/«no», а оценка — вероятность «yes»).

## Шаг 4. Шаблон реранкера

Qwen3-Reranker должен сразу отвечать «yes» или «no» после фиксированного промпта. Стандартный шаблон Qwen3
в LM Studio добавляет режим размышлений, и первым токеном приходит `<think>` — переранжирование тогда
отключается (`check-lmstudio.ps1` и `[!]` в ответе это покажут).

My Models → **Qwen3-Reranker-4B** → ⚙️ → Prompt → **Template (Jinja)** → замените текст целиком на:

```jinja
{%- for m in messages %}{{- '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n' }}{%- endfor %}{{- '<|im_start|>assistant\n<think>\n\n</think>\n\n' }}
```

Шаблон сохраняется для этой модели и на другие модели не влияет. Сообщения формирует `1c-search` сам — ровно
как в официальном примере Qwen3-Reranker:

```text
system: Judge whether the Document meets the requirements based on the Query and the Instruct provided.
        Note that the answer can only be "yes" or "no".
user:   <Instruct>: {инструкция}
        <Query>: {запрос}
        <Document>: {фрагмент кода}
```

Запрос — `POST /v1/responses` с `temperature: 0`, `max_output_tokens: 1` (если сервер требует больше — 16),
`top_logprobs: 20`, `include: ["message.output_text.logprobs"]`, `store: false`. Оценка —
`P(yes) = softmax(logprob(yes), logprob(no))` по первому токену; если токена нет среди top-20, его logprob = −10.
Logprobs в LM Studio отдаёт только `/v1/responses` (не `/v1/chat/completions`); если их нет —
`lms runtime update llama.cpp` (нужен движок llama.cpp 2.0.1+).

## Шаг 5. Загрузите модели с постоянными идентификаторами

```powershell
powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1
```

Скрипт находит скачанные модели (`lms ls`), предпочитает Q8_0, пропускает уже загруженные и выполняет

```powershell
lms load <ключ-эмбеддингов> --identifier qwen3-embedding-4b --context-length 8192 --gpu max
lms load <ключ-реранкера>   --identifier qwen3-reranker-4b  --context-length 8192 --gpu max
```

без `--ttl`, поэтому модели не выгружаются по простою. `--gpu` передаётся всегда: `-Gpu max` (по умолчанию) —
все слои на видеокарту, `-Gpu off` — только процессор, `-Gpu 0.5` — доля слоёв. Без `--gpu` `lms load` берёт
настройки загрузки модели из LM Studio, и при GPU Offload = 0 модель молча садится на процессор.
Уже загруженные модели скрипт пропускает как есть; `-Reload` выгружает их и загружает заново с `-Gpu`
(см. «ОЗУ занята, видеопамять пустая» ниже). `-EstimateOnly` — только оценить память,
`-NoRerank` — без реранкера, `-Unload` — выгрузить обе. Идентификаторы должны совпадать с настройками
`embedModel` / `rerankModel` (см. ниже).

Реранкер шлёт до 4 запросов параллельно (`rerankConcurrency`). Если в настройках загрузки модели есть
**Max Concurrent Predictions** (параллельные запросы движка llama.cpp), поставьте 4 — переранжирование будет
быстрее; при 1 запросы просто встанут в очередь.

## Шаг 6. Две видеокарты

Обе модели вместе занимают ~10 ГБ — помещаются на одну карту 16 ГБ. Настройки — Ctrl+Shift+H (Hardware):

- **Priority order** (порядок приоритета) и первой — карта, свободная от чат-модели: эмбеддинги и реранкер сядут
  на неё целиком, вторая карта останется под основную LLM. Это лучший вариант для 2× RTX 5060 Ti 16 ГБ.
- **Split evenly** (поровну) тоже работает, но каждый слой гоняет данные между картами — для моделей 4B это
  медленнее, чем одна карта.
- **Limit offload to dedicated GPU memory** — включите: при нехватке VRAM лучше ошибка загрузки, чем молчаливый
  уход в общую память и падение скорости в разы.
- `--gpu max` в `lms load` — все слои на GPU (`lmstudio-load.ps1` передаёт его всегда). Проверка: `nvidia-smi`
  (у карты занято несколько ГБ, в процессах — `llama-server.exe`), Диспетчер задач → Производительность → GPU.
- Чтобы и JIT-загрузка (по первому запросу, без `lms load`) шла на GPU, в LM Studio → My Models → шестерёнка у
  модели → настройки загрузки по умолчанию поставьте **GPU Offload** на максимум.

## Шаг 7. Проверка

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-lmstudio.ps1
```

Проверяет `/v1/models` и идентификаторы, размерность и качество эмбеддингов (похожий текст ближе непохожего),
реранкер (P(yes) у релевантного документа выше, чем у нерелевантного; диагностика `<think>`, отсутствия logprobs,
токена). Код выхода: 0 — всё работает, 1 — работают только эмбеддинги, 2 — сервер или эмбеддинги недоступны.
Параметры: `-BaseUrl`, `-EmbedModel`, `-RerankModel`, `-RerankBackend`, `-RerankUrl`, `-TimeoutSec`.

## Шаг 8. Включите в агенте

```powershell
install.cmd -Project D:\1c\my-config -WithSemantic
```

`-WithSemantic` записывает переменные среды пользователя (`SEMANTIC_SEARCH=1` и только отличающиеся от умолчаний:
`-SemanticUrl`, `-SemanticEmbedModel`, `-SemanticRerankModel`, `-SemanticRerankBackend`), создаёт
`.v8-project.json` с разделом `semanticSearch`, если файла ещё нет (существующий файл не переписывается — печатается
фрагмент для вставки), и запускает проверку шага 7. Токен установщик не трогает.

Без установщика ничего делать не обязательно: значения по умолчанию совпадают с этой инструкцией, а `enabled: auto`
включает семантику, как только сервер отвечает.

### Настройки

Переменные среды важнее `.v8-project.json` → `semanticSearch`, тот — важнее значений по умолчанию.

| `semanticSearch` | Переменная | По умолчанию | Что |
|------------------|------------|--------------|-----|
| `enabled` | `SEMANTIC_SEARCH` | `auto` | `auto`/`true` — если сервер отвечает; `false`/`0` — только ключевые слова |
| `baseUrl` | `SEMANTIC_BASE_URL`, `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-совместимый сервер |
| — | `LMSTUDIO_API_KEY` | — | токен (только переменная среды; имя меняет `apiKeyEnv`) |
| `embedModel` | `SEMANTIC_EMBED_MODEL` | `qwen3-embedding-4b` | идентификатор модели эмбеддингов |
| `dimensions` | `SEMANTIC_EMBED_DIM` | 1024 | размерность (MRL: вектор обрезается и нормируется) |
| `appendEos` | `SEMANTIC_EMBED_APPEND_EOS` | `false` | дописывать токен конца к каждому входу эмбеддингов: `false` — нет (LM Studio добавляет сам), `true` — всегда, `auto` — для моделей `qwen3-embedding`; нужен только серверам, которые EOS не добавляют (см. «Предупреждения llama.cpp про EOS») |
| `eosToken` | `SEMANTIC_EMBED_EOS_TOKEN` | `<\|endoftext\|>` | какой токен дописывать |
| `rerankBackend` | `SEMANTIC_RERANK_BACKEND` | `lmstudio-logprobs` | `lmstudio-logprobs`, `rerank-api`, `none` |
| `rerankModel` | `SEMANTIC_RERANK_MODEL` | `qwen3-reranker-4b` | идентификатор реранкера |
| `rerankBaseUrl` | `SEMANTIC_RERANK_URL` | = `baseUrl` | отдельный сервер реранкера |
| `rerankTopN` | `SEMANTIC_RERANK_TOPN` | 30 | сколько кандидатов переранжировать |
| `rerankConcurrency` | `SEMANTIC_RERANK_CONCURRENCY` | 4 | параллельных запросов к реранкеру |
| `topK` | `SEMANTIC_TOPK` | 10 | результатов по умолчанию |
| `batchSize` | `SEMANTIC_BATCH` | 16 | фрагментов в одном запросе эмбеддингов |
| `maxChunkChars` | `SEMANTIC_MAX_CHUNK_CHARS` | 2000 | длина фрагмента (длинные методы обрезаются) |
| `includeObjects` | `SEMANTIC_INCLUDE_OBJECTS` | `true` | индексировать объекты метаданных |
| `autoBuild` | `SEMANTIC_AUTOBUILD` | `true` | достраивать индекс в фоне при поиске |
| `storeDir` | `SEMANTIC_STORE_DIR` | `%LOCALAPPDATA%\1c-opencode\semantic` | хранилище векторов |
| `timeoutMs` | `SEMANTIC_TIMEOUT_MS` | 15000 | эмбеддинг запроса |
| `buildTimeoutMs` | `SEMANTIC_BUILD_TIMEOUT_MS` | 120000 | один пакет при построении |
| `rerankTimeoutMs` | `SEMANTIC_RERANK_TIMEOUT_MS` | 45000 | всё переранжирование (по истечении — без него) |
| `queryInstruction`, `rerankInstruction` | — | англ. инструкции Qwen3 | `Instruct: …\nQuery: …` для запроса |

Пример `.v8-project.json` (файл в `.gitignore`):

```json
{
  "semanticSearch": { "enabled": "auto", "embedModel": "qwen3-embedding-4b", "rerankModel": "qwen3-reranker-4b", "topK": 10 }
}
```

## Шаг 9. Постройте индекс

Индекс строится сам в фоне при первом `semantic_search` (пока он строится, поиск идёт по готовой части плюс
ключевым словам, в ответе — `[!] индекс неполный …`). Для большой конфигурации (ERP, УТ) лучше заранее, из консоли:

```powershell
node mcp\code-search.mjs --semantic-build --root D:\1c\my-config    # только изменённые файлы
node mcp\code-search.mjs --semantic-build --root D:\1c\my-config --force
node mcp\code-search.mjs --semantic-status --root D:\1c\my-config
```

Коды выхода `--semantic-build`: 0 — готово, 1 — ошибка, 2 — нет выгрузки, 3 — семантика выключена или сервер
недоступен, 4 — индекс уже строит другой процесс. Из агента — инструмент `semantic_index` (`status`, `build`,
`rebuild`, `wait_seconds` до 50).

Повторное построение пересчитывает только изменённые файлы (mtime и размер, затем хэш текста фрагмента): после
`git pull` или выгрузки из конфигуратора — секунды или минуты. Векторы хранятся по хэшу текста фрагмента, поэтому
клоны одной конфигурации (и разные пользователи с общим хранилищем) один и тот же код второй раз не считают.
Ориентир: ~150 тыс. фрагментов — ~150 МБ векторов (int8), поиск ~1 с.

## Предупреждения llama.cpp про EOS в логе LM Studio

При построении индекса в логе LM Studio может повторяться:

```text
[WARNING] At least one last token in strings embedded is not SEP. 'tokenizer.ggml.add_eos_token' should be set to 'true' in the GGUF header
```

**Это предупреждение безвредно — не обращайте на него внимания.** Qwen3-Embedding берёт вектор последнего токена
(`<|endoftext|>`), и LM Studio добавляет этот токен сам по метаданным GGUF; проверка llama.cpp ищет другой токен
(SEP) и потому пишет предупреждение, даже когда всё правильно. Проверено на LM Studio 0.4.26 с
`majentik/text-embedding-qwen3-embedding-4b`: если дописать `<|endoftext|>` ещё и со стороны 1c-search, llama.cpp
сообщает

```text
llm_tokenizer_bpe_session::check_double_bos_eos: Added a EOS token to the prompt as specified by the model but the prompt also ends with a EOS token. So now the final prompt ends with 2 EOS tokens.
```

а предупреждение «not SEP» всё равно остаётся. Поэтому `1c-search` по умолчанию **ничего не дописывает**
(`appendEos: false`).

- `appendEos: true` (или `SEMANTIC_EMBED_APPEND_EOS=1`) включайте, только если ваш сервер сам EOS **не**
  добавляет — например, старый `llama-server` с GGUF без `tokenizer.ggml.add_eos_token`
  ([ggml-org/llama.cpp#14252](https://github.com/ggml-org/llama.cpp/issues/14252), подсказка в ранней карточке
  [Qwen/Qwen3-Embedding-4B-GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/commit/e9f76f6a3091c96c04e53d106b5040890f484644)).
  `auto` — то же, но только для моделей с `qwen3-embedding` в имени. Токен не дублируется, если текст уже им
  кончается, и остаётся последним при усечении.
- Видите в логе «final prompt ends with 2 EOS tokens» — выключите: удалите `SEMANTIC_EMBED_APPEND_EOS` /
  `semanticSearch.appendEos` или поставьте `false`.
- Настройка EOS — часть идентичности набора векторов: с EOS векторы лежат в отдельном каталоге
  `vectors\<модель>-d<размерность>-eos…`, без EOS — в прежнем `vectors\<модель>-d<размерность>` с прежними хэшами.
  Векторы, посчитанные без EOS (в том числе до версии с `appendEos`), используются как есть; при смене настройки
  индекс перестраивается сам, уже посчитанное не пересчитывается.

Удалить ненужный набор с EOS (когда никто не строит индекс):

```powershell
Get-ChildItem "$env:LOCALAPPDATA\1c-opencode\semantic\vectors" -Directory -Filter '*-eos*' | Remove-Item -Recurse -Force
```

(при общем хранилище — тот же каталог `vectors` внутри `SEMANTIC_STORE_DIR`).

## ОЗУ занята, видеопамять пустая — модели на процессоре

Признаки: после загрузки моделей или построения индекса процесс LM Studio держит много ОЗУ, `nvidia-smi` у карт
почти ничего не показывает и в списке процессов нет `llama-server.exe`, эмбеддинги и реранкер заметно медленнее.
`lms ps` при этом выглядит нормально — модели загружены (`IDLE`), колонка `DEVICE` = `Local`.

Причина: модели загружены без выгрузки на видеокарту — с GPU Offload = 0 в настройках загрузки модели (JIT по
первому запросу, загрузка из интерфейса LM Studio или `lms load` без `--gpu`). `lmstudio-load.ps1` уже загруженную
модель пропускает, поэтому сам по себе её не перенесёт.

1. Движок должен быть с CUDA: `lms runtime ls` — отмечен `llama.cpp-win-x86_64-nvidia-cuda12-avx2@…`. Если выбран
   `…-avx2` без `cuda` — LM Studio → Settings → Runtime → llama.cpp (CUDA 12).
2. Перезагрузите модели на GPU:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1 -Reload
   ```

   или вручную: `lms unload --all`, затем `lms load <ключ> --identifier <id> --context-length 8192 --gpu max -y`
   для каждой модели.
3. `nvidia-smi`: у карт занято на несколько ГБ больше, в процессах `llama-server.exe`; ОЗУ LM Studio освободилась.
4. Чтобы JIT-загрузка тоже шла на GPU — GPU Offload на максимум в настройках модели по умолчанию (шаг 6).
   `lmstudio-autostart.ps1 -Run` вызывает `lmstudio-load.ps1 -Reload`, так что при автозапуске модели всегда
   перезагружаются с `--gpu max`.

## Несколько пользователей (RDP) и оптимальное распределение памяти (например, 32 ГБ ОЗУ + 32 ГБ VRAM)

На терминальном сервере с несколькими RDP-сессиями **узкое место — системная ОЗУ** (каждая сессия с 1С, браузером,
OpenCode и BSL LS расходует 4–8 ГБ RAM). Поэтому все модели и вычисления должны целиком жить в **VRAM**, а кэш
векторов — быть общим для всех пользователей:

1. **Один LM Studio на весь сервер (`127.0.0.1:1234`):**
   - Не запускайте LM Studio в каждой пользовательской сессии. Запустите один экземпляр под учётной записью
     администратора / сервисной учёткой — все RDP-сессии обращаются к нему через `http://127.0.0.1:1234/v1`.
   - Автозапуск при старте Windows (даже без входа владельца в RDP):
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts\lmstudio-autostart.ps1 -Register
     ```
     (удаление — `-Unregister`).

2. **100% моделей в VRAM, 0 ГБ в системной ОЗУ:**
   - `Qwen3-Embedding-4B (Q8_0)` (~4,5 ГБ) + `Qwen3-Reranker-4B (Q8_0)` (~4,5 ГБ) + контекст/батчи занимают
     **~10–11 ГБ VRAM** (из 32 ГБ VRAM остаётся ещё ~21 ГБ под основную LLM или запас).
   - Если стоят две карты (например, 2×16 ГБ) — в `Ctrl+Shift+H` (Hardware) выберите **Priority order** и поставьте
     первой карту, свободную от чат-модели (не *Split evenly*).
   - Обязательно включите **Limit offload to dedicated GPU memory**, чтобы при нехватке VRAM слои не выгружались в
     системную ОЗУ.
   - Загрузите модели на GPU:
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts\lmstudio-load.ps1 -Reload
     ```

3. **Общее content-addressed хранилище векторов (`C:\ProgramData\1c-opencode\semantic`):**
   - Векторы в `1c-search` хранятся по **SHA-1 хэшу текста процедуры/объекта** (`vectors/<модель>-d1024/seg-*.vec`), а
     манифест рабочей папки — отдельно в `projects/<хэш-пути>.json`. Если у 5 разработчиков 5 своих git-клонов одной
     конфигурации, 99% процедур совпадают и считаются видеокартой **ровно один раз**.
   - Настройка один раз от Администратора:
     ```powershell
     install.cmd -Machine -WithSemantic
     ```
     или вручную из PowerShell (Администратор):
     ```powershell
     $dir = 'C:\ProgramData\1c-opencode\semantic'
     New-Item -ItemType Directory -Force -Path $dir | Out-Null
     icacls $dir /grant "*S-1-5-32-545:(OI)(CI)M" | Out-Null

     [Environment]::SetEnvironmentVariable('SEMANTIC_STORE_DIR', $dir, 'Machine')
     [Environment]::SetEnvironmentVariable('SEMANTIC_SEARCH', 'auto', 'Machine')
     [Environment]::SetEnvironmentVariable('SEMANTIC_BATCH', '64', 'Machine')
     [Environment]::SetEnvironmentVariable('SEMANTIC_RERANK_CONCURRENCY', '4', 'Machine')
     ```
   - `SEMANTIC_BATCH=64` (вместо 16 по умолчанию) на 32 ГБ VRAM ускоряет первичную векторизацию крупной конфигурации
     в **2,5–3 раза**.
   - В оперативной памяти каждого процесса `1c-search` квантованные `Int8`-векторы (`dim=1024`) занимают всего
     **~150 МБ на 150 000 процедур** (~750 МБ суммарно на 5 RDP-сессий).

4. **Первичное построение индекса (один раз из консоли):**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\check-lmstudio.ps1
   node mcp\code-search.mjs --semantic-build --root D:\1c\my-config
   ```
   Когда остальные пользователи откроют свои клоны конфигурации в своих RDP-сессиях, `1c-search` возьмёт готовые
   векторы из `C:\ProgramData\1c-opencode\semantic` и досчитает только изменённые в их ветке модули за 2–5 секунд.
   Запись сегментов атомарная (временный файл → rename), одновременно достраивает индекс только один процесс
   (`build.lock` с heartbeat; брошенная блокировка снимается через 2 мин), остальные в это время ищут без блокировок.

## Другой сервер реранкера: `/v1/rerank`

Бэкенд `rerank-api` шлёт `POST {rerankBaseUrl}/rerank` `{model, query, documents, top_n}` и читает
`results[].relevance_score` — формат llama.cpp `llama-server`, Infinity, TEI, vLLM. Пример с llama.cpp:

```powershell
llama-server -m Qwen3-Reranker-4B-Q8_0.gguf --reranking --host 127.0.0.1 --port 8081 -ngl 99
$env:SEMANTIC_RERANK_BACKEND = 'rerank-api'; $env:SEMANTIC_RERANK_URL = 'http://127.0.0.1:8081/v1'
```

Для Qwen3-Reranker в `llama-server` нужен GGUF, сконвертированный свежим llama.cpp (с головой классификатора);
проще — `bge-reranker-v2-m3`. Проверка: `scripts\check-lmstudio.ps1 -RerankBackend rerank-api -RerankUrl http://127.0.0.1:8081/v1`.

## Ограничения

- Качество зависит от комментариев и имён: метод без комментария находится по коду, но хуже.
- Длинные методы обрезаются до `maxChunkChars` (начало метода важнее всего); модули форм и общие модули
  индексируются так же, как модули объектов. Код вне процедур (переменные модуля, основная программа), тексты
  запросов и макеты не индексируются.
- Первое построение на большой конфигурации занимает от десятков минут до нескольких часов (скорость GPU);
  поиском можно пользоваться сразу — по готовой части.
- Смена модели, `dimensions` или `appendEos`/`eosToken` — новый набор векторов (старые остаются на диске;
  удалить можно каталог `vectors\<модель>-d<размерность>[-eos…]`).
- Переранжирование 30 кандидатов — 1–5 с на запрос; `rerank: false` в вызове или `rerankBackend: none` — без него.
- Если реранкер выдаёт ошибку конфигурации (`<think>`, нет logprobs, нет модели, нет токена), переранжирование
  отключается на 60 с, поиск продолжается без него с пометкой `[!]`.
