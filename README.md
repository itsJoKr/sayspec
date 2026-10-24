<p align="center">
  <img src="apps/desktop/build/icon.svg" alt="SaySpec logo" width="128" height="128">
</p>

<h1 align="center">SaySpec</h1>

SaySpec turns a narrated manual QA walkthrough into an automated test. You click through your app while saying what should happen. SaySpec records the actions and screenshots and transcribes your narration on your Mac. Your own coding agent (Claude Code or Codex) then writes and runs a Playwright or Patrol test from it in an embedded terminal. Saved tests run again on demand. When one fails, SaySpec explains the failure and proposes a fix, which is applied only after you approve it.

- **Web:** recording in Chromium, Playwright tests.
- **Flutter:** recording through the [`sayspec_flutter_recorder`](packages/sayspec_flutter_recorder) package, Patrol tests on an Android emulator or iOS simulator.
- **Local-first:** recordings, transcripts, tests and runs stay on your machine. Tests can live in SaySpec's local storage or in a folder you choose, such as a git repository.
- **Git:** when the source folder or the test folder is a Git repository, an applied fix or a changed test can be committed to a new `sayspec/…` branch, pushed and opened as a pull request, using your own Git login. SaySpec commits only the files it changed and adds commits only to branches it created.

SaySpec is a desktop app for macOS, built with Electron, React, TypeScript and Vite. To use it without building from source, get the signed and notarized app at [sayspec.app](https://sayspec.app).

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
| `packages/contracts` | Shared types and validation between the main process and the renderer. |
| `packages/sayspec_flutter_recorder` | The Flutter recorder SDK, published on pub.dev (BSD-3-Clause). |
| `fixtures` | Sample Web and Flutter apps used for manual testing and native tests. |

This repository is the SaySpec desktop app. SaySpec Cloud (the hosted backend for accounts, workspaces and shared tests) and the [sayspec.app](https://sayspec.app) website are separate and not open source.

## Optional cloud

Everything above works without a server. The official SaySpec builds can also connect to SaySpec Cloud for accounts and workspaces, a shared test library, shared evidence and review comments. The app reaches any backend only through the `CloudBackend` interface in [`apps/desktop/src/cloud/backend.ts`](apps/desktop/src/cloud/backend.ts). It is chosen at build time:

- **No configuration (the default):** a local-only build. No backend code is bundled and the app opens straight into the local workspace.
- **`VITE_SAYSPEC_CLOUD=firebase`:** the SaySpec Cloud client in [`apps/desktop/src/cloud/firebase`](apps/desktop/src/cloud/firebase), configured from a git-ignored `apps/desktop/.env.<name>` file and built with `SAYSPEC_ENV=<name> npm run build`. See [`apps/desktop/.env.example`](apps/desktop/.env.example).
- **Your own backend:** implement `CloudBackend` in a new folder under `src/cloud/` and add it to [`src/cloud/load.ts`](apps/desktop/src/cloud/load.ts). The main process authorizes fix decisions through [`electron/cloud-fix-authority.ts`](apps/desktop/electron/cloud-fix-authority.ts).

To remove the SaySpec Cloud client entirely, delete `apps/desktop/src/cloud/firebase` and its branch in `load.ts`.

## Transcription

Narration is transcribed by a `TranscriptionProvider` ([`apps/desktop/electron/transcription/provider.ts`](apps/desktop/electron/transcription/provider.ts)). The built-in `whisper-local` provider runs whisper.cpp on your Mac, so audio never leaves it. It is the default, and the only provider in a local-only build.

With SaySpec Cloud, Beta and Pro workspaces can also choose `gemini-cloud` under **Narration**. It uploads each narration to SaySpec Cloud, which checks the workspace's plan and monthly allowance and transcribes the audio with Gemini on Vertex AI. Other engines implement the same interface and register in `TRANSCRIPTION_PROVIDERS`.

## Tests

```sh
npm run typecheck
npm test                      # contracts and desktop unit tests
npm run build && npm run test:native -w @sayspec/desktop   # built app, local-only guest walkthrough
```

The `test:native:*` scripts in `package.json` cover recording, runs and fixes. Device lanes need an Android emulator or iOS simulator. Lanes against SaySpec Cloud run in the SaySpec Cloud repository with this app built for its emulators.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

SaySpec is licensed under the [Apache License 2.0](LICENSE). The Flutter recorder package is licensed under [BSD-3-Clause](packages/sayspec_flutter_recorder/LICENSE). The license does not grant rights to the SaySpec name or logo (Apache-2.0, section 6).
