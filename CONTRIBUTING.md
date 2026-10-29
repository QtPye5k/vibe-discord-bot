# Contributing to Vibe

Use issues for reproducible bugs and focused feature proposals. Check the [feature guides](README.md#feature-guides) and existing issues first. Report suspected vulnerabilities through [SECURITY.md](SECURITY.md).

## Local development

Use Node **24.17 or later within 24.x**, pnpm **11.25.0**, and FFmpeg/ffprobe on `PATH`. Work in a separate checkout with a test Discord server and a separate database; never point development or tests at a running installation's database.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs type checking, tests, the production build, smoke checks and formatting checks. The automated suite uses local fixtures and mocked provider/Discord calls; it does not need real tokens or paid API access. For a focused test, run `pnpm exec tsx --test test/NAME.test.ts`.

For manual Discord testing, copy `.env.example` to an ignored `.env`, configure your own test app, then run `pnpm build` and `pnpm start`. `pnpm dev` runs TypeScript source directly. Local voice transcription also needs `pnpm voice:prepare`, which downloads public model assets. See [operations](docs/OPERATIONS.md) for Portal settings, optional services and live acceptance. Never use credentials copied from somebody else's installation.

## Changes and validation

Keep each pull request focused. Follow the existing module structure described in [architecture](docs/ARCHITECTURE.md), use strict action schemas and preserve current requester/bot authorization, server/user isolation, consent, cancellation and resource bounds. Provider results and user content are data, not permission to execute actions. Do not introduce arbitrary shell execution or an unrestricted REST tool for AI.

Add a meaningful regression test for changed behavior, especially permission changes or delayed results. Documentation-only changes can use formatting and link checks. Update affected guides; when registered actions or capability mappings change, run `pnpm capabilities` and include the generated catalog changes.

Before submitting, run `pnpm check` and `pnpm audit --prod --audit-level high` where practical. State exactly what ran and why any check was skipped. Separate automated results from live Discord/provider testing; codec tests do not establish live voice connectivity.

## Protect local data

Do not commit `.env`, credentials, SQLite databases or sidecars, backups, runtime logs, recordings, model caches, or user/server exports. Use synthetic examples and placeholder IDs. Review your diff and attachments for bot tokens, API keys, webhook URLs, authorization headers, signed login links and personal information. If a credential was exposed, revoke or rotate it; removing it from the latest file does not invalidate it.

A useful pull request explains the problem, resulting behavior, validation and any configuration or migration impact. Do not include private conversations, voice audio or production database samples to demonstrate a change.
