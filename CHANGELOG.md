# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Добавлено
- Расширение `AgentQuery` в XML (`skills/db-install-agentquery/extension`) и навык `db-install-agentquery`:
  загрузка HTTP-сервиса чтения в выбранную базу через `db-load-xml -Extension` (`-Database <id>`, без пароля
  в команде). Перед загрузкой подставляются uuid языка и версия формата из выгрузки базы. `query_db` с
  `action: "status"` отдельно сообщает: нет адреса, адрес не отвечает, сервис не опубликован (404),
  ошибка входа (401/403), в URL попал веб-клиент.
- MCP `odata_get` (`1c-search`): только GET стандартного OData (`entity`, `$filter`, `$select`, `$top`, `$orderby`),
  лимит строк и таймаут обязательны, пароль из `.v8-project.json` уходит заголовком `Authorization` и не попадает
  в ответ. `action: "status"` проверяет, что сервис опубликован. Адрес — `odataUrl` или `webUrl` + `/odata/standard.odata`.
- Плагин `shell-guard` v2: кроме прежних запретов блокирует команду с паролем базы (`-Password`, `/P`, `curl -u`,
  `Basic`, значение из `.v8-project.json`), чтение `.v8-project.json`, `opencode.db` и `.env` через оболочку и
  `Get-Content`/`Select-String`/`cat`/`grep` по BSL и XML выгрузки. Последнее именно блокируется, а не предупреждается:
  в сессиях этот обход индекса был основным расходом, в ответе назван инструмент (`read` с offset, `find_method`,
  `find_usages`, `search_code`, `meta-info`). Отключение прежнее: `shellGuard.enabled=false` или `V8_SHELL_GUARD=0`.
- Навыки с `-Password` принимают `-Database <id>` и сами подставляют соединение, пользователя и пароль
  (сначала `id` и `aliases`, иначе путь или `server`+`ref`). В примерах навыков пароль больше не показан.
