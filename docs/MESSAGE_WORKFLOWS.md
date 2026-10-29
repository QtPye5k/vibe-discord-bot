# Message workflows

These workflows are off until configured through confirmed actions. They respond in the source channel and preserve the author's message. They do not relay content between channels or edit member-authored messages.

## Automatic translation

1. A manager uses `translation.configure` to select a channel and target language.
2. Each author reads `translation.preferences` and explicitly enables `translation.consent` with that exact target language. A manager's configuration does not consent on behalf of members.
3. New messages from consenting authors can receive a same-channel translation reply. `translation.consent` with `enabled:false` withdraws consent for one channel; `translation.optout` withdraws it across the server.

Changing the translation policy invalidates all previous consent for that policy, including changes that retain the same language. Withdrawal or replacement of consent while AI is running prevents its finished response from being posted. These privacy actions remain available when the message-workflows module is paused; enabling new consent still requires both message workflows and AI to be enabled.

Only the current source message's text, target language and ordinary request context are sent to the configured OpenAI model. Translation runs as the actual author, with action tools and web search disabled. It uses an isolated scope, does not load private assistant history or saved preferences, and does not retain translation conversation history. Existing AI quotas, role access, provider availability and timeouts still apply. Attachments and earlier channel messages are not included.

Translation accepts at most 4,000 source characters and publishes at most 1,750 translated characters. It allows one active translation per server, two per bot store, and one provider request per author per server every 60 seconds. Busy or cooling-down messages are skipped, without a deferred queue. Bot, webhook and system messages are ignored. Source edits, deletion, revoked access, action-policy changes, manager authority loss, and module changes during provider work suppress the reply. Passive failures do not publish provider errors or private input.

## Explicit formatting

`formatter.configure` sets a channel prefix, defaulting to `!format`. An author requests formatting with one of these forms:

```text
!format code lang=js
const answer = 42;

!format list First item
2. Second item

!format quote Text to quote
Another line
```

Formatting is deterministic and uses no AI. Requests are limited to 1,700 content characters, thirty list/quote lines, and one reply per author per server every five seconds. Code requests reject embedded triple-backtick fences. The original message remains intact. Invalid explicit requests receive a short usage error in the same channel.

## Status panels

`statuspanel.create` sends one bot status message with its unique marker, then updates that exact message. `statuspanel.bind` explicitly binds an existing message authored by this bot; the next update replaces its content. A channel has at most one binding, with twenty bindings per server. Intervals range from 60 seconds to one hour. Content contains the panel title, bot name, Gateway latency, process uptime and update timestamp.

`statuspanel.list` shows active, failed and uncertain bindings. `statuspanel.remove` stops updates without deleting the Discord message and remains available while the module is paused. Updates require current Manage Server authority for the configuring manager, applicable action policy, source/destination access, and reading/posting permissions for both manager and bot. A changed status marker or changed initial bound-message content stops updates so another feature's message is preserved.

If a create request loses its HTTP response, the binding becomes `needs-review`. The scheduler never sends a replacement. Inspect the channel and use `statuspanel.reconcile` with the actual message ID; the message must be authored by this bot and contain the exact saved marker. A process restart during creation also leaves a binding that requires reconciliation. Removing an uncertain binding is an explicit decision to abandon it; it does not delete a message that may already exist.

Transient update failures retry with bounded exponential backoff and stop after five attempts. Permission and ownership failures stop immediately. Failed bindings remain visible. Sweeps process at most ten due panels and cannot overlap for one store. Panel edits can be repeated safely after a lost response, but Discord delivery is not guaranteed exactly once. Discord nonce deduplication does not provide permanent deduplication.

## Integration and retention

Register `registerMessageWorkflowActions(registry)`, route allowed `messageCreate` messages to `handleMessageWorkflow(message,store,ai,allowedGuildIds)`, and call `sweepMessageWorkflowTasks(client,store,now,allowedGuildIds)` from maintenance. Empty allowed-server lists mean unrestricted server selection. Source reads use fresh member/channel/message fetches and require current Read Message History. Private-thread membership remains enforced by shared channel permissions. The `core.featureEpochs` written by `system.features` invalidate work even when an operator disables and re-enables a category before the request completes.

SQLite retains channel policy, author consent and panel metadata rather than source message text or translated text. Formatting and translation cooldown metadata is removed after one day. Panel state remains until explicitly removed. Common confirmed actions and current Discord permissions still apply. Offline tests cover consent, privacy isolation options, concurrency, role/policy/module changes, source changes, ownership conflicts, uncertain creation, reconciliation and bounded retries; they do not prove live model quality or Discord delivery.
