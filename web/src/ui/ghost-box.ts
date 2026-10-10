// The pure parts of a leaving copy (ui/ghost.ts): what it is called and where it floats.

export interface GhostOpts {
  /** how long the exit animation runs (the copy is removed when it ends, or shortly after this) */
  ms: number;
  /** the class that carries the exit animation */
  className: string;
  /** rename a class on the copy's root: the class the page (and its tests) look the real thing up by */
  rename?: [from: string, to: string];
  /** descendants the copy must not carry (a live region that would be read out again) */
  strip?: string;
  /** take the copy out of the flow, where the original was: what replaces it must not be pushed around */
  float?: boolean;
}

/** The copy's class list: the original's, the looked-up class renamed, the leaving class added. */
export function ghostClass(className: string, o: Pick<GhostOpts, 'className' | 'rename'>): string {
  const names = className.split(/\s+/).filter(Boolean).map((c) => (o.rename && c === o.rename[0] ? o.rename[1] : c));
  return [...names, o.className].join(' ');
}

/**
 * Absolute coordinates for a copy that floats where the original was, inside the same offset parent: by its
 * distance from the parent's bottom — what is under it (the composer's box) keeps its place when the original goes,
 * what is above it does not.
 */
export function floatBox(el: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number }, parentClientHeight: number): { left: number; bottom: number; width: number } {
  return { left: el.offsetLeft, bottom: Math.max(0, parentClientHeight - el.offsetTop - el.offsetHeight), width: el.offsetWidth };
}
