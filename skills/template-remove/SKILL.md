---
name: template-remove
description: Удалить макет из объекта 1С (обработка, отчёт, справочник, документ и др.). Вызывай только по явной просьбе пользователя.
argument-hint: <ObjectName> <TemplateName>
---

# /template-remove — Удаление макета

> **goose:** `{SKILL_DIR}` в командах — каталог этого навыка: подставь абсолютный путь из строки `Skill directory:` (раздел Supporting Files в конце). Команды запускай из корня проекта. Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` (или `python3`) с теми же параметрами.

Удаляет макет и убирает его регистрацию из корневого XML объекта.

## Usage

```
/template-remove <ObjectName> <TemplateName>
```

| Параметр     | Обязательный | По умолчанию | Описание                            |
|--------------|:------------:|--------------|-------------------------------------|
| ObjectName   | да           | —            | Имя объекта                         |
| TemplateName | да           | —            | Имя макета для удаления             |
| SrcDir       | нет          | `src`        | Каталог исходников                  |

## Команда

```powershell
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/remove-template.ps1" -ObjectName "<ObjectName>" -TemplateName "<TemplateName>" [-SrcDir "<SrcDir>"]
```

## Что удаляется

```
<SrcDir>/<ObjectName>/Templates/<TemplateName>.xml     # Метаданные макета
<SrcDir>/<ObjectName>/Templates/<TemplateName>/         # Каталог макета (рекурсивно)
```

## Что модифицируется

- `<SrcDir>/<ObjectName>.xml` — убирается `<Template>` из `ChildObjects`
- Для ExternalReport/Report: если удалённый макет был указан в `MainDataCompositionSchema` — значение очищается
