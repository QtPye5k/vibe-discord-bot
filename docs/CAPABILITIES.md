# Capability coverage

The supplied list contains **909 bullets across 22 sections**. These bullets overlap and include alternative implementation choices; they are not 909 independent commands. This build registers **699 executable action schemas**. [requirements.md](requirements.md) preserves the original list, [capabilities.json](capabilities.json) records every bullet, and [actions.json](actions.json) lists the actual action inputs.

**Implemented** means a concrete registered action or source entrypoint exists. A configurable optional adapter counts as implemented code while its required fields are blank; blank fields keep it unavailable. This is separate from live credentials, hosting, grants, billing, platform eligibility and acceptance testing. **External setup** below is reserved for a literal platform operation that a bot API cannot perform. **Resolved architecture** records a deliberately unselected alternative, not a claim that another language/distributed backend was implemented. Partial/unimplemented counts, if nonzero, are unfinished code and must not be hidden by setup language.

The [reviewed acceptance matrix](ACCEPTANCE_MATRIX.md) documents the 297 previously partial, externally dependent, missing or alternative rows with concrete behavior, source/test files and exact configuration fields. Bounds, consent, current permissions, supported formats and honest observation gaps are part of each implemented contract.

## Counts

| Status                    | Original bullets |
| ------------------------- | ---------------: |
| implemented               |              894 |
| partial                   |                0 |
| external_setup            |                4 |
| unimplemented             |                0 |
| architectural_alternative |                0 |
| resolved_architecture     |               11 |

| Original section                                                    | Implemented | Partial | Platform setup | Unimplemented | Resolved design |
| ------------------------------------------------------------------- | ----------: | ------: | -------------: | ------------: | --------------: |
| 1. Server Administration and Configuration                          |          31 |       0 |              0 |             0 |               0 |
| 2. Channel, Category, Forum, and Thread Management                  |          47 |       0 |              0 |             0 |               0 |
| 3. Role Management and Permissions                                  |          32 |       0 |              0 |             0 |               0 |
| 4. Member Management and Moderation                                 |          47 |       0 |              0 |             0 |               0 |
| 5. Security, AutoMod, and Anti-Raid Protection                      |          39 |       0 |              0 |             0 |               0 |
| 6. Messaging, Attachments, and Chat Control                         |          56 |       0 |              0 |             0 |               0 |
| 7. Commands and Interaction Methods                                 |          31 |       0 |              0 |             0 |               0 |
| 8. Interactive Interfaces, Forms, and UI Components                 |          37 |       0 |              0 |             0 |               0 |
| 9. Voice Channels, Audio, Speech, and Soundboards                   |          45 |       0 |              0 |             0 |               0 |
| 10. Events, Scheduling, Reminders, and Automation                   |          33 |       0 |              0 |             0 |               0 |
| 11. Artificial Intelligence and Natural-Language Capabilities       |          63 |       0 |              0 |             0 |               0 |
| 12. Images, GIFs, Videos, Documents, and Media Processing           |          47 |       0 |              0 |             0 |               0 |
| 13. Games, Entertainment, and Virtual Economies                     |          45 |       0 |              0 |             0 |               0 |
| 14. Community Management, Support, and Engagement                   |          42 |       0 |              0 |             0 |               0 |
| 15. Statistics, Tracking, Analytics, and Reporting                  |          34 |       0 |              0 |             0 |               0 |
| 16. Third-Party Integrations and External Automation                |          56 |       0 |              0 |             0 |               0 |
| 17. Bot Identity, Profiles, DMs, OAuth2, and Account Linking        |          33 |       0 |              0 |             0 |               0 |
| 18. Webhooks, Gateway Events, and Automation Triggers               |          35 |       0 |              0 |             0 |               0 |
| 19. Discord Activities, Games, and Advanced Application Experiences |          26 |       0 |              0 |             0 |               0 |
| 20. Monetization, App Distribution, and Premium Features            |          22 |       0 |              4 |             0 |               0 |
| 21. Developer Tools, Hosting, Scalability, and Operations           |          43 |       0 |              0 |             0 |              11 |
| 22. Unified All-in-One Bot Capabilities                             |          50 |       0 |              0 |             0 |               0 |

## Platform operations that remain with the account owner

