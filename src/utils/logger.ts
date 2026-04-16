/* eslint-disable no-console */
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  ctx?: Record<string, unknown>;
  module?: string;
}

export class Logger {
  private minLevel: number;
  private sink?: (e: LogEntry) => void;
  private fileStream?: fs.WriteStream;

  constructor(
    private readonly module: string,
    level: LogLevel = 'info',
    sink?: (e: LogEntry) => void,
  ) {
    this.minLevel = LEVELS[level];
    this.sink = sink;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVELS[level];
  }

  attachFile(filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fileStream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (e) {
      console.error('[logger] failed to attach file', e);
    }
  }

  child(module: string): Logger {
    const lg = new Logger(`${this.module}:${module}`, 'info', this.sink);
    lg.minLevel = this.minLevel;
    lg.fileStream = this.fileStream;
    return lg;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('debug', msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('info', msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('warn', msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('error', msg, ctx);
  }

  private emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVELS[level] < this.minLevel) return;
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx, module: this.module };
    const stamp = new Date(entry.ts).toISOString();
    const base = `[${stamp}] [${level.toUpperCase()}] [${this.module}] ${msg}`;
    const ctxStr = ctx && Object.keys(ctx).length > 0 ? ' ' + safeJson(ctx) : '';
    const line = base + ctxStr;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.fileStream) this.fileStream.write(line + '\n');
    if (this.sink) {
      try {
        this.sink(entry);
      } catch {
        /* sink errors are ignored */
      }
    }
  }
}

const SENSITIVE_KEYS = /^(private[_-]?key|secret|passphrase|api[_-]?key|password|token)$/i;

function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, (k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) return { message: v.message, stack: v.stack };
      if (typeof k === 'string' && SENSITIVE_KEYS.test(k) && typeof v === 'string') return '[REDACTED]';
      return v;
    });
  } catch {
    return '[unserializable]';
  }
}

let rootLogger: Logger | null = null;

export function initRootLogger(level: LogLevel, filePath?: string): Logger {
  rootLogger = new Logger('root', level);
  if (filePath) rootLogger.attachFile(filePath);
  return rootLogger;
}

export function getLogger(module: string): Logger {
  if (!rootLogger) rootLogger = new Logger('root', 'info');
  return rootLogger.child(module);
}
