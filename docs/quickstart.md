# Быстрый старт: OpenCode + навыки 1С

Краткая инструкция для запуска навыков 1С в OpenCode. Итоговый поток такой:

1. открыть проект с XML-выгрузкой 1С;
2. подключить навыки и MCP;
3. попросить агент выполнить задачу на естественном языке.

## Что нужно заранее

| Компонент | Зачем нужен |
|-----------|-------------|
| `OpenCode` | Агентная среда, которая загружает skills и использует MCP |
| `Python 3.9+` | Скрипты навыков и установщик `scripts/opencode_port.py` |
| `Node.js 18+` | MCP-серверы `1c-search`, `1c-bsl`, `1c-help` и `web-test` |
| `vanessa-runner 3.x` | Необязательно: навык и MCP `vrunner` |
| `1С:Предприятие 8.3` | Сборка, выгрузка, загрузка в базы и веб-публикация |
| `Git` | Желателен для безопасной работы и отката изменений |

## Windows: всё одной командой

На Windows шаги 1–3, установку BSL LS и Chromium делает `install.ps1` из корня проекта. Скачайте проект (ZIP или
`git clone`), откройте его папку и дважды щёлкните `install.cmd` или выполните в PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Папку проекта после установки не переносите: MCP-серверы запускаются из неё. Параметры (`-Project`, `-WithVrunner`,
`-NoBslLs`, `-NoBrowser`, `-WithDesktop`, `-Uninstall`) — в [README](../README.md#windows-одной-командой).

## Шаг 1. Получите репозиторий

```bash
git clone https://github.com/mika-com/1C-Agent.git
cd 1C-Agent
```

Если Git не нужен, можно скачать ZIP архива репозитория и распаковать его в любую папку.

## Шаг 2. Установите агента в проект

```bash
python scripts/opencode_port.py install --project-dir /путь/к/1С-проекту
# или глобально для всех проектов:
python scripts/opencode_port.py install --global
```

Установщик:
- копирует 85 навыков в `<проект>/.opencode/skills/` (глобально — `~/.config/opencode/skills/`);
- копирует агентов (`1c`, `1c-analyst`, `1c-developer`, `1c-deployer`, `1c-tester`, `1c-test-author`) в
  `.opencode/agents/` и команды `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`
  в `.opencode/commands/`;
- создаёт шаблон `AGENTS.md` в проекте, если его ещё нет;
- регистрирует MCP-серверы в `~/.config/opencode/opencode.json` (формат v2, `mcp.servers`); запись `lsp.bsl`
  прежних версий удаляет (OpenCode v2 LSP не запускает);
- ставит плагин `bsl-autocheck` (`<opencode>/plugins/bsl-autocheck.js`): после каждой правки `.bsl`/`.os` агент
  получает ошибки и предупреждения BSL LS прямо в результате правки (`--no-autocheck` — не ставить,
  `BSL_AUTOCHECK=0` — выключить; настройки — в [README](../README.md#mcp-серверы)). Перед загрузкой в базу
  каталог всё равно проверяется навыком `bsl-check`.

## Шаг 3. MCP-серверы

Регистрацию можно выполнить и отдельно:

```bash
node mcp/register-opencode-mcp.mjs            # 1c-search, 1c-bsl, 1c-help (+ vrunner выключен)
node mcp/register-opencode-mcp.mjs --vrunner  # включить vrunner-mcp (нужен vanessa-runner 3.x)
```

- `1c-search` — поиск по выгрузке; `semantic_search` — по смыслу через LM Studio (необязательно:
  [semantic-search.md](semantic-search.md), `install.cmd -Project <папка> -WithSemantic`; без LM Studio — по
  ключевым словам);
- `1c-bsl` — BSL Language Server;
- `1c-help` — синтакс-помощник по справке установленной платформы 1С (`help_search`, `help_get`, `help_members`,
  `help_status`). Справка читается локально из `bin` платформы (`shcntx_ru.hbk` и др.), в проект не входит.
  Платформа выбирается так: `V8_HELP_PATH` → `v8path` из `.v8-project.json` → самая новая установленная
  (`C:\Program Files\1cv8\<версия>\bin`, Linux `/opt/1cv8/x86_64/<версия>`). Первый вызов строит индекс
  (до ~минуты на большой справке) в `%LOCALAPPDATA%\1c-opencode\help-cache`; дальше — из кэша.
  Закрепить платформу: `[Environment]::SetEnvironmentVariable('V8_HELP_PATH', 'C:\Program Files\1cv8\8.3.25.1374\bin', 'User')`;
- `vrunner` — команды vanessa-runner как инструменты (по умолчанию `disabled: true`).

Таймауты в OpenCode v2 — объект в миллисекундах (`startup`, `catalog`, `execution`). Уточняющие вопросы агент
задаёт встроенным инструментом `question` — отдельный MCP-сервер для этого больше не нужен.

## Шаг 4. Запустите OpenCode

Откройте каталог проекта в OpenCode Desktop (или `opencode` в терминале), выберите агента **1c**.
Проверьте MCP: `/mcps` или `opencode mcp list`. `index_status` сервера `1c-search` показывает версию 1C-Agent
(файл `VERSION`) и активен ли плагин `bsl-autocheck` этой сборки.

Для длинных задач берите сильную модель. Flash и бесплатные модели выдумывают API платформы и раздувают
контекст. В `.opencode/agents/1c.md` и `1c-developer.md` есть закомментированный `model:` — конкретная модель
не задана, подставьте свою. Плагин `bsl-autocheck` перед командой PowerShell включает UTF-8 (`shell.create.before`);
на живом OpenCode этот хук не проверялся. Если в выводе оболочки кракозябры, не разбирайте его как данные.

## Шаг 5. Откройте проект 1С

Рабочий каталог агента должен быть корнем проекта, где лежат:
- XML-выгрузка конфигурации или расширения;
- каталог `src/`;
- при необходимости `.v8-project.json`.

Если проект ещё не настроен, используйте шаблон [`.v8-project.example.json`](../.v8-project.example.json)
и справочник [v8-project-guide.md](v8-project-guide.md).

## Шаг 6. Дайте первую задачу

Примеры нормальных формулировок:

- `Проанализируй конфигурацию и найди, где формируется номер заказа`
- `Используй skill meta-info и покажи структуру документа ЗаказКлиента`
- `Создай внешнюю обработку ЗагрузкаЦен и добавь форму с кнопкой Загрузить`
- `Проверь изменённые модули через bsl-check`
- `Используй MCP 1c-search и найди вызовы процедуры ПередЗаписью`

Если задача неоднозначна, агент задаст вопросы встроенным инструментом `question`.

## Шаг 7. Настройте `.v8-project.json`, если нужна база

Для операций `db-*`, `web-*`, `epf-build`, `erf-build` и `web-test` обычно нужен файл
`.v8-project.json` в корне проекта.

Минимальный пример:

```json
{
  "v8path": "C:\\Program Files\\1cv8\\8.3.27.2325\\bin",
  "databases": [
    {
      "id": "dev",
      "name": "Разработка",
      "type": "file",
      "path": "C:\\Bases\\MyApp_Dev",
      "configSrc": "src\\cf",
      "webUrl": "http://localhost:8081/dev"
    }
  ],
  "default": "dev"
}
```

Поля `user` и `password` записи базы скрипты (`epf-build`, `db-*` и другие с `-Password`) подставляют сами.
Явный `-Password` по-прежнему перекрывает запись. Если записи нет, берутся `V8_DB_USER` и `V8_DB_PASSWORD`.
Пароль в аргументы команды не пишите: он попадает в историю и в контекст модели.

Подробности: [v8-project-guide.md](v8-project-guide.md).

## Шаг 8. Веб-тесты и браузер

Для `web-test` один раз установите Playwright:

```bash
npm install --prefix "$HOME/.config/opencode" --no-fund --no-audit "playwright@^1.50.0"
npx --prefix "$HOME/.config/opencode" playwright install chromium
```

Если навыки установлены в проект, `scripts/opencode_port.py` перенастраивает `web-test`
на локальный префикс `<проект>/.opencode`.

Перед первым прогоном проверьте окружение: `node .opencode/skills/1c-test/scripts/preflight.mjs dev`
(команда `/1c-webtest` делает это сама). На Linux без графической сессии web-test запускается через `xvfb-run -a`.
Отчёты и скриншоты — в `build/reports/web/`.

## Тестирование

См. [testing-guide.md](testing-guide.md): `/1c-webtest` (web-test с preflight), `/1c-bdd` (Vanessa Automation),
YAxUnit через vrunner. Отчёты — в `build/reports/`.

## Что проверять после установки

- агент видит навыки вроде `epf-init`, `meta-info`, `form-edit`, `bsl-check`;
- в `~/.config/opencode/opencode.json` в `mcp.servers` появились `1c-search`, `1c-bsl`, `1c-help`, `vrunner`;
- в списке агентов есть `1c` и субагенты `1c-analyst`, `1c-developer`, `1c-deployer`, `1c-tester`, `1c-test-author`;
- в списке команд есть `/1c-analyze`, `/1c-implement`, `/1c-deploy`, `/1c-webtest`, `/1c-bdd`, `/1c-check`;
- в корне проекта корректный `.v8-project.json`, если вы работаете с базой;
- `Node.js` доступен из PATH;
- `Python` запускает `scripts/opencode_port.py`.

## Частые проблемы

| Проблема | Что делать |
|----------|------------|
| Агент не видит навыки | Проверьте `.opencode/skills/` проекта или `~/.config/opencode/skills/` |
| Нет `1c-search` / `1c-bsl` | Выполните `node mcp/register-opencode-mcp.mjs`, проверьте `opencode mcp list` |
| Нет строк `[bsl-autocheck]` после правки `.bsl` | Плагин ставится в `~/.config/opencode/plugins/` (или `.opencode/plugins/` проекта); проверьте `opencode plugin list`, `BSL_AUTOCHECK`, перезапустите OpenCode |
| `1c-bsl` «не подключён» | BSL LS стартует JVM — `timeout.startup` должен быть ≥ 30000 мс |
| `1c-help`: «Справка недоступна» | Нет платформы 1С со `shcntx_ru.hbk`: задайте `V8_HELP_PATH` (каталог `bin`) или `v8path` в `.v8-project.json`; проверка — `help_status` |
| `1c-help`: «сборка индекса … прервана» | Увеличьте `HELP_BUILD_TIMEOUT_MS` (мс) или повторите вызов; индекс строится один раз на версию платформы |
| `Cannot find package 'playwright'` | Повторите установку Playwright из шага 8 |
| `BSL Language Server не установлен` | Выполните `node skills/bsl-check/scripts/bsl-check.mjs -Install`  |
| Навыки не могут найти платформу | Укажите `v8path` в `.v8-project.json` |
| Агент не понимает, с какой базой работать | Добавьте `default`, `aliases` или явно укажите базу в запросе |
| Агент «висит» на большом проекте, в памяти много `java`/`bsl-language-server` | См. раздел ниже |
| Операция конфигуратора обрывается через 2 минуты | Агент должен задавать shell `timeout` (до 3600000) или `background: true`; правило есть в агенте `1c` |
| Скрипт навыка `.ps1` не запускается (ExecutionPolicy) | Запуск — `powershell -NoProfile -ExecutionPolicy Bypass -File ...` |

### Зависания и процессы BSL LS на больших конфигурациях

Раньше MCP `1c-bsl` отдавал BSL LS корень проекта. На 6–7 тыс. модулей индексация занимает 15–30 минут: вызовы ждали,
блок Code Mode прерывался, а процессы BSL LS оставались в памяти и накапливались. Теперь:

- **Сразу освободить память** (только свои процессы, чужие сеансы RDP не трогаются): `node scripts/kill-bsl-ls.mjs` (Windows: `powershell -ExecutionPolicy Bypass -File
  scripts\kill-bsl-ls.ps1`; `-DryRun` / `--dry-run` — только показать).
- **Область индексации.** По умолчанию `1c-bsl` не индексирует проект целиком. Агент регистрирует узкую папку через
  `register_workspace_folder`, а для проверки большого кода использует `bsl-check -Path <узкий каталог>`. Сразу
  отдать узкие папки: переменная `BSL_LS_ROOT=D:\1c\проект\src\cfe\МоёРасширение` (несколько — через `;`);
  вернуть старое поведение: `BSL_LS_ROOT=auto`.
- **Таймаут.** Вызов, на который BSL LS не ответил за `BSL_LS_TIMEOUT_MS` (по умолчанию 90000), сразу возвращает
  понятную ошибку.
- **Процессы.** При закрытии сеанса, сигнале или смерти OpenCode всё дерево BSL LS завершается (на Windows через
  `taskkill /T /F`). На один каталог проекта работает один экземпляр: новый гасит старый и осиротевшие
  (`BSL_LS_SINGLETON=0` — отключить). Так же запускается `vrunner-mcp` (`mcp/run-supervised.mjs`).
- **Автопроверка после правок** (`bsl-autocheck`) запускает BSL LS только по изменённым файлам, с таймаутом
  `BSL_AUTOCHECK_TIMEOUT_MS` (30 с) и гашением дерева процессов; файлы больше `BSL_AUTOCHECK_MAX_KB` (1 МБ) пропускает.
- **Память JVM:** `BSL_LS_XMX=4g`. `install.ps1` выставляет её по объёму ОЗУ, если переменная не задана.

## Несколько пользователей (RDP)

Агент рассчитан на сервер Windows, где в разных RDP-сеансах одновременно работают разные пользователи.

**Установка**
- По умолчанию установка своя у каждого пользователя: `%USERPROFILE%\.config\opencode`, переменные среды
  пользователя, `pip --user`, `winget --scope user` (если пакет так не ставится, обычная установка с запросом UAC),
  Chromium в `%LOCALAPPDATA%\ms-playwright`.
- На общем сервере удобнее поставить инструменты один раз для всех. Администратор выполняет
  `powershell -ExecutionPolicy Bypass -File install.ps1 -Machine -Users 6` в окне «от имени администратора»:
  - Git, Node.js, Python и Java ставятся через `winget --scope machine`;
  - BSL LS ставится в `C:\ProgramData\1c-opencode\tools`, в переменных машины задаются `BSL_LS_PATH` и `BSL_LS_XMX`;
  - Chromium ставится в `C:\ProgramData\1c-opencode\ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`);
  - репозиторий копируется в `C:\ProgramData\1c-opencode\repo`, у пользователей к нему доступ **только на чтение**.
- Затем каждый пользователь в своём сеансе, без прав администратора, выполняет
  `powershell -ExecutionPolicy Bypass -File C:\ProgramData\1c-opencode\repo\install.ps1`. Скрипт регистрирует навыки
  и MCP себе, берёт общий BSL LS и общий Chromium (ставит ту же версию Playwright) и ничего не скачивает повторно.
- Папку репозитория (свою или `C:\ProgramData\1c-opencode\repo`) должны читать все пользователи. Не переносите и не
  удаляйте её: MCP-серверы запускаются оттуда.

**Процессы и lock-файлы**
- `1c-bsl` гасит предыдущий или осиротевший экземпляр, только если тот принадлежит **тому же пользователю в том же
  сеансе**. Владелец проверяется через `Win32_Process.GetOwner` и `SessionId`, PID — по командной строке.
- Lock-файлы лежат в `%LOCALAPPDATA%\1c-opencode\bsl-ls`, ключ — пользователь плюс корень проекта. Если один проект
  открыт двумя пользователями, они друг друга не трогают.
- `kill-bsl-ls.ps1` и `kill-bsl-ls.mjs` завершают только процессы текущего пользователя в текущем сеансе, даже если
  запущены от администратора. Все пользователи — только явно: `-AllUsers` (`--all-users`) в окне администратора.
- Индекс `1c-help` — в `%LOCALAPPDATA%\1c-opencode\help-cache` каждого пользователя.
- Семантический поиск: LM Studio — один на сервер (127.0.0.1:1234), векторы — у каждого пользователя или общие
  (`install.cmd -Machine -WithSemantic` → `C:\ProgramData\1c-opencode\semantic`), индекс строит один процесс
  (lock-файл), см. [semantic-search.md](semantic-search.md#несколько-пользователей-rdp).
- Кэш `1c-search` и файл сеанса `web-test` (порт локального HTTP-сервера браузера) у каждого пользователя свои.
  Сервер `web-test start` слушает случайный свободный порт на 127.0.0.1.

**Порты**
- `web-publish` без `-Port` берёт первый свободный порт от 8081. Порт своего Apache считается свободным, чужой
  Apache не останавливается. Фактический URL печатается, он же нужен для `web-test` и `.v8-project.json`
  (`webUrl`).
- Apache у каждого проекта свой (`<проект>\tools\apache24`). Два пользователя с одним каталогом проекта будут
  перезапускать общий Apache, поэтому держите проекты в своих профилях.

**Память.** У каждого пользователя свой BSL LS (JVM). `install.ps1` задаёт `BSL_LS_XMX` из расчёта: половина ОЗУ
делится на число сеансов (`quser`) или на `-Users N`, но не меньше 1 и не больше 4 ГБ на пользователя.

**Общие информационные базы.** Загрузка конфигурации и `UpdateDBCfg` требуют монопольного режима и выбивают коллег.
Агенты `1c` и `1c-deployer` перед такими операциями спрашивают, свободна ли база. Лучше работать на своей копии базы.

## Следующие шаги

- Для XML-объектов: [meta-guide.md](meta-guide.md), [form-guide.md](form-guide.md), [cf-guide.md](cf-guide.md)
- Для баз и загрузки: [db-guide.md](db-guide.md), [v8-project-guide.md](v8-project-guide.md)
- Для веб-клиента: [web-guide.md](web-guide.md), [web-test-guide.md](web-test-guide.md)
- Для видеоинструкций: [web-test-recording-guide.md](web-test-recording-guide.md)
