# 多 agent 编排 实现计划（子项目 2）

spec：`docs/superpowers/specs/2026-09-28-orchestration-design.md`

## 任务

1. **类型**（`server/src/orchestra/types.ts`，protocol.ts `export *` + 在 `ClientRequest` / `ServerEvent` 联合里各追加一个别名）
   - `OrchNode` / `Workflow` / `OrchRun` / `NodeRun` / `CompareCandidate` / `OrchestraRequest` / `OrchestraEvent`。
2. **纯逻辑**（`server/src/orchestra/dag.ts` + `dag.test.ts`）
   - `validateWorkflow(w, {isGitRepo})`：重复 id、悬空依赖、环、空提示词、compare 少于 2 个 agent、worktree / compare 要求 git 仓库。
   - `topoLayers(nodes)`：按拓扑层分列（UI 执行图也用）。
   - `renderPrompt(tpl, ctx)`：`{{input}}` / `{{nodes.<id>.output}}` / `{{nodes.<id>.approval}}`，输出 > 8000 字截断 + `<session-ref id="…" />`。
   - `parseWinner(text, agents)`：裁判回复里的 `WINNER: <agent>`。
3. **引擎**（`server/src/orchestra/service.ts` + `service.test.ts`）
   - `OrchestraService`，依赖全部注入（`OrchDeps`：会话打开器、git 适配、goals、存储目录、设置读取、通知回调），单测用假会话 / 假 git。
   - 调度：每次状态变化 `tick()`；依赖全 done 才启动；每个 run 同时运行的节点 ≤ `orchestra.maxParallel`（默认 3）；上游 failed / cancelled / skipped → 下游 skipped；所有节点终态后 run done / failed。
   - task：开会话 → 发提示词 → 第一个 `result` 完成（`is_error` / 会话 error / closed → failed）；`untilDone` 走 GoalService（create + start，监听 `changed`：complete → done，blocked / max_turns → failed）。
   - worktree：`<root>/.claude-web/worktrees/<runId>-<nodeId>-<agent>`、分支 `cw/<runId>/<nodeId>-<agent>`，从 run 的基线分支拉。
   - compare：N 个候选并行，全部结束后自动提交各 worktree 的改动、算 `diff --stat`，节点 `waiting`；配置 judge 时开裁判会话给推荐。`pick` → `merge --no-ff` 到基线分支 → 删除其它 worktree 与分支。
   - approval：`waiting` → approve / reject。
   - 持久化：`<dataDir>/orchestra/<runId>.json` 每次变化写盘（按 run 串行写）；启动时加载，`running|waiting` 的 run → failed「服务重启中断」；`resume` 把非 done 节点重置为 pending。
   - `retry`：节点及其被跳过的下游重置为 pending。
   - 内置 3 个模板（`ORCH_TEMPLATES`），`workflows.list` 在用户没有任何工作流时不自动写入，模板单独返回。
4. **接线**
   - `server/src/orchestra/handlers.ts`：`handleOrchestra(svc, req)`；hub.ts 只加一行分发 + 一行广播；index.ts 构造 service。
   - `server/src/orchestra/runtime.ts`：真正的会话打开器（与 hub 的 `session.open` / `session.send` 同一套：canonical、默认供应商、外部 agent 标题、`expandSessionRefs`）与 git 适配（包 `GitService`）。
   - meta store 追加 `workflows()` / `setWorkflow()` / `removeWorkflow()`。
   - IM：`ImRouter` 追加 `announce(sessionIds, text, buttons)` 与 `orch:` 回调前缀（通过 / 驳回按钮）。
5. **前端**
   - `web/src/features/orchestra/state.ts`：独立 zustand 小 store（runs / workflows / 模板），订阅 `orchestra.changed`，节点进入 waiting 时发桌面通知。
   - `OrchestraPanel.tsx`：左列工作流 + 运行记录；右侧编辑器（表单节点列表 + 实时执行图预览）/ 运行视图（执行图 SVG 连线、审批卡、比选视图）。`graph.ts` 放布局纯函数（带单测）。
   - `PANELS` 加 `orchestra`、`PanelBody` 加 case、图标 `orchestra` 手写、命令面板「新建编排」「运行编排…」。
   - Mission Control「需要你」列显示 approval / compare 等待卡片。
6. **收尾**：`server/ws-phase14.mjs`、`scripts/e2e.mjs` 加 14、CLAUDE.md / README 小节、截图、提交。

## 裁决

