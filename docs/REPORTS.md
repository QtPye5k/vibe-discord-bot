# Scheduled administrator reports

`report.preview` computes selected aggregate administration statistics for the previous complete UTC day, Monday–Sunday week, or calendar month. `report.schedule.set` publishes those reports daily, every Monday, or on the first of the month at the configured UTC hour/minute. Changes use the common exact-action confirmation. Up to ten schedules are persisted per server.

```json
{
  "id": "weekly-staff",
  "channelId": "YOUR_PRIVATE_STAFF_CHANNEL_ID",
  "cadence": "weekly",
  "hourUtc": 9,
  "minuteUtc": 0,
  "sections": ["activity", "commands", "moderation", "support", "giveaways"]
}
```

Sections contain the following actual retained data:

- `activity`: opted-in UTC observed event counters, summed across observed channels. Missing collection, disabled analytics and retention gaps remain explicit.
- `commands`: registered action success/failure/denied counts within the period, limited to the top 30 action/status combinations. Pending confirmation requests are excluded.
- `moderation`: warning cases and observed security findings created during the period. No warning reasons or member identifiers are included.
- `support`: tickets created/closed during the period, average resolution seconds for those closures, and the current open count.
- `giveaways`: giveaways whose configured deadline falls in the period, their current drawn count and recorded entrant count. Entry timestamps are not reconstructed.
- `resources`: the current bot process CPU, memory and uptime snapshot. These values are not historical whole-host measurements.

The destination must be hidden from the everyone role, and both author and bot need current visibility, sending and attachment permissions. The policy author must still belong to the server and hold Manage Server. Scheduling action role/channel restrictions are rechecked when delivering. Each report is a real JSON attachment capped at 128 KiB. Reports contain aggregate numbers and action names, never message bodies, ticket subjects, application answers, warning reasons or user identities.

`report.schedule.list` shows persisted configuration, next occurrence, retry attempts and error class. `report.schedule.remove` cancels future delivery and discards pending retries. Updating a schedule creates a new version and invalidates previous work. Cancellation or replacement during a permission fetch cannot send or restore the old report. A request already accepted by Discord cannot be recalled by cancellation.

A maintenance pass starts at most ten due reports and stops starting additional work after twenty seconds. Its currently running Discord request completes or times out. Sweeps are serialized. Report generation and sending use the original due occurrence; a rendered snapshot and stable Discord message nonce survive restart/retry unchanged. Transient failures back off and stop after three failed attempts; lost authority, unknown resources and permission failures disable the schedule immediately. After a successful delivery, the next future UTC occurrence is selected, skipping any intervening missed occurrences. Network delivery is not guaranteed exactly once after every possible crash or Discord nonce-retention window.

Disabling `analytics` pauses report delivery, and the configured server allowlist is checked before work begins. Accepted delivery is recorded even if the module is paused during the send, preventing an avoidable repeated delivery when it resumes. Cancellation remains available while paused. Re-enable or replace a disabled failed schedule only after reviewing its destination, author and last error.

Native timed polls already use `poll.create durationHours` (1–768 hours); Discord closes them at that deadline. `poll.end` can end an accessible bot-owned poll early. No second timer is required to provide native poll expiry.

Fourteen offline tests exercise actual SQLite persistence, strict schemas/confirmations, UTC/leap/calendar boundaries, private destinations, real report attachments, aggregate privacy/guild isolation, authority changes, stable retry payload/nonces, preflight retry caps, allowlists/pause, cancellation/replacement during I/O and concurrent sweep exclusion. No Discord login or paid API call is needed for these tests.
