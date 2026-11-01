# 文件 / Git / 编辑器（阶段 3，2026-09-03）

- 服务端三个新服务：`server/src/files/service.ts`（`fs.open/write/mkdir/create/rename/copy/trash/watch`，`write` 带 `expectMtime` 冲突检测；回收站在 Windows 走 PowerShell 的 `Microsoft.VisualBasic.FileIO`，macOS 走 Finder，Linux 走 `gio trash`）、`server/src/search/service.ts`（ripgrep `--json`；`resolveRg()`：优先用 Claude Code 二进制自带的（argv0 设成 `rg` 启动），没有再找 Homebrew 的 rg / PATH；以前用 ccb 自带的 ripgrep）、`server/src/git/service.ts`（porcelain v2 解析、`classifyGitError()` 把 stderr 归成 15 类并配修复提示，`GitCommandError` 在 hub 里编码成 `message\n\n[kind] hint`，客户端 `GitView` 解析回来给「一键修复」按钮）。
- `GET /api/file?path=&token=` 直出本地文件（图片 / PDF / 媒体预览用，支持 Range），CSP sandbox。
- 编辑器是 Monaco 0.56：`web/src/features/editor/monaco.ts` 懒加载，worker 用 exports 映射写法 `monaco-editor/editor/editor.worker.js?worker`（`esm/vs/...` 路径会被 exports 的 `./*` 规则映射错）。主题从 CSS 变量算出来，切主题时 MutationObserver 重定义。每个路径一个 model（多个 tile 共享），tile 关闭只 dispose editor。
- Doc tile：自动保存（`ui.autoSave`，默认开，停手 0.8s）、`fs.watch` 检测磁盘变更（干净时静默重载，脏时横幅二选一）、Ctrl+S、未保存关闭确认（store `dirtyDocs` + `closeTile`）。同一路径的 doc / diff tile 在同一窗格内去重（`tile.open` 里比较归一化路径）。
- 会话 tile 的工作台视图（`tile.wb`；标签行已从默认界面移走，入口是会话头 `···` 和命令面板；**改动 / Git / 文件 / 搜索 / 生成的文件 / Issue 与 PR 打开的是右侧面板**（手机上是底部抽屉），定时任务是自动化页，只有远端会话才原地换视图，见「界面改版 阶段 2 / 7」）：改动（会话触碰的文件）/ Git（`GitView`：分支切换新建、拉推 fetch、暂存 / 取消 / 丢弃、提交 amend、历史（点开提交 diff）、worktree 列表新建删除、stash）/ 文件（`FileTree`：git 徽章、右键菜单、内联新建重命名、F2、回收站）/ 搜索（`SearchView`：大小写 / 全词 / 正则 / include / exclude，替换可逐行排除）。
- 后台 fetch：`git.watch` 过的仓库每 5 分钟 `fetch --prune`，`.git/HEAD|index|refs` 变化广播 `git.changed`。
- `server/ws-phase3.mjs`：文件操作 / 冲突检测 / 搜索替换 / 回收站 / git 只读 的端到端检查（在 detached HEAD 下跑时 `branch` 可以是 null、分支列表里没有当前分支）。

## 项目的额外文件夹 / 多根面板（阶段 C，2026-10-25）

- 项目（workspace）可以有额外文件夹：meta.json 里 workspace 的 `folders: string[]`（不含主文件夹 `path`），读的时候补 `[]`（`meta/workspace-folders.ts` 的 `normFolders`：去重、去掉主文件夹、Windows 上不分大小写），老数据不用迁移。改用 `workspaces.update { id, name?, folders? }`：每个文件夹都要存在且是目录，不然整次拒绝（「找不到这个文件夹：…」），不写半截。
- 「编辑项目」对话框 `sidebar/ProjectDialog.tsx`（项目 ··· / 右键菜单的「编辑项目…」）：名字、源文件夹（主文件夹在第一行、不能删；「添加文件夹」用选文件夹对话框；× 删除）、从侧栏移除项目（先确认）。保存走 store 的 `updateWorkspace`，服务端拒绝时 toast、对话框不关。
- 面板：`features/paths.ts` 的 `projectRoots(cwd, workspaces)`——对话在项目主文件夹里时是 `[主, ...folders]`，否则只有 cwd。文件、搜索、Git（审阅里的 Git）按这个列表画 `workbench/RootGroups.tsx`：一个文件夹一组、可折叠；只有一个文件夹时和以前完全一样。@文件补全对每个根各查一次再合并。
- 额外文件夹是 UNC 信任根：`files/service.ts` 的 `workspaceRoots(meta.workspaces())` 把 `folders` 也算进去（`\\nas\share` 上的额外文件夹能读）。
- 只在**新开的**对话里生效（`AgentPool.open` 时按 cwd 查一次）；正在跑的对话下次打开时才看到。给 Claude 的是 SDK 的 `additionalDirectories`（以前其它 agent 各有各的传法，随「只留 Claude」删了）。
- e2e 第 33 期（`server/ws-phase33.mjs`）：真 server + 真引擎 + 假上游，断言 `workspaces.update` 的校验，以及项目里开的对话发给模型的请求里写着额外文件夹（Claude Code 把它放进环境段的 additional working directories）、不是项目主文件夹的对话里没有。
