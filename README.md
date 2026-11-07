# claude-for-arc

**[Русский](#русский) · [English](#english)**

---

## Русский

claude-for-arc даёт приложению Claude на Mac управлять браузером **Arc**: открывать вкладки, читать страницы, нажимать кнопки и заполнять формы. Работает и в обычных чатах, и во вкладке Code.

Официальное расширение Claude in Chrome в Arc не работает, поэтому и сделано это.

### Что нужно

- Mac;
- браузер [Arc](https://arc.net);
- приложение [Claude](https://claude.ai/download) для Mac;
- доступ к этому репозиторию на GitHub (если ссылка ниже открывает «404», попросите владельца добавить вас и войдите в GitHub).

Больше ничего ставить не нужно.

### Установка (2 минуты)

1. **Скачайте коннектор:** [claude-for-arc.mcpb](https://github.com/eburinu/claude-for-arc/releases/latest/download/claude-for-arc.mcpb)
2. **Откройте скачанный файл** двойным кликом. Откроется Claude с окном установки — нажмите **«Установить»**.
3. Сразу после этого сам откроется Arc со страницей расширений, а Finder покажет папку `extension`. В Arc:
   - включите **«Режим разработчика»** (Developer mode) — переключатель справа вверху;
   - нажмите **«Загрузить распакованное»** (Load unpacked) и выберите папку `extension` из Finder (путь: `~/claude-for-arc/extension`).

Готово. Значок claude-for-arc появится на панели расширений Arc. Нажмите на него: там должно быть **«Подключено к Claude»**.

> Ключ подключения копировать не нужно: коннектор сам кладёт его в папку расширения.

### Как пользоваться

Просто попросите Claude в чате или во вкладке Code, упомянув claude-for-arc или Arc:

- «Через claude-for-arc открой example.com и перескажи, что там»
- «Открой в Arc сайт погоды и скажи, будет ли завтра дождь»
- «Найди в Arc на Авито велосипеды до 20 000 ₽ и пришли 5 ссылок»

Claude попросит разрешение на действия — подтвердите.

По умолчанию Claude видит **только вкладки, которые открыл сам**. Ваши вкладки ему не видны. Это можно поменять в окне расширения.

### Обновление

Скачайте файл по той же ссылке и откройте его. Claude обновит коннектор, а расширение в Arc обновится и перезапустится само.

### Если что-то не так

| Что видно | Что сделать |
|---|---|
| В окне расширения «Сервер не запущен» | Откройте приложение Claude: коннектор работает, пока оно открыто. Проверьте, что claude-for-arc включён в настройках Claude, в разделе расширений (Settings → Extensions). |
| «Ключи не совпадают» | Закройте Claude (⌘Q) и откройте снова, потом в Arc на странице `arc://extensions` нажмите ↻ у claude-for-arc. |
| Claude пытается открыть Chrome вместо Arc | Откажитесь и напишите прямо: «через claude-for-arc …». |
| Ссылка на коннектор открывает 404 | Войдите в GitHub. Если не помогло — у вас нет доступа к репозиторию, попросите владельца. |
| На каком-то сайте не срабатывает клик | Бывает на сайтах со сложными формами или защитой от ботов. Попросите Claude попробовать по-другому или сделайте этот шаг сами. |

### Безопасность

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

Там же журнал последних действий Claude.

Ограничение: программа, запущенная на вашем Mac от вашего имени, может прочитать ключ. От вредоносных программ на самом компьютере это не защищает (как и браузер в целом).

### Удаление

1. В Claude: настройки → расширения (Settings → Extensions) → claude-for-arc → удалить.
2. В Arc: `arc://extensions` → claude-for-arc → «Удалить».
3. Удалите папки `~/claude-for-arc` и `~/Library/Application Support/claude-for-arc`.

---

## English

claude-for-arc lets the Claude app on your Mac drive the **Arc** browser: open tabs, read pages, click buttons and fill in forms. It works in regular chats and in the Code tab.

The official Claude in Chrome extension does not work in Arc, which is why this exists.

### What you need

- a Mac;
- the [Arc](https://arc.net) browser;
- the [Claude](https://claude.ai/download) app for Mac;
- access to this GitHub repository (if the link below shows "404", ask the owner to add you and sign in to GitHub).

Nothing else to install.

### Install (2 minutes)

1. **Download the connector:** [claude-for-arc.mcpb](https://github.com/eburinu/claude-for-arc/releases/latest/download/claude-for-arc.mcpb)
2. **Double-click the downloaded file.** Claude opens an install window — click **Install**.
3. Right after that Arc opens its extensions page and Finder shows the `extension` folder. In Arc:
   - turn on **Developer mode** (switch in the top right);
   - click **Load unpacked** and pick the `extension` folder from Finder (path: `~/claude-for-arc/extension`).

Done. The claude-for-arc icon appears in Arc's extensions bar. Click it: it should say «Подключено к Claude» (connected; the extension window is in Russian).

> You don't need to copy any key: the connector puts it into the extension folder for you.

### How to use

Just ask Claude in a chat or in the Code tab, mentioning claude-for-arc or Arc:

- "Using claude-for-arc, open example.com and summarize it"
- "Open a weather site in Arc and tell me if it will rain tomorrow"
- "In Arc, find used bikes under $200 on Craigslist and send me 5 links"

Claude asks for permission to act — approve it.

By default Claude sees **only the tabs it opened itself**. Your own tabs stay hidden. You can change this in the extension window.

### Updating

Download the file from the same link and open it. Claude updates the connector, and the Arc extension updates and restarts on its own.

### Troubleshooting

| What you see | What to do |
|---|---|
| The extension says the server is not running | Open the Claude app: the connector runs while it is open. Check that claude-for-arc is enabled in Claude's Settings → Extensions. |
| Keys don't match | Quit Claude (⌘Q) and open it again, then click ↻ on claude-for-arc at `arc://extensions` in Arc. |
| Claude tries to open Chrome instead of Arc | Decline and say it directly: "using claude-for-arc, …". |
| The connector link shows 404 | Sign in to GitHub. If that doesn't help, you have no access to the repository — ask the owner. |
| A click doesn't work on some site | Happens on sites with complex forms or bot protection. Ask Claude to try another way or do that step yourself. |

### Security

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

The same window shows a log of Claude's recent actions.

Limitation: a program running on your Mac as you can read the key. This does not protect against malware on the computer itself (neither does the browser).

### Uninstall

1. In Claude: Settings → Extensions → claude-for-arc → uninstall.
2. In Arc: `arc://extensions` → claude-for-arc → Remove.
3. Delete the folders `~/claude-for-arc` and `~/Library/Application Support/claude-for-arc`.

---

## For developers / Для разработки

```bash
cd server && npm ci && cd ..
node --test --test-concurrency=1 server/test/ tests/   # unit + bridge tests
node tests/worker.e2e.mjs                              # extension worker + server with mocked chrome APIs
node tests/live-arc.mjs                                # every tool in a real Arc (see the comment in the file)
bash scripts/make-mcpb.sh                              # connector: dist/claude-for-arc.mcpb
gh release create v<version> dist/claude-for-arc.mcpb  # → .../releases/latest/download/claude-for-arc.mcpb
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

Based on [OpenDia](https://github.com/aeonfun/opendia) by Aeon Inc (MIT), reworked with a focus on security.
Основано на [OpenDia](https://github.com/aeonfun/opendia) от Aeon Inc (MIT), переработано с упором на безопасность.

## License / Лицензия

MIT — see [LICENSE](LICENSE).
