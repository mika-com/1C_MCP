# Хук support-guard — legacy-защита конфигураций на поддержке

Если legacy-окружение goose пытается напрямую изменить объект типовой конфигурации, который стоит на поддержке
поставщика, хук `PreToolUse` **блокирует** вызов встроенного инструмента (`write`, `edit`,
`text_editor`) и объясняет модели, что делать: вести доработку в расширении
(`cfe-borrow` / `cfe-patch-method`) или явно разрешить редактирование навыком `support-edit`
(готовая команда — в тексте отказа).

Базовая защита уже встроена в навыки-мутаторы; хук ловит правки **в обход навыков**.

Это порт `hooks/support-guard.mjs` из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills)
на [протокол хуков goose](https://block.github.io/goose/docs/guides/context-engineering/hooks)
(`{"decision":"block","reason":...}`). Хук `skill-suggester` не портирован: хуки goose не могут
добавлять текст в контекст модели.

## Статус

Основной режим репозитория теперь — OpenCode. Этот каталог сохранён для обратной совместимости со старым
goose-портом и как справка по логике `support-guard`.

## Подключение

- **Плагин `1c`** (`goose plugin install ...`) — хук включён сразу: goose подхватывает
  `hooks/hooks.json` из корня плагина.
- **Навыки без плагина** (`scripts/goose_port.py install`) — флаг `--hooks` ставит хук отдельным
  плагином `1c-support-guard` в `<проект>/.agents/plugins/` (или `~/.agents/plugins/` с `--global`).

Нужен **Node.js 18+** (`node` в `PATH`). Если `node` нет, хук не срабатывает, но и ничего не ломает:
goose по умолчанию пропускает вызов при сбое хука.

## Настройка (`.v8-project.json`)

| Поле | Значения | По умолчанию | Что делает |
|------|----------|--------------|------------|
| `editingAllowedCheck` | `deny` / `warn` / `off` | `deny` | Блокировать правку объекта на замке / только предупреждать (в лог goose) / выключить проверку. |

Поле задаётся глобально или для конкретной базы (`databases[].editingAllowedCheck`, сопоставление
по `configSrc`). Источник истины по состоянию поддержки — сама выгрузка (`Ext/ParentConfigurations.bin`).

## Проверка

```bash
node hooks/test/run.mjs
```
