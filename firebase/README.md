# SaySpec cloud backend (Firebase)

This folder is the optional cloud backend behind the desktop app's Firebase `CloudBackend` implementation (`apps/desktop/src/cloud/firebase`) and the account portal (`apps/website`). It provides:

- **Accounts:** Firebase Auth with email and password, shared by the desktop app and the portal.
- **Workspaces:** company codes and roles, plus a per-workspace seat limit.
- **Shared tests:** a shared test library, drafts and suites, with review comments. Flutter tests are stored as immutable Patrol versions that each Mac pulls and runs locally.
- **Evidence sharing:** recordings and Flutter runs that the user explicitly chose to share.
- **Gemini transcription:** narration transcribed by Gemini on Vertex AI for Beta and Pro workspaces, within a monthly allowance (`functions/src/transcription.ts`).

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

   Every callable checks Firebase Auth in code and needs public invocation. If your Google Cloud organization blocks `allUsers` invokers, run `SAYSPEC_INVOKER_PROJECT=<project-id> node firebase/scripts/allow-public-invoke.mjs --apply` after each deploy (it needs Application Default Credentials). Without the Google Cloud CLI, open each new function's service in the Cloud Run console and set **Security → Authentication** to **Allow public access**.
4. Register a Web app in the Firebase console. Put its configuration in `apps/desktop/.env.<name>` (see `apps/desktop/.env.example`), with `VITE_SAYSPEC_CLOUD=firebase`, then build the desktop app with `SAYSPEC_ENV=<name> npm run build`.
5. Optionally, deploy the account portal with the same Web app configuration in `apps/website/.env.live`, using `SAYSPEC_FIREBASE_PROJECT=<project-id> npm run deploy:website`.

New workspaces start on the plan set by `DEFAULT_ORGANIZATION_PLAN`. An operator can change a workspace's plan with `scripts/set-plan.mjs` (dry run by default).

### Gemini transcription

`narrationTranscribe` calls Gemini on Vertex AI as the Functions runtime service account, so there is no API key to store or leak. Before members use it:

1. Enable the Vertex AI API in the project.
2. Grant the Functions runtime service account (by default `<project-number>-compute@developer.gserviceaccount.com`) the **Vertex AI User** role (`roles/aiplatform.user`).
3. Choose `GEMINI_TRANSCRIPTION_MODEL`, `GEMINI_TRANSCRIPTION_LOCATION`, `TRANSCRIPTION_MONTHLY_MINUTES` and `TRANSCRIPTION_MAX_INSTANCES` in `functions/.env.<project-id>` (see `functions/.env.example`).
4. Under **Billing → Budgets & caps**, create a budget with **spend cap enforcement** for the project and the Vertex AI service. It pauses Vertex AI, and only Vertex AI, when the cap is reached. Enforcement lags by a few hours, so set the cap a little under your real limit.

Each request is limited to 25 minutes of Ogg/Opus audio and is accepted only from an editor, admin or owner of a Beta or Pro workspace. Minutes are reserved against the workspace's allowance before Gemini is called and refunded if the call fails. Audio is passed to Gemini inline and not stored.

The Firebase Web API key ships inside the desktop app and the portal. In the Google Cloud console, make sure its API restrictions list neither Vertex AI (Agent Platform), the Gemini API, nor **Firebase AI Logic API**. The last is in Firebase's default list, and once Vertex AI is enabled it lets anyone holding the key call Gemini on your bill. SaySpec does not use it.

## Tests

Each suite starts the emulators it needs:

```sh
npm run test:emulator:rules
npm run test:emulator:membership
npm run test:emulator:managed-fix
npm run test:emulator:application-fix
npm run test:emulator:recording-share
npm run test:emulator:flutter-share
npm run test:emulator:cloud-patrol-storage
npm run test:emulator:portable-pro
npm run test:emulator:transcription
```

The emulator never calls Gemini: in a `demo-` project, `narrationTranscribe` uses a fixed stand-in transcript.
