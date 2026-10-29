# Community, approvals and optional operations

All action IDs below are available through the bot’s normal action interface and catalog. Writes use its shared confirmation and permission checks. Current Discord permissions still apply when queued work runs.

## Native administration and history

`guild.system-flags`, `guild.community` and `guild.onboarding-edit` use Discord’s native server APIs. Community changes require Administrator; onboarding supports full prompts/options/default-channel replacement. Native channel/thread edits include forum tags, reaction defaults, layouts and thread defaults. `member.permissions-compare` compares selected channels.

`channel.lock` saves and denies posting/thread creation across ordinary role and member overwrites. `channel.unlock` restores the exact saved overwrites only when they still match the bot’s applied lock; another administrator’s intervening edits require review. Administrator permissions inherently bypass channel overwrites.

`message.send` defaults to no notifications. Explicit `mentionUserIds`, `mentionRoleIds` and `mentionEveryone` opt in to bounded, permission-checked notifications. `message.search`, `message.history-export`, `ticket.transcript` and `ticket.thread-transcript` traverse retained accessible history. Continue using `nextBefore` until `complete` is true. A single response is limited to 5,000 messages, 6 MiB and 30 seconds. Deleted messages and attachment file contents cannot be reconstructed; transcripts include source IDs and attachment links.

Native moderation actions now create case records usable by existing case, appeal, export and activity-report actions. `moderation.tempban` adds a marked temporary ban; its expiry removes only a ban whose current reason matches that exact marker. Unknown writes remain recorded for reconciliation. A manual replacement becomes a conflict instead of being removed automatically. A Discord ban read followed by deletion is not an atomic compare-and-delete operation, so staff should avoid editing the same ban during its expiry request.

## Currencies, drawings and roles

`currency.create` defines a named fictional integer currency, supply cap and label. `currency.adjust`, `currency.transfer`, `currency.balance` and `currency.history` use transactional accounting. These currencies have no cash value and do not accept payments. A currency can be deleted only after its supply reaches zero. Personal erasure removes the person’s wallet and burns its outstanding supply.

`raffle.create` requires explicit free entry and records fixed rules, a deadline, prize and winner count. Configurable eligibility includes required roles, account age, membership age and community level. `raffle.enter` returns a numbered receipt; `raffle.withdraw` removes an open entry. Draws save a cryptographically chosen candidate before checking current eligibility, resume that candidate after a lookup interruption, and save the finalized winner record and entry digest before announcement. `raffle.export` provides the manager’s receipt/draw record. Unknown announcement delivery needs inspection instead of an automatic duplicate. Giveaways support the same role, age and level requirements at entry and again when selecting winners.

`eventroles.configure` links an ordinary role to accepted RSVPs on an existing local calendar event. Grants occur only inside its configured event window. Withdrawal, cancellation and expiry remove only roles recorded as the bot’s own grants; pre-existing roles are preserved. Interrupted or manually changed grants require `eventroles.review`.

`tournament.schedule` assigns exact timezone-aware dates to unfinished matches in the current round, publishes the dated bracket and creates one-time match reminders in the shared announcement scheduler. Old-round, completed-match and expired reminders stop automatically. Existing scheduling limits and current manager/source-channel permissions apply.

## Consented messaging and approval chains

`relay.configure` sets one source and destination; each author must use `relay.consent` for that exact policy version. A changed policy invalidates earlier consent. Original messages are forwarded through Discord only while author, configuring manager and bot access remain valid. Busy deliveries queue reference IDs rather than copied content. Interrupted sends are not blindly repeated.

`conversation.channel.configure` enables replies without repeated mentions in one channel; each author separately uses `conversation.channel.consent`. This requires Message Content and OpenAI. The bot retains bounded conversation context in a separate public-channel scope and excludes saved private preferences, private chat history, web search and administrative tools. Withdrawal removes that author’s retained public scope. Normal AI retention settings apply.

`tracking.watch` records future reply/reaction transitions on a selected message for up to 30 days. `tracking.view` requires current source history access; `tracking.remove` removes the watch and deduplication metadata. `ui.pages.publish` creates genuine previous/next buttons; navigation belongs to its author, expires after ten minutes and returns subsequent pages privately.

`approval.chain.create` shares one immutable AI action plan with selected reviewer roles and staged quorums. The owner cannot approve their own plan; one reviewer can satisfy only one stage. Every future plan step rechecks exact plan content, expiry, chain state, reviewer roles and source history access. `review`, `withdraw`, `renew` and `cancel` manage the chain. Rejection or withdrawal stops future steps; it cannot reverse an already completed Discord operation. The plan’s existing execution/reconciliation engine performs all approved actions.

## Optional PostgreSQL reads

