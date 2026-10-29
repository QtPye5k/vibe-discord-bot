# Private support tickets

Configure `staffRoleId` and optionally `ticketCategoryId` with `community.configure`. A ticket owner can open one active ticket at a time. There are at most 500 active or unresolved creation requests per server. The bot needs Manage Channels and Manage Roles for creation, closure and archiving. Members with the configured staff role or Moderate Members permission are support staff; channel access is still required for ticket operations.

All mutations use the common expiring, requester/channel-bound confirmation flow. Ticket edits serialize per channel so two approvals cannot overwrite each other’s progress. Staff membership, requester membership, bot membership and channel access are refreshed during operations.

| Action              | Behavior                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ticket.open`       | Creates a text channel visible to its owner, configured support role and bot, with an explicit everyone deny. Stores a durable creation reservation before calling Discord.                                                                    |
| `ticket.status`     | Reads your active ticket or unresolved creation reservation. Staff may specify another member.                                                                                                                                                 |
| `ticket.reconcile`  | Resolves an uncertain creation against its exact reservation topic, or explicitly releases a verified unmatched reservation.                                                                                                                   |
| `ticket.list`       | Checks the 100 most recent owned or staff-managed records against a fresh channel list. Inaccessible/deleted channels are omitted. Owner responses omit internal priority/tags.                                                                |
| `ticket.claim`      | Claims an open unassigned ticket for the current staff member.                                                                                                                                                                                 |
| `ticket.transfer`   | Assigns an open ticket to another current human staff member with channel access, or clears its assignment with `assigneeId: null`. It does not grant channel permissions.                                                                     |
| `ticket.update`     | Staff set priority (`low`, `normal`, `high`, `urgent`) and up to ten distinct tags. Values stay in private metadata and are not posted to the ticket.                                                                                          |
| `ticket.category`   | Staff with Manage Channels move the channel to a visible category or no category. `lockPermissions: false` preserves explicit ticket overwrites instead of synchronizing category access.                                                      |
| `ticket.close`      | Owner or staff deny the owner channel posting and thread creation/posting, retain history and release the active ticket slot. Staff retain their existing access.                                                                              |
| `ticket.archive`    | Staff archive a closed ticket by additionally denying owner channel visibility. It retains the channel, history and staff access. It does not delete or globally lock the channel. Server owners and administrators bypass channel overwrites. |
| `ticket.rate`       | The owner submits one score from one to five and optional private feedback within thirty days after closure. Use `ticketId`, from another accessible channel if the ticket was archived. No direct messages are sent.                          |
| `ticket.feedback`   | Owner reads their feedback; staff can read another owner’s feedback only with current ticket access.                                                                                                                                           |
| `ticket.transcript` | Returns up to 100 recent messages and attachment links after checking current requester and bot history permissions. The response explicitly reports `partial: true`; it is not a complete transcript.                                         |

## Uncertain creation responses

A network error or HTTP timeout can occur after Discord creates a channel. The reservation stays in `needs-review`, preventing another creation request from silently producing a duplicate. A known rejected HTTP 4xx response, excluding HTTP 408, releases the reservation for a later user-requested retry. No automatic creation retries run.

Read `ticket.status` to obtain the reservation UUID. Inspect Discord and submit `ticket.reconcile` with that UUID and either:

- `outcome: "created"`, with the actual `channelId`. The channel must be visible and its exact topic must match the saved reservation, owner and subject.
- `outcome: "not-created"`, after support staff verify no channel was created. This requires a two-minute settling interval and a fresh channel scan with no exact match. A matching channel must be recovered instead of releasing its reservation.

Reconciliation refuses an operation still creating a channel in the current process. The maintenance sweep can recover an existing exact match after ten minutes. Zero matches or multiple matches leave the reservation in review; maintenance never automatically releases an uncertain request. A replaced reservation cannot be resurrected by an older sweep response.

Failed close/archive/category operations preserve their previous local metadata. Their permission/category edits are idempotent, so a later explicit retry can reconcile an ambiguous response without creating another channel. Completed Discord changes are not automatically rolled back.

## Validation

Tests use a real SQLite store and stub Discord transport. They cover duplicate prevention, rejected versus uncertain creation, durable recovery, active-operation conflicts, exact topic matching, staff/assignee checks, permission revocation, overwrite-preserving category moves, failure state preservation, archive permissions, metadata privacy and owner-only satisfaction windows. No live server changes occur in these tests.
