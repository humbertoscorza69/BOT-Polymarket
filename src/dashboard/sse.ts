import { Response } from 'express';

export class SseHub {
  private clients: Set<Response> = new Set();

  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(obj: unknown): void {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(data);
      } catch {
        /* ignore */
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
