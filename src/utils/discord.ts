import { getLogger } from './logger';

const log = getLogger('discord');

export type AlertSeverity = 'info' | 'warn' | 'error' | 'critical';

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
  info: 0x3498db,     // blue
  warn: 0xf39c12,     // orange
  error: 0xe74c3c,    // red
  critical: 0x8b0000, // dark red
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: '\u2139\ufe0f',
  warn: '\u26a0\ufe0f',
  error: '\ud83d\udea8',
  critical: '\ud83d\udd34',
};

export class DiscordAlerter {
  private webhookUrl: string;
  private lastSendTs = 0;
  private minIntervalMs: number;
  private botName: string;

  constructor(webhookUrl: string, opts?: { minIntervalMs?: number; botName?: string }) {
    this.webhookUrl = webhookUrl;
    this.minIntervalMs = opts?.minIntervalMs ?? 5000;
    this.botName = opts?.botName ?? 'Polymarket Bot';
  }

  isConfigured(): boolean {
    return this.webhookUrl.length > 0;
  }

  async send(severity: AlertSeverity, title: string, message: string, fields?: Record<string, string | number>): Promise<void> {
    if (!this.isConfigured()) return;

    const now = Date.now();
    if (now - this.lastSendTs < this.minIntervalMs) {
      log.debug('discord alert throttled', { title });
      return;
    }
    this.lastSendTs = now;

    const embed: DiscordEmbed = {
      title: `${SEVERITY_EMOJI[severity]} ${title}`,
      description: message,
      color: SEVERITY_COLORS[severity],
      timestamp: new Date().toISOString(),
    };

    if (fields && Object.keys(fields).length > 0) {
      embed.fields = Object.entries(fields).map(([name, value]) => ({
        name,
        value: String(value),
        inline: true,
      }));
    }

    const body = JSON.stringify({
      username: this.botName,
      embeds: [embed],
    });

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        log.warn('discord webhook failed', { status: res.status, statusText: res.statusText });
      }
    } catch (e) {
      log.warn('discord webhook error', { err: String(e) });
    }
  }
}
