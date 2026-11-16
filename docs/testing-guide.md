# Тестирование в агенте 1С для OpenCode

Краткий обзор того, что есть в ветке и как этим пользоваться. Подробности — в навыке
[`1c-test`](../skills/1c-test/SKILL.md).

## Что выбрать

| Задача | Инструмент | Команда / агент | Тесты | Отчёты |
|--------|-----------|-----------------|-------|--------|
| Быстрая проверка в браузере, воспроизведение ошибки | `web-test` (`open` + `exec` по шагам, `run` — сценарий целиком) | `/1c-webtest`, `1c-tester` | разовый скрипт | `build/reports/web/` |
| Регресс по веб-клиенту | `web-test` (`test`) | `1c-test-author` пишет, `1c-tester` прогоняет | `tests/web/` | `build/reports/web/allure`, `junit.xml` |
| Приёмочные BDD-сценарии, тонкий клиент | Vanessa Automation через `vrunner run enterprise` | `/1c-bdd`, `1c-test-author` | `features/**/*.feature` | `build/reports/va/` |
| Проект уже на Vanessa-ADD | `vrunner test vanessa` | навык `vrunner` | `features/` | `build/reports/` |
| Модульные тесты кода | YAxUnit — `vrunner test yaxunit` | навык `vrunner` | расширение с тестами | `build/reports/yaxunit.xml` |

## Vanessa Automation и Vanessa-ADD — не одно и то же

- **Vanessa-ADD** (`bddRunner.epf`, `xddTestRunner.epf`, настройки VBParams) — именно её запускает
  `vrunner test vanessa` / `test xunit` в vanessa-runner 3.x.
- **Vanessa Automation** (`vanessa-automation.epf`, настройки VAParams) — отдельный продукт
  ([Pr-Mex/vanessa-automation](https://github.com/Pr-Mex/vanessa-automation)). В vrunner для неё нет отдельной
  команды, поэтому `/1c-bdd` запускает её через
  `vrunner run enterprise --additional "/TESTMANAGER" --execute ./tools/vanessa/vanessa-automation.epf --command "StartFeaturePlayer;QuietInstallVanessaExt;VAParams=./tools/vanessa/VAParams.json"`.
  Итог читается из `build/reports/va/status.log` и `build/reports/va/junit/`, а не из кода возврата vrunner.
- `vanessa-automation.epf` в репозиторий не входит: скачайте релиз и положите в `tools/vanessa/`.
  Шаблоны: [`VAParams.json`](../skills/1c-test/templates/VAParams.json),
  [`example.feature`](../skills/1c-test/templates/example.feature). Пути в VAParams — от корня проекта
  (на реальной базе ещё не проверялось).

## Preflight web-test

[`preflight.mjs`](../skills/1c-test/scripts/preflight.mjs) ничего не устанавливает, только проверяет и
подсказывает команду исправления:

1. URL базы — из `.v8-project.json` (`webUrl` или `http://localhost:8081/<id>`) или аргумента;
2. Playwright в `.opencode/` или `~/.config/opencode/`;
3. Chromium скачан;
4. на Linux — есть `DISPLAY`/`WAYLAND_DISPLAY` (иначе `xvfb-run -a`);
5. веб-клиент отвечает (иначе — навык `web-publish`, сам агент базу не публикует без согласия);
6. создаёт `build/reports/web/`.

Код выхода 0 — всё готово; `--json` — машиночитаемый вывод.

## Отчёты

```
build/reports/
├── web/        # web-test: allure/, junit.xml, скриншоты, видео (--record)
├── va/         # Vanessa Automation: allure/, junit/, screenshots/, log.txt, status.log
└── yaxunit.xml # YAxUnit через vrunner
```

JUnit для web-test собирается из Allure того же прогона:
[`allure-to-junit.mjs`](../skills/1c-test/scripts/allure-to-junit.mjs). HTML-отчёт Allure:
`allure generate build/reports/web/allure -o build/reports/web/html` (Allure CLI ставится отдельно).

## Права агентов

| Агент | Может писать |
|-------|--------------|
| `1c-tester` | `tests/**`, `build/reports/**` |
| `1c-test-author` | `tests/**`, `features/**`, `tools/vanessa/**`, `build/reports/**` |

## Ограничения

- Ничего из этого не прогонялось на живой базе 1С — проверены только скрипты (preflight, allure-to-junit) и установка.
- `web-publish` работает только на Windows (Apache + `wsap24.dll`).
- CI-сценария для тестов пока нет (есть только `upstream-sync` для пересборки навыков).
