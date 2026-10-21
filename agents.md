# SaySpec

SaySpec turns narrated manual QA walkthroughs into reusable tests and a shared test library, with runs, failure explanations, and approved fixes.
It is an Electron desktop app built with React, TypeScript, and Vite. Web tests use Playwright; Flutter tests use Patrol.
This repository is the desktop app only; SaySpec Cloud (backend) and the website live in a separate, private repository.
The app is local-first and fully usable without any backend. Optional cloud features (accounts, shared test storage, sharing, reviews) go through the `CloudBackend` interface in `apps/desktop/src/cloud/`; only `apps/desktop/src/cloud/firebase/` (the SaySpec Cloud client) may import Firebase. Transcription goes through the provider registry in `apps/desktop/electron/transcription/`.
Keep privileged work (files, processes, credentials) in the Electron main process behind the preload bridge, and require explicit user approval before applying product-generated fixes.
Test generation runs the user's own Claude Code or Codex CLI in an embedded interactive terminal; do not replace it with headless generation.
Never commit backend configuration, credentials, or personal data. Configuration lives in git-ignored `.env.*` files; see each `.env.example`.
