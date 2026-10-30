# Private confirmations

Vibe sends every required action preview and its **Approve / Reject** buttons to the dedicated private `#bot-confirmations` text channel. A command, addressed message, voice transcript or dashboard request receives only a location/status message. The exact input and approval controls remain in the staff channel.

Only a human guild member whose **highest role is strictly above Vibe’s current highest role** may approve or reject. Equal roles, administrator permission, server ownership and being the requester do not create exceptions. Discord administrators inherently bypass channel visibility overwrites, but they still cannot bypass this application-level role comparison.

## Setup

Create/restrict a dedicated private text channel, then set `CONFIRMATION_CHANNEL_ID` to its ID or use the configured `CONFIRMATION_CHANNEL_NAME` (default `bot-confirmations`). The approval policy resolves an existing channel and fails closed if it is missing or ambiguous. There is no fallback to a public channel, direct message or voice transcript channel.

The channel must deny `View Channel` to `@everyone`. Any explicit role grant of visibility must belong to a role strictly above Vibe; Vibe’s own managed bot role/member grant is permitted. Explicit member grants must belong to Vibe or an eligible senior human. Vibe needs `View Channel`, `Send Messages` and `Read Message History`. Reviewers need current view/history access. The channel and these grants are checked again when delivering and approving requests.

## Request and review

`CONFIRMATION_MODE=smart` executes ordinary changes requested directly through an admitted command or addressed chat/voice turn. Destructive actions, authority changes, host execution and selected external/account operations retain one exact preview. `CONFIRMATION_MODE=always` requires previews for every write. Background jobs never acquire direct-user authorization merely by running during a conversation.

In the private confirmation channel, an eligible reviewer can press **Approve**, press **Reject**, use `/confirm id:ID`, or mention Vibe with **@Vibe confirm** / **@Vibe cancel** for the single pending request. **@Vibe confirm last** selects the newest request. Several pending requests require an explicit choice; one conversational response does not approve the entire server queue. Approval IDs are one-use and expire after the configured lifetime (normally two minutes).

The reviewer and requester are separate principals. Approval never replaces the requester with a more privileged member: Vibe reloads the original requester, checks the action’s current input schema, original channel, role/channel policy, user permissions, bot permissions and optional premium admission, then rechecks reviewer authority before claiming the request once. Lost requester access or a demoted reviewer prevents execution. Concurrent approvals cannot execute the same request twice. A failed or uncertain preview delivery invalidates that pending action rather than leaving an invisible approval available.

Private action results, including account links, operator sign-in URLs and private files, go only to the original requester’s DMs. Vibe sends that requester a placeholder DM before executing and rechecks both principals afterward. If their DMs are unavailable, no private action runs. Reviewers receive only a safe completion receipt. If result delivery fails after execution, Vibe reports that delivery failed and does not expose or automatically repeat the completed operation.

Unresolved approvals cannot survive a bot restart: the live requester/cancellation proof is deliberately not reconstructed from the persisted row. Submit the request again after a restart.

For an active voice request, its original cancellation/consent lease remains binding. Normal completion of the spoken response preserves the pending approval; stopping, revoking consent or cancelling the request invalidates its live authorization. A staff member cannot approve by speaking in voice or by replying in the transcript channel: review happens in `#bot-confirmations`.

## Plans and other interfaces

Staged approval chains retain their configured reviewer roles, independent human quorums, immutable plan hash and source-history access requirements. Chain review also requires the dedicated channel and above-Vibe authority. Every saved voter’s authority is checked again before future plan steps. The plan owner cannot count as an independent reviewer. Withdrawing one’s own saved vote remains a revocation, not approval of another operation.

One senior approval of an `ai.plan.step` preview covers the exact child action and normalized child input shown inside that preview. An internal one-use scope permits only that identical child; altered arguments, other actions or a second execution need a new private approval. It is not a general approval token.

The dashboard can submit requests and display their private-channel location, but it receives no approval ID, preview hash or exact input for those routed requests, and cannot approve/reject them through browser controls. Buttons, slash commands, natural-language approval and chain reviews all reach the same registry policy. Legacy synchronous cancellation is disabled while that policy is installed, so internal automatic-confirmation helpers cannot impersonate staff. Failed internal workflows can invalidate their own pending request using a private originating-context capability; copied input, another requester or a newly manufactured context cannot use it as a rejection endpoint.

Standalone registry instances used in tests or host extensions retain their original same-requester/same-channel behavior until the host installs a confirmation policy. Production Vibe installs the dedicated policy centrally in `createServices`; action inputs cannot disable it.
