# Interactive panels and forms

The `interfaces` module adds persistent member interfaces. Use `/schema` to inspect exact fields and `/action` to request an action. Publication, role grants, settings changes, votes and final form submission use the common expiring confirmation workflow. Buttons continue working after restart because definitions, panel IDs and form drafts live in SQLite.

## Role and ticket panels

Approve ordinary roles with `community.configure` and its `selfRoleIds` first. `ui.roles.publish` posts a dropdown for up to 25 approved roles and individual buttons for the first five. Members select up to five roles to toggle; each specific add/remove proposal requires confirmation. The existing self-service action checks the current allowlist and role privileges again when confirmed. Publishing a panel cannot turn a privileged role into a self-service role.

`ui.ticket.publish` posts an Open a ticket button. Clicking it immediately opens a subject modal. Submission proposes the existing `ticket.open` action for that person; the existing one-active-ticket reservation, staff role and permission-overwrite rules apply. Configure `community.configure staffRoleId` and optionally `ticketCategoryId` first.

## Applications, recruitment, surveys and quizzes

`form.create` creates or updates a definition. `purpose` can be `application`, `recruitment`, `survey` or `quiz`. Forms have up to 20 fields, divided into steps of at most five components. Supported field kinds are short text, paragraphs, radio groups, checkboxes, checkbox groups, string selects, user selects, role selects, channel selects, mentionable selects and file uploads. Every component has an input label and can have a description. Choice fields require distinct value options. Uploaded file metadata is stored rather than downloading arbitrary files; files must be Discord attachments at most 8 MiB each. Attachment links can expire and are not permanent archival storage.

For example:

```json
{
  "id": "recruitment",
  "title": "Join the team",
  "purpose": "recruitment",
  "description": "Applications are reviewed privately.",
  "staffRoleId": "YOUR_REVIEWER_ROLE_ID",
  "fields": [
    { "id": "name", "label": "Preferred name", "kind": "short" },
    { "id": "experience", "label": "Relevant experience", "kind": "paragraph" },
    {
      "id": "availability",
      "label": "Availability",
      "kind": "radio",
      "options": [
        { "label": "Weekdays", "value": "weekdays" },
        { "label": "Weekends", "value": "weekends" }
      ]
    },
    { "id": "rules", "label": "I accept the server rules", "kind": "checkbox" }
  ]
}
```

Replace the role placeholder with an actual server role ID. Without `staffRoleId`, Manage Server permission is required to review. Optional review notifications use `reviewChannelId`, which must be hidden from everyone; notifications include submission metadata, never submitted answers.

Publish the definition with `form.publish`. The member's draft is private, bound to their account, server and originating channel, and expires 20 minutes after starting. A member can have two active drafts; a server can have 100. Out-of-order and repeated steps are rejected. Updating a definition invalidates older drafts. The final step shows the member their collected answers and requests common action confirmation; staff cannot see an unconfirmed draft.

`form.drafts`, `form.draft` and `form.draft-cancel` manage personal drafts. `form.mine` shows the member their submitted data and status without private staff notes. Reviewers use `form.responses`, `form.response`, `form.review` and `form.export`. CSV output neutralizes spreadsheet formulas. Updating a form's reviewer role immediately applies to existing responses. Deleting a form definition invalidates drafts; existing individual responses retain their previous reviewer role for historical access. Export responses before deleting their definition.

Quiz definitions can include `answerKey`, keyed by field ID, with string, Boolean or string-array expected answers. Text comparisons trim whitespace and ignore case; multi-select grading ignores order. Selector/file fields are not auto-graded. Scores are returned on confirmed submission and saved with the response; answer keys are excluded from public listings and member response data. Configure answer keys only for a form with `purpose: "quiz"`. Manual staff review is also available.

Forms default to one submission per member and allow up to ten when configured. Each server retains at most 5,000 submissions. Reviewers can export and delete individual responses. Members can erase their own drafts and responses with `form.erase-own`. No identity verification, external CAPTCHA, notification email or automatic recruitment hiring is implied by submitting a form.

### Identity hidden from reviewers

Forms are identified by default. A manager can set `anonymous: true` on `form.create` for private submissions whose automatic author metadata is hidden in normal staff review and CSV export. This is an explicit **anonymous-to-reviewers** mode. It does not post anonymous public messages or promise anonymity from Discord, the hosting operator or someone who can inspect internal storage.

