# Contributing to SaySpec

Thanks for helping. Bug reports, fixes and focused improvements are welcome. For larger changes, open an issue first so we can agree on the approach.

## Setup

Use Node.js 24 (`.nvmrc`) on macOS, then:

```sh
npm ci
npm run dev            # local-only app, no backend (uses apps/desktop/.env.live instead if you have one)
npm run dev:local      # always local-only
npm run dev:emulator   # with the Firebase backend on local emulators (see firebase/README.md)
```

Renderer changes reload automatically. Restart `npm run dev` after editing the Electron main process or preload code.

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run build && npm run test:native -w @sayspec/desktop
```

If you change Firestore or Storage rules, or the Functions, also run the matching `npm run test:emulator:*` suites (they need OpenJDK 21). If you change recording, runs or fixes, run the matching `test:native:*` script. Mention in the pull request what you ran and what you could not run (for example, a device lane without an emulator).

## Ground rules

- **The app works without a backend.** Anything that talks to a server goes through the `CloudBackend` interface (`apps/desktop/src/cloud/backend.ts`). Only `apps/desktop/src/cloud/firebase/` may import Firebase. Features must keep working, or say clearly why they are unavailable, in a local-only build.
- **Privileged work stays in the main process.** The renderer reaches files, processes and credentials only through the preload bridge (`apps/desktop/electron/preload.ts`), and the main process validates every request.
- **Generated changes need approval.** A fix proposed by a coding agent is never applied to tests or application source without the user's explicit approval.
- **No secrets or personal data in the repository.** Backend configuration lives in git-ignored `.env.*` files (see each `.env.example`). Use generic sample apps and `example.com` addresses in tests and fixtures.
- **Match the surrounding code.** Keep changes focused, follow the existing style and naming, and add or update tests with behavior changes.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE). Contributions to `packages/sayspec_flutter_recorder` are licensed under its BSD-3-Clause license.
