# Automation and public integrations

All policy creation and changes use the common action registry, exact JSON schemas and human confirmation. Policies are persisted in SQLite per server. Their author must still have Manage Server when jobs execute. Each message destination and ordinary role is revalidated before use. Role assignment additionally requires current Manage Roles and both bot and author hierarchy. Roles with privileged or unknown permission flags are rejected.

## Event workflows

`workflow.set` configures up to five explicit steps: send a message to a chosen channel, create a public thread from the observed source message, or assign an ordinary role to the event's eligible member. Arbitrary registry actions, shell commands and destructive actions cannot be embedded in a workflow. A message workflow can filter one source channel and a literal case-insensitive keyword. Thread steps support `messageCreate` with a configured source channel. Supported event names are listed in the action schema, including signed Discord webhook events routed by the HTTP receiver.

```json
{
  "id": "welcome",
  "trigger": "guildMemberAdd",
  "steps": [{ "kind": "message", "channelId": "YOUR_CHANNEL_ID", "content": "Welcome {user}!" }]
}
```

The literal placeholders are `{user}`, `{userId}`, `{channel}`, `{guildId}` and `{event}`. Mentions are disabled in generated messages. No original message contents are persisted in the job queue. Policies are capped at 25 per server; active outbox jobs at 200 per server. `workflow.list`, `workflow.jobs` and `workflow.remove` expose policy state and cancellation. Replacing a policy invalidates its old queued work.

Work is queued durably and runs on bounded maintenance sweeps. Successful steps are saved before advancing. Failed transient operations retry up to three times with exponential backoff; permission/policy errors stop immediately. Message sends use a stable nonce for their occurrence. Event fingerprints suppress repeat observations for the retention window, but Gateway event types without unique delivery IDs can coalesce identical state changes. Network delivery is not guaranteed exactly once. Jobs from finished or failed workflows are retained seven days.

## Scheduling, events and community dates

- `schedule.set`, `schedule.list`, `schedule.remove`: recurring UTC announcements using five-field cron. Integers, comma lists, ranges and steps are supported. Weekday 0 or 7 means Sunday. Day-of-month and weekday restrictions use OR semantics. No named months/weekdays, seconds field or timezone/DST extension is supported. Missed occurrences are skipped rather than sent in a burst. Delivery retries retain a stable nonce and stop after three failures.
- `channel.temporary`, `channel.temporary-list`: text/voice channels with a durable expiration time. An occupied voice channel is retained and retried later. Expiration continues when new automation policies are disabled; failures back off and remain visible after their bounded attempt limit.
- `voiceroom.hub`, `voiceroom.hub-remove`: join-to-create voice rooms under a configured category. Rooms are private by default, limited to 50 temporary resources per server, and cleaned up after becoming empty. `voiceroom.allow` lets the room owner invite a current member without delegating channel-management privileges. Voice-state intent must be enabled.
- `calendar.create`, `calendar.list`, `calendar.rsvp`, `calendar.checkin`, `calendar.cancel`, `calendar.export`: local event calendar, bounded RSVP capacity and FIFO waitlist promotion, self check-in, optional observed voice attendance, timed reminders and post-event counts. These local entries are separate from Discord's native scheduled-event actions. Notification retries are capped at three, and original channel access is checked before reading events. RSVPs and attendance are durable; live attendance is observed metadata, not an infallible attendance proof.
- `celebration.configure`, `celebration.set`, `celebration.remove`: operator-selected destination plus each member's own public birthday/anniversary opt-in. Only month/day is stored, not birth year. Announcements use UTC dates; February 29 is announced only in leap years. Delivery retries are bounded per date and use a stable nonce.
- `tournament.create`, `tournament.result`, `tournament.view`: 2–32-player single-elimination brackets with byes and published rounds. Staff record match results; the bot does not validate an external game result. Each selected winner must be an unfinished match participant.

Native Discord scheduled events, Stage instances, timed giveaways, personal reminders and temporary roles retain their existing dedicated actions. Automatic event-channel creation, calendar-provider synchronization and arbitrary scheduled host scripts are separate requirements, not implicitly supplied by these local calendar actions.

## Public integrations

`integration.github` queries publicly accessible GitHub repository metadata, recent commits, releases, pull requests or Actions runs. It uses no GitHub credential. Private repositories and authenticated mutation workflows require additional authorization and implementation. Public GitHub rate limits still apply.

`integration.weather` retrieves modeled current conditions by latitude/longitude from Open-Meteo. Responses identify the source and observation/model timestamp and units. Provider terms and availability apply. Public JSON is cached for five minutes, with 100 cached endpoint entries, and simultaneous identical queries are coalesced.

`integration.hosts` confirms up to 20 exact public HTTPS hostnames for this server. Then `integration.http` can GET a bounded endpoint, `integration.rss` reads RSS/Atom items, and `integration.watch` configures RSS, uptime or content-hash change notifications. `integration.watch-list` exposes baseline/status/error/undelivered change state. `integration.watch-remove` revokes a monitor.

Monitors establish an initial silent baseline. Later changes produce notifications; unchanged states stay quiet. RSS retains at most 200 item IDs and sends up to five new entries per update. Intervals are 5 minutes–24 hours; at most 20 monitors per server. Failed notification delivery retries three times with the same nonce, then disables the monitor for staff review. Removing/replacing a monitor during an HTTP request discards its late result and cannot resurrect the old policy.

Outbound HTTP enforces HTTPS, exact confirmed hosts for arbitrary endpoints, no URL credentials/custom ports/fragments, no redirects, bounded bodies, four active requests, and bounded DNS/TLS-response timeouts. Every DNS answer must be public. The actual HTTPS socket is pinned to the validated IP while TLS still verifies the original hostname; there is no resolve-then-fetch rebinding gap. Private, loopback, link-local/metadata, mapped and unsupported transition networks are blocked. Feeds are parsed without DTD/entity expansion or external document fetching.

These public readers do not authorize Google, email/SMS, malware scanning, private databases, private repositories or cloud accounts. OAuth grants, service credentials and endpoint-specific implementation are still required for those services. No secret should be supplied through Discord action inputs.

## Verification and limits

Offline tests use real SQLite state and injected transports. They check cron semantics, role safety, event deduplication, resumed failed steps, policy revocation during I/O, guild/visibility boundaries, stable delivery IDs, bounded retry behavior, RSVP waitlists, tournament advancement, DNS pinning, private-address rejection, feed parsing, monitor baselines, change delivery and removed-policy late results. No authenticated or paid service requests are made by these tests.

The deployment remains a single process per SQLite database. Maintenance has bounded per-pass work and stops starting additional work after its time budget; an already-running network operation completes or times out. External outages, missing permissions and crash points can require staff review. No claim of exactly-once network effects or complete third-party synchronization is made.
