# SaySpec cloud backend (Firebase)

This folder is the optional cloud backend behind the desktop app's Firebase `CloudBackend` implementation (`apps/desktop/src/cloud/firebase`) and the account portal (`apps/website`). It provides:

- **Accounts:** Firebase Auth with email and password, shared by the desktop app and the portal.
- **Workspaces:** company codes and roles, plus a per-workspace seat limit.
- **Shared tests:** a shared test library, drafts and suites, with review comments.
- **Evidence sharing:** recordings and Flutter runs that the user explicitly chose to share.

Firestore and Storage are read directly under `firestore.rules` and `storage.rules`. Every write goes through a callable Function in `functions/src`.

The desktop app does not need any of this. Without a backend it is a complete local-only app.

## Local emulators

Needs OpenJDK 21 on `PATH`.

```sh
npm run build -w @sayspec/functions
npx firebase emulators:start --only auth,firestore,functions,storage --project demo-sayspec-local
node firebase/scripts/seed-auth.mjs          # in another terminal: seeded test accounts
npm run dev:emulator                         # the desktop app against the emulators
```

The demo project exists only inside the emulators. The seeded accounts and their passwords are in `fixtures/tenants.json`; the sign-in form in an emulator build is prefilled with `tester@sayspec.local`.

## Deploying your own

1. Create a Firebase project on the Blaze plan. Enable Authentication with **Email/Password**, then create Firestore (Native mode) and Cloud Storage.
2. Copy `functions/.env.example` to `functions/.env.<project-id>` and choose the values.
3. Deploy the rules, indexes and Functions. They use the `europe-west1` region (`functions/src/index.ts`).

   ```sh
   SAYSPEC_FIREBASE_PROJECT=<project-id> npm run deploy:backend
   ```

   Every callable checks Firebase Auth in code and needs public invocation. If your Google Cloud organization blocks `allUsers` invokers, run `SAYSPEC_INVOKER_PROJECT=<project-id> node firebase/scripts/allow-public-invoke.mjs --apply` after each deploy.
4. Register a Web app in the Firebase console. Put its configuration in `apps/desktop/.env.<name>` (see `apps/desktop/.env.example`), with `VITE_SAYSPEC_CLOUD=firebase`, then build the desktop app with `SAYSPEC_ENV=<name> npm run build`.
5. Optionally, deploy the account portal with the same Web app configuration in `apps/website/.env.live`, using `SAYSPEC_FIREBASE_PROJECT=<project-id> npm run deploy:website`.

New workspaces start on the plan set by `DEFAULT_ORGANIZATION_PLAN`. An operator can change a workspace's plan with `scripts/set-plan.mjs` (dry run by default).

## Tests

Each suite starts the emulators it needs:

```sh
npm run test:emulator:rules
npm run test:emulator:membership
npm run test:emulator:managed-fix
npm run test:emulator:application-fix
npm run test:emulator:recording-share
npm run test:emulator:flutter-share
npm run test:emulator:portable-pro
```
