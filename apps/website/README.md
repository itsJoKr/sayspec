# SaySpec website

Static sales page for SaySpec plus the account portal (`/get-app`, sign-in, `/portal/**`). The marketing page (`index.html`, `src/main.ts`) stays a dependency-free static page; the portal is a separate React entry (`get-app.html`, `portal.html`, `src/app/**`) that loads the Firebase Web SDK lazily. Nothing here imports the Electron renderer or the reference project.

## Local development

From the repository root:

```sh
npm run website:dev
```

The site uses `http://127.0.0.1:5174`. The port is strict, so startup stops instead of silently choosing another port.

For the portal against local Firebase emulators, create `apps/website/.env.local`:

```sh
VITE_FIREBASE_API_KEY=demo-api-key
VITE_FIREBASE_AUTH_DOMAIN=demo-sayspec-local.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=demo-sayspec-local
VITE_FIREBASE_APP_ID=1:1234567890:web:demo
VITE_FIREBASE_USE_EMULATORS=true
```

then, from the repository root, build the functions, start the emulators and seed them (needs OpenJDK 21 on `PATH`):

```sh
npm run build -w @sayspec/functions
npx firebase emulators:start --only auth,firestore,functions --project demo-sayspec-local
node firebase/scripts/seed-auth.mjs && node firebase/scripts/seed-workspaces.mjs   # second terminal, with FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

Seeded users (for example `tester@sayspec.local`) use the password in `firebase/fixtures/tenants.json`.

Development fixtures (no Firebase at all, visibly labeled "Demo data"): `npm run dev:fixtures -w @sayspec/website`. Every demo account uses the password `demo-password`. Fixtures exist only in `--mode fixtures`; production builds compile them out.

Without Firebase configuration the portal shows an honest "Account portal unavailable" state; the marketing page is unaffected. See `.env.example` for all variables. A production build offers the Mac download from `VITE_DESKTOP_DOWNLOAD_URL`; builds without it show "Download coming soon". See `src/app/download.ts`.

## Tests

```sh
npm run test -w @sayspec/website        # unit: pricing, return paths, config, permissions, validation
npm run test:e2e -w @sayspec/website    # browser: fixtures suite, then real emulator suite, via the Hosting emulator
```

The browser suites need OpenJDK 21 (`/opt/homebrew/opt/openjdk@21` or `JAVA_HOME`) and the local Google Chrome. They build `dist/` for the test and restore an unconfigured production build afterwards.

## Production build

```sh
npm run website:build                                   # unconfigured: marketing page plus "portal unavailable"
npm run website:build:live                              # reads apps/website/.env.live (git-ignored; see .env.example)
SAYSPEC_FIREBASE_PROJECT=<project-id> npm run deploy:website
```

The static output is written to `apps/website/dist`; `deploy:website` publishes only this directory to Firebase Hosting in the given project. Use the same Firebase project as the desktop's cloud build so both share one account pool.

## Social previews

Open Graph and Twitter titles/descriptions are included in the static HTML. The
1200 × 630 PNG at `public/social-preview.png` matches the homepage headline and
colors. Set `SITE_URL` in `apps/website/.env` to the final public HTTPS origin
(with no path, query, or fragment), then rebuild. Vite inserts `og:url` and
absolute image URLs into the HTML at build time, so preview crawlers do not need
JavaScript. Without `SITE_URL`, domain-dependent tags are omitted; text metadata
and the image asset are still included. No domain is assumed during local review.

After deployment, verify that `/social-preview.png` is publicly accessible and
check a shared link preview. Domain/canonical setup, sitemap, and live indexing
verification remain launch tasks.
