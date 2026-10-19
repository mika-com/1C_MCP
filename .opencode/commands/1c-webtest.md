---
description: Этап 4 — проверка доработки в веб-клиенте (web-test) с preflight и отчётами в build/reports/web
agent: 1c-tester
---

Проверь доработку в веб-клиенте 1С.

$ARGUMENTS

Порядок: загрузи навыки `1c-test` и `web-test`; по результатам preflight ниже установи недостающее
(Playwright/Chromium) или остановись с предложением `web-publish`, если веб-клиент не отвечает. Отчёты, скриншоты
и видео — в `build/reports/web/`. Проверяй текстом и DOM; на одну проверку не больше 1–2 скриншотов. В итоге
перечисли пути к отчётам, а не содержимое каждой картинки. COM, GUI `1cv8` и пароль в `-Password` не используй.

Preflight:

!`for p in .opencode/skills/1c-test/scripts/preflight.mjs "$HOME/.config/opencode/skills/1c-test/scripts/preflight.mjs" skills/1c-test/scripts/preflight.mjs; do if [ -f "$p" ]; then node "$p" 2>&1; exit 0; fi; done; echo "preflight не найден — запусти его по навыку 1c-test"`
