# Streamlined confirmations

`CONFIRMATION_MODE=smart` runs ordinary changes requested directly through an admitted command or addressed chat/voice turn without a second approval. Joining voice, explicitly granting your own voice consent, creating an event and renaming the server can therefore complete from the request itself. Each action still validates its inputs, the requester's current permissions, bot permissions, module policies and optional premium access.

Destructive changes, permission/authority changes, host task execution, external email/SMS, DNS updates and selected account grants retain one exact preview. Say **confirm**, **yes**, **do it** or **go ahead** in that same conversation to approve the real pending preview. Say **cancel** to withdraw it. Several previews displayed in one assistant turn can be approved with one response; execution still rechecks each operation, and a failure does not blindly retry completed work.

If there is no pending change, Vibe says so. It does not treat a model-written description as an executable preview. If several unrelated changes are pending, say **confirm last** or use `/confirm id:ID` for the intended one. Preview ownership stays bound to the same person, server and channel, with a limited lifetime. Changed or expired displayed arguments require a fresh request. Ordinary conversation is not interpreted as a general approval.

`CONFIRMATION_MODE=always` retains the original preview-first behavior for every write. Background policies and jobs never acquire smart-mode user authorization merely because they run at the same time as a conversation. A direct-request marker is created only at the admitted user entry point, survives current authorization refreshes, expires after five minutes and is omitted from serialized jobs/action inputs.

For voice, these confirmations are additionally subject to the active name-triggered conversation and speaker's consent. Unrelated background speech cannot select another member's preview. Private transcript-channel rules and recording consent remain separate from action approval.
