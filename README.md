# 1C Skills for OpenCode

Набор из 82 навыков для разработки на 1С:Предприятие 8.3 в [OpenCode](https://opencode.ai/), собранный на базе
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) и дополненный локальными MCP-серверами для
поиска по выгрузке, проверки BSL-кода и уточняющих вопросов.

Проект покрывает:
- создание и анализ XML-исходников конфигураций, расширений, EPF, ERF, форм, СКД, ролей и XDTO;
- загрузку и обновление информационных баз;
- веб-публикацию и автоматизацию 1С через браузер;
- проверку BSL-кода через BSL Language Server;
- поиск по выгрузке через MCP вместо ручного `grep` по XML.

## OpenCode Setup

### Быстрый старт

1. Клонируйте репозиторий в удобный каталог.
2. Установите навыки:

```bash
python scripts/opencode_port.py install --project-dir .
# или глобально:
python scripts/opencode_port.py install --global
```

3. Зарегистрируйте MCP-серверы OpenCode:

```bash
node mcp/register-opencode-mcp.mjs
```

4. Перезапустите OpenCode.

OpenCode умеет читать навыки из `.agents/skills/`, `~/.config/opencode/skills/`, `.claude/skills/` и `.opencode/skills/`,
поэтому проектная установка идёт в `.agents/skills/`, а глобальная — в `~/.config/opencode/skills/`.

### Готовый конфиг

В корне репозитория есть [opencode.json](opencode.json) с локальными MCP-серверами:
- `1c-ask` — форма уточняющих вопросов;
- `1c-search` — поиск объектов, методов и вызовов по XML-выгрузке;
- `1c-bsl` — BSL Language Server.

Если у вас уже есть свой `opencode.json`, используйте `node mcp/register-opencode-mcp.mjs`, чтобы аккуратно добавить
или обновить только записи 1С.

### Требования

- `OpenCode`
- `Python 3.9+`
- `Node.js 18+`
- `1С:Предприятие 8.3` для операций сборки/выгрузки/загрузки и работы с базами
- `BSL Language Server` для `bsl-check` и `1c-bsl`

## Использование

Запускайте OpenCode из корня 1С-проекта и формулируйте задачу естественным языком. Для точного вызова можно просить
конкретные навыки, например:

```text
Используй skill epf-init и создай внешнюю обработку МояОбработка
Используй skill meta-info и проанализируй Документ.ЗаказКлиента
Используй MCP 1c-search и найди метод, который записывает номер заказа
```

Настройки проекта по базам, платформе и веб-клиенту лежат в `.v8-project.json`.
Пример — [`.v8-project.example.json`](.v8-project.example.json).

## Web Test

Навык `web-test` использует Playwright. При первой необходимости установите браузер:

```bash
npm install --prefix "$HOME/.config/opencode" --no-fund --no-audit "playwright@^1.50.0"
npx --prefix "$HOME/.config/opencode" playwright install chromium
```

Для проектной установки `scripts/opencode_port.py install --project-dir .` автоматически перенастраивает `web-test`
на локальный префикс `<проект>/.agents`.

## Структура

- `skills/` — 82 OpenCode-совместимых навыка
- `mcp/` — локальные MCP-серверы `1c-ask`, `1c-search`, `1c-bsl`
- `opencode.json` — пример конфигурации OpenCode
- `scripts/opencode_port.py` — установка навыков под OpenCode
- `scripts/goose_port.py` — legacy-скрипт старого goose-порта
- `goose/` — legacy-артефакты старой сборки
- `docs/` — гайды и спецификации форматов 1С

## Обновление из Upstream

Каталог `skills/` продолжает генерироваться из `cc-1c-skills`:

```bash
python scripts/opencode_port.py build
python scripts/opencode_port.py build --upstream ../cc-1c-skills
python scripts/opencode_port.py build --ref <ветка-или-тег>
```

Файл [`UPSTREAM`](UPSTREAM) хранит источник и коммит, из которого собрана текущая версия.

## Совместимость

Репозиторий переведён в OpenCode-first режим, но часть legacy-файлов для `goose` пока сохранена:
- `plugin.json`
- `mcp/register-extensions.mjs`
- `hooks/`
- `goose/`

Они больше не являются основной точкой входа и нужны только для обратной совместимости и безопасной миграции.

## Лицензия

MIT — см. [LICENSE](LICENSE). Upstream-автор навыков и документации — Nick Shirokov,
[cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills). OpenCode-адаптация распространяется
на тех же условиях.
