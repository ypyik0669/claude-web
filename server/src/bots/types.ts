export interface TrustEntry { approvals: number; lastAt: number }
/** key = `${cls}|${scopeKey}` */
export type TrustMap = Record<string, TrustEntry>;
export interface RoutineState { fingerprint?: string; checkpoint?: string; lastSummary?: string; updatedAt: number }
