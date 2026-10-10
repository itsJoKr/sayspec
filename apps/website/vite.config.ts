import { defineConfig, loadEnv, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Mirrors the Firebase Hosting rewrites in /firebase.json so dev/preview behave like Hosting.
// Hosting remains the source of truth; tests verify routing against the Hosting emulator.
const pageRoutes: Array<[RegExp, string]> = [
  [/^\/get-app$/, '/get-app.html'],
  [/^\/(sign-in|sign-up|reset-password)$/, '/portal.html'],
  [/^\/portal(\/.*)?$/, '/portal.html'],
];

function hostingRoutes(): Connect.NextHandleFunction {
  return (request, _response, next) => {
    const [path, query] = (request.url ?? '/').split('?');
    const match = pageRoutes.find(([pattern]) => pattern.test(path));
    if (match) request.url = `${match[1]}${query ? `?${query}` : ''}`;
    next();
  };
}

export default defineConfig(({ mode }) => {
  const siteUrl = loadEnv(mode, process.cwd(), 'SITE_').SITE_URL?.trim();
  let origin: string | undefined;
  if (siteUrl) {
    const url = new URL(siteUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('SITE_URL must be a public HTTPS origin without a path, credentials, query, or fragment.');
    }
    origin = url.origin;
  }
  // Development fixtures are compiled in only for the explicit `fixtures` mode.
  // Production builds replace this with `false`, so fixture modules are never bundled.
  const fixturesEnabled = mode === 'fixtures';
  if (fixturesEnabled && origin) throw new Error('Fixture builds cannot be given a public SITE_URL.');

  return {
    plugins: [react(), {
      name: 'sayspec-social-metadata',
      transformIndexHtml(_html, context) {
        if (!origin || context.path.endsWith('/portal.html')) return [];
        const pagePath = context.path.endsWith('/get-app.html') ? '/get-app' : '/';
        const imageUrl = `${origin}/social-preview.png`;
        const imageAlt = 'SaySpec. Still testing by hand? Welcome to the AI era. Turn manual QA walkthroughs into automated tests. Available for Mac.';
        return [
          { property: 'og:url', content: `${origin}${pagePath}` },
          { property: 'og:image', content: imageUrl },
          { property: 'og:image:type', content: 'image/png' },
          { property: 'og:image:width', content: '1200' },
          { property: 'og:image:height', content: '630' },
          { property: 'og:image:alt', content: imageAlt },
          { name: 'twitter:image', content: imageUrl },
          { name: 'twitter:image:alt', content: imageAlt },
        ].map((attrs) => ({ tag: 'meta', attrs, injectTo: 'head' as const }));
      },
    }, {
      name: 'sayspec-hosting-routes',
      configureServer(server) { server.middlewares.use(hostingRoutes()); },
      configurePreviewServer(server) { server.middlewares.use(hostingRoutes()); },
    }],
    define: { __PORTAL_FIXTURES__: JSON.stringify(fixturesEnabled) },
    build: {
      // The Firebase SDK chunk is loaded lazily by portal pages only; the
      // marketing page never requests it.
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          getApp: resolve(import.meta.dirname, 'get-app.html'),
          portal: resolve(import.meta.dirname, 'portal.html'),
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
    },
  };
});
