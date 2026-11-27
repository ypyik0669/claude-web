export interface MachoSlice { cpu: string; minos: string | null }
export interface MinOsVerdict {
  bad: { path: string; why: string }[];
  allowed: { path: string; why: string; rule: string }[];
  ok: number;
}
export function versionText(v: number): string;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function machoSlices(read: (offset: number, length: number) => Buffer): MachoSlice[] | null;
export function goVersionOf(buf: Buffer): string | null;
export function judgeMinOs(binaries: { path: string; slices: MachoSlice[]; go?: string | null }[], max: string, allow?: RegExp[], goMax?: string | null): MinOsVerdict;
