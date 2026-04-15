export class BotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly ctx?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BotError';
  }
}

export class FeedError extends BotError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, 'FEED_ERROR', ctx);
    this.name = 'FeedError';
  }
}

export class ExecutionError extends BotError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, 'EXEC_ERROR', ctx);
    this.name = 'ExecutionError';
  }
}

export class ConfigError extends BotError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', ctx);
    this.name = 'ConfigError';
  }
}

export class DiscoveryError extends BotError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, 'DISCOVERY_ERROR', ctx);
    this.name = 'DiscoveryError';
  }
}

export class ReconcileError extends BotError {
  constructor(message: string, ctx?: Record<string, unknown>) {
    super(message, 'RECONCILE_ERROR', ctx);
    this.name = 'ReconcileError';
  }
}
