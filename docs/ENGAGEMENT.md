# Community enrollment and announcements

The `engagement` module supplies local opt-in rosters, accepted task assignments, rotating questions and member-count milestones. Every configuration/member change uses the common action confirmation. These features do not send direct messages or grant Discord roles.

## Clubs, groups, teams and waiting lists

`group.configure` creates up to 25 rosters per server. Choose a `kind` of `club`, `group`, `team`, `volunteer` or `staff`, a visible channel, a name/description, a capacity of 1–500 and an optional waitlist of 0–500. An optional `managerRoleId` delegates local roster/task management; Manage Server remains sufficient. The manager role is an authorization gate, not a role the bot assigns.

```json
{
  "id": "readers",
  "kind": "club",
  "name": "Readers club",
  "description": "Opt in for the next reading group.",
  "channelId": "YOUR_CHANNEL_ID",
  "capacity": 20,
  "waitlistCapacity": 50
}
```

Members use `group.list`, `group.enroll` and `group.leave`. Enrollment can only affect the requester. Repeated enrollment is idempotent. A full roster admits the requester to its FIFO waitlist; departure or a capacity increase promotes waiting records before later entrants. Capacity cannot shrink below recorded enrollment. Hidden rosters are omitted from listings. Managers see participant/waitlist IDs; other members receive counts and their own status/position.

`group.member.remove` removes a local enrollment record. `group.delete` deletes a roster and its local assignments. Both leave Discord roles/channels unchanged. Rosters retain explicitly opted-in records until departure, member erasure or manager cleanup; they are not a continuous proof of current server membership. Any future Discord action would require its own fresh membership/role checks. No such role grants are implied here.

`group.assignment.set` lets a current manager propose a bounded task to an explicitly enrolled seated member. At most 100 tasks are stored per roster. Tasks begin `proposed`; the target uses `group.assignment.respond` to accept or decline. A target must accept before completing a task, and must still hold a roster seat when accepting. Managers can read all tasks through `group.assignment.list`; members see only their own. `group.assignment.remove` removes a task. Assignments are local plans and accepted responsibilities, not a promotion to Discord staff authority or an automatically sent invitation.

`group.erase.mine` removes the requester's seats/waitlist entries and tasks assigned to them in this server. Departure and erasure remain available when the engagement module is disabled or roster-channel visibility was lost. A task can still be declined while the module is disabled. Other assignment changes remain paused.

## Daily questions

`engagement.questions.set` stores up to 100 supplied questions (1,000 characters each), a channel and a daily UTC time. At most five question policies exist per server. Questions rotate in stored order; one due occurrence is queued, then the next future UTC occurrence is selected. Returning after downtime sends one due question and skips intervening missed days. Question content is supplied explicitly; these posts do not silently incur OpenAI costs.

`engagement.questions.list` shows configuration and durable job metadata. `engagement.questions.remove` cancels a policy and its queued posts. Updating a policy creates a new version and invalidates work from its previous configuration.

## Member-count milestones

`engagement.milestone.set` accepts a channel, up to 25 distinct member thresholds and a text template. `{server}` and `{count}` are expanded; expanded content is capped at 1,900 characters. At most five milestone policies exist per server. The current observed member count becomes a silent baseline. Only future thresholds above that baseline are eligible. Each threshold queues once; its persisted queued/announced flags prevent repeat announcements when the count drops and later rises again.

`observeEngagementMemberCount` records current observed Gateway membership counts without making network calls. The application calls it for relevant member events and ready guild counts. Counts older than 24 hours do not generate new milestone jobs. Missing intents, downtime and missed events can delay or omit observation; the bot does not infer an exact historical milestone timestamp. Existing queued jobs remain durable across restart.

`engagement.milestone.list` shows baseline/threshold/delivery state. `engagement.milestone.remove` cancels a policy and its queued jobs. Replacing a policy establishes a new baseline; it is an explicit new policy rather than an automatic replay of old milestones.

## Delivery and verification

All announcement messages originate from the durable sweeper. Before sending, it reloads policy/version, fetches current policy author and bot membership, checks Manage Server, original/destination visibility, sending permission and any scheduling action role/channel restrictions. Removing a policy during a fetch cannot send or resurrect it. Mentions are disabled.

The queue holds at most 100 pending announcement jobs per server. A serialized maintenance pass starts at most ten due jobs and stops starting additional work after twenty seconds. A running Discord request completes or times out. Transient failures retry with the same persisted body/nonce up to three failed attempts. Lost permissions/resources or the retry cap disable the policy and leave visible failure metadata. Failed/done jobs are retained seven days. Discord effects are not guaranteed exactly once after every crash or beyond Discord's nonce-retention window.

The server allowlist and `engagement` feature pause are checked before queuing/sending. Accepted delivery is recorded even if the feature is paused while its request is in flight. Cancellation remains available while paused. Seventeen offline tests verify actual SQLite roster/queue state, confirmation schemas, FIFO promotion, hidden roster privacy, manager/target boundaries, task consent, erasure, stale revisions, rotation, milestone deduplication/bounds, retry limits, allowlists/pause, cancellation/version races and concurrent sweeps. No Discord login or paid API call was made.
