# Explicit warnings and bounded escalation

`warning.issue` creates a durable case compatible with existing case notes, owner-visible cases and appeals. It records an explicit warning separately so existing `case.warn` records do not silently trigger automatic sanctions. All writes require the common expiring confirmation. Issuing warnings requires current Moderate Members permission for both requester and bot, plus the ordinary requester/bot role hierarchy checks.

## Notices

Choose a delivery mode when issuing a warning:

- `record-only` creates the case without a notice. This is the default.
- `configured-channel` queues a notice in the text channel selected with `warning.configure`. The issuing moderator, target and bot must currently have the required channel access; the bot must be able to send. The notice includes the case number, target ID and violation reason without pinging members.
- `consented-dm` queues a personal notice only if the target explicitly enabled server notification DMs with `notification.subscribe`. Consent is checked before saving the warning and again at delivery. Opting out, sending STOP or disabling notifications prevents queued DM delivery. No unsolicited direct messages are sent.

Notices are durable jobs rather than a second untracked network call during case creation. Read `warning.jobs`, optionally filtered by member, for the latest 100 job states. `warning.job.cancel` cancels pending notice or timeout work. Cancellation cannot recall an HTTP request already sent or undo a completed action.

## Opt-in timeout policy

A manager with Manage Server and Moderate Members can configure:

```json
{
  "noticeChannelId": null,
  "escalationEnabled": true,
  "threshold": 3,
  "windowHours": 24,
  "timeoutMinutes": 10,
  "cooldownMinutes": 60
}
```

Escalation is disabled by default. The policy counts only explicit warnings within the configured window, excluding warnings whose appeals were approved. Its threshold is between two and twenty warnings; the window is between one hour and thirty days. The only automatic sanction is a temporary timeout between one and sixty minutes. The module cannot automatically kick or permanently ban a member.

The cooldown is at least the larger of the configured cooldown and timeout duration. Each timeout job has a fixed absolute end time calculated when queued, so retries cannot extend it. An existing longer timeout is preserved. An expired queued sanction is skipped.

Before each delivery or sanction, the queue refreshes the issuing moderator, target and bot, checks current permissions and hierarchy, and checks access to the originating channel. Jobs tied to a configured policy also refresh the configuring manager and check their Manage Server/Moderate Members permissions and hierarchy. Policy changes invalidate older policy jobs. Approved appeals, missing cases, permission loss, an unmanageable target or revoked DM consent cancel affected work. Administrators cannot be automatically timed out.

## Durability and limits

At most twenty eligible jobs are considered per maintenance pass. The module pauses when moderation is disabled and respects the configured guild allowlist. Reentrant maintenance calls cannot deliver the same job concurrently. Pending jobs survive restarts, including interrupted `running` jobs. Transient failures back off and stop after three attempts; only error classes are stored. Notices use stable Discord message nonces with duplicate enforcement. Discord’s nonce deduplication window is finite, so a very late retry after an ambiguous delivery cannot provide an unlimited exactly-once guarantee.

Warnings are limited to 100 per server per hour and 200 pending/running delivery or timeout jobs per server. Case creation and its queued work commit in one SQLite transaction; reaching a limit rolls back the entire request. Completed/cancelled/failed job metadata is pruned after seven days and explicit escalation counters after thirty-one days. Existing moderation case records are retained under the bot’s normal case policy.

The focused tests exercise confirmation, case sequence compatibility, explicit opt-in, target access, DM revocation, fixed timeout deadlines, longer timeout preservation, manager authorization, approved appeals, policy invalidation, module pauses, guild allowlists, cancellation races, retry bounds, concurrent maintenance, restart recovery and transactional queue limits. They use stub Discord transport and make no live server changes.
