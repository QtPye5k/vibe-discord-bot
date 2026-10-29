# Operations

## Prepare the host

Use Node 24.17+ within the 24.x release line, pnpm 11.25.0, and FFmpeg/ffprobe on `PATH` for audio/video actions and their checks. Run `SETUP.cmd` on Windows or `./setup.sh` on Linux. For manual installation, run `pnpm install --frozen-lockfile`, `pnpm check` and `pnpm voice:prepare`. Setup creates `.env` only when absent and prepares the local Whisper model when enabled; model assets require an initial download without a provider API key. Keep real credentials in that ignored file; use a single running process for each SQLite database.

Enter `DISCORD_TOKEN` and `OPENAI_API_KEY` locally when ready. `DISCORD_BOT_TOKEN` is also accepted. Non-AI features can run without the OpenAI key. The bot discovers its application ID after authentication; server commands need no OAuth client secret. Model availability and billing depend on the API account; check [model configuration and retirement dates](OPENAI_MODELS.md).

Install to a private test server with `bot` and `applications.commands`. Grant the permissions required by selected actions and position the bot above managed roles and members. Requesters also need current permissions and hierarchy. Channel overwrites and private-thread membership still apply. `DISCORD_GUILD_IDS` optionally restricts both accepted servers and command deployment. Previously deployed global commands may remain visible after changing registration scope; the runtime allowlist still denies excluded servers.

Enable required privileged intents in the Portal and `.env`: Members for membership events, Message Content for prefix/passive message features, and Presences for presence events. Slash commands do not require these switches. Check the application's current [Discord intent eligibility](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents).

## Deployment acceptance

After entering credentials, run `pnpm run doctor --live`. It checks authentication and model visibility through read-only requests; it does not perform paid generation. Then start the compiled bot and verify in the test server:

1. Help, schemas, status and context-menu commands appear. A normal member is denied staff-only data and administrative changes.
2. Request a harmless test channel and verify the ordinary change completes under smart confirmation mode. Then request its deletion, inspect the exact preview and confirm it once. Verify a different user, channel or server cannot confirm; permission removal, expiry and repeated use reject execution.
3. Test private channel/thread tickets with unrelated members, staff access, transcript and closure. Review actual overwrites and preserve history as intended.
4. Create a short reminder, restart before its deadline and inspect one delivery. Test policy/module withdrawal and any enabled scheduled workflow.
5. Make a small billed AI request, image and audio transcription. Verify user isolation, erasure and cancellation of delayed responses after relevant consent or policy withdrawal.
6. Test voice with an unconsented participant, explicit consent, the disclosed text destination and synthetic audio. Revoke during processing and verify no late result or playback is delivered. Check outbound UDP connectivity.
7. Test optional dashboard, signed events, local tasks, plugins and entitlement roles only if configured. Confirm current operator authority, intended network exposure and the relevant feature guide's recovery behavior.

Offline tests cannot establish final token validity, live channel permissions, account eligibility, model quality or target-host connectivity. Record these live results separately from [offline verification](VERIFICATION.md).

## Runtime and HTTP endpoints

`START.cmd` or `pnpm start` runs the build. Source changes require `pnpm build`; environment changes require restart. Stored feature/policy settings apply without rebuilding. Ctrl+C/SIGTERM stops admission, drains tracked work, cleans up voice/plugins and closes SQLite. [Supervised startup and fixed host tasks](LOCAL_OPERATIONS.md) are optional. The host must stay awake and connected.

`HEALTH_PORT=0` disables HTTP. With a nonzero port, `/health` and `/ready` return 200 when Gateway is ready and 503 otherwise. The default `HEALTH_HOST=127.0.0.1` binds locally. Additional routes are enabled separately:

| Route             | Enablement                   | Purpose                                                           |
| ----------------- | ---------------------------- | ----------------------------------------------------------------- |
| `/discord/events` | `ENABLE_WEBHOOK_EVENTS=true` | Signed Discord Webhook Events receiver                            |
| `/dashboard`      | `ENABLE_DASHBOARD=true`      | Private operator interface with short-lived Discord sign-in links |

