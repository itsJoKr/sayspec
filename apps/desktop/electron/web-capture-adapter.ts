import { access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import type { RecordingEvent } from '@sayspec/contracts';

type BrowserEvent = Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds' | 'context' | 'pageId' | 'frameUrl' | 'action'> & {
  kind: RecordingEvent['action'];
  targetDescription: string;
  value?: string;
  locatorCandidates?: string[];
  unsupportedWarning?: string;
};

export interface WebCaptureAdapterOptions {
  headless?: boolean;
  executablePath?: string;
  onEvent(input: Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds'> & { screenshot?: Uint8Array; observedAtMonotonicMs?: number }): Promise<void>;
  onWarning(message: string): Promise<void>;
  onControlRequested(action: 'start' | 'stop'): void;
  onBrowserClosed(): void;
  /** Test harness seam; production callers leave this undefined. */
  onReady?(page: Page): void;
}

function redactedUrl(input: string) {
  try {
    const url = new URL(input);
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return `${url.protocol}<redacted>`;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|authorization|api[-_]?key|session)/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    url.hash = '';
    return url.href;
  } catch { return '<unavailable>'; }
}

function httpOrigin(input: string) {
  try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined; }
  catch { return undefined; }
}

export async function installedChromiumExecutable() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* keep looking */ } }
  throw new Error('SaySpec needs Google Chrome, Chromium, or Microsoft Edge to record Web tests. Install one of those browsers, then try again.');
}

export class WebCaptureAdapter {
  readonly #options: WebCaptureAdapterOptions;
  #browser?: Browser;
  #context?: BrowserContext;
  #primaryPage?: Page;
  #capturing = false;
  #resetting = false;
  #intentionalClose = false;
  #closedReported = false;
  #eventQueue = Promise.resolve();
  readonly #pageIds = new WeakMap<Page, string>();
  readonly #visitedOrigins = new Set<string>();
  #pageCount = 0;

