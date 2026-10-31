/** pay only: maxAmount = largest approved amount; unpriced = some approved payment had no amount (never upgraded). */
export interface TrustEntry { approvals: number; lastAt: number; maxAmount?: number; unpriced?: boolean }
/** key = `${cls}|${scopeKey}` */
export type TrustMap = Record<string, TrustEntry>;
/** a call the user approved in the inbox */
export interface ApprovedCall { toolName: string; input: Record<string, unknown> }
/**
 * `<bot>/resumes.json`: approved steps whose resumed run hasn't started yet, per conversation. Kept on disk until the
 * run starts, so a restart / a new holder of the lease picks them up (a budget wait included).
 */
export interface PendingResume { sessionId: string; routineId: string; approved: ApprovedCall[]; at: number }
export interface RoutineState { fingerprint?: string; checkpoint?: string; lastSummary?: string; updatedAt: number }
/**
 * `<bot>/thread.json`: the bot's own conversation as the list sees it. lastLine = its last reply; seenAt = when the
 * user last looked (what counts as unseen); deliveredAt = the newest timeline entry already told to the model.
 */
export interface ThreadState { lastLine?: { text: string; at: number }; seenAt?: number; deliveredAt?: number; updatedAt: number }
