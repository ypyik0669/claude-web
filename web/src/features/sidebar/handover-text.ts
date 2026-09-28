import { isImportedSessionId } from '@/util';

const ACTIVE = new Set(['running', 'waiting', 'starting']);

/**
 * Is the conversation mid-turn? This window's own state when it has one; otherwise (not open here, or only its
 * history loaded) the session list's `live` — a turn driven by IM, a schedule or another window counts too.
 */
export function turnRunning(openState: string | undefined, live: string | undefined): boolean {
  const state = openState && openState !== 'history' ? openState : live;
  return !!state && ACTIVE.has(state);
}

/** Body of the hand-over confirm: in place for claude-web / Claude conversations, a new one for imported ones. */
export function handOverMessage(sessionId: string): string {
  const tail = '新 agent 会收到一份结构化交接说明（已决定什么、改过哪些文件、试过什么失败了）。思考/推理内容带签名或加密，跨厂商无法携带，不会带过去。';
  return isImportedSessionId(sessionId)
    ? `这是从其它 agent 导入的对话：交接会新建一个对话（同一工作目录），原对话保持不变。${tail}`
    : `对话 id、标题和历史都保留。${tail}`;
}

/**
 * The hand-over confirm (··· 「交给其它 Agent 继续」 and the model menu): 「对话」 throughout, the model as the menu
 * shows it (not its raw id), and a warning when a turn is running.
 */
export function handOverConfirmText(o: { sessionId: string; agentName: string; modelLabel?: string; running: boolean }): { title: string; message: string } {
  return {
    title: `把这个对话交给 ${o.agentName}${o.modelLabel ? `（${o.modelLabel}）` : ''}？`,
    message: `${o.running ? '对话正在运行，当前这一轮会被中断。' : ''}${handOverMessage(o.sessionId)}`,
  };
}