  constructor(options: WebCaptureAdapterOptions) { this.#options = options; }

  async prepare(startUrl: string) {
    const startOrigin = httpOrigin(startUrl); if (startOrigin) this.#visitedOrigins.add(startOrigin);
    const executablePath = this.#options.executablePath ?? await installedChromiumExecutable();
    this.#browser = await chromium.launch({
      executablePath, headless: this.#options.headless ?? false,
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });
    this.#browser.once('disconnected', () => this.#reportClosed());
    this.#context = await this.#browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await this.#context.exposeBinding('__sayspecCapture', async (source, payload: BrowserEvent) => {
      if (!this.#capturing || !source.page || !source.frame) return;
      const page = source.page; const frame = source.frame;
      const observedAtMonotonicMs = performance.now();
      this.#eventQueue = this.#eventQueue.then(() => this.#capture(page, frame, payload, observedAtMonotonicMs));
      await this.#eventQueue;
    });
    await this.#context.exposeBinding('__sayspecControl', async (_source, request: { action?: unknown }) => {
      const action = request?.action === 'stop' ? 'stop' : 'start';
      if (!this.#resetting && ((action === 'start' && !this.#capturing) || (action === 'stop' && this.#capturing))) this.#options.onControlRequested(action);
      return this.#overlayState();
    });
    await this.#context.exposeBinding('__sayspecSync', async () => this.#overlayState());
    await this.#context.addInitScript(captureBootstrap);
    this.#context.on('page', (page) => this.#registerPage(page));
    this.#primaryPage = await this.#context.newPage();
    this.#registerPage(this.#primaryPage);
    await this.#primaryPage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.#primaryPage.bringToFront();
    this.#options.onReady?.(this.#primaryPage);
  }

  resume(captureCurrentPage = false) {
    this.#capturing = true;
    this.#broadcastOverlayState();
    if (captureCurrentPage && this.#primaryPage && !this.#primaryPage.isClosed()) {
      const page = this.#primaryPage;
      this.#eventQueue = this.#eventQueue.then(async () => {
        const observedAtMonotonicMs = performance.now();
        let screenshot: Uint8Array | undefined;
        try { screenshot = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 5_000 }); }
        catch { await this.#options.onWarning('The first-screen screenshot was unavailable; its URL was preserved.'); }
        const url = redactedUrl(page.url());
        await this.#options.onEvent({ action: 'navigation', targetDescription: url, context: `${this.#pageId(page)} · first screen`, pageId: this.#pageId(page), frameUrl: url, screenshot, observedAtMonotonicMs });
      });
    }
  }
  async pause() { this.#capturing = false; this.#broadcastOverlayState(); await this.#eventQueue; }

  async reset(startUrl: string) {
    this.#capturing = false; this.#resetting = true; this.#broadcastOverlayState(); await this.#eventQueue;
    try {
      const context = this.#context; const page = this.#primaryPage;
      if (!context || !page || page.isClosed()) throw new Error('The recording browser is no longer available.');
      for (const openPage of context.pages()) {
        for (const frame of openPage.frames()) await frame.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => undefined);
      }
      for (const extra of context.pages()) { if (extra !== page) await extra.close().catch(() => undefined); }
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await context.clearCookies(); await context.clearPermissions();
      const session = await context.newCDPSession(page);
      try {
        await session.send('DOMStorage.enable');
        for (const origin of this.#visitedOrigins) {
          await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
          await session.send('DOMStorage.clear', { storageId: { securityOrigin: origin, isLocalStorage: true } }).catch(() => undefined);
          await session.send('DOMStorage.clear', { storageId: { securityOrigin: origin, isLocalStorage: false } }).catch(() => undefined);
        }
        await session.send('Network.clearBrowserCache');
      } finally { await session.detach(); }
      this.#visitedOrigins.clear(); const startOrigin = httpOrigin(startUrl); if (startOrigin) this.#visitedOrigins.add(startOrigin);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.bringToFront();
    } finally { this.#resetting = false; this.#broadcastOverlayState(); }
  }

  async close() {
    this.#capturing = false; this.#intentionalClose = true;
    await this.#eventQueue;
    await this.#browser?.close().catch(() => undefined);
    this.#browser = undefined; this.#context = undefined; this.#primaryPage = undefined;
  }

  async #capture(page: Page, frame: Frame, payload: BrowserEvent, observedAtMonotonicMs: number) {
    const { kind, unsupportedWarning, ...event } = payload;
    if (unsupportedWarning) await this.#options.onWarning(unsupportedWarning);
    // A capture-phase click callback precedes the page's own click handler.
    // Let that handler and a smooth scroll settle before photographing the outcome.
    if (kind === 'click') await page.evaluate(() => new Promise<void>((resolve) => {
      let quiet: ReturnType<typeof setTimeout>;
      const finish = () => { window.removeEventListener('scroll', changed, true); clearTimeout(quiet); clearTimeout(limit); resolve(); };
      const changed = () => { clearTimeout(quiet); quiet = setTimeout(finish, 160); };
      const limit = setTimeout(finish, 1_500);
      window.addEventListener('scroll', changed, true);
      quiet = setTimeout(finish, 350);
    })).catch(() => undefined);
    let screenshot: Uint8Array | undefined;
    try { screenshot = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 5_000 }); }
    catch { await this.#options.onWarning(`A screenshot could not be captured for ${payload.targetDescription}; the action was preserved.`); }
    await this.#options.onEvent({
      ...event, action: kind, context: `${this.#pageId(page)} · ${redactedUrl(frame.url())}`,
      pageId: this.#pageId(page), frameUrl: redactedUrl(frame.url()), screenshot, observedAtMonotonicMs,
    });
  }

  #registerPage(page: Page) {
    this.#pageId(page);
    page.on('framenavigated', (frame) => {
      const origin = httpOrigin(frame.url()); if (origin) this.#visitedOrigins.add(origin);
      if (!this.#capturing || frame !== page.mainFrame()) return;
      const observedAtMonotonicMs = performance.now();
      this.#eventQueue = this.#eventQueue.then(async () => {
        let screenshot: Uint8Array | undefined;
        try { await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }); screenshot = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 5_000 }); }
        catch { await this.#options.onWarning('A navigation screenshot was unavailable; the destination URL was preserved.'); }
        await this.#options.onEvent({ action: 'navigation', targetDescription: redactedUrl(frame.url()), context: `${this.#pageId(page)} · main frame`, pageId: this.#pageId(page), frameUrl: redactedUrl(frame.url()), screenshot, observedAtMonotonicMs });
      });
    });
    page.on('crash', () => { void this.#options.onWarning(`The captured page ${this.#pageId(page)} crashed. Evidence before the crash is still available.`); });
    page.on('framedetached', (frame) => {
      if (!this.#capturing || frame === page.mainFrame()) return;
      void this.#options.onWarning(`A child frame detached from ${this.#pageId(page)}. Evidence captured before it disappeared is still available.`);
    });
    page.on('close', () => {
      if (this.#context?.pages().length === 0) this.#reportClosed();
    });
  }

  #pageId(page: Page) {
    const existing = this.#pageIds.get(page); if (existing) return existing;
    const next = `page_${++this.#pageCount}`; this.#pageIds.set(page, next); return next;
  }

  #overlayState() { return { recording: this.#capturing, resetting: this.#resetting }; }

  #broadcastOverlayState() {
    const state = this.#overlayState();
    for (const page of this.#context?.pages() ?? []) {
      void page.evaluate((next) => window.dispatchEvent(new CustomEvent('__sayspecRecorderState', { detail: next })), state).catch(() => undefined);
    }
  }

  #reportClosed() {
    if (this.#intentionalClose || this.#closedReported) return;
    this.#closedReported = true; this.#options.onBrowserClosed();
    this.#intentionalClose = true; void this.#browser?.close().catch(() => undefined);
  }
}

