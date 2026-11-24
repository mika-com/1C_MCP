---
name: db-dump-cf
description: Выгрузка конфигурации 1С в CF-файл. Используй когда нужно выгрузить конфигурацию в CF, сохранить конфигурацию, сделать бэкап CF
argument-hint: "[database] [output.cf]"
---

# /db-dump-cf — Выгрузка конфигурации в CF-файл

> **OpenCode:** `{SKILL_DIR}` в командах — каталог текущего навыка. Подставь абсолютный путь к каталогу навыка, если среда не делает это автоматически. Команды запускай из корня проекта. Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` (или `python3`) с теми же параметрами.

> **Пароль (OpenCode).** Не передавай `-Password`, `/P`, `--password`, `curl -u` и заголовок `Basic`. Передай `-Database <id>`: скрипт подставит путь или сервер, пользователя и пароль из записи `databases[]` (сначала `id` и `aliases`, иначе `path` или `server`+`ref`). Нет записи — `V8_DB_USER` / `V8_DB_PASSWORD`. Явный `-Password` перекрывает файл, но shell-guard его блокирует. Значение пароля в команду и в ответ не подставляй.

Выгружает конфигурацию информационной базы в бинарный CF-файл.

## Usage

```
/db-dump-cf [database] [output.cf]
/db-dump-cf dev config.cf
/db-dump-cf                          — база по умолчанию, файл config.cf
```

## Параметры подключения

Прочитай `.v8-project.json` из корня проекта и разреши базу:
1. Если пользователь указал параметры подключения (путь, сервер) — используй напрямую
2. Если указал базу по имени — ищи по id / alias / name в `.v8-project.json`
3. Если не указал — сопоставь текущую ветку Git с `databases[].branches`
4. Если ветка не совпала — используй `default`
Платформа — `v8path` найденной записи базы, иначе корневой `v8path`. Не задан ни там, ни там — `-V8Path` не передавай.
Если файла нет — предложи `/db-list add`.
Если использованная база не зарегистрирована — после выполнения предложи добавить через `/db-list add`.

## Команда

```powershell
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/db-dump-cf.ps1" <параметры>
```

### Параметры скрипта

| Параметр | Обязательный | Описание |
|----------|:------------:|----------|
| `-V8Path <путь>` | нет | Каталог bin платформы, или полный путь к `1cv8.exe` / `ibcmd.exe` |
| `-InfoBasePath <путь>` | * | Файловая база |
| `-InfoBaseServer <сервер>` | * | Сервер 1С (для серверной базы) |
| `-InfoBaseRef <имя>` | * | Имя базы на сервере |
| `-UserName <имя>` | нет | Имя пользователя |
| `-Password <пароль>` | нет | Пароль |
| `-Database <id>` | нет | id базы в `.v8-project.json`: путь или сервер, пользователь и пароль берутся из записи. `-Password` не передавать |
| `-OutputFile <путь>` | да | Путь к выходному CF-файлу |
| `-Extension <имя>` | нет | Выгрузить расширение |
| `-AllExtensions` | нет | Выгрузить все расширения |
| `-AdditionalV8Arguments <список>` | нет | Доп. аргументы запуска `1cv8.exe` через запятую, напр. `/UseHwLicenses+` |
| `-AdditionalIbcmdArguments <список>` | нет | Доп. аргументы `ibcmd` через запятую, в форме `--ключ=значение` |

> `*` — нужен либо `-InfoBasePath`, либо пара `-InfoBaseServer` + `-InfoBaseRef`

## Примеры

```powershell
# Выгрузка конфигурации (файловая база)
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/db-dump-cf.ps1" -InfoBasePath "C:\Bases\MyDB" -UserName "Admin" -OutputFile "C:\backup\config.cf"

# Серверная база
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/db-dump-cf.ps1" -InfoBaseServer "srv01" -InfoBaseRef "MyApp_Dev" -OutputFile "config.cf"

# Выгрузка расширения
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/db-dump-cf.ps1" -InfoBasePath "C:\Bases\MyDB" -UserName "Admin" -OutputFile "ext.cfe" -Extension "МоёРасширение"
```
