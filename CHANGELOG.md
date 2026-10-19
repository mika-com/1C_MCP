# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Добавлено
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
- В README, быстром старте и frontmatter `1c` / `1c-developer` — рекомендация сильной модели. `model:` закомментирован
  и не привязан к конкретному идентификатору: flash и бесплатные модели на длинных задачах 1С работают плохо.
- `1c-search`: таймаут вызова в конфиге OpenCode — `execution: 120000`; `index_status` показывает состояние
  семантического индекса и версию агента. Без LM Studio поведение прежнее, `semantic_search` отвечает по ключевым словам с `[!]`.

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
