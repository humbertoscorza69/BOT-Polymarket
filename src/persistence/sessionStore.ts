import * as path from 'path';
import { SessionSummary } from '../types';
import { writeJsonAtomic, ensureDir } from './jsonStore';

export class SessionStore {
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  save(summary: SessionSummary): string {
    const file = path.join(this.dir, `${summary.runId}.json`);
    writeJsonAtomic(file, summary);
    return file;
  }
}
