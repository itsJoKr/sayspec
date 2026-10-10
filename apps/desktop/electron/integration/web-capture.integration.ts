import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { RecordingEvent } from '@sayspec/contracts';
import { WebCaptureAdapter } from '../web-capture-adapter.ts';

test('real Chromium capture records actions and screenshots without sensitive input values', async () => {
  const events: Array<Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds'> & { screenshot?: Uint8Array }> = [];
  const warnings: string[] = [];
  let browserClosed = false;
  const page = `data:text/html,${encodeURIComponent(`<!doctype html><html><body>
    <label>Email <input id="email" aria-label="Email"></label>
    <label>Password <input id="password" name="password" type="password" aria-label="Password"></label>
    <button id="submit">Continue</button>
    <script>
      setTimeout(() => {
        const email = document.querySelector('#email'); email.value = 'tester@example.test'; email.dispatchEvent(new Event('change', { bubbles: true }));
        const password = document.querySelector('#password'); password.value = 'never-persist-this'; password.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#submit').click();
      }, 700);
    </script>
  </body></html>`)}`;
  let adapter: WebCaptureAdapter;
  let readyPage: import('playwright-core').Page | undefined;
  let controlRequested = '';
  adapter = new WebCaptureAdapter({
    headless: true,
    onEvent: async (event) => { events.push(event); },
    onWarning: async (warning) => { warnings.push(warning); },
    onControlRequested: (action) => { controlRequested = action; if (action === 'start') adapter.resume(true); },
    onBrowserClosed: () => { browserClosed = true; },
    onReady: (next) => { readyPage = next; },
  });
  try {
    await adapter.prepare(page);
    assert.equal(events.length, 0, 'opening the browser must not start capture');
    const overlay = readyPage!.locator('[data-sayspec-recorder]');
    await overlay.evaluate((host) => host.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(controlRequested, 'start');
    assert.equal(await overlay.evaluate((host) => host.shadowRoot?.querySelector('button')?.textContent), 'Stop');
    assert.match(await overlay.evaluate((host) => host.shadowRoot?.querySelector('.status')?.textContent ?? ''), /^00:/);
    await new Promise((resolve) => setTimeout(resolve, 1_200)); adapter.pause();
  } finally { await adapter.close(); }

  assert.ok(events.some((event) => event.action === 'click' && event.targetDescription.includes('Continue')), JSON.stringify(events));
  assert.ok(events.some((event) => event.action === 'navigation' && event.context.includes('first screen') && event.screenshot?.byteLength), JSON.stringify(events));
  assert.ok(events.some((event) => event.action === 'input' && event.value === 'tester@example.test'), JSON.stringify(events));
  const password = events.find((event) => event.action === 'input' && event.targetDescription.includes('Password'));
  assert.ok(password, JSON.stringify(events)); assert.equal(password.value, undefined);
  assert.ok(events.every((event) => event.screenshot?.byteLength), JSON.stringify(warnings));
  assert.equal(JSON.stringify(events).includes('never-persist-this'), false);
  assert.equal(browserClosed, false, 'intentional close must not look like an interruption');
});

test('closing the last managed page reports an interrupted browser', async () => {
  let readyPage: import('playwright-core').Page | undefined; let closed = false;
  const adapter = new WebCaptureAdapter({
    headless: true, onEvent: async () => undefined, onWarning: async () => undefined,
    onControlRequested: () => undefined,
    onBrowserClosed: () => { closed = true; }, onReady: (page) => { readyPage = page; },
  });
  await adapter.prepare('data:text/html,<h1>close me</h1>'); adapter.resume();
  await readyPage!.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, true);
  await adapter.close();
});

test('click evidence is photographed after a smooth scroll reaches its target', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><style>html{scroll-behavior:smooth}</style><a href="#how-it-works">See how it works</a><section id="how-it-works" style="margin-top:1300px;height:500px">Target section</section>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address.');
  let page: import('playwright-core').Page | undefined; let capturedScroll = -1; let screenshotBytes = 0;
  const adapter = new WebCaptureAdapter({
    headless: true, onWarning: async () => undefined, onControlRequested: () => undefined, onBrowserClosed: () => undefined,
    onReady: (ready) => { page = ready; },
    onEvent: async (event) => { if (event.action === 'click') { capturedScroll = await page!.evaluate(() => window.scrollY); screenshotBytes = event.screenshot?.byteLength ?? 0; } },
  });
  try {
    await adapter.prepare(`http://127.0.0.1:${address.port}/`);
    adapter.resume(true);
    await page!.getByRole('link', { name: 'See how it works' }).click();
    await adapter.pause();
    assert.ok(capturedScroll > 400, `click screenshot captured before scroll settled: ${capturedScroll}`);
    assert.ok(screenshotBytes > 1_000);
  } finally { await adapter.close(); server.close(); }
});