Leave `EXTERNAL_DATABASE_URL` or `EXTERNAL_DATABASE_QUERIES_FILE` blank to disable this service. Set the connection URL to an operator-created restricted read-only PostgreSQL role, then copy and edit `config/external-database.queries.example.json` on the host. Discord accepts only named query IDs and typed parameter values; it never accepts SQL, connection URLs or file paths.

`database.queries` lists approved reads. `database.query` uses parameter binding inside a read-only transaction, a two-connection pool, five-second statement deadline, row limits, 64 KiB per row and 1 MiB returned output. Both current access and the exact approved catalog hash are checked again before results are released. The SQL lexer catches common allowlist mistakes; it is not a SQL sandbox. Operators must review their own approved SQL and restrict database privileges, including callable functions, to the intended data.

## Signed event automation and deployment notifications

Leave `OUTBOUND_AUTOMATION_URL` or `OUTBOUND_AUTOMATION_KEY` blank to disable outbound automation. The endpoint must be an operator-selected public HTTPS URL on port 443. `automation.external.configure` selects supported metadata-only events; message content is excluded. A persistent outbox retries bounded failures. The receiver must deduplicate `Idempotency-Key`, verify `X-Automation-Timestamp`, and verify `X-Automation-Signature: v1=<hex HMAC-SHA256(key, timestamp + "." + exact body)>`. The same event ID is used across retries; delivery is not a distributed exactly-once transaction. Public DNS is pinned at connection time, redirects are disabled, and saved manager permissions are checked again after DNS.

Set `DEPLOYMENT_WEBHOOK_SECRET` to enable `POST /hooks/deployments` on the configured bot HTTP server. Publish its HTTPS URL through your own hosting configuration. `deployment.notifications.configure` sets an exact project/environment and authorized destination; callers cannot choose a Discord server or channel.

The caller sends `X-Deployment-Timestamp` as Unix seconds and `X-Deployment-Signature` as `v1=<hex HMAC-SHA256(secret, timestamp + "." + exact body)>`. The accepted timestamp window is five minutes. JSON is limited to 64 KiB and uses this schema:

```json
{
  "eventId": "build-123",
  "project": "website",
  "environment": "production",
  "status": "succeeded",
  "releaseId": "release-123",
  "url": "https://example.com/deployments/123"
}
```

Statuses are `started`, `succeeded`, `failed` or `rolled-back`. Valid event IDs/payloads are retained for seven-day deduplication; reuse with a different payload is rejected. A successful HTTP 204 means durably accepted, not delivered to Discord. `deployment.notifications.list` shows delivery state. Unknown sends require inspection and explicit `deployment.notifications.resolve`; a manual retry can duplicate a previously accepted remote message.

## Approved code deployment and rollback

Leave `DEPLOYMENT_RELEASES_DIRECTORY` or `DEPLOYMENT_ACTIVE_FILE` blank to disable deployment selection. Activation also requires a configured host operator, current server Administrator and the controlled supervisor. No Discord action accepts source code, shell commands, package names or arbitrary filesystem paths.

After installing dependencies, building and testing a candidate on the host, stage its built files once:

```text
node scripts/stage-release.mjs <built-project-directory> <releases-directory> <release-id>
```

The helper creates a new release folder and `release.json` with SHA-256 hashes for its built files. It refuses overwriting an existing release. Keep the releases root beneath the original workspace, such as `data/releases`, so the installation’s compatible `node_modules` is an ancestor for ESM resolution. External release roots need their own compatible dependency resolution. Operators should make reviewed release folders immutable to other accounts and retain the dependencies used to test them.

`deployment.releases` verifies staged releases and exposes the exact manifest hash. `deployment.activate` requires that ID/hash pair, verifies every listed built file, creates a consistent online SQLite snapshot, atomically updates the active pointer and requests a controlled restart. The launcher verifies the selection again before starting it. Supported database schema is currently version 1; incompatible versions fail closed.

`deployment.rollback` selects only the exact recorded previous code release and takes another snapshot. It preserves current database content. It does not promise to reverse Discord side effects or schema migrations. `deployment.status` provides the selected current/previous hashes and latest backup checksum. Database restoration is a separate stopped-process host operation with an explicitly chosen compatible backup.

Deployment history is capped at 100 records. The service retains its newest 20 generated SQLite snapshots plus the active pointer’s snapshot; unrelated operator backup filenames are preserved. Release folders remain host-curated.

The independent uptime monitor persists outage/recovery transitions before attempting its Discord webhook, and acknowledges them only after a successful send. Pending alerts retry after a failed send or monitor restart. An interrupted webhook can have been accepted remotely, so retries may duplicate an alert; its stable alert ID makes that visible. The pending queue is capped at 32 transitions, with further changes combined into a counted latest-state summary. Run this monitor on another host to observe the bot host being unavailable.
