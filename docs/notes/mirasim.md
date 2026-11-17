# 从 Mirasim 借鉴的功能（2026-09-02）

- **额度环**：`server/src/usage/limits.ts` 读 `~/.claude/.credentials.json` 的 OAuth token 调 `api.anthropic.com/api/oauth/usage`（CLI 的 `/usage` 同源）。该接口 429 很积极：缓存 4 分钟，429 后退避 15 分钟，别加轮询。
- **工作区 / 置顶 / 归档 / 定时任务 / UI 设置** 存在 `~/.claude-web/meta.json`（`server/src/meta/store.ts`），Claude Code 本身不持久化这些。
- **分叉**：走 SDK `forkSession(id, {upToMessageId})` 先复制 transcript 拿到新 id 再 resume；不要用 `--fork-session`，那条路的新 id 要到第一轮才知道。
- **插话**：SDK user message 加 `priority: 'now'`。
- **worktree 会话**：`extraArgs: { worktree: name }`。
- 浏览器占用 Ctrl+N，新会话快捷键是 Alt+N；命令面板 Ctrl+K。

## meta.json 的新键（阶段 C，2026-10-25）

- workspace 的 `folders: string[]`：项目的额外文件夹（不含主文件夹），缺省读成 `[]`，见 `phase03-files-git`「项目的额外文件夹」。
- sessions 的 `extraDirs: string[]`（2026-11-17）：对话自己加的工作目录，只经 `session.setExtraDirs` 写，见「界面改版 阶段 3」的「添加文件夹 = 加工作目录」。
- settings `ui.sidebar.view`：侧栏「显示」菜单（分组 / 排序 / 显示已归档 / 其它 agent / 每组），`ui.sidebar.sections`：自建分区 `[{ id, name, ids }]`，见 `ui-redesign-4-sidebar`「一个显示菜单」。