- **s20-005 — Create product SKUs.** Actual product SKU creation is a Developer Portal operation after app/team monetization approval; the documented bot API lists SKUs and consumes entitlements but does not create offerings. No fabricated create-SKU endpoint is exposed.
- **s20-018 — Create an application Store page.** The code prepares configured offering information and the native Store link. Creating/publishing the actual Discord application Store page requires the team’s Developer Portal configuration; it is not an authenticated bot REST mutation.
- **s20-019 — Publish application information in supported discovery surfaces.** App discovery publication requires verified app eligibility, required policy/support metadata and the Developer Portal Enable Discovery operation. Providing an app link is not claimed as completing publication.
- **s20-024 — Manage supported pricing and offerings.** Configured local benefits/offerings are read and enforced, but actual payment prices and offering publication are managed in Developer Portal. Discord checkout remains authoritative; the bot does not invent a pricing-edit API.

Discord requires offering creation/pricing, Store configuration and discovery publication in its Developer Portal. The implemented premium module handles native purchase buttons, current user/guild entitlements, durable/consumable benefits, action/AI allowances, actual dashboard appearance, usage/lifecycle analytics and support. It does not impersonate unsupported SKU/pricing/publication APIs. See [managing SKUs](https://docs.discord.com/developers/monetization/managing-skus), [monetization setup](https://docs.discord.com/developers/monetization/enabling-monetization) and [discovery setup](https://support-dev.discord.com/hc/en-us/articles/6378525413143-App-Directory-App-profile-pages).

## Selected operating design

[Architecture](ARCHITECTURE.md) selects TypeScript on Node.js 24, one Gateway owner and primary SQLite WAL database, bounded worker threads/subprocesses, optional named provider adapters and companion HTTP services. Alternative language rewrites, HTTP interaction dispatch, Redis/a separate vector database and distributed primary/sharded deployment are resolved design choices. Optional approved PostgreSQL reads, remote host agents and independent monitors have their own concrete implementations; they do not distribute primary SQLite ownership.

## Working contracts

- Actions use strict schemas, current member/bot permissions, role hierarchy, per-server policies and exact expiring confirmations for changes. Durable plans and staged approvals share one engine. Unknown remote outcomes require inspection/reconciliation instead of blind write retry.
- [Optional service adapters](OPTIONAL_INTEGRATIONS.md) implement real selected Google, GitHub, GitLab, Trello, Notion, YouTube, Twitch, email/SMS, reputation, CAPTCHA, Steam, parcel, commerce, social, video and cloud APIs. [Optional setup and OAuth](OPTIONAL_SETUP.md) supplies account-owned grants; host shared credentials require operator authority. Empty provider fields disable discovery/execution; supplied fields do not prove account authorization.
- [AI workflows](AI_WORKFLOWS.md) add exact arithmetic, private durable pins, source/role-scoped knowledge, bounded paginated analysis, deterministic configured model routes, per-person/admin policies and immutable reviewed multi-step plans. [Ticket AI](TICKET_AI.md) can use approved readable content, private-thread tickets, priority/locale and fixed category routing.
- [Voice](VOICE.md) verifies the actual lazy Opus/DAVE runtime, supports compressed authorized attachments and fixed audio sources, durable music references, current-track volume and voice/Stage moves. Receiving, acoustic VAD, transcription, spoken commands/replies, summaries and persistent individual WAV archives require their disclosed separate consent and bounds.
- [Media](MEDIA.md) and [audio/video](AUDIO_MEDIA.md) produce real bounded image/file outputs: typed ordered filters, transparent backgrounds, charts/cards/statistics bindings, XLSX, emoji/soundboard preparation, perceptual duplicate indexing and FFmpeg effects. Supported file formats are explicit; no universal binary/layout converter is claimed.
- Hosted [Activities](ACTIVITIES.md) are actual bundled Embedded App SDK applications with authenticated shared games, quizzes/learning, whiteboard, tasks/editor, maps, simulation and room statistics. [Native Game Stats Widgets](GAME_STATS_WIDGETS.md) use the separate actual Application Identity Profile API, with a verified personal grant and operator-approved game identity/stat source. Native game claiming and widget layout configuration remain Portal setup.
- [Premium](PREMIUM.md), authenticated dashboards, signed inbound/outbound event routes, approved local/remote operations, immutable code deployment/rollback and independent uptime monitoring have concrete modules. The database, backups, retained consented data, configuration files and host privileges require normal operator protection.

Offline tests verify executable behavior, schemas, codecs, real media processing, durable recovery and adversarial authority/source changes. They do not prove live Discord/OpenAI/provider login, UDP reachability, privileged intents, product eligibility or production uptime. [Verification](VERIFICATION.md) records the actual checks and remaining live acceptance work.

## Regeneration

Run `pnpm capabilities` after action changes. Generation checks all 909 original IDs, every mapped registered action, all 297 reviewed rows, cited source/test files and configuration field names. Source/test references are evidence pointers, not a substitute for running the tests or manual live acceptance.
