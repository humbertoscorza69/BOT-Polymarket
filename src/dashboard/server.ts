import express from 'express';
import * as path from 'path';
import { BotConfig } from '../config';
import { SseHub } from './sse';
import { serializeForDashboard } from './serializers';
import { TelemetryHub } from '../core/telemetry';
import { getLogger } from '../utils/logger';

const log = getLogger('dashboard');

export class DashboardServer {
  private app = express();
  private sse = new SseHub();
  private server: ReturnType<typeof this.app.listen> | null = null;

  constructor(
    private readonly cfg: BotConfig,
    private readonly telemetry: TelemetryHub,
  ) {
    const staticDir = path.join(__dirname, '..', '..', 'public');
    this.app.use('/', express.static(staticDir));
    this.app.get('/api/snapshot', (req, res) => {
      res.json(serializeForDashboard(this.telemetry.getLast()));
    });
    this.app.get('/api/stream', (req, res) => {
      this.sse.addClient(res);
    });
    this.app.get('/api/health', (_req, res) => {
      res.json({ ok: true, clients: this.sse.clientCount() });
    });

    this.telemetry.on('snapshot', (s) => {
      this.sse.broadcast(serializeForDashboard(s));
    });
  }

  start(): void {
    this.server = this.app.listen(this.cfg.dashboardPort, this.cfg.dashboardHost, () => {
      log.info(`dashboard at http://${this.cfg.dashboardHost}:${this.cfg.dashboardPort}`);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