The public form definition/panel and final private confirmation show this disclosure before approval: “Identity is hidden in normal staff review/export; bot operators can access audit/internal records.” They also warn that answers, uploaded files, timestamps and action-audit timing can identify or correlate with the author. User selectors, names, attachment filenames/contents and self-identifying answers remain as supplied; the bot does not claim to anonymize those contents.

The normal final-step interface includes `anonymousDisclosureAccepted: true` in the exact submission confirmation. When submitting a completed draft through `/action` directly, inspect `form.draft` or the action schema, review the disclosure and explicitly include that acknowledgement. An anonymous submission without it is rejected before storing answers for staff. Identified forms continue accepting their existing submission input.

Each submitted record retains its original privacy choice. Changing a form to identified mode, deleting it or recreating its definition cannot reveal an earlier anonymous author. Already identified submissions keep their original author metadata; enabling anonymous mode applies to new confirmed submissions. Updating any definition still invalidates old drafts through the existing revision check.

For anonymous records, `form.response`, `form.responses`, `form.mine`, reviewer decisions and optional notification messages omit the automatic owner ID. CSV uses a clearly marked hidden-identity value. All reviewer result paths select allowed output fields instead of returning the raw stored record, including requests routed through AI tools or the operator dashboard. Normal views stay redacted for server managers and operators as well; there is no identity-reveal action.

The bot retains the internal owner ID to enforce submission quotas, prevent self-review and allow personal erasure. Common registry confirmations still belong to the actual submitting account. Shared action-audit records for **all** `form.submit` requests use `private-submission` for pending/success/failure actor identity, while identified forms continue showing the author in their normal form views. This prevents a normal server audit export from directly disclosing an anonymous submitter, but timing and other activity may still correlate. Host database access, backups and Discord interaction metadata remain outside the reviewer-redaction contract.

Current reviewer roles are still checked for response reads, exports, decisions and deletion. `form.erase-own` finds the retained internal owner ID and removes only that person's drafts/submissions, including anonymous records, while other members' records remain intact. Anonymous mode does not bypass review permissions, quotas, exact confirmation or file/input limits.

## Acknowledgement verification

Use `verification.configure` with a safe ordinary role and rules text, then `verification.publish`. Completion explicitly acknowledges the policy and proposes a verified role assignment. The role is checked again for privilege changes and bot hierarchy. Optional minimum account age and membership age are checked on completion; native Discord membership screening must already be finished. `verification.status` shows the member's record. This workflow is rule acknowledgement, not proof of a real person or external account ownership.

## Suggestions and staff controls

`suggestion.configure` selects a channel. `suggestion.submit` posts voting buttons, with a limit of five proposals per member per day. A member has one mutable support/opposition vote per suggestion; approval confirms a concrete vote. `suggestion.review` records an acceptance or denial and staff note, closes voting and updates the bot-owned message. Visibility and channel moderation authority are checked again. `suggestion.list` supplies query filtering and pagination; `suggestion.delete` permits authorized cleanup. Suggestion content and vote records persist. If Discord cannot update a display, the returned result reports `displayUpdated: false` while retaining the authoritative vote/decision.

`ui.settings.publish` posts a settings menu for XP, FAQ and custom antispam. Its buttons propose `community.configure` changes and require Manage Server permission. `ui.moderation.publish` posts a staff dashboard that opens private report/case queues and rechecks moderation authority. Buttons do not grant access merely because a person can see the panel.

## Styled announcements

`ui.message.publish` sends a real Components V2 container with text, optional thumbnail, media gallery, separators, attached file components and HTTPS link buttons. Media URLs must be Discord attachment URLs. At most three file attachments totaling 8 MiB are downloaded through the bounded shared downloader. A premium purchase button can be rendered only for an existing SKU belonging to this application; actual purchases still require Discord's monetization configuration and eligibility. A purchase button does not create a SKU or subscription.

## Router integration

The module exports `registerInterfaceActions(registry)` and `handleInterfaceInteraction(interaction, contextOrFactory, registry, store?)`. The application routes all message-component interactions and modal submissions through the handler before its generic defer logic. The handler returns false for non-`ui:` custom IDs. With a lazy context factory, pass Store as the fourth argument: public modal presentation uses persisted configuration before Discord network reads, while submitted work defers privately before fresh authorization. Common registry confirmation buttons remain handled by the application's existing confirmation router.

The `interfaces` feature toggle gates panels and new form work; personal erasure should remain available as a registry privacy exception. No live Discord validation was performed while implementing this module. All component structures serialize through the installed Discord builders, and tests cover the local handlers, role privacy boundaries, quotas, typed inputs, session replay and confirmation behavior.
