/** pay only: maxAmount = largest approved amount; unpriced = some approved payment had no amount (never upgraded). */
export interface TrustEntry { approvals: number; lastAt: number; maxAmount?: number; unpriced?: boolean }
/** key = `${cls}|${scopeKey}` */
export type TrustMap = Record<string, TrustEntry>;
export interface RoutineState { fingerprint?: string; checkpoint?: string; lastSummary?: string; updatedAt: number }
