// Keeps the PC from sleeping while remote access is on — a sleeping PC can't be reached from the phone. The server
// tells the shell what it wants ({type:'keepAwake', on} over parentPort, see server/src/remote/keep-awake.ts, at its
// startup and whenever the answer changes); main.ts wires KeepAwake to Electron's powerSaveBlocker. No electron
// imports: desktop/src/keep-awake.test.ts runs this under vitest.

/** Remote access on, and the 不让电脑睡眠 setting (meta `remote.keepAwake`) not turned off — unset means on. */
export function keepAwakeWanted(s: { remoteEnabled: boolean; keepAwake: boolean | undefined }): boolean {
  return s.remoteEnabled && s.keepAwake !== false;
}

/** The part of Electron's powerSaveBlocker this uses. */
export interface PowerSaveApi {
  start(type: string): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** Holds at most one 'prevent-app-suspension' blocker: the screen may still turn off, the system doesn't sleep. */
export class KeepAwake {
  private id: number | null = null;

  constructor(private readonly api: PowerSaveApi) {}

  set(on: boolean): void {
    if (on) {
      // already holding one — unless it was stopped from elsewhere, then start a new one
      if (this.id !== null && this.api.isStarted(this.id)) return;
      this.id = this.api.start('prevent-app-suspension');
    } else if (this.id !== null) {
      this.api.stop(this.id);
      this.id = null;
    }
  }
}
