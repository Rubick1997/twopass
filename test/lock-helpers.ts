import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCK_FILE, type RunLock } from '../src/lock.ts';

export function writeRunLock(dir: string, lock: RunLock): void {
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock));
}
