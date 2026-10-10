import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Loopback endpoint the instrumented Flutter app posts evidence to.
 *
 * The device reaches it through `adb reverse tcp:PORT tcp:PORT`, so the app
 * still connects to `127.0.0.1` on the device and never needs a real network
 * listener. The server binds to loopback only and refuses any request that does
 * not carry the session token minted for this capture.
 */
export interface FlutterCaptureServerOptions {
  /** Called with every accepted batch. Returns after the batch is persisted. */
  onEvents: (input: { sessionId: string; envelope?: Record<string, unknown>; events: Record<string, unknown>[] }) => Promise<void> | void;
  onEnvelope?: (envelope: Record<string, unknown>) => Promise<void> | void;
  onSessionComplete?: (summary: Record<string, unknown>) => Promise<void> | void;
  onRequest?: (kind: 'events' | 'clock' | 'complete') => void;
}

export class FlutterCaptureServer {
  #server: Server | undefined;
  #port = 0;
  #token = '';
  #captureId = '';
  readonly #pendingCommands: Record<string, unknown>[] = [];

  /** Host monotonic reference. Exposed so clock alignment is measured, not guessed. */
  static monotonicMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  readonly #options: FlutterCaptureServerOptions;

  constructor(options: FlutterCaptureServerOptions) {
    this.#options = options;
  }

  get port() { return this.#port; }
  get url() { return `http://127.0.0.1:${this.#port}`; }
  get token() { return this.#token; }

  async start(input: { captureId: string }): Promise<{ port: number; token: string; url: string }> {
    if (this.#server) throw new Error('The Flutter capture server is already running.');
    this.#captureId = input.captureId;
    this.#token = `${input.captureId}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    this.#server = createServer((request, response) => { void this.#handle(request, response); });
    this.#server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    return { port: this.#port, token: this.#token, url: this.url };
  }

  /** Queues a recorder command for the next app batch. */
  enqueue(command: Record<string, unknown>) {
    this.#pendingCommands.push(command);
  }

  async stop() {
    this.#pendingCommands.length = 0;
    const server = this.#server;
    this.#server = undefined;
    this.#port = 0;
    this.#token = '';
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const fail = (status: number, message: string) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    };
    try {
      if (request.method !== 'POST') return fail(405, 'Only POST is accepted.');
      const authorization = request.headers.authorization ?? '';
      if (authorization !== `Bearer ${this.#token}`) return fail(401, 'Unknown recording session token.');
      const body = await readJson(request);
      const url = request.url ?? '/';
      if (url === '/clock') {
        this.#options.onRequest?.('clock');
        const sentMonotonicMs = Number((body as { sentMonotonicMs?: unknown }).sentMonotonicMs ?? 0);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ hostMonotonicMs: FlutterCaptureServer.monotonicMs(), echoSentMonotonicMs: Number.isFinite(sentMonotonicMs) ? sentMonotonicMs : 0 }));
        return;
      }
      if (url === '/events') {
        this.#options.onRequest?.('events');
        const value = body as { sessionId?: unknown; envelope?: Record<string, unknown>; events?: unknown };
        const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
        if (sessionId !== this.#captureId) return fail(409, 'The batch belongs to a different recording session.');
        if (value.envelope && typeof value.envelope === 'object') await this.#options.onEnvelope?.(value.envelope);
        const events = Array.isArray(value.events) ? value.events.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
        if (events.length) await this.#options.onEvents({ sessionId, envelope: value.envelope, events });
        const commands = this.#pendingCommands.splice(0, this.#pendingCommands.length);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: events.length, commands }));
        return;
      }
      if (url === '/session/complete') {
        this.#options.onRequest?.('complete');
        await this.#options.onSessionComplete?.(body as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      return fail(404, 'Unknown recorder endpoint.');
    } catch (error) {
      return fail(400, error instanceof Error ? error.message : 'The recorder request was rejected.');
    }
  }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      // Screenshots travel as base64 in the batch, so the budget is generous
      // but still bounded so a misbehaving app cannot exhaust memory.
      if (size > 24 * 1024 * 1024) { reject(new Error('The recorder batch exceeds the 24 MiB budget.')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('The recorder batch was not valid JSON.')); }
    });
    request.on('error', reject);
  });
}
