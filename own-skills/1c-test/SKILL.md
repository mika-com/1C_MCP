---
name: 1c-test
description: Стратегия тестирования 1С и общие правила отчётов — выбор между web-test (Playwright, веб-клиент), Vanessa Automation (BDD .feature через vrunner), Vanessa-ADD и YAxUnit; preflight перед web-test; шаблоны VAParams и .feature. Загружай перед любой проверкой или написанием тестов
argument-hint: "[web|bdd|unit] [база]"
---

# /1c-test — как тестировать 1С

> **OpenCode:** `{SKILL_DIR}` в командах — каталог текущего навыка. Команды запускай из корня проекта.

## Что выбрать

| Задача | Инструмент | Где тесты | Отчёты |
|--------|-----------|-----------|--------|
| Быстро проверить доработку «руками», воспроизвести ошибку, разведать форму | `web-test` — `run`/`exec` | разовый скрипт | `build/reports/web/` |
| Регресс по веб-клиенту, наборы с тегами/ретраями, несколько пользователей | `web-test` — режим `test` (`regress.md`) | `tests/web/` | `build/reports/web/{allure,junit.xml}` |
| Приёмочные сценарии на русском Gherkin, тонкий клиент, стандарт команды/CI | **Vanessa Automation** (`/1c-bdd`) | `features/*.feature` | `build/reports/va/` |
| Проект уже на Vanessa-ADD (`bddRunner`, VBParams) | `vrunner test vanessa` (навык `vrunner`) | `features/` | `build/reports/` |
| Модульные тесты кода (общие модули, расчёты) | **YAxUnit** — `vrunner test yaxunit` | расширение с тестами | `build/reports/yaxunit.xml` |

Правила выбора:
- Нет опубликованной базы и нужен тонкий клиент → Vanessa Automation или YAxUnit, не web-test.
- Логика без UI → YAxUnit (быстро, стабильно); UI-процесс → web-test или Vanessa.
- В проекте уже есть `features/` или `tests/web/` — продолжай в том же инструменте.
- Если выбор неочевиден — спроси пользователя (`question`) с вариантами из таблицы.

## Единые отчёты

Все артефакты — в `build/reports/` (в `.gitignore` проекта):
- `build/reports/web/` — web-test: `allure/`, `junit.xml`, скриншоты ошибок, видео (`--record`);
- `build/reports/va/` — Vanessa Automation: `allure/`, `junit/`, `screenshots/`, `log.txt`, `status.log`;
- `build/reports/` — vrunner (`--report-path`).

В итоговом ответе всегда перечисляй пути к отчётам и скриншотам упавших шагов.

## web-test: preflight и запуск

1. Проверка окружения (ничего не ставит, печатает, чем исправить):
   ```bash
   node "{SKILL_DIR}/scripts/preflight.mjs" [id-базы|URL]
   ```
   Проверяет `.v8-project.json` → URL, Playwright и Chromium, дисплей (Linux: без `DISPLAY` — `xvfb-run -a`),
   ответ веб-клиента, создаёт `build/reports/web`. Если не хватает Playwright — выполни показанную команду
   установки. Если веб-клиент не отвечает — предложи пользователю навык `web-publish` и не продолжай без ответа.
2. Разовый сценарий: `node <web-test>/scripts/run.mjs run <url> script.js`. При ошибке `exec`/`run` кладут
   скриншот в `$TMPDIR/web-test-error-shot.png` (путь в поле `screenshot` ответа) — скопируй его в
   `build/reports/web/`.
3. Регресс (один прогон → Allure + JUnit):
   ```bash
   node <web-test>/scripts/run.mjs test tests/web --url=<url> --format=allure \
     --report-dir=build/reports/web/allure --screenshot=on-failure [--record]
   node "{SKILL_DIR}/scripts/allure-to-junit.mjs" build/reports/web/allure build/reports/web/junit.xml
   ```
   Скриншоты и видео (`--record`) пишутся в `--report-dir`. HTML: `allure generate build/reports/web/allure -o build/reports/web/html`.

## Vanessa Automation через vrunner

Нужны: vanessa-runner 3.x (`vrunner --version`), `vanessa-automation.epf` (релиз
https://github.com/Pr-Mex/vanessa-automation/releases — положи в `tools/vanessa/`), база с выгрузкой.

1. Настройки: скопируй `{SKILL_DIR}/templates/VAParams.json` в `tools/vanessa/VAParams.json` (если файла нет),
   поправь `КлиентыТестирования[].ПутьКИнфобазе`. Пути в нём — от корня проекта.
2. Фичи: `features/<Подсистема>/<Имя>.feature`, первая строка `# language: ru`, шаги — из стандартной библиотеки
   VA (`И я нажимаю на кнопку с именем '...'`, `Тогда открылось окно '...'`). Шаблон —
   `{SKILL_DIR}/templates/example.feature`. Имена элементов бери из `form-info`, а не угадывай. Теги: `@smoke`,
   `@wip` (исключается шаблоном).
3. Запуск (тонкий клиент, менеджер тестирования):
   ```bash
   vrunner run enterprise --ibconnection /F./build/ib --additional "/TESTMANAGER" \
     --execute ./tools/vanessa/vanessa-automation.epf \
     --command "StartFeaturePlayer;QuietInstallVanessaExt;VAParams=./tools/vanessa/VAParams.json"
   ```
   Без vrunner — тем же ключом `/Execute ... /C"StartFeaturePlayer;VAParams=..."` через `1cv8c`.
   Запускай с таймаутом shell 30–60 мин или `background: true`.
4. Результат: `build/reports/va/status.log` (0 — успех), `junit/*.xml`, `allure/`, скриншоты ошибок.

## YAxUnit

`vrunner test yaxunit --ibconnection <...> --report-format junit --report-path build/reports/yaxunit.xml` — тесты в
расширении (см. https://github.com/bia-technologies/yaxunit). Подробности команд — навык `vrunner`.
