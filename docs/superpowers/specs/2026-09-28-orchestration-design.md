# 多 agent 编排 设计（子项目 2）

日期：2026-09-28 · 状态：用户授权一次性实施（「把全部一次性都做完」）

## 目标

把一件事拆成若干步骤，每步交给用户选定的 agent（Claude / Codex / Gemini / OpenCode / 任意 ACP），可以并行、可以在各自的 git worktree 里做同一件事再比选，关键节点等人审批，全程有一张执行图。对标 Mirasim 的编排和 magpie 的多 agent 协作。

## 约束

- **只用用户选定的 agent**：可选列表 = `AgentRegistry` 里已安装且启用的 agent（`agents.list`），不自动拉起别的。
- 每个任务节点就是一个**普通会话**（`RunnerPool.open`），在侧栏、Mission Control、权限请求、账本里照常出现，用户可以随时点进去插话 / 中断。不另造运行时。
- 不花真 token 的测试：全部用 mock ACP agent（`server/src/agents/__mocks__/`）。
- 不写 agent 自己的数据文件。

## 模型

```ts
type OrchNode =
  | { id; kind: 'task'; title; agent: AgentKind; model?; prompt: string; dependsOn: string[];
      workspace: 'shared' | 'worktree'; permissionMode?; untilDone?: boolean }   // untilDone → 复用 GoalService 协议跑到 GOAL_STATUS: complete
  | { id; kind: 'compare'; title; agents: AgentKind[]; prompt; dependsOn; judge?: AgentKind }  // 同一提示词分发给 N 个 agent，各自 worktree
  | { id; kind: 'approval'; title; note?: string; dependsOn };                  // 等人：通过 / 驳回（附意见）
interface Workflow { id; name; description?; cwd: string; nodes: OrchNode[]; createdAt; updatedAt }
interface OrchRun { id; workflowId; name; cwd; baseBranch?; startedAt; finishedAt?; state: 'running'|'waiting'|'done'|'failed'|'cancelled';
  nodes: Record<nodeId, NodeRun> }
interface NodeRun { state: 'pending'|'running'|'waiting'|'done'|'failed'|'skipped'|'cancelled'; sessionIds: string[]; worktrees?: {agent, path, branch}[];
  output?: string; winner?: string; approval?: { decision: 'approve'|'reject'; comment?: string; at }; error?; startedAt?; finishedAt?; costUsd? }
```

- **提示词模板**：`{{input}}`（启动时用户填的输入）、`{{nodes.<id>.output}}`（上游节点最后一段助手正文）、`{{nodes.<id>.approval}}`（审批意见）。上游输出过长（> 8000 字）时截断并附会话引用 `<session-ref id=… />`，由现有 `expandSessionRefs` 展开成简报。
- **调度**：DAG，依赖全部 done 才启动；无依赖关系的节点并行（并发上限设置 `orchestra.maxParallel`，默认 3）。环 / 悬空依赖在保存时校验并报错。上游 failed / 被驳回 → 下游 skipped，run failed。
- **任务完成判定**：会话出一个 `result` 即完成（`untilDone` 时由 GoalService 的状态行决定）；`result.is_error` / 会话 error → failed。节点可「重试」（新开会话重跑）。
- **worktree**：`git worktree add <repo>/.claude-web/worktrees/<runId>-<nodeId>-<agent> -b cw/<runId>/<nodeId>-<agent>`（走现有 `GitService`），cwd 不是 git 仓库时 worktree 选项不可用（保存时报错）。
- **compare**：N 个候选并行跑完后节点进入 `waiting`，界面并排展示每个候选的回复、`git diff --stat` 和完整 diff；用户选胜者（或配置 `judge` 时先让裁判 agent 读各候选的 diff 与回复给出推荐，最终仍由用户确认）。选定后：胜者分支合并回 run 的基线分支（`git merge --no-ff`，冲突则节点 failed 并保留 worktree 让用户处理），其它 worktree 与分支删除；胜者的回复成为节点 output。
- **approval**：节点 `waiting`，界面 + Mission Control「需要你」+ 桌面通知 + IM（如已绑定）显示；通过继续，驳回则 run failed（意见记录下来）。
- **持久化**：工作流模板存 `meta.workflows`；运行记录存 `<dataDir>/orchestra/<runId>.json`（每次状态变化写盘）。server 重启时运行中的 run 标记为 `failed: 服务重启中断`，可以「从失败节点续跑」（已 done 的节点保留 output）。
- 事件：`orchestra.changed {run}` 广播。

## 接口

WS 请求：`orchestra.workflows.list/save/remove`、`orchestra.run.start {workflowId, input}`、`orchestra.runs.list`、`orchestra.run.get`、`orchestra.run.cancel`、`orchestra.run.resume`、`orchestra.node.retry`、`orchestra.node.approve {decision, comment}`、`orchestra.node.pick {winner}`。

## 界面

- 停靠面板「编排」（`PANELS` 加一行，图标手写）：左侧工作流列表 + 运行记录；右侧：
  - 编辑器：表单式节点列表（加节点、选类型 / agent / 依赖 / 工作区方式、提示词带变量提示），上方实时预览执行图。不做拖拽画布。
  - 运行视图：执行图（按拓扑层分列的节点卡片，连线用 SVG；状态色用设计令牌；运行中计时），点节点打开对应会话 tile；审批卡片；比选视图（候选并排、diff、选胜者）。
- 内置 3 个模板：「计划 → 实现 → 审查」（Claude 规划、Codex 实现、Claude 审查，中间一个审批）、「三方比选」（compare：claude/codex/gemini 中已安装的）、「修 bug + 测试」。
- 命令面板：「新建编排」「运行编排…」。

## 测试

- 单元：DAG 校验、调度（并行上限、依赖、失败传播、驳回）、模板变量替换、compare 流程（假 git 服务）、重启恢复。
- 端到端 `server/ws-phase14.mjs`：mock ACP agent 跑「两步 + 审批 + compare(2 个 mock agent，临时 git 仓库)」，断言会话被创建、审批阻塞、选胜者后合并、worktree 被清理。加入 `scripts/e2e.mjs` 默认列表。
