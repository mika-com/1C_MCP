# 1C-Agent — агент 1С для OpenCode v2

Агент для разработки на 1С:Предприятие 8.3 в [OpenCode](https://opencode.ai/v2/docs) (Desktop и CLI):

- **86 навыков**: 81 из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (конфигурации, расширения,
  EPF/ERF, формы, СКД, макеты, роли, XDTO, базы, веб-публикация, web-test) + свои `bsl-check`, `vrunner`, `1c-test` (стратегия тестирования, preflight, шаблоны Vanessa), `print-form`
  (печатные формы «сначала макет» с PNG-предпросмотром макета) и `db-install-agentquery` (расширение чтения `query_db`);
- **9 агентов**: основной `1c`, субагенты по этапам `1c-analyst` → `1c-developer` → `1c-deployer` → `1c-tester` (+ `1c-test-author`),
  и профильные субагенты `1c-explorer` (разведка кода и расширений CFE), `1c-debugger` (расследование ошибок и ЖР `event_log`),
  `1c-query-expert` (разработка, валидация `validate_query` и оптимизация запросов 1С);
- **9 команд**: `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`, `/1c-explore`, `/1c-debug`, `/1c-query`;
- **MCP-серверы**: `1c-search` (поиск по XML-выгрузке), `1c-bsl` (BSL Language Server), `1c-help` (синтакс-помощник
  по справке установленной платформы 1С),
  `vrunner` ([vanessa-runner 3.x](https://github.com/vanessa-opensource/vanessa-runner), `vrunner-mcp`, по умолчанию выключен).

## Модель

Flash и бесплатные модели на длинных задачах 1С работают плохо: выдумывают API платформы, обходят запреты
(COM, клики по диалогам) и раздувают контекст. Для агентов `1c` и `1c-developer` в frontmatter есть
закомментированный пример `model:` — раскомментируйте и подставьте сильную модель своего провайдера, если в
OpenCode по умолчанию выбрана слабая. Конкретная модель в репозитории не задана: она зависит от аккаунта.

## Быстрый старт

### Windows одной командой

1. Скачайте проект: ZIP-архив с GitHub (Code → Download ZIP, распакуйте) или
   `git clone https://github.com/mika-com/1C_MCP.git`.
2. Откройте папку проекта и дважды щёлкните **`install.cmd`**. Можно запустить и из PowerShell в этой папке:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Права администратора не нужны. Только winget может один раз запросить UAC, когда ставит Node.js, Python или Java.
Скрипт берёт навыки из своей папки, поэтому **не удаляйте и не переносите её**: MCP-серверы и плагин `bsl-autocheck` запускаются оттуда.
Порядок работы:
- ставит через winget недостающие Git, Node.js LTS (20+), Python 3 и Java 17+;
- ставит навыки, агентов и команды глобально в `%USERPROFILE%\.config\opencode`;
- регистрирует там MCP и плагин `bsl-autocheck` (проверка BSL после каждой правки);
- скачивает BSL Language Server, а также Playwright и Chromium для `web-test`.

Повторный запуск безопасен. Для обновления выполните `git pull` или распакуйте новый ZIP в ту же папку и запустите
скрипт снова.

| Параметр | Что делает |
|----------|------------|
| `-Project D:\1c\проект` | установить в проект (`<проект>\.opencode`) вместо глобальной установки |
| `-WithVrunner` | включить MCP `vrunner` |
| `-WithDesktop` | поставить OpenCode Desktop (`winget SST.OpenCodeDesktop`) |
| `-NoBslLs` | без BSL LS и Java (и без плагина `bsl-autocheck`) |
| `-NoBrowser` | без Playwright/Chromium |
| `-Uninstall` | удалить навыки, агентов, команды, плагин и MCP (с `-Project` — из проекта) |
| `-Machine [-Users N]` | (администратор) общие инструменты и копия репозитория в `C:\ProgramData\1c-opencode` для всех пользователей сервера; см. [Несколько пользователей (RDP)](docs/quickstart.md#несколько-пользователей-rdp) |

Параметры передаются и через `install.cmd`, например `install.cmd -Project D:\1c\проект -WithVrunner`.

### Вручную (любая ОС)

```bash
git clone https://github.com/mika-com/1C_MCP.git
cd 1C_MCP
python scripts/opencode_port.py install --project-dir /путь/к/1С-проекту
```

Откройте проект в OpenCode Desktop: агент **1c** будет выбран по умолчанию (установщик прописывает
`"default_agent": "1c"` в `~/.config/opencode/opencode.json`, только если там ещё не задан свой агент по умолчанию). Подробно — [docs/quickstart.md](docs/quickstart.md).

| Требование | Зачем |
|------------|-------|
| OpenCode 2.x | агентная среда |
| Python 3.9+ | скрипты навыков, установщик (`pip install -r requirements.txt` для рантайма python) |
| Node.js 18+ | MCP-серверы, `web-test` |
| 1С:Предприятие 8.3 | сборка, выгрузка, загрузка, веб-публикация |
| BSL Language Server | `bsl-check`, `1c-bsl` (`node skills/bsl-check/scripts/bsl-check.mjs -Install`) |
| vanessa-runner 3.x | необязательно: навык и MCP `vrunner` (`opm install vanessa-runner`) |

## Как пользоваться

```text
/1c-explore где проверяется лимит задолженности в заказе клиента и какие расширения его перехватывают
/1c-debug почему не проводится заказ клиента в базе dev
/1c-query запрос остатков и резервов товаров по складам с параметрами виртуальной таблицы
/1c-analyze Добавить в документ ЗаказКлиента реквизит «Приоритет» и вывести его в список
/1c-implement <вставьте план>
/1c-check src/cfe/МоёРасширение
/1c-deploy в базу dev
/1c-webtest создать заказ клиента и провести
/1c-bdd сценарий создания заказа клиента
```

Или обычным языком агенту `1c`: «найди, где формируется номер заказа», «создай внешнюю обработку ЗагрузкаЦен».
Навык можно вызвать явно: `@epf-init`, `@meta-info`.

Базы, платформа и веб-клиент описываются в `.v8-project.json` (пример — [.v8-project.example.json](.v8-project.example.json)).
Если в проекте есть `autumn-properties.json`, агент использует vanessa-runner.

## Тестирование

| Что | Как | Отчёты |
|-----|-----|--------|
| Проверка в веб-клиенте | `/1c-webtest <что проверить>` — preflight (Playwright, Chromium, дисплей, доступность `webUrl`), затем `web-test` | `build/reports/web/` (`allure/`, `junit.xml`, скриншоты, видео) |
| Регресс по веб-клиенту | агент `1c-test-author` пишет `tests/web/` по `regress.md`, `1c-tester` прогоняет | `build/reports/web/` |
| BDD (Vanessa Automation) | `/1c-bdd <сценарий>` — `features/*.feature` на русском Gherkin, запуск через `vrunner run enterprise` с `tools/vanessa/VAParams.json` | `build/reports/va/` |
| Модульные тесты | YAxUnit: `vrunner test yaxunit` | `build/reports/yaxunit.xml` |

Как выбрать инструмент — навык [`1c-test`](skills/1c-test/SKILL.md) и [docs/testing-guide.md](docs/testing-guide.md).

> **Vanessa Automation ≠ Vanessa-ADD.** `vrunner test vanessa` в vanessa-runner 3.x запускает Vanessa-ADD
> (`bddRunner.epf`, VBParams). Vanessa Automation (`vanessa-automation.epf`, VAParams) запускается через
> `vrunner run enterprise`, а результат читается из `build/reports/va/status.log` и `junit/`. Файл
> `vanessa-automation.epf` скачивается отдельно в `tools/vanessa/`.

Права: `1c-tester` пишет только в `tests/**` и
`build/reports/**`, `1c-test-author` — в `tests/**`, `features/**`, `tools/vanessa/**`, `build/reports/**`.

## Печатные формы

Агенты делают печатную форму **через макет**, а не программным построением таблицы: навык
[`print-form`](skills/print-form/SKILL.md) ведёт путь «вопросы → `template-add` → JSON DSL → `mxl-compile` →
`mxl-validate` → предпросмотр PNG (`mxl-render`) → модуль заполнения по эталону» (области, `Параметры.Заполнить`,
`ПроверитьВывод` с повтором шапки таблицы, итоги, `ЧислоПрописью`) для внешней печатной формы БСП, документа с БСП
и без. Существующий макет правится через `mxl-decompile` → JSON → `mxl-compile`. Предпросмотр:

```bash
python3 skills/print-form/scripts/mxl-render.py <...>/Templates/<Макет>/Ext/Template.xml --png build/reports/print/<Макет>.png
```

Для PNG нужен Playwright с Chromium (тот же, что у `web-test`). Подробнее — [docs/mxl-guide.md](docs/mxl-guide.md).

## MCP-серверы

| Сервер | Что даёт | По умолчанию |
|--------|----------|--------------|
| `1c-search` | `semantic_search` (по смыслу, гибрид с ключевыми словами и реранкером; без LM Studio — ключевые слова), `semantic_index`, `find_object(query)`, `object_refs(object)` (граф связей объекта: типы, движения по регистрам, ввод на основании, подписки, ФО, расширения CFE, where-used), `find_method(name, object)` (с перехватчиками CFE), `module_methods(module)`, `find_usages(name, object)` (вызовы + подписки, регл. задания, сервисы, `Form.xml`, CFE), `search_code(pattern)`, `validate_query(query)` (статический валидатор запросов 1С по метаданным), `query_db(database, query)` (чтение базы, только `ВЫБРАТЬ`, лимит и таймаут обязательны, `readOnlyHint`), `event_log(database)` (чтение ЖР `.lgd`/`.lgp` с маппингом стека на `.bsl`), `index_status` | включён |
| `1c-bsl` | BSL LS в режиме MCP (`analyze_file`, `document_symbols`, …); без BSL LS — заглушка с подсказкой | включён |
| `1c-help` | синтакс-помощник: `help_search`, `help_get` (синтаксис, параметры, возврат, доступность, версия, примеры), `help_members`, `help_status` — по справке **установленной** платформы | включён |
| `vrunner` | команды vanessa-runner 3.x (`vrunner-mcp`) | `disabled: true`, включить: `node mcp/register-opencode-mcp.mjs --vrunner` |

Формат OpenCode v2: `mcp.servers`, `disabled`, таймауты в миллисекундах (`startup` 10 с / 30 с для BSL LS).

**Семантический поиск `semantic_search`.** «Где реализовано X», когда имя метода неизвестно. Фрагменты — процедуры и
функции (с комментарием и директивами) и объекты метаданных; векторы считает локальный LM Studio
(`Qwen3-Embedding-4B`, `/v1/embeddings`), результат смешивается с поиском по ключевым словам (RRF) и
переранжируется `Qwen3-Reranker-4B` (logprobs «yes/no» из `/v1/responses` LM Studio или `/v1/rerank`). Хранилище
векторов — `%LOCALAPPDATA%\1c-opencode\semantic` (общее для сервера — `SEMANTIC_STORE_DIR`), обновляется
по изменённым файлам, один построитель на хранилище, атомарная запись. Без LM Studio — поиск по ключевым словам и
строка `[!]` с причиной. Настройка LM Studio по шагам (модели, Domain Type, шаблон реранкера, две GPU) —
[docs/semantic-search.md](docs/semantic-search.md); включить: `install.cmd -Project <папка> -WithSemantic`,
проверить: `scripts\check-lmstudio.ps1`.

**Синтакс-помощник `1c-help`.** Справка 1С в репозиторий не входит и не распространяется: сервер читает файлы
`shcntx_ru.hbk`, `shlang_ru.hbk`, `shquery_ru.hbk` из каталога `bin` платформы, установленной у пользователя.
Платформа: `V8_HELP_PATH` (каталог `bin` или файл `.hbk`) → `v8path` из `.v8-project.json` → самая новая из
`%ProgramFiles%\1cv8\<версия>\bin` (Linux: `/opt/1cv8/x86_64/<версия>`). Язык — `V8_HELP_LANG` (`ru`, `en` →
`*_root.hbk`). Индекс оглавления строится при первом вызове в отдельном процессе (таймаут `HELP_BUILD_TIMEOUT_MS`,
120 с) и хранится у пользователя: `%LOCALAPPDATA%\1c-opencode\help-cache\<версия>-<язык>.json`
(Linux/macOS: `~/.cache/1c-opencode/help-cache`). Агенты `1c` и `1c-developer` проверяют через него незнакомые
методы и свойства платформы, а не придумывают их. Парсер `.hbk` свой, без зависимостей
([`mcp/lib/hbk.mjs`](mcp/lib/hbk.mjs)).

**Чтение базы — `query_db`.** Инструмент MCP `1c-search`. В аргументе `database` — `id` из `.v8-project.json`,
в `query` — только `ВЫБРАТЬ`. Текст сначала проходит `validate_query`. Лимит строк (по умолчанию 100, потолок 500)
и таймаут (по умолчанию 30 с, потолок 120 с) не отключаются. Запрос уходит HTTP-сервису `AgentQuery`
опубликованной базы (`queryUrl` или `webUrl` + `/hs/agentquery/query`, модуль
[`mcp/query-db/AgentQuery.bsl`](mcp/query-db/AgentQuery.bsl)). Пароль берётся из записи базы и передаётся
заголовком `Authorization` внутри процесса MCP: в ответе и в командной строке его нет, дочерний процесс не
запускается. COM, интерактивный `1cv8` и `ibcmd --password` для выборки не используются. Пока сервис не
опубликован навыком `db-*`, инструмент отказывается и обход не предлагает. Как проверить на живой базе —
[docs/db-guide.md](docs/db-guide.md#чтение-данных-query_db). У инструмента в каталоге MCP стоит `readOnlyHint`.

**Запрет опасных команд — плагин [`shell-guard`](plugins/shell-guard.mjs).** OpenCode v2 вызывает его на
`tool.execute.before` (вызов прерывается) и на `shell.create.before` (команда подменяется отказом, потому что
хук оболочки сам запуск не отменяет). Блокируется COM-коннектор и COM-приложение любой версии (`V82`…`V85` и
дальше), регистрация `comcntr`, интерактивный `1cv8` (в том числе `ENTERPRISE` и свой `/Execute`) и загрузка или
обновление конфигурации и расширений в базу вне скриптов навыков `db-*` (`/LoadConfigFromFiles`, `/UpdateDBCfg`,
`ibcmd config load|import|apply`). Свой `.ps1`/`.py` и `powershell -EncodedCommand` проверяются так же. Навыки
`skills/<имя>/scripts/` остаются пакетным путём. Снять запрет: `"shellGuard": { "enabled": false }` в
`.v8-project.json` или `V8_SHELL_GUARD=0` (переменная важнее файла). Установщик кладёт переходник рядом с
`bsl-autocheck`; `--no-autocheck` его не убирает.

**Проверка BSL после каждой правки — плагин [`bsl-autocheck`](plugins/bsl-autocheck.mjs).** OpenCode v2 языковые
серверы (секция `lsp`) не запускает, поэтому LSP из проекта убран (установщик удаляет старую запись `lsp.bsl` из
конфига). Вместо него плагин OpenCode v2 (хук `tool.hook("execute.after")`) после `edit` / `write` / `patch` файла
`.bsl`/`.os` запускает `bsl-language-server analyze` только по изменённым файлам и дописывает к результату
инструмента до 20 строк замечаний — сначала ошибки, затем предупреждения. Модель видит их в том же шаге и исправляет.
Параллельные правки проверяются одним запуском, таймаут 30 с (дерево процессов BSL LS гасится), файлы больше 1 МБ
пропускаются, нет BSL LS — одна подсказка за сеанс. Процессы и временные файлы — свои у каждого пользователя (RDP).
Установка: `install.ps1` / `opencode_port.py install` кладут переходник `plugins/bsl-autocheck.js` в
`~/.config/opencode/plugins/` или `<проект>/.opencode/plugins/` (`--no-autocheck` — не ставить).
При загрузке плагин пишет отметку версии в кэш пользователя (`bsl-autocheck.json`). MCP `1c-search` в
`initialize` и в `index_status` печатает версию из файла `VERSION` и говорит, активен ли плагин этой сборки:
нет отметки или чужая версия — установка устарела, после правки `.bsl` строки `[bsl-autocheck]` не будет.
Тот же плагин на `shell.create.before` (и на `tool.execute.before`, если у вызова указана оболочка) выставляет
UTF-8 для PowerShell и `cmd` и `PYTHONIOENCODING`/`PYTHONUTF8` для Python: Windows PowerShell 5.1 иначе пишет
кириллицу в cp866. Контракт хука сверен с документацией OpenCode v2; в живом сеансе OpenCode он не прогонялся.

| Настройка | Переменная среды | `.v8-project.json` → `bslAutocheck` | По умолчанию |
|-----------|------------------|-------------------------------------|--------------|
| выключить | `BSL_AUTOCHECK=0` | `"enabled": false` | включено |
| порог | `BSL_AUTOCHECK_SEVERITY` | `"severity"` (`Error`, `Warning`, `Information`, `Hint`) | `Warning` |
| таймаут, мс | `BSL_AUTOCHECK_TIMEOUT_MS` | `"timeoutMs"` | 30000 |
| строк замечаний | `BSL_AUTOCHECK_LIMIT` | `"limit"` | 20 |
| размер файла, КБ | `BSL_AUTOCHECK_MAX_KB` | `"maxKb"` | 1024 |

Автопроверка не заменяет проверку каталога перед загрузкой в базу — её делает навык `bsl-check`.
Уточняющие вопросы агент задаёт встроенным инструментом OpenCode `question`.

## Структура

| Путь | Что |
|------|-----|
| `.opencode/agents/` | агенты OpenCode v2 (Markdown + frontmatter) |
| `.opencode/commands/` | команды `/1c-*` |
| `skills/` | 86 навыков: 81 из `cc-1c-skills` + собственные (`bsl-check`, `vrunner`, `1c-test`, `print-form`, `db-install-agentquery`) |
| `mcp/` | MCP-серверы и `register-opencode-mcp.mjs` (пишет `mcp.servers`, удаляет старую запись `lsp.bsl`) |
| `plugins/` | плагины OpenCode v2: `bsl-autocheck.mjs` (проверка BSL после правки) и `shell-guard.mjs` (запрет COM, интерактивного `1cv8`, загрузки в базу вне `db-*`, пароля в команде и чтения секретов). Переходники — `.opencode/plugins/*.js` |
| `opencode.json` | конфиг v2 для работы в самом репозитории (`skills`, `mcp.servers`, `default_agent`) |
| `templates/AGENTS.md` | шаблон инструкций для 1С-проекта |
| `install.ps1`, `install.cmd` | установка на Windows одной командой из папки проекта |
| `scripts/kill-bsl-ls.mjs`, `scripts/kill-bsl-ls.ps1` | завершить зависшие процессы BSL LS ([зависания на больших проектах](docs/quickstart.md#зависания-и-процессы-bsl-ls-на-больших-конфигурациях)) |
| `tests/mcp/run.mjs`, `tests/mcp/multiuser.mjs` | тесты прокси `1c-bsl` (дерево процессов, таймаут, область индексации) и многопользовательской безопасности |
| `tests/plugins/bsl-autocheck.mjs` | тесты плагина на поддельном BSL LS (пачки, таймаут, вывод, нет BSL LS) и миграции `lsp.bsl` |
| `tests/plugins/shell-guard.mjs` | тесты запрета COM, интерактивного `1cv8` и загрузки конфигурации, включая отключение в `.v8-project.json` |
| `tests/mcp/query-db.mjs` | тесты `query_db` на подставном HTTP (лимит, таймаут, `validate_query`, пароль не в ответе и не в URL, `action: status`) |
| `tests/mcp/odata-get.mjs` | тесты `odata_get`: только GET, лимит, пароль не в URL и не в ответе |
| `tests/skills/agentquery-extension.mjs` | состав расширения AgentQuery и подстановка языка базы без запуска платформы |
| `tests/agents/permissions.mjs` | права агентов OpenCode v2: последнее совпадение, секреты закрыты, загрузку делает deployer |
| `tests/mcp/help.mjs` | тесты `1c-help` на синтетических `.hbk` (`tests/mcp/lib/make-hbk.mjs`, без содержимого справки 1С) |
| `tests/mcp/power1c.mjs` | тесты графа метаданных (`object_refs`, `find_method`, `find_usages`), статического валидатора запросов (`validate_query`) и чтения ЖР (`event_log`) |
| `tests/web-test/session.mjs` | тесты сеанса `web-test` на поддельном браузере: `open` → много `exec` в одном браузере, сеанс переживает конец вызова shell, токен, простой, смена адреса |
| `scripts/opencode_port.py` | сборка из upstream и установка; ядро — `scripts/port_core.py` |
| `docs/` | руководства: [quickstart](docs/quickstart.md), [семантический поиск](docs/semantic-search.md), [тестирование](docs/testing-guide.md), [.v8-project.json](docs/v8-project-guide.md), [web-test](docs/web-test-guide.md), [mxl](docs/mxl-guide.md) и гайды по объектам 1С |

## Обновление из upstream

```bash
python scripts/opencode_port.py build                         # git clone cc-1c-skills main
python scripts/opencode_port.py build --upstream ../cc-1c-skills
```

[`UPSTREAM`](UPSTREAM) хранит коммит сборки (сейчас cc-1c-skills `b102d9d`). Собственные навыки в `skills/` сохраняются,
адаптация под OpenCode — в `scripts/port_core.py`.

GitHub Action [`upstream-sync`](.github/workflows/upstream-sync.yml) раз в неделю (понедельник, 05:17 UTC) или вручную
выполняет `python scripts/opencode_port.py build` и, если `skills/` или `UPSTREAM` изменились, открывает PR из ветки
`auto/upstream-sync`. Для создания PR включите в настройках репозитория «Allow GitHub Actions to create and approve
pull requests».

## Лицензия

MIT — см. [LICENSE](LICENSE) и [NOTICE.md](NOTICE.md). Навыки в `skills/` (кроме собственных `bsl-check`, `vrunner`,
`1c-test`, `print-form`) и большая часть `docs/` основаны на [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills)
Nick Shirokov (MIT); его copyright сохранён в LICENSE. Внешние инструменты (BSL Language Server, vanessa-runner,
Vanessa Automation, Playwright) в репозиторий не входят — ставятся отдельно, лицензии перечислены в NOTICE.md.

История изменений — [CHANGELOG.md](CHANGELOG.md).
