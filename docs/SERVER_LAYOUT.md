# Server layouts, snapshots and templates

The `layouts` module provides 13 actions for configuration snapshots, JSON exports, differences, configuration reports, declarative channel/role layouts, public Discord template imports and incremental restoration. All require Manage Server, Manage Roles and Manage Channels for the requester and bot. These permissions must exist at server level; a channel overwrite cannot substitute for them.

## Prepare and review a layout

Run `layout.plan` through `/action` with a label and a layout. Preparation saves a local immutable plan and does not change Discord resources.

```json
{
  "label": "Project community",
  "layout": {
    "roles": [{ "key": "member", "name": "Member", "permissions": "1024" }],
    "channels": [
      { "key": "projects", "name": "Projects", "type": "category" },
      {
        "key": "chat",
        "name": "project-chat",
        "type": "text",
        "parentRef": "projects",
        "overwrites": [{ "roleRef": "member", "allow": "1024" }]
      }
    ]
  }
}
```

Read the full result and copy the exact `nextBatch` object into `layout.apply`. The ordinary confirmation must be approved before execution. A batch contains at most ten operations. Read `layout.status` for the next batch and continue until its state is `done`. Modified, shortened, reordered and previously consumed batches are rejected.

Roles are processed first, then categories, child channels and selected server settings. References connect newly created resources without guessing names. An `existingId` edits that exact resource; an ID confirmed deleted is recreated. Other fetch failures stop preparation. Existing resources with duplicate names are never chosen automatically, and unrelated resources are preserved.

Supported channels are text, voice, category, announcement, stage, forum and media. Each plan allows up to 100 roles, 100 channels and one server settings operation. Channels support parent references, positions, applicable topics, age restrictions, slow mode, voice bitrate/user limits and explicit role/member permission overwrites. Layout restoration replaces the reviewed overwrite list on each edited channel. It does not merge individual overwrites. Roles support basic colors, permissions, hoisting, mentions and positions. Everyone base permissions and managed roles are excluded.

Every operation refreshes requester/bot membership, server permissions and access to the invocation channel. Affected channels, overwrite targets, permission grants and role hierarchy are checked again when used. Grants and denials cannot exceed permissions held by both requester and bot. Role positions must stay below both, with the usual server owner exception for requester hierarchy. Discord feature availability, boost limits and remaining server capacity still apply.

## Snapshots and recovery

Use `layout.snapshot.save` with a short name, then `layout.snapshot.list`, `layout.snapshot.export` or `layout.snapshot.diff`. There are at most 20 stored snapshots per server. Snapshots capture supported channels visible to both requester and bot, ordinary roles, overwrites and selected server settings. Export and difference actions recheck access to captured channels that still exist. JSON exports contain configuration and IDs; they contain no credentials or message history.

`layout.restore.plan` prepares merge/recreate operations from a saved snapshot. An ordinary role above the bot or requester can be captured for reporting but cannot be edited by restoration; use a scoped declarative layout for resources the bot can manage. References to managed-role overwrites can require an already existing role in the target server. `layout.template.plan` prepares a public template's supported topology in the current server, maps template placeholder IDs and rejects member overwrites that cannot be mapped to target-server accounts. It does not create a server.

Snapshots exclude messages, files, member assignments, threads, managed resources, everyone base permissions, expressions, integrations, entitlements, invites, server images, role icons/enhanced colors and forum tags. Recreated resources receive new Discord IDs. A configuration snapshot is not a complete server backup.

## Interrupted batches

Batches are incremental. Completed operations stay applied if a later operation fails. Each operation is marked in flight before authorization or network work. Concurrent approvals cannot claim the same batch. Module disabling or permission/access loss stops subsequent operations.

A failed response may arrive after Discord applied a mutation. The plan stops in `needs-review`, records its progress and does not automatically retry. After inspecting Discord, use `layout.reconcile` with the exact operation index and either:

- `outcome: "applied"` and the actual role/channel ID. The bot checks the supplied resource's identity, access, basic configuration and hierarchy before advancing.
- `outcome: "not-applied"` only after verifying that Discord did not apply the operation. This permits a later explicitly confirmed retry.

Reconciliation also handles persisted `applying` states after a process restart. It refuses operations still active in this process. `layout.abort` stops a plan without rolling back changes. Plans expire after 24 hours; status, reconciliation and abort remain available afterward, but further application requires a fresh plan. There are at most 20 active plans per server, and completed/aborted plans older than seven days are pruned when another plan is prepared.

## Validation

The focused tests exercise immutable payload review, multi-batch progress, one-use confirmation, concurrent claim protection, membership/permission/channel revocation, module disabling, hierarchy/grant limits, ambiguous response reconciliation, process interruption, deleted-channel recreation, snapshot privacy, explicit null settings and template reference mapping. They use real SQLite persistence and stub Discord transport. They do not change a live server.

Channel limits follow the [official Discord channel API documentation](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx).