| 裁决 | 理由 | 代价 |
| --- | --- | --- |
| 并发上限按 **run** 计（每个 run 同时运行的 task / compare 节点数），approval 等待不占名额 | spec 说「无依赖关系的节点并行（并发上限…）」，对象是节点；跨 run 全局限流会让一个大 run 饿死别的 | 同时开多个 run 时总会话数可以超过 3 |
| compare 节点占 1 个名额（不论候选数） | 候选数本来就是用户显式选的 | compare 里 3 个候选时同时会有更多会话 |
| 某节点失败后，**不相关的分支继续跑**，直到没有可推进的节点，run 才落 failed | 已经在跑的会话不该被硬停，独立分支的结果也有价值 | run 结束得比「一失败就停」晚 |
| 候选 / worktree 任务结束时**自动提交** worktree 里未提交的改动（`orchestra: <节点> by <agent>`）；身份缺失时用 `claude-web` 身份重试 | agent 多半不会自己 commit，不提交就没法 `merge` 也没法算分支 diff | 在用户仓库里多出提交（在分支上，merge --no-ff 保留历史） |
| `task` 节点选 `worktree` 时，完成后同样合并回基线分支并删除 worktree 与分支（冲突 → failed、保留） | 否则下游节点看不到它的改动，worktree 选项就没意义 | 与 compare 一致的合并风险 |
| 合并冲突时 `merge --abort`，节点 failed，保留 worktree 与分支，错误里写明分支名 | 不把用户的主工作区留在半合并状态 | 用户需要自己 `git merge <分支>` 解决 |
| 胜者合并后删除**所有** worktree 目录；落选分支 `-D` 删除，胜者分支保留 | 胜者分支已合并，留着便于追溯；目录没用了 | 仓库里留一个 `cw/...` 分支 |
| 合并前检查基线 cwd 当前分支 == run 的 `baseBranch`，不等就报错不合并 | 避免把结果合到用户临时切过去的分支上 | 用户切回去后要「重试 / 重新选择」 |
| 在仓库的 `.git/info/exclude` 里追加 `/.claude-web/` | worktree 放在仓库里，不排除的话主工作区 `git status` 会一直显示它 | 改了用户仓库的 info/exclude（只追加一行、本地、不入库） |
| 服务重启：`running` 与 `waiting` 的节点都 → failed「服务重启中断」，run failed；`resume` 重置所有非 done 节点 | 与 spec 一致；compare 等待态的 worktree 在重置时先清理，重新跑 | 重启会丢掉等待中的比选结果 |
| 取消 run：中断运行中的会话，所有未终态节点 → cancelled，**保留** worktree | 取消常常是为了看一眼现场 | 需要手动清理（节点卡片上显示路径） |
| 增加 `orchestra.node.diff {runId,nodeId,agent}` 与 `orchestra.templates` 请求 | 比选视图要完整 diff；模板要给前端 | 比 spec 多两个请求 |
| 发给 agent 的提示词第一行加 `[编排 <run 名> · <节点名>]` | 会话标题（Claude 从首条提示派生、外部 agent 取首条文本）一眼能认出是编排开的 | 提示词多一行 |
| 裁判回复最后一行 `WINNER: <agent>` 解析成推荐；解析不到就只展示正文 | 用户最终确认，推荐只是辅助 | — |
| 前端运行记录用独立的小 store（`features/orchestra/state.ts`）而不是往 `store/index.ts` 里加 | 共享文件只做最小改动 | App 里多一行初始化 |

## 审查后修订（2026-09-28，覆盖上表中冲突的条目：worktree 位置、exclude、清理 / 重试行为）

| 裁决 | 理由 | 代价 |
| --- | --- | --- |
| worktree 放 `<dataDir>/worktrees/<仓库名>-<hash8>/…`（M5 选项二），不再写 `.git/info/exclude` | 仓库父目录可能是家目录或 monorepo，往那里写不可控；dataDir 本来就是本应用的地盘 | worktree 与仓库不在一起，路径较长 |
| 合并前拒绝：进行中的 merge / cherry-pick / revert / rebase、暂存区非空；只 abort 自己造成的 MERGE_HEAD | C1 | 用户要先收拾好工作区才能选胜者 |
| 任何删除都走 `drop()`：脏 worktree 保留；分支只在已合并（`-d`）或仍停在编排记录的提交（`-D`）时删 | C2 / I1 | 用户手动改过的落选分支会留下，需要手动清理（面板列出来） |
| 重试 / 续跑换 `-attemptN` 新名字，旧的进 `retained`，不删除旧 worktree | C2 | 多次重试会积累 worktree，删运行记录时可选清理 |
| 比选合并失败回到 waiting；任务节点合并失败仍是 failed（保留 worktree） | 比选还能重新选；任务节点没有「选择」这一步 | — |
| IM 审批只接受绑定了该 run 某会话的聊天；没有绑定时不退回默认聊天 | 网关没有「默认聊天」概念，硬造一个会把审批发错地方 | 想在 IM 审批要先绑定 |
| 用户动作按 run 加锁（审批不加锁，它在第一个 await 之前就切了状态） | I2 | 合并进行中对同一 run 的其它操作会被拒绝，稍候重试 |
