# legacy — артефакты goose-порта

Не поддерживается и не используется OpenCode. Сохранено для истории и возможного переноса.

| Что | Было | Замена в OpenCode v2 |
|-----|------|----------------------|
| `goose/.goosehints` | подсказки goose | агент `.opencode/agents/1c.md` + `templates/AGENTS.md` |
| `goose/recipes/*.yaml` | рецепты этапов | субагенты `1c-analyst/developer/deployer/tester` (+ `1c-test-author`) и команды `/1c-*` |
| `goose/plugin.json`, `goose/install-windows.cmd` | манифест и установщик плагина goose | `scripts/opencode_port.py install` |
| `mcp/ask-user.mjs` | форма вопросов через MCP Elicitation | встроенный инструмент OpenCode `question` |
| `mcp/register-extensions.mjs` | регистрация MCP в goose config.yaml | `mcp/register-opencode-mcp.mjs` |
| `hooks/` | хук `support-guard` (формат Claude Code/goose) | пока нет: нужен плагин OpenCode; сейчас — правила агента `1c` (см. [docs/v8-project-guide.md](../docs/v8-project-guide.md)) |
| `scripts/goose_port.py` | сборка/установка для goose | `scripts/port_core.py` + `scripts/opencode_port.py` |
| `scripts/analyze_session.py`, `install-windows.ps1` | анализ сеансов goose, установщик Windows | — |

Тест хука: `node legacy/hooks/test/run.mjs`.

`.github/workflows/upstream-sync.yml` всё ещё ссылается на `scripts/goose_port.py` и `plugin.json` — см. предупреждение
в [README](../README.md#обновление-из-upstream).
