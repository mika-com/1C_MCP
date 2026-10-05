# 1c-support-guard — плагин хуков goose

> ⚠️ **Экспериментально, по умолчанию не подключён.** Базовая защита поддержки уже встроена
> в навыки-мутаторы; плагин добавляет перехват правок **в обход навыков** — когда модель
> меняет файлы встроенными инструментами goose (`write`, `edit`, `text_editor`).

Если goose пытается напрямую изменить объект типовой конфигурации, который стоит на поддержке
поставщика, хук `PreToolUse` **блокирует** вызов инструмента (`{"decision":"block"}`) и объясняет
модели, что делать: вести доработку в расширении (`cfe-borrow` / `cfe-patch-method`) или явно
разрешить редактирование навыком `support-edit` (готовая команда — в тексте отказа).

Это порт `hooks/support-guard.mjs` из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills)
под [протокол хуков goose](https://block.github.io/goose/docs/guides/context-engineering/hooks).
Хук `skill-suggester` не портирован: хуки goose не могут добавлять текст в контекст модели.

## Требования

**Node.js 18+**, команда `node` в `PATH` (тот же Node.js, что нужен для `/web-test`).

## Установка

```bash
# в проект: <проект>/.agents/plugins/1c-support-guard/
python scripts/goose_port.py install --project-dir /path/to/project --hooks

# для пользователя: ~/.agents/plugins/1c-support-guard/
python scripts/goose_port.py install --global --hooks
```

Или скопируйте каталог `goose/plugins/1c-support-guard/` вручную в `.agents/plugins/`
проекта либо в `~/.agents/plugins/`. Перезапустите сессию goose.

Отключить без удаления — добавить имя в `disabledPlugins` (`~/.config/goose/settings.json`
или `<проект>/.config/goose/settings.json`):

```json
{ "disabledPlugins": ["1c-support-guard"] }
```

## Настройка (`.v8-project.json`)

| Поле | Значения | По умолчанию | Что делает |
|------|----------|--------------|------------|
| `editingAllowedCheck` | `deny` / `warn` / `off` | `deny` | Блокировать правку объекта на замке / только предупреждать (в лог goose) / выключить проверку. |

Поле можно задать глобально или для конкретной базы (`databases[].editingAllowedCheck`,
сопоставление по `configSrc`). Источник истины по состоянию поддержки — сама выгрузка
(`Ext/ParentConfigurations.bin`).

## Проверка

```bash
node goose/plugins/1c-support-guard/test/run.mjs
```
