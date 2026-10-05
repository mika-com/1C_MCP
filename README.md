# 1C Skills for goose

Порт набора навыков [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (автор — Nikolay Shirokov, MIT)
для AI-агента [goose](https://github.com/block/goose).

81 навык охватывает полный цикл разработки на платформе 1С:Предприятие 8.3 — от создания конфигураций,
расширений, внешних обработок и отчётов до загрузки изменений в информационную базу, публикации на
веб-сервере (portable Apache), тестирования через веб-клиент и записи видеоинструкций. Навыки дают модели
готовые абстракции над XML-форматами и CLI конфигуратора, а веб-тестирование — глаза и руки для работы
с интерфейсом 1С.

## Чем порт отличается от оригинала

| | cc-1c-skills (Claude Code) | Этот порт (goose) |
|---|---|---|
| Каталог навыков | `.claude/skills/` | `.agents/skills/` — стандартный каталог goose |
| Пути к скриптам | `${CLAUDE_SKILL_DIR}/scripts/...` | `.agents/skills/<навык>/scripts/...` от корня проекта (при глобальной установке — абсолютные) |
| `allowed-tools` | список инструментов Claude Code | удалён — в goose его нет |
| `disable-model-invocation` | запрет автовызова | goose его не поддерживает: в `description` добавлено «Вызывай только по явной просьбе пользователя» (`db-load-dt`, `form-decompile`, `form-remove`, `meta-decompile`, `skd-decompile`, `template-remove`) |
| `AskUserQuestion` | инструмент вопроса | «спроси пользователя» обычным сообщением |
| Хуки | `hooks/` (Claude Code) | плагин goose `goose/plugins/1c-support-guard/` (протокол Open Plugins) |
| Подсказки проекта | `CLAUDE.md` | `.goosehints` (образец — `goose/.goosehints`) |

Скрипты навыков (`.ps1`, `.py`, `.mjs`) не менялись — это те же файлы, что в upstream.

## Быстрый старт

### Вариант 1 — скопировать каталог

Скопируйте `.agents/skills/` из этого репозитория в корень своего 1С-проекта и запустите goose из этого
каталога:

```
МойПроект/
├── .agents/skills/    ← скопировать сюда
└── ...
```

### Вариант 2 — скрипт установки

```bash
git clone https://github.com/mika-com/1C_MCP_GOOSE.git tools/1c-goose

# В проект (PowerShell-рантайм, Windows)
python tools/1c-goose/scripts/goose_port.py install --project-dir .

# В проект с Python-рантаймом (Linux/Mac), плагином защиты поддержки и .goosehints
python tools/1c-goose/scripts/goose_port.py install --project-dir . --runtime python --hooks --hints

# Для пользователя: ~/.agents/skills/ (пути в SKILL.md станут абсолютными)
python tools/1c-goose/scripts/goose_port.py install --global

# Удалить
python tools/1c-goose/scripts/goose_port.py uninstall --project-dir .
```

Повторный `install` обновляет навыки до версии из репозитория.

### Использование

Просто опишите задачу своими словами — goose видит названия и описания всех навыков и сам загрузит
нужный (`load_skill`). Для точного контроля работают слеш-команды с именем навыка:

```
/epf-init МояОбработка
/skills meta-info form-info
```

Список навыков: `goose skills list` или `/skills` в сессии.

> **Важно:** goose запускает shell в рабочем каталоге сессии, а пути в SKILL.md указаны от корня проекта
> (`.agents/skills/...`). Запускайте goose из корня проекта, куда установлены навыки. При глобальной
> установке (`--global`) пути абсолютные, и это ограничение снимается.

## Рантайм: PowerShell ↔ Python

По умолчанию навыки вызывают скрипты через `powershell.exe` (основной вариант upstream, Windows).
На Linux/Mac или без PowerShell переключитесь на Python-порты:

```bash
python scripts/goose_port.py runtime python --project-dir /path/to/project
python scripts/goose_port.py runtime powershell --project-dir /path/to/project
```

Python 3.9+ и зависимости: `pip install -r requirements.txt` (`lxml`, `Pillow`, `psutil`).
Навык `img-grid` существует только в Python-версии и не переключается.

## Группы навыков

| Группа | Навыки | Описание | Гайд |
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

- **goose** с включённым встроенным расширением Skills (включено по умолчанию) и Developer (shell, файлы)
- **Windows** с PowerShell 5.1+ — рантайм по умолчанию; либо **Python 3.9+** — на любой ОС
- **1С:Предприятие 8.3** — для сборки/разборки EPF/ERF и работы с базами (навыки генерации XML работают без платформы)
- **Node.js 18+** — для `web-test` и плагина хуков. Перед первым запуском `web-test`:
  `cd .agents/skills/web-test/scripts && npm install && npx playwright install chromium`

## Защита конфигураций на поддержке (хуки goose, экспериментально)

Навыки-мутаторы сами не дают испортить объект типовой конфигурации на поддержке поставщика.
Плагин [`1c-support-guard`](goose/plugins/1c-support-guard/README.md) добавляет защиту от правки
**в обход навыков**: хук `PreToolUse` блокирует встроенные инструменты goose `write`/`edit`/`text_editor`
для объектов «на замке» и объясняет модели, как действовать (расширение или `support-edit`).
Ставится флагом `--hooks`. Хук подсказки навыков (`skill-suggester`) не портирован: хуки goose не умеют
добавлять текст в контекст модели.

## Обновление из upstream

Каталог `.agents/skills/` генерируется из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills).
Версия, из которой собран порт, записана в файле [`UPSTREAM`](UPSTREAM). Пересборка:

```bash
python scripts/goose_port.py build                          # git clone main во временный каталог
python scripts/goose_port.py build --upstream ../cc-1c-skills  # из локального клона
python scripts/goose_port.py build --ref <ветка-или-тег>
```

Сборка заменяет `${CLAUDE_SKILL_DIR}` путями `.agents/skills/...`, чистит frontmatter от полей Claude Code
и переписывает упоминания инструментов Claude. Правьте навыки в upstream, а не в `.agents/skills/` —
ручные правки перезапишутся при следующей сборке.

## Структура репозитория

```
.agents/skills/                 # 81 навык в формате goose (Agent Skills)
goose/
├── .goosehints                 # Образец подсказок проекта для goose
└── plugins/1c-support-guard/   # Плагин хуков: защита объектов на поддержке
    ├── plugin.json
    ├── hooks/hooks.json
    ├── scripts/                # support-guard.mjs + common/
    └── test/run.mjs
scripts/goose_port.py           # Сборка из upstream, установка, переключение рантайма
docs/                           # Гайды и спецификации форматов 1С (из upstream)
.v8-project.example.json        # Пример настроек проекта
.v8-xsd/                        # Каталог для XSD-схем платформы (v8-xsd-fetch)
UPSTREAM                        # Коммит cc-1c-skills, из которого собран порт
```

Спецификации форматов: **[сводный индекс](docs/1c-specs-index.md)**.

## Лицензия

MIT — см. [LICENSE](LICENSE). Навыки, скрипты и документация — © Nick Shirokov,
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills). Адаптация под goose распространяется
на тех же условиях.
