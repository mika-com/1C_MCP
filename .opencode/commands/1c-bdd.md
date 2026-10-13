---
description: BDD-сценарии Vanessa Automation — написать .feature на русском Gherkin и/или прогнать через vrunner с отчётами Allure/JUnit
agent: 1c-test-author
---

Работа со сценариями Vanessa Automation: $ARGUMENTS

Загрузи навыки `1c-test` и `vrunner`.

1. Проверь окружение: `vrunner --version` (нужна 3.x), наличие `tools/vanessa/vanessa-automation.epf` и
   `tools/vanessa/VAParams.json` (если нет — создай из шаблона навыка `1c-test` и попроси пользователя положить epf).
2. Если нужно — напиши или дополни `features/**/*.feature` (`# language: ru`, шаги стандартной библиотеки VA,
   имена элементов из `form-info`).
3. Прогони через `vrunner run enterprise ... --execute ./tools/vanessa/vanessa-automation.epf
   --command "StartFeaturePlayer;QuietInstallVanessaExt;VAParams=./tools/vanessa/VAParams.json"`.
4. Итог: результат из `build/reports/va/status.log` и `junit/`, пути к Allure и скриншотам ошибок.
