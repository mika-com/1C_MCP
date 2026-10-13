---
name: vrunner
description: Автоматизация 1С через vanessa-runner 3.x (vrunner) — сборка/разборка cf/cfe/epf, загрузка и обновление ИБ, хранилище, тесты YAxUnit/Vanessa-ADD/xUnit, синтаксический контроль. Используй, когда в проекте есть autumn-properties.json или пользователь просит vrunner/vanessa-runner/CI-сценарий
argument-hint: <группа> <подкоманда> [опции]
---

# /vrunner — vanessa-runner 3.x

[vanessa-runner](https://github.com/vanessa-opensource/vanessa-runner) — консольная утилита на OneScript
для повседневных операций разработчика 1С. Этот навык — шпаргалка: как вызывать `vrunner` из shell
и когда предпочесть его навыкам `db-*` / `epf-*`.

## Когда использовать

- В корне проекта есть `autumn-properties.json` (или старый `vrunner.json`) — проект уже живёт на vrunner,
  используй его, а не `db-*`: так агент повторяет тот же путь, что CI.
- Нужны тесты (YAxUnit, Vanessa-ADD, xUnit), синтаксический контроль, работа с хранилищем или кластером.
- Нужна сборка во временной базе без своей ИБ (`--ibcmd`).

Если vrunner не установлен — не ставь его молча. Предложи пользователю (инструмент `question`):
установить (`opm install vanessa-runner`, нужен OneScript ≥ 2.0) или выполнить задачу навыками `db-*`.

## Проверка окружения

```bash
vrunner --version          # установлен ли и какая версия (нужна 3.x)
oscript -version           # OneScript >= 2.0.0
```

Версия 2.x использует старые команды (`vrunner updatedb`, `vrunner vanessa`) и `vrunner.json`.
Миграция: `oscript tools/migrate26to30.os --input vrunner.json --output autumn-properties.json`.

## Настройки

`autumn-properties.json` в корне проекта — ключи без `--`, иерархия по командам:

```json
{
  "vrunner": {
    "ibconnection": "/F./build/ib",
    "v8version": "8.3.24",
    "test": { "xunit": { "testspath": "./tests", "report-format": ["junit"], "report-path": "./build/reports/junit.xml" } }
  }
}
```

Переменные окружения — `VRUNNER_*` (в 2.x были `RUNNER_*`). Пароли (`--db-pwd`) передавай через
переменные окружения, не записывай в файлы и не выводи в ответ.

## Команды (3.x)

| Группа | Подкоманды | Пример |
|--------|-----------|--------|
| `cf` | compile, decompile, load, unload, make-dist, merge, vendor-update | `vrunner cf load --ibconnection /F./ib ./src` |
| `cfe` | compile, decompile, load, unload, compare, convert | `vrunner cfe load --ibconnection /F./ib --extension-name МоёРасширение ./src/cfe` |
| `epf` | compile, decompile, convert | `vrunner epf compile -R --out ./build/epf --ibcmd ./src/epf` |
| `infobase` | init, update, dump-dt, restore-dt, create-user, lock-resources, scheduled-job | `vrunner infobase update --ibconnection /F./ib` |
| `repo` | create, bind, unbind, load, lock, unlock, commit, save-cf | `vrunner repo load --ibconnection /F./ib` |
| `test` | xunit, yaxunit, vanessa | `vrunner test yaxunit --ibconnection /F./ib` |
| `validate` | syntax-check, edt | `vrunner validate syntax-check --ibconnection /F./ib --report-format junit --report-path ./build/syntax.xml` |
| `run` | enterprise, designer | только по явной просьбе: интерактивный запуск |

Без базы — сборка во временной ИБ: `vrunner cf compile --ibcmd -s ./src ./build/App.cf`.
Исходники EDT определяются автоматически (`--src-format edt` — принудительно).
Полный справочник: `vrunner <группа> --help` или https://autumn-library.github.io/vanessa-runner

## Правила

1. Перед `cf load`, `cfe load`, `infobase update`, `repo commit`, `restore-dt` — покажи пользователю,
   что и в какую базу будет загружено, и получи подтверждение (`question`).
2. Перед загрузкой проверь код навыком `bsl-check`; ошибки уровня «ошибка» — стоп.
3. Долгие операции (load, update, тесты) запускай с увеличенным таймаутом shell (30–60 минут)
   или в фоне (`background: true`), лог сохраняй в файл и читай частями.
4. Отчёты тестов и проверок (`--report-path`) пиши в `build/reports/` и разбирай файл, а не консоль.

## MCP-сервер vrunner-mcp

vanessa-runner 3.x ставит `vrunner-mcp` — MCP-сервер, выставляющий команды как инструменты
(`cf_compile`, `infobase_update`, `test_yaxunit`, `validate_syntax_check`, `task_status`…).
В `opencode.json` он описан как `vrunner` и по умолчанию выключен (`disabled: true`). Включить:
`node mcp/register-opencode-mcp.mjs --vrunner`. Долгие команды через MCP возвращают `taskId` —
забирай результат через `task_status` / `task_result`.