- Права агентов OpenCode v2 (проверено по [документации permissions](https://opencode.ai/docs/permissions/) и
  [миграции с v1](https://opencode.ai/docs/migrate-v1/)): у `1c` и субагентов оболочка по умолчанию спрашивает,
  чтение git и скрипты навыков разрешены, загрузку в базу может только `1c-deployer`, исследователи не правят файлы
  и не запускают Code Mode, чтение `.v8-project.json`, `opencode.db` и `.env` запрещено. Файл с ключом `permissions`
  OpenCode v2 читает только как v2, старый объект `permission` рядом не дублируется. На v1 эти правила не действуют;
  барьер — `shell-guard`. В быстром старте — как задать дешёвую модель служебным агентам `title` / `summary` /
  `compaction` вместо устаревшего `small_model`.
- Плагин `shell-guard`: до запуска блокирует COM-коннектор любой версии, интерактивный `1cv8` и загрузку или
  обновление конфигурации и расширений в базу вне навыков `db-*` (включая скрипт и `powershell -EncodedCommand`).
  Отключение — `"shellGuard": { "enabled": false }` в `.v8-project.json` или `V8_SHELL_GUARD=0`.
- MCP `query_db` (`1c-search`): чтение базы только запросом `ВЫБРАТЬ` после `validate_query`, с обязательными
  лимитом строк и таймаутом. База — `id` из `.v8-project.json`. Пароль не попадает в вывод и в командную строку:
  вызов идёт HTTP-сервисом `AgentQuery` (`mcp/query-db/AgentQuery.bsl`) из процесса MCP. У инструмента стоит
  `readOnlyHint`.
- `1c-search` запускается через `mcp/restart-stdio.mjs`: при падении процесса (код 134, нехватка памяти) незакрытый
  запрос получает ошибку, сервер поднимается снова и не пропадает из каталога OpenCode. Дочернему процессу задаётся
  куча `SEARCH_MAX_OLD_SPACE_MB` (по умолчанию 8192). `search_code` и `find_usages` читают модули построчно и
  останавливаются по объёму; ответ «поиск остановлен» просит сузить `path_filter`.
- `web-test`: `getFormState().frameTexts` и `readFrameText()` читают текст iframe (лента, HTML-поле, табличный документ).
- Установщик (`register-opencode-mcp.mjs`, его вызывают `opencode_port.py install` и `install.ps1`) прописывает
  `"default_agent": "1c"` в `~/.config/opencode/opencode.json`, только если `default_agent` ещё не задан;
  удаление убирает его, только если он равен `"1c"`. Отключить при ручной регистрации — `--no-default-agent`.
- Файл `VERSION` — единственный источник версии 1C-Agent. MCP-серверы пишут её в `instructions` и `serverInfo`
  (`1c-search`, `1c-help`, заглушка `1c-bsl`; прокси `1c-bsl` дописывает её к ответу `initialize`, не затирая
  версию BSL LS). `index_status` печатает `1C-Agent <версия>` и состояние плагина `bsl-autocheck`: активен,
  отмечен старой версией или отметки нет. Плагин при загрузке пишет `%LOCALAPPDATA%` / `~/.cache/1c-opencode/bsl-autocheck.json`
  (`BSL_AUTOCHECK_STATE` — свой путь). Нет строки `[bsl-autocheck]` после правки `.bsl` и нет отметки — установка устарела.
- `form-compile` отклоняет незнакомое событие формы и элемента (`[ERROR]`, код выхода ≠ 0). Список событий формы
  дополнен событиями отчёта СКД, у поля табличного документа — `DetailProcessing` и соседние. Обход:
  `FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1` (остаётся `[WARN]`). Патч в `scripts/port_core.py`, переживает сборку навыков.
- Скрипты навыков с `-Password` берут пользователя и пароль из записи `databases[]` в `.v8-project.json`
  (по `path` или `server`+`ref`), иначе из `V8_DB_USER` / `V8_DB_PASSWORD`. Явный аргумент важнее. Пароль в вывод не пишется.
- Плагин `bsl-autocheck` перед командой PowerShell/`cmd` включает UTF-8 (`shell.create.before` и `tool.execute.before`,
  если указана оболочка): преамбула `[Console]::OutputEncoding` без BOM и `chcp 65001`. Скрипты навыков `.ps1`
  делают то же в начале файла. `PYTHONIOENCODING`/`PYTHONUTF8` выставляются для Python.
- Правила агентов: не запускать COM, typelib, правку реестра, UI Automation и GUI `1cv8` (проверка — веб-публикация
  и `web-test`); внешний отчёт/обработка на БСП — сразу `epf-bsp-init`, штатная форма СКД и штатная расшифровка
  (`DetailProcessing`, не выдуманное событие); после ~3 неудач — `1c-help` / `1c-search`, затем вопрос пользователю;
  незнакомый API — сначала справка; циклы `web-test` — субагенту `1c-tester`, 1–2 скриншота, лучше текст и DOM;
  план и подтверждение, один этап на сеанс; исходники (в том числе JSON СКД) в проекте, не в `%TEMP%`; пароль не
  в аргументах команды.
- Семантический поиск в MCP `1c-search` (`mcp/lib/semantic.mjs`): инструменты `semantic_search` (режимы `hybrid`,
  `semantic`, `keyword`; фильтр `object`, `with_code`) и `semantic_index` (`status`, `build`, `rebuild`).
  Фрагменты — процедуры/функции BSL с комментарием и директивами и объекты метаданных; эмбеддинги через
  `/v1/embeddings` (LM Studio, `Qwen3-Embedding-4B`, MRL 1024, инструкция `Instruct: …\nQuery: …`); гибрид с
  ключевыми словами через RRF; реранкер `lmstudio-logprobs` (`Qwen3-Reranker-4B`, P(yes) из `/v1/responses`,
  параллельно 4) или `rerank-api` (`/v1/rerank`).
- Хранилище векторов: content-addressed (хэш текста фрагмента), int8, атомарная запись сегментов, один построитель
  (`build.lock` с heartbeat), инкрементальное обновление по mtime/хэшу, частичный индекс доступен во время
  построения; общее хранилище для RDP-сервера — `SEMANTIC_STORE_DIR`.
- CLI `node mcp/code-search.mjs --semantic-build [--root] [--force]` и `--semantic-status`.
- Скрипты `scripts/check-lmstudio.ps1` (проверка эмбеддингов и реранкера), `scripts/lmstudio-load.ps1` (загрузка
  моделей с постоянными идентификаторами, без TTL), `scripts/lmstudio-autostart.ps1` (необязательный автозапуск
  через планировщик); `install.ps1 -WithSemantic` (`-SemanticUrl`, `-SemanticEmbedModel`, `-SemanticRerankModel`,
  `-SemanticRerankBackend`; с `-Machine` — общее хранилище векторов).
- Настройки: переменные `SEMANTIC_*`, раздел `semanticSearch` в `.v8-project.json`; токен — только `LMSTUDIO_API_KEY`.
- Документация [docs/semantic-search.md](docs/semantic-search.md); правила агентов `1c`, `1c-analyst` и шаблон
  `AGENTS.md`: «где реализовано X» — сначала `semantic_search`.

### Изменено
- Агент `1c` не загружает конфигурацию и не гоняет браузер сам: shell на `db-load-*`, `db-update`,
  `/LoadConfigFromFiles`, `/UpdateDBCfg` и `web-test` запрещён, это `1c-deployer` и `1c-tester`. Согласие на общую
  базу покрывает одну загрузку. Сразу после загрузки расширения, до браузера, снимается безопасный режим — скрипты
  `db-load-*` и `db-update` печатают строку `[безопасный режим]`.
- `bsl-check` и `bsl-autocheck` не считают `QueryToMissingMetadata` ошибкой расширения. Сравнение с `""` в запросе —
  предупреждение `StringCompareInQuery`, а для строки неограниченной длины (длина 0 в метаданных) — ошибка
  `UnlimitedStringCompare`.
- В README, быстром старте и frontmatter `1c` / `1c-developer` — рекомендация сильной модели. `model:` закомментирован
  и не привязан к конкретному идентификатору: flash и бесплатные модели на длинных задачах 1С работают плохо.
- `1c-search`: таймаут вызова в конфиге OpenCode — `execution: 120000`; `index_status` показывает состояние
  семантического индекса и версию агента. Без LM Studio поведение прежнее, `semantic_search` отвечает по ключевым словам с `[!]`.

### Исправлено
- `web-test`: при работе по шагам браузер с 1С закрывался и открывался заново после каждого действия. Причины:
  `run` по построению открывает браузер, выполняет скрипт и закрывает его, а навык называл его предпочтительным
  режимом; интерактивный `start` — сервер на переднем плане, и shell OpenCode завершает его вместе с вызовом (или
  по таймауту 2 мин); правило `1c-tester` требовало `stop` после интерактивной сессии. Новая команда
  `run.mjs open <url>` запускает сервер браузера отдельным процессом, ждёт готовности 1С и возвращается; дальше
  каждое действие — `exec` в том же браузере и сеансе 1С, `stop` — в конце. Повторный `open` с тем же адресом
  берёт открытый сеанс, с другим — закрывает старый (с выходом из 1С); два одновременных `open` не открывают два
  браузера. Сеанс закрывается сам после простоя `WEB_TEST_IDLE_MIN` (30 мин, `open --idle-min=N`, `0` — никогда;
  идущий `exec` не обрывается) и по SIGTERM/SIGHUP — с выходом из 1С, чтобы не держать лицензию.
- `web-test`, несколько пользователей RDP: сервер браузера слушает общий для всех 127.0.0.1 и принимал `/exec` от
  любого пользователя сервера. Теперь запросы — только с токеном из файла сеанса (временный каталог пользователя,
  права 0600), иначе 403; `status` токен не печатает.
- Навык `web-test`, агенты `1c`, `1c-tester`, навык `1c-test`, docs/web-test-guide.md (раздел «Сеанс браузера»),
  testing-guide, quickstart: по шагам — `open` + `exec`, `run` — только сценарий целиком. Файлы порта, которых нет
  в upstream, лежат в `skill-overlays/` и копируются при `opencode_port.py build`; правки upstream-скриптов — в
  `SCRIPT_PATCHES` (`scripts/port_core.py`). Тесты — `tests/web-test/session.mjs`.
- `1c-search`: вызов `find_object` с `{"name": …}` вместо `{"query": …}` OpenCode отклонял ещё до сервера
  («query: Missing key»). Главный аргумент `find_object`, `find_method`, `module_methods`, `find_usages`,
  `search_code` больше не помечен `required`; синонимы (`name`/`object` → `query` у `find_object`, `method` → `name`,
  `object`/`name` → `module`, `query`/`text` → `pattern`) объявлены в схеме и приводятся сервером к каноническому
  имени; без аргумента — понятная ошибка с примером. Имена аргументов указаны в описаниях инструментов, в
  инструкциях сервера и в правилах агентов `1c`, `1c-analyst`.
- Эмбеддинги: `<|endoftext|>` по умолчанию **не** дописывается (`appendEos: false`). LM Studio добавляет EOS сам по
  метаданным GGUF; дописывание со стороны клиента (33d1bd2, `auto` по умолчанию) давало в логе llama.cpp «final
  prompt ends with 2 EOS tokens». Предупреждение «At least one last token in strings embedded is not SEP» безвредно —
  его можно не замечать. Настройка `appendEos` (`SEMANTIC_EMBED_APPEND_EOS`: `true`, `auto` — только для
  `qwen3-embedding`, `false`) и `eosToken` остаются для серверов, которые EOS не добавляют; токен не дублируется и
  остаётся последним при усечении. Без EOS каталог векторов и хэши фрагментов — прежнего формата: индекс, посчитанный
  до 33d1bd2 (или с `SEMANTIC_EMBED_APPEND_EOS=0`), используется без пересчёта; набор `…-eos…` можно удалить.
  `check-lmstudio.ps1` по умолчанию без EOS, `-AppendEos true|auto` — по желанию.
- `scripts/lmstudio-load.ps1`: модели, уже загруженные на процессор (JIT, интерфейс LM Studio, GPU Offload = 0), больше
  не остаются там молча. `-Gpu max|off|0..1` (по умолчанию `max`, проверяется) всегда передаётся в `lms load --gpu`;
  `-Reload` выгружает уже загруженные модели и загружает заново с `--gpu`; без `-Reload` скрипт подсказывает его
  для уже загруженных моделей. `scripts/lmstudio-autostart.ps1` принимает `-Gpu` и вызывает загрузку с
  `-Gpu <значение> -Reload`. Без TTL, как и раньше. В docs/semantic-search.md — раздел «ОЗУ занята, видеопамять
  пустая» (`nvidia-smi`, `lms runtime ls`, `--gpu max`, GPU Offload для JIT).

## [1.0.0] — 2026-10-19

Первый публичный выпуск 1C-Agent — агента 1С:Предприятие 8.3 для OpenCode v2 (Desktop и CLI).

### Состав
- 85 навыков: 81 из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (коммит `b102d9d`, см. `UPSTREAM`),
  адаптированных под OpenCode v2, и 4 собственных: `bsl-check`, `vrunner`, `1c-test`, `print-form`.
- Агенты `1c`, `1c-analyst`, `1c-developer`, `1c-deployer`, `1c-tester`, `1c-test-author`;
  команды `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`.
- MCP-серверы `1c-search` (поиск по XML-выгрузке), `1c-bsl` (BSL LS в режиме MCP), `vrunner` (выключен по умолчанию)
  в формате OpenCode v2 (`mcp.servers`, `disabled`, таймауты в мс).
- Плагин OpenCode v2 `bsl-autocheck`: после каждой правки `.bsl`/`.os` (`edit`, `write`, `patch`) BSL LS проверяет
  изменённые файлы, ошибки и предупреждения дописываются к результату инструмента (пачки, таймаут 30 с с гашением
  дерева процессов, лимит размера, одна подсказка без BSL LS; `BSL_AUTOCHECK*`, `.v8-project.json` → `bslAutocheck`).
- LSP убран: каталог `lsp/`, секция `lsp` в `opencode.json`, флаг `--no-lsp`; установщик удаляет запись `lsp.bsl`
  прежних версий из конфига пользователя (OpenCode v2 LSP не запускает).
- MCP-сервер `1c-help` — синтакс-помощник по справке установленной платформы (`*.hbk` читаются локально, в репозиторий
  не входят): `help_search` (нечёткий поиск, рус./англ., `Тип.Метод`), `help_get`, `help_members`, `help_status`;
  выбор платформы `V8_HELP_PATH` → `.v8-project.json` → самая новая установленная; индекс в
  `%LOCALAPPDATA%\1c-opencode\help-cache` по версии; собственный парсер `.hbk` без зависимостей.
- Установка на Windows одной командой: `install.cmd` / `install.ps1` (winget-зависимости, BSL LS, Playwright,
  `-Project`, `-WithVrunner`, `-WithDesktop`, `-NoBslLs`, `-NoBrowser`, `-Uninstall`, `-Machine`); на других ОС —
  `python scripts/opencode_port.py install`.

### Надёжность
- `1c-bsl`: очистка дерева процессов, один BSL LS на пользователя и проект, таймаут вызова, узкая область индексации,
  `BSL_LS_XMX`; `scripts/kill-bsl-ls.*` — завершение только своих зависших процессов.
- Многопользовательский сервер (RDP): lock-файлы, кэши и сеансы web-test у каждого пользователя свои, общие
  инструменты через `install.ps1 -Machine`.

### Правила агентов
- Ошибки `[bsl-autocheck]` после правки исправлять сразу; каталог перед загрузкой — навыком `bsl-check`.
- Незнакомые методы и свойства платформы — проверять через `1c-help`, не придумывать (`1c`, `1c-developer`).
- Печатные формы «сначала макет» (`print-form`, предпросмотр PNG).
- Выбор перехватчика для методов типовой конфигурации (`&ИзменениеИКонтроль` / `&Перед` / `&После` / `&Вместо`),
  `cfe-patch-method -Check` / `-Actualize` после обновления.
- Стратегия тестирования: web-test, Vanessa Automation (BDD), YAxUnit.

### Удалено перед публикацией
- Наследие goose-порта (`legacy/`: рецепты и манифест goose, сервер вопросов `1c-ask`, хук `support-guard`
  в формате Claude Code, `goose_port.py`, `analyze_session.py`, старый `install-windows.ps1`) и путь `~/.agents`.
  Проверку объектов на поддержке выполняют сами навыки-мутаторы (`editingAllowedCheck`).

[1.0.0]: https://github.com/mika-com/1C-Agent/releases/tag/v1.0.0
