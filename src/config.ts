import { EnvConfig, loadEnv } from './env';
import { newRunId } from './utils/ids';

export interface BotConfig extends EnvConfig {
  runId: string;
  startTs: number;
  dataDir: string;
  logsDir: string;
  fillsFile: string;
  sessionsDir: string;
  snapshotsDir: string;
  paramsStateFile: string;
}

export function buildConfig(): BotConfig {
  const env = loadEnv();
  const startTs = Date.now();
  const runId = newRunId();
  const dataDir = 'data';
  return {
    ...env,
    runId,
    startTs,
    dataDir,
    logsDir: `${dataDir}/logs`,
    fillsFile: `${dataDir}/fills.jsonl`,
    sessionsDir: `${dataDir}/sessions`,
    snapshotsDir: `${dataDir}/snapshots`,
    paramsStateFile: `${dataDir}/params_state.json`,
  };
}
