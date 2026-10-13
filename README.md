# Агент 1С для OpenCode v2

Агент для разработки на 1С:Предприятие 8.3 в [OpenCode](https://opencode.ai/v2/docs) (Desktop и CLI):

- **84 навыка**: 81 из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (конфигурации, расширения,
  EPF/ERF, формы, СКД, макеты, роли, XDTO, базы, веб-публикация, web-test) + свои `bsl-check`, `vrunner` и `1c-test` (стратегия тестирования, preflight, шаблоны Vanessa);
- **агенты**: основной `1c` и субагенты по этапам `1c-analyst` → `1c-developer` → `1c-deployer` → `1c-tester`,
  плюс `1c-test-author` (пишет регресс web-test и BDD-сценарии);
- **команды**: `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`;
- **MCP-серверы**: `1c-search` (поиск по XML-выгрузке), `1c-bsl` (BSL Language Server),
  `vrunner` ([vanessa-runner 3.x](https://github.com/vanessa-opensource/vanessa-runner), `vrunner-mcp`, по умолчанию выключен).

## Быстрый старт

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

Как выбрать инструмент — навык [`1c-test`](own-skills/1c-test/SKILL.md). Права: `1c-tester` пишет только в `tests/**` и
`build/reports/**`, `1c-test-author` — в `tests/**`, `features/**`, `tools/vanessa/**`, `build/reports/**`.

## Структура

| Путь | Что |
|------|-----|
| `.opencode/agents/` | агенты OpenCode v2 (Markdown + frontmatter) |
| `.opencode/commands/` | команды `/1c-*` |
| `skills/` | собранные навыки (генерируются, руками не править) |
| `own-skills/` | свои навыки (`bsl-check`, `vrunner`, `1c-test`) — источник для `skills/` |
| `mcp/` | MCP-серверы и `register-opencode-mcp.mjs` |
| `opencode.json` | конфиг v2 для работы в самом репозитории (`skills`, `mcp.servers`, `default_agent`) |
| `templates/AGENTS.md` | шаблон инструкций для 1С-проекта |
| `scripts/opencode_port.py` | сборка из upstream и установка; ядро — `scripts/port_core.py` |
| `docs/` | гайды и спецификации форматов 1С |
| `legacy/` | артефакты старого goose-порта (не используются, см. [legacy/README.md](legacy/README.md)) |

## Обновление из upstream

```bash
python scripts/opencode_port.py build                         # git clone cc-1c-skills main
python scripts/opencode_port.py build --upstream ../cc-1c-skills
```

[`UPSTREAM`](UPSTREAM) хранит коммит сборки. GitHub Action `upstream-sync` делает это раз в неделю и открывает PR.

## Лицензия

MIT — см. [LICENSE](LICENSE). Навыки и документация — Nick Shirokov,
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills). vanessa-runner — проект vanessa-opensource (MPL-2.0),
сюда не входит, только вызывается.
