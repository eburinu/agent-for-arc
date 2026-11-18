# Agent for Arc

**[Русский](#русский) · [English](#english)**

---

## Русский

Управляйте **Arc из Claude на Mac**.

> **Codex.** В релизе есть экспериментальный установщик MCP. Полноценная адаптация под Codex и проверка работы в браузере ещё впереди.

[![Claude: скачать коннектор](docs/assets/install-claude.svg)](https://github.com/eburinu/agent-for-arc/releases/latest/download/claude-for-arc.mcpb) [![Codex: промпт и команда](docs/assets/install-codex.svg)](#установка-в-codex)

### Установка в Codex

Нужны Mac, Arc и приложение Codex. Выберите один вариант, чтобы попробовать экспериментальную интеграцию.

**Вариант 1. Вставьте в локальный чат Codex**

```text
Установи claude-for-arc для Codex на этом Mac из последнего релиза https://github.com/eburinu/agent-for-arc/releases/latest.
Скачай claude-for-arc-codex.zip и файл .sha256, сверь контрольную сумму, распакуй архив и запусти install.sh.
Покажи, что нужно сделать в Arc при первой установке, и напомни перезапустить Codex.
```

**Вариант 2. Вставьте одну строку в Терминал**

```bash
( d=$(mktemp -d) && cd "$d" && u=https://github.com/eburinu/agent-for-arc/releases/latest/download && curl -fsSL -O "$u/claude-for-arc-codex.zip" -O "$u/claude-for-arc-codex.zip.sha256" && shasum -a 256 -c claude-for-arc-codex.zip.sha256 && ditto -x -k claude-for-arc-codex.zip . && bash claude-for-arc-codex/install.sh )
```

При первой установке в Arc включите **Developer mode**, нажмите **Load unpacked** и выберите папку из Finder. Если расширение уже установлено, пропустите этот шаг. Перезапустите Codex и в новом чате попросите: «Через Arc открой example.com и прочитай заголовок».

### Установка в Claude

**Скачайте коннектор и откройте его. Затем один раз разрешите расширение в Arc.**

1. Нажмите **[Скачать claude-for-arc](https://github.com/eburinu/agent-for-arc/releases/latest/download/claude-for-arc.mcpb)**.
2. Откройте скачанный `.mcpb` двойным щелчком. В Claude нажмите **«Установить»**.
3. В открывшемся Arc включите **Developer mode** → **Load unpacked** и выберите папку `extension`, которую откроет Finder (`~/claude-for-arc/extension`).

**Готово.** Нажмите значок расширения в Arc: статус должен быть **«Подключено к Claude»**. Больше ничего настраивать не нужно. Ключ подключения добавляется автоматически.

Для установки нужны Mac, Arc и приложение [Claude для Mac](https://claude.ai/download).

### Как пользоваться

Попросите Claude выполнить действие в Arc:

- «Через claude-for-arc открой example.com и перескажи, что там»
- «Открой в Arc сайт погоды и скажи, будет ли завтра дождь»
- «Найди в Arc на Авито велосипеды до 20 000 ₽ и пришли 5 ссылок»

Для серии однотипных действий попросите: «Выполни это одной серией». Если пользуетесь и Claude, и Codex, обновите коннектор Claude до 0.5.0, чтобы чаты не прерывали уже начатую работу в Arc.

По умолчанию Claude видит **только вкладки, которые открыл сам**. Ваши вкладки ему не видны. Это можно поменять в окне расширения.

### Обновление

Скачайте файл по той же ссылке и откройте его. Claude обновит коннектор и расширение в Arc. Для Codex повторите установку одним из способов выше.

### Если не подключается

| Что видно | Что сделать |
|---|---|
| В окне расширения «Сервер не запущен» | Откройте приложение Claude: коннектор работает, пока оно открыто. Проверьте, что claude-for-arc включён в настройках Claude, в разделе расширений (Settings → Extensions). |
| «Ключи не совпадают» | Закройте Claude (⌘Q) и откройте снова, потом в Arc на странице `arc://extensions` нажмите ↻ у claude-for-arc. |
| Claude пытается открыть Chrome вместо Arc | Откажитесь и напишите прямо: «через claude-for-arc …». |
| Ссылка на коннектор открывает 404 | Откройте [последний релиз](https://github.com/eburinu/agent-for-arc/releases/latest) и скачайте коннектор из списка файлов. |
| На каком-то сайте не срабатывает клик | Бывает на сайтах со сложными формами или защитой от ботов. Попросите Claude попробовать по-другому или сделайте этот шаг сами. |

### Настройки и безопасность

- Всё работает только на вашем Mac. Сервер и расширение общаются через `127.0.0.1` и перед любой командой проверяют друг друга по секретному ключу. Сайты, другие расширения и чужие программы подключиться не могут.
- Поля паролей, одноразовых кодов и данных карт Claude **не читает и не заполняет**.
- Открываются только обычные сайты (`http`/`https`). Страницы настроек, файлы и магазины расширений — нет.
- По умолчанию в чёрном списке менеджеры паролей. Список можно дополнить.

Настройки в окне расширения:

| Настройка | По умолчанию | Что делает |
|---|---|---|
| Только вкладки, открытые Claude | **вкл** | Claude видит и трогает только свои вкладки |
| Только чтение | выкл | Запрещает клики, ввод и закрытие вкладок |
| История и закладки | **выкл** | Доступ к истории и закладкам только после разрешения |
| Запрещённые сайты | менеджеры паролей | Эти сайты Claude не открывает и не читает |
| Пауза | выкл | Мгновенно запрещает любые действия |

В окне расширения также доступен журнал действий. Программы, запущенные на вашем Mac от вашего имени, могут прочитать ключ подключения.

### Удаление

1. В Claude удалите claude-for-arc в настройках расширений. В Codex удалите `arc` в **Settings → MCP servers**.
2. В Arc: `arc://extensions` → claude-for-arc → «Удалить».
3. Удалите папки `~/claude-for-arc` и `~/Library/Application Support/claude-for-arc`.

---

## English

Control **Arc from Claude on your Mac**.

> **Codex.** The release includes an experimental MCP installer. Full Codex support and end-to-end browser testing are planned.

[![Claude: download connector](docs/assets/install-claude.svg)](https://github.com/eburinu/agent-for-arc/releases/latest/download/claude-for-arc.mcpb) [![Codex: prompt and terminal command](docs/assets/install-codex.svg)](#install-in-codex)

### Install in Codex

You need a Mac, Arc, and the Codex app. Choose either option to try the experimental integration.

**Option 1. Paste into a local Codex chat**

```text
Install claude-for-arc for Codex on this Mac from the latest release at https://github.com/eburinu/agent-for-arc/releases/latest.
Download claude-for-arc-codex.zip and its .sha256 file, verify the checksum, extract the archive, and run install.sh.
Show me the first-time step in Arc and remind me to restart Codex.
```

**Option 2. Paste one line into Terminal**

```bash
( d=$(mktemp -d) && cd "$d" && u=https://github.com/eburinu/agent-for-arc/releases/latest/download && curl -fsSL -O "$u/claude-for-arc-codex.zip" -O "$u/claude-for-arc-codex.zip.sha256" && shasum -a 256 -c claude-for-arc-codex.zip.sha256 && ditto -x -k claude-for-arc-codex.zip . && bash claude-for-arc-codex/install.sh )
```

For a first-time install, turn on **Developer mode** in Arc, click **Load unpacked**, and select the folder Finder opens. If the extension is already installed, skip that step. Restart Codex and ask in a new chat: "Open example.com in Arc and read its heading."

### Install in Claude

**Download and open the connector. Then allow the extension in Arc once.**

1. Click **[Download claude-for-arc](https://github.com/eburinu/agent-for-arc/releases/latest/download/claude-for-arc.mcpb)**.
2. Double-click the downloaded `.mcpb`. In Claude, click **Install**.
3. In Arc, which opens automatically, enable **Developer mode** → **Load unpacked** and choose the `extension` folder opened by Finder (`~/claude-for-arc/extension`).

**Done.** Click the extension icon in Arc; its status should say **Connected to Claude**. No other setup is needed. The connection key is added automatically.

You need a Mac, Arc, and the [Claude app for Mac](https://claude.ai/download).

### How to use

Ask Claude to do something in Arc:

- "Using claude-for-arc, open example.com and summarize it"
- "Open a weather site in Arc and tell me if it will rain tomorrow"
- "In Arc, find used bikes under $200 on Craigslist and send me 5 links"

For repeated actions, ask: "Do this as one sequence." If you use both Claude and Codex, update the Claude connector to 0.5.0 so chats leave in-progress Arc actions alone.

By default Claude sees **only the tabs it opened itself**. Your own tabs stay hidden. You can change this in the extension window.

### Updating

Download the file from the same link and open it. Claude updates the connector and Arc extension. For Codex, repeat either install option above.

### If it won't connect

| What you see | What to do |
|---|---|
| The extension says the server is not running | Open the Claude app: the connector runs while it is open. Check that claude-for-arc is enabled in Claude's Settings → Extensions. |
| Keys don't match | Quit Claude (⌘Q) and open it again, then click ↻ on claude-for-arc at `arc://extensions` in Arc. |
| Claude tries to open Chrome instead of Arc | Decline and say it directly: "using claude-for-arc, …". |
| The connector link shows 404 | Open the [latest release](https://github.com/eburinu/agent-for-arc/releases/latest) and download the connector from its assets. |
| A click doesn't work on some site | Happens on sites with complex forms or bot protection. Ask Claude to try another way or do that step yourself. |
| A site asks you to select a file | Use the system picker yourself, or use `element_fill` with `file: { name, base64, mime_type }` to attach supplied bytes (up to 1 MiB, with optional `mime_type`). The tool accepts a filename and contents. |

### Settings and security

- Everything stays on your Mac. The server and the extension talk over `127.0.0.1` and prove a shared secret key to each other before any command. Websites, other extensions and other programs cannot connect.
- Claude **never reads or fills** password, one-time code or card fields.
- Only regular websites (`http`/`https`) can be opened — no settings pages, local files or extension stores.
- Password managers are blocked by default. You can add more sites.

Settings in the extension window:

| Setting | Default | What it does |
|---|---|---|
| Only tabs opened by Claude | **on** | Claude sees and touches only its own tabs |
| Read only | off | No clicks, typing or closing tabs |
| History and bookmarks | **off** | History and bookmark access only after you allow it |
| Blocked sites | password managers | Claude never opens or reads these sites |
| Pause | off | Instantly blocks every action |

The extension window also shows an activity log. Programs running on your Mac as you can read the connection key.

### Uninstall

1. In Claude, uninstall claude-for-arc in Settings → Extensions. In Codex, remove `arc` in **Settings → MCP servers**.
2. In Arc: `arc://extensions` → claude-for-arc → Remove.
3. Delete the folders `~/claude-for-arc` and `~/Library/Application Support/claude-for-arc`.

---

## For developers / Для разработки

```bash
cd server && npm ci && cd ..
node --test --test-concurrency=1 server/test/ tests/   # unit + bridge tests
node tests/worker.e2e.mjs                              # extension worker + server with mocked chrome APIs
node tests/live-arc.mjs                                # every tool in a real Arc (see the comment in the file)
node tests/live-speed.mjs                              # 10 messages: one call per action vs run_steps, no double sends
bash scripts/make-mcpb.sh                              # connector: dist/claude-for-arc.mcpb
bash scripts/make-codex.sh  # dist/claude-for-arc-codex.zip
gh release create v<version> dist/claude-for-arc.mcpb dist/claude-for-arc-codex.zip
```

Versions in `extension/manifest.json`, `server/package.json` and `mcpb/manifest.json` must match; bump them for every release so the extension folder gets refreshed.

Layout:
- `mcpb/manifest.json` — the Claude connector manifest;
- `server/server.js` — MCP over stdio and the authenticated WebSocket bridge;
- `server/deploy.js` — places the extension (with `key.json`) in `~/claude-for-arc/extension` and asks an outdated one to reload;
- `extension/src/background/guard.js`, `policy.js` — access rules;
- `extension/src/background/background.js` — connection and tools;
- `extension/src/content/content.js` — page interaction.

The extension ID is pinned by the `key` in `extension/manifest.json`: `dllpmmijlpleaoifjffigbcilgmhjpla`; the server accepts only it.

Older install path without the connector (needs Node.js 18+, Claude Code only by default): `bash scripts/install.sh`, diagnostics `bash ~/claude-for-arc/scripts/doctor.sh`, archive `bash scripts/make-release.sh`.

## Credits / Благодарности

Agent for Arc is developed and maintained by [Ivan Belov (@eburinu)](https://github.com/eburinu).
Agent for Arc разрабатывает и поддерживает [Иван Белов (@eburinu)](https://github.com/eburinu).

Based on [OpenDia](https://github.com/aeonfun/opendia) by Aeon Inc (MIT), reworked with a focus on security.
Основано на [OpenDia](https://github.com/aeonfun/opendia) от Aeon Inc (MIT), переработано с упором на безопасность.

## License / Лицензия

MIT — see [LICENSE](LICENSE).