function captureBootstrap() {
  const recorderWindow = globalThis as typeof globalThis & {
    __sayspecCapture?: (payload: BrowserEvent) => Promise<void>;
    __sayspecControl?: (request: { action: 'start' | 'stop' }) => Promise<{ recording: boolean; resetting?: boolean }>;
    __sayspecSync?: () => Promise<{ recording: boolean; resetting?: boolean }>;
  };
  const capture = recorderWindow.__sayspecCapture;
  if (!capture) return;
  let overlayHost: HTMLDivElement | null = null;
  const sensitive = (element: Element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const metadata = [element.type, element.name, element.id, element.autocomplete, element.getAttribute('aria-label') ?? ''].join(' ');
    return element instanceof HTMLInputElement && element.type === 'password' || /(?:password|passcode|secret|token|authorization|api[-_ ]?key|credit.?card|cc-number|cvc|cvv)/i.test(metadata);
  };
  const targetFrom = (event: Event) => {
    const path = event.composedPath();
    return path.find((item): item is Element => item instanceof Element) ?? (event.target instanceof Element ? event.target : null);
  };
  const describe = (element: Element) => {
    const label = element.getAttribute('aria-label') || element.getAttribute('title');
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return [element.tagName.toLowerCase(), label || text || element.getAttribute('name') || element.id].filter(Boolean).join(' · ').slice(0, 180);
  };
  const candidates = (element: Element) => {
    const values: string[] = [];
    if (element.id && /^[a-zA-Z][\w-]{0,100}$/.test(element.id)) values.push(`#${CSS.escape(element.id)}`);
    const aria = element.getAttribute('aria-label'); if (aria && aria.length <= 120) values.push(`[aria-label=${JSON.stringify(aria)}]`);
    const testId = element.getAttribute('data-testid'); if (testId && testId.length <= 120) values.push(`[data-testid=${JSON.stringify(testId)}]`);
    const name = element.getAttribute('name'); if (name && name.length <= 120) values.push(`${element.tagName.toLowerCase()}[name=${JSON.stringify(name)}]`);
    return values.slice(0, 4);
  };
  const send = (event: Event, kind: BrowserEvent['kind'], value?: string) => {
    if (overlayHost && event.composedPath().includes(overlayHost)) return;
    const element = targetFrom(event); if (!element) return;
    const customElementWithoutOpenRoot = element.tagName.includes('-') && !element.shadowRoot;
    void capture({ kind, targetDescription: describe(element), locatorCandidates: candidates(element), ...(value === undefined ? {} : { value }), ...(customElementWithoutOpenRoot ? { unsupportedWarning: `Action on ${element.tagName.toLowerCase()} may be inside a closed shadow root; the host was captured but inner target details are unavailable.` } : {}) });
  };
  document.addEventListener('click', (event) => send(event, 'click'), true);
  document.addEventListener('change', (event) => {
    const element = targetFrom(event); if (!element) return;
    const value = sensitive(element) ? undefined : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value.slice(0, 500) : undefined;
    send(event, 'input', value);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    send(event, 'key', event.key);
  }, true);

  if (window.top !== window) return;

  let recording = false;
  let resetting = false;
  let busy = false;
  let startedAt = 0;
  let timer = 0;

  const elapsed = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const render = () => {
    const root = overlayHost?.shadowRoot; if (!root) return;
    const shell = root.querySelector<HTMLElement>('.sayspec-recorder');
    const button = root.querySelector<HTMLButtonElement>('button');
    const status = root.querySelector<HTMLElement>('.status');
    if (!shell || !button || !status) return;
    shell.dataset.recording = recording ? 'true' : 'false';
    shell.dataset.busy = busy ? 'true' : 'false';
    button.disabled = busy || resetting;
    button.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
    button.textContent = recording ? 'Stop' : 'Record';
    status.textContent = resetting ? 'Resetting…' : busy ? 'Starting…' : recording ? elapsed() : 'Ready';
  };

  const setState = (next: { recording?: boolean; resetting?: boolean }) => {
    const wasRecording = recording;
    recording = Boolean(next.recording);
    resetting = Boolean(next.resetting);
    if (recording && !wasRecording) startedAt = Date.now();
    if (!recording) startedAt = 0;
    busy = false; render();
  };

  const toggle = async () => {
    if (busy || !recorderWindow.__sayspecControl) return;
    busy = true; render();
    try { setState(await recorderWindow.__sayspecControl({ action: recording ? 'stop' : 'start' })); }
    catch { busy = false; render(); }
  };

  const mountOverlay = () => {
    if (!document.body || overlayHost?.isConnected) return;
    overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-sayspec-recorder', '');
    overlayHost.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    const root = overlayHost.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      .sayspec-recorder { box-sizing:border-box; width:94px; display:flex; flex-direction:column; align-items:center; gap:6px; padding:8px; border:1px solid #d4d4ca; border-radius:12px; background:#f5f2eb; color:#202522; box-shadow:0 8px 22px rgba(32,37,34,.20); font:500 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; user-select:none; cursor:grab; }
      .sayspec-recorder[data-dragging="true"] { cursor:grabbing; }
      .brand { display:flex; align-items:center; justify-content:center; gap:5px; font-weight:750; letter-spacing:-.2px; }
      .mark { position:relative; width:18px; height:18px; display:grid; place-items:center; color:#202522; font:800 12px/1 ui-monospace,SFMono-Regular,monospace; }
      .mark::before { content:'['; position:absolute; left:0; } .mark::after { content:']'; position:absolute; right:0; }
      .mark i { width:5px; height:5px; border-radius:50%; background:#c44b2d; }
      button { all:unset; box-sizing:border-box; width:64px; height:27px; border-radius:7px; background:#202522; color:#f5f2eb; text-align:center; font-size:11px; font-weight:750; cursor:pointer; }
      button:focus-visible { outline:2px solid #c44b2d; outline-offset:2px; }
      button:disabled { opacity:.6; cursor:wait; }
      .sayspec-recorder[data-recording="true"] button { background:#c44b2d; }
      .sayspec-recorder[data-recording="true"] .mark i { animation:pulse 1.2s ease-in-out infinite; }
      .status { color:#626860; font-size:9px; line-height:1; white-space:nowrap; }
      @keyframes pulse { 50% { opacity:.3; transform:scale(.72); } }
    </style><div class="sayspec-recorder" data-recording="false"><div class="brand"><span class="mark"><i></i></span><span>SaySpec</span></div><button type="button">Record</button><span class="status">Ready</span></div>`;
    const shell = root.querySelector<HTMLElement>('.sayspec-recorder')!;
    root.querySelector('button')!.addEventListener('click', () => void toggle());
    let drag: { x: number; y: number } | null = null;
    shell.addEventListener('pointerdown', (event) => {
      if ((event.target as Element).closest('button')) return;
      const rect = overlayHost!.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      overlayHost!.style.right = 'auto'; overlayHost!.style.bottom = 'auto';
      overlayHost!.style.left = `${rect.left}px`; overlayHost!.style.top = `${rect.top}px`;
      shell.dataset.dragging = 'true'; shell.setPointerCapture(event.pointerId);
    });
    shell.addEventListener('pointermove', (event) => {
      if (!drag || !overlayHost) return;
      const rect = overlayHost.getBoundingClientRect();
      overlayHost.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, event.clientX - drag.x))}px`;
      overlayHost.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, event.clientY - drag.y))}px`;
    });
    const endDrag = () => { drag = null; delete shell.dataset.dragging; };
    shell.addEventListener('pointerup', endDrag); shell.addEventListener('pointercancel', endDrag);
    document.body.appendChild(overlayHost); render();
  };

  window.addEventListener('__sayspecRecorderState', (event) => setState((event as CustomEvent<{ recording: boolean; resetting?: boolean }>).detail));
  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyR') { event.preventDefault(); event.stopPropagation(); void toggle(); }
  }, true);

  const boot = async () => {
    mountOverlay();
    try { if (recorderWindow.__sayspecSync) setState(await recorderWindow.__sayspecSync()); } catch { /* browser is closing */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
  else void boot();
  timer = window.setInterval(() => { mountOverlay(); if (recording) render(); }, 500);
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
}