For Discord's **Webhook Events Endpoint URL**, use `https://YOUR_PUBLIC_HOST/discord/events`. Point that public HTTPS reverse proxy/tunnel to the bot's listener, preserving the raw request body and signature headers. Start the bot before Portal validation; `DISCORD_PUBLIC_KEY` can be entered from the Portal or discovered after login. This public verification key is not the bot token. A local `http://127.0.0.1` URL is not a public endpoint. This receiver does not replace Gateway slash-command handling or provide an Interactions Endpoint URL. Follow [Discord's Webhook Events guide](https://docs.discord.com/developers/events/webhook-events) for the app's available subscriptions.

Signature validation, application matching, a bounded durable inbox, deduplication and retry handling precede event dispatch. Entitlement events are reconciliation hints; actual entitlement and role changes are verified against Discord. The endpoint does not automatically implement every event's business workflow. `webhook.events.status` exposes inbox counts to an application operator without exposing payloads. Inbox records expire after three days, with an additional completed-record bound.

The [dashboard](DASHBOARD.md) is off by default. Local use can share port 3000; remote use requires an exact HTTPS `DASHBOARD_BASE_URL` and a proxy preserving its expected Host. Publish only intended routes and redact sign-in query strings from proxy logs. No separate client secret is needed for this dashboard's sign-in flow.

Compose binds inside the container and publishes no host port by default. Add a deliberate loopback port mapping/proxy for HTTP access. Its restart policy handles process exits, including a confirmed `system.restart`; health status alone does not restart an unhealthy live process. An independent monitor is needed for host/network downtime.

## Capacity, delivery and recovery

Image/PDF, Office and FFmpeg jobs share two active heavy-work slots. AI, voice and fixed tasks have separate bounded admission. Busy work is rejected for a later retry. This is a single-process design: shared network-filesystem SQLite, multiple replicas, distributed queues and automatic sharding need additional engineering.

Scheduled Discord messages use stable nonces where supported, but Discord's deduplication window is finite. A crash after remote acceptance and before local persistence can leave an ambiguous outcome or later duplicate. A cancellation cannot recall a send already in progress. Inspect retained job state before repeating work.

Channel/thread creation, layout batches and other workflows with ambiguous mutations retain reservations or require reconciliation. They do not promise transactional rollback of Discord resources. [Layout restoration](SERVER_LAYOUT.md) applies reviewed batches of at most ten operations and preserves unrelated resources; configuration snapshots exclude message history and many resource types. Temporary role removal may fail after permission/hierarchy changes. Check task states and logs after recovery.

## Data and retention

SQLite and backups may contain private documents, preferences, form answers, reports, moderation evidence, ticket subjects and configured content logs. Protect host access and copies. Runtime limits cap individual records and workflows; they are not a universal server-data deletion policy.

- AI conversation/document data expires after `MEMORY_DAYS` since its last stored update, default seven days. Preferences persist until erased. `/forget` clears the caller's AI data and invalidates pending AI delivery.
- Bot audit retention follows `AUDIT_DAYS`, default thirty days. Expired confirmations and completed reminder jobs are pruned; finished reminder jobs remain for seven days past their due time.
- Security/analytics collection starts disabled. Content logging needs separate `logMessageContent:true` opt-in. Retained security events default to seven days and allow 1–90 days; findings retain at least thirty days. Observed metrics/activity retain up to ninety days. These records represent observed events, not a reconstruction of unavailable history. See [security features](SECURITY_FEATURES.md).
- Closed tickets, forms and moderation records have their own feature bounds and do not all expire under `MEMORY_DAYS`. `community.erase` removes supported personal community data while preserving moderation evidence. Apply a reviewed retention process to records without a dedicated removal action.

## Backup, update and rollback

`pnpm backup` creates a consistent SQLite online backup in ignored `backups/`. It does not copy `.env`, Discord messages or remote media. Store the credential file separately in secure secret storage.

Before updating, take a backup and retain the previous source plus lockfile. Stop the process, install frozen dependencies, run `pnpm check` and the dependency audit, then perform test-server acceptance. Re-run `pnpm capabilities` after catalog changes. Windows/Linux CI and Docker configuration are included; a configuration file is not evidence of an executed remote build.

To restore SQLite, stop every process using it, preserve the current database, replace the configured `DATABASE_PATH` with a chosen consistent snapshot, handle stale sidecars only while stopped, and restart. Never overwrite a live database. Preserve the Docker `bot-data` volume during updates. Roll back source and lockfile together; use a matching backup if a later release changes schema. Unknown future schema versions are rejected.

Hosted Activities, private provider accounts, monetization products, deployment targets and remote administration still need their respective implementation/configuration and authorization. Refer to the item-level [capability audit](CAPABILITIES.md) and feature guides before enabling them.
