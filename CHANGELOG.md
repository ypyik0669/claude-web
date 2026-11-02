# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

Every version's changes are recorded here; installers are on the [Releases](https://github.com/ypyik0669/claude-web/releases) page. Versions follow [semantic versioning](https://semver.org/).

## [0.5.2] — 2026-11-02

### Fixed

- **New Codex conversations show up in the library again after the Codex desktop app updates.** The library listed Codex conversations with the configured `codex` command — often an older CLI on PATH — which can't read what a newer Codex stored, so conversations started after the update never appeared. With the Codex desktop app installed, its own CLI (always as new as the app) now lists and reads them first; the configured command is the fallback.

## [0.5.1] — 2026-11-02

### Fixed

- **A duty bot can't reach its own policy through a mapped drive whose path has a short (8.3) folder name.** Folding a mapped drive back to the local path now resolves the short name too.

## [0.5.0] — 2026-11-02

### Added

- **Duty bots.** The icon rail has 「Bot」: teammates that live on your computer. The left column is the roster (each bot has its own face, its last line and an unread count; the ones that need you come first), the middle is your conversation with it, and the right column is its profile, computer, routines, permissions, memory and usage.
  - **Made by talking**: ＋, pick a face, a name and a folder (or one of 14 templates), and it speaks first with a few choices; say "every day at 9, check …" and it makes the routine itself (with an end date).
  - **Works while you're away**: routines run on schedule and each run is a card in the conversation; 「值班模式」 in Settings keeps them running with the window closed.
  - **Actions go through its policy first**: reading and local writes just happen, installs happen and tell you, sending out, paying and deleting ask you first — on an approval card right in the conversation (Deny / Allow ▾: just this once, for this run, always for this target, always). A bot can't change its own policy: it can only propose a 「规矩」 card, which takes effect when you accept it.
  - A bot's conversations stay out of the conversation list; daily budgets, quiet hours and IM notifications can be set.
- **Web search is always in the model's tool list**, so research doesn't spend turns finding it first.

### Fixed

- **Codex conversations sync again after Codex desktop 0.166.** The new Codex names its session files with a second UUID (`…-<session>_<another>.jsonl`); the last one was taken as the session, so open Codex conversations stopped updating at the moment of the upgrade.

## [0.4.6] — 2026-10-30

### Fixed

