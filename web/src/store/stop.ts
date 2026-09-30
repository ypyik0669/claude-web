/**
 * Stop on a conversation the server no longer runs (its process was closed or crashed, or the server restarted
 * while this window still showed the turn as running): `session.interrupt` answers `{ running: false }` and the
 * turn this window still shows is ended here, with a result the reducer finishes like any other.
 */
export const STALE_STOP_TEXT = '这个对话的进程已经不在运行了（可能已被关闭，或服务重启过），这一轮已结束。直接发送新消息会重新接上。';

export function staleStopResult(sessionId: string, now = Date.now()) {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: STALE_STOP_TEXT,
    terminal_reason: 'aborted_stale',
    duration_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
    session_id: sessionId,
    uuid: `stale-stop-${now}`,
  };
}

/** What the server said to `session.interrupt`: an older server answers `null`, which means it was running. */
export function stopFoundNothing(reply: unknown): boolean {
  return !!reply && typeof reply === 'object' && (reply as { running?: unknown }).running === false;
}
