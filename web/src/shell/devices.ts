// The PCs this phone has paired with. The device token lives only here (IndexedDB, keyed by the PC's id for this
// device): it never goes into a URL the shell navigates to, only into the requests it sends over the link.
// (Type-only imports here: vite.shell.config.ts loads assets.ts, which imports this file, without the aliases.)
import type { BrokerDef } from '@anywhere';
import type { PcLists } from './pair-link';

/** The PC's ids for paired devices: 12 lowercase hex (RemoteService, randomBytes(6).toString('hex')). */
export const DEVICE_ID_RE = /^[0-9a-f]{12}$/;

export interface DeviceRec {
  /** The PC's id for this phone (from api/pair); also part of the app cache's name. */
  id: string;
  pcName: string;
  token: string;
  pairedAt: number;
  /** Last time a connection to it opened the app. */
  lastAt?: number;
  /**
   * The PC's signaling brokers and STUN servers, from its pairing link: present only when the PC was not on the
   * defaults when it paired. Every dial of this PC uses them (a record without them: the defaults).
   */
  brokers?: BrokerDef[];
  stun?: string[];
}

/** The lists a dial of this PC uses (the localStorage override still wins over them, main.ts). */
export function listsOf(d: DeviceRec): PcLists {
  return { ...(d.brokers !== undefined ? { brokers: d.brokers } : {}), ...(d.stun !== undefined ? { stun: d.stun } : {}) };
}

export interface DeviceStore {
  /** Most recently used first. */
  list(): Promise<DeviceRec[]>;
  /** Adds, or replaces the one with the same id. */
  put(d: DeviceRec): Promise<void>;
  remove(id: string): Promise<void>;
}

const recent = (d: DeviceRec) => d.lastAt ?? d.pairedAt;
const byRecent = (a: DeviceRec, b: DeviceRec) => recent(b) - recent(a);

function isRec(v: unknown): v is DeviceRec {
  const d = v as DeviceRec;
  return !!d && typeof d.id === 'string' && typeof d.token === 'string' && typeof d.pcName === 'string' && typeof d.pairedAt === 'number';
}

/** For tests (and a browser without IndexedDB, for one visit). */
export function memoryDevices(): DeviceStore {
  const m = new Map<string, DeviceRec>();
  return {
    async list() {
      return [...m.values()].map((d) => ({ ...d })).sort(byRecent);
    },
    async put(d) {
      m.set(d.id, { ...d });
    },
    async remove(id) {
      m.delete(id);
    },
  };
}

const DB = 'cw-shell';
const STORE = 'devices';

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let opened: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((e) => {
    // the next call tries again (a private window, a blocked open)
    opened = undefined;
    throw e;
  });
  return opened;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const t = (await db()).transaction(STORE, mode);
  const committed = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
  // both awaited together: a failed request also aborts the transaction, and neither rejection is left unhandled
  const [r] = await Promise.all([done(fn(t.objectStore(STORE))), committed]);
  return r;
}

export function idbDevices(): DeviceStore {
  return {
    async list() {
      const all = await tx('readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
      return all.filter(isRec).sort(byRecent);
    },
    async put(d) {
      await tx('readwrite', (s) => s.put({ ...d }));
    },
    async remove(id) {
      await tx('readwrite', (s) => s.delete(id));
    },
  };
}