test('stopping one test keeps the browser open and reset clears site state for the next test', async () => {
  let page: import('playwright-core').Page | undefined; const controls: string[] = [];
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Reset fixture</title><h1>Start screen</h1><button id="action">Action</button>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Reset fixture server did not start.');
  const origin = `http://127.0.0.1:${address.port}/`;
  let adapter: WebCaptureAdapter;
  adapter = new WebCaptureAdapter({
    headless: true, onEvent: async () => undefined, onWarning: async () => undefined,
    onControlRequested: (action) => { controls.push(action); if (action === 'start') adapter.resume(true); else adapter.pause(); },
    onBrowserClosed: () => undefined, onReady: (ready) => { page = ready; },
  });
  try {
    await adapter.prepare(origin); const originalPage = page!;
    await page!.evaluate(() => { document.cookie = 'session=must-clear; path=/'; localStorage.setItem('session', 'must-clear'); sessionStorage.setItem('draft', 'must-clear'); });
    await page!.locator('[data-sayspec-recorder]').evaluate((host) => host.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page!.click('#action'); adapter.pause(); await adapter.reset(origin);
    assert.equal(page, originalPage); assert.equal(page!.isClosed(), false);
    assert.deepEqual(await page!.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('session'), session: sessionStorage.getItem('draft') })), { cookie: '', local: null, session: null });
    const overlay = page!.locator('[data-sayspec-recorder]');
    assert.equal(await overlay.evaluate((host) => host.shadowRoot?.querySelector('button')?.textContent), 'Record');
    assert.equal(await overlay.evaluate((host) => host.shadowRoot?.querySelector('.status')?.textContent), 'Ready');
    await overlay.evaluate((host) => host.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(controls, ['start', 'start']);
  } finally { await adapter.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('navigation survives an HTTP redirect and a page crash is reported honestly', async () => {
  const events: Array<Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds'> & { screenshot?: Uint8Array }> = [];
  const warnings: string[] = []; let page: import('playwright-core').Page | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/destination?token=must-not-persist' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<h1>${request.url === '/destination?token=must-not-persist' ? 'After redirect' : 'Before redirect'}</h1>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Redirect fixture server did not start.');
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = new WebCaptureAdapter({
    headless: true, onEvent: async (event) => { events.push(event); }, onWarning: async (warning) => { warnings.push(warning); },
    onControlRequested: () => undefined,
    onBrowserClosed: () => undefined, onReady: (ready) => { page = ready; },
  });
  try {
    await adapter.prepare(`${origin}/before`); adapter.resume();
    await page!.goto(`${origin}/redirect`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const session = await page!.context().newCDPSession(page!);
    void session.send('Page.crash').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally { await adapter.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  const navigation = events.find((event) => event.action === 'navigation' && event.targetDescription.includes('/destination'));
  assert.ok(navigation, JSON.stringify(events));
  assert.equal(JSON.stringify(navigation).includes('must-not-persist'), false, JSON.stringify(navigation));
  assert.match(navigation.targetDescription, /token=%3Credacted%3E/);
  assert.ok(warnings.some((warning) => /page .* crashed/i.test(warning)), JSON.stringify(warnings));
});

test('real Chromium capture follows frames, dynamic DOM, keyboard actions, new tabs, and flags closed-shadow hosts', async () => {
  const events: Array<Omit<RecordingEvent, 'id' | 'segmentId' | 'elapsedMs' | 'evidenceArtifactIds'> & { screenshot?: Uint8Array }> = [];
  const warnings: string[] = []; let page: import('playwright-core').Page | undefined;
  const html = `<!doctype html><html><body>
    <iframe srcdoc="<button id='frame-action'>Frame action</button>"></iframe>
    <button id="add">Add dynamic</button><button id="popup" onclick="window.open('about:blank','_blank')">Popup</button>
    <closed-widget id="closed"></closed-widget>
    <script>document.querySelector('#add').onclick=()=>{const button=document.createElement('button');button.id='dynamic';button.textContent='Dynamic action';document.body.append(button)};const host=document.querySelector('#closed');const root=host.attachShadow({mode:'closed'});const inner=document.createElement('button');inner.textContent='Closed action';root.append(inner);host.addEventListener('click',()=>inner.click())</script>
  </body></html>`;
  const adapter = new WebCaptureAdapter({
    headless: true, onEvent: async (event) => { events.push(event); }, onWarning: async (warning) => { warnings.push(warning); },
    onControlRequested: () => undefined,
    onBrowserClosed: () => undefined, onReady: (ready) => { page = ready; },
  });
  try {
    await adapter.prepare(`data:text/html,${encodeURIComponent(html)}`); adapter.resume();
    await page!.frameLocator('iframe').locator('#frame-action').click();
    await page!.locator('iframe').evaluate((frame) => frame.remove());
    await page!.click('#add'); await page!.click('#dynamic'); await page!.keyboard.press('Tab');
    const popupPromise = page!.waitForEvent('popup'); await page!.click('#popup'); const popup = await popupPromise; await popup.goto(`data:text/html,${encodeURIComponent('<button id="popup-action">Popup action</button>')}`); await popup.click('#popup-action');
    await page!.click('#closed'); await new Promise((resolve) => setTimeout(resolve, 400)); adapter.pause();
  } finally { await adapter.close(); }
  const summary = events.map(({ action, targetDescription, value, pageId, frameUrl }) => ({ action, targetDescription, value, pageId, frameUrl }));
  assert.ok(events.some((event) => event.frameUrl?.startsWith('about:srcdoc') && event.targetDescription.includes('Frame action')), JSON.stringify(summary));
  assert.ok(events.some((event) => event.targetDescription.includes('Dynamic action')), JSON.stringify(summary));
  assert.ok(events.some((event) => event.action === 'key' && event.value === 'Tab'), JSON.stringify(summary));
  assert.ok(new Set(events.map((event) => event.pageId)).size >= 2, JSON.stringify(summary));
  assert.ok(warnings.some((warning) => /child frame detached/i.test(warning)), JSON.stringify(warnings));
  assert.ok(warnings.some((warning) => /closed shadow root/i.test(warning)), JSON.stringify(warnings));
});
