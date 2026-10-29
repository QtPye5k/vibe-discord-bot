import { registerNativeCapabilityReviews } from './capability-review-native.js';
/** Explicit review of the 297 previously partial, external, missing or alternative requirements.
 * Bounds, permissions, consent and pagination are part of the supported contract, not missing features.
 * A code-complete optional adapter is distinct from an activated, live-tested account integration.
 */
export type CapabilityStatus =
  | 'implemented'
  | 'partial'
  | 'external_setup'
  | 'unimplemented'
  | 'architectural_alternative'
  | 'resolved_architecture';
export interface CapabilityEvidence {
  sourceFiles: string[];
  testFiles: string[];
  configuration: string[];
  operatorSetup: string[];
}
export interface ReviewedCoverage {
  status: CapabilityStatus;
  actionIds: string[];
  entryPoints: string[];
  notes: string;
  evidence: CapabilityEvidence;
  architectureDecision?: { selected: string; resolution: string };
}
export const reviewedCoverage = new Map<string, ReviewedCoverage>();
function review(
  ids: string,
  actions: string,
  sources: string,
  tests: string,
  notes: string,
  configuration: string[] = [],
  status: CapabilityStatus = 'implemented',
  operatorSetup: string[] = [],
): void {
  for (const id of ids.split(' ')) {
    if (reviewedCoverage.has(id)) throw new Error(`Duplicate reviewed capability: ${id}`);
    reviewedCoverage.set(id, {
      status,
      actionIds: actions ? actions.split(' ') : [],
      entryPoints: sources ? sources.split(' ') : [],
      notes,
      evidence: {
        sourceFiles: sources ? sources.split(' ') : [],
        testFiles: tests ? tests.split(' ') : [],
        configuration,
        operatorSetup,
      },
    });
  }
}

