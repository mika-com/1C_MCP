# NOTICE — сторонний код и инструменты

1C-Agent распространяется по лицензии MIT (см. [LICENSE](LICENSE)).

## Включено в репозиторий

| Компонент | Где | Лицензия | Правообладатель |
|-----------|-----|----------|-----------------|
| [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) | `skills/` (81 навык, собраны `scripts/opencode_port.py build`; коммит — в [UPSTREAM](UPSTREAM)), большая часть `docs/`, `.v8-project.example.json`, `.v8-xsd/README.md`, `requirements.txt` | MIT | © 2025-2026 Nick Shirokov |

Навыки cc-1c-skills адаптированы под OpenCode v2 (формат SKILL.md, пути, вопросы через `question`, заметки
агента); изменения описаны в `scripts/port_core.py`. Уведомление об авторских правах и текст MIT-лицензии
cc-1c-skills сохранены в [LICENSE](LICENSE) и должны сохраняться во всех копиях.

Собственные компоненты 1C-Agent (MIT, © 2026 mika-com): `own-skills/` (`bsl-check`, `vrunner`, `1c-test`,
`print-form`), `.opencode/`, `mcp/`, `lsp/`, `scripts/`, `tests/`, `install.ps1`, `install.cmd`, `templates/`,
`docs/quickstart.md`, `docs/testing-guide.md`.

## Не включено (устанавливается или вызывается отдельно)

| Инструмент | Лицензия | Как используется |
|------------|----------|------------------|
| [BSL Language Server](https://github.com/1c-syntax/bsl-language-server) | LGPL-3.0 | скачивается установщиком (`bsl-check -Install`) с GitHub Releases, запускается как отдельный процесс |
| [vanessa-runner](https://github.com/vanessa-opensource/vanessa-runner) | MPL-2.0 | ставится пользователем (`opm install vanessa-runner`), вызывается как CLI / `vrunner-mcp` |
| [Vanessa Automation](https://github.com/Pr-Mex/vanessa-automation) | BSD-3-Clause | `vanessa-automation.epf` скачивается пользователем в `tools/vanessa/` |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | ставится через npm (`web-test`, предпросмотр PNG) |
| [OpenCode](https://github.com/anomalyco/opencode) | MIT | агентная среда |
| XSD-схемы платформы 1С | собственность 1С | не распространяются; `/v8-xsd-fetch` берёт их из установленной платформы |
