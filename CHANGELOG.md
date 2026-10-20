# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Добавлено
- Установщик (`register-opencode-mcp.mjs`, его вызывают `opencode_port.py install` и `install.ps1`) прописывает
  `"default_agent": "1c"` в `~/.config/opencode/opencode.json`, только если `default_agent` ещё не задан;
  удаление убирает его, только если он равен `"1c"`. Отключить при ручной регистрации — `--no-default-agent`.
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
- `1c-search`: таймаут вызова в конфиге OpenCode — `execution: 120000`; `index_status` показывает состояние
  семантического индекса. Без LM Studio поведение прежнее, `semantic_search` отвечает по ключевым словам с `[!]`.

### Исправлено
- Qwen3-Embedding в LM Studio: к каждому входу эмбеддингов (фрагменты и запросы) дописывается `<|endoftext|>` —
  модель берёт вектор последнего токена, а GGUF без `tokenizer.ggml.add_eos_token` (например,
  `majentik/text-embedding-qwen3-embedding-4b`) его не добавляют; в логе LM Studio было
  «At least one last token in strings embedded is not SEP». Настройка `appendEos` (`SEMANTIC_EMBED_APPEND_EOS`,
  `auto` — для моделей `qwen3-embedding`, `true`/`false`) и `eosToken` (`SEMANTIC_EMBED_EOS_TOKEN`); без повторного
  добавления, усечение — до токена. Учтено в наборе векторов и хэше фрагментов: **после обновления индекс
  перестраивается автоматически** (или `node mcp/code-search.mjs --semantic-build --root <проект>`), старые векторы
  не используются. `semantic_index` и `check-lmstudio.ps1` (`-AppendEos`) показывают настройку.

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
