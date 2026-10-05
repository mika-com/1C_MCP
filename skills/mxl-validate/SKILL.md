---
name: mxl-validate
description: Валидация макета табличного документа (MXL). Используй после создания или модификации макета для проверки корректности
argument-hint: <TemplatePath> [-Detailed] [-MaxErrors 20]
---

# /mxl-validate — валидация макета табличного документа (MXL)

> **goose:** `{SKILL_DIR}` в командах — каталог этого навыка: подставь абсолютный путь из строки `Skill directory:` (раздел Supporting Files в конце). Команды запускай из корня проекта. Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` (или `python3`) с теми же параметрами.

Проверяет Template.xml на структурные ошибки: индексы, ссылки на палитры, диапазоны именованных областей и объединений, согласованность ячеек-полей ввода.

## Параметры

| Параметр      | Обяз. | Умолч. | Описание                                 |
|---------------|:-----:|---------|--------------------------------------------|
| TemplatePath  | да    | —       | Путь к макету (директория или Template.xml) |
| Detailed      | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors     | нет   | 20      | Остановиться после N ошибок                |

## Команда

```powershell
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/mxl-validate.ps1" -TemplatePath "Catalogs/Номенклатура/Templates/Макет"
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/mxl-validate.ps1" -TemplatePath "src/МояОбработка/Templates/ПечатнаяФорма"
```

