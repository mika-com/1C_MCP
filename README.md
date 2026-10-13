# Агент 1С для OpenCode v2

Агент для разработки на 1С:Предприятие 8.3 в [OpenCode](https://opencode.ai/v2/docs) (Desktop и CLI):

- **85 навыков**: 81 из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (конфигурации, расширения,
  EPF/ERF, формы, СКД, макеты, роли, XDTO, базы, веб-публикация, web-test) + свои `bsl-check`, `vrunner`, `1c-test` (стратегия тестирования, preflight, шаблоны Vanessa) и `print-form`
  (печатные формы «сначала макет» с PNG-предпросмотром макета);
- **6 агентов**: основной `1c` и субагенты по этапам `1c-analyst` → `1c-developer` → `1c-deployer` → `1c-tester`,
  плюс `1c-test-author` (пишет регресс web-test и BDD-сценарии);
- **6 команд**: `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`;
- **MCP-серверы**: `1c-search` (поиск по XML-выгрузке), `1c-bsl` (BSL Language Server),
  `vrunner` ([vanessa-runner 3.x](https://github.com/vanessa-opensource/vanessa-runner), `vrunner-mcp`, по умолчанию выключен).

## Быстрый старт

### Windows одной командой

1. Скачайте проект: ZIP-архив с GitHub (Code → Download ZIP, распакуйте) или
   `git clone -b cleanup/opencode-v2 https://github.com/mika-com/1C_MCP_GOOSE.git`.
2. Откройте папку проекта и дважды щёлкните **`install.cmd`**. Можно запустить и из PowerShell в этой папке:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Права администратора не нужны. Только winget может один раз запросить UAC, когда ставит Node.js, Python или Java.
Скрипт берёт навыки из своей папки, поэтому **не удаляйте и не переносите её**: MCP-серверы и LSP запускаются оттуда.
Порядок работы:
- ставит через winget недостающие Git, Node.js LTS (20+), Python 3 и Java 17+;
- ставит навыки, агентов и команды глобально в `%USERPROFILE%\.config\opencode`;
- регистрирует там MCP и LSP;
- скачивает BSL Language Server, а также Playwright и Chromium для `web-test`.

Повторный запуск безопасен. Для обновления выполните `git pull` или распакуйте новый ZIP в ту же папку и запустите
скрипт снова.

| Параметр | Что делает |
|----------|------------|
| `-Project D:\1c\проект` | установить в проект (`<проект>\.opencode`) вместо глобальной установки |
| `-WithVrunner` | включить MCP `vrunner` |
| `-WithDesktop` | поставить OpenCode Desktop (`winget SST.OpenCodeDesktop`) |
| `-NoBslLs` | без BSL LS и Java (и без LSP `bsl`) |
| `-NoBrowser` | без Playwright/Chromium |
| `-Uninstall` | удалить навыки, агентов, команды и MCP/LSP (с `-Project` — из проекта) |

Параметры передаются и через `install.cmd`, например `install.cmd -Project D:\1c\проект -WithVrunner`.

### Вручную (любая ОС)

```bash
git clone https://github.com/mika-com/1C_MCP_GOOSE.git
cd 1C_MCP_GOOSE
python scripts/opencode_port.py install --project-dir /путь/к/1С-проекту
```

Откройте проект в OpenCode Desktop и выберите агента **1c**. Подробно — [docs/quickstart.md](docs/quickstart.md).

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

Как выбрать инструмент — навык [`1c-test`](own-skills/1c-test/SKILL.md) и [docs/testing-guide.md](docs/testing-guide.md).

> **Vanessa Automation ≠ Vanessa-ADD.** `vrunner test vanessa` в vanessa-runner 3.x запускает Vanessa-ADD
> (`bddRunner.epf`, VBParams). Vanessa Automation (`vanessa-automation.epf`, VAParams) запускается через
> `vrunner run enterprise`, а результат читается из `build/reports/va/status.log` и `junit/`. Файл
> `vanessa-automation.epf` скачивается отдельно в `tools/vanessa/`.

Права: `1c-tester` пишет только в `tests/**` и
`build/reports/**`, `1c-test-author` — в `tests/**`, `features/**`, `tools/vanessa/**`, `build/reports/**`.

## Печатные формы

Агенты делают печатную форму **через макет**, а не программным построением таблицы: навык
[`print-form`](own-skills/print-form/SKILL.md) ведёт путь «вопросы → `template-add` → JSON DSL → `mxl-compile` →
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
| `1c-search` | `find_object`, `find_method`, `module_methods`, `find_usages`, `search_code`, `index_status` | включён |
| `1c-bsl` | BSL LS в режиме MCP (`analyze_file`, `document_symbols`, …); без BSL LS — заглушка с подсказкой | включён |
| `vrunner` | команды vanessa-runner 3.x (`vrunner-mcp`) | `disabled: true`, включить: `node mcp/register-opencode-mcp.mjs --vrunner` |

Формат OpenCode v2: `mcp.servers`, `disabled`, таймауты в миллисекундах (`startup` 10 с / 30 с для BSL LS).

**LSP.** В `opencode.json` и установщике есть секция `lsp.bsl`: BSL Language Server для `.bsl` и `.os` через
[`lsp/bsl-lsp.mjs`](lsp/bsl-lsp.mjs) — тот же поиск BSL LS, что у `1c-bsl` (`BSL_LS_PATH` →
`~/.config/opencode/tools/bsl-language-server` → `~/.agents/tools/...`), режим `lsp` по stdio. **OpenCode v2 эту
секцию принимает, но языковые серверы пока не запускает** (документация, «Migrate from V1»); она работает в OpenCode
1.x и включится сама, когда v2 вернёт LSP. Рабочая диагностика в v2 — MCP `1c-bsl` (точечно по модулю) и навык
`bsl-check` (каталог, отчёт). Не записывать LSP: `install --no-lsp` или `register-opencode-mcp.mjs --no-lsp`.
Уточняющие вопросы агент задаёт встроенным инструментом `question` (сервер `1c-ask` перенесён в `legacy/`).

## Структура

| Путь | Что |
|------|-----|
| `.opencode/agents/` | агенты OpenCode v2 (Markdown + frontmatter) |
| `.opencode/commands/` | команды `/1c-*` |
| `skills/` | собранные навыки (генерируются, руками не править) |
| `own-skills/` | свои навыки (`bsl-check`, `vrunner`, `1c-test`, `print-form`) — источник для `skills/` |
| `mcp/` | MCP-серверы и `register-opencode-mcp.mjs` (пишет `mcp.servers` и `lsp.bsl`) |
| `lsp/` | `bsl-lsp.mjs` — запуск BSL LS в режиме LSP для секции `lsp` |
| `opencode.json` | конфиг v2 для работы в самом репозитории (`skills`, `mcp.servers`, `default_agent`) |
| `templates/AGENTS.md` | шаблон инструкций для 1С-проекта |
| `install.ps1`, `install.cmd` | установка на Windows одной командой из папки проекта |
| `scripts/kill-bsl-ls.mjs`, `scripts/kill-bsl-ls.ps1` | завершить зависшие процессы BSL LS ([зависания на больших проектах](docs/quickstart.md#зависания-и-процессы-bsl-ls-на-больших-конфигурациях)) |
| `tests/mcp/run.mjs` | тесты прокси `1c-bsl`: дерево процессов, таймаут, область индексации |
| `scripts/opencode_port.py` | сборка из upstream и установка; ядро — `scripts/port_core.py` |
| `docs/` | гайды и спецификации форматов 1С; [quickstart](docs/quickstart.md), [тестирование](docs/testing-guide.md) |
| `legacy/` | артефакты старого goose-порта (не используются, см. [legacy/README.md](legacy/README.md)) |

## Обновление из upstream

```bash
python scripts/opencode_port.py build                         # git clone cc-1c-skills main
python scripts/opencode_port.py build --upstream ../cc-1c-skills
```

[`UPSTREAM`](UPSTREAM) хранит коммит сборки (сейчас cc-1c-skills `b102d9d`). Свои навыки берутся из `own-skills/`,
адаптация под OpenCode — в `scripts/port_core.py`.

GitHub Action [`upstream-sync`](.github/workflows/upstream-sync.yml) раз в неделю (понедельник, 05:17 UTC) или вручную
выполняет `python scripts/opencode_port.py build` и, если `skills/` или `UPSTREAM` изменились, открывает PR из ветки
`auto/upstream-sync`. Для создания PR включите в настройках репозитория «Allow GitHub Actions to create and approve
pull requests».

## Лицензия

MIT — см. [LICENSE](LICENSE). Навыки и документация — Nick Shirokov,
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills). vanessa-runner — проект vanessa-opensource (MPL-2.0),
сюда не входит, только вызывается.
