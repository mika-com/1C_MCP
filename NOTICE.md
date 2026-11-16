# NOTICE — сторонний код и инструменты

1C-Agent распространяется по лицензии MIT (см. [LICENSE](LICENSE)).

## Включено в репозиторий

| Компонент | Где | Лицензия | Правообладатель |
|-----------|-----|----------|-----------------|
| [cc-1c-skills](https://github.com/Nikolay-Shirokov/cc-1c-skills) | `skills/` (81 навык, собраны `scripts/opencode_port.py build`; коммит — в [UPSTREAM](UPSTREAM)), большая часть `docs/`, `.v8-project.example.json`, `.v8-xsd/README.md`, `requirements.txt` | MIT | © 2025-2026 Nick Shirokov |

Навыки cc-1c-skills адаптированы под OpenCode v2 (формат SKILL.md, пути, вопросы через `question`, заметки
агента); изменения описаны в `scripts/port_core.py`. Уведомление об авторских правах и текст MIT-лицензии
cc-1c-skills сохранены в [LICENSE](LICENSE) и должны сохраняться во всех копиях.

Собственные компоненты 1C-Agent (MIT, © 2026 mika-com): навыки `bsl-check`, `vrunner`, `1c-test`, `print-form` в `skills/`,
`print-form`), `.opencode/`, `mcp/`, `plugins/`, `scripts/`, `tests/`, `install.ps1`, `install.cmd`, `templates/`,
`docs/quickstart.md`, `docs/testing-guide.md`, `docs/semantic-search.md`.

## Не включено (устанавливается или вызывается отдельно)

| Инструмент | Лицензия | Как используется |
|------------|----------|------------------|
| [BSL Language Server](https://github.com/1c-syntax/bsl-language-server) | LGPL-3.0 | скачивается установщиком (`bsl-check -Install`) с GitHub Releases, запускается как отдельный процесс (`bsl-check`, `1c-bsl`, плагин `bsl-autocheck`) |
| [vanessa-runner](https://github.com/vanessa-opensource/vanessa-runner) | MPL-2.0 | ставится пользователем (`opm install vanessa-runner`), вызывается как CLI / `vrunner-mcp` |
| [Vanessa Automation](https://github.com/Pr-Mex/vanessa-automation) | BSD-3-Clause | `vanessa-automation.epf` скачивается пользователем в `tools/vanessa/` |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | ставится через npm (`web-test`, предпросмотр PNG) |
| [OpenCode](https://github.com/anomalyco/opencode) | MIT | агентная среда |
| [LM Studio](https://lmstudio.ai) | проприетарная (бесплатна, см. условия LM Studio) | необязательный локальный сервер эмбеддингов и реранкера для `semantic_search`; ставится пользователем |
| [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF) | Apache-2.0 | модель эмбеддингов; скачивается пользователем в LM Studio, не распространяется |
| [Qwen3-Reranker-4B](https://huggingface.co/Qwen/Qwen3-Reranker-4B) (GGUF: [DevQuasar](https://huggingface.co/DevQuasar/Qwen.Qwen3-Reranker-4B-GGUF)) | Apache-2.0 | модель-реранкер; скачивается пользователем, не распространяется; формат промпта — по карточке модели |
| XSD-схемы платформы 1С | собственность 1С | не распространяются; `/v8-xsd-fetch` берёт их из установленной платформы |
| Справка платформы 1С (синтакс-помощник, `*.hbk`) | собственность 1С | не распространяется и не входит в репозиторий; MCP `1c-help` читает её из платформы, установленной у пользователя, индекс хранится только локально (`%LOCALAPPDATA%\1c-opencode\help-cache`) |

## Формат `.hbk`

Парсер `mcp/lib/hbk.mjs` написан с нуля, внешних зависимостей нет, код сторонних проектов не копировался.
Сведения о формате контейнера и оглавления взяты из открытых источников:
[1c-syntax/bsl-context](https://github.com/1c-syntax/bsl-context) (LGPL-3.0),
[alkoleft/hbk-viewer](https://github.com/alkoleft/hbk-viewer) (MIT) и публикаций сообщества на Infostart.
Тестовые `.hbk` (`tests/mcp/lib/make-hbk.mjs`) синтетические: вымышленный тип «Виджет», без текста справки 1С.
