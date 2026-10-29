# Optional premium offerings

Leave `PREMIUM_POLICY_FILE` blank to keep premium billing features off. The bot does not require another payment API key. If you want to sell premium features, complete your application's monetization eligibility and offering setup in the Discord Developer Portal, save the policy below as `config/premium.json`, replace the example SKU IDs with your own, set `PREMIUM_POLICY_FILE=config/premium.json`, and restart the bot. Relative paths resolve inside the portable project folder.

The policy is an operator-owned local file, limited to 64 KiB. It is parsed once at startup with a strict schema. Invalid configuration is reported through `premium.configuration` without crashing the bot; action authorization fails closed until the host repairs the configured policy. An empty environment field leaves ordinary actions unrestricted. Optional premium actions disappear from discovery while unconfigured.

## Example policy

These IDs are placeholders. Use existing action IDs from the bot's action catalog. An action listed in any product's `actions` requires at least one active matching product; unlisted actions retain their existing access rules.

```json
{
  "version": 1,
  "allowTestEntitlements": false,
  "storeDescription": "Optional upgrades for additional AI requests and customization.",
  "termsUrl": "https://example.com/terms",
  "privacyUrl": "https://example.com/privacy",
  "billingSupportUrl": "https://example.com/support",
  "products": [
    {
      "id": "plus",
      "skuId": "111111111111111111",
      "name": "Plus",
      "description": "Higher daily AI allowance, image generation and a gold dashboard theme.",
      "kind": "subscription",
      "scope": "user",
      "actions": ["ai.image", "ai.image.edit"],
      "commandLimits": { "ai.image": 20, "ai.image.edit": 20 },
      "aiUserDailyLimit": 100,
      "themes": ["gold"],
      "interfaces": ["compact"]
    },
    {
      "id": "image_credits",
      "skuId": "222222222222222222",
      "name": "Image credits",
      "kind": "consumable",
      "scope": "user",
      "actions": ["ai.image", "ai.image.edit"],
      "credits": 10,
      "creditsPerAction": 1
    }
  ],
  "themes": [
    {
      "id": "gold",
      "name": "Gold",
      "background": "#101010",
      "foreground": "#ffffff",
      "accent": "#d4af37"
    }
  ],
  "interfaces": [
    {
      "id": "compact",
      "name": "Compact",
      "compact": true,
      "showAnalytics": true
    }
  ]
}
```

Remove optional website fields you do not use. `supportChannelId` may identify a private staff channel in the current guild for case notifications. Notifications contain the case ID and category; the customer conversation stays in the private case store. A public destination is refused, and an uncertain notification is not sent repeatedly.

## Products and access

`kind` accepts `subscription`, `durable`, or `consumable`. A durable product grants benefits while Discord reports a valid purchase. A subscription can grant a purchasing user access across servers (`scope: "user"`) or all current members of one entitled server (`scope: "guild"`). Configure either user or guild subscription SKUs for one application, consistent with Discord's available offering model. Consumables require user scope and a positive `credits` value; they provide metered action credits rather than passive AI/theme/interface benefits.

`commandLimits` sets attempts per action and member per UTC day. User-product allowances follow the member across servers; guild-product allowances apply in the entitled server. The bot checks subscription/durable offerings before spending consumable credits and uses another eligible product when a preferred allowance is exhausted. Multiple active plans do not add their quotas together. Daily limits reset at 00:00 UTC. Requests that only preview a confirmation consume no allowance. Execution reserves an attempt atomically immediately before the action runs. Failures and interrupted attempts remain recorded rather than being silently retried or credited; the support restoration flow below handles reviewed consumable failures.

`aiUserDailyLimit` and guild-scoped `aiGuildDailyLimit` supply plan allowances to the existing AI limiter. Existing concurrency and server authorization still apply. Themes accept only six-digit hexadecimal colors. Interfaces support `compact` and `showAnalytics`; these settings are applied by the bot's dashboard. Access expiration, deletion, refund or module disablement removes passive benefits and falls back to the standard interface. Saved selections never grant access by themselves.

Native Activity admission and mutations fetch current access. Read polling can reuse a five-second entitlement and appearance lease, invalidated immediately by observed entitlement/subscription changes or premium module changes. Subscription or durable products provide continuous native Activity access; consumable products cannot gate `activity.launch` because a spent admission credit would not authorize later polling.

Every paid request re-fetches the application's SKU catalog and the member/server's entitlements. SKU type, flags, application, ownership, validity and consumed state must match the configured product. Pagination must complete within 1,000 records per scope; incomplete inventories are rejected. A grant expires after 15 seconds and is bound to the action, member, guild, policy revision and module epoch. Subscription lifecycle status is used for reporting, while entitlements determine access. Test-mode purchases are excluded unless `allowTestEntitlements` is explicitly enabled for testing. Discord permissions and the bot's ordinary confirmation rules continue to apply.

