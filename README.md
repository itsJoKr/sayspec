<p align="center">
  <img src="apps/desktop/build/icon.svg" alt="SaySpec logo" width="128" height="128">
</p>

<h1 align="center">SaySpec</h1>

SaySpec turns a narrated manual QA walkthrough into an automated test. You click through your app while saying what should happen. SaySpec records the actions and screenshots and transcribes your narration on your Mac. Your own coding agent (Claude Code or Codex) then writes and runs a Playwright or Patrol test from it in an embedded terminal. Saved tests run again on demand. When one fails, SaySpec explains the failure and proposes a fix, which is applied only after you approve it.

- **Web:** recording in Chromium, Playwright tests.
- **Flutter:** recording through the [`sayspec_flutter_recorder`](packages/sayspec_flutter_recorder) package, Patrol tests on an Android emulator or iOS simulator.
- **Local-first:** recordings, transcripts, tests and runs stay on your machine. Tests can live in SaySpec's local storage or in a folder you choose, such as a git repository.

SaySpec is a desktop app for macOS, built with Electron, React, TypeScript and Vite.

## Getting started

You need Node.js 24 (see `.nvmrc`) and, for generating tests, the [Claude Code](https://code.claude.com) or [Codex](https://github.com/openai/codex) CLI signed in on your machine.

```sh
npm ci
npm run dev
```

This opens the app with no account and no cloud. **Settings → Machine setup** checks and installs what each kind of project needs (Playwright browsers, the Whisper transcription model, Flutter, Patrol, Android and iOS tooling).

Two small sample apps are included for trying the full flow:

- [Web storefront](fixtures/web_sample_app/README.md): run `cd fixtures/web_sample_app && npm run dev`, then use `http://127.0.0.1:4173/?bug=cart-total` in a Web project to reproduce a cart total that is $5 too low.
- [Flutter storefront](fixtures/flutter_sample_app/README.md): the cart total is always $5.00 short.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/desktop` | The Electron app. `electron/` holds the main process (files, processes, recording, transcription, test runs) and the preload bridge; `src/` holds the React renderer. |
| `packages/contracts` | Shared types and validation between the main process, renderer and backend. |
| `packages/sayspec_flutter_recorder` | The Flutter recorder SDK, published on pub.dev (BSD-3-Clause). |
| `firebase` | The optional cloud backend: Firestore and Storage rules, Cloud Functions, emulator fixtures and operator scripts. |
| `apps/website` | The marketing page and the account portal for the optional cloud. |
| `fixtures` | Sample Web and Flutter apps used for manual testing and native tests. |

## Optional cloud

Everything above works without a server. Teams can add a cloud backend for accounts and workspaces, a shared test library, shared evidence and review comments. The app reaches the backend only through the `CloudBackend` interface in [`apps/desktop/src/cloud/backend.ts`](apps/desktop/src/cloud/backend.ts). It is chosen at build time:

- **No configuration (the default):** a local-only build. No backend code is bundled and the app opens straight into the local workspace.
- **`VITE_SAYSPEC_CLOUD=firebase`:** the Firebase implementation in [`apps/desktop/src/cloud/firebase`](apps/desktop/src/cloud/firebase), configured from a git-ignored `apps/desktop/.env.<name>` file and built with `SAYSPEC_ENV=<name> npm run build`. See [`apps/desktop/.env.example`](apps/desktop/.env.example) and, to run your own backend, [`firebase/README.md`](firebase/README.md).
- **Your own backend:** implement `CloudBackend` in a new folder under `src/cloud/` and add it to [`src/cloud/load.ts`](apps/desktop/src/cloud/load.ts). The main process authorizes fix decisions through [`electron/cloud-fix-authority.ts`](apps/desktop/electron/cloud-fix-authority.ts).

To remove Firebase entirely, delete `apps/desktop/src/cloud/firebase`, its branch in `load.ts`, the `firebase` folder and `apps/website`.

The emulator configuration in `apps/desktop/.env.emulator` runs the Firebase backend locally: `npm run dev:emulator`, with the emulators started as described in `firebase/README.md`.

## Transcription

Narration is transcribed by a `TranscriptionProvider` ([`apps/desktop/electron/transcription/provider.ts`](apps/desktop/electron/transcription/provider.ts)). The built-in `whisper-local` provider runs whisper.cpp on your Mac, so audio never leaves it. Other engines implement the same interface and register in `TRANSCRIPTION_PROVIDERS`.

## Tests

```sh
npm run typecheck
npm test                      # contracts and desktop unit tests
npm run build && npm run test:native -w @sayspec/desktop   # built app, local-only guest walkthrough
npm run test:emulator:rules   # Firestore/Storage rules and Functions on the emulators (needs OpenJDK 21)
```

The `test:native:*` and `test:emulator:*` scripts in `package.json` cover recording, runs, fixes, sharing and team flows. Suites that need the cloud build the app with the emulator configuration themselves. Device lanes need an Android emulator or iOS simulator.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

SaySpec is licensed under the [Apache License 2.0](LICENSE). The Flutter recorder package is licensed under [BSD-3-Clause](packages/sayspec_flutter_recorder/LICENSE). The license does not grant rights to the SaySpec name or logo (Apache-2.0, section 6).
