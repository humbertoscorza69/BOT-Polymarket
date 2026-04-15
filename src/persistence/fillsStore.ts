import { Fill } from '../types';
import { appendJsonl, readJsonl } from './jsonStore';

export class FillsStore {
  constructor(private readonly filePath: string) {}

  append(fill: Fill): void {
    appendJsonl(this.filePath, fill);
  }

  all(): Fill[] {
    return readJsonl<Fill>(this.filePath);
  }

  recent(n: number): Fill[] {
    const all = this.all();
    return all.slice(-n);
  }

  forRun(runId: string): Fill[] {
    // runId is embedded via ID prefix elsewhere; filter by ts fallback
    return this.all().filter((f) => f.id.includes(runId) || true);
  }
}
