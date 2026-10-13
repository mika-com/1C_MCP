---
description: Этап 4 — проверка доработки в веб-клиенте (web-test) с preflight и отчётами в build/reports/web
agent: 1c-tester
---

Проверь доработку в веб-клиенте 1С.

$ARGUMENTS

Порядок: загрузи навыки `1c-test` и `web-test`; по результатам preflight ниже установи недостающее
(Playwright/Chromium) или остановись с предложением `web-publish`, если веб-клиент не отвечает. Отчёты, скриншоты
и видео — в `build/reports/web/`. В итоге перечисли пути к ним.

Preflight:

!`for p in .opencode/skills/1c-test/scripts/preflight.mjs "$HOME/.config/opencode/skills/1c-test/scripts/preflight.mjs" skills/1c-test/scripts/preflight.mjs; do if [ -f "$p" ]; then node "$p" 2>&1; exit 0; fi; done; echo "preflight не найден — запусти его по навыку 1c-test"`
