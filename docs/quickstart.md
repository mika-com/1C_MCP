# Быстрый старт: OpenCode + навыки 1С

Краткая инструкция для запуска навыков 1С в OpenCode. Итоговый поток такой:

1. открыть проект с XML-выгрузкой 1С;
2. подключить навыки и MCP;
3. попросить агент выполнить задачу на естественном языке.

## Что нужно заранее

| Компонент | Зачем нужен |
|-----------|-------------|
| `OpenCode` | Агентная среда, которая загружает skills и использует MCP |
| `Python 3.9+` | Скрипты навыков и установщик `scripts/opencode_port.py` |
| `Node.js 18+` | MCP-серверы `1c-ask`, `1c-search`, `1c-bsl` и `web-test` |
| `1С:Предприятие 8.3` | Сборка, выгрузка, загрузка в базы и веб-публикация |
| `Git` | Желателен для безопасной работы и отката изменений |

## Шаг 1. Получите репозиторий

```bash
git clone https://github.com/mika-com/1C_MCP_GOOSE.git
cd 1C_MCP_GOOSE
```

Если Git не нужен, можно скачать ZIP архива репозитория и распаковать его в любую папку.

## Шаг 2. Установите навыки

### В проект

Используйте этот вариант, если хотите хранить skills рядом с проектом и сделать их доступными всей команде:

```bash
python scripts/opencode_port.py install --project-dir .
```

Навыки будут установлены в `.agents/skills/` внутри проекта.

### Глобально

Если навыки нужны сразу во всех проектах:

```bash
python scripts/opencode_port.py install --global
```

Навыки будут установлены в `~/.config/opencode/skills/`.

## Шаг 3. Подключите MCP-серверы

В корне репозитория уже есть [opencode.json](../opencode.json), но если у вас свой конфиг OpenCode,
проще аккуратно дописать только записи 1С:

```bash
node mcp/register-opencode-mcp.mjs
```

Скрипт добавляет или обновляет:
- `1c-ask` — уточняющие вопросы;
- `1c-search` — поиск по выгрузке;
- `1c-bsl` — проверка BSL-кода.

## Шаг 4. Перезапустите OpenCode

После установки навыков и MCP перезапустите OpenCode, чтобы он перечитал:
- `skills/` из `.agents/skills/` или `~/.config/opencode/skills/`;
- локальный `opencode.json`.

## Шаг 5. Откройте проект 1С

Рабочий каталог агента должен быть корнем проекта, где лежат:
- XML-выгрузка конфигурации или расширения;
- каталог `src/`;
- при необходимости `.v8-project.json`.

Если проект ещё не настроен, используйте шаблон [`.v8-project.example.json`](../.v8-project.example.json)
и справочник [v8-project-guide.md](v8-project-guide.md).

## Шаг 6. Дайте первую задачу

Примеры нормальных формулировок:

- `Проанализируй конфигурацию и найди, где формируется номер заказа`
- `Используй skill meta-info и покажи структуру документа ЗаказКлиента`
- `Создай внешнюю обработку ЗагрузкаЦен и добавь форму с кнопкой Загрузить`
- `Проверь изменённые модули через bsl-check`
- `Используй MCP 1c-search и найди вызовы процедуры ПередЗаписью`

Если задача неоднозначна, агент должен использовать `1c-ask` и уточнить параметры.

## Шаг 7. Настройте `.v8-project.json`, если нужна база

Для операций `db-*`, `web-*`, `epf-build`, `erf-build` и `web-test` обычно нужен файл
`.v8-project.json` в корне проекта.

Минимальный пример:

```json
{
  "v8path": "C:\\Program Files\\1cv8\\8.3.27.2325\\bin",
  "databases": [
    {
      "id": "dev",
      "name": "Разработка",
      "type": "file",
      "path": "C:\\Bases\\MyApp_Dev",
      "configSrc": "src\\cf",
      "webUrl": "http://localhost:8081/dev"
    }
  ],
  "default": "dev"
}
```

Подробности: [v8-project-guide.md](v8-project-guide.md).

## Шаг 8. Веб-тесты и браузер

Для `web-test` один раз установите Playwright:

```bash
npm install --prefix "$HOME/.config/opencode" --no-fund --no-audit "playwright@^1.50.0"
npx --prefix "$HOME/.config/opencode" playwright install chromium
```

Если навыки установлены в проект, `scripts/opencode_port.py` перенастраивает `web-test`
на локальный префикс `<проект>/.agents`.

## Что проверять после установки

- агент видит навыки вроде `epf-init`, `meta-info`, `form-edit`, `bsl-check`;
- в `opencode.json` появились записи `1c-ask`, `1c-search`, `1c-bsl`;
- в корне проекта корректный `.v8-project.json`, если вы работаете с базой;
- `Node.js` доступен из PATH;
- `Python` запускает `scripts/opencode_port.py`.

## Частые проблемы

| Проблема | Что делать |
|----------|------------|
| Агент не видит навыки | Проверьте, что skills установлены в `.agents/skills/` или `~/.config/opencode/skills/`, затем перезапустите OpenCode |
| Нет `1c-search` / `1c-ask` / `1c-bsl` | Выполните `node mcp/register-opencode-mcp.mjs` и проверьте `opencode.json` |
| `Cannot find package 'playwright'` | Повторите установку Playwright из шага 8 |
| `BSL Language Server не установлен` | Выполните `node skills/bsl-check/scripts/bsl-check.mjs -Install` или установите через Windows-установщик |
| Навыки не могут найти платформу | Укажите `v8path` в `.v8-project.json` |
| Агент не понимает, с какой базой работать | Добавьте `default`, `aliases` или явно укажите базу в запросе |

## Следующие шаги

- Для XML-объектов: [meta-guide.md](meta-guide.md), [form-guide.md](form-guide.md), [cf-guide.md](cf-guide.md)
- Для баз и загрузки: [db-guide.md](db-guide.md), [v8-project-guide.md](v8-project-guide.md)
- Для веб-клиента: [web-guide.md](web-guide.md), [web-test-guide.md](web-test-guide.md)
- Для видеоинструкций: [web-test-recording-guide.md](web-test-recording-guide.md)
