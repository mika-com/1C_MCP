---
name: web-publish
description: Публикация информационной базы 1С через Apache. Используй когда пользователь просит опубликовать базу, сервисы, настроить веб-доступ, веб-клиент, открыть в браузере
argument-hint: "[database]"
---

# /web-publish — Публикация 1С через Apache

> **OpenCode:** `{SKILL_DIR}` в командах — каталог текущего навыка. Подставь абсолютный путь к каталогу навыка, если среда не делает это автоматически. Команды запускай из корня проекта. Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` (или `python3`) с теми же параметрами.

> **Пароль (OpenCode).** Не передавай `-Password`, `/P`, `--password`, `curl -u` и заголовок `Basic`. Передай `-Database <id>`: скрипт подставит путь или сервер, пользователя и пароль из записи `databases[]` (сначала `id` и `aliases`, иначе `path` или `server`+`ref`). Нет записи — `V8_DB_USER` / `V8_DB_PASSWORD`. Явный `-Password` перекрывает файл, но shell-guard его блокирует. Значение пароля в команду и в ответ не подставляй.

Генерирует `default.vrd`, настраивает `httpd.conf` и запускает Apache HTTP Server для веб-доступа к информационной базе. При необходимости скачивает portable Apache. Идемпотентный — повторный вызов обновляет конфигурацию.

## Usage

```
/web-publish [database]
/web-publish dev
/web-publish dev --manual
/web-publish dev --port 9090
```

## Параметры подключения

Прочитай `.v8-project.json` из корня проекта и разреши базу:
1. Если пользователь указал параметры подключения (путь, сервер) — используй напрямую
2. Если указал базу по имени — ищи по id / alias / name в `.v8-project.json`
3. Если не указал — сопоставь текущую ветку Git с `databases[].branches`
4. Если ветка не совпала — используй `default`

**Передавай так:**
- **`-Database <id>`** — достаточно id базы. Скрипт сам возьмёт путь или сервер, пользователя и пароль. `-Password` и `-UserName` не передавай
- **`-V8Path`** — только если нужно перекрыть `v8path` записи. Иначе не передавай: скрипт возьмёт платформу сам
- **`-ApachePath`** — из `webPath` в `.v8-project.json` (если есть)

Если файла `.v8-project.json` нет — предложи `/db-list add`.

## Команда

```powershell
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/web-publish.ps1" <параметры>
```

### Параметры скрипта

| Параметр | Обязательный | Описание |
|----------|:------------:|----------|
| `-V8Path <путь>` | нет | Каталог bin платформы (для wsap24.dll) |
| `-InfoBasePath <путь>` | * | Файловая база |
| `-InfoBaseServer <сервер>` | * | Сервер 1С (для серверной базы) |
| `-InfoBaseRef <имя>` | * | Имя базы на сервере |
| `-UserName <имя>` | нет | Имя пользователя |
| `-Password <пароль>` | нет | Пароль |
| `-Database <id>` | нет | id базы в `.v8-project.json`: путь или сервер, пользователь и пароль берутся из записи. `-Password` не передавать |
| `-AppName <имя>` | нет | Имя публикации (по умолчанию из имени каталога базы) |
| `-ApachePath <путь>` | нет | Корень Apache (по умолчанию `tools/apache24`) |
| `-Port <порт>` | нет | Порт (по умолчанию — первый свободный, начиная с `8081`; итоговый URL печатается) |
| `-Manual` | нет | Не скачивать — только проверить и дать инструкцию |

> `*` — нужен либо `-InfoBasePath`, либо пара `-InfoBaseServer` + `-InfoBaseRef`

## Несколько пользователей одной базы

Повторный вызов с тем же AppName **заменяет** публикацию (идемпотентность). Это используется для:
- смены пользователя: «опубликуй под Ивановым» → тот же AppName, новый `-UserName`
- перезапуска после `/web-stop`: тот же вызов поднимает Apache обратно

Если пользователь просит **параллельную** публикацию под другим пользователем (для тестирования разных наборов прав), добавь суффикс к AppName:
- база `bpdemo`, пользователь `Иванов` → `-AppName bpdemo-ivanov`
- база `bpdemo`, пользователь `Admin` → `-AppName bpdemo-admin` (или просто `bpdemo`)

Ключевые слова: «ещё одну публикацию», «дополнительно», «параллельно», «под другим пользователем не убирая текущую».

## После выполнения

1. Сообщи URL-ы:
   - Веб-клиент: `http://localhost:{Port}/{AppName}`
   - OData: `http://localhost:{Port}/{AppName}/odata/standard.odata`
   - HTTP-сервисы: `http://localhost:{Port}/{AppName}/hs/<RootUrl>/...`
   - Web-сервисы: `http://localhost:{Port}/{AppName}/ws/<Имя>?wsdl`
2. Предложи открыть в браузере
3. Если нужно протестировать сервис — помоги составить запрос
4. Если база не зарегистрирована — предложи `/db-list add`

Сервисы расширений публикуются наравне с сервисами конфигурации. Если сервис расширения всё же
отдаёт 404 (HTTP) или 500 «Сервис не найден» (SOAP) — расширение не применено к базе данных:
`/db-update -Extension <имя>`.

## Примеры

```powershell
# Файловая база
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/web-publish.ps1" -InfoBasePath "C:\Bases\MyDB" -UserName "Admin"

# С явным именем публикации и портом
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/web-publish.ps1" -InfoBasePath "C:\Bases\MyDB" -AppName "mydb" -Port 9090

# Серверная база
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/web-publish.ps1" -InfoBaseServer "srv01" -InfoBaseRef "MyDB"

# Ручной режим (только инструкция)
powershell.exe -NoProfile -File "{SKILL_DIR}/scripts/web-publish.ps1" -InfoBasePath "C:\Bases\MyDB" -Manual
```
