# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [1.0.0] — 2026-10-19

Первый публичный выпуск 1C-Agent — агента 1С:Предприятие 8.3 для OpenCode v2 (Desktop и CLI).

### Состав
- 85 навыков: 81 из [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) (коммит `b102d9d`, см. `UPSTREAM`),
  адаптированных под OpenCode v2, и 4 собственных: `bsl-check`, `vrunner`, `1c-test`, `print-form`.
- Агенты `1c`, `1c-analyst`, `1c-developer`, `1c-deployer`, `1c-tester`, `1c-test-author`;
  команды `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`.
- MCP-серверы `1c-search` (поиск по XML-выгрузке), `1c-bsl` (BSL LS в режиме MCP), `vrunner` (выключен по умолчанию)
  в формате OpenCode v2 (`mcp.servers`, `disabled`, таймауты в мс); секция `lsp.bsl` (v2 пока LSP не запускает).
- MCP-сервер `1c-help` — синтакс-помощник по справке установленной платформы (`*.hbk` читаются локально, в репозиторий
  не входят): `help_search` (нечёткий поиск, рус./англ., `Тип.Метод`), `help_get`, `help_members`, `help_status`;
  выбор платформы `V8_HELP_PATH` → `.v8-project.json` → самая новая установленная; индекс в
  `%LOCALAPPDATA%\1c-opencode\help-cache` по версии; собственный парсер `.hbk` без зависимостей.
- Установка на Windows одной командой: `install.cmd` / `install.ps1` (winget-зависимости, BSL LS, Playwright,
  `-Project`, `-WithVrunner`, `-WithDesktop`, `-NoBslLs`, `-NoBrowser`, `-Uninstall`, `-Machine`); на других ОС —
  `python scripts/opencode_port.py install`.

### Надёжность
- `1c-bsl`: очистка дерева процессов, один BSL LS на пользователя и проект, таймаут вызова, узкая область индексации,
  `BSL_LS_XMX`; `scripts/kill-bsl-ls.*` — завершение только своих зависших процессов.
- Многопользовательский сервер (RDP): lock-файлы, кэши и сеансы web-test у каждого пользователя свои, общие
  инструменты через `install.ps1 -Machine`.

### Правила агентов
- Незнакомые методы и свойства платформы — проверять через `1c-help`, не придумывать (`1c`, `1c-developer`).
- Печатные формы «сначала макет» (`print-form`, предпросмотр PNG).
- Выбор перехватчика для методов типовой конфигурации (`&ИзменениеИКонтроль` / `&Перед` / `&После` / `&Вместо`),
  `cfe-patch-method -Check` / `-Actualize` после обновления.
- Стратегия тестирования: web-test, Vanessa Automation (BDD), YAxUnit.

### Удалено перед публикацией
- Наследие goose-порта (`legacy/`: рецепты и манифест goose, сервер вопросов `1c-ask`, хук `support-guard`
  в формате Claude Code, `goose_port.py`, `analyze_session.py`, старый `install-windows.ps1`) и путь `~/.agents`.
  Проверку объектов на поддержке выполняют сами навыки-мутаторы (`editingAllowedCheck`).

[1.0.0]: https://github.com/mika-com/1C-Agent/releases/tag/v1.0.0
