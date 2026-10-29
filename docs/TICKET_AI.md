# Ticket classification and approved routing

`ticket.ai.configure` enables future open-ticket classification with two to ten distinct approved category names. The manager needs Manage Server and current support staff authority (Moderate Members or the configured staff role). Every policy stores its author, origin channel, enablement time and immutable version. Blank OpenAI configuration leaves AI unavailable; ordinary support tickets still work.

The default sends only the bounded subject and returns a category label. Optional settings add:

- `includeContent:true`: up to `maximumMessages` recent readable messages (1–50, default 20), with a bounded 2,200-character source budget. Caller and bot must retain source visibility and readable history.
- `inferPriority:true` and `inferLocale:true`: strict priority (`low`, `normal`, `high`, `urgent`) and language-tag metadata. These are advisory unless priority application is separately approved.
- `applyPriority:true`: apply the inferred priority through the standard confirmed ticket updater. Private-thread tickets receive the corresponding metadata update. This setting requires priority inference.
- `routes:[{"category":"billing","categoryId":"DISCORD_CATEGORY_ID"}]`: apply an exact approved category mapping to channel tickets while preserving the ticket's private overwrites. Both manager and bot need Manage Channels in every selected category. Private threads receive classification metadata; Discord does not support moving an existing private thread into a server category.

The model cannot invent a route, change permissions or execute tools. Preferences, retained chat history and web search are disabled. Fresh staff/manager authority, source content, policy/version, feature epochs and source history access are checked before upload, after the model response, and before approved native changes. Changed or withdrawn work is discarded. Unknown or failed native updates are marked `review-required` and are never blindly retried.

Automatic processing covers channel tickets and assigned-staff private-thread tickets created after enablement. It makes at most one billed attempt per maintenance cycle using the configuring manager's AI allowance. Disabled support/AI pauses processing. A failed billed attempt is retained and not paid for again under the same policy version. Reconfiguring creates a new version and can make qualifying tickets eligible for a new attempt.

`ticket.ai.classify` accepts either `{"channelId":"..."}` or `{"threadTicketId":"24_HEX_CHARACTER_ID"}` for a separately confirmed manual request using that staff member's allowance, including older tickets. Thread tickets additionally require the staff member to be assigned to that private ticket. `ticket.ai.view` accepts the same reference and reports the label, priority/routing outcome and whether the source remains current. `ticket.ai.policy` shows the approved settings and quota owner.

Classification can be wrong. Labels, language/priority metadata, source IDs/hashes and application outcomes persist with support records; raw message content is not copied into the classification record. Protect SQLite/backups and apply the server's support retention process. See [channel tickets](SUPPORT.md) and [private-thread tickets](THREAD_TICKETS.md) for the underlying support workflows.
