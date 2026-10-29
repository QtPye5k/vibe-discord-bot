# Security and observed analytics

All passive collection and automatic responses are off by default. Use `security.configure` after reviewing its exact `/schema`; changes require the shared action confirmation. Configure a staff alert channel, then explicitly enable the policies you intend to use. Gateway intents and effective channel permissions still govern which events and content the bot receives.

## Implemented policies

- **Join spikes:** configurable threshold/window, duplicate-join suppression and persistent alert throttling. `autoPauseInvites` optionally applies Discord's time-limited incident invite pause for 1–60 minutes. Existing longer pauses are preserved. This does not ban newcomers, pause DMs, identify an attack with certainty, or undo administrative changes.
- **Content review:** configured domain blocklists/allowlists, hostname-boundary matching, suspicious executable/double extensions, URL user-info/IP/internationalized-host/giveaway-pattern heuristics, mass mentions, capitalization and emoji scores. Known configured domains can be flagged; there is no bundled external reputation or malware scanner and no guarantee that a URL is phishing-free. Regex patterns are not executed locally from user input. Native Discord AutoMod remains a separate supported feature.
- **Human review and trust:** bounded findings queue, staff confirmation/dismissal and transparent configurable trust penalties based on confirmed findings plus existing warning cases. No automatic bans or timeouts are imposed. `autoDeleteFlagged` is an optional, explicitly approved message-deletion policy; it is off by default and requires Manage Messages.
- **Structural changes:** role changes/channel deletions can produce a configurable burst alert. Webhook-change alerts contain channel IDs, not webhook tokens. Unlisted administrative actors may be flagged when one recent audit entry matches the affected target. Audit correlation is best effort; an ambiguous or unavailable audit log produces an unknown actor, never an accusation.
- **Configuration comparison:** a saved `security.baseline.save` fingerprints accessible channels and selected server/role settings; `security.baseline.compare` reports added/removed/changed IDs. Loss of channel visibility can appear as removal. This detects changes, not whether they were authorized, and does not recreate deleted objects.
- **Scoped emergency lockdown:** `security.lockdown.apply` accepts up to 50 explicitly listed channels. It saves exact overwrite arrays and denies sending/thread creation or voice Connect/Speak across existing role/member overrides, preserving the bot's effective posting permissions. Discord Administrators retain their platform bypass. The state survives restarts. Restoration checks current overwrites and preserves conflicting later edits by default. `force:true` is a separate confirmed instruction to replace those later changes with the saved state. Time-limited restoration continues if new security actions are disabled; failed or conflicting restorations remain inspectable. Network failures can leave partial application/restoration, which the result and status explicitly report.

## Observed logs and privacy

Message edit/delete logs and administrative logs have separate switches. **Message text is not retained unless `logMessageContent=true` is explicitly configured.** Content is limited to 1,000 characters per before/after field; unknown, uncached or inaccessible content cannot be reconstructed. A source-channel allowlist can narrow message logging. Channel-linked historical logs and findings require current channel visibility and Read Message History before they are displayed or exported, even for staff. Deleted/inaccessible channel records are omitted. Staff alerts contain IDs and scores rather than captured conversation text.

Per-guild logs/findings are bounded to approximately 5,000 records; sweeps apply configured 1–90 day event retention and at least 30 days for moderation findings. Deduplication metadata is retained for at most one day and capped around 100,000 recent IDs globally. Staff alerts use durable per-key backoff and a hard ceiling of ten deliveries per server per minute. Retained SQLite data is not application-encrypted; protect the hosting filesystem and backups.

`analytics.privacy` lets each user opt out of personal observed-activity tracking and erase existing member counters. Aggregate server totals and moderation records remain. `analytics.erase.mine` erases personal counters without changing the preference. These privacy operations should remain available when analytics collection is disabled.

## Analytics

With `analyticsEnabled=true`, available events produce durable UTC daily message/channel, join/leave, edit/delete, reaction/poll, scheduled-event, AutoMod and voice metadata counters. Voice records contain channel/user IDs and elapsed time, never audio. Voice time is split at UTC midnight; a process restart resets checkpoint times instead of counting unseen downtime. The bot cannot infer historical activity, actual attendance from an RSVP alone, or whether an inactive member was offline.

- `analytics.observed` and `analytics.observed.export` read/export daily totals over up to 90 days.
- `analytics.compare` compares current and prior seven- or thirty-day periods.
- `analytics.activity` and `analytics.leaderboard` report observed member counts and configurable message/voice scoring.
- `analytics.summary` combines observed counts, existing moderation cases, support-ticket volume/resolution times, giveaway participation and action audit totals.
- `recordCommandMetric` supplies optional registry instrumentation for action success/failure counts and elapsed execution time. `analytics.command-latency` reports averages from those recorded samples. It is not a percentile histogram or a promise of provider latency.
- `analytics.resources` reports cumulative process CPU, current memory, uptime and Gateway ping; it is not host-wide CPU percentage monitoring.

Daily counters and inactive personal activity expire after 90 days. Root routing must enforce `DISCORD_GUILD_IDS` before forwarding events; sweeps also accept the allowed server list. Automation does not grant missing permissions or bypass hierarchy, Discord eligibility or API limits.

## Integration

Register with `registerSecurityActions(registry)`. Route the exact names in exported `SECURITY_EVENTS` to `observeSecurityEvent(eventName,args,client,store)`. Call `sweepSecurityTasks(client,store,now,allowedGuildIds)` from the existing serialized maintenance loop. To measure action execution, invoke `recordCommandMetric(store,guildId,action,status,elapsedMs)` from the registry's execution hook. No network requests occur during module registration.

Offline tests cover actual SQLite state, strict configuration, scoring boundaries, duplicate events, permissions revoked, opt-in content privacy, staff-channel access loss, per-server isolation, join bursts, alert backoff/budget, UTC voice boundaries, previous/current statistics, common confirmations, exact lockdown restoration, changed-permission conflicts, replay isolation and expiration. Live Discord incident and overwrite behavior still requires deployment acceptance in a test server.

The implementation follows Discord's [incident response API](https://docs.discord.com/developers/resources/guild#modify-guild-incident-actions) and [audit-log permission model](https://docs.discord.com/developers/resources/audit-log). These APIs do not provide certainty that a change is malicious or a complete rollback of a deleted server structure.
