---
name: form-validate
description: Валидация управляемой формы 1С. Используй после создания или модификации формы для проверки корректности
argument-hint: <FormPath> [-Detailed] [-MaxErrors 30]
---

# /form-validate — валидация управляемой формы 1С

> **goose:** `{SKILL_DIR}` в командах — каталог этого навыка: подставь абсолютный путь из строки `Skill directory:` (раздел Supporting Files в конце). Команды запускай из корня проекта. Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` (или `python3`) с теми же параметрами.

Проверяет Form.xml на структурные ошибки: уникальность ID, наличие companion-элементов, корректность ссылок DataPath и команд.

## Параметры

| Параметр  | Обяз. | Умолч. | Описание                                |
|-----------|:-----:|---------|-----------------------------------------|
| FormPath  | да    | —       | Путь к файлу Form.xml                   |
| Detailed  | нет   | —       | Подробный вывод (все проверки, включая успешные) |
| MaxErrors | нет   | 30      | Остановиться после N ошибок              |

## Команда

```powershell
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/form-validate.ps1" -FormPath "Catalogs/Номенклатура/Forms/ФормаЭлемента"
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/form-validate.ps1" -FormPath "src/МояОбработка/Forms/Форма/Ext/Form.xml"
```