- **Switching a conversation to a relay and back no longer breaks it with "Invalid `signature` in `thinking` block".** A relay signs Claude's thinking its own way, and the account's API refuses those signatures; the automatic repair only removed unsigned thinking, so 重试 kept failing. Switching back now removes the thinking that other providers wrote (your account's own stays), and if the API still refuses a signature, every thinking block is removed so the retry goes through.
- **Workflow agents show the subagent model they really run on.** With a subagent model picked (for example DeepSeek under a GPT main model), the agents of a workflow / 深度编排 already ran on it, but their cards said the main model. Running and finished runs now show the real one.
- **"EMFILE: too many open files" after the app has been running for a while.** Reading the first line of a conversation record left the file open each time; after about 8,000 of these Windows refused to open any file, so saving a provider (and anything else) failed. The file is now always closed. Restarting the app clears it on older versions.

## [0.4.5] — 2026-10-30

### Added

- **Every installed MCP server can be edited.** Connectors has a pencil on each connected server, and Settings → MCP has 「编辑」: change the command, its arguments and environment variables, or the URL and headers of an HTTP / SSE server. The server is saved back where it was (every project, the project's `.mcp.json`, or this project on this computer). Values that look like keys show as dots and stay as they are unless you change them, and they keep their value when you rename the variable. If a save fails, the old configuration is put back.
- **Importing finds MCP servers in more apps**: Pencil, Trae / Trae CN, Antigravity, LM Studio, VS Code Insiders and VSCodium. Cline and Roo Code are found in every VS Code-style editor, not only VS Code.

### Fixed

- **Conversation names no longer turn into the latest message.** A renamed conversation could show its most recent message as its name — while chatting and after a restart — once the conversation grew long, and a conversation that was never renamed kept changing its name to whatever was said last. Names are now read from the whole conversation: your own name first, then the name Claude Code gave it, then the first question. Never the latest message.
- **Pencil's MCP server can be imported in a form that keeps working.** The Pencil extension writes its server into other tools with a path inside a versioned extension folder, which disappears when the extension updates. Import now reads the copy Pencil keeps in `~/.pencil/mcp/`, which has no version in its path.
- **Import marks servers whose program is gone** with 「程序不在了」 and leaves them unticked, instead of importing a server that cannot start.

## [0.4.3] — 2026-10-28

### Added

- **The privacy page's local model downloads completely inside the app.** One button, 「下载运行库和模型」, fetches the model and the onnxruntime runtime it needs (about 154 MB, each file checked against its published hash) into the app's data folder. No terminal, no `npm i`, no restart. 「删除模型和运行库」 removes both.
- **Client fingerprint can be set per account**, not only per provider (模型 → 设置 → 客户端指纹).

### Fixed

- **Choosing a project folder works from any browser** ([#12](https://github.com/ypyik0669/claude-web/issues/12)). On Linux without zenity or a display, and from a browser on another computer, 「打开文件夹」 did nothing. When the system's folder dialog can't be shown, the app now opens its own folder browser: it lists the folders on the computer running Claude Web, lets you go up, type a path, show hidden folders, and make a new folder. On Linux, kdialog is tried when zenity is missing.
- **Settings and dialogs no longer show the system's own controls.** Dropdowns, checkboxes and text boxes that rendered as plain Windows widgets (模型 → 设置, sharing and LAN, sync, routing rules, plugins, the provider editor, several settings sections and dialogs) now use the app's own dropdowns, switches and fields; the LAN IP allow-list is laid out properly.
- **Menus near the top of the window can be clicked everywhere.** The top rows of a sidebar conversation's right-click menu sat over the window's drag strip and did nothing; every menu, list and dialog is now exempt from it.
- **Menus no longer open under the window's minimise / maximise / close buttons.** The conversation header's ⋯ menu could open behind them; menus near the top right now open below them.
- **A share key with nothing ticked is told so plainly** (403 「这个密钥还没有可用的网关组」) instead of "name a group" with an empty list.

## [0.4.2] — 2026-10-28

This release turns the 上游 (upstream) page into a full model hub: one place for every model source — free ones, subscriptions, relays — with smart routing across them, privacy masking on the way out, plugins, sync and sharing. The techniques that CLIProxyAPI and Magpie use are now built into Claude Web itself, and both programs ship inside the installer for the logins only they can do.

### Added

**Model hub**

- **One page for every model source:** overview, sources, routing, computer control, usage, privacy, plugins, connected agents and settings. The sources page lists 44 ready-made sources (free and paid) as cards with a filter; adding one is one step.
- **Import from other tools:** CLIProxyAPI's `config.yaml` and Magpie's `providers.json`.
- **Sign in with subscriptions:** Codex (OAuth), GitHub Copilot (device code), your local OpenCode and Claude logins, and — through the bundled CLIProxyAPI / Magpie — Gemini, Antigravity, Kimi, Grok, Qoder, Trae CN, WorkBuddy, ZCode, Kiro, Devin, Factory, MiMo and Cline. Account files exported by Sub2API-style tools can be imported.
- **CLIProxyAPI and Magpie are in the installer** (no download needed), with SHA-256 checks and rollback.
- **Claude subscription as a source:** answers plain-text requests with your own `claude` command and subscription. Off by default; guarded against looping back into Claude Web.

**Smart routing**

- **Pick a strategy instead of a model:** Auto, Free first, Performance first, Capability first, or Custom. Candidates are filtered by what the request needs (tools, images, context) and what you allowed (paid, budget).
- **Seven ways to order candidates** (smart score, in order, round-robin, least used, use up before reset, weighted, fastest first), plus optional intent rules judged by a model you choose ("code" → this model).
- **See every decision:** which candidates were considered, why each was excluded, scores, the pick and each attempt.
- **Quota-aware:** remaining quota is read from upstream rate-limit headers; a 429 puts a source on cooldown until it resets.
- **Source health:** a check button reads the model list and, for free sources, makes one real 1-token call.

**Gateway**

- **Thinking signatures are cleaned per target** (Claude, Gemini, GPT, Grok, Kimi), so switching providers mid-conversation no longer causes 400s; signed reasoning a client drops is put back from a cache.
- **WebSocket for Codex:** `/v1/responses` and `/v1/ws` work over WebSocket, with the same auth, routing and failover as HTTP.
- **Client fingerprint (opt-in, per source):** requests can look like Claude Code, Codex CLI or Gemini CLI — user agent, header and field order, TLS handshake. Settings → Client fingerprint.
- **OpenTelemetry export (opt-in):** request spans with model, source, latency, tokens and status — never prompts or keys.

**Privacy**

- **Masking before anything leaves your computer:** keys, private keys, JWTs, config secrets, email, phone, CN ID / bank card, Chinese names, addresses, your own words and regexes. Mask, warn or block per type; answers get the real values back.
- **Changes apply immediately**, no restart.
- **Covers Codex with a ChatGPT login and Gemini CLI with a Google login** too; agents that cannot be covered are marked on the page.
- **Logs and diagnostic bundles are masked as well.**
- **Optional local model** (AstrLink Guard) finds personal data the rules miss; downloaded on demand and checked by SHA-256.

**Plugins, sync and sharing**

- **Plugins:** declarative sources, and executable plugins that run in their own process with Node's permission model — reads limited to their folder, writes to their data folder, no child processes unless you allow it, a memory cap. Approval covers the code: a plugin whose code changes asks again. A signed plugin market installs in one click.
- **Sync:** encrypted bundles merged item by item (both credentials kept on a conflict), to a file or to WebDAV / S3 / GitHub.
- **Share keys:** give someone a key to your gateway with its own sources, models, concurrency and daily / weekly / monthly quotas. A share key reaches nothing until you tick what it may use; subscriptions only if you allow; paid sources only within its own daily budget.
- **Signed remote model catalog:** add your own https list and Ed25519 key.

**Agents and computer control**

- **Connected agents page:** every agent's model and reasoning settings, and a warning when its config file was changed outside Claude Web, with re-apply, keep or restore.
- **Computer control on Windows uses UI Automation:** Claude finds buttons and fields by name instead of guessing pixels (29 tools). A window you allowed can no longer be used to act on one you did not.
- **Full access really asks nothing**, browser scripts and computer control included; otherwise "Allowed sites" is the only list that decides.
- **ego lite is the browser agents act in first** when it is installed (checked with ego-browser 2.1.0).

### Fixed

- **Outbound requests to addresses you entered (sync, plugin market, catalog, telemetry) are guarded:** cloud metadata and link-local addresses are always refused, every DNS answer and redirect is checked, and credentials never follow a redirect to another host.
- **Share key "retry after" is right:** weekly and monthly limits pointed to the next midnight; daily limits were off by the time zone.
- **Managed programs get a minimal environment** (no keys or tokens), and a release without a published SHA-256 installs only after you confirm its hash.
- **A crafted sync file cannot change your settings** beyond routing, models and privacy, and cannot point a saved key at another host.
- **A reply only gets back the secrets its own request masked.**
- **Empty arguments survive Windows `.cmd` launchers** (they used to vanish, shifting the next flag).

## [0.4.1] — 2026-10-26

### Fixed

- **The question card works again.** When Claude asked something (AskUserQuestion), the conversation showed only the question and "Waiting for an answer…", with no options, Skip or Commit, so the only way out was replying in the input box. A new question was appended to the old list, and the card never recomputed.
- **Subagents can use the model gateway's models while the main model is on another relay.** Switching the main model to another provider used to drop the gateway's whole section (account pools such as WorkBuddy) from the subagent menu. The subagents' requests now go to that gateway group, with its members and failover as usual.

### Changed

- **Every model gets the thinking-strength parameter.** A relay's logs showed Kimi (kimi-k3.1-pro) requests never carried `reasoning_effort` while DeepSeek's did: only models we knew got the parameter, the rest only a line in the prompt. Now:
  - OpenAI-format relays: every model gets `reasoning_effort`; a model nobody describes gets the standard low / medium / high.
  - Claude-format relays: non-Claude models there get a thinking budget too.
  - The model gateway used to drop the strength when converting formats; it now turns it into the target format's parameter (`reasoning_effort`, Gemini's thinkingConfig…) at the levels that model supports.
  - When an upstream refuses the parameter, that turn is resent without it and the model goes through the prompt from then on; the conversation does not fail.

## [0.4.0] — 2026-10-26

This release mostly catches up with the official desktop app and the Codex app: a much stronger built-in browser, a question card, projects with several folders, node graphs, auto-handling of PR comments, GitLab, screen recording, WSL / SSH, and local versions of a few claude.ai cloud features. The bundled engine is now 2.8.4-cw.7.

### Added

**Built-in browser**

- **Claude uses web pages like a person.** It can hover, drag, select text and run scripts. It reads the page's console, network requests and structure, waits for text or an element to appear, opens and closes its own tabs, and resizes the viewport. While it works you see its cursor on the page; you can take over at any time and hand back when done.
- **New sites ask first.** The first visit to a site, or running a script in a page, asks you. Allowed sites can be reviewed and removed in settings.
- **Page annotation.** Pick elements and draw with pen / box / text; "Send to Claude" turns it into one attachment.
- **The browser itself is complete:** loading bar, find in page, per-tab zoom, downloads bar, viewport presets, save screenshot, open a local HTML file, import cookies from a file, clear browsing data, stop loading.
- **The preview reloads after front-end files change.** Page errors show as "Preview has N errors" with "Let Claude fix". The last previewable file Claude wrote in a turn opens when the turn ends.
- **Links in replies open in the built-in browser** (Ctrl / Cmd for the system browser).
- **Record Claude's actions:** with the ⋯ switch on, the conversation's tab is recorded from its first browser action to the end of the turn.

**Conversations**

- **Question card.** When Claude asks you something (AskUserQuestion), a card appears in the conversation: one question per page, with paging, skip, "Other" and multi-select, all usable from the keyboard.
- **Node graphs.** ```nodegraph blocks in replies are drawn as graphs you can drag and zoom; Mermaid flowcharts switch between node graph and source. The background command center and orchestra run view are node graphs too.
- **Double-click selects one word** (a whole inline code span). The selection menu gets a side question with the quote filled in.
- **Screen recording** from the + menu, with our own picker for screens, windows and built-in browser tabs. The extracted keyframes are shown before sending, each with a remove button.

**Projects and sidebar**

- **A project can have several folders**, added in "Edit project". Files, search, Git and @file list all of them, and conversations in the project can read and write them.
- **Project page:** project instructions (added to new conversations), project files, the project's conversations.
- **One "View" menu in the sidebar:** group by project / folder / date or not at all, sort, items per group, and your own sections (drag in, or right-click "Add to section").

**PR / Git**

- **Auto-handle PR comments.** With the switch on in the PR bar, comments from people with write access go to the conversation five at a time, and replies are posted after the push. With two windows open only one handles them.
- **GitLab.** The PR bar understands GitLab MRs: pipelines, merge when the pipeline succeeds, job logs, comments.

**Run elsewhere**

- **WSL.** A new conversation can pick a WSL distro and run Claude Code inside it; files, Git and the terminal go through `\\wsl.localhost`.
- **SSH machines.** "Pick machine → Add SSH machine…" with address, user and key, and a connection test. A host trusted for the first time shows its fingerprint to compare.

**Local versions of claude.ai features**

- **Hand off to an always-on machine:** pass a conversation, with its uncommitted changes, to another machine that stays on, and fetch it back later. New untracked files go only when you tick them, and files like `.env` and private keys never go. A handed-off conversation is read-only here.
- **Publish a page:** turn an HTML page into a link (optional expiry, revoke any time). Only the styles, scripts and pictures the page really uses are copied, and the file list is shown before publishing.
- **Import a claude.ai data export:** conversations go into the library and can be continued in Claude; its projects become projects here.
- **Dispatch:** send a task to a project from the phone drawer or IM.

**Context and compaction**

- **Every provider and every Claude account can set its own auto-compact point**, which beats settings.json.
- **A Claude account can pick 200K or 1M per model family.** The context card title and the model menu show the window and the compaction point.

### Changed

- **Appearance → Background animation (on / off)** replaces "Animated background on the new conversation page".
- **The context card is faster:** it no longer recounts after every turn, only when opened and on Refresh. Each category keeps one colour, biggest first.

### Fixed

- **Menus are no longer cut off** (a list's fade mask clipped them).
- **Cafe:** the page scrolling no longer zooms it; small trackpad scrolls no longer make the zoom run away.
- **The desktop window only ever shows the app's own page**; a crashed page reloads itself (stops after three in a minute).
- **File links in replies:** `#L12-L20` opens at line 12; `file:///` and `C:\` links are no longer blanked; network-path links (`\\host\…`) open nothing and never reach out over SMB.
- **A busy computer no longer gets "failed to start".** The desktop app used to wait only 30 seconds for the server, and a cold start with the CPU maxed out took longer. Now it waits up to 3 minutes while the server is alive, and after 20 seconds the splash says the computer is busy.
- **A sudden reboot no longer wipes your settings.** meta.json (providers, keys, projects, switches) could be renamed before its data reached the disk and come back all zero bytes. Every save is now flushed to disk first, a `meta.json.bak` is kept, and a broken file is recovered from it.
- **The phone page moved to an address that opens in mainland China**, `https://cw.y0p66y9.me/` (github.io needs a VPN there). The same server runs our own matchmaking server, which only carries encrypted data. Phones paired before need to scan the code again; github.io can still be chosen in settings.
- Codex: a project's extra folders are added to your own `writable_roots` instead of replacing them.

## [0.3.2] — 2026-10-23

### Fixed

**Relays and models**

- **A relay's log is no longer full of "non-streaming" Claude calls, and the 403s and disconnects that came with them are gone.** At the end of every turn Claude Web asked how full the context was; the built-in core counts that part by part, and where a relay has no token-counting endpoint it sent one non-streaming, 1-token request per part (about 30 a turn, on the main model) with no Claude Code system prompt — a relay's log showed a row of "非流 1 t/s", relays that check for Claude Code refused them with 403, and the input was billed at the main model's price. The composer's context ring and the status strip now read the last answer's usage (as the official CLI's indicator does — no request); the info column's context breakdown is fetched once when you unfold it and again on 刷新; and the built-in core (2.8.4-cw.6) estimates locally when counting fails, like the official client, instead of sending those requests.
- **Thinking strength works on the gpt-6 family (e.g. gpt-6-astra).** The rule stopped at gpt-5, so gpt-6 was treated as a model that does not reason: the strength went into the prompt only, with no `reasoning_effort` in the request (a relay's log showed an empty effort column). gpt-5 and every later gpt now get OpenAI's native parameter.
- **DeepSeek through the WorkBuddy component shows its thinking.** The gateway dropped an OpenAI-format upstream's `reasoning_content` (DeepSeek, Qwen, Kimi, WorkBuddy) / `reasoning`; it now becomes a thinking block before the answer.
- **A conversation on Gemini web / WorkBuddy no longer warns "over 170 KB" on its first message.** The lean tool set also lost tool search, so every MCP tool's schema was inlined and the request ended up larger than the full set; such conversations now run without MCP servers (about 62 KB). The cost: no web or shared-memory tools there. The "conversation too large" notice names the conversation and the member.

**DeepSeek Harness**

- **A dsh conversation in the library now goes on in Claude.** Sending used to show only your own message, answered by `no API key for provider route`. The whole history is now written into a new Claude conversation that carries on with the provider you pick (or the default), and later messages go to the same one; what you say in dsh afterwards is brought over automatically (when it opens, before you send, and as soon as dsh writes). Nothing is ever written to dsh's own log. Three reading bugs were fixed too: the newer (v4) log missing the latest turns after an upgrade, the two tool-result shapes, and tool calls shown twice.

**Built-in browser**

- **Google sign-in works.** It always ended in "Couldn't sign you in / This browser or app may not be secure": our cleaned-up user agent claims Chrome while the browser's other signals say otherwise, which Google treats as an impostor. Google's sign-in pages now get Electron's own user agent; every other site is unchanged.

## [0.3.1] — 2026-10-21

### Fixed

**DeepSeek Harness**

- **The desktop app from deepseek.com is found, wherever it was installed.** Its Download button gives an Electron app whose `dsh` command lives inside the install folder and is deliberately kept off PATH — so an install showed up as “not installed”. The install folder is now read from the Windows uninstall entry (which follows a custom folder too), with the usual folders and the macOS `.app` as fallbacks. Click 重新检测, or wait a minute, and it is detected.
- **And it starts.** That `dsh` launcher runs a script inside `app.asar` with the app's own Electron binary; plain `node` cannot read an asar archive, so the launcher now goes through `cmd.exe` instead of being unwrapped into `node`.
- **Its conversations read the way they were written.** The runtime records its own injections (working folder / sandbox snapshot, the skill list) as user messages — those are skipped, so a history no longer looks like you pasted a wall of text before each question. Reasoning blocks are shown as thinking again.

Two tests that could not pass on macOS / Linux were fixed (a path built for the host platform instead of the one asked for, and a symlinked temp dir).

## [0.3.0] — 2026-10-21

### Added

**Gateway: one address for every account**

- **The gateway is simpler to start with.** It now opens on just 概览 / 账号 / 任务. Add an account and it goes into a 默认 group automatically, so the root `/v1` address works without creating pools, groups or keys; the overview shows the address and a one-click "copy key". Pools, route groups, keys, the audit log and LAN settings are under 高级设置. The Tasks page has three one-click presets (daily check-in, keepalive every 6 hours, daily quota refresh), and the account dialog is three big buttons and one Add button.
- **The address stays put.** It used to pick a new port on every start, so an address copied elsewhere stopped working the next day. The gateway now has a port of its own; changing it listens on the new one first and only then switches, keeping the old one if that fails. Note: upgrading from an older build moves the port once — the overview page shows the current one.
- **A gateway group is a provider.** Add an account and its group shows up in the model menu; there is no second step of creating a provider. Deleting that provider means "keep this group out of the menu", and it is not recreated on its own.
- **Gemini web and WorkBuddy accounts, in the gateway with the Claude ones.** Each family runs its own pinned MIT sidecar on this computer: downloaded and SHA256-checked on first use (or already bundled with the installer), supervised with health checks, automatic restarts and a log you can read in the app. Their models appear in `/v1/models`, and their account pools can be gateway members next to Claude accounts and providers.
- **A Gemini web account is added by signing in with this computer's Chrome.** Click "sign in to Google" and Chrome (Edge if there is none) opens at Google's sign-in page; once you are signed in to Gemini, close that window and the account is added. It keeps a sign-in of its own and does not touch the Chrome you use day to day. Pasting cookies works too (one per line, in batches), and the dialog says what is missing as you paste — including the common case of copying only the gemini.google.com row.
- **Residential exits and anti-ban settings.** The Gemini card manages a pool of exits (http / https / socks5, credentials included): an account remembers the exit it used and keeps leaving from the same IP, and the sign-in window uses that same exit, so signing in and calling out come from one address. An unreachable exit is an error — it never quietly falls back to a direct connection. An exit that keeps failing is tripped and put back after a cooldown, with its failure count and state shown in the UI. Per-exit concurrency, per-minute and per-hour caps, whether a direct connection is allowed when every exit is out, and whether an expired cookie may fall back to anonymous: all editable, applied immediately.
- **A dead sign-in comes back by itself.** A windowless Chrome loads Gemini on that account's own profile in the background, letting Chromium renew the short-lived ticket the sidecar cannot, and the renewed cookies are written back. When that cannot help, the account row offers 重新登录 — sign in again and the account is switched back on. An account you stopped yourself is never re-enabled automatically.
- **Keys and LAN**: a key starts with `cwg-` and is stored as a salted SHA256 hash — the UI shows only the first and last few characters. LAN listening is opt-in and takes an IP allowlist, CORS origins and a body limit; every request goes to an audit log that never records the prompt or a key. No public listener.
- **A Tasks page for account upkeep**: check-in, keepalive, growth tasks, cat travel, lottery, activity, quota refresh and account check. Give a task a cron time or an interval; run it now; missed runs are caught up once (up to seven days late) and dropped beyond that. The run history shows each account's result.

**Conversation**

- **Run a code block straight from the conversation.** Bash / shell / PowerShell / Python / Node blocks in a reply get a run button: after a confirmation, the code runs as you, in the conversation's folder, with a 30-second limit and at most 64 KB of output shown under the block. Only a window on this machine can run code; phones and remote devices cannot.
- **Selecting text brings up a menu**, like the official desktop app: copy, copy the code block, copy the message / copy as Markdown, quote it into the input box, pin the reply, fork from here. No right-click needed. The desktop app also has a real context menu now (before, right-clicking selected text did nothing).
- **Thinking language**: a setting that asks the model to write its reasoning in a chosen language (code, paths and identifiers stay as they are); the answer still follows the language you write in. A conversation can override it.

**Models**

- **A subagent can run on any model, whatever the conversation uses.** The 子代理 menu lists every connected provider's models, whether the conversation runs on a Claude account or another provider. Changing the main model or moving the conversation to another provider keeps the subagent pick. Once one is picked, the system prompt tells the main model to hand the work to it instead of doing it itself.

**Library**

- **Cursor's history is readable** (read-only), and a local scan finds the conversation folders of WorkBuddy, Zcode, Hermes, OpenClaw, Kiro and Windsurf (read-only; nothing of theirs is changed).
- **DeepSeek Harness history can be read and continued**, like Codex.

**Desktop**

- **The Mac app updates itself, like the Windows one.** A new version downloads in the background; "Restart to update" swaps it in and opens it again, and "Later" installs it when you quit. No Apple signature needed: the app replaces its own copy in Applications. If it can't (opened straight from the dmg or Downloads, a folder it can't write to, or macOS's App Management said no), you get the download link as before, with the reason. Versions up to and including 0.2.9 still have to be updated by hand one last time.
- **The installer carries the Gemini and WorkBuddy components**, so the first account no longer waits for a download.

### Changed

- **The Gemini web path is much faster.** A bare "hello" used to take 26 seconds to the first token and 90+ to finish: every turn carried the whole tool schema (~100 KB) plus the system prompt, went past the sidecar's 128 KB inline limit as an uploaded attachment, and the model read that before answering. Such conversations now carry seven core tools (read, edit, write, run a command, search contents, find files, todo), and the first token lands in 1-2 seconds. Measured on "hello": 26.4 s / 95.7 s before, 1.2 s / 6.4 s after.
- **A long conversation is pointed out once.** These turns re-send everything each time; past 128 KB the conversation says so once (with the current size) and suggests `/compact` or a new conversation — past about 163 KB the web end truncates the tail anyway. It arms again after a compaction.
- **The model list follows the sign-in.** Without a usable account the sidecar reports two anonymous models; once signed in it reports the full subscription list (including `gemini-4-argon`). It is refreshed on a timer, the Gemini card has a 刷新模型 button, and each model carries a one-line note in the menu (fast / best for code / thinks 20-40 s / flagship, slowest).
- **Streaming no longer lags.** Each delta used to re-render the whole conversation; with DeepSeek sending one token per delta the window fell tens of seconds behind (a 5-second burst took 49.6 s to paint). Rendering now happens once per frame — 0.05 s behind.
- **Plan card, question card and thinking box**: the plan card stays with the task when a background subagent continues it; 详细 view no longer shows the plan twice; no spinner while the model waits for your answer; Enter submits inside the question card; the thinking box follows the bottom while streaming.
- **DeepSeek V4 counts as a 1M context window** (it was 128K, so compaction ran far too often and cache hits sat at 26-33%).
- **Saving provider settings reaches a conversation that is already running** — it restarts after the current turn, no manual restart needed.
- **Every native select is the app's own component now**, with the same keyboard handling and the same picker on a phone.
- **A connector's first start is warmed up**: an npx / uvx entry downloads its package on first launch and used to show 「连不上」 straight after adding; now it waits for it.
- **Smaller first screen**: the English catalogs (useless to a Chinese interface) are no longer in the first-screen bundle — 2.36 MB of first-load files became 4 KB, the rest loading on demand. This also matters for opening the app from a phone.

### Fixed

- **Switching from another provider's model to Claude no longer 400s every turn.** Empty thinking blocks left by the other model are dropped from the history (the cost: those turns' reasoning is gone from it).
- **A relay configured in your own settings.json can serve subagents again** — the pick used to be silently ignored and fell back to another model.
- **The shared-memory MCP is named `claude-web-memory`**, no longer colliding with the official `memory`.
- **The add-account dialog**: the "I understand" checkbox is gone; WorkBuddy's 扫码登录 / 粘贴 JSON became a proper two-way switch instead of two broken rows; Cancel sits in the standard dialog footer.
- **The sidebar's 「把 X 等工具里的对话也列在这里？」 was cut off** with several, long tool names; it now may wrap to three lines.

## [0.2.9] — 2026-10-18

### Added

- **Subagents can use any model, whatever the main conversation runs on.** The Subagents menu lists the models of every provider you've connected, whether the conversation is on your Claude account or on a provider (before, other providers' models were only offered when the conversation was on an Anthropic-format provider). Changing the main model or moving the conversation to another provider keeps the subagents' choice. The checkbox at the bottom is now "Same for new conversations": one default for all new conversations, and the per-provider defaults you had carry over. A conversation on a provider can also send its subagents to a model of your Claude account.
- **The plan sits at the bottom of the conversation**, like the official desktop app: the latest turn's plan (ticks, the step in progress) is always last.

### Fixed

- The stats under the input box (turns · steps · tok/s · cache hit rate) never showed for a conversation started from the new-conversation page. They do now.
- A long screenshot pasted into the input box shows as a small thumbnail instead of filling the whole row (clicking it still opens the full image).

### Removed

- The statusLine above the input box: the model, branch and usage it showed are in the window already.

## [0.2.8] — 2026-10-18

### Fixed

- **0.2.7 would not start**: "Failed to start: Error: server exited early (code 1)". The installer was missing a package that the new "Import from other tools" feature needs. If you're on 0.2.7, download 0.2.8 from the [Releases](https://github.com/ypyik0669/claude-web/releases) page and install it over the top. Your conversations and settings are kept. 0.2.7 can't update itself because it quits before it checks for updates.
- From this version on, if the app fails to start, the Windows installed version looks for a newer version and offers to install it instead of just quitting.

## [0.2.7] — 2026-10-18

### Added

- **The interface is laid out like the official desktop app.** A column of cards sits to the right of the conversation: environment, a breakdown of the context in use, connectors, changes (with Create PR), background tasks and pinned replies. You can fold the cards and drag them into another order. The conversation header has Review / Browser / Files buttons on the right, and ⋮ gains Side chat, Background tasks and Keep the computer awake. The input box is a single line (+ · text · mic · send); the permission, the model and thinking strength, and the context ring move to a line under it. **Ctrl+Enter cuts in** while a reply is running (Enter still queues). A statusLine set in `~/.claude/settings.json` is drawn above the box, in its own colours.
- **The new-conversation page** has the same one-line box. Under it are Code / Chat, which computer to start on, the folder, the branch and the permission, with the model on the right.
- **An animated backdrop on the new-conversation page: Drift.** Letters drift like ink on a slowly turning current. The pointer parts them, a click splashes a ring of accent-coloured letters, and what you type in the box floats out of it from the caret and joins the stream. The setting "Animated backdrop on the new-conversation page" switches it to Field (a dim field of letters with a ripple on every click) or off. With reduced motion on it is a still picture, and phones don't show it.
- **Claude's thinking has content again.** Thinking rows used to open up empty, because current Claude models leave the thinking text out unless it is asked for. Both the official client and the built-in one ask for it now. A thinking row is titled by its summary's heading, and the step being worked on shows four dots lighting in turn.
- **Stats for the conversation under the input box:** turns · steps · tok/s (generation speed, from each turn's own model time) · cache hit rate. When the window is narrow, whole items drop out.
- **Subagents can use any provider's model.** When the conversation is on an Anthropic-format provider, the Subagent menu lists other providers' models (DeepSeek, for example). Subagent requests go to that provider, translated as needed, and the main conversation's requests still go to its own provider unchanged.
- **Import from other tools** ("Import from other tools…" on the provider list and the connectors page). It reads the providers and MCP servers set up in Hermes, CC Switch, Codex, OpenCode, Continue, Cursor, Windsurf, Kiro, Claude Desktop, VS Code, Cline, Roo, Gemini / Qwen CLI, Zed, Goose and a running Ollama, and imports the ones you tick. It only reads, never changes their files, and skips what you already have. Mirasim and Cherry Studio keep their settings encrypted in a browser database, so they can't be read; the dialog tells you to copy the address and key across yourself.
- **Next-prompt suggestions:** after a turn, the empty input box shows a grey guess at what you'll say next. Tab or → takes it. You can turn this off in settings.
- **View modes:** Normal / Show thinking / Verbose. Switch with Ctrl+O or from the conversation header's menu.
- **Side chat:** `/btw` or Ctrl+; asks something about the conversation without the conversation hearing it. "Add to conversation" puts the answer into the input box.
- **@ files:** type @ to list the project's files (.gitignore respected); the one you pick goes into the message as @path.
- **Keyboard shortcuts, matching the official app:**
  - Ctrl+/ shows them all.
  - Alt+M opens the model menu, and Ctrl+Shift+E the thinking strength.
  - Shift+Tab in an empty box steps through the permission modes (only the safe ones).
  - 1–9 pick a row in a menu.
  - Ctrl+\ closes the current split, and Ctrl / Cmd + click on a conversation in the sidebar opens it in a split beside.
  - Alt+← / → go back and forward through the conversations you've looked at (⌘[ ⌘] on macOS; the mouse's side buttons work too).
- **Comments on diff lines in Review:** click a line to write a comment. Ctrl+Enter hands all the comments to Claude as one message.
- **Code review card:** `/code-review` lists its findings by file. Each one has "Fix this" or "Ignore", and "Fix the open ones" handles the rest at once.
- **PR status bar:** when the current branch has a PR, the bar above the conversation shows the PR and its checks. Its CI menu has "Fix CI failures automatically" (it asks the conversation to fix them once per push) and GitHub auto-merge. Once the PR is merged or closed, the conversation is archived (this can be turned off).
- **Right-click a file path** to add it to the next message, open it in VS Code / Cursor / Zed (whichever are installed), show it in Explorer / Finder, or copy the path.
- **Cross-conversation tools:** Claude can list, read, message and rename the other conversations on this computer, and archive them once you say yes. Tasks it suggests become a button that starts a new conversation in a worktree of its own.
- **Local environment variables** (in settings) are stored encrypted on this computer. Every conversation and terminal this app starts gets them.
- **Where worktrees go, and their branch prefix,** can be set. With either set, the files `.worktreeinclude` lists that git ignores are copied into a new worktree.
- **Start a new conversation on another computer:** pick a connected computer on the new-conversation page, and the conversation runs there with that computer's own models and settings.
- **Scheduled tasks:**
  - A run missed in the last seven days runs once, and you're told about it; older ones are dropped.
  - A new "Manual" kind runs only when you click Run now.
  - Each run can have a worktree of its own.
- **Chat only:** start a conversation from the + menu with no tools at all (none of the built-in ones, ours, or your own MCP servers).
- **What's new:** after an update, the app shows once what this version changed, in the interface language. The command palette and Settings → App updates show it any time.
- **Overview** gains three lanes: Awaiting review (an open PR waiting for review), Landing (approved, or set to merge itself) and Resolved (archived in the last week).
- **Right panel → Files** lists the files generated in recent conversations: pages, documents, pictures and data Claude wrote in the 50 most recent conversations that are still on disk. Each one links back to the conversation that made it.
- **Preview servers:** if the project has `.claude/launch.json` (the official format), Claude can start the dev server, read its logs and stop it, and opens it in the app's browser. The browser's empty page lists these servers too, and ▶ starts one.
- **Under a reply:** Pin (pinned replies are listed in the right-hand column), Read aloud, Fork, and a time such as "2 minutes ago".
- **☰ and ← → in the title bar:** ☰ opens the app menu, and the desktop app gains a Go menu with back / forward.
- `claude-web://` links: `new?folder=…&q=…` opens a filled-in new-conversation page (it never sends by itself), and `session/<id>` opens a conversation. Only the installed app registers them.
- The official desktop app's anthropic-skills plugin works here too (anthropic-skills:xlsx and the like in a conversation). A setting turns it off.

### Changed

- **Texture:**
  - Menus, toasts, cards, switches, the right panel and phone sheets move on spring curves.
  - Edges are hairlines on 2x screens; dark themes get a faintly lit inner ring, and menus and dialogs a contact shadow.
  - Lists fade at an edge only while there is more to scroll past it.
  - Latin text is lighter in dark themes (Chinese is unchanged).
- **Sidebar:**
  - Search matches conversation titles and folder names only (#7).
  - Projects and folders start folded, with the current one open (#3).
  - The By provider lists fold (#4).
  - The built-in Claude reads "Claude Code · <relay host>" when settings.json points it at a relay (#5, #6).
- The app icon is the new logo.
- The desktop app no longer shows a microphone button: in Electron, speech recognition fails on every start.

### Fixed

- **After sending a picture on its own, every later turn of that conversation failed with a 400** (cache_control / non-empty text). The empty text block is no longer sent, and a conversation that already broke repairs its transcript and restarts once when that 400 comes back.
- **Codex conversations failed to start.** When Codex can't read its own configuration (for example a model_catalog_json that codexmate wrote into config.toml, older than the installed Codex), the message now names the setting, the file, who wrote it and how to get going again, instead of a raw log. Your files are left untouched.
- **A conversation whose first message was long (a pasted screenshot, say) vanished from the list**, in other apps such as Mirasim too, and its folder was lost (#9). Both are back. A new conversation not listed yet reads "New conversation" instead of its id (#8).
- **A conversation renamed while it was running got its old name back.**
- **Images over 2000 px failed with "Could not load the sharp module".**
- **"Background · 19 commands":** background commands and subagents that ended during a turn kept counting as running.
- The rail's account and ··· menus were cut off under a full page (Extensions, Background…).
- Layout fixes:
  - ☰ at the top of the rail was half cut off by the window's edge.
  - The permission and model buttons overlapped when the row under the new-conversation box was crowded.
  - On phones, the title ran under the buttons on the right.
- tok/s in the stats used to be far too low (the model time came back as a running total).
- With subagents on another provider's model, their messages showed an internal alias instead of the real model name.
- @ completion could turn a plain word into a file name, Shift+Tab could step onto a hidden permission mode, and the PR bar could pick up a PR from someone else's fork with the same branch name.
- On macOS, Ctrl now shows as Cmd in shortcuts, and English sentences keep Claude / GitHub capitalised.
- A link's folder must be a full local path: a network path is never looked up, so Windows never logs in to that host. "Where worktrees go" also takes only a full local path.
- A chat-only conversation stays without tools after a reopen, a fork, a message from another conversation, IM, a scheduled task or a provider switch.
- Two conversations told to keep each other informed no longer answer each other forever: one conversation takes at most 10 messages every 10 minutes.

## [0.2.6] — 2026-10-16

### Added

- **The interface now comes in English.** The whole interface (the web app, the desktop menus and tray, the phone page, the pairing page, exported HTML, error explanations) is available in both Chinese and English, and **by default it follows this computer's language**: an English computer gets English, a Chinese computer gets Chinese. To change it: **Settings → Appearance → Language** (Follow system / 中文 / English). The interface reloads once after you change it; the desktop menus and tray need an app restart. The language Claude replies in inside a conversation is not affected.
- **Subagents can use a different model.** Next to the model button in the input box there is now a "Subagent" button. The main task still uses the main model, while subagents (the ones launched by Task or by workflows) use whatever you pick here, so you can choose a cheaper model to save quota. The default is "Same as main model". Each conversation remembers its own choice; tick "New conversations on this provider all do this" at the bottom of the menu and every conversation you start on that provider from now on (including IM and scheduled-task ones) uses it. If you change it in a running conversation, the process restarts quietly in the background and the new setting takes over once the current turn finishes.
- **Several Claude accounts side by side.** **Settings → Account and login → Other Claude accounts → Add account** opens a terminal running `claude setup-token`: sign in to the account you're adding in the browser and authorize, and the token the terminal prints fills in by itself. Give it a name and save (saving sends one very short message as a test). From then on each account is a section of the model menu ("Work / Opus 5.5"), and every conversation picks the account it runs on; when one runs out of quota, pick a model of another and carry on — the conversation is kept. An account can be the default for new conversations, and IM bots and scheduled tasks can use it too. The login in ~/.claude is still "Claude account", as before.
- **Custom styles (custom.css)** (GitHub issue #2). Put your own CSS in `~/.claude-web/custom.css`: it is loaded after the built-in styles, every window picks up a save at once, and the desktop app's auto-update leaves it alone. **Settings → Appearance → Custom styles** creates / edits the file and switches it off in one click. A new file lists the hooks that stay the same in later versions: `html[data-theme]`, `.chat[data-state]`, a plan's `data-done` / `data-total` / `--progress`, each plan item's `data-status`, and more.
- **The plan in the side panel's Task tab has a progress bar**, like a goal's card: "3/7" in its title row with a bar next to it.
- **Click an image in the input box to see it big** (wheel to zoom, arrow keys to move between images); hover it and a × in the corner removes it. A click used to remove it.
- **"Subagent model" at the bottom of the model menu** opens the subagent menu directly (the button next to the model is still there; this is another way in).
- Conversations that aren't running here (after a restart, from history) now have the "time · steps · cost · tokens · cache" line under each turn too: turns that ran in this app from the ledger, turns that ran elsewhere from the answers' usage (no cost). The context ring in the corner of the input box is always there now (a faint ring without a number below 60%), estimated from the last turn for a conversation that isn't running.
- **Pick the models you want when adding a provider.** A relay lists a dozen models at once, and they all used to land in the model menu. Now, when you add a provider and "Test connection" brings back its list, "Choose the models to use" opens: search, select all / none, tick them one by one — only the ticked ones appear in the model menu. Change it any time under "Models to use" on the edit page (the same switches as Settings → Models).
- **Codex's model list follows Codex itself.** It used to be built into the app (5.6 Sol / Terra / Luna / Pro), so a new Codex model had to wait for an update from us. Now the app asks the Codex on this computer which models this account can use (GPT-6-Luna, for example), and the model menu and Settings → Models list what it reported; it asks again every few hours, and whenever a Codex conversation starts.

### Fixed

- **Opening a Codex conversation failed with "paginated_threads is not supported yet".** Newer Codex (the desktop app updates itself) stores conversations in a new way that an older `codex` command line on the same computer can't read. Such conversations are now read with the codex that comes with the Codex desktop app; without the desktop app, the message says to update the Codex command line.
- The context ring's card in the composer no longer stays over a menu you just opened: a click elsewhere closes it.
- **The "+" on the workspace's tab row did nothing.** Its menu did open, but the tab row cut it off. The menu now floats below the row, flipping up or scrolling when the window is short.
- **Group names repeated.** After adding a few groups and closing some in the middle, new groups counted from "Group 2" again and you ended up with two "Group 4". A new group now takes the first number nobody has.
- **Easy mis-clicks in the top-right corner.** The last button of the conversation header and of the side panel (panel toggle, ···, close) sat 4 pixels from Windows' minimize / maximize / close. There are 20 pixels between them now.
- The home page's "What do you want to do today?" sits lower, no longer squeezed into the top half of the window.

- **"Allow everything" went back to "Ask first" after a few turns.** When a conversation's process was reclaimed after sitting idle, the app restarted, or you carried on from the phone, it reopened in "Ask first". Each conversation now remembers the permission mode it last ran in and reopens in it; one with nothing recorded uses Settings → General → Default permissions.
- **"This conversation is being updated elsewhere (terminal or another app)" appeared for no reason.** Claude Code writes a few bookkeeping lines into the record as it exits, and those were taken for new messages from elsewhere. The note now only shows when new messages really arrive.
- **0% cache hits and over a dollar a turn.** Usually the next message came more than 5 minutes later: the prompt cache had expired and the whole context was read again at full price. The line now says "12 min later, the cache had expired", with the reason on hover and a pointer to "1-hour prompt cache" under Settings → Providers → Edit (official runtime).
- **A long conversation stuck on "Loading history…" on a phone on the slow relay.** Only the latest part is sent first now (cut at a turn); "Load earlier history" fetches the rest. Very long conversations on the computer open faster too.

## [0.2.5] — 2026-10-14

### Added

- **Projects can be reordered.** Drag a project's name row in the sidebar to put it before or after another project; the project's ··· menu also has "Move to top / Move up / Move down" (use this on a phone). A newly added project goes to the top instead of landing at the bottom. The order is stored on this computer and changes in all windows at once.
- **When a conversation won't fit the model you switch to, it is compacted first.** If you've chatted a lot on a large-window model (say Claude at 400K) and then switch to a small-window model, the new model can't even read the whole conversation, and compacting fails too. Now, before switching, the app checks: if the conversation is over 80% of the new model's window, it is compacted with the current model first and then switched over, with a line in the conversation explaining what happened.

### Fixed

- **Clicking "Allow" on a tool that needs confirmation (editing files, running commands…) still failed**, with the model saying the tool layer rejected it for lacking `updatedInput`. Every conversation running on our built-in runtime had this problem (relays in OpenAI / Gemini format, and relays that aren't restricted to the official Claude Code); tools that need no confirmation, such as reading files, were not affected. "Allow" works now, including the "Allow" buttons on the phone and in IM bots.
- **Switching models inside one conversation didn't change the context window.** With the official Claude Code runtime, the early-compaction setting is read only once when the conversation starts. When you switch to a model with a different window, the process now restarts in the background and picks up the same conversation.
- The little context ring next to the input box used to show 0 / 0 for "used / total" on hover; it now shows the real numbers.

## [0.2.4] — 2026-10-14

### Added

- **Each model's context window now defaults to the full size.** Before, Claude on a relay was always treated as 200K and auto-compacted at around 175K; a GPT relay really has only 272K, but the engine assumed 1.05M and errored out before compaction could kick in. Now **Settings → Providers → Edit** has a "Context window" section with one row per model; leave a row empty to use the default: Claude on a relay is 1M (Haiku 200K), GPT is 272K, Gemini is about 1.05M, a size written in the relay's model list is used as written, and unknown models stay at 200K. To change one, just type it (272000, 272k and 1m all work). When Codex uses this provider, it also follows the default model's window. Conversations that are already running need to be restarted to pick this up.
- **Filter plugins by status**: under Extensions → Plugins, "Installed" now has "All / Enabled / Disabled" at the top right, and enabled plugins come first.

### Changed

- The built-in runtime is now 2.8.4-cw.4: it compacts according to the context window in the provider settings (see above).
- **Every folder in the sidebar is its own group**, like the official Claude app. Before, if you made a parent folder (say your user directory) a project, the conversations from every folder under it were filed under it; now a project holds only the conversations started in that exact folder. Below the projects comes "Folders": one flat group for each folder that has conversations, most recently used on top. On a group you can directly choose "New conversation here" or "Make a project" (pins it to the top); once there are more than 10, older ones are tucked into "Earlier folders". When two folders have the same name, the name is followed by its parent folder (`app · shop`, `app · blog`).
- **"Deep orchestration" now explains how to use it**: the menu says it is for big tasks (the model splits the work into pieces, hands them to several subagents to do at the same time, and you watch progress in "Background"); turning it on shows a one-line hint, and the input box gives an example.

### Fixed

- **Clicking "Rerun" under your own message opened a new conversation.** Now rerunning the last message (say, the one that just errored) asks again in the original conversation; rerunning an earlier message still forks a new conversation from that point, and the button tooltip now says so.
- **A turn that wasn't finished in Codex showed up here as finished.** When you carried on with the same conversation in the Codex desktop app or command line, a half-done turn was shown here as over ("0s · 3 steps · cost unknown"). It now says "This turn is still running in Codex" and updates by itself when it finishes. For Codex conversations started here, a half-done turn could also be recorded too early, and its second half was then never visible; now it is recorded only once it's done.
- **"Open in File Explorer" did nothing** (Windows): Explorer did open, but its window was hidden. "Open in VS Code" also never worked on Windows. Both work now, and you get a message if the folder no longer exists.
- **Settings → settings.json couldn't be scrolled with the mouse wheel**, only with the keyboard.

## [0.2.2] — 2026-10-13

### Added

- **Background: see the subagents and workflows that are running.** The icon bar has a new "Background" entry: subagents a conversation has launched, workflows that are running and background commands, all on one page. There is a row of cards at the top, one per subagent (name, stage, running / queued / done / failed, what it is doing right now, how many tokens it has used). Above them sits a pixel internet café: the main conversation is the admin at the front desk, and every subagent is a customer. They come in, check in at the desk, sit at their own seat and type away (code scrolls on the screen and the step they just took pops up over their head); when they have nothing to do they go eat instant noodles, have a drink, play a round of a game, use the restroom, visit the smoking area or borrow a power bank, and the moment there's work they head straight back to the seat. When they finish they walk to the desk to pay and get a little receipt (how long they were on, the fee, how many tokens, roughly how much money) and leave. A failed one gets a blue screen, and one that was stopped hears the admin shout "called off". The seat plate shows the café fee (purely for fun; you can change the price in Settings → General), and hovering shows the real tokens and estimated cost. Below are the cards, today's bill, the relationship graph and the activity feed. Click a customer and its own conversation opens next to it: what it read, which commands it ran, what it changed. The side panel's "More" also has a small café that follows the current conversation. The left side lists every conversation with background activity, and you can look back at workflows this conversation ran before.
- **Make a character.** In the "Character library" at the top right of the café you'll find the default little octopus and the admin. Click "Make a character", give it a photo or describe what you want ("a programmer in black-framed glasses and a blue hoodie"), and Claude draws a pixel character for you to see. Keep talking to adjust it ("bigger eyes"), save it when you're happy, and assign it to the admin, to all customers, to one kind of subagent (say Explore) or to a subagent with a particular name. You can also just say "make me a café character that looks like this photo" in any conversation.
- A small "Background" pill now sits above the input box: when a turn has ended but things are still running in the background it stays there, and clicking it opens "Background" directly. The Workflow card in a conversation shows each subagent's status live; the side panel's "Task" has a shrunken relationship graph and a stop button for each task.

### Changed

- **"Stop" now stops only this turn.** Before, pressing stop in the input box also killed background workflows, background subagents and background commands; now they keep running, and to stop them you do it individually on the "Background" page, in the side panel's "Task" or on the card (a workflow is stopped as a whole). If something is still running in the background when you press stop, you get a note about it.
- When a conversation's turn has ended but a workflow or subagent is still running in the background, idle reclaim no longer shuts its process down (before, after 30 minutes idle it closed the process together with the background work, and the workflow's result never arrived).
- The built-in runtime is now 2.8.4-cw.3: after a workflow starts, the turn ends once it has said its piece, and the input box no longer stays stuck on "Running" for the whole workflow (before, pressing stop at that point got no response and reopened the process, taking the background workflow with it); when the workflow finishes, its result starts a turn by itself to tell you.

## [0.2.1] — 2026-10-11

### Added

- **Search now happens in the built-in browser; Tavily is gone.** When an agent searches, the built-in browser opens a search site's results page in a page you can't see and reads the results out, which is the same kind of request as searching in a browser yourself, so no key is needed and no third-party search proxy is involved. By default it tries DuckDuckGo, Bing, Yahoo and Baidu in turn and uses whichever gives relevant results; in **Settings → Web access** you can pick one (Google, Yahoo and Baidu were added), and "Try it" shows which ones work on your network. When a site asks for verification, open it in the browser in the side panel and verify once. In testing (on a network behind a proxy) DuckDuckGo gave relevant results for all three queries within 1–4 seconds; the previous version fetched results pages straight from the computer, and Bing was relevant only once in four tries. Several searches can run at the same time. The web version and the phone (which have no desktop window) still have the computer fetch Bing / DuckDuckGo results pages.
- **Mouse and keyboard on a web page, by position.** For things that can't be listed as elements (a canvas, a map, dragging, hover menus, sliders), the agent can now look at a screenshot of the built-in browser and act by position: click, double-click, right-click, drag, scroll wheel, type, press keys. It only acts on its own tab and goes through permission approval like every other web action.
- **Computer control (Windows).** "Computer control" in the `+` menu now works: the agent looks at screenshots of the screen and uses the mouse and keyboard on the apps you allow (Notepad, File Explorer, desktop software…). Which apps it may use is asked every time with a card that shows the app name and what it says it wants to do; **only clicking "Allow control" on the card counts as consent**, Enter doesn't, and neither "Allow everything" nor "Auto" will consent for you. Once allowed, it can see a screenshot of the whole main screen, but the keyboard and mouse only go out while an app you allowed is in front; Claude Web's own window can never be operated by it. It is on for this one conversation only, and the next new conversation needs it turned on again; the permission is withdrawn when the conversation ends. On macOS and Linux this row still says "Not available right now".

### Changed

- The model now has only one search tool. The one that ships with the runtime used to go through a Tavily proxy hosted by an upstream project by default (your search terms passed through someone else's server); on our runtime it is no longer offered. If you chose a backend for it yourself (`WEB_SEARCH_ADAPTER` or `/web-tools`), that keeps working as before. Conversations running on the official Claude Code are not affected.
- Tavily is gone from Settings → Web access; a Tavily key stored earlier is deleted on startup. A Brave Search key can still be entered.
- Search result summaries no longer start with the URL and a machine-format date.

### Fixed

- For a page that keeps spinning and never finishes loading (say an image that never returns), the agent used to time out when reading it and get nothing; now, if it can't wait any longer, it stops the loading, reads what has already appeared, and says "still loading".
- The browser identification the built-in browser reports to websites no longer contains `Electron` or the app name (some sites showed a verification page on seeing it).

## [0.2.0] — 2026-10-10

### Added

- **Web access: search and the built-in browser.** The agent in every conversation (Claude, Codex, Gemini and so on) can search the web, and can use the built-in browser to open pages, read content, click, fill in forms and take screenshots; just tell it "search for…" or "open this address and take a look". The pages it opens appear in the new "Browser" tab of the side panel, with each conversation's agent using its own tab, so you can see what it is doing; you can also use it to browse yourself (links that want a new window open as a new tab of it), and "send to conversation" the page address and the text you've selected. Search here needs no key by default (Bing, or DuckDuckGo if that fails), and is only a fallback: on many networks they rate-limit or return unrelated results, and the agent prefers its own built-in search first. For something dependable, enter a Tavily or Brave key in **Settings → Web access**. Click, form filling and screenshots need the desktop app; the web version and the phone can only search and read text. Opening and operating pages goes through permission approval; searching doesn't ask.
- **Icon bar and sections.** A new icon bar runs down the far left of the window: Conversation · Automation · Extensions · ···, with Settings and your account below (the ring around the avatar is your quota). Click "Automation" or "Extensions" and the sidebar switches to that section's own content, with its page in the main area. The row of unlabeled panel icons that used to appear after "Show workbench tools" is gone: those panels are now in ···, each with a name and a one-line description, and the ones you use often can be pinned to the icon bar.
- **Extensions page.** Connectors (MCP servers) are a directory: each service has its own logo, a one-line description and an "Add" button; Skills and plugins are here too. The old pages in Settings are all still there.
- **"How deep to think" is its own button.** Model and thinking effort are now two buttons: the model menu only picks the model; the button next to it has one level per row, each with a one-line explanation, and "Deep orchestration" is the switch on the last row.
- **Automation → Scheduled tasks**, when you have no tasks yet, is no longer a line of grey text but an explanation plus six template cards with icons.
- **Interface zoom** (desktop app): when your screen resolution is high and the interface looks small, you can scale the whole interface up (or down), from 50% to 300%. <kbd>Ctrl</kbd>+<kbd>=</kbd> zooms in, <kbd>Ctrl</kbd>+<kbd>-</kbd> zooms out, <kbd>Ctrl</kbd>+<kbd>0</kbd> resets (on macOS it's <kbd>⌘</kbd>; the numpad + − 0 work too), or choose it in **Settings → Appearance → Interface zoom**; it's in the command palette as well. All windows change together and **it is remembered after a restart** (Ctrl+Shift+= used to zoom in too, but every launch went back to 100%). When zoomed in, the window's minimum size grows with it, so the interface won't get squeezed into the phone layout; how far you can go depends on the screen (the window has to fit). The − □ × at the top right and the button next to them never overlap at any scale. For the web version, use your browser's own zoom.

### Changed

- The side panel has five fixed tabs (the Browser was added). When the panel is narrow only the current tab keeps its name and the others are icons; for a panel opened from "More", a name that doesn't fit is no longer cut off in the middle of a character but folded into "More" (a number on the button, and the panel's name written at the top of the panel).
- "Control browser" in the `+` menu is now called "Control Chrome": it uses your own Chrome (the Claude extension must be installed); the built-in browser is there for every conversation and needs no switch.

### Fixed

- **Turning on "Computer control" meant the conversation wouldn't start.** This switch in `+` passed the runtime an argument it doesn't recognize, and the process exited before the first message. The runtime supports computer control only in its own terminal interface, so the argument is no longer passed, that row is marked "Not available right now" with the reason given; for going online (search, opening pages, clicking, screenshots) use the built-in browser above.
- When the project and branch at the top of a conversation didn't fit, they used to be squeezed into an unreadable stub like "m…"; now the item that doesn't fit is hidden entirely, and only the project name itself gets shortened.

### Interface refresh

The whole interface got a new look and feel (the design notes are in `docs/superpowers/specs/2026-10-10-ui-refresh/`). No features or entry points were removed; the only changes in position are the ones listed above under "Added" and "Changed".

- **No longer all squares and boxes.** The sidebar sits directly on the warm background, while the conversation area, the side panel and the settings pages are rounded cards floating above it with a gap between them; the dividers and outlines that used to be everywhere are replaced by a very faint shadow ring. The corner radii of the input box, menus, dialogs and cards follow one unified set of sizes.
- **Color**: light is a warm paper white, dark is a warm black, and the accent is a bright orange (used only for the brand, focus and the glow of things that are running). The other four themes (Paper, Dracula, Nord, Tokyo Night) were adjusted to match.
- **Fonts**: interface text is Inter and code is JetBrains Mono (both ship with the app, nothing to install), Chinese still uses the system font; the home greeting and page titles use a serif. Font sizes are unified into one set of whole numbers.
- **Icons** are all replaced with Lucide line icons, with stroke weight adjusted to size.
- **Input box**: the send button is a circle that changes (grey when empty, solid when there's content, a stop square while running); while running, a travelling glow runs around the input box, and a status tab on the top edge says what it is doing, which step it's on and how long it's taken.
- **Conversation**: the steps of a turn are one line each, and consecutive steps of the same kind (several files read in a row) merge into one line; new steps slide in and collapse into a one-sentence summary at the end, with times and numbers rolling up; the reply text fades in. Code blocks, the changed-files card and tables were redrawn.
- **Menus, segmented controls, notices**: menus grow from where you clicked; a pick-one-of-two-or-three choice in Settings is a segmented control with a slider; notices ("Copied" and the like) moved from the bottom right to the top of the main area as small ink-colored pills, at most three stacked, so they no longer cover the input box and the approval buttons.
- **Approval card** (the one for when Claude wants to run a command or change a file) has larger corners, the command in a block of its own, and pill-shaped buttons.
- **Phone**: the header is floating round buttons (with an extra `+N −M` when there are changes, which you tap to see them) and the content scrolls underneath; the side panel is a draggable bottom sheet (two heights, pull down to close); swipe right on a conversation to pull out the sidebar and left to put it away; on a phone every menu slides up from the bottom as an action sheet, and long-pressing a conversation row opens one too; the system back gesture closes the topmost layer first (menu, sheet, sidebar) instead of leaving the page; tap a step in the conversation and its details open in the sheet; the approval card's buttons each take a row; above the terminal there is a new row of Esc / Tab / Ctrl / Alt / arrow keys / Ctrl+C / Paste; in Review you can toggle word wrap and horizontal scrolling, and commit is folded into one button; everything tappable has a tap target of at least 44px. These gestures have only been tried on a computer with a phone-width window and simulated touch, **and have not yet been verified on a real phone**; if something feels off, please open an issue.
- The phone shell (the page you get when connecting back from outside) and the LAN pairing page use the same colors now.
- A message sent while a turn is running is now a small card above the input box saying "Queued; it will be sent when this turn ends", and you can edit it, send it now or delete it.
- Settings → Appearance has a new "Haptic feedback" (on phones that support vibration, a light buzz on send, on approve and when a long press opens a menu).
- With the system's "reduce motion" on, or "Reduce motion" on in Settings, none of the animations above appear (except the spinning loading mark).
- Desktop app (Windows): the − □ × at the top right float over the cards and sit roughly in line with that row's own buttons (they used to sit a bit higher); when viewing an image, the buttons on the right of the toolbar are no longer covered by − □ ×.

## [0.1.10] — 2026-10-09

### Fixed

- **The row of buttons on your own messages (Copy, Edit, Rerun, Fork, Share) was always hard to click.** ([#1](https://github.com/ypyik0669/claude-web/issues/1)) They used to float in the empty space above the message, and when you moved the mouse up from the message, the buttons vanished the moment it left the message. Now the buttons sit below the message, like the ones under a reply, and stay there as you move the mouse over to them.

## [0.1.9] — 2026-10-09

### Fixed

- **A code block sometimes showed only "12 lines" with blank space below.** We couldn't reproduce it here; it looks like a browser extension or page translation altering the page. Now a code block checks itself: when it has content but displays as empty, takes up no space, or has text the same color as the background so it can't be seen, it redraws once first, and if that still doesn't work it falls back to plain text without highlighting and writes the circumstances to the log (only things like line count, language and browser, never the code itself), so next time it can be traced.
- **On an OpenAI-format relay, choosing a model with sonnet / opus / haiku in its name (such as `claude-sonnet-5`) actually sent the default model.** Now the models the relay lists itself are sent as they are. The runtime is updated to 2.8.4-cw.2 with this.
- The runtime's built-in `update` command used to go and install from npm a package that doesn't exist on npm; now it just says the runtime updates together with Claude Web.

## [0.1.8] — 2026-10-09

### Added

- The row under every reply now shows the cache hit rate ("Cache 92%"), and hovering shows how much of the input was read from the cache, how much was written to it and how much didn't go through the cache. Input (↑) now also counts the part written to the cache, using the same calculation as "This conversation's usage" and the ledger.
- The model menu and the model name below the input box now use the names that come with the provider's model list: the official DeepSeek's `deepseek-flash` shows as "DeepSeek-V4.1-Flash" (the real id is still written under that row in the menu). For providers you've already added, click "Refresh all models" once to update.
- **Every provider and every model can now pick a "Thinking effort".** Before, only Claude could; providers in OpenAI / Gemini / Grok format never sent this setting at all. Now a model that supports it uses its own parameter (DeepSeek's `reasoning_effort`, Gemini's thinking level…, with the levels taken from the provider's model list), and one that doesn't has the request written into every turn's prompt; if a relay doesn't accept the parameter, it is removed and re-sent automatically, the turn is still answered, and the app remembers to use the prompt approach for that model from then on. Changing the level doesn't require reopening the conversation.
- **"Deep orchestration" now works on every model**: once it's on, the model writes a workflow for bigger tasks and hands the pieces to several subtasks (this uses more tokens). Turning it on in the welcome page and then sending works too.
- The runtime is now claude-web-engine, which we maintain ourselves (a modification of claude-code-best 2.8.4); it ships together with Claude Web and is no longer updated separately.

### Fixed

- **The rules behind "Auto" were never actually loaded.** The previous runtime dropped the rule text used for the judgement when it was packaged, so the judging was left to the model's guesswork; now the complete rules are used.
- **On the official DeepSeek, "Auto" no longer asks you about every single command.** Before running a command, "Auto" first has the model judge whether it's safe, and this step requires the model to call a judging tool; DeepSeek rejects that kind of request in thinking mode ("Thinking mode does not support this tool_choice"), so every judgement failed and it had to ask you every time. Now when this step meets that rejection, it turns thinking off and asks again automatically, and does it that way from then on. The DeepSeek member in the model gateway is the same.
- **A question asked on the phone (or in another window) is now shown on the computer too.** Before, only the reply showed up and you had to reopen the conversation to see the question; the same went for bots like DingTalk, scheduled tasks, and the "continue" that goals send automatically.
- When a "Claude account" conversation fails because the key was rejected or it couldn't connect, and you have already added a provider, it now says this conversation didn't go through your provider, and offers a "Retry with “provider name”" button.
- When the server can't be reached, the retry line no longer says just "(unknown)": it says "Can't reach the server", and explains that the specific reason is shown only after the retries finish, and that you can click "Test connection" to find out right away.
- When the computer's name is very long (over 64 characters), the name shown on the phone before and after pairing is now the same.
- When Codex uses a provider (relay), the ledger no longer records calls that were answered normally as failed ("client disconnected"): Codex disconnects as soon as it has the answer, and these calls used to be counted as failures. The conversation identifier sent to the relay is also now consistent with Codex's own.

## [0.1.7] — 2026-10-07

0.1.6 was never published on its own; everything under 0.1.6 below is in this version too.

### Fixed

- **Conversations opened with a provider (relay) are no longer overridden by old settings in `~/.claude/settings.json`.** Before, people who had used a tool like cc-switch, or had written a relay address and key into the `env` of `settings.json` by hand, ran into this after adding a new provider here: the model list could be fetched (that was done here with the new key), but sending a message got "API retry 1/10 (authentication_failed HTTP 401)" and took several minutes to fail. The cause was that Claude Code used the old key (even the old address) from `settings.json` over the one given by this app. Now conversations and "Test connection" both go by what's entered in the provider; the other settings in `settings.json` still apply as usual, and conversations opened with a Claude account still read it as before.
- When a key is rejected (401), the first retry now says right away what to check, without waiting for all ten retries to run.

## [0.1.6] — 2026-10-03

### Added

- **Reach your computer from your phone even when you're not on the home Wi-Fi.** **Settings → Phone and other computers** has a new "Use it from anywhere" option (on by default when remote access is on). The pairing QR code now defaults to the "works anywhere" one: scan it, the phone opens a web page, you pair once, and from then on you can connect from anywhere, with no app to install and no sign-up.
  - The two sides find each other through a public rendezvous server, all messages are encrypted, and the rendezvous server only sees the encrypted data and both sides' IPs.
  - It connects directly when it can; on mobile data that often doesn't work, and then it switches automatically to a slower relay path: text and approvals work, file preview and upload don't, and the phone says so.
  - The old LAN QR code is still there ("Local network only (no internet needed)").
  - iPhone: to use it from a Home Screen icon, first "Add to Home Screen" and pair from there (the Home Screen and Safari have separate storage); on the phone page you can paste the link you get from "Copy pairing link" on the computer.
  - After a device is revoked, any channel it already has open is cut immediately.
  - The rendezvous server, STUN server and phone page address can be changed under "More options", and the last 20 connections are there too. A changed list is written into the QR code and the phone picks it up when scanning; after a change, phones that are already paired need to scan again.
- **Keep the computer from sleeping while remote access is on** (desktop app, on by default). The screen still turns off, and a laptop with its lid closed still sleeps. The web version can't do this, and Settings says so.

### Notes

- **If you already had remote access on, "Use it from anywhere" and "Keep the computer awake" turn on automatically after upgrading** (both are on by default). The computer stays connected to the public rendezvous server waiting for the phone to look for it, and doesn't fall asleep on its own while remote access is on: this makes little difference on a desktop or a laptop plugged in, but a laptop on battery will use more power than before (the screen still turns off and closing the lid still sleeps). If you don't need them, turn the two switches off in **Settings → Phone and other computers**, or just turn off "Allow other devices to connect".
- **When one phone is paired with several computers, those computers can read each other's access tokens on that phone** (the "works anywhere" phone page has the same URL, and the interfaces of several computers run inside it). Pair only computers that trust each other to the same phone; pairing with the "Local network only" QR code is not affected.

## [0.1.5] — 2026-10-02

### Fixed

- **Switching provider in a new conversation before sending a message no longer gives "No conversation found with session ID".** Before, if in a new conversation you first switched in the model menu to a model from another provider (relay), the conversation immediately became "Error" and switching back didn't help. The cause was that the conversation had no record file yet, but switching tried to reopen it as "continue the earlier conversation". Now a conversation that has never had a message restarts within the same conversation. Sending a message after a new conversation has sat idle for half an hour, or switching models in a new conversation and triggering a restart, was the same problem and is fixed too.
- **Errors now start with a one-sentence plain explanation of what went wrong.** In the red text in conversations, in pop-ups and in `server.log`, common errors (folder not found, connection refused, wrong key, insufficient balance, region restriction, rate limiting, conversation too long…) first say what the problem is and what to do, with "Original: …" kept below so the raw error is visible in screenshots or when reporting a problem. Pop-ups stay a few seconds longer and the text can be selected and copied.
- When a conversation's project folder has been moved or deleted, it now says outright "Can't find this conversation's project folder" instead of suggesting you test the provider.
- **After switching provider, other windows immediately show the new model and "Starting".** Before, they sat on "Closed" and the old model for ten-odd seconds up to half a minute, and messages sent in that time were still delivered to the old provider.
- **Messages sent during the second or two of a provider switch are no longer refused or dropped.** The message waits until the new process is up and then goes out; opening the same conversation in another window at that moment also no longer quietly cancels the switch. If you switch while it is answering, this turn ends clearly with the note "Switched. This turn was interrupted."
- **Switching provider back and forth between the official Claude Code and ccb no longer loses the turns in between.** Before, turns that ran on ccb were invisible after switching back to the official Claude Code, and the next turn would also fork off from an earlier point. Continuing a web conversation in the terminal with `claude --resume` had the same problem and is fixed too.
- **New models such as Claude Opus 5.5 work on Claude-format relays.** Before, choosing one gave a 400 "requires adaptive thinking": the built-in ccb was too old to know these models. Now these models automatically run on the official Claude Code; if the conversation uses a feature only ccb has, it stays on ccb, just without thinking.
- **Cost is no longer added up repeatedly.** Before, each turn added the conversation's whole cost so far again, so a conversation that really cost $2.42 showed $17.42, and every turn in the ledger was recorded under the first model the conversation ever used. Now each turn records only its own cost and model.
- **Changing "Thinking effort" on ccb really takes effect now.** Before, you changed the level in the interface but what actually went out was still the old one. Now the conversation is reattached with the new level; if it's answering, the change waits until this turn ends. Relays in formats other than Claude (OpenAI / Gemini / Grok) never sent the level anyway, and the option is no longer shown for them.
- **You can now see the reason for errors reported by a relay.** Errors like insufficient balance or no available account used to show only "403 status code (no body)". "Insufficient account balance" is now described as insufficient balance, no longer as no permission.
- **Test connection is faster and failure reasons are clearer.** When a relay kept returning 5xx, it used to take 4 minutes to produce just "exit 1". Now it retries only once, a timeout says timeout outright, and for a relay outage or insufficient balance it no longer wastes time re-testing with the official Claude Code. A key that only works for image models now says "No chat models in the list" directly, and those models no longer appear in the model menu. Test connection also no longer leaves conversations like "Reply with exactly: ok" under "Other folder › Temp".
- **Switching back to "Claude account" really switches back.** Before, the interface said "Claude account" but the old provider was still the one answering, and still being charged.
- **For accounts that configured a relay by hand in `~/.claude/settings.json`, the default model no longer gets stuck.** Before, it was replaced with a model name the relay doesn't have, and hung for over three minutes before erroring.
- **Handing back to Claude from Codex (or another agent) no longer errors on the first message on ccb.** After handing back and reopening, the conversation is also no longer treated as a Codex conversation.
- **Continuing, in the terminal, a conversation that is open on the web no longer makes the web side miss those turns or lose them.** When a web conversation ran on the official Claude Code and was idle, `claude --resume` in the terminal couldn't see the web side's last reply; that is fixed too.
- An insufficient-balance error is no longer described as "quota used up, wait for the reset": it now says plainly that the provider account's balance is too low, so top up or switch provider; and "auto-continue when the time comes" no longer applies to it.
- When the process exits and the CLI output contains a more specific reason (not signed in, not a git repository, wrong key…), that reason is stated first instead of just "exit code 1".
- A turn interrupted by a provider switch no longer leaves an empty ledger row with no model and no usage.
- During Test connection, if reading the model list hits a dropped connection (disconnect, connection timeout), it retries once automatically instead of immediately reporting "wrong address".
- After handing back from Codex and the like to Claude, the conversation's title in the sidebar no longer shows as "# Conversation handoff …".
- A relay's qwen model (which returns an empty `reasoning_content`) no longer has its reply cut down to the first word.
- **For a Codex conversation opened on the web, turns continued with the Codex command line (`codex exec resume`) now show up on the web too.** The window that has this conversation open refreshes automatically; continuing on the web afterwards also keeps the right order.
- A Codex conversation open on the web releases its thread after two minutes idle, so `codex exec resume` in the terminal no longer reports "already has an active writer". If it was added to the conversation library before Codex ever ran, its conversations can be seen afterwards as well.
- When a conversation process errors, the error message now includes the reason the CLI itself printed (before, only "exited with code 1"), and `server.log` records the CLI's output too.
- When switching provider, the old CLI process ends immediately. Before, on Windows it kept running for a few more seconds, and in that time it could finish a turn for the old provider and charge for it with nothing visible in the window; occasionally it also reported "Session ID … already in use".
- A reopened Codex conversation shows the model it used; a fork of a fork has just one "(Fork)" in its title; renaming a conversation that has never had a message now explains in plain language that you must send a message first; the default model now picks the newest GPT (such as gpt-6.1), and among same-name entries that differ only in case, the lowercase one is preferred.

## [0.1.4] — 2026-10-01

### Fixed

- **When a conversation's process errors, it now says clearly what went wrong.** Before, if the process behind a conversation errored and exited right at startup, the interface kept showing "Thinking" with only an English "session … is error; reopen it to continue" popping up, and nothing was written to the log. Now:
  - the conversation shows the cause in red and the turn simply ends instead of spinning forever;
  - the pop-up is in plain language, with the cause and what to do;
  - the cause is written to the log (a `process failed:` line in `server.log`), so sending the log when you report a problem is enough to see it;
  - sending again in the errored conversation reopens it automatically.

### Documentation

- The README section "Connecting a third-party API / relay" gained screenshots of adding a provider quickly and of the model menu.

## [0.1.3] — 2026-09-30

### Added

- **The app checks for updates by itself and shows a pop-up when there's a new version.** Before, you only found a new version by opening **Settings → Advanced → Update** and clicking "Check for updates". Now it checks automatically after startup and every 4 hours:
  - **Windows installed version**: downloads the new version in the background, then pops up "Restart to update / Later"; choose "Later" and it installs by itself the next time you quit the app.
  - **macOS version and Windows portable version**: they can't install updates themselves (the macOS version has no Apple signature), so the pop-up gives the download link that fits this computer.
  - Important versions are marked as required, and the pop-up then has no "Later".
  - If you don't want automatic checks, turn them off in **Settings → Advanced → Update**.
- This changelog.

Note: automatic checking takes effect from this version; v0.1.2 and earlier need one last manual download and install of v0.1.3.

## [0.1.2] — 2026-09-30

This version mainly looks after two kinds of people: those who have no Claude account and only use relays or domestic Chinese models, and those running a proxy (rule mode).

### Added

- **Connect a model the first time you open the app, no Claude account needed.** The first step of the first-run guide is now "Connect a model": pick a relay, DeepSeek, Kimi, Zhipu, Tongyi, SiliconFlow, OpenRouter or Gemini, paste the API key, and click connect. The app first reads the model list, works out the format and the default model by itself, and then sends one very short test. When it fails it says the reason outright (wrong key, insufficient balance, wrong address, can't connect…). Signing in with a Claude account is still possible and sits in a secondary place on the same page.
- **Network proxy.** New **Settings → Providers → Network proxy**. The default is "Follow system": it first looks at the `HTTPS_PROXY` environment variable at startup, then reads the system proxy (Windows system proxy / PAC, macOS network settings). A proxy tool that only turns on the "system proxy" and not global mode now works: Test connection, fetching model lists, all conversations (including other agents such as Codex), IM bots and the built-in terminal all go through it, while local and LAN addresses still connect directly. A stale proxy left behind after the proxy tool quits is skipped automatically. You can also choose "Don’t use", or enter a custom HTTP proxy address.
- **IM bots, scheduled tasks and other agents can all use your providers.** New conversations default to the one set as default in **Settings → Providers**; each bot can pick "which provider to use" on its own, and each agent's (Codex, Gemini CLI…) card also lets you choose which provider "New conversations use".
- **Codex works with relays that only have chat/completions.** Most Chinese relays and vendors don't have the `/v1/responses` endpoint Codex needs; the app now converts automatically and remembers that this relay doesn't support it.
- **Agents installed elsewhere are found.** The codex bundled with the Codex desktop app or the VS Code / Cursor extension, and commands installed through fnm / pnpm / Volta / scoop, are all found; if one is found but errors when run, the error is shown instead of "not installed".

### Fixed

- When you use the Claude CLI in a terminal, or keep sending messages in Codex, the conversation open here now updates live (before, it only caught up after a restart).
- Codex conversation "Failed to load history: thread not loaded": it now reads in a different way; if it still can't be read, it says why and removes it from the list. Conversations already deleted in Codex are no longer listed.
- When an OpenAI-format provider had been marked "only accepts the official binary", all its models were greyed out in the menu; now that mark is ignored.
- When Test connection hits a region restriction ("Access from this region…"), the hint now tells you to check the network proxy instead of saying "wrong API key".
- The home page now shows the "List your Codex conversations here" prompt from the start (before, you had to finish the getting-started checklist or wait 3 days).
- The description of "Show workbench tools" now says outright: adding a provider or switching models doesn't require turning it on.

## [0.1.1] — 2026-09-30

A bug-fix release, mainly for the problem of showing "Thinking" forever and not stopping even when you click stop on OpenAI-compatible relays, and for users without a Claude account whose terminal exited as soon as they opened it.

### Fixed

- **Stop always stops.** When the conversation process is already gone but the interface still shows "Running", clicking stop ends the turn directly; when the runtime doesn't respond to an interrupt within 8 seconds, its process is killed and the same conversation is reattached, with no history lost.
- **A notice when the upstream never answers.** When no reply at all from the model has arrived for 3 minutes in a turn, it says the provider may not be responding and offers an "Interrupt" button. It also fixes a false "may be stuck" warning that appeared right away when you sent a message after more than 3 minutes of silence.
- **Third-party providers work when the computer has a system proxy set.** When `HTTP_PROXY` / `HTTPS_PROXY` is set, requests to the local cache-optimization service (127.0.0.1) now bypass the proxy automatically.
- **The terminal and the "Install" button work without a Claude account, with only a relay.** The terminal panel is now an ordinary command line (cmd on Windows, your default shell on macOS / Linux), and you can still type `claude` in it; "Sign in in the terminal" runs `claude auth login`.
- **OpenAI-compatible providers send requests for the model you chose.** Before, picking another model in the menu, or configuring haiku / sonnet / opus mappings, had no effect.

## [0.1.0] — 2026-09-29

The first public release: a visual workbench for Claude Code, usable as a desktop app or in the browser, and the same interface can also drive CLI agents such as Codex, Gemini CLI, Qwen Code, Kimi and OpenCode.

### Main features

- **Conversation**: streaming output; a finished turn folds into a one-line summary, ending with a changed-files card; permission cards sit above the input box, and pressing Enter on an empty box means allow once.
- **Side panel**: Review (per-file diff, stage, revert, commit), file tree and full-text search, terminal, tasks.
- **Workbench**: split the screen when needed (up to 6), tabs, groups; built-in Monaco editor and browser.
- **Providers and models**: the official account, Anthropic-compatible relays, OpenAI / Gemini / Grok interfaces, all in one model menu; a local model gateway provides multi-account failover and protocol conversion; prompt-cache optimization for third-party models.
- **Multi-agent**: Codex, Gemini CLI, Qwen, Kimi, OpenCode and any ACP agent; a conversation can be handed off to another agent to continue; their conversation history on this computer can also be listed in the same sidebar.
- **Automation**: scheduled tasks, goals (have it advance turn after turn until done), multi-agent orchestration (parallel runs, separate copies, approval nodes, compare).
- **Remote**: scan-to-pair phone access, SSH tunnels, conversations on other computers, Telegram / Discord / Slack / DingTalk / Feishu bots.

[0.1.7]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.7
[0.1.6]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.6
[0.1.5]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.5
[0.1.4]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.4
[0.1.3]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.3
[0.1.2]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.2
[0.1.1]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.1
[0.1.0]: https://github.com/ypyik0669/claude-web/releases/tag/v0.1.0
