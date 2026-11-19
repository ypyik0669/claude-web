// 子代理硬绑定 (2026-10-19 user request): a subagent model picked for a conversation means the user wants its work
// done by subagents — without having to say 「用子代理」 in every prompt. The main model was left to judge, and often
// did the work itself. Pure prompt text, a section of the system prompt; the model itself is bound by
// CLAUDE_CODE_SUBAGENT_MODEL (every subagent, whatever its definition or the tool call asks for).

/** The model's own name in a pick: `cw-x:<provider>:<model>` → `<model>`. */
export function subagentModelName(pick: string): string {
  return pick.replace(/^cw-x:[^:]*:/, '');
}

/** The system-prompt section for a picked subagent model ('' = none: same as the main model, or 只聊天). */
export function subagentPolicyPrompt(pick: string | undefined): string {
  const model = pick ? subagentModelName(pick) : '';
  if (!model) return '';
  return [
    '# Subagents',
    `The user has assigned a dedicated model to subagents (${model}) and wants the work done by them. This is a standing instruction that applies to every request, however small: the user does not need to ask for subagents in each message.`,
    '- Any work that needs tools — reading or searching files, exploring the codebase, research, running commands or tests, editing or writing code, reviews — goes to subagents through the Agent tool. Do not do it yourself in the main conversation, even when it looks quick.',
    '- This user instruction overrides the general guidance on when not to use the Agent tool (such as "to read a specific file path, use the Read tool instead"): in this conversation, those cases go to a subagent too.',
    '- Launch independent pieces in parallel (several Agent calls in one message); one subagent is fine for a small task.',
    '- Keep for yourself only: understanding the request, planning, decisions, combining the subagents\' results, managing the plan (TodoWrite), and talking to the user. Answer directly without a subagent only when no tool is needed at all.',
    '- Give each subagent a complete, self-contained brief: the goal, the relevant files and paths, constraints, and what to report back.',
    `- Do not pass a \`model\` to the Agent tool: every subagent runs on ${model} regardless.`,
    `- In the main conversation, direct calls of ${[...DELEGATED_TOOLS].join(', ')} are refused: hand that work to a subagent from the start.`,
  ].join('\n');
}

/**
 * The tools that do the work — reading / searching files, running commands, editing, fetching from the web. With a
 * subagent model picked, the main thread's own calls of these are refused (`delegateDecision`): 2026-11-19 community
 * report, reproduced on a real relay — Opus 5.5 with a DeepSeek subagent model read three small files itself, the
 * `# Subagents` section above notwithstanding (in October it was enough). Everything else stays the main thread's:
 * Agent, TodoWrite, questions to the user, plan mode, skills, MCP tools.
 */
export const DELEGATED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']);

/**
 * The PreToolUse hook's answer for one call in a conversation with a subagent model (`pick`, '' = none any more: the
 * user went back to 「跟主模型一样」 and the process has not restarted yet): a refusal with a pointer to the Agent tool
 * for the main thread's work tools, null for the rest. `agentId`: set when a subagent calls (both engines put the
 * caller's agent id on the hook input; the main thread has none).
 */
export function delegateDecision(tool: string, agentId: string | undefined, pick: string | undefined): { reason: string } | null {
  const model = pick ? subagentModelName(pick) : '';
  if (!model || agentId || !DELEGATED_TOOLS.has(tool)) return null;
  return { reason: `Not run: in this conversation the user has assigned all tool work to subagents (${model}). Use the Agent tool instead, with a complete, self-contained brief (the goal, the files and paths, what to report back); do not do this step in the main conversation.` };
}
