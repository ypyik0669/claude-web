// Side-effect module: MUST stay the first import of index.ts. ESM evaluates imports in order, so every
// module after it (and their `promisify(execFile)` captured at load time) sees the guarded child_process.
import { installSpawnGuard } from './spawn-guard.js';

installSpawnGuard({ role: 'server' });