System, premium and privacy recovery actions cannot be paywalled. `premium.configuration`, analytics, staff support and credit restoration require an application operator. A guild administrator does not automatically become an application billing operator.

## User and operator actions

| Action                                            | Purpose                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `premium.configuration`                           | Operator checks configuration state and opens the app's Portal setup link.                                              |
| `premium.catalog`                                 | Read configured benefits, verified SKU metadata and store/terms/privacy links.                                          |
| `premium.purchase`                                | Show the exact SKU's native Discord premium button. Discord handles checkout and its price/terms.                       |
| `premium.status`                                  | Read current entitlements, unlocked options and remaining consumed-purchase credits.                                    |
| `premium.claim`                                   | Confirm conversion of one owned, unconsumed consumable entitlement into in-bot credits.                                 |
| `premium.claim-review`                            | Reconcile an ambiguous consumption from fresh Discord proof or explicitly review retry of a proved unconsumed purchase. |
| `premium.theme.set` / `premium.interface.set`     | Confirm an unlocked appearance choice; use `null` to clear it.                                                          |
| `premium.subscriptions`                           | Read the caller's paginated subscription periods, renewal status and cancellation time for an offering.                 |
| `premium.usage`                                   | Read retained personal command-attempt outcomes.                                                                        |
| `premium.analytics`                               | Operator reads observed attempt, claim, lifecycle and support counts.                                                   |
| `premium.support.open` / `premium.support.mine`   | Open and follow a private account or billing support case.                                                              |
| `premium.support.queue` / `premium.support.reply` | Operators review, reply and resolve; customers may reply only to their own cases.                                       |
| `premium.support.restore-credits`                 | Confirm exact in-bot credit restoration for a reviewed failed/interrupted attempt tied to its customer's support case.  |

Consumable claims are durable, globally unique per entitlement, and shared across servers for that purchasing user. Claim state is saved before the remote consumption request. Unknown outcomes become `uncertain`; the bot never assumes failure or automatically repeats consumption. `premium.claim-review` accepts `outcome: "grant-consumed"` only when Discord proves the current purchase consumed. `outcome: "retry-unconsumed"` is a separate confirmed action requiring fresh unconsumed proof. In-flight requests cannot be reconciled concurrently. Refunded, deleted, expired or foreign purchases cannot supply credits. Existing purchased credit quantities survive cosmetic policy edits; changing a future pack size does not rewrite prior purchases.

For a failed or interrupted paid attempt, an operator first reviews the remote operation and opens the customer's support case. `premium.support.restore-credits` requires `caseId`, the retained 24-character `usageId`, `remoteStateReviewed: true` and a reason. It restores the exact original debit once, checks the original consumed purchase is still valid, records the staff decision in the case, and cannot mint credits for successful, refunded or unrelated purchases. This is an in-bot credit correction; Discord monetary refunds and invoices remain with Discord's billing support.

Usage and observed lifecycle events are retained for 90 days. An attempt interrupted for over ten minutes becomes `unknown`; an unfinished consumption becomes `uncertain`. Claims retain purchase/debit provenance to prevent duplicate use. Event records store allowlisted IDs, state and lifecycle timestamps, with stable snapshot deduplication. Analytics describes events actually observed by this deployment, not complete payment history or inferred revenue. Support is limited to five open cases per member, fifty messages per case and 5,000 retained cases; it never requests passwords or card information.

## Platform setup and validation

Creating/publishing offerings, choosing prices, configuring benefits and store presentation, eligibility/discovery review, payout onboarding, legal terms and monetary billing support use Discord's Developer Portal and account workflows. The bot supplies policy configuration, native purchase opportunities, entitlement enforcement, lifecycle reporting and customer support. It does not claim those account-specific setup steps are completed by adding an environment field.

The implemented platform contract follows Discord's official [SKU resource](https://docs.discord.com/developers/resources/sku), [entitlement resource](https://docs.discord.com/developers/resources/entitlement), [subscription resource](https://docs.discord.com/developers/resources/subscription), [subscription guide](https://docs.discord.com/developers/monetization/implementing-app-subscriptions), and [SKU management guide](https://docs.discord.com/developers/monetization/managing-skus).

Run `pnpm exec tsx --test test/premium.test.ts` for fixture acceptance tests. They cover blank/invalid configuration, fresh entitlements, SKU/owner/scope isolation, expiry and confirmation, pagination, cross-server quotas, durable appearance, native purchase components, consumable races and ambiguous outcomes, finite credit accounting, refunds, support isolation, restoration and retained analytics. No test initiates a real purchase, changes payout settings, consumes a live entitlement or needs a payment credential. After choosing actual SKUs, use a separate test deployment with `allowTestEntitlements: true` and Discord test entitlements to validate your own offering configuration before publishing it.
