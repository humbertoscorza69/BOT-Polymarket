import * as path from 'path';
import { writeJsonAtomic, ensureDir } from './jsonStore';

export class SnapshotStore {
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  save(name: string, payload: unknown): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(this.dir, `${safe}.json`);
    writeJsonAtomic(file, payload);
    return file;
  }
}
