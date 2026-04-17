import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAlerter } from '../src/utils/discord';

describe('DiscordAlerter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isConfigured returns false when URL is empty', () => {
    const alerter = new DiscordAlerter('');
    expect(alerter.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when URL is set', () => {
    const alerter = new DiscordAlerter('https://discord.com/api/webhooks/123/abc');
    expect(alerter.isConfigured()).toBe(true);
  });

  it('send does nothing when not configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const alerter = new DiscordAlerter('');
    await alerter.send('error', 'Test', 'test message');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('send posts to webhook with correct embed structure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const alerter = new DiscordAlerter('https://discord.com/api/webhooks/123/abc');

    await alerter.send('error', 'Kill Alert', 'Threshold breached', { Metric: 'PnL', Value: '-50' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://discord.com/api/webhooks/123/abc');

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.username).toBe('Polymarket Bot');
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain('Kill Alert');
    expect(body.embeds[0].description).toBe('Threshold breached');
    expect(body.embeds[0].color).toBe(0xe74c3c); // error = red
    expect(body.embeds[0].fields).toHaveLength(2);
    expect(body.embeds[0].fields[0]).toEqual({ name: 'Metric', value: 'PnL', inline: true });
  });

  it('throttles rapid sends', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const alerter = new DiscordAlerter('https://discord.com/api/webhooks/123/abc', { minIntervalMs: 10000 });

    await alerter.send('info', 'First', 'msg1');
    await alerter.send('info', 'Second', 'msg2');

    expect(fetchSpy).toHaveBeenCalledOnce(); // second call throttled
  });

  it('handles fetch errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const alerter = new DiscordAlerter('https://discord.com/api/webhooks/123/abc');

    // Should not throw
    await expect(alerter.send('critical', 'Test', 'msg')).resolves.toBeUndefined();
  });

  it('uses custom bot name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const alerter = new DiscordAlerter('https://discord.com/api/webhooks/123/abc', { botName: 'My Bot' });

    await alerter.send('info', 'Test', 'msg');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.username).toBe('My Bot');
  });
});
