# Own-application subscription roles

The membership module can map an eligible Discord application subscription SKU to an ordinary server role. This uses the bot's existing Discord connection to read its **own application's** SKU and entitlement endpoints. It needs no additional OAuth flow, provider account or secret.

This implementation does not create products, purchases, billing pages or monetization approval. A real eligible SKU must already exist in this application's Discord product setup. Product eligibility, purchases and live entitlement delivery remain unverified until configured and exercised on the actual application.

## Configure and review

`entitlement.roles.configure` requires an application owner or locally configured `OPERATOR_IDS` user who also currently has Manage Server and Manage Roles. The bot needs Manage Roles. Each mapping is one-to-one, with at most ten mappings per server:

```json
{
  "mappings": [{ "skuId": "123456789012345678", "roleId": "234567890123456789" }]
}
```

The [Discord SKU API](https://docs.discord.com/developers/resources/sku) identifies recurring subscription SKUs as type 5 and distinguishes individual-user access from guild-wide access with flags. The bot fetches the application's current SKUs and accepts only its own `Subscription` SKU with `UserSubscription`, optionally `Available`. Guild subscription flags, subscription groups, consumables, one-time products, foreign applications and unknown flags are rejected. Purchase availability is not required for an existing entitlement.

Roles must pass the shared ordinary-role allowlist: no managed/everyone roles, privileged or unknown permissions, and the role must be below both the configuring manager and bot. Each recipient must be a current human server member below the manager and bot. The shared hierarchy guard excludes the author themselves, server owner and bot as automated targets.

`entitlement.roles.policy` reads the current mapping/version. `entitlement.roles.grants` reads your own tracking and retry state; an operator manager can specify another `userId`. `entitlement.roles.sync` reconciles the caller by default, or a selected `userId` when requested by an operator manager. Role-changing actions use the normal confirmation flow.

Setting `{"mappings":[]}` removes the policy and cancels queued work. It leaves existing roles intact. Replacing a policy also cancels old queued work and freezes old-version ownership records. Those records require explicit review before automation resumes; changing a mapping does not silently remove previously granted roles.

`entitlement.roles.review` requires a current operator manager and a tracked role record:

```json
{ "userId": "345678901234567890", "roleId": "234567890123456789", "operation": "detach" }
```

- `detach` relinquishes automated ownership and cancels that user's queued reconciliation. It preserves the role and records manual takeover so subsequent automatic syncs skip it.
- `remove` explicitly removes a role with confirmed current bot ownership and then detaches it. This review is available after policy removal, while membership features remain enabled. Ambiguous, detached and already-removed records cannot authorize this removal.
- `resume` explicitly returns a tracked record to the current policy's matching SKU/role pair, then performs full fresh entitlement reconciliation. It can restore automation after a policy change/manual takeover. An ambiguous addition never becomes confirmed ownership merely through resume: a role still present is preserved, and an absent eligible role can be added again with confirmed success. A previously existing role without a bot record cannot be claimed through review.

## Entitlement verification and ownership

[Discord entitlements](https://docs.discord.com/developers/resources/entitlement) describe access to application products and expose user/application/SKU scope, deletion/consumption state and start/end dates. The module independently validates these fields instead of relying only on the SDK's `isActive()` helper. It accepts only individual-user `ApplicationSubscription` entitlements for the configured application/SKUs. Deleted, consumed, future-starting and ended records are inactive. Invalid/foreign records fail the whole read; they cannot establish absence and trigger a removal. Null start/end bounds are handled explicitly and may describe perpetual test entitlements; an accepted record is not proof of a paid purchase.

Every sync reads fresh API results filtered by user and the configured SKU IDs. Pagination starts with `after:"0"` and stays in that direction, validates progress and duplicate IDs, and must reach a page smaller than one hundred records within five pages. A saturated five-page result is incomplete and produces an error before any role changes. A failed or incomplete API read never revokes a role.

Only successful singular bot role additions establish automatic ownership. A role present before the bot's addition is preserved and never claimed. Fresh forced member fetches observe actual current roles on subsequent runs. Active records keep the owned role; a complete current read that proves no active matching entitlement can remove only the currently owned role under the same policy version.

Each grant/removal refreshes the configuring author's operator/manager authority, bot permissions, current target, role hierarchy and ordinary-role eligibility. It rechecks policy/job identity, membership module state and configured guild allowlist after awaited work, and evaluates timestamps against the current clock immediately before changing a role. Role changes use singular idempotent Discord role endpoints with a stable tracking ID in the audit reason. No entitlement is consumed or created.

An ambiguous role-add/remove failure leaves an `uncertain` record for explicit review; automation does not assume ownership or blindly repeat that mutation. A request already sent to Discord cannot be recalled. If it succeeds after policy withdrawal, confirmed provenance is retained for review and the withdrawn policy cannot authorize further work.

## Event hints, refresh and limits

Gateway entitlement create/update/delete observations only enqueue matching users. They never grant a role from the event payload. `observeEntitlementRoleEvent(client,store,event,options)` accepts the SDK entitlement object; `sweepEntitlementRoleTasks(client,store,now,options)` processes the queue and refreshes due tracked grants. Both share `EntitlementRoleOptions` with registration: `operatorIds`, `allowedGuildIds` and an optional injectable clock.

Owned grants schedule verification at most five minutes later, or at the next observed entitlement expiry when sooner. This allows renewal checks before removing an expired grant. Disabled/excluded servers pause work, and removed/version-changed policies cannot authorize old jobs. API failures retain roles, retry after one and then two minutes, and pause after the third failure; Gateway repetition cannot reset exhausted retries. An explicit confirmed sync can request a new attempt. Failed job metadata older than seven days is pruned.

There are at most two simultaneous reconciliations globally, one per user/server, five jobs per sweep, one hundred policy-bearing servers, one thousand queued/failed jobs (two hundred per server), and five thousand ownership/review records (five hundred per server). Each reconciliation/sweep checks a twenty-second admission deadline before starting more work; in-flight SDK requests use the client's Discord REST timeout. These bounds do not provide an entitlement refresh latency guarantee during outages or exhausted retries.

Tests use controlled SDK-shaped SKU/entitlement responses and real persistent-store behavior. They cover confirmation, permission/hierarchy races, SKU flags, active-date semantics, complete pagination, API failure preservation, expiry refresh, Gateway hints, policy cancellation/version changes, manual takeover, ambiguous writes and concurrency cleanup. No live Discord purchase, role mutation or authenticated entitlement call was performed during implementation.
