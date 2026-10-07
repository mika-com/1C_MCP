# 1C Skills for goose

Плагин для AI-агента [goose](https://github.com/block/goose): порт набора навыков
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (автор — Nikolay Shirokov, MIT).

81 навык охватывает полный цикл разработки на платформе 1С:Предприятие 8.3 — от создания конфигураций,
расширений, внешних обработок и отчётов до загрузки изменений в информационную базу, публикации на
веб-сервере (portable Apache), тестирования через веб-клиент и записи видеоинструкций. Навыки дают модели
готовые абстракции над XML-форматами и CLI конфигуратора, а веб-тестирование — глаза и руки для работы
с интерфейсом 1С.

> **Впервые работаете с goose?** Начните с пошаговой инструкции для goose Desktop (с окном):
> **[docs/quickstart.md](docs/quickstart.md)**.

## Установка

**goose Desktop (Windows):** скачайте ZIP этого репозитория (**Code → Download ZIP**), распакуйте
и дважды щёлкните **`install-windows.cmd`**. Установщик положит плагин в `%USERPROFILE%\.agents\plugins\1c`
и настроит `GOOSE_SHELL` (Git Bash) и таймаут команд. Затем перезапустите goose. Подробно —
в [docs/quickstart.md](docs/quickstart.md).

**goose CLI:**

```bash
goose plugin install https://github.com/mika-com/1C_MCP_GOOSE
# или с автообновлением:
goose plugin install --auto-update https://github.com/mika-com/1C_MCP_GOOSE
```

Плагин встаёт в `~/.agents/plugins/1c/` и доступен во всех проектах. Обновление — `goose plugin update 1c`.
Отключить — добавить `"1c"` в `disabledPlugins` в `~/.config/goose/settings.json`.

Плагин содержит:
- **82 навыка** — 81 из cc-1c-skills (`epf-init`, `meta-info`, …) и свой `bsl-check`. После `goose plugin install`
  goose добавляет к именам префикс плагина: `1c:epf-init`;
- **поиск по выгрузке** — MCP-сервер `search` ([`mcp/code-search.mjs`](mcp/code-search.mjs)): `find_object` (объект
  по смыслу — имени, синониму, реквизиту), `find_method` (метод сразу с кодом), `module_methods`, `find_usages`
  (кто вызывает), `search_code`. Заменяет `grep`/`sed` по XML: ответы короткие, контекст не раздувается.
  Индекс строится при первом запросе и кэшируется (выгрузка на 3,4 млн строк BSL — 5 с, повторно — 0,5 с);
- **проверка BSL-кода** — навык `bsl-check` и MCP-сервер `bsl` на базе
  [BSL Language Server](https://github.com/1c-syntax/bsl-language-server): ошибки в модулях до загрузки в базу,
  символы модуля, ссылки, граф вызовов, справка по типам платформы. BSL LS ставится установщиком отдельно
  (около 170 МБ, со встроенной Java); без него сервер `bsl` только подсказывает, как его поставить;
- **уточняющие вопросы формой** — MCP-сервер `ask` (`ask_user`): в goose Desktop прямо в чате, в CLI — в терминале.
  Аналог `AskUserQuestion` из Claude Code, работает через MCP Elicitation;
- **рецепты этапов работы** ([`goose/recipes/`](goose/recipes)): «1С: анализ и план доработки» → «доработка по плану» →
  «загрузка в базу» → «проверка в браузере». Каждый — новый чат с узкими инструкциями и параметрами;
- **хук `support-guard`** — защита объектов типовой конфигурации на поддержке от прямой правки
  (см. [hooks/README.md](hooks/README.md)).

MCP-серверы плагина написаны на Node.js без зависимостей — нужен Node.js 18+. Каждый чат запускает свой
экземпляр BSL LS (Java, около 300–500 МБ памяти). Если памяти мало, отключите сервер `bsl`
переменной окружения `BSL_LS_MCP=off` — навык `bsl-check` продолжит работать.

После установки — один раз для веба (Node.js 18+):

```bash
npm install --prefix "$HOME/.agents" --no-fund --no-audit "playwright@^1.50.0" && npx --prefix "$HOME/.agents" playwright install chromium
```

Модель выполнит эту команду сама, когда впервые понадобится `web-test`. Playwright ставится
в `~/.agents/node_modules`, поэтому `goose plugin update` его не стирает.

Python-рантайм (Linux/macOS или без PowerShell): `pip install -r requirements.txt` (`lxml`, `Pillow`, `psutil`).

### Использование

Запустите goose **из корня 1С-проекта** и опишите задачу своими словами — goose видит названия
и описания всех навыков и сам загрузит нужный. Для точного контроля работают слеш-команды:

```
/1c:epf-init МояОбработка
/skills 1c:meta-info 1c:form-info
```

Список навыков: `goose skills list` или `/skills` в сессии.

### Установка без плагина

Если нужны имена навыков без префикса, навыки внутри репозитория проекта (для всей команды) или
свой рантайм, поставьте навыки как обычные Agent Skills:

```bash
git clone https://github.com/mika-com/1C_MCP_GOOSE.git tools/1c-goose
python tools/1c-goose/scripts/goose_port.py install --project-dir . --hooks --hints   # в <проект>/.agents/skills/
python tools/1c-goose/scripts/goose_port.py install --global                          # в ~/.agents/skills/
python tools/1c-goose/scripts/goose_port.py runtime python --project-dir .            # жёстко Python
python tools/1c-goose/scripts/goose_port.py uninstall --project-dir .
```

Не ставьте одновременно плагин и навыки через `install` — получатся дубли (`1c:epf-init` и `epf-init`).

## Чем порт отличается от оригинала

| | cc-1c-skills (Claude Code) | Этот порт (goose) |
|---|---|---|
| Упаковка | плагин Claude Code, `.claude/skills/` | плагин goose (Open Plugins): `plugin.json`, `skills/`, `hooks/hooks.json` |
| Пути к скриптам | `${CLAUDE_SKILL_DIR}/scripts/...` подставляет Claude Code | `{SKILL_DIR}/scripts/...` — модель подставляет путь из `Skill directory:`, который goose выводит при загрузке навыка. Работает при любом месте установки |
| Рантайм | PowerShell или Python — разные сборки | одна сборка: команды на PowerShell, при отсутствии `powershell.exe` модель запускает одноимённый `.py` (параметры совпадают) |
| Корень проекта в скриптах `web-*`, `web-test` | 4–6 уровней вверх от скрипта | текущий каталог (навыки лежат вне проекта, в плагине) |
| Зависимости `web-test` | `node_modules` внутри навыка | `~/.agents/node_modules`: goose перечисляет модели все файлы навыка, и ~550 файлов `node_modules` раздули бы контекст |
| Фоновый `web-test start` | `run_in_background=true` | `nohup … &` в shell |
| `allowed-tools` | список инструментов Claude Code | удалён — в goose его нет |
| `disable-model-invocation` | запрет автовызова | goose его не поддерживает: в `description` добавлено «Вызывай только по явной просьбе пользователя» (`db-load-dt`, `form-decompile`, `form-remove`, `meta-decompile`, `skd-decompile`, `template-remove`) |
| `AskUserQuestion` | инструмент вопроса | инструмент `ask_user` плагина: форма через MCP Elicitation |
| Хук `support-guard` | опционально, вручную | в плагине включён; протокол goose (`{"decision":"block"}`) |
| Хук `skill-suggester` | опционально | не портирован: хуки goose не добавляют текст в контекст модели |
| Подсказки проекта | `CLAUDE.md` | `.goosehints` (образец — `goose/.goosehints`) |
| Поиск по выгрузке | `grep`/чтение файлов | MCP-сервер `search` с индексом объектов и методов |
| Проверка BSL-кода | — | навык `bsl-check` и MCP-сервер `bsl` (BSL Language Server) |
| Этапы работы | — | рецепты goose «1С: …» |

Все правки скриптов (10 файлов) делает `scripts/goose_port.py build` — точечные замены, отмеченные
комментарием `goose`. Остальные скрипты — те же, что в upstream.

## Настройка goose

Отдельный MCP-сервер не нужен: навыки работают через встроенные расширения goose — **Skills**
(загрузка навыков) и **Developer** (shell и файлы). Оба включены по умолчанию.

| Что | Зачем | Как |
|-----|-------|-----|
| `GOOSE_SHELL` = Git Bash (только Windows) | goose на Windows по умолчанию запускает команды через `cmd`, а в навыках синтаксис bash: heredoc, `&`, `until`. Claude Code на Windows работает через Git Bash, поэтому в оригинале это не было проблемой | `setx GOOSE_SHELL "C:\Program Files\Git\bin\bash.exe"` и перезапустить goose |
| `GOOSE_DEFAULT_EXTENSION_TIMEOUT` | Стандартный таймаут shell-команды — 300 с. `db-update`, загрузка/выгрузка, сборка и сценарии `web-test` на больших конфигурациях идут дольше | `setx GOOSE_DEFAULT_EXTENSION_TIMEOUT 3600` (модель может и сама передать `timeout_secs`, подсказка есть в `.goosehints`) |
| Режим подтверждений (`GOOSE_MODE`) | Навыки запускают много shell-команд. В `approve` / `smart_approve` goose спрашивает подтверждение на каждую | `auto` для доверенного проекта, иначе `smart_approve` |
| Модель | Навыки длинные (сотни строк инструкций и DSL), нужна модель с хорошим tool calling и контекстом от 128K | любая сильная модель провайдера goose |
| `.goosehints` | Подсказки проекта: сначала навык 1С, а не ручная правка XML; запуск из корня; таймауты | скопировать `goose/.goosehints` в корень проекта (или `install --hints`) |

### Нужна ли локальная база 1С

Зависит от навыка:

| Навыки | Что нужно |
|--------|-----------|
| Генерация и анализ XML: `epf-init`, `erf-init`, `meta-*`, `form-*`, `skd-*`, `mxl-*`, `role-*`, `cf-*`, `cfe-*`, `subsystem-*`, `interface-*`, `xdto-*`, `template-*`, `help-add`, `support-edit` | **Ничего**: ни платформы, ни базы. Работа только с файлами выгрузки |
| `epf-build` / `erf-build` / `epf-dump` / `erf-dump` | Установленная **платформа 1С 8.3** (`1cv8` или `ibcmd`). База не обязательна: без неё скрипт сам создаст и удалит временную файловую базу. С реальной базой сборка надёжнее, если обработка ссылается на объекты конфигурации |
| `db-*` | Платформа 1С и **информационная база**: файловая или на сервере 1С, локальная или сетевая. Её можно создать навыком `db-create` и зарегистрировать в `.v8-project.json` (`db-list`) |
| `web-publish` / `web-stop` / `web-info` / `web-unpublish` | Платформа 1С (модуль веб-расширения `wsap24`) и база; Apache скачивается автоматически (portable, Windows) |
| `web-test` | **URL опубликованной базы.** Это может быть локальная публикация (`web-publish`) или любой доступный веб-клиент 1С, указанный в `webUrl` в `.v8-project.json`. Плюс Node.js 18+ и Chromium |

### Работа с веб-клиентом (`web-test`)

Работает: навык управляет Chromium через Playwright, а goose запускает его скрипты через shell.
Проверено на goose 1.53: плагин установлен `goose plugin install`, `run.mjs run` из каталога плагина
открыл страницу и выполнил сценарий; после `goose plugin update` Playwright остался на месте.

1. Один раз поставить Playwright и Chromium (команда выше; модель сделает это сама).
2. Опубликовать базу (`/1c:web-publish <база>`) или прописать в `.v8-project.json` в записи базы
   `"webUrl": "http://сервер/база"` для уже опубликованной.
3. Просить своими словами: «открой в 1С список заказов и создай новый», «проверь отчёт по продажам
   за май», «запиши видеоинструкцию по созданию заказа».

Apache для `web-publish` ставится в `<проект>/tools/apache24`, видео и скриншоты `web-test` — относительно
корня проекта (текущего каталога goose).

## Группы навыков

| Группа | Навыки (с префиксом `1c:`) | Описание | Гайд |
|--------|--------|----------|------|
| Внешние обработки (EPF) | 6 навыков `epf-*` | Создание, сборка, разборка, валидация обработок из XML-исходников | [Подробнее](docs/epf-guide.md) |
| Внешние отчёты (ERF) | 4 навыка `erf-*` | Создание, сборка, разборка, валидация внешних отчётов | [Подробнее](docs/epf-guide.md#внешние-отчёты-erf) |
| Универсальные операции | `template-add`, `template-remove`, `help-add`, `form-remove` | Макеты, формы, справка для любых объектов | [Подробнее](docs/epf-guide.md#универсальные-навыки) |
| Табличный документ (MXL) | 4 навыка `mxl-*` | Анализ, создание, компиляция макетов печатных форм | [Подробнее](docs/mxl-guide.md) |
| Управляемые формы | 7 навыков `form-*` | Создание, анализ, генерация, модификация, валидация форм | [Подробнее](docs/form-guide.md) |
| Роли | 4 навыка `role-*` | Анализ прав, создание из JSON DSL, правка, валидация | [Подробнее](docs/role-guide.md) |
| Схема компоновки (СКД) | 5 навыков `skd-*` | Анализ, генерация из JSON DSL, точечное редактирование, валидация | [Подробнее](docs/skd-guide.md) |
| Метаданные конфигурации | 6 навыков `meta-*` | Создание, анализ, редактирование, удаление, валидация объектов (23 типа) | [Подробнее](docs/meta-guide.md) |
| Корневая конфигурация | 4 навыка `cf-*` | Создание, анализ, редактирование, валидация Configuration.xml | [Подробнее](docs/cf-guide.md) |
| Расширения (CFE) | 5 навыков `cfe-*` | Создание, заимствование, перехват методов, валидация, анализ | [Подробнее](docs/cfe-guide.md) |
| Подсистемы | 4 навыка `subsystem-*` | Анализ, создание, редактирование, валидация подсистем | [Подробнее](docs/subsystem-guide.md) |
| Командный интерфейс | 2 навыка `interface-*` | Редактирование и валидация CommandInterface.xml | [Подробнее](docs/subsystem-guide.md) |
| Пакеты XDTO | 5 навыков `xdto-*` | Анализ, создание из XML-схемы, выгрузка, правка, валидация | [Подробнее](docs/xdto-guide.md) |
| Поддержка поставщика | `support-edit` | Управление состоянием поддержки объектов типовой конфигурации | [Подробнее](docs/v8-project-guide.md) |
| Базы данных | 13 навыков `db-*` | Создание баз, загрузка/выгрузка, обновление БД, Git, хранилище, расширения в базе | [Подробнее](docs/db-guide.md) |
| Веб-публикация | 4 навыка `web-*` | Публикация баз через Apache, статус, остановка, удаление | [Подробнее](docs/web-guide.md) |
| Тестирование | `web-test` | Веб-клиент 1С: навигация, формы, таблицы, отчёты, регресс, запись видео | [Подробнее](docs/web-test-guide.md) |
| Утилиты | `img-grid`, `v8-xsd-fetch` | Сетка на изображении; загрузка XSD-схем платформы | [Подробнее](docs/v8-project-guide.md#xsdpath--xsd-схемы-платформы) |

Настройки проекта (платформа, базы, привязка к веткам Git) — в `.v8-project.json`,
см. [гайд](docs/v8-project-guide.md) и [пример](.v8-project.example.json).

## Требования

- **goose** со встроенными расширениями Skills и Developer (включены по умолчанию); на Windows — Git Bash
  (см. «Настройка goose»)
- **Windows** с PowerShell 5.1+, либо **Python 3.9+** — на любой ОС
- **1С:Предприятие 8.3** — для сборки/разборки EPF/ERF и работы с базами (навыки генерации XML работают без платформы)
- **Node.js 18+** — для MCP-серверов плагина (вопросы, поиск, BSL LS), `web-test` и хука `support-guard`
- **BSL Language Server** — для проверки кода (`bsl-check`, сервер `bsl`); ставится `install-windows.cmd`
  или `node skills/bsl-check/scripts/bsl-check.mjs -Install`

## Обновление из upstream

Каталог `skills/` генерируется из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills).
Версия, из которой собран порт, записана в файле [`UPSTREAM`](UPSTREAM). Пересборка:

```bash
python scripts/goose_port.py build                             # git clone main во временный каталог
python scripts/goose_port.py build --upstream ../cc-1c-skills  # из локального клона
python scripts/goose_port.py build --ref <ветка-или-тег>
```

Правьте навыки в upstream или в `scripts/goose_port.py`, а не в `skills/` — ручные правки перезапишутся
при следующей сборке. Собственные навыки порта лежат в `goose/skills/` и копируются в `skills/` при сборке.
После пересборки поднимите `version` в `plugin.json`.

**Автоматически:** GitHub Action [`upstream-sync`](.github/workflows/upstream-sync.yml) раз в неделю
пересобирает порт из свежего cc-1c-skills и, если есть изменения, открывает PR (ветка `auto/upstream-sync`,
версия плагина +1). Запустить вручную — Actions → «Синхронизация с cc-1c-skills» → Run workflow. Чтобы
Action мог создавать PR, включите Settings → Actions → General → «Allow GitHub Actions to create and approve
pull requests».

## Структура репозитория

```
plugin.json                 # Манифест плагина goose (Open Plugins), имя «1c»; MCP-сервер ask_user
install-windows.cmd         # Установщик для Windows (goose Desktop/CLI): плагин + GOOSE_SHELL + таймаут
skills/                     # 82 навыка (Agent Skills): 81 из upstream + свои из goose/skills
mcp/code-search.mjs         # MCP-сервер search: поиск объектов, методов, вызовов по выгрузке
mcp/bsl-ls.mjs              # MCP-сервер bsl: запуск BSL Language Server (или подсказка, если не установлен)
mcp/lib/stdio-server.mjs    # Общий минимальный MCP-сервер на stdio
mcp/ask-user.mjs            # Форма уточняющих вопросов (MCP Elicitation), без зависимостей
hooks/
├── hooks.json              # PreToolUse → support-guard
├── support-guard.mjs       # + common/
└── test/run.mjs
goose/.goosehints           # Образец подсказок проекта для goose
goose/skills/bsl-check/     # Свой навык: проверка BSL-кода через BSL LS (+ поиск/установка BSL LS)
goose/recipes/              # Рецепты goose: анализ → доработка → загрузка → проверка в браузере
.github/workflows/upstream-sync.yml  # Еженедельная синхронизация с cc-1c-skills
scripts/goose_port.py       # Сборка из upstream, установка без плагина, переключение рантайма
scripts/install-windows.ps1 # Логика установщика install-windows.cmd
scripts/analyze_session.py  # Разбор сеанса goose: токены, навыки, повторы, ошибки, рекомендации
docs/                       # Гайды и спецификации форматов 1С (из upstream)
.v8-project.example.json    # Пример настроек проекта
.v8-xsd/                    # Каталог для XSD-схем платформы (v8-xsd-fetch)
UPSTREAM                    # Коммит cc-1c-skills, из которого собран порт
```

Спецификации форматов: **[сводный индекс](docs/1c-specs-index.md)**.

## Лицензия

MIT — см. [LICENSE](LICENSE). Навыки, скрипты и документация — © Nick Shirokov,
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills). Адаптация под goose распространяется
на тех же условиях.
