# Membership and rejoin consent

The membership module supports consented restoration of manager-approved ordinary roles. It needs the Members intent enabled in both the Portal and `.env` for departure/rejoin events.

1. A manager runs `membership.roles.configure` with up to 25 `roleIds`, then confirms. Both Manage Server and Manage Roles are required. Managed, privileged and unmanageable roles are rejected.
2. A member runs `membership.roles.consent` with `enabled:true`, then confirms. Only approved roles that member holds are saved; departure events refresh that selection.
3. On rejoin, a durable task restores the saved intersection with the current policy. It checks the member's continuing consent, policy version, configuring manager's current authority, channel access, role safety and hierarchy. Up to ten due tasks are handled per sweep, with at most three attempts.

`membership.roles.view` shows the caller's saved consent and restoration result. `membership.roles.consent` with `enabled:false` deletes saved roles and pending restoration. It remains possible to withdraw when membership features are disabled. Disabling the module pauses restoration. Reconfiguring approved roles changes the policy version and invalidates old pending work; no elevated or unrelated role is inferred.

Finished restoration records expire after seven days; opted-in saved roles persist until withdrawal. Restoration failures caused by changed permissions or hierarchy require manager review. This workflow restores selected role assignments, not a complete member profile.

## Requested onboarding DM

A manager can set a text template with `membership.onboarding.configure`; `{server}` and `{user}` are substituted without enabling mention notifications. The member must first approve personal DMs through `notification.subscribe`, then request `membership.onboarding.start` and confirm it. Consent identity and feature epochs are checked again after DM creation; withdrawal/reapproval or a relevant module toggle cancels the old request. A join event does not automatically initiate an unsolicited DM. Use `STOP` in the bot's DMs to withdraw personal notification consent.

Subscription/entitlement role assignment uses the separate [entitlement-role guide](ENTITLEMENT_ROLES.md), including application SKU eligibility and ownership rules.