review(
  's12-009',
  'image.filters',
  'src/features/media.ts src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Apply an actual ordered typed filter stack; materialize each step so repeated filters preserve their stated order.',
);
review(
  's12-010 s12-011',
  'image.background-remove ai.image.background-remove',
  'src/features/media.ts src/features/media-workflows.ts src/features/ai.ts',
  'test/media-workflows.test.ts test/ai-enhancements.test.ts',
  'Export real alpha PNG after deterministic edge-connected color-key removal, or explicitly request transparent PNG from the configured image-edit model for complex subjects.',
  ['OPENAI_API_KEY'],
);
review(
  's12-013',
  'ai.image.profile image.profile',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Generate a dedicated square profile concept using validated subject/style/palette, or bind an actual member profile to a themed card.',
  ['OPENAI_API_KEY'],
);
review(
  's12-014',
  'image.banner',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Render a themed banner directly from current guild identity and a reviewed subtitle.',
);
review(
  's12-016 s12-017',
  'image.welcome image.welcome.configure image.rank',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Bind current member/server identity and observed XP to personalized welcome/rank cards; optional manager-approved join policies automatically send welcome images with version/access checks and durable delivery claims.',
);
review(
  's12-018 s12-019',
  'chart.render',
  'src/features/media.ts src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Render actual bar, line, area, pie and scatter charts from validated bounded numeric data; pie requires a positive total.',
);
review(
  's12-020',
  'image.statistics analytics.chart',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Bind current member/boost counts and retained observed activity directly to server statistics images/charts.',
);
review(
  's12-026 s12-046',
  'file.extract file.hash ai.document.analyze',
  'src/features/files.ts src/features/ai-enhancements.ts',
  'test/files.test.ts test/ai-enhancements.test.ts',
  'Read/analyze supported text, CSV, DOCX, PPTX and XLSX content locally, with image/PDF model analysis available separately; preserve explicit format, size and extraction coverage limits without executing macros or external links.',
  ['OPENAI_API_KEY'],
);
review(
  's12-027 s12-028',
  'ai.document.analyze',
  'src/features/ai.ts src/features/ai-enhancements.ts',
  'test/ai.test.ts test/files.test.ts',
  'Use the actual supplied image/PDF input path for OCR-style text extraction and document analysis through the configured model, with quoted data and no administrative tools.',
  ['OPENAI_API_KEY'],
);
review(
  's12-031',
  'file.extract file.csv file.xlsx file.docx image.format',
  'src/features/files.ts src/features/media.ts',
  'test/files.test.ts test/media.test.ts',
  'Convert documented CSV/XLSX tables, supported document text/TXT/DOCX and raster PNG/JPEG/WebP/GIF formats into real files. The original bullet does not require every binary format or perfect arbitrary layout conversion.',
);
review(
  's12-042',
  'image.emoji.create',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Prepare an actual bounded transparent 128 px PNG and upload it via the fresh-authorized native emoji action after a reviewed workflow confirmation.',
);
review(
  's12-044',
  'media.soundboard.create',
  'src/features/media-workflows.ts src/features/audio-media.ts',
  'test/media-workflows.test.ts',
  'Prepare a selected audio segment up to five seconds as a size-bounded MP3, then call the native soundboard uploader with current expression permissions and a human confirmation.',
);
review(
  's12-045',
  'media.index.add media.duplicates media.index.remove',
  'src/features/media.ts src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Persist SHA-256 and 64-bit perceptual image hashes plus bounded metadata; filter duplicate/similar results by current source history access without storing media bytes.',
);
review(
  's15-008',
  'analytics.api analytics.commands',
  'src/features/api-metrics.ts src/features/ai.ts src/core/registry.ts',
  'test/ai-enhancements.test.ts test/security.test.ts',
  'Record provider/endpoint aggregate request/error counts and latency plus action failure metadata; store neither credentials nor request bodies.',
);
review(
  's15-012',
  'case.list security.logs analytics.commands',
  'src/features/moderation-cases.ts src/features/security.ts',
  'test/native-completion.test.ts test/security.test.ts',
  'Track successful supported bot punishments in the unified case journal and retained observed moderation events/audit counts, preserving gaps and unknown actors.',
);
review(
  's15-020',
  'analytics.chart',
  'src/features/media-workflows.ts',
  'test/media-workflows.test.ts',
  'Aggregate retained observed daily counters directly into a selected real chart type without manually copying values.',
);
review(
  's15-027',
  'dashboard.login',
  'src/features/dashboard.ts src/services/account-linking.ts',
  'test/dashboard.test.ts test/account-linking.test.ts',
  'Serve current authorized event-derived analytics and a schema-based action console through fixed short-lived authenticated dashboard sessions; public HTTPS and login setup remain deployment configuration.',
  ['ENABLE_DASHBOARD', 'DASHBOARD_BASE_URL', 'APP_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
);
review(
  's15-029',
  'analytics.workbook',
  'src/features/media-workflows.ts src/features/files.ts',
  'test/media-workflows.test.ts test/files.test.ts',
  'Export real observed-activity and API-request worksheets in one XLSX action, with actual retained data and current manager checks.',
);
review(
  's15-032',
  'website.analytics',
  'src/features/website-analytics.ts',
  'test/hosted-services.test.ts',
  'Query actual authenticated Plausible Stats API v2 visitor/visit/pageview, acquisition and goal/conversion aggregates for the fixed configured site, with strict metrics/date filters and fresh authority.',
  ['PLAUSIBLE_API_KEY', 'PLAUSIBLE_SITE_ID'],
);

const providerSource =
  'src/features/optional-integrations.ts src/integrations/credentials.ts src/integrations/http.ts';
const providerTests = 'test/optional-integrations.test.ts';
const google = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
review(
  's05-007 s05-036',
  'integration.security.url-report integration.security.scan-url integration.security.analysis',
  providerSource,
  providerTests,
  'Use actual VirusTotal URL reputation/submission/analysis endpoints through a fixed-origin credential-bound transport; provider quotas and explicit upload confirmation apply.',
  ['VIRUSTOTAL_API_KEY'],
);
review(
  's05-010',
  'integration.security.file-report integration.security.scan-file integration.security.analysis',
  providerSource,
  providerTests,
  'Look up SHA-256 malware reports or submit a selected bounded Discord attachment to VirusTotal after explicit review, then retrieve the actual analysis job.',
  ['VIRUSTOTAL_API_KEY'],
);
review(
  's05-033 s05-034',
  'verification.configure verification.captcha.start verification.complete',
  'src/services/captcha.ts src/features/interfaces.ts',
  'test/hosted-services.test.ts test/interfaces.test.ts',
  'Host an actual Turnstile verification page, bind challenge receipt to the current member/flow, validate hostname/action with Siteverify and require that receipt for configured verification.',
  ['APP_PUBLIC_URL', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_EXPECTED_HOSTNAME'],
);
review(
  's05-035',
  'oauth.start oauth.link.confirm oauth.identity',
  'src/services/account-linking.ts',
  'test/account-linking.test.ts',
  'Verify the requesting member’s real provider identity through bounded state/PKCE OAuth callbacks and exact Discord confirmation; retain encrypted account-owned grants and recheck revocation.',
  [
    'APP_PUBLIC_URL',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
  ],
);
review(
  's10-012 s14-028',
  'integration.google-calendar.events integration.google-calendar.event-create integration.google-calendar.event-update integration.google-calendar.event-remove integration.provider-watch.create',
  providerSource,
  providerTests,
  'Read, create, update and cancel authorized calendar appointments/interviews; durable calendar monitors synchronize selected external event metadata notifications using scope/account-bound credentials.',
  google,
);
review(
  's11-039',
  'integration.video.render integration.video.render-status',
  providerSource,
  providerTests,
  'Submit actual bounded Shotstack edit/render timelines and inspect the provider job/output URL. Stage and production keys, paid jobs and media rights remain account configuration.',
  ['SHOTSTACK_API_KEY', 'SHOTSTACK_ENVIRONMENT'],
);
review(
  's11-040',
  'integration.video.generate integration.video.image-generate integration.video.task integration.video.cancel',
  providerSource,
  providerTests,
  'Submit actual Runway text/image video generation jobs, retrieve task state/output and cancel an exact selected task after confirmation.',
  ['RUNWAY_API_KEY', 'RUNWAY_VIDEO_MODEL'],
);
review(
  's13-041 s15-033 s16-043 s16-044',
  'integration.steam.stats integration.steam.achievements',
  providerSource,
  providerTests,
  'Query actual authorized Steam player/game statistics and achievement records by explicit SteamID/AppID; inaccessible/private provider data is not invented.',
  ['STEAM_API_KEY'],
);
review(
  's16-001 s16-002',
  'integration.github.read',
  providerSource,
  providerTests,
  'Query authenticated GitHub repository metadata and selected commits/releases/issues/pull requests/workflow runs with fixed documented routes.',
  ['GITHUB_TOKEN'],
);
review(
  's16-003 s16-004 s16-005',
  'integration.github.read integration.provider-watch.create',
  providerSource,
  providerTests,
  'Poll actual authenticated GitHub release/pull-request/CI-run APIs using durable metadata baselines and deliver approved change notifications with unknown-send reconciliation.',
  ['GITHUB_TOKEN'],
);
review(
  's16-006',
  'integration.gitlab.project integration.gitlab.pipelines integration.gitlab.issue-create',
  providerSource,
  providerTests,
  'Connect to the configured trusted GitLab origin for authorized project/pipeline reads and confirmed issue creation.',
  ['GITLAB_TOKEN', 'GITLAB_BASE_URL'],
);
review(
  's16-007',
  'integration.github.issue-create integration.gitlab.issue-create integration.trello.card-create',
  providerSource,
  providerTests,
  'Integrate concrete selected development/task tools through typed authenticated routes and reviewed writes, rather than claiming arbitrary application automation.',
  ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'TRELLO_API_KEY', 'TRELLO_TOKEN'],
);
review(
  's16-008',
  'integration.google-calendar.events integration.google-calendar.event-create',
  providerSource,
  providerTests,
  'Use the actual Google Calendar API for accessible event listing and confirmed event creation with per-account scope enforcement.',
  google,
);
review(
  's16-009',
  'integration.google-sheets.read integration.google-sheets.write',
  providerSource,
  providerTests,
  'Read explicit authorized Sheets ranges and perform reviewed RAW range writes without formula evaluation; current owner/scopes/source access are rechecked.',
  google,
);
review(
  's16-010 s16-024',
  'integration.google-drive.files integration.google-drive.download integration.google-drive.export integration.google-drive.upload-text',
  providerSource,
  providerTests,
  'Find/download/export actual authorized Drive/cloud files and upload reviewed text documents; return bounded binary attachments and enforce exact granted account scopes.',
  google,
);
review(
  's16-011 s16-047',
  'integration.email.send integration.email.received',
  providerSource,
  providerTests,
  'Send reviewed plain-text messages through Resend and retrieve a selected received message by ID. The provider requires a verified sending/receiving domain.',
  ['RESEND_API_KEY', 'EMAIL_FROM'],
);
review(
  's16-012 s16-013 s16-014',
  'integration.trello.cards integration.trello.card-create integration.notion.data-source',
  providerSource,
  providerTests,
  'Read/create reviewed Trello task cards and query authorized Notion data sources through concrete current APIs.',
  ['TRELLO_API_KEY', 'TRELLO_TOKEN', 'NOTION_TOKEN'],
);
review(
  's16-015',
  'integration.notion.search integration.notion.data-source integration.notion.page-create',
  providerSource,
  providerTests,
  'Search pages shared with the Notion integration, query a current data source and create a reviewed child page with a pinned supported API version.',
  ['NOTION_TOKEN'],
);
review(
  's16-018',
  'database.queries database.query',
  'src/features/external-database.ts',
  'test/deployment-database-automation.test.ts',
  'Execute named operator-approved parameterized PostgreSQL reads in a read-only transaction, with restricted database role, deadlines, row/byte bounds and catalog/access rechecks.',
  ['EXTERNAL_DATABASE_URL', 'EXTERNAL_DATABASE_QUERIES_FILE'],
);
review(
  's16-019 s16-021',
  'integration.github.read integration.google-calendar.events integration.cloudflare.dns-update',
  providerSource,
  providerTests,
  'Send bounded authenticated REST requests through named fixed-origin adapters with validated routes/bodies and exact write confirmations; caller-selected credential destinations are prohibited.',
  ['GITHUB_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CLOUDFLARE_API_TOKEN'],
);
review(
  's16-020',
  'integration.graphql-get integration.shopify.products',
  'src/features/public-services.ts src/features/optional-integrations.ts',
  'test/public-services.test.ts test/optional-integrations.test.ts',
  'Query confirmed public GraphQL GET endpoints or the fixed authenticated Shopify product/variant GraphQL operation with separately encoded variables.',
  ['SHOPIFY_SHOP', 'SHOPIFY_ADMIN_TOKEN'],
);
review(
  's16-023',
  'webhook.create deployment.notifications.configure',
  'src/discord/actions/resources.ts src/features/external-automation.ts src/features/webhook-events.ts',
  'test/discord-actions.test.ts test/deployment-database-automation.test.ts test/webhook-events.test.ts',
  'Create authorized native Discord incoming webhooks and receive signed fixed-route deployment/outgoing Discord event payloads with replay/durable inbox controls.',
  ['DISCORD_PUBLIC_KEY', 'DEPLOYMENT_WEBHOOK_SECRET'],
);
review(
  's16-026',
  'integration.minecraft-status host.status',
  'src/features/public-services.ts src/features/remote-host.ts',
  'test/public-services.test.ts test/host-agent.test.ts',
  'Read actual approved Minecraft Java status or authenticated host telemetry; supported game/host protocols are explicit and do not imply every server type.',
  ['REMOTE_AGENT_URL', 'REMOTE_AGENT_KEY'],
);
review(
  's16-027 s16-028 s16-029',
  'host.status',
  'src/features/remote-host.ts src/host-agent/service.ts',
  'test/host-agent.test.ts',
  'Use a separately installed signed host agent to read authorized home/server/computer uptime, memory, load and task telemetry; shared-secret timestamp/nonces and current operator permission protect access.',
  ['REMOTE_AGENT_URL', 'REMOTE_AGENT_KEY', 'HOST_AGENT_KEY'],
);
review(
  's16-030',
  'webhook.create security.configure',
  'src/discord/actions/resources.ts src/features/security.ts',
  'test/discord-actions.test.ts test/security.test.ts',
  'Provide an authorized native Discord incoming webhook URL for an external security product’s alert destination and deliver configured local security findings. External products must be configured to send their alerts to that exact webhook.',
  [],
  'implemented',
  [
    'Configure the selected security product’s outgoing-alert destination with the generated channel webhook URL.',
  ],
);
review(
  's16-031',
  'deployment.notifications.configure deployment.notifications.list deployment.notifications.resolve',
  'src/features/external-automation.ts',
  'test/deployment-database-automation.test.ts',
  'Receive HMAC-signed deployment status notifications at a fixed endpoint, match approved project/environment routes and deliver with durable deduplication/unknown-outcome review.',
  ['DEPLOYMENT_WEBHOOK_SECRET'],
);
review(
  's16-034',
  'integration.currency',
  'src/features/public-services.ts',
  'test/public-services.test.ts',
  'Query actual dated Frankfurter financial currency-reference rates and bounded conversion estimates. The literal financial-API requirement does not require securities trading or private banking.',
);
review(
  's16-035 s16-036 s16-037',
  'integration.shopify.products integration.provider-watch.create',
  providerSource,
  providerTests,
  'Query actual authorized Shopify product/variant prices, availability and inventory and monitor selected changes with a durable baseline.',
  ['SHOPIFY_SHOP', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_VERSION'],
);
review(
  's16-038',
  'integration.mastodon.account integration.mastodon.posts integration.mastodon.post integration.provider-watch.create',
  providerSource,
  providerTests,
  'Read selected Mastodon account/posts, monitor metadata changes and publish reviewed text through the configured instance/account.',
  ['MASTODON_BASE_URL', 'MASTODON_ACCESS_TOKEN'],
);
review(
  's16-039 s16-042',
  'integration.youtube.channel integration.youtube.uploads integration.provider-watch.create',
  providerSource,
  providerTests,
  'Retrieve actual YouTube channel/statistics/uploads data and announce newly observed uploads through a reviewed durable monitor.',
  ['YOUTUBE_API_KEY'],
);
review(
  's16-040 s16-041',
  'integration.twitch.channel integration.twitch.streams integration.provider-watch.create',
  providerSource,
  providerTests,
  'Resolve actual Twitch channel/live-stream state with cached app authorization and announce meaningful live-status changes.',
  ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_ACCESS_TOKEN'],
);
review(
  's16-045',
  'integration.parcel.create integration.parcel.get integration.provider-watch.create',
  providerSource,
  providerTests,
  'Register an actual AfterShip carrier/tracking record, read shipping checkpoints and monitor approved status changes through the pinned provider API.',
  ['AFTERSHIP_API_KEY'],
);
review(
  's16-046',
  'integration.sms.send',
  providerSource,
  providerTests,
  'Send one reviewed message to an exact E.164 recipient through Twilio; a queued provider response is not proof of delivery.',
  ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
);
review(
  's16-050 s16-052 s16-053',
  'operation.run operation.tasks',
  'src/features/operations.ts',
  'test/operations.test.ts',
  'Run only operator-approved fixed executable/argument task definitions for the selected local application/service; supports explicitly staged start/stop tasks without a Discord shell or user-supplied paths/arguments.',
  ['LOCAL_OPERATIONS_MANIFEST', 'OPERATOR_IDS'],
);
review(
  's16-055',
  'integration.cloudflare.workers integration.cloudflare.dns-list integration.cloudflare.dns-update',
  providerSource,
  providerTests,
  'Manage supported authorized Cloudflare infrastructure through concrete Worker/DNS reads and exact reviewed DNS updates; token account/zone permissions remain provider-side.',
  ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
);
review(
  's16-056',
  'host.tasks host.run host.result host.acknowledge',
  'src/features/remote-host.ts src/host-agent/service.ts',
  'test/host-agent.test.ts',
  'Run exact fixed reviewed remote tasks through the signed host agent, with current operator access, bounded subprocesses and durable unknown-outcome acknowledgement rather than automatic retry.',
  ['REMOTE_AGENT_URL', 'REMOTE_AGENT_KEY', 'HOST_AGENT_MANIFEST'],
);

review(
  's01-006',
  'guild.system-flags',
  'src/discord/actions/guild.ts',
  'test/native-completion.test.ts',
  'Read and update the documented systemChannelFlags bitfield through the native guild editor.',
);
review(
  's01-009',
  'guild.community',
  'src/discord/actions/guild.ts',
  'test/native-completion.test.ts',
  'Enable/disable Community and bind its required rules/public-update channel fields with current server prerequisites.',
);
review(
  's01-011',
  'guild.onboarding-edit',
  'src/discord/actions/guild.ts',
  'test/native-completion.test.ts',
  'Replace validated onboarding prompts/options, including role/channel choices, with the supported native onboarding API.',
);
review(
  's01-020',
  'layout.template.plan layout.apply',
  'src/features/server-layout.ts',
  'test/server-layout.test.ts',
  'Convert the accessible supported role/channel topology of a Discord template into exact immutable merge operations; apply reviewed batches with fresh authority. Template payloads do not contain message history or managed resources.',
);
review(
  's01-023 s01-024',
  'layout.snapshot.save layout.snapshot.export layout.restore.plan layout.apply',
  'src/features/server-layout.ts',
  'test/server-layout.test.ts',
  'Save/export supported topology/settings snapshots and restore them through immutable merge/recreate plans. Each reviewed operation is journaled; interrupted effects require reconciliation.',
);
review(
  's01-026 s03-029',
  'security.configure security.logs security.baseline.compare',
  'src/features/security.ts',
  'test/security.test.ts',
  'Compare configured privilege/admin allowlists and observe supported administrative changes; dangerous role permissions produce findings. Missing/ambiguous audit actors remain explicitly unknown rather than inferred.',
);
review(
  's01-031',
  'layout.apply member.bulk-ban role.assign-many message.bulk-delete',
  'src/features/server-layout.ts src/discord/actions/members.ts src/discord/actions/messages.ts',
  'test/server-layout.test.ts test/discord-actions.test.ts',
  'Execute validated bounded batches for topology, roles, bans and eligible message deletion through exact confirmations and native hierarchy checks.',
);
review(
  's02-012 s02-032',
  'channel.edit thread.edit',
  'src/discord/actions/channels.ts',
  'test/native-completion.test.ts',
  'Edit documented channel/forum/thread metadata and forum default-post fields using typed native schemas and current permissions.',
);
review(
  's02-020 s02-021',
  'channel.lock channel.unlock',
  'src/discord/actions/channels.ts',
  'test/native-completion.test.ts',
  'Snapshot everyone plus ordinary role/member sending overwrites, deny intended send permissions, then restore the exact saved bits only while the current snapshot matches. Privileged/Administrator bypass is a Discord platform rule.',
);
review(
  's03-028',
  'member.permissions-compare',
  'src/discord/actions/members.ts',
  'test/native-completion.test.ts',
  'Compare a member’s effective permissions across selected currently accessible channels, including channel overwrite effects.',
);
review(
  's03-030',
  'security.configure security.logs',
  'src/features/security.ts',
  'test/security.test.ts',
  'An opt-in single privileged-role change creates an immediate staff alert, with best-effort audit attribution and explicit unknown actors.',
);
review(
  's03-031',
  'bot.linked-role.metadata oauth.linked-role.update',
  'src/features/identity.ts src/services/account-linking.ts',
  'test/identity.test.ts test/account-linking.test.ts',
  'Register the application metadata schema and update the requesting user’s own Linked Role connection using separately granted role_connections.write authorization.',
  ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'APP_PUBLIC_URL', 'OAUTH_ENCRYPTION_KEY'],
);
review(
  's04-018',
  'moderation.tempban moderation.tempbans moderation.tempban-revoke member.timeout',
  'src/features/temporary-bans.ts src/discord/actions/members.ts',
  'test/temporary-bans.test.ts test/discord-actions.test.ts',
  'Persist marked temporary-ban expiry/revocation and recheck exact native ban provenance before lifting it; communication timeouts expire natively. Unknown external state pauses recovery.',
);
review(
  's04-025 s04-028 s05-030',
  'case.list case.mine appeal.submit appeal.review',
  'src/features/moderation-cases.ts src/features/community.ts src/discord/actions/members.ts',
  'test/native-completion.test.ts test/community.test.ts',
  'Journal successful supported native punishments and warnings in the unified case history; case-linked appeals retain explicit staff review without assuming that an appeal automatically reverses a punishment.',
);
review(
  's04-026',
  'warning.configure warning.issue warning.jobs',
  'src/features/moderation.ts',
  'test/moderation.test.ts',
  'Configured warning thresholds/windows create durable bounded escalation work with fresh moderator/target/bot checks; explicitly approved penalties use the unified journal.',
);
review(
  's04-038 s04-039',
  'security.export analytics.commands system.audit case.list',
  'src/features/security.ts src/features/moderation-cases.ts',
  'test/security.test.ts test/native-completion.test.ts',
  'Export retained observed moderation/case/audit metadata and per-moderator action counts. Retention gaps and missing historical actors are disclosed.',
);
review(
  's04-040',
  'analytics.activity member.prune-count',
  'src/features/security.ts src/discord/actions/members.ts',
  'test/security.test.ts test/guild-prune.test.ts',
  'Identify inactivity from available opt-in last-seen records and native prune estimates, without treating unavailable/offline history as observed data.',
);
review(
  's04-044',
  'report.assign',
  'src/features/community.ts',
  'test/community.test.ts',
  'Assign or reassign a retained member report to an explicitly selected currently eligible moderator.',
);
review(
  's05-006',
  'security.analyze integration.security.url-report integration.security.scan-url',
  'src/features/security.ts src/features/optional-integrations.ts',
  'test/security.test.ts test/optional-integrations.test.ts',
  'Apply configured suspicious-domain/URL heuristics and optionally request an actual VirusTotal reputation/analysis verdict; no detector promises to classify every phishing URL.',
  ['VIRUSTOTAL_API_KEY'],
);

review(
  's06-005',
  'message.send',
  'src/discord/actions/messages.ts',
  'test/native-completion.test.ts',
  'Allow only explicitly selected user/role/everyone mentions in the reviewed allowedMentions field; default delivery suppresses mentions.',
);
review(
  's06-040',
  'relay.configure relay.consent relay.list relay.remove',
  'src/features/message-automation.ts',
  'test/message-automation.test.ts',
  'Opt into a continuous authorized channel relay with durable reference queue, per-author consent and fresh source/destination checks before forwarding.',
);
review(
  's06-042',
  'ai.summarize.messages ai.history.answer',
  'src/features/knowledge.ts src/features/ai-enhancements.ts',
  'test/knowledge.test.ts test/ai-enhancements.test.ts',
  'Summarize accessible discussions with source IDs, bounded excerpt coverage and optional paginated multi-stage analysis; omitted attachments/text are disclosed.',
  ['OPENAI_API_KEY'],
);
review(
  's06-050',
  'message.search message.history-export',
  'src/discord/actions/messages.ts src/features/history.ts',
  'test/native-completion.test.ts',
  'Search/export up to 5,000 readable messages per range with exact continuation IDs and current source/history checks on every page; continue older history explicitly.',
);
review(
  's06-051 s06-052',
  'tracking.watch tracking.view tracking.remove',
  'src/features/message-automation.ts',
  'test/message-automation.test.ts',
  'Persist bounded opted-in reply/reaction event metadata for selected messages and reauthorize source access when reading; no retroactive unobserved events are invented.',
);
review(
  's06-055',
  'conversation.channel.configure conversation.channel.consent',
  'src/features/message-automation.ts',
  'test/message-automation.test.ts',
  'An explicit channel policy and author consent enable bounded public conversational continuation without repeated mentions, using separately scoped context without administrative tools or private preferences.',
  ['OPENAI_API_KEY'],
);
review(
  's07-023 s07-024',
  '',
  'src/discord/commands.ts src/discord/personal.ts',
  'test/commands.test.ts test/identity.test.ts',
  'Register supported personal slash commands for the configured user-install/DM contexts, keeping personal conversational requests separate from guild administrative authority.',
  ['ENABLE_USER_INSTALL', 'DISCORD_CLIENT_ID'],
);
review(
  's08-035',
  'ui.pages.publish',
  'src/features/interfaces.ts',
  'test/interfaces.test.ts',
  'Publish real previous/next interaction buttons over a bounded page set; button handlers check audience/current context and update the bound message.',
);
review(
  's10-018',
  'eventroles.configure eventroles.view eventroles.review eventroles.remove',
  'src/features/event-roles.ts',
  'test/event-roles.test.ts',
  'Reconcile RSVP/time-window temporary ordinary event roles and remove only confirmed bot-owned grants; manual/unknown provenance is preserved for review.',
);
review(
  's10-020',
  'tournament.schedule',
  'src/features/automation.ts',
  'test/automation.test.ts',
  'Publish an exact per-match schedule with one-time reminders through the existing durable scheduler.',
);
review(
  's10-027',
  'workflow.set operation.schedule.set',
  'src/features/automation.ts src/features/operations.ts',
  'test/automation.test.ts test/operations.test.ts',
  'Run explicitly configured timed/cron workflows and approved fixed local operations through durable scheduling, fresh author checks and bounded execution.',
  ['LOCAL_OPERATIONS_MANIFEST'],
);
review(
  's10-032',
  'integration.provider-watch.create integration.google-calendar.events',
  'src/features/optional-integrations.ts',
  'test/optional-integrations.test.ts',
  'Poll an authorized external Google calendar and notify the reviewed channel about selected event metadata changes, with durable baselines and ambiguous-send recovery.',
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
);

review(
  's09-003',
  'voice.move',
  'src/features/voice.ts',
  'test/voice.test.ts',
  'Move the existing transport between authorized voice/Stage channels; expected Gateway moves preserve it, while old playback and per-speaker consent are cleared.',
  ['ENABLE_VOICE'],
);
review(
  's09-004 s09-041',
  'voice.play voice.sources voice.stream voice.library-play',
  'src/features/voice.ts src/features/audio-media.ts',
  'test/voice.test.ts test/voice-experiences.test.ts test/media-workflows.test.ts',
  'Stream bounded decoded audio from currently authorized Discord attachments, fixed local WAV IDs or configured HTTPS source IDs. Compressed inputs decode through real FFmpeg; unknown-duration sources are clipped to 120 seconds.',
  ['ENABLE_VOICE', 'VOICE_AUDIO_DIRECTORY', 'VOICE_STREAM_SOURCES_JSON'],
);
review(
  's09-011',
  'voice.queue.saved voice.queue.restore voice.queue.clear voice.playlist-save',
  'src/features/voice.ts',
  'test/voice.test.ts',
  'Persist isolated per-server current/queued music references, restore atomically after fresh source checks, and resume interrupted tracks from the beginning. Raw audio and consent do not persist.',
  ['ENABLE_VOICE'],
);
review(
  's09-013',
  'voice.volume',
  'src/features/voice.ts',
  'test/voice.test.ts',
  'Adjust the active audio resource’s inline volume immediately and retain it for subsequent tracks without restarting playback.',
  ['ENABLE_VOICE'],
);
review(
  's09-030',
  'voice.consent',
  'src/features/voice.ts src/discord/voice-commands.ts',
  'test/voice-commands.test.ts test/voice.test.ts',
  'Individual transcription consent and the wake name gate spoken requests and short related follow-ups. Commands-only consent uses deterministic controls; conversational replies also route natural requests through typed AI tools with fresh member/bot permissions, policies and cancellation leases. Transcripts use a verified private channel; spoken output applies public-safe tool restrictions without personal preferences. Smart mode executes eligible ordinary requests directly; destructive and authority-sensitive actions retain one member/channel-bound confirmation with natural spoken confirmation. Stop/revoke act immediately.',
  ['ENABLE_VOICE', 'OPENAI_API_KEY'],
);
review(
  's09-034',
  'voice.consent',
  'src/features/voice.ts src/app.ts',
  'test/voice.test.ts',
  'Individually consented local/OpenAI transcription checks the wake name and short related follow-ups before generation. Ordinary chat streams Realtime audio; action requests use guarded typed AI tools and spoken receipts. Transcripts remain in a verified private channel, spoken output uses public-safe restrictions, and consent tokens, fresh membership/history, policies and cancellation checks prevent stale delivery.',
  ['ENABLE_VOICE', 'OPENAI_API_KEY'],
);
review(
  's09-037',
  'voice.consent voice.activity',
  'src/voice/recordings.ts src/features/voice.ts',
  'test/voice.test.ts',
  'Opt-in local acoustic VAD evaluates actual 20 ms PCM energy frames, rejects silent utterances before upload/archive and exposes bounded activity metadata; loud non-speech can count as activity.',
  ['ENABLE_VOICE'],
);
review(
  's09-040',
  'voice.attendance.report calendar.export analytics.activity',
  'src/features/voice-experiences.ts src/features/automation.ts',
  'test/voice-experiences.test.ts test/automation.test.ts',
  'Export retained observed member voice durations or permission-scoped local event RSVP/attendance CSV, with explicit downtime/missing-event gaps.',
  ['ENABLE_VOICE'],
);
review(
  's09-043 s09-044',
  'audio.convert',
  'src/features/audio-media.ts',
  'test/audio-media.test.ts test/media-workflows.test.ts',
  'Apply real validated equalizer, compressor, high/low-pass, echo, tempo, volume and trimming operations through fixed FFmpeg filter graphs.',
);
review(
  's09-045',
  'voice.recording.configure voice.consent voice.recordings.list voice.recordings.export voice.recordings.erase',
  'src/features/voice.ts src/voice/recordings.ts',
  'test/voice.test.ts',
  'Require manager opt-in and individual speaker consent for bounded WAV archives; support local recording-only mode, owner/source-checked exports, revocation/erasure and automatic expiry within a 64 MiB global admission limit.',
  ['ENABLE_VOICE'],
);

review(
  's11-004',
  'ai.memory.pin ai.memory.pins ai.memory.unpin ai.memory.forget',
  'src/features/ai-enhancements.ts src/features/ai.ts',
  'test/ai-enhancements.test.ts',
  'Retain named private pinned memories until explicit removal/erasure, independently of expiring conversation history; exclude private pins from shared/public/voice requests.',
  ['OPENAI_API_KEY'],
);
review(
  's11-008 s11-009',
  'ai.history.answer ai.summarize.messages',
  'src/features/ai-enhancements.ts src/features/knowledge.ts',
  'test/ai-enhancements.test.ts test/knowledge.test.ts',
  'Paginate readable history, analyze bounded excerpts in stages and report selected IDs, analyzed/source characters, truncation, continuation and whether older history remains.',
  ['OPENAI_API_KEY'],
);
review(
  's11-010',
  'ai.document.analyze integration.google-drive.download integration.google-drive.export',
  'src/features/ai-enhancements.ts src/features/optional-integrations.ts',
  'test/ai-enhancements.test.ts test/optional-integrations.test.ts test/files.test.ts',
  'Read selected image/PDF/Office/text attachments or authorized Google Drive files/exports; quoted source analysis remains bounded and does not execute source instructions.',
  ['OPENAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
);
review(
  's11-018',
  'ai.log.analyze',
  'src/features/ai-enhancements.ts',
  'test/ai-enhancements.test.ts',
  'Operator plus Manage Server authority permits only fixed host-approved log IDs; cap regular files at 1 MiB, redact configured secrets and refresh authority for each bounded model stage.',
  ['OPENAI_API_KEY', 'AI_LOG_FILES_JSON', 'OPERATOR_IDS'],
);
review(
  's11-025',
  'ai.article.summarize',
  'src/features/ai-enhancements.ts src/features/integrations.ts',
  'test/ai-enhancements.test.ts test/integrations.test.ts',
  'Fetch an explicitly approved public HTTPS article with DNS-pinned public-address validation, remove scripts/markup and summarize bounded source coverage.',
  ['OPENAI_API_KEY'],
);
review(
  's11-026',
  'ai.document.analyze',
  'src/features/ai-enhancements.ts src/features/ai.ts',
  'test/ai.test.ts test/files.test.ts',
  'Supply a selected supported PDF through the real SDK’s document input for model summarization; attachment and account/model limits remain explicit.',
  ['OPENAI_API_KEY'],
);
review(
  's11-030',
  'math.calculate',
  'src/features/calculator.ts src/features/ai.ts',
  'test/calculator.test.ts test/ai-enhancements.test.ts',
  'Use a safe bounded BigInt rational parser/tool for exact decimal arithmetic, fractions, powers, parentheses and rounding disclosure; never evaluate code.',
);
review(
  's11-041',
  'ai.knowledge.search ai.knowledge.shared-add ai.knowledge.shared-ask integration.google-drive.files',
  'src/features/knowledge.ts src/features/ai-enhancements.ts src/features/optional-integrations.ts',
  'test/knowledge.test.ts test/ai-enhancements.test.ts test/optional-integrations.test.ts',
  'Search private or role/source/version-gated shared semantic knowledge and selected authorized Drive documents; shared answers cite named source excerpts and omit private context.',
  ['OPENAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
);
review(
  's11-051',
  'ticket.ai.configure ticket.ai.classify ticket.ai.view',
  'src/features/ticket-ai.ts',
  'test/ticket-ai.test.ts',
  'Automatically classify approved readable channel/thread ticket content with exact taxonomy, optional priority/locale and reviewed fixed category routes; make one billed automatic attempt per cycle and preserve unknown mutations for staff review.',
  ['OPENAI_API_KEY'],
);
review(
  's11-054 s11-056 s11-062 s11-063',
  'ai.plan.create ai.plan.view ai.plan.step ai.plan.reconcile ai.plan.cancel ai.plan.remove',
  'src/features/ai-enhancements.ts src/features/ai.ts src/features/approval-chains.ts',
  'test/ai-enhancements.test.ts test/approval-chains.test.ts test/ai.test.ts',
  'Coordinate strict tools and durable immutable plans with exact one-use step confirmations, fresh action permissions, optional staged human quorums, progress revisions and explicit unknown-outcome reconciliation. No cross-service atomic rollback is claimed.',
  ['OPENAI_API_KEY'],
);
review(
  's11-058',
  'ai.access.configure ai.access.view',
  'src/features/ai.ts src/features/ai-policy.ts',
  'test/ai-enhancements.test.ts',
  'Route coding/reasoning/general tasks deterministically to host-configured model IDs; explicit per-person/admin/server routes override the automatic route and absent routes fall back to the configured general model.',
  ['OPENAI_API_KEY', 'AI_MODEL_ROUTES_JSON'],
);
review(
  's11-060 s11-061',
  'ai.access.configure ai.access.view ai.access.remove',
  'src/features/ai-policy.ts src/features/ai.ts src/features/ai-enhancements.ts',
  'test/ai-enhancements.test.ts',
  'Intersect server, administrator and individual enablement/tool/web permissions, retain strict daily ceilings even with premium top-ups, and invalidate pending work after policy change or erasure.',
  ['OPENAI_API_KEY'],
);

const oauthSource = 'src/services/account-linking.ts';
const oauthTests = 'test/account-linking.test.ts';
const oauthConfig = ['APP_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'OAUTH_ENCRYPTION_KEY'];
review(
  's17-017 s17-018 s17-019 s17-020 s17-021',
  'oauth.start oauth.link.confirm oauth.accounts oauth.identity oauth.unlink',
  oauthSource,
  oauthTests,
  'Authorize actual Discord/Google/GitHub user identities via state/PKCE callbacks, exact account confirmation and encrypted owner/server-scoped tokens. Live identity and selected granted scopes are retrieved without exposing credentials.',
  oauthConfig,
);
review(
  's17-022',
  'bot.linked-role.metadata oauth.linked-role.update',
  'src/features/identity.ts src/services/account-linking.ts',
  'test/identity.test.ts test/account-linking.test.ts',
  'Register application Linked Role metadata and update only the current user’s exact authorized role connection using role_connections.write, not a bot-token substitute for a user grant.',
  oauthConfig,
);
review(
  's17-023',
  'oauth.start oauth.link.confirm',
  'src/services/account-linking.ts',
  'test/account-linking.test.ts',
  'Authorize the hosted account/dashboard surface with actual Discord OAuth login, current linked identity and short-lived sessions; browser callbacks do not create guild administrative authority.',
  oauthConfig,
);
review(
  's17-030',
  'invite.list',
  'src/discord/actions/resources.ts',
  'test/discord-actions.test.ts',
  'Read available native invitation usage counters and current invite metadata; the literal available-activity requirement does not promise reliable member-to-inviter attribution when Discord does not provide it.',
);
review(
  's17-031',
  'oauth.start oauth.guild.join',
  oauthSource,
  oauthTests,
  'Request exact guilds.join authorization for a selected operator-approved server, then explicitly confirm joining the same verified user account. Enforce the fixed allowlist, current bot authority and durable unknown-outcome review; do not grant roles or bypass screening.',
  ['APP_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'OAUTH_JOIN_GUILD_IDS'],
);
review(
  's17-032 s17-033',
  '',
  'src/discord/commands.ts src/discord/personal.ts scripts/deploy-commands.ts',
  'test/commands.test.ts test/identity.test.ts test/deploy-commands.test.ts',
  'Deploy supported user-install command definitions with Guild/BotDM/PrivateChannel contexts and route personal help/status/schema/forget/ask without impersonating a guild administrator. Native Portal installation settings still apply.',
  ['ENABLE_USER_INSTALL'],
);

const activitySource = 'src/activities/service.ts src/activities/state.ts web/activity.js';
const activityTests = 'test/activity-state.test.ts test/hosted-services.test.ts';
const activityConfig = ['ACTIVITY_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];
review(
  's07-006 s19-001 s19-010',
  'activity.launch activity.preview',
  'src/activities/service.ts src/discord/commands.ts web/activity.js',
  activityTests,
  'Provide actual Activity launch/primary-entry commands, hosted iframe assets and Embedded App SDK authorization; preview remains explicitly separate from a native live instance.',
  activityConfig,
);
review(
  's19-002 s19-006',
  'activity.launch',
  activitySource,
  activityTests,
  'Render and synchronize playable multiplayer tic-tac-toe plus a valid sliding-puzzle board, with authoritative turns/revisions and current room participants.',
  activityConfig,
);
review(
  's19-003',
  'activity.launch',
  activitySource,
  activityTests,
  'Provide a real pointer/touch whiteboard with bounded shared strokes and per-author undo in the authenticated Activity.',
  activityConfig,
);
review(
  's19-004 s19-005',
  'activity.launch',
  activitySource,
  activityTests,
  'Run timed multiplayer quiz rounds with actual correct-answer scoring and a learning mode containing explanatory lessons; host controls and answer bounds are enforced server-side.',
  activityConfig,
);
review(
  's19-007 s19-015',
  'activity.launch',
  activitySource,
  activityTests,
  'Provide a shared task board and real revision-checked collaborative editor; conflicting edits preserve the browser draft for explicit review rather than overwriting a newer revision.',
  activityConfig,
);
review(
  's19-008 s19-009 s19-011',
  'activity.launch activity.rooms',
  activitySource,
  activityTests,
  'Persist authoritative shared room/participant/game state in SQLite with bounded low-latency polling, membership checks and exact operation revisions; interrupted writes are not blindly replayed.',
  activityConfig,
);
review(
  's19-012',
  'activity.launch',
  activitySource,
  activityTests,
  'Render an interactive coordinate map with pan/zoom and bounded shared labeled markers; it is the implemented map experience rather than an unlicensed external map service.',
  activityConfig,
);
review(
  's19-013',
  'activity.launch',
  activitySource,
  activityTests,
  'Run the interactive particle simulation using shared validated gravity, restitution and particle-count settings.',
  activityConfig,
);
review(
  's19-014 s19-023',
  'activity.launch',
  activitySource,
  activityTests,
  'Display a real graphical dashboard of current participants, tasks, strokes, quiz rounds and persisted local game/quiz scores; external game statistics remain a separate Steam adapter.',
  activityConfig,
);
review(
  's19-016 s19-017 s19-018 s19-025',
  'activity.launch',
  activitySource,
  activityTests,
  'Use the real Embedded App SDK OAuth code exchange and exact instance/channel/connected-user verification to authenticate supported embedded games and bind current Discord identity/context. This does not claim native-game SDK integration.',
  activityConfig,
);
review(
  's19-019 s19-026',
  'activity.launch activity.rooms',
  activitySource,
  activityTests,
  'Supply the supported embedded game companion: authenticated shared rooms, participant identity, local scores, quizzes and social collaborative tools. Native off-platform game integrations remain provider-specific.',
  activityConfig,
);
review(
  's19-020',
  'activity.launch',
  'web/activity.js src/activities/service.ts',
  activityTests,
  'Request the explicit rpc.activities.write scope and let the current authenticated Activity user publish supported Rich Presence through Embedded App SDK setActivity. Presence is not silently enabled for unrelated players.',
  activityConfig,
);
review(
  's19-021 s19-022',
  'activity.launch activity.rooms',
  activitySource,
  activityTests,
  'Use native Embedded App SDK openInviteDialog for supported Activity invitations and authenticated instance-bound shared rooms for the bundled game lobby/participants; no arbitrary native Social SDK lobby is implied.',
  activityConfig,
);
review(
  's19-024',
  'game-stats.identities game-stats.source game-stats.profile game-stats.update game-stats.remove',
  'src/features/game-stats-widgets.ts src/services/account-linking.ts',
  'test/game-stats-widgets.test.ts test/account-linking.test.ts',
  'Use the real native Profile Board Application Identity Profile API with verified own application_identities.write OAuth, existing bot token, host-approved game account/stat source and exact confirmed payloads. Claim the actual game and configure Games > Widget layouts in Portal; the Activity room scoreboard is not substituted.',
  ['GAME_STATS_PROFILES_FILE', 'APP_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  'implemented',
  [
    'Claim the game in Discord, configure its Games > Widget layout, and let each player authorize and add their native widget.',
  ],
);

const premiumSource = 'src/features/premium.ts src/features/entitlement-roles.ts';
const premiumTests = 'test/premium.test.ts test/entitlement-roles.test.ts';
const premiumConfig = ['PREMIUM_POLICY_FILE'];
const premiumSetup = [
  'Complete Discord app/team monetization eligibility and payout onboarding, create the intended offerings in Portal, and map their actual SKU IDs in the local premium policy.',
];
review(
  's08-003 s20-017',
  'premium.purchase premium.catalog',
  'src/features/premium.ts src/features/interfaces.ts',
  premiumTests,
  'Render actual native purchase buttons for verified available own-application SKUs and display configured benefits; checkout, current pricing and purchase authorization remain in Discord.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-001 s20-002',
  'premium.catalog premium.purchase premium.status premium.subscriptions',
  premiumSource,
  premiumTests,
  'Support configured user or guild subscription offerings, authoritative current user/guild entitlements and lifecycle reads. Discord permits choosing user or guild subscription scope for a product configuration; both code paths are supported.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-003',
  'premium.purchase premium.status',
  premiumSource,
  premiumTests,
  'Support permanent durable one-time SKU unlocks through current own-application entitlements and configured action/theme/interface benefits.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-004',
  'premium.purchase premium.claim premium.claim-review',
  premiumSource,
  premiumTests,
  'Consume an exact eligible one-time entitlement into a durable finite in-bot credit ledger, with claim deduplication and explicit uncertain-consumption reconciliation; no automatic double-credit or blind retry.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-005',
  'premium.configuration',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'Actual product SKU creation is a Developer Portal operation after app/team monetization approval; the documented bot API lists SKUs and consumes entitlements but does not create offerings. No fabricated create-SKU endpoint is exposed.',
  premiumConfig,
  'external_setup',
  premiumSetup,
);
review(
  's20-010 s20-021',
  'premium.status premium.catalog',
  'src/features/premium.ts src/core/registry.ts src/app.ts',
  'test/premium.test.ts',
  'Synchronously verify current own-application user/guild entitlements before protected action admission, recheck policy versions before execution and retain quotas/credit debits atomically. Ordinary role possession does not substitute for entitlement.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-011',
  'premium.catalog premium.usage',
  'src/features/premium.ts src/core/registry.ts',
  'test/premium.test.ts',
  'Enforce configured per-action subscription command limits at the actual registry execution boundary, with atomic admission and durable usage/outcome records.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-012 s20-013',
  'premium.theme.set premium.interface.set',
  'src/features/premium.ts src/features/dashboard.ts src/discord/dashboard-page.ts',
  'test/premium.test.ts test/dashboard.test.ts',
  'Select only currently entitled configured themes/interfaces and apply the actual appearance/compact/analytics options in the supported authenticated dashboard UI.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-014',
  'premium.status',
  'src/features/premium.ts src/features/ai.ts src/core/limits.ts src/app.ts',
  'test/premium.test.ts test/ai-enhancements.test.ts',
  'Resolve current premium AI daily allowances before metering while preserving stricter per-person/admin/server limits, policy epochs, erasure cancellation and single request charging.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-015',
  'premium.status premium.claim premium.subscriptions',
  premiumSource,
  premiumTests,
  'Maintain actual configured premium membership benefits, permanent unlocks, consumable credit claims and subscription state; optional ordinary role reconciliation remains provenance-aware.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-016',
  'premium.subscriptions premium.analytics',
  premiumSource,
  premiumTests,
  'Record current entitlement/subscription lifecycle events, use live entitlements for access rather than subscription status alone, expire/reconcile benefits and preserve known/unknown usage outcomes.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-018',
  'premium.configuration premium.catalog',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'The code prepares configured offering information and the native Store link. Creating/publishing the actual Discord application Store page requires the team’s Developer Portal configuration; it is not an authenticated bot REST mutation.',
  premiumConfig,
  'external_setup',
  premiumSetup,
);
review(
  's20-019',
  'premium.configuration',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'App discovery publication requires verified app eligibility, required policy/support metadata and the Developer Portal Enable Discovery operation. Providing an app link is not claimed as completing publication.',
  premiumConfig,
  'external_setup',
  ['Complete app verification/discovery requirements and explicitly enable Discovery in Developer Portal.'],
);
review(
  's20-022 s20-023',
  'premium.usage premium.analytics',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'Persist actual premium action attempts, outcomes, credit debits and lifecycle events, then generate customer/staff-scoped usage/subscription aggregates with bounded retention.',
  premiumConfig,
  'implemented',
  premiumSetup,
);
review(
  's20-024',
  'premium.catalog premium.configuration',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'Configured local benefits/offerings are read and enforced, but actual payment prices and offering publication are managed in Developer Portal. Discord checkout remains authoritative; the bot does not invent a pricing-edit API.',
  premiumConfig,
  'external_setup',
  premiumSetup,
);
review(
  's20-025 s20-026',
  'premium.support.open premium.support.mine premium.support.queue premium.support.reply premium.support.restore-credits',
  'src/features/premium.ts',
  'test/premium.test.ts',
  'Provide private customer account/billing support cases, staff queue/replies and exact reviewed restoration of in-bot credits tied to a failed/unknown usage record. Monetary refunds remain the payment provider’s process.',
  premiumConfig,
  'implemented',
  premiumSetup,
);

registerNativeCapabilityReviews(review);
