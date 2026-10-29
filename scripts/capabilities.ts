import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { reviewedCoverage, type CapabilityStatus, type CapabilityEvidence } from './capability-review.js';
import { OPTIONAL_INTEGRATION_FIELDS } from '../src/integrations/provider-catalog.js';
import { ADDITIONAL_SERVICE_FIELDS } from '../src/service-fields.js';

type Status = CapabilityStatus;
interface Coverage {
  status: Status;
  actionIds: string[];
  entryPoints: string[];
  notes: string;
  evidence?: CapabilityEvidence;
  architectureDecision?: { selected: string; resolution: string };
}
interface Capability extends Coverage {
  id: string;
  sectionNumber: number;
  section: string;
  capability: string;
}
interface Rule extends Coverage {
  sectionNumbers?: number[];
  test: RegExp;
}
const rules: Rule[] = [];
function rule(
  test: RegExp,
  actionIds: string[] = [],
  notes = 'Executable action exists; Discord permissions and server eligibility apply.',
  status: Status = 'implemented',
  sectionNumbers?: number[],
  entryPoints: string[] = [],
): void {
  rules.push({ test, actionIds, notes, status, sectionNumbers, entryPoints });
}

// Exact overrides record later modules without accidentally broadening an older regex mapping.
function exact(
  sections: number[],
  capabilities: string[],
  actionIds: string[],
  notes: string,
  status: Status = 'implemented',
  entryPoints: string[] = [],
): void {
  const names = capabilities.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  rules.unshift({
    test: new RegExp(`^(?:${names.join('|')})\\.$`, 'i'),
    actionIds,
    notes,
    status,
    sectionNumbers: sections,
    entryPoints,
  });
}

exact(
  [1],
  ['Rebuild server layouts using templates'],
  ['layout.template.plan', 'layout.apply'],
  'Converts supported public Discord template roles/channels into an immutable merge plan. Apply at most ten exact reviewed operations per confirmation; managed resources, messages, images and full guild identity are omitted.',
  'partial',
);
exact(
  [1],
  ['Automatically create channel structures', 'Automatically create role structures'],
  ['layout.plan', 'layout.apply'],
  'Declarative supported role/channel structures execute in bounded explicitly confirmed batches. Every step rechecks authority; interrupted operations require reconciliation.',
);
exact(
  [1],
  ['Back up server configuration information', 'Restore supported server configurations'],
  ['layout.snapshot.save', 'layout.snapshot.export', 'layout.restore.plan', 'layout.apply'],
  'Persistent supported topology/settings snapshots and merge/recreate restore plans. Messages, managed resources and other documented omissions are not backed up; existing unrelated resources are preserved.',
  'partial',
);
exact(
  [1],
  ['Compare server configuration changes'],
  ['layout.snapshot.diff', 'security.baseline.compare'],
  'Compare saved supported topology/settings and accessible configuration against the current server. Visibility changes can appear as removals.',
);
exact(
  [1],
  ['Detect unauthorized administrative changes'],
  ['security.configure', 'security.logs'],
  'Opt-in structural-change logging with best-effort audit attribution flags actors outside a configured allowlist. Missing or ambiguous audit data remains unknown; this cannot prove authorization or intent.',
  'partial',
);
exact(
  [1],
  ['Alert administrators about configuration changes'],
  ['security.configure'],
  'Opt-in administrative change and role/channel burst notifications to a configured staff channel; only observed supported events.',
);
exact(
  [1],
  ['Produce server administration reports'],
  ['layout.report', 'analytics.summary'],
  'Current supported configuration inventory/privileged-role summary plus stored administration/support activity; not a complete historical audit.',
);
exact(
  [1],
  ['Execute bulk administrative operations'],
  ['layout.apply', 'member.bulk-ban', 'role.assign-many', 'message.bulk-delete'],
  'Bounded topology batches, member bans, role assignments and message deletions; no arbitrary raw API batch executor.',
  'partial',
);
exact(
  [2],
  ['Create temporary channels', 'Automatically delete temporary channels'],
  ['channel.temporary', 'channel.temporary-list'],
  'Persisted text/voice channel expirations; occupied voice rooms wait for vacancy and failed deletion backs off.',
);
exact(
  [2, 9],
  [
    'Create temporary private voice rooms',
    'Manage temporary voice channels',
    'Automatically create voice rooms',
    'Automatically delete unused voice rooms',
  ],
  ['voiceroom.hub', 'voiceroom.allow'],
  'Opt-in join-to-create private voice rooms and empty-room cleanup with current permission checks and durable resource tracking.',
);
exact(
  [2],
  ['Configure channel-specific automation', 'Automatically organize discussions into threads'],
  ['workflow.set'],
  'Explicit message-event policies can filter a source channel/keyword and create public threads. Configured author/channel authority is checked again when jobs execute.',
);
exact(
  [3],
  ['Assign multiple roles automatically'],
  ['workflow.set', 'community.configure'],
  'Configured newcomer assignment and event workflows grant allowlisted ordinary roles; workflows allow up to five steps and revalidate author/bot role authority.',
);
exact(
  [3],
  ['Assign roles through button interactions', 'Assign roles through selection menus'],
  ['ui.roles.publish', 'selfrole.add', 'selfrole.remove'],
  'Persistent approved ordinary-role dropdown/button panels propose exact member-bound role changes for confirmation.',
);
exact(
  [3],
  ['Assign roles after verification'],
  ['verification.configure', 'verification.publish', 'verification.complete'],
  'Rules acknowledgement, optional account/member age checks and completed native screening precede a currently safe ordinary-role grant. This is not proof of human identity.',
);
exact(
  [3],
  [
    'Assign roles based on activity',
    'Assign roles based on experience levels',
    'Assign achievement roles',
    'Assign reward roles',
  ],
  ['reward.roles.configure'],
  'Configured ordinary role rewards for observed XP/levels and built-in game achievements; policy author and hierarchy are revalidated. No external game achievements.',
);
exact(
  [3],
  ['Alert administrators about privileged role changes'],
  ['security.configure'],
  'Opt-in role-change/burst alerts and best-effort audit actor correlation; does not automatically reverse privileged changes.',
  'partial',
);
exact(
  [3],
  ['Configure Linked Roles metadata'],
  ['bot.linked-role.metadata'],
  'Application owner can register metadata schema records. Per-user role connection updates and account linking still require an OAuth callback service.',
  'partial',
);

exact(
  [4],
  [
    'Log member joins',
    'Log member leaves',
    'Track role changes',
    'Track nickname changes',
    'Track moderation events',
  ],
  ['security.configure', 'security.logs'],
  'Opt-in bounded Gateway event metadata and best-effort audit actor records, subject to intents, configured retention and event availability.',
);
exact(
  [4],
  ['Log deleted messages observed by the bot', 'Log edited messages observed by the bot'],
  ['security.configure', 'security.logs', 'security.export'],
  'Opt-in observed edits/deletions for selected channels; content requires a separate explicit setting, available cached event data and current channel/history access on retrieval.',
);
exact(
  [4],
  ['Export moderation logs', 'Generate moderator activity reports'],
  ['security.export', 'analytics.summary', 'system.audit'],
  'Exports accessible observed event/audit metadata and bot action counts. Historical events before opt-in or missing audit actors cannot be reconstructed.',
  'partial',
);
exact(
  [4],
  ['Identify inactive members using available activity data'],
  ['analytics.activity', 'member.prune-count'],
  'Queries observed last activity and Discord prune counts. Members with no observed data are not inferred inactive.',
  'partial',
);
exact(
  [4],
  [
    'Create automated moderation queues',
    'Send urgent staff alerts',
    'Implement configurable moderation policies',
  ],
  ['security.configure', 'security.findings', 'security.review'],
  'Opt-in local heuristic policies create a bounded staff review queue and alerts. Automatic flagged-message deletion is separately opt-in; no automatic escalating bans.',
);

exact(
  [5],
  ['Detect rapid member-join spikes'],
  ['security.configure'],
  'Configurable observed join threshold/window, deduplication and alert throttling; optional bounded invite pause.',
);
exact(
  [5],
  [
    'Detect suspicious link patterns',
    'Detect known scam domains',
    'Identify suspicious attachment types',
    'Detect excessive emoji spam',
    'Detect excessive capitalization',
    'Build custom anti-spam scoring systems',
  ],
  ['security.configure', 'security.analyze'],
  'Local configured domain/extension and URL/capitalization/emoji/mention heuristics, bounded scoring and human review; no bundled external reputation feed.',
);
exact(
  [5],
  ['Detect phishing URLs'],
  ['security.analyze', 'security.configure'],
  'Flags configured domains and suspicious URL patterns. No external reputation verdict or guarantee of phishing detection.',
  'partial',
);
exact(
  [5],
  [
    'Detect suspicious mass-channel deletions',
    'Detect suspicious mass-role modifications',
    'Alert administrators about webhook changes',
  ],
  ['security.configure'],
  'Opt-in observed structural-change window thresholds and staff alerts; webhook alerts omit secret tokens.',
);
exact(
  [5],
  ['Restrict server access during raids'],
  ['security.configure', 'guild.incident'],
  'Opt-in join-spike response pauses invitations for a bounded interval; manual Discord incident controls are also available. No automatic newcomer bans.',
);
exact(
  [5],
  ['Activate emergency server lockdowns', 'Restore saved permissions after lockdowns'],
  ['security.lockdown.apply', 'security.lockdown.status', 'security.lockdown.restore'],
  'Explicitly selected channels save exact overwrites and deny sending/thread or voice access across ordinary role/member overrides. Timed restore detects conflicts; Administrators keep Discord bypass.',
);
exact(
  [5],
  ['Implement configurable moderation trust scores'],
  ['security.trust'],
  'Transparent configurable penalties from confirmed recent findings and stored warnings, not identity or intent prediction.',
);
exact(
  [5],
  ['Request human review of suspicious activity'],
  ['security.findings', 'security.review'],
  'Bounded persistent findings queue with current channel/history access checks and confirmed staff decisions.',
);
exact(
  [5],
  ['Maintain allowlists', 'Maintain blocklists'],
  ['security.configure', 'automod.create'],
  'Configured domain/actor/trusted-role policy lists and native AutoMod keyword exemptions; no globally maintained reputation database.',
);

exact(
  [6],
  ['Send graphical reports'],
  ['chart.bar', 'image.card'],
  'Generated bounded raster charts/cards are returned as Discord attachments; values and labels are supplied explicitly.',
);
exact(
  [6],
  ['Schedule messages'],
  ['reminder.create', 'schedule.set'],
  'Durable one-off/fixed-interval reminders and five-field UTC cron announcements with bounded retries and stable delivery nonces.',
);
exact(
  [6],
  ['Send personalized event-based messages'],
  ['workflow.set'],
  'Operator-configured observed-event message policies support user/channel/server/event placeholders and current authorization.',
);
exact(
  [6],
  ['Monitor replies', 'Monitor reactions'],
  ['workflow.set', 'security.configure'],
  'Observed message/reaction metadata and configured event workflows; reply threading metadata is not a complete reply-tracking dashboard.',
  'partial',
);
exact(
  [6],
  ['Continue conversations without repeated mentions'],
  ['notification.subscribe'],
  'Explicitly opted-in eligible members can continue AI conversation in personal DMs. General guild channel listening without mentions is not enabled.',
  'partial',
);

exact(
  [8],
  [
    'Create interactive buttons',
    'Create string-selection dropdown menus',
    'Create user-selection dropdown menus',
    'Create role-selection dropdown menus',
    'Create channel-selection dropdown menus',
    'Create mentionable-selection dropdown menus',
    'Create modal popup forms',
    'Create text-input fields',
    'Create file-upload fields in modals',
    'Create radio-button groups',
    'Create checkbox groups',
    'Create individual checkboxes',
    'Create input labels',
    'Build multi-step forms',
    'Create application forms',
    'Create recruitment forms',
    'Create interactive quizzes',
    'Create answer-submission forms',
    'Create custom surveys',
  ],
  ['form.create', 'form.publish', 'form.submit'],
  'Persistent typed multi-step forms, private expiring drafts, exact confirmed submission, optional quiz grading and role-restricted review/export. File fields retain bounded Discord attachment metadata.',
);
exact(
  [8],
  [
    'Create link buttons',
    'Create styled message containers',
    'Create text-display components',
    'Create text-and-accessory sections',
    'Display embedded thumbnails',
    'Display media galleries',
    'Display file components',
    'Create layout separators',
  ],
  ['ui.message.publish'],
  'Real Discord Components V2 publication with validated bounded Discord attachment media and HTTPS link buttons.',
);
exact(
  [8],
  ['Create premium purchase buttons'],
  ['ui.message.publish'],
  'Renders a purchase button for an existing SKU belonging to this application. Product eligibility and monetization setup remain external.',
  'partial',
);
exact(
  [8],
  ['Create interactive settings menus'],
  ['ui.settings.publish'],
  'Persistent XP/FAQ/antispam settings controls require current Manage Server and common confirmation.',
);
exact(
  [8],
  ['Create interactive moderation dashboards'],
  ['ui.moderation.publish'],
  'Persistent buttons open authorized private report/case queues; no external web dashboard.',
);
exact(
  [8, 14],
  ['Create ticket-creation panels', 'Set up support-ticket panels'],
  ['ui.ticket.publish', 'ticket.open'],
  'Persistent ticket button opens a subject modal and proposes an authorized private ticket channel.',
);
exact(
  [8],
  ['Create role-selection panels'],
  ['ui.roles.publish'],
  'Approved ordinary-role dropdown/button panels with per-member exact confirmations and privilege revalidation.',
);
exact(
  [8],
  ['Create interactive game interfaces'],
  ['game.panel', 'game.move'],
  'Persistent revision-bound board buttons for supported built-in games; stale moves are rejected.',
);
exact(
  [8],
  ['Create interactive pagination systems'],
  [],
  'Searchable action help has previous/next buttons; list schemas use limits/offsets. No general interactive result paginator.',
  'partial',
  ['/help'],
);

exact(
  [7],
  ['Create slash subcommands', 'Create slash command groups'],
  [],
  'Structured /bot actions run|schema and /bot account status|forget aliases dispatch through the same established authorization and confirmation paths.',
  'implemented',
  ['/bot actions run', '/bot account status'],
);
exact(
  [7],
  ['Localize command names', 'Localize command descriptions'],
  [],
  'Spanish command-name and slash-description localizations, including structured groups/subcommands; canonical option names remain stable. No claim of every locale.',
  'implemented',
  ['src/discord/commands.ts'],
);
exact(
  [7],
  ['Restrict commands to specific roles', 'Restrict commands to specific channels'],
  ['system.action-policy.set', 'system.action-policy.list', 'system.action-policy.remove'],
  'Per-action enable/disable and role/channel allowlists are rechecked on request and confirmation, including after awaited authorization. Privacy/cancellation and policy recovery remain available.',
);

exact(
  [9],
  [
    'Detect users joining voice channels',
    'Detect users leaving voice channels',
    'Detect voice mute changes',
    'Detect voice deafen changes',
    'Detect supported streaming-state changes',
    'Detect supported camera-state changes',
  ],
  ['security.configure', 'workflow.set'],
  'Opt-in observed voice-state metadata and event workflows, subject to Voice States intent; no audio recording is implied.',
);
exact(
  [9],
  ['Generate voice attendance reports'],
  ['calendar.create', 'calendar.export', 'analytics.activity'],
  'Opt-in local calendar voice attendance and observed per-member voice duration. Disconnections, downtime and missing events create observation gaps.',
  'partial',
);

exact(
  [10],
  [
    'Send event reminders',
    'Maintain event calendars',
    'Create RSVP systems',
    'Track event attendance',
    'Create event waitlists',
    'Send post-event summaries',
  ],
  ['calendar.create', 'calendar.rsvp', 'calendar.checkin', 'calendar.export'],
  'Durable local event calendar with capacity/FIFO waitlists, self check-in, optional observed voice attendance, reminders and summary counts. Separate from native scheduled events.',
);
exact(
  [10],
  ['Schedule recurring reminders', 'Create scheduled announcements', 'Use cron-style scheduling'],
  ['schedule.set', 'schedule.list', 'schedule.remove'],
  'Five-field UTC cron supports integers/lists/ranges/steps with DOM/DOW OR semantics; missed intervals are skipped and delivery retries are bounded.',
);
exact(
  [10],
  ['Announce birthdays', 'Announce anniversaries'],
  ['celebration.configure', 'celebration.set', 'celebration.remove'],
  'Explicit member month/day opt-in and configured public UTC destination; no birth year retained.',
);
exact(
  [10],
  ['Assign temporary event roles'],
  ['temprole.assign'],
  'Explicit confirmed ordinary temporary role grants with durable expiry; not automatically synchronized to calendar membership.',
  'partial',
);
exact(
  [10],
  ['Organize tournaments'],
  ['tournament.create', 'tournament.result', 'tournament.view'],
  'Persistent 2–32-player single-elimination brackets with byes and staff-recorded validated match winners.',
);
exact(
  [10],
  ['Announce tournament schedules'],
  ['tournament.create', 'tournament.view', 'schedule.set'],
  'Publishes bracket rounds and supports separately configured timed text announcements; per-match tournament scheduling is not automatic.',
  'partial',
);
exact(
  [10],
  ['Trigger actions at specific times'],
  ['schedule.set', 'reminder.create'],
  'Timed authorized text announcements/reminders only; no arbitrary scheduled administrative action or host script runner.',
  'partial',
);
exact(
  [10],
  ['Execute daily maintenance jobs', 'Execute weekly maintenance jobs', 'Execute monthly maintenance jobs'],
  ['schedule.set'],
  'Cron announcements and internal bounded expiry/pruning/queue maintenance exist. No user-programmable maintenance-script executor.',
  'partial',
);
exact(
  [10],
  ['Send alerts when configured conditions are met'],
  ['workflow.set', 'security.configure', 'integration.watch'],
  'Explicit observed-event, security-threshold and public HTTPS/RSS monitor notification policies with current authorization.',
);

exact(
  [11],
  ['Retrieve current information through connected APIs'],
  ['integration.github', 'integration.weather', 'integration.http'],
  'Public GitHub/weather readers and confirmed-host bounded public HTTPS GET. No private account connector is implied.',
);
exact(
  [12],
  ['Generate CSV exports'],
  ['file.csv', 'analytics.observed.export', 'form.export'],
  'Spreadsheet-safe explicit tabular CSV and supported persisted analytics/form exports.',
);
exact(
  [12],
  ['Generate spreadsheets'],
  ['file.xlsx'],
  'Macro-free native XLSX with bounded typed literal cells, worksheets, header styling and a frozen header row; no formula execution.',
);
exact(
  [12],
  ['Generate Word documents'],
  ['file.docx'],
  'Native bounded DOCX with title, headings, paragraphs and bullet/number lists; not arbitrary Word automation.',
);
exact(
  [12],
  ['Generate presentation files'],
  ['file.pptx'],
  'Native bounded 16:9 PPTX title/bullet slides and page numbers; no automatic research or embedded multimedia.',
);
exact(
  [12],
  ['Read uploaded documents'],
  ['file.extract'],
  'Bounded text/CSV and DOCX/PPTX/XLSX text/cell extraction without executing macros, formulas or external links. PDFs/images use separate AI analysis.',
  'partial',
);
exact(
  [12],
  ['Convert files between formats'],
  ['file.convert', 'image.format'],
  'Supported CSV/XLSX tabular conversion and document text extraction to TXT/DOCX plus raster conversion; arbitrary document layouts and universal conversion are not supported.',
  'partial',
);
exact(
  [12],
  ['Analyze uploaded files'],
  ['file.extract', 'file.hash', 'pdf.info'],
  'Bounded supported document content, PDF metadata and exact-file hashes, plus optional supplied-image/PDF AI analysis; not every binary format.',
  'partial',
  ['/ask'],
);
exact(
  [12],
  ['Upload processed files into Discord'],
  ['file.xlsx', 'file.docx', 'file.pptx', 'image.format', 'pdf.report'],
  'Generated/processed bounded artifacts return real Discord attachment payloads. Discord upload limits and channel permissions apply.',
);

exact(
  [13],
  [
    'Play word games',
    'Run guessing games',
    'Create text adventures',
    'Create turn-based games',
    'Create collaborative puzzles',
    'Run boss battles',
  ],
  ['game.create', 'game.join', 'game.move', 'game.view'],
  'Persistent bounded hangman/word-chain/number-guess/adventure/tic-tac-toe/connect-four/puzzle/cooperative boss sessions; server/channel/player scope and revision checks apply.',
);
exact(
  [13],
  ['Run roleplaying games'],
  ['character.set', 'character.view', 'game.create'],
  'Persistent character classes/profiles, a fixed text adventure and cooperative boss. No unrestricted tabletop rules engine.',
  'partial',
);
exact(
  [13],
  ['Create AI-powered story games'],
  ['game.create', 'story.continue'],
  'Turn-based collaborative story sessions can request a bounded AI continuation with administrative tools disabled. Model output remains best effort.',
);
exact(
  [13],
  ['Run virtual pet systems'],
  ['pet.adopt', 'pet.view', 'pet.care'],
  'Persistent fictional pets with bounded time decay, feeding/play/sleep and cooldown/currency checks.',
);
exact(
  [13],
  ['Create collectible-card systems'],
  ['card.daily', 'shop.inventory'],
  'Daily random fictional cards persist as inventory stacks and can use supported item trading.',
);
exact(
  [13],
  [
    'Award fictional coins for participation',
    'Award achievement badges',
    'Create fictional jobs',
    'Create progression systems',
    'Track match results',
    'Track wins',
    'Track losses',
  ],
  ['game.stats', 'game.leaderboard', 'job.work'],
  'Built-in match statistics/badges, bounded daily match rewards and cooldown-based fictional work; no external game result validation.',
);
exact(
  [13],
  ['Implement virtual item trading'],
  ['trade.offer', 'trade.view', 'trade.accept', 'trade.cancel'],
  'Recipient-approved expiring bilateral fictional coin/item trades recheck holdings and settle atomically in SQLite.',
);
exact(
  [13],
  ['Manage crafting systems'],
  ['craft.recipe.set', 'craft.recipes', 'craft.make'],
  'Staff-configured bounded recipes atomically consume required inventory and grant output items.',
);
exact(
  [13],
  ['Create character profiles'],
  ['character.set', 'character.view'],
  'Bounded personal character names/classes/backgrounds and progression derived from stored server XP.',
);
exact(
  [13],
  ['Run competitions', 'Manage tournaments'],
  ['tournament.create', 'tournament.result', 'game.create'],
  'Built-in competitive game sessions and staff-recorded single-elimination brackets; no external game referee.',
);
exact(
  [13],
  ['Create team assignments', 'Generate randomized teams'],
  ['team.randomize'],
  'Randomizes an explicit bounded list of current server members into balanced teams; this does not enroll or notify members automatically.',
);
exact(
  [13],
  ['Display gaming leaderboards'],
  ['game.leaderboard'],
  'Built-in bot game results only; no external gaming service statistics.',
  'partial',
);

exact(
  [14],
  ['Build verification workflows', 'Maintain server rules displays'],
  ['verification.configure', 'verification.publish', 'verification.complete'],
  'Persistent rules acknowledgement panel, optional age/screening requirements and a currently safe ordinary verification role.',
);
exact(
  [14],
  ['Create knowledge-base search systems'],
  ['ai.knowledge.add', 'ai.knowledge.search'],
  'Personal permission-scoped semantic document store/search; no shared server support knowledge base or external account connector.',
  'partial',
);
exact(
  [14],
  [
    'Collect community feedback',
    'Run satisfaction surveys',
    'Run application forms',
    'Run recruitment forms',
    'Escalate applications for human review',
  ],
  ['form.create', 'form.publish', 'form.responses', 'form.review'],
  'Persistent typed forms, exact confirmed member submission, private authorized reviewer queue, optional staff notifications and spreadsheet-safe exports.',
);
exact(
  [14],
  ['Automatically process application submissions'],
  ['form.submit', 'form.review'],
  'Typed validation, quotas, durable queue and optional quiz scoring are automatic; staff approval/denial remains a confirmed human decision.',
  'partial',
);
exact(
  [14],
  ['Create suggestion systems', 'Enable suggestion voting', 'Track suggestion statuses'],
  ['suggestion.configure', 'suggestion.submit', 'suggestion.vote', 'suggestion.review'],
  'Persistent suggestions, one mutable vote per member, staff accept/deny/status and revision-safe public display updates.',
);
exact(
  [14],
  ['Accept anonymous submissions through controlled interfaces'],
  ['form.create', 'form.submit'],
  'Forms are private to submitter and authorized reviewers but retain Discord user IDs; true anonymous submission is not implemented.',
  'unimplemented',
);
exact(
  [14],
  ['Send opt-in reminders'],
  ['notification.subscribe', 'notification.remind', 'reminder.create'],
  'Own reminders and explicitly opted-in DMs with fresh consent/membership checks and cancellation.',
);
exact(
  [14],
  ['Run event signups', 'Run membership waiting lists'],
  ['calendar.create', 'calendar.rsvp'],
  'Local event RSVP capacity and FIFO waitlist only; no general recurring club/group membership roster.',
  'partial',
);
exact(
  [14],
  ['Create notification roles'],
  ['role.create', 'ui.roles.publish'],
  'Create an ordinary role and explicitly approved self-role button/dropdown opt-in. Mention notifications remain disabled by the message layer.',
  'partial',
);
exact(
  [14],
  ['Manage community rewards'],
  ['reward.roles.configure', 'economy.grant', 'giveaway.create'],
  'Built-in game/XP ordinary-role rewards, bounded fictional currency grants and giveaways; no real-money rewards.',
);

exact(
  [15],
  [
    'Track member joins',
    'Track member departures',
    'Measure membership changes',
    'Track available message counts',
    'Track voice-channel usage metadata',
    'Track channel activity',
    'Track available reaction statistics',
  ],
  ['security.configure', 'analytics.observed'],
  'Explicit opt-in observed Gateway aggregate counters and bounded per-member activity metadata. Missing intents, downtime and event gaps are not reconstructed.',
);
exact(
  [15],
  ['Count command usage', 'Measure command response times', 'Track command popularity'],
  ['analytics.command-latency', 'analytics.commands'],
  'Registered action execution counts and average elapsed time, including observed failures. This is not full slash-ack latency or a REST latency histogram.',
);
exact(
  [15],
  ['Monitor system resource usage'],
  ['analytics.resources'],
  'Current process CPU microseconds, memory categories, uptime and Gateway ping; no whole-host telemetry agent.',
);
exact(
  [15],
  ['Track event participation'],
  ['calendar.export', 'event.subscribers'],
  'Local event RSVP/check-in/optional observed voice attendance plus native scheduled-event interested member lists.',
);
exact(
  [15],
  ['Track moderation actions'],
  ['security.configure', 'security.logs', 'system.audit'],
  'Observed supported moderation/audit events and bot-dispatched action history; event gaps and unknown actors remain explicit.',
  'partial',
);
exact(
  [15],
  ['Track ticket resolution times', 'Track support ticket volumes'],
  ['analytics.summary'],
  'Stored ticket count/open status and average resolution from persisted creation/close timestamps.',
);
exact(
  [15],
  ['Detect activity spikes'],
  ['security.configure'],
  'Configured observed-message activity threshold/window alerts with throttling; no predictive model.',
);
exact(
  [15],
  ['Calculate configurable activity scores', 'Create leaderboards'],
  ['analytics.leaderboard', 'level.leaderboard', 'game.leaderboard'],
  'Observed message/voice weighted activity and stored XP/game rankings; personal tracking opt-out/erasure supported.',
);
exact(
  [15],
  ['Store historical analytics in databases', 'Compare weekly statistics', 'Compare monthly statistics'],
  ['analytics.observed', 'analytics.compare'],
  'SQLite UTC daily observed aggregates and current/prior 7/30-day comparisons within configured retention.',
);
exact(
  [15],
  ['Export data to CSV files'],
  ['analytics.observed.export', 'analytics.export', 'form.export'],
  'Spreadsheet-safe supported daily aggregate, action audit and form exports.',
);
exact(
  [15],
  ['Export data to spreadsheets'],
  ['analytics.observed.export', 'file.xlsx'],
  'Export aggregate CSV then convert supported tabular content to XLSX explicitly; no automatic one-step analytics workbook.',
  'partial',
);
exact(
  [15],
  ['Send administrator summaries'],
  ['analytics.summary'],
  'On-demand administration/support summary; scheduled delivery of computed reports is not implemented.',
  'partial',
);
exact(
  [15],
  ['Track connected service availability'],
  ['integration.watch', 'integration.watch-list'],
  'Confirmed-host public HTTPS uptime monitoring and change notifications; private services require another connector.',
);
exact(
  [15],
  ['Track external website statistics'],
  ['integration.watch'],
  'Public HTTPS availability/content changes only; no authenticated traffic, visitor or conversion analytics.',
  'partial',
);

exact(
  [16],
  ['Connect to GitHub', 'Retrieve repository commits'],
  ['integration.github'],
  'Read public repository metadata/recent commits without another credential. Private repositories and mutations require additional authorization.',
  'partial',
);
exact(
  [16],
  ['Monitor repository releases', 'Post pull-request notifications', 'Report CI/CD build results'],
  ['integration.github', 'integration.watch'],
  'On-demand public release/pull/Actions-run metadata; confirmed public feed/content monitoring can notify changes. No authenticated GitHub webhook subscription or dedicated per-item notification policy.',
  'partial',
);
exact(
  [16],
  ['Connect to development tools'],
  ['integration.github'],
  'Public GitHub repository/commit/release/pull/CI readers only; no general authenticated development-tool connector.',
  'partial',
);
exact(
  [16],
  ['Receive RSS feeds', 'Monitor website changes', 'Monitor website uptime'],
  ['integration.hosts', 'integration.rss', 'integration.watch'],
  'Explicit confirmed public HTTPS hosts; bounded RSS/Atom, content-hash and uptime monitors with silent baseline and capped delivery retries.',
);
exact(
  [16],
  ['Query REST APIs', 'Send HTTP requests to authorized services'],
  ['integration.hosts', 'integration.http'],
  'Bounded public HTTPS GET from confirmed exact hosts only, no credentials/custom headers/redirects/private addresses or mutations.',
  'partial',
);
exact(
  [16],
  ['Create webhooks'],
  ['webhook.create'],
  'Creates a Discord channel webhook; no arbitrary external provider webhook registration.',
);
exact(
  [16],
  ['Receive webhooks'],
  ['webhook.events.status'],
  'Signed Discord outgoing webhook receiver with durable inbox only. Generic external service webhook schemas and shared-secret authorization are not included.',
  'partial',
  ['POST /discord/events'],
);
exact(
  [16],
  ['Query weather APIs'],
  ['integration.weather'],
  'Public Open-Meteo current modeled conditions at explicit latitude/longitude with source/time/units and bounded caching.',
);
exact(
  [16],
  ['Monitor computer telemetry', 'Monitor server telemetry'],
  ['analytics.resources'],
  'Current bot process CPU/memory/uptime and Gateway latency only; no remote host telemetry collector.',
  'partial',
);
exact(
  [16],
  ['Receive cybersecurity alerts'],
  ['security.configure'],
  'Local observed Discord security policy alerts only; no external security product alert connector.',
  'partial',
);

exact(
  [17],
  ["Change the bot's username", "Change the bot's global avatar", 'Change supported bot profile details'],
  ['bot.profile.global', 'bot.application.profile'],
  'Application owner/configured operator confirmed global username/avatar/banner and application description/tag updates; Discord eligibility/rate limits apply.',
);
exact(
  [17],
  ['Configure supported per-server bot profiles'],
  ['bot.profile.guild'],
  'Confirmed server bot nickname/avatar/banner/bio edits with Manage Server; Discord eligibility applies.',
);
exact(
  [17],
  [
    'Set online presence',
    'Set idle presence',
    'Set do-not-disturb presence',
    'Set invisible presence',
    'Display supported game activity',
    'Display supported watching activity',
  ],
  ['bot.presence'],
  'Owner-only persisted global presence and supported activity types are restored at ready.',
);
exact(
  [17],
  [
    'Open DM conversations with eligible users',
    'Respond to direct messages',
    'Create personalized DM workflows',
    'Let users opt into notifications',
    'Send permitted DM reminders',
  ],
  ['notification.subscribe', 'notification.remind', 'notification.cancel'],
  'Explicit per-user/server DM consent, conversational AI without administration tools and durable own reminders. Membership/access/consent are rechecked; STOP revokes personal DMs.',
);
exact(
  [17],
  ['Support Discord Linked Roles'],
  ['bot.linked-role.metadata'],
  'Owner metadata schema registration exists; user OAuth linking and per-user role connection updates are not implemented.',
  'partial',
);

exact(
  [18],
  ['Create channel webhooks'],
  ['webhook.create'],
  'Creates a supported channel webhook with current channel permissions and explicit confirmation.',
);
exact(
  [18],
  [
    'Receive external events through HTTP servers',
    'Handle Discord outgoing webhook events',
    'Validate signed event requests',
  ],
  ['webhook.events.status'],
  'Opt-in POST /discord/events validates Ed25519 signature, timestamp freshness, raw bounded body and application ID, responds to PING and persists a deduplicated inbox before acknowledgement. Public HTTPS hosting/Portal subscription is still required.',
  'implemented',
  ['POST /discord/events'],
);
exact(
  [18],
  [
    'React to new messages',
    'React to message edits',
    'React to message deletions',
    'React to reaction additions',
    'React to reaction removals',
    'React to member joins',
    'React to member departures',
    'React to role changes',
    'React to channel changes',
    'React to thread changes',
    'React to scheduled-event changes',
    'React to poll events',
    'React to voice-state changes',
  ],
  ['workflow.set', 'workflow.jobs'],
  'Explicit supported Gateway event policies queue bounded message/thread/ordinary-role steps with author/channel checks and event deduplication; required intents and event data apply.',
);
exact(
  [18],
  ['React to entitlement events', 'React to subscription events'],
  ['workflow.set'],
  'Gateway trigger names exist, but only events carrying an attributable installed guild can route to a guild policy; nonguild events require application-level handling and monetization setup.',
  'partial',
);
exact(
  [18],
  [
    'Trigger multiple workflows from one event',
    'Queue tasks for later processing',
    'Create event-driven notifications',
  ],
  ['workflow.set', 'workflow.jobs'],
  'Multiple matching policies persist bounded jobs and resume individually authorized message/thread/ordinary-role steps after restart.',
);
exact(
  [18],
  ['Retry failed operations'],
  ['workflow.jobs', 'schedule.set', 'notification.remind'],
  'Durable workflow/schedule/notification retries are bounded with backoff and revocation checks. Arbitrary destructive mutations are not blindly retried.',
);
exact(
  [18],
  ['Maintain event logs'],
  ['security.configure', 'security.logs', 'workflow.jobs'],
  'Opt-in bounded supported Gateway metadata, retained workflow results and signed webhook inbox state; no exhaustive immutable event archive.',
);
exact(
  [18],
  ['Detect duplicate events', 'Prevent duplicate actions'],
  ['workflow.set', 'webhook.events.status'],
  'Persistent signed-body/event fingerprints, saved step progress, one-use confirmations and stable message nonces suppress supported repeats. No exactly-once network effect guarantee.',
  'partial',
);
exact(
  [18],
  ['Build automated approval chains'],
  ['form.review'],
  'Confirmed member submissions and staff review plus per-action approvals exist. Configurable multi-reviewer chained approval state machines are not implemented.',
  'partial',
);

exact(
  [20],
  [
    'Handle entitlement creation events',
    'Handle entitlement removal events',
    'Handle subscription lifecycle events',
  ],
  ['workflow.set'],
  'Supported guild-attributed Gateway events can trigger configured notifications; full per-user premium state/gates/lifecycle are not implemented and monetization setup is required.',
  'partial',
);
exact(
  [20],
  ['Display premium purchase opportunities'],
  ['ui.message.publish'],
  'Existing application SKU purchase buttons can be displayed. SKU creation, eligibility, payout onboarding and commerce remain external setup.',
  'partial',
);
exact(
  [20],
  ['Offer free functionality'],
  ['system.features'],
  'Registered bot features do not impose a bot subscription gate; hosting and optional OpenAI API costs remain the operator’s responsibility.',
);

exact(
  [21],
  ['Use job queues'],
  ['workflow.jobs', 'reminder.list'],
  'Bounded durable SQLite workflow, reminder, schedule and webhook inbox queues in one process; no distributed queue broker.',
);
exact(
  [21],
  ['Use background workers', 'Scale across multiple CPU cores'],
  [],
  'Bounded worker_threads perform image/PDF/document processing away from the Gateway loop; the application and SQLite scheduler remain single-process.',
  'partial',
  ['src/features/media.ts', 'src/features/files.ts'],
);
exact(
  [21],
  ['Cache frequently accessed resources'],
  ['integration.github'],
  'Bounded short-lived public integration response cache with identical-request coalescing; Discord caches are configured and authority is fetched freshly.',
);
exact(
  [21],
  ['Measure CPU consumption'],
  ['analytics.resources'],
  'Reports cumulative process CPU microseconds together with current process memory, uptime and Gateway latency.',
);
exact(
  [21],
  ['Monitor API latency'],
  ['analytics.command-latency', 'analytics.resources'],
  'Registered action execution averages and Gateway ping; no endpoint-specific REST/OpenAI latency histograms.',
  'partial',
);
exact(
  [21],
  ['Automatically restart after crashes'],
  [],
  'Docker Compose restart policy is supplied; it requires a deployed Docker runtime and is not a running local supervisor.',
  'partial',
  ['compose.yaml'],
);

exact(
  [22],
  ['Security and anti-raid protection'],
  ['security.configure', 'security.lockdown.apply'],
  'Opt-in join/structural/content heuristics, staff review, bounded invite pause and scoped recoverable lockdown. Not complete anti-nuke undo or external reputation scanning.',
  'partial',
);
exact(
  [22],
  ['Interactive menus and forms'],
  ['form.create', 'ui.roles.publish', 'ui.settings.publish'],
  'Persistent typed multi-step forms, roles/tickets/settings/staff panels and Components V2 messages. External web/Activity interfaces are separate.',
);
exact(
  [22],
  ['Games and entertainment'],
  ['game.create', 'pet.adopt', 'trade.offer', 'tournament.create'],
  'Built-in persistent text/board games, pets/cards, crafting/trading and staff-managed brackets; no external game connectors or graphical Activity frontend.',
  'partial',
);
exact(
  [22],
  ['File conversion', 'Document generation', 'Document analysis'],
  ['file.convert', 'file.xlsx', 'file.docx', 'file.pptx', 'file.extract'],
  'Bounded supported Office/tabular/text generation/extraction/conversion, PDF utilities and raster transforms. Not arbitrary document layout conversion or every format.',
  'partial',
);
exact(
  [22],
  ['Third-party service integrations'],
  ['integration.github', 'integration.weather', 'integration.rss', 'integration.http'],
  'Public GitHub/weather, confirmed-host RSS/HTTPS readers and monitors. Private SaaS/Google/email/cloud accounts remain separate integrations.',
  'partial',
);
exact(
  [22],
  ['Webhook processing'],
  ['webhook.events.status', 'workflow.set'],
  'Signed Discord outgoing webhook HTTP inbox and supported guild-attributed workflows; public HTTPS hosting and Portal subscription required.',
  'partial',
);
exact(
  [22],
  ['Gateway event handling'],
  ['workflow.set', 'security.configure'],
  'Supported permission-scoped Gateway observers, event workflows and opt-in analytics; intents and event coverage are explicitly bounded.',
);
exact(
  [22],
  ['Automated infrastructure monitoring'],
  ['integration.watch', 'analytics.resources'],
  'Public HTTPS uptime/content monitors and local bot process telemetry; no private remote host/cloud administration agent.',
  'partial',
);

exact(
  [4],
  ['Automatically expire bot-managed punishments'],
  ['member.timeout'],
  'Discord-native communication timeout deadlines expire on Discord. Temporary bans and other generalized timed punishments are not implemented.',
  'partial',
);
exact(
  [5],
  ['Detect repeated identical messages'],
  ['community.configure'],
  'Opt-in custom antispam fingerprints recent normalized messages, detects repetitions in a bounded window and can delete a flagged message. Message Content access is required.',
);
exact(
  [6],
  ['Relay messages between authorized channels'],
  ['message.forward'],
  'Explicitly confirmed forwarding between currently authorized source/destination channels. Continuous automatic relays are not implemented.',
  'partial',
);
exact(
  [6],
  ['Convert uploaded media between formats'],
  ['image.format', 'audio.convert', 'video.convert'],
  'Bounded supported raster, audio and video attachment conversion. FFmpeg/FFprobe are required for audio/video; unsupported or non-streamable containers are rejected.',
);
exact(
  [9],
  ['Play supported audio streams', 'Stream authorized audio sources'],
  ['voice.play'],
  'Uploaded bounded PCM16 WAV is streamed into the joined voice connection; remote streaming providers, arbitrary local paths and playlist services are not implemented.',
  'partial',
);
exact(
  [9],
  ['Process audio using compression and equalization'],
  ['audio.convert'],
  'Bounded MP3/Opus/FLAC conversion, bitrate/trim and volume control. Equalizer bands and dynamic-range compression are not implemented.',
  'partial',
);
exact(
  [9],
  ['Apply audio effects'],
  ['audio.convert'],
  'Bounded volume adjustment and trimming only; no arbitrary effect graph.',
  'partial',
);
exact(
  [10],
  ['Run timed polls'],
  ['poll.create', 'poll.end'],
  'Native Discord poll duration is configurable from 1 to 768 hours and finalizes on Discord; an authorized bot-owned poll can also be ended explicitly.',
);
exact(
  [10],
  ['Synchronize external calendars'],
  [],
  'No authenticated calendar-provider connector is included. Provider OAuth and endpoint-specific synchronization plus callback hosting must be implemented/configured.',
  'external_setup',
);
exact(
  [12],
  ['Generate thumbnails'],
  ['video.thumbnail', 'image.resize'],
  'Extract a bounded video timestamp as PNG or resize a supplied raster. FFmpeg input/output and dimensions/time limits apply.',
);
exact(
  [12],
  ['Generate rank cards'],
  ['image.card', 'level.profile'],
  'Query a member XP profile then supply explicit rank-card text/progress. Automatic profile-to-image binding is not implemented.',
  'partial',
);
exact(
  [12],
  ['Compress video files', 'Trim video files', 'Generate video clips'],
  ['video.convert'],
  'Bounded uploaded MP4/WebM first-video-stream trim, resize, compression and optional mute. Input must be streamable; output at most 120 seconds/8 MiB and selected dimensions.',
);
exact(
  [12],
  ['Extract audio from videos', 'Convert audio formats', 'Trim audio files'],
  ['audio.convert'],
  'Bounded first audio stream extraction/trim to MP3, Opus/Ogg, WAV or FLAC; at most 120 seconds/8 MiB, selected bitrates and no arbitrary source paths.',
);
exact(
  [12],
  ['Create subtitle files'],
  ['media.subtitles'],
  'Real SRT or WebVTT from explicit ordered non-overlapping timed text segments; automatic timestamped transcription is separate.',
);
exact(
  [12],
  ['Prepare soundboard files'],
  ['audio.convert', 'soundboard.create'],
  'Convert an attachment to a trimmed bounded MP3/Opus clip, then use explicit soundboard upload. The operator must choose duration and size matching Discord eligibility.',
  'partial',
);
exact(
  [15],
  ['Generate server activity charts'],
  ['analytics.observed', 'chart.bar'],
  'Query observed counters and provide explicit selected values to the bounded bar-chart renderer. Automatic chart aggregation/binding is not implemented.',
  'partial',
);
exact(
  [21],
  ['Monitor bot uptime'],
  ['system.status', 'analytics.resources'],
  'Current bot process uptime and optional /health and /ready HTTP probes. External downtime detection requires a separate running monitor.',
);
exact(
  [17],
  ['Require specific roles for dashboard actions'],
  [],
  'No external dashboard/OAuth login server is included. Role-gated Discord staff panels do not supply web dashboard authorization.',
  'external_setup',
);
exact(
  [22],
  ['Video processing'],
  ['video.convert', 'video.thumbnail', 'audio.convert'],
  'Bounded uploaded MP4/WebM processing with FFmpeg: trim, resize, compression, thumbnail and audio extraction. No external video generation provider.',
  'partial',
);
exact(
  [22],
  ['Discord Activities', 'Embedded graphical applications'],
  [],
  'Requires a separately implemented hosted Activity/frontend, Embedded App SDK and application configuration; no Activity frontend is included.',
  'external_setup',
);
exact(
  [22],
  ['Premium features', 'Monetization systems'],
  ['premium.skus', 'premium.entitlements', 'ui.message.publish'],
  'Reads existing SKU/entitlement data and can render eligible purchase buttons. Product setup, premium feature enforcement, purchase lifecycle and payouts are not implemented.',
  'external_setup',
);
exact(
  [22],
  ['External web dashboards'],
  [],
  'No external web dashboard or OAuth session service is included. This requires a separately implemented hosted frontend and authorized backend.',
  'external_setup',
);

exact(
  [3],
  ['Implement role-based access control', 'Manage role-based command access'],
  ['system.action-policy.set', 'system.action-policy.list', 'system.ai.access'],
  'Current Discord permissions, per-action enabled/role/channel policies and separate AI role access are checked at request and confirmation. Privacy/cancellation and policy recovery remain available.',
);
exact(
  [3],
  ['Restore saved role assignments when members rejoin'],
  ['membership.roles.configure', 'membership.roles.consent', 'membership.roles.view'],
  'Only explicitly opted-in member roles approved by a manager are captured/restored. Current author/bot/target membership, ordinary-role flags, hierarchy, policy version and consent are rechecked on durable restoration.',
);
exact(
  [4],
  ['Send onboarding direct messages'],
  ['membership.onboarding.configure', 'membership.onboarding.start'],
  'A member explicitly requests their configured onboarding DM after personal DM opt-in. No unsolicited newcomer DM broadcast is sent.',
);
exact(
  [4],
  ['Prune inactive members'],
  ['guild.prune-count', 'guild.prune'],
  'Owner-only confirmed native prune executes only after a fresh count equals the explicitly reviewed expected count. Discord selects eligible inactive members.',
);
exact(
  [6, 11],
  ['Summarize discussions', 'Summarize conversations', 'Answer questions using accessible message history'],
  ['ai.summarize.messages'],
  'Summarizes up to 100 accessible recent messages within a bounded excerpt and returns source IDs. Current view/history permissions apply and omitted/older content remains explicit.',
  'partial',
);
exact(
  [9],
  ['Create music playlists'],
  ['voice.playlist-save', 'voice.playlist-list', 'voice.playlist-play'],
  'Personal persisted playlists reference up to five validated Discord-uploaded PCM16 WAV tracks. Every source is reauthorized at playback; no external music provider library.',
);
exact(
  [9],
  ['Produce voice meeting summaries'],
  ['voice.consent', 'voice.meeting-summary'],
  'Private bounded summaries of current participants’ explicitly opted-in in-memory meeting excerpts. Consent and disclosed transcript-channel access are rechecked; no persistent raw recording.',
);
exact(
  [11],
  ['Search connected knowledge bases'],
  ['ai.knowledge.add', 'ai.knowledge.search', 'ai.knowledge.list'],
  'Personal server/user-scoped saved text documents with semantic search. No shared server-wide or authenticated external knowledge connector.',
  'partial',
);
exact(
  [11],
  ['Use retrieval-augmented generation'],
  ['ai.knowledge.add', 'ai.knowledge.ask'],
  'Explicit private knowledge question retrieves up to three bounded semantic source excerpts and generates a source-named answer without administrative tools, personal preferences or retained history.',
);
exact(
  [15],
  ['Generate scheduled reports', 'Send administrator summaries'],
  ['report.preview', 'report.schedule.set', 'report.schedule.list', 'report.schedule.remove'],
  'Daily, Monday weekly or first-of-month UTC aggregate reports to an everyone-hidden staff channel. Actual retained activity/audit/moderation/ticket/giveaway/resource data, bounded attachment and durable authorized capped retries.',
);
exact(
  [11],
  ['Generate reports using database information'],
  ['report.preview', 'analytics.summary', 'analytics.observed.export'],
  'Fixed bounded reports over retained bot SQLite analytics/audit/community records. No unrestricted SQL or arbitrary external database agent.',
);
exact(
  [14],
  ['Transfer tickets between staff members'],
  ['ticket.transfer'],
  'Current authorized support staff transfer a ticket to another eligible current staff member after confirmation.',
);
exact(
  [14],
  ['Prioritize support tickets', 'Tag tickets'],
  ['ticket.update'],
  'Current authorized ticket staff set bounded priority and tags in durable ticket metadata.',
);
exact(
  [14],
  ['Categorize tickets'],
  ['ticket.category', 'ticket.update'],
  'Confirmed ticket-channel category movement and bounded tags/priority metadata with fresh ticket/category access checks.',
);
exact(
  [14],
  ['Archive tickets'],
  ['ticket.archive'],
  'Explicitly archived ticket state with retained channel/history and staff/current visibility checks. No external archival storage.',
  'partial',
);
exact(
  [14],
  ['Assign tickets to staff members'],
  ['ticket.claim', 'ticket.transfer'],
  'Current support staff can claim or explicitly transfer a ticket to an eligible staff member.',
);
exact(
  [14],
  ['Run satisfaction surveys'],
  ['form.create', 'ticket.rate', 'ticket.feedback'],
  'Typed survey forms and one owner rating/comment for a closed/archived ticket within the bounded feedback window.',
);
exact(
  [14],
  [
    'Create club enrollment systems',
    'Create group enrollment systems',
    'Run membership waiting lists',
    'Manage team registration',
  ],
  ['group.configure', 'group.enroll', 'group.leave'],
  'Capacity-limited explicit club/group/team enrollment, FIFO waiting lists, manager roster access and own erasure. Local membership records do not grant Discord roles or send DMs.',
);
exact(
  [14],
  ['Coordinate volunteer assignments', 'Coordinate staff assignments'],
  ['group.configure', 'group.assignment.set', 'group.assignment.respond', 'group.assignment.list'],
  'Current manager proposes local tasks to explicitly enrolled members; target accepts/declines/completes. Bounded role-gated local tracking grants no Discord staff authority.',
);
exact(
  [14],
  ['Create question-of-the-day posts'],
  ['engagement.questions.set', 'engagement.questions.list', 'engagement.questions.remove'],
  'Explicit supplied questions rotate in durable daily UTC post jobs; current manager/channel checks, capped retries, version cancellation and skipped missed intervals.',
);
exact(
  [14],
  ['Announce community milestones'],
  ['engagement.milestone.set', 'engagement.milestone.list', 'engagement.milestone.remove'],
  'Observed member-count thresholds above a silent configured baseline queue once-only announcements. Missing intents/events can delay observation; no inferred historical milestone timestamp.',
);
exact(
  [22],
  ['Community engagement'],
  ['group.enroll', 'engagement.questions.set', 'engagement.milestone.set', 'suggestion.submit'],
  'Persistent opt-in enrollment/waitlists, accepted local assignments, questions/milestones, forms, suggestions, safe rewards and event signups; selected bounds remain explicit.',
  'partial',
);

exact(
  [4],
  ['Automatically escalate penalties'],
  ['warning.configure', 'warning.issue', 'warning.jobs', 'warning.job.cancel'],
  'Only explicitly issued warnings count toward a configured threshold/window and bounded temporary timeout. Native/generic cases do not trigger escalation; current moderator, target, policy and bot authority are rechecked before queued execution.',
  'partial',
);
exact(
  [4],
  ['Send customized violation notices'],
  ['warning.configure', 'warning.issue', 'warning.jobs'],
  'Explicit warning reason/case notices are queued to a configured target-visible channel or personally consented DM. Delivery is chosen for each warning, currently authorized and bounded; there is no unsolicited DM broadcast.',
);
exact(
  [6],
  ['Automatically translate messages'],
  ['translation.configure', 'translation.consent', 'translation.optout'],
  'Opt-in same-channel AI translation requires the author’s explicit consent to the exact configured target-language policy. Bounded recent source messages, fresh access/consent checks, cooldowns and output labels apply; translations are best effort.',
);
exact(
  [6],
  ['Automatically format text'],
  ['formatter.configure'],
  'Configured same-channel replies format explicit prefix requests as code blocks, lists or quotations. Original messages remain; arbitrary automatic rewriting and message replacement are not included.',
);
exact(
  [6],
  ['Automatically update status panels'],
  ['statuspanel.create', 'statuspanel.bind', 'statuspanel.list', 'statuspanel.remove'],
  'Durable bindings periodically edit an exact bot-authored message with process uptime and Gateway latency. Current configuring-manager/channel policies are checked; uncertain creation requires explicit reconciliation.',
);
exact(
  [7],
  ['Create commands usable in direct messages', 'Create user-installable commands'],
  ['notification.subscribe'],
  'Optional ENABLE_USER_INSTALL exposes help/schema/status/forget/ask in supported personal contexts. Personal AI requires consent and current membership in an allowed installed server; administrative actions remain guild routes. Portal installation settings and global command deployment are required.',
  'partial',
  ['src/discord/commands.ts', 'src/discord/personal.ts'],
);
exact(
  [17],
  ['Support user-installed applications', 'Provide user-installed commands in supported group-chat contexts'],
  ['notification.subscribe'],
  'Opt-in UserInstall and PrivateChannel command contexts route personal help/schema/status/forget/ask without creating an administrative guild context. Personal AI still requires consent and current eligible installed-server membership. Portal settings/global command deployment are required; no external-account OAuth linking is provided.',
  'partial',
  ['src/discord/commands.ts', 'src/discord/personal.ts'],
);
exact(
  [12],
  ['Find images using search APIs', 'Search GIF providers'],
  ['image.search', 'gif.search'],
  'Bounded public Wikimedia Commons raster/GIF catalog search returns source, artist and license metadata plus expiring member/channel-bound selections. Commons GIF files are supported; Giphy/Tenor are not integrated.',
);
exact(
  [12],
  ['Send discovered GIFs'],
  ['gif.search', 'media.search-send'],
  'Explicitly confirmed Commons GIF selections are size/type inspected and uploaded with attribution. Selection ownership, current channel permissions, expiry and one-use state are checked; uncertain sends are not automatically repeated.',
);
exact(
  [12],
  ['Generate animated graphics'],
  ['image.animate'],
  'Creates a real animated GIF from 2–12 explicitly supplied Discord raster frames within shared input/output, dimension and worker bounds. Animated source files contribute their first frame; no AI video generation.',
);
exact(
  [12],
  ['Prepare sticker files'],
  ['image.sticker'],
  'Produces a bounded 320×320 PNG on a transparent canvas, preserving existing alpha. Animated inputs use their first frame; automatic background removal and animated sticker formats are not provided.',
);
exact(
  [16],
  ['Query GraphQL APIs'],
  ['integration.hosts', 'integration.graphql-get'],
  'Exact confirmed bounded public GraphQL GET query/variables to an approved HTTPS hostname. No authentication, POST, subscriptions, redirects, private networks or automatic retries. GET does not prove the remote service has no side effects.',
  'partial',
);
exact(
  [16],
  ['Query currency APIs'],
  ['integration.currency'],
  'Frankfurter v2 dated reference rates and bounded amount-conversion estimates with source/date. Cached reference rates are not live intraday quotes, settlement guarantees or a financial ledger.',
);
exact(
  [16],
  ['Query financial information APIs'],
  ['integration.currency'],
  'Only dated Frankfurter currency reference rates and bounded conversion estimates. Securities, account balances, order execution and other financial data services are not implemented.',
  'partial',
);
exact(
  [13],
  ['Track game server status'],
  ['integration.hosts', 'integration.minecraft-status'],
  'On-demand bounded direct Minecraft Java status for an approved public hostname on TCP 25565, with version/player counts/MOTD/response time. No custom ports, SRV, Bedrock, RCON, player identities or historical status monitor.',
);
exact(
  [16],
  ['Monitor game servers', 'Query gaming statistics'],
  ['integration.hosts', 'integration.minecraft-status'],
  'On-demand public Minecraft Java status and online/maximum player counts on TCP 25565 only. No periodic game-server alert policy, historical/player achievements, custom ports, SRV, Bedrock or RCON.',
  'partial',
);
exact(
  [16],
  ['Execute approved commands on the hosting machine', 'Run scheduled scripts'],
  ['operation.tasks', 'operation.run', 'operation.schedule.set', 'operation.history'],
  'Owner-only exact-hash approval of locally supplied fixed executable/arguments/cwd task definitions, optionally on UTC cron. Discord cannot supply shell text, arguments, paths or environment. Subprocess/output/time limits and redacted history apply; failed or unknown outcomes pause schedules without automatic retry.',
);
exact(
  [16],
  ['Control authorized local applications', 'Start approved local services', 'Stop approved local services'],
  ['operation.tasks', 'operation.run', 'operation.history'],
  'Can invoke only an owner-installed fixed executable/task definition for a locally authorized application or service operation. No generic remote application UI, arbitrary shell, process discovery, service-state controller or distributed host agent is included.',
  'partial',
);
exact(
  [10],
  ['Trigger actions at specific times'],
  ['schedule.set', 'reminder.create', 'operation.schedule.set'],
  'Durable timed reminders/announcements and owner-approved fixed local tasks on UTC cron. Arbitrary scheduled Discord administrative action plans are not included.',
  'partial',
);
exact(
  [10],
  ['Execute daily maintenance jobs', 'Execute weekly maintenance jobs', 'Execute monthly maintenance jobs'],
  ['operation.tasks', 'operation.schedule.set', 'operation.schedule.list', 'operation.schedule.remove'],
  'Owner-approved fixed local task definitions can use daily/weekly/monthly UTC cron schedules. Current owner/policy/hash checks precede execution; failure or unknown host outcomes pause the schedule without automatic retries.',
);
exact(
  [21],
  ['Organize features into plugins'],
  [],
  'Explicitly configured trusted local plugins/<id>/index.js modules register bounded validated action definitions through staged startup loading and cleanup. Full process trust is required; no sandbox, remote download, hot reload or untrusted plugin execution.',
  'implemented',
  ['src/core/plugins.ts', 'src/app.ts'],
);
exact(
  [22],
  ['External application automation'],
  ['operation.tasks', 'operation.run', 'operation.schedule.set'],
  'Owner-configured fixed local executable invocations and UTC schedules only. No general application UI control, private SaaS account automation or remote host administration agent.',
  'partial',
);
exact(
  [16],
  ['Restart the bot through a process supervisor'],
  ['system.restart'],
  'Owner/operator-confirmed graceful restart is available only under the bundled supervisor. Shutdown drains tracked work and the supervisor relaunches the compiled entry with a restart-rate bound; successful Discord reconnection still requires valid runtime configuration.',
  'implemented',
  ['start:supervised', 'scripts/supervise.mjs'],
);
exact(
  [21],
  ['Automatically restart after crashes'],
  [],
  'The optional bundled supervisor relaunches exited child processes with bounded exponential backoff and at most ten restarts per rolling hour. Planned restarts are distinguished from failures; shutdown forwards signals/Windows IPC and has a bounded grace period. It does not detect a live-but-hung process.',
  'implemented',
  ['start:supervised', 'scripts/supervise.mjs'],
);
exact(
  [18],
  ['React to authorized presence changes'],
  ['workflow.set', 'workflow.jobs'],
  'Optional ENABLE_PRESENCES and the required Portal privileged intent allow installed-server presenceUpdate workflows. Policies can match the observed status keyword; bounded event fingerprints can suppress repeated same-status/activity updates within five seconds. Disabled by default; no presence history or user surveillance dashboard.',
);
exact(
  [10],
  ['Provide event countdowns'],
  ['calendar.list'],
  'Visible local calendar entries return computed nonnegative seconds until their scheduled start when queried. No continuously ticking graphical countdown or native-event synchronization.',
);
exact(
  [10],
  ['Automatically open event channels', 'Automatically close event channels'],
  ['eventchannel.configure', 'eventchannel.list', 'eventchannel.pause', 'eventchannel.reconcile'],
  'A native scheduled-event policy opens one private category-bound text channel before its start, then hides/locks/archives it after its scheduled end or observed completion/cancellation. Current manager, bot, ordinary-role and policy authority are checked. Content is retained; uncertain creation requires exact reservation reconciliation and changed overwrites stop closure.',
);
exact(
  [14],
  ['Create ticket threads'],
  ['ticket.thread-configure', 'ticket.thread-open', 'ticket.thread-close', 'ticket.thread-reconcile'],
  'Separate owner-requested bot-owned private threads use an approved text parent and 1–5 current staff users under an exact reviewed configuration version. Durable unique creation reservations, ID-before-invite persistence, bounded idempotent invitations and explicit uncertainty recovery. Close locks/archives without deletion; this flow does not inherit all channel-ticket metadata features.',
);
exact(
  [11],
  ['Automatically categorize support tickets'],
  ['ticket.ai.configure', 'ticket.ai.classify', 'ticket.ai.view'],
  'Opt-in future private channel-ticket subjects receive an advisory AI label from an approved taxonomy, using the configuring manager’s quota, at most one billed classification per cycle without automatic paid retry. No ticket content analysis, channel movement, priority changes or thread-ticket classification.',
  'partial',
);
exact(
  [13],
  ['Run streak-reward systems'],
  ['economy.daily', 'economy.streak'],
  'Transactional fictional daily-claim streaks persist current/best counts. Claims are at least 24 hours apart, a gap beyond 48 hours resets the streak, and every seventh consecutive claim adds a fixed 50-coin bonus. No real-money or arbitrary streak policy engine.',
);
exact(
  [9],
  ['Play locally stored audio files'],
  ['voice.library', 'voice.library-play'],
  'Fixed operator-approved local library exposes at most 50 safe WAV IDs; playback validates real paths and bounded PCM16 content through the existing authorized server voice queue. Discord cannot supply arbitrary local paths or URLs.',
);
exact(
  [9],
  ['Interpret voice commands using speech recognition'],
  ['voice.consent', 'voice.pause', 'voice.resume', 'voice.skip', 'voice.volume'],
  'Individual transcription consent and the configured wake name gate spoken requests and short related follow-ups. Commands-only consent uses deterministic controls; conversational reply consent also admits natural action requests to typed AI tools under current member/bot permissions, policies and cancellation leases. Transcripts remain in a verified private channel and spoken output uses public-safe tools without personal preferences. Smart confirmation mode executes eligible ordinary requests directly; destructive or authority-sensitive actions retain one member/channel-bound confirmation that can be answered naturally. Stop/revoke act immediately.',
  'partial',
  ['src/discord/voice-commands.ts'],
);
exact(
  [9],
  ['Translate spoken languages'],
  ['voice.consent'],
  'An individually consenting speaker can select one of eleven target-language codes for bounded utterance transcription, isolated AI translation and synthetic speech. Consent, current voice/text access and session generation are checked before delivery. This is best-effort utterance translation, not simultaneous interpretation of everyone in a channel.',
);
exact(
  [9],
  ['Run voice-based games', 'Run audio trivia games'],
  ['voice.trivia-start', 'voice.trivia-answer', 'voice.trivia-status', 'voice.trivia-stop'],
  'Eight fixed known-answer spoken trivia questions use synthetic speech, sixty-second answers, three guesses per member and bounded in-memory session scores. Answers use typed actions or individually consented, addressed speech. Trivia writes follow the registry confirmation mode: eligible current-user requests execute directly in smart mode, while always mode requests confirmation. No general real-time voice-game engine.',
);
exact(
  [9],
  ['Create audio-based alerts'],
  ['voice.alert'],
  'Explicit confirmed notice/success/warning tones enqueue deterministic short PCM audio in the currently authorized server voice session. No automatic audio threshold policy or external alert provider.',
);
exact(
  [8],
  ['Create interactive search-result interfaces'],
  ['image.search', 'gif.search', 'media.search-send', 'dashboard.login'],
  'Commons image/GIF results render up to five selectable Discord buttons. A selection is member/server/channel-bound and expiry/state checked before proposing the exact media-send confirmation. The optional owner/operator dashboard also searches the action catalog with selectable schema details; no arbitrary search-provider interface builder.',
  'implemented',
  ['src/discord/presentation.ts', 'src/app.ts', 'src/discord/dashboard-page.ts'],
);
exact(
  [15],
  ['Build web-based analytics dashboards'],
  ['dashboard.login', 'analytics.observed'],
  'Optional owner/operator dashboard displays seven UTC days of authorized observed message aggregates plus current process/Gateway status. It polls while visible; no arbitrary report designer, external traffic analytics or reconstruction of observation gaps.',
  'partial',
  ['GET /dashboard'],
);
exact(
  [17],
  ['Require specific roles for dashboard actions'],
  ['dashboard.login', 'system.action-policy.set'],
  'Owner/configured operator plus current Manage Server authorizes a fixed server/channel dashboard session. Login and action enabled/role/channel policies are fetched again, and registry permissions/role policies apply to each request and exact preview confirmation. No OAuth account-linking server.',
);
exact(
  [18],
  ['Create event-driven dashboards'],
  ['dashboard.login', 'analytics.observed', 'statuspanel.create'],
  'The optional owner/operator dashboard periodically reads event-observed stored message counters and process status; a separate Discord status message can update on a timer. No arbitrary event-to-widget builder or streamed real-time dashboard state.',
  'partial',
);
exact(
  [21, 22],
  ['Provide external control dashboards', 'External web dashboards'],
  ['dashboard.login'],
  'Optional locally served owner/operator web interface has current observed analytics and an action console using the same schemas, authorization, per-action policies and exact expiring confirmations. Single-use Discord-issued login links, fixed context, short sessions and bounded downloads; remote use requires configured HTTPS hosting. OAuth login and general staff/public dashboards are not included.',
  'partial',
  ['GET /dashboard', 'src/features/dashboard.ts'],
);
exact(
  [3],
  ['Assign subscription-based roles', 'Assign entitlement-based roles'],
  [
    'entitlement.roles.configure',
    'entitlement.roles.sync',
    'entitlement.roles.grants',
    'entitlement.roles.review',
  ],
  'An operator with current Manage Server/Roles maps this application’s individual UserSubscription SKUs to ordinary roles. Fresh complete bounded entitlement reads govern current-member grants and expiry refresh; only confirmed bot-owned roles may be removed. Existing/manual roles and ambiguous writes are preserved for explicit review. Guild, one-time, consumable and external-provider subscriptions are unsupported; eligible products must already exist.',
);
exact(
  [14],
  ['Accept anonymous submissions through controlled interfaces'],
  ['form.create', 'form.submit', 'form.response', 'form.export', 'form.erase-own'],
  'Optional anonymous-to-reviewers private forms snapshot their privacy mode, disclose host/audit/timing/content limits before exact confirmation, and omit automatic owner IDs from normal review/summary/CSV views. form.submit uses private audit identity while internal owner IDs support quotas, self-review prevention and owner erasure. Answers/files may self-identify; no anonymity from Discord or the host and no public anonymous posting/reveal endpoint.',
);
exact(
  [11],
  ['Use multiple specialized AI models'],
  ['ai.image', 'ai.image.edit', 'ai.transcribe', 'voice.speak', 'ai.knowledge.add'],
  'Separate chat, image-generation, image-editing, transcription and speech configurations route their corresponding feature requests, with a fixed embedding model for knowledge. One configured OpenAI key is used, subject to actual model/account access, quotas and live acceptance. This does not provide an automatic general-purpose model-selection policy.',
  'implemented',
  ['src/config.ts', 'src/features/ai.ts'],
);
exact(
  [11],
  ['Route tasks to different AI models'],
  ['ai.image', 'ai.image.edit', 'ai.transcribe', 'voice.speak'],
  'Feature-specific chat, generation, editing, transcription, speech and embedding endpoints select their configured/fixed models. No semantic router chooses among general chat/reasoning models based on arbitrary user tasks.',
  'partial',
);
exact(
  [18],
  ['React to entitlement events'],
  ['entitlement.roles.configure', 'entitlement.roles.sync', 'workflow.set'],
  'Own-application individual-user entitlement create/update/delete events enqueue bounded subscription-role reconciliation; fresh REST reads, current membership and policy authority are required before any grant/removal. Event payloads are hints, and installed-guild event workflows remain available. Existing eligible SKUs and live Discord event delivery are required; no general billing-event processor.',
  'implemented',
  ['src/app.ts', 'src/features/entitlement-roles.ts'],
);
exact(
  [20],
  ['Handle entitlement creation events', 'Handle entitlement removal events'],
  ['entitlement.roles.configure', 'entitlement.roles.grants', 'entitlement.roles.review'],
  'Own-application individual subscription entitlement create/delete hints queue verified ordinary-role reconciliation, with bounded expiry refresh and confirmed-add provenance before removal. Foreign/guild/one-time/consumable records are rejected, incomplete reads cannot prove absence, and ambiguous writes stop for review. Product setup, purchasing, billing and payouts remain external.',
  'implemented',
  ['src/app.ts', 'src/features/entitlement-roles.ts'],
);
exact(
  [20],
  ['Check premium entitlements'],
  ['premium.entitlements', 'entitlement.roles.sync', 'entitlement.roles.grants'],
  'Reads existing application entitlements and validates individual UserSubscription eligibility through own-application/user/SKU scope, deletion/consumption state and start/end bounds across complete bounded pages. This is not a checkout, purchase-eligibility approval, paid-purchase proof or external-provider account link.',
);
exact(
  [20],
  ['Build premium membership systems'],
  ['entitlement.roles.configure', 'entitlement.roles.sync', 'entitlement.roles.review'],
  'Only the existing own-application individual-subscription-to-ordinary-role membership lifecycle is implemented, including verified grant/expiry, bounded refresh and manual takeover/recovery. Product creation, guild/one-time SKUs, billing, payouts, tiers and a general premium account product are not included.',
  'partial',
);
exact(
  [20],
  ['Restrict features to premium members', 'Offer premium functionality'],
  ['entitlement.roles.configure', 'entitlement.roles.sync', 'system.action-policy.set'],
  'An operator can map an existing individual subscription SKU to an ordinary role and separately require that role for selected registered actions. Access follows current Discord roles, including manual grants, and bounded entitlement-role refresh; there is no synchronous entitlement check on every command, premium usage quota, theme/interface unlock or commerce product.',
  'partial',
);
exact(
  [20],
  ['Handle subscription lifecycle events'],
  ['entitlement.roles.configure', 'entitlement.roles.grants', 'workflow.set'],
  'Individual own-application subscription entitlement changes and scheduled expiry refresh maintain tracked ordinary roles; supported guild-attributed subscription Gateway events can trigger notifications. This does not implement every subscription event, recurring billing/account state, payment failure/refund workflows or per-user commerce lifecycle.',
  'partial',
);
exact(
  [22],
  ['Premium features', 'Monetization systems'],
  [
    'premium.skus',
    'premium.entitlements',
    'ui.message.publish',
    'entitlement.roles.configure',
    'system.action-policy.set',
  ],
  'Existing SKU/entitlement readers, eligible SKU purchase buttons and verified individual-subscription ordinary-role lifecycle can support separately configured role-gated actions. Product creation, eligibility/payout onboarding, guild/one-time offerings, billing, premium quotas/themes and general commerce/account management are not implemented.',
  'partial',
);

// Map narrowly to actual code entrypoints. An SDK's ability is not implementation coverage.
rule(/^Read server (?:name|features)/i, ['guild.info']);
rule(/^Retrieve member counts and membership information/i, ['guild.info', 'member.info']);
rule(/^Change server names and supported settings/i, ['guild.edit']);
rule(/^Change server icons, banners, and visual settings/i, ['guild.visual']);
rule(/^(?:Manage verification levels|Configure server safety settings|Configure notification settings)/i, [
  'guild.edit',
]);
rule(
  /^Configure system-message settings/i,
  ['guild.channel-setting'],
  'Select the system channel; system-message flag editing is not implemented.',
  'partial',
);
rule(/^Change AFK voice channels and timeouts/i, ['guild.channel-setting', 'guild.edit']);
rule(
  /^Configure Community server settings/i,
  ['guild.channel-setting', 'guild.onboarding-defaults'],
  'Selected channel/default settings only; Community feature activation is not implemented.',
  'partial',
);
rule(/^Manage welcome screens/i, ['guild.welcome', 'guild.welcome-set']);
rule(
  /^Manage onboarding prompts and options/i,
  ['guild.onboarding', 'guild.onboarding-defaults'],
  'Read prompts/options and configure defaults; editing prompts/options is not implemented.',
  'partial',
);
rule(/^Manage incident-response settings/i, ['guild.incident']);
rule(/^Retrieve server integration information/i, ['guild.integrations']);
rule(/^Manage server widgets/i, ['guild.widget', 'guild.widget-set']);
rule(/^Retrieve vanity invitation information/i, ['guild.vanity']);
rule(/^Create server templates/i, ['guild.template-create']);
rule(/^Synchronize server templates/i, ['guild.template-sync']);
rule(
  /^Back up server configuration information/i,
  ['guild.snapshot'],
  'Exports accessible channel settings, roles and selected metadata; excludes messages/secrets and is not a complete restorable backup.',
  'partial',
);
rule(/^Manage server emojis/i, ['emoji.list', 'emoji.create', 'emoji.edit', 'emoji.delete']);
rule(/^Manage server stickers/i, ['sticker.list', 'sticker.create', 'sticker.edit', 'sticker.delete']);
rule(
  /^Execute bulk administrative operations/i,
  ['member.bulk-ban', 'role.assign-many', 'message.bulk-delete'],
  'Only the listed bounded bulk operations exist; no arbitrary bulk workflow executor.',
  'partial',
);

rule(
  /^Create (?:text channels|voice channels|Stage channels|announcement channels|forum channels|media channels|channel categories)/i,
  ['channel.create'],
);
rule(/^Delete channels/i, ['channel.delete']);
rule(
  /^(?:Rename channels|Change channel topics|Edit channel descriptions|Set channel age restrictions|Configure channel slowmode)/i,
  ['channel.edit'],
);
rule(
  /^Edit channel metadata/i,
  ['channel.edit'],
  'Only the fields in channel.edit schema are supported.',
  'partial',
);
rule(/^Reorder (?:channels|categories)/i, ['channel.position']);
rule(/^Move channels between categories/i, ['channel.move']);
rule(/^Configure channel permission overwrites/i, ['channel.overwrite', 'channel.overwrite-delete']);
rule(/^Create private channels/i, ['channel.private-create']);
rule(
  /^Lock channels/i,
  ['channel.lock'],
  'Saves and denies the everyone SendMessages overwrite. Other explicit role/member allows can still grant sending.',
  'partial',
);
rule(
  /^Unlock channels/i,
  ['channel.unlock'],
  'Restores the saved everyone SendMessages overwrite from channel.lock; not a full-server lockdown recovery system.',
  'partial',
);
rule(/^Create (?:public threads|private threads|threads from existing messages)/i, ['thread.create']);
rule(/^Create (?:forum posts|media posts)/i, ['thread.post']);
rule(/^Apply forum tags/i, ['thread.post', 'thread.edit']);
rule(/^Edit forum tags/i, ['channel.forum-tags']);
rule(
  /^Edit forum post settings/i,
  ['thread.edit'],
  'Supported thread name, archive, lock, slowmode and tag settings only.',
  'partial',
);
rule(/^(?:Archive|Unarchive|Lock|Unlock) threads/i, ['thread.edit']);
rule(/^Join threads/i, ['thread.join']);
rule(/^Leave threads/i, ['thread.leave']);
rule(/^Add thread participants/i, ['thread.member-add']);
rule(/^Remove thread participants/i, ['thread.member-remove']);
rule(/^Retrieve active threads/i, ['thread.active']);
rule(/^Retrieve archived threads/i, ['thread.archived']);
rule(/^Manage voice-channel statuses/i, ['channel.voice-status']);
rule(/^Create support channels on demand/i, ['ticket.open']);
rule(/^Follow announcement channels/i, ['channel.follow']);

rule(/^Create roles/i, ['role.create']);
rule(/^Delete roles/i, ['role.delete']);
rule(/^(?:Rename roles|Change role colors|Configure enhanced role colors|Change role permissions)/i, [
  'role.edit',
]);
rule(/^Change role icons/i, ['role.icon']);
rule(/^Reorder roles/i, ['role.position']);
rule(/^Assign roles to members/i, ['role.assign']);
rule(/^Remove roles from members/i, ['role.remove']);
rule(
  /^Assign multiple roles automatically/i,
  ['role.assign-many'],
  'Explicit bounded assignment after human confirmation; no arbitrary automatic trigger engine.',
  'partial',
);
rule(
  /^(?:Automatically assign newcomer roles|Assign newcomer roles|Run automatic welcome systems|Welcome new members|Send customized welcome messages|Detect member departures)/i,
  ['community.configure'],
  'Configure community settings; member join/leave automation requires ENABLE_MEMBERS and the Portal intent.',
);
rule(
  /^Assign roles through (?:button interactions|selection menus)/i,
  ['selfrole.list'],
  'Allowlisted safe self-role actions exist; dedicated button/select role panels are not implemented.',
  'partial',
);
rule(/^Assign temporary roles/i, ['temprole.assign']);
rule(
  /^Automatically expire temporary roles/i,
  ['temprole.assign'],
  'Durable temporary-role cleanup runs while the bot is online; retries are bounded.',
);
rule(
  /^(?:Implement role-based access control|Manage role-based command access)/i,
  ['system.ai.access', 'system.features'],
  'Discord permissions guard actions and AI access can be role restricted; arbitrary per-command role/channel policy editing is not implemented.',
  'partial',
);
rule(/^(?:Calculate member permissions|Display member permissions)/i, ['member.permissions']);
rule(
  /^Compare permissions across channels/i,
  ['member.permissions'],
  'Query channels individually; no built-in comparison report.',
  'partial',
);
rule(
  /^Detect dangerous permission combinations/i,
  ['role.security-review'],
  'On-demand privileged-role report; no continuous privilege-change detection.',
  'partial',
);

rule(/^(?:Track server join dates|Retrieve membership information)/i, ['member.info']);
rule(/^(?:Change member nicknames|Reset member nicknames)/i, ['member.nickname']);
rule(/^Kick members/i, ['member.kick']);
rule(/^Ban members/i, ['member.ban']);
rule(/^Unban members/i, ['member.unban']);
rule(
  /^Bulk-ban eligible accounts/i,
  ['member.bulk-ban'],
  'Up to 20 current manageable members; does not ban arbitrary absent accounts.',
);
rule(
  /^Remove recent message history when banning/i,
  ['member.ban'],
  'Discord permits deleting up to seven days of message history.',
);
rule(/^(?:Apply communication timeouts|Remove communication timeouts)/i, ['member.timeout']);
rule(/^Server-mute members in voice channels/i, ['member.voice-mute']);
rule(/^Server-deafen members in voice channels/i, ['member.voice-deafen']);
rule(
  /^(?:Move members between voice channels|Move users between voice channels|Disconnect members from voice channels)/i,
  ['member.voice-move'],
);
rule(/^Warn members/i, ['case.warn']);
rule(/^Maintain warning histories/i, ['case.list', 'case.mine']);
rule(
  /^Maintain moderation case records/i,
  ['case.warn', 'case.list'],
  'Warning cases are persisted; automatic case creation for every native moderation action is not implemented.',
  'partial',
);
rule(
  /^Create moderation appeal workflows/i,
  ['appeal.submit', 'appeal.review'],
  'Warning-case appeals only; does not automatically reverse Discord punishments.',
  'partial',
);
rule(/^Allow moderators to (?:approve|deny) appeals/i, ['appeal.review']);
rule(/^Retrieve server audit logs/i, ['guild.audit']);
rule(
  /^Identify administrators responsible for audited actions/i,
  ['guild.audit'],
  'Returns Discord-provided executor IDs; does not infer missing or ambiguous audit attribution.',
);
rule(
  /^Export moderation logs/i,
  ['analytics.export', 'community.export'],
  'Bot action audit CSV and stored warnings/reports; not an export of all Discord historical moderation.',
  'partial',
);
rule(
  /^Identify inactive members using available activity data/i,
  ['member.prune-count', 'level.profile'],
  'Native prune count and observed XP only; not a complete inactivity detector.',
  'partial',
);
rule(/^Create user-reporting systems/i, ['report.submit', 'report.list', 'report.resolve']);
rule(
  /^Assign reports to moderators/i,
  ['report.claim'],
  'Moderators claim reports for themselves; arbitrary reassignment is not implemented.',
  'partial',
);
rule(/^Maintain moderation case notes/i, ['case.note']);
rule(/^Track previous moderation violations/i, ['case.list'], 'Stored warning cases only.', 'partial');

rule(
  /^(?:Detect excessive mentions|Detect mass pinging|Detect repeated message flooding|Filter configured keywords)/i,
  ['community.configure', 'automod.create'],
  'Opt-in simple message-rate/mention/keyword checks and native AutoMod; Message Content intent is required where content is examined.',
);
rule(
  /^Filter regular-expression patterns/i,
  ['automod.create'],
  'Regular expressions run inside native Discord AutoMod, not arbitrary in-process regex loops.',
);
rule(/^Configure native Discord AutoMod rules/i, ['automod.list', 'automod.create']);
rule(/^(?:Enable AutoMod rules|Disable AutoMod rules)/i, ['automod.toggle']);
rule(/^Change AutoMod exemptions/i, ['automod.exemptions']);
rule(
  /^(?:Block messages matching AutoMod criteria|Send AutoMod alerts|Apply native AutoMod timeout actions)/i,
  ['automod.create'],
);
rule(
  /^Restrict server access during raids/i,
  ['guild.incident', 'guild.invites-toggle'],
  'Manual incident controls; automatic join-spike detection/response is not implemented.',
  'partial',
);
rule(
  /^(?:Maintain allowlists|Maintain blocklists)/i,
  ['automod.create', 'community.configure'],
  'Native AutoMod allowlist and configured keyword blocklist; no global URL/domain reputation store.',
  'partial',
);
rule(
  /^Require human approval before destructive actions/i,
  [],
  'All registry mutations are previewed and require an expiring confirmation bound to member, server and channel.',
  'implemented',
  undefined,
  ['/action', '/confirm', '/cancel'],
);

rule(
  /^Send (?:plain-text messages|Markdown-formatted messages|code blocks|hyperlinks|messages containing custom emojis|server stickers|image attachments|GIFs|video attachments|audio files|PDF files|ZIP files|other permitted file attachments|rich embedded messages|text-to-speech messages|messages without normal push notifications|messages with suppressed embeds)/i,
  ['message.send'],
  'Text, embeds, stickers, TTS/flags and bounded base64 attachments are supported by the exact schema; use public files you are authorized to share.',
);
rule(
  /^Send messages containing mentions/i,
  ['message.send'],
  'Mention-like text can be sent, but mention notifications are deliberately disabled.',
  'partial',
);
rule(/^Send polls/i, ['poll.create']);
rule(/^End polls/i, ['poll.end']);
rule(/^Retrieve poll results/i, ['poll.results']);
rule(/^Retrieve available poll voting information/i, ['poll.voters']);
rule(/^Reply to messages/i, ['message.reply']);
rule(/^Forward supported messages/i, ['message.forward']);
rule(/^Edit the bot's own messages/i, ['message.edit']);
rule(/^(?:Delete the bot's own messages|Delete other users' messages with authorization)/i, [
  'message.delete',
]);
rule(/^Bulk-delete eligible recent messages/i, ['message.bulk-delete']);
rule(/^Pin messages/i, ['message.pin']);
rule(/^Unpin messages/i, ['message.unpin']);
rule(/^Retrieve pinned messages/i, ['message.pins']);
rule(/^Add message reactions/i, ['message.react']);
rule(/^(?:Remove the bot's reactions|Remove other reactions with authorization)/i, [
  'message.reaction-remove',
]);
rule(/^Clear reactions from messages/i, ['message.reactions-clear']);
rule(/^Show typing indicators/i, ['message.typing']);
rule(/^Crosspost announcement-channel messages/i, ['message.crosspost']);
rule(/^Send webhook-based announcements/i, ['webhook.send']);
rule(/^Read accessible message history/i, ['message.history']);
rule(
  /^Search accessible message history/i,
  ['message.search-recent'],
  'Bounded recent-history search only; no exhaustive historical index.',
  'partial',
);
rule(/^(?:Create automatic FAQ responses|Respond to keywords|Create FAQ systems)/i, [
  'faq.set',
  'faq.list',
  'community.configure',
]);
rule(
  /^Respond to bot mentions/i,
  [],
  'Leading bot mentions provide help or bounded public AI chat without administrative tools, saved preferences or retained conversation history. Discord supplies mention-message content without general channel-content access; use /ask in an installed server for private permission-checked tool proposals.',
  'implemented',
  undefined,
  ['@bot'],
);
rule(
  /^Maintain conversational context across messages/i,
  [],
  'Private /ask and opted-in personal chat retain bounded context scoped to server, channel and requesting user. Public mention/prefix chat neither reads saved preferences nor retains conversation history.',
  'implemented',
  undefined,
  ['/ask'],
);
rule(
  /^(?:Schedule messages|Create scheduled announcements|Send event reminders|Schedule recurring reminders|Trigger actions at specific times)/i,
  ['reminder.create'],
  'Durable timed text messages and fixed-minute recurrence; no arbitrary scheduled action execution.',
  'partial',
);

rule(
  /^Create slash commands/i,
  [],
  'Guild-installed slash commands are registered by deploy:commands.',
  'implemented',
  undefined,
  ['/help', '/action', '/ask'],
);
rule(
  /^Create (?:user|message) context-menu commands/i,
  [],
  'Inspect member and Explain message commands are registered.',
  'implemented',
  undefined,
  ['Inspect member', 'Explain message'],
);
rule(
  /^Create mention-triggered commands/i,
  [],
  'Leading mentions route help and bounded public AI conversation. Administrative tools, saved preferences and retained history are disabled in this public path; private actions use /action or /ask.',
  'implemented',
  undefined,
  ['@bot help', '@bot <prompt>'],
);
rule(
  /^Create (?:natural-language|AI-interpreted) commands/i,
  [],
  'In an installed server, /ask privately interprets natural-language action requests through permission-checked tools and exact human confirmations. Public mention/prefix AI only returns bounded conversation without administrative tools, saved preferences or retained history.',
  'implemented',
  undefined,
  ['/ask', '@bot <prompt>'],
);
rule(
  /^Create prefix commands/i,
  [],
  'The configured prefix supports help and bounded public AI chat when ENABLE_MESSAGE_CONTENT is enabled in code and Portal. Public !action requests redirect to private /action or /ask; public chat has no administrative tools, saved preferences or retained history.',
  'implemented',
  undefined,
  ['!help', '!Explain recursion'],
);
rule(
  /^Create commands with (?:text arguments|numerical arguments|Boolean arguments)/i,
  [],
  'Typed slash options and strict action JSON schemas are implemented.',
  'implemented',
  undefined,
  ['/action', '/schema'],
);
rule(
  /^Create commands (?:targeting users|targeting channels|targeting roles|accepting file attachments)/i,
  [],
  'Target IDs are validated in action schemas; /ask accepts a file; /report has a native user option.',
  'implemented',
  undefined,
  ['/action', '/ask', '/report'],
);
rule(
  /^Provide command autocomplete suggestions/i,
  [],
  'Action-name autocomplete is implemented.',
  'implemented',
  undefined,
  ['/action', '/schema'],
);
rule(
  /^(?:Create server-specific commands|Create global commands)/i,
  [],
  'Command deployment supports configured guilds or a global registration.',
  'implemented',
  undefined,
  ['deploy:commands'],
);
rule(
  /^(?:Send private interaction responses|Defer responses for long-running operations|Send interactive follow-up messages|Create interactive approval workflows|Create interactive confirmation workflows|Build confirmation dialogs)/i,
  [],
  'Router responses are private; mutations use expiring member/channel-bound confirm/cancel buttons.',
  'implemented',
  undefined,
  ['/action', '/confirm', '/cancel'],
);
rule(
  /^Create interactive buttons/i,
  [],
  'Confirm/cancel buttons are implemented; no general button-builder interface.',
  'partial',
  undefined,
  ['/action'],
);
rule(
  /^Create (?:modal popup forms|text-input fields)/i,
  [],
  'Required action input opens a bounded JSON text-input modal; no general multi-step form designer.',
  'partial',
  undefined,
  ['/action'],
);
rule(
  /^Create interactive pagination systems/i,
  [],
  'Previous/next buttons paginate the action help list; no generic paginator-builder.',
  'partial',
  undefined,
  ['/help'],
);
rule(
  /^Create interactive help menus/i,
  [],
  'Searchable action list with previous/next help buttons.',
  'implemented',
  undefined,
  ['/help'],
);

rule(/^Join voice channels/i, ['voice.join']);
rule(/^Leave voice channels/i, ['voice.leave']);
rule(
  /^Move between voice channels/i,
  ['voice.leave', 'voice.join'],
  'Leave then join another regular voice channel; no seamless move action.',
  'partial',
);
rule(
  /^Queue multiple audio tracks/i,
  ['voice.play'],
  'Uploaded PCM16 WAV only; at most 5 waiting tracks and 24 MiB total decoded PCM.',
);
rule(/^Pause audio playback/i, ['voice.pause']);
rule(/^Resume audio playback/i, ['voice.resume']);
rule(/^Skip audio tracks/i, ['voice.skip']);
rule(/^Stop audio playback/i, ['voice.stop']);
rule(
  /^Maintain music queues across servers/i,
  ['voice.play', 'voice.status'],
  'Separate bounded in-memory playback queues per server. Personal playlists persist approved uploaded-WAV references, but queued audio itself does not survive process restart and there is no remote music-provider library.',
  'partial',
);
rule(
  /^Adjust audio playback volume/i,
  ['voice.volume'],
  '0–1 volume applies to subsequent tracks; current track volume is unchanged.',
  'partial',
);
rule(
  /^Play sound effects/i,
  ['voice.play', 'soundboard.play'],
  'Uploaded WAV clips and Discord-native soundboard playback.',
);
rule(/^Trigger supported Discord soundboard sounds/i, ['soundboard.play']);
rule(/^Retrieve available soundboard sounds/i, ['soundboard.list']);
rule(/^Create server soundboard sounds/i, ['soundboard.create']);
rule(/^Edit server soundboard sounds/i, ['soundboard.edit']);
rule(/^Delete server soundboard sounds/i, ['soundboard.delete']);
rule(
  /^Receive and process voice audio through compatible implementations/i,
  ['voice.consent'],
  'Explicit individual consent, regular voice channels, maximum 15-second utterances. Discord receive compatibility is not guaranteed.',
);
rule(
  /^Transcribe consented voice conversations/i,
  ['voice.consent'],
  'Only consenting speakers; expires after 10 min; one capture/transcription per server; transcripts posted to disclosed join text channel.',
);
rule(/^(?:Generate spoken responses using text-to-speech|Generate speech)/i, ['voice.speak']);
rule(
  /^Build conversational voice AI/i,
  ['voice.consent'],
  'Optional consented transcription → conversational text reply → synthetic speech. Does not execute Discord actions from voice.',
  'partial',
);
rule(
  /^Implement voice activity detection/i,
  ['voice.consent'],
  'Uses Discord speaking events and receive-stream silence termination; no independent acoustic VAD model.',
  'partial',
);
rule(
  /^Build consent-based voice recording systems/i,
  ['voice.consent'],
  'Transient in-memory transcription only; no recording files or persistent audio archive.',
  'partial',
);

rule(/^Create Discord scheduled events/i, ['event.create']);
rule(/^Edit scheduled events/i, ['event.edit']);
rule(/^Cancel scheduled events/i, ['event.status']);
rule(/^Retrieve event information/i, ['event.list']);
rule(/^Track interested event participants/i, ['event.subscribers']);
rule(/^Manage Stage instances/i, ['stage.create', 'stage.delete']);
rule(/^Manage Stage topics/i, ['stage.topic']);
rule(/^Run timed giveaways/i, ['giveaway.create', 'giveaway.enter']);

rule(
  /^(?:Hold natural-language conversations|Understand user instructions|Maintain short-term conversation context|Maintain separate memory for individual users|Maintain separate memory for individual servers|Explain programming concepts|Generate programming code|Debug code|Review code|Explain error messages|Generate essays|Generate stories|Generate descriptions|Rewrite text|Improve grammar and wording|Translate between languages|Interpret uploaded images|Analyze charts|Analyze diagrams|Create structured plans|Generate quizzes|Generate practice questions|Provide personalized tutoring|Classify messages|Suggest moderation actions|Analyze suspicious content|Generate moderation summaries|Identify common support issues|Ask follow-up questions for ambiguous instructions|Explain completed actions)/i,
  [],
  'Implemented through /ask with bounded user/server/channel-scoped context. Model output remains best effort and may need human review.',
  'implemented',
  [11],
  ['/ask'],
);
rule(
  /^Perform mathematical calculations/i,
  [],
  'Model reasoning only; no calculator/code execution tool. Verify precision-sensitive results.',
  'partial',
  [11],
  ['/ask'],
);
rule(
  /^Summarize (?:conversations|articles|PDFs)/i,
  [],
  'Summarizes supplied text/PDF; does not automatically read every channel or fetch arbitrary article URLs.',
  'partial',
  [11],
  ['/ask'],
);
rule(
  /^Analyze server logs/i,
  [],
  'Analyze an explicitly supplied text/code attachment; no host log-file access.',
  'partial',
  [11],
  ['/ask'],
);
rule(
  /^Answer questions using external documents/i,
  [],
  'Accepts supplied image, PDF and text/code attachments; no connected Drive/cloud document reader.',
  'partial',
  [11],
  ['/ask'],
);
rule(
  /^Answer questions using accessible message history/i,
  ['message.history'],
  'AI can request authorized bounded message history through tools; no automatic full-server indexing.',
  'partial',
  [11],
  ['/ask'],
);
rule(
  /^Store long-term conversational memory/i,
  ['ai.memory.save'],
  'Explicit saved preferences plus retained bounded conversations; default conversation retention is 7 days.',
  'partial',
);
rule(/^Remember saved user preferences/i, ['ai.memory.save', 'ai.memory.view']);
rule(
  /^Search the web through external search services/i,
  [],
  'Optional OpenAI Responses web_search tool; ENABLE_WEB_SEARCH=true, model/account support and API charges apply.',
  'implemented',
  undefined,
  ['/ask'],
);
rule(/^(?:Generate AI images|Create AI images)/i, ['ai.image']);
rule(/^(?:Edit images using AI|Edit uploaded images)/i, ['ai.image.edit']);
rule(/^Convert speech to text/i, ['ai.transcribe']);
rule(/^Store vector embeddings/i, ['ai.knowledge.add']);
rule(/^Search vector embeddings/i, ['ai.knowledge.search']);
rule(
  /^Use retrieval-augmented generation/i,
  ['ai.knowledge.add', 'ai.knowledge.search'],
  'Personal semantic document storage/search exists; chat does not automatically retrieve private documents.',
  'partial',
);
rule(
  /^Generate reports using database information/i,
  ['analytics.commands', 'community.export'],
  'Fixed bot audit/community exports only; no arbitrary SQL agent.',
  'partial',
);
rule(
  /^Interpret natural-language administration requests/i,
  [],
  'In an installed server, /ask privately discovers exact action schemas and proposes member-authorized changes for explicit confirmation. Public mention/prefix chat cannot request administrative tools.',
  'implemented',
  undefined,
  ['/ask'],
);
rule(
  /^Convert authorized instructions into Discord actions/i,
  [],
  'Only registered actions; every mutation requires an exact expiring human confirmation.',
  'implemented',
  undefined,
  ['/ask', '/confirm'],
);
rule(
  /^(?:Generate multi-step action plans|Execute authorized tools through an AI-agent framework|Execute approved multi-step workflows|Coordinate multiple AI tools within one conversation)/i,
  [],
  'Bounded Responses tool loop with at most five pending confirmations; no transactional multi-step workflow/rollback engine.',
  'partial',
  undefined,
  ['/ask'],
);
rule(
  /^(?:Use multiple specialized AI models|Route tasks to different AI models)/i,
  ['ai.image', 'ai.transcribe', 'voice.speak'],
  'Separate configured chat/image/speech/transcription models; no automatic general model-routing policy.',
  'partial',
);
rule(
  /^(?:Maintain user-specific AI permissions|Maintain administrator-specific AI permissions)/i,
  ['system.ai.access'],
  'AI spending can be restricted to configured roles; Discord permissions separately guard action tools.',
  'partial',
);

rule(
  /^Resize images/i,
  ['image.resize'],
  'Bounded first-frame PNG/JPEG/WebP/GIF transforms; explicit dimensions up to 4096 and raster input limits apply.',
);
rule(/^Crop images/i, ['image.crop']);
rule(/^Rotate images/i, ['image.rotate']);
rule(
  /^Apply image filters/i,
  ['image.blur', 'image.grayscale'],
  'Gaussian blur and grayscale only; no arbitrary filter stack.',
  'partial',
);
rule(
  /^Remove image backgrounds/i,
  ['ai.image.edit'],
  'Can request a background edit through the configured image model; no deterministic local background-removal pipeline.',
  'partial',
);
rule(
  /^Create transparent PNGs/i,
  ['image.format'],
  'Converts to PNG and preserves existing alpha; does not automatically remove an opaque background.',
  'partial',
);
rule(/^Generate memes/i, ['image.meme'], 'Escaped top/bottom text on the first raster frame.');
rule(
  /^Create (?:profile-picture concepts|banners|thumbnails)/i,
  ['ai.image', 'image.resize'],
  'Generate image concepts then resize supplied raster images; dedicated brand/layout templates are not included.',
  'partial',
);
rule(
  /^Create (?:personalized welcome cards|rank cards)/i,
  ['image.card'],
  'Generate a card from supplied text and optional progress; automatic member/profile-stat binding is not included.',
  'partial',
);
rule(
  /^Create (?:charts|graphs)/i,
  ['chart.bar'],
  'Horizontal bar charts for up to 20 supplied nonnegative numeric values; no general charting engine.',
  'partial',
);
rule(
  /^Generate server statistics images/i,
  ['chart.bar', 'analytics.commands'],
  'Query statistics, then supply selected chart values explicitly; no automatic dashboard image template.',
  'partial',
);
rule(
  /^Generate PDF reports/i,
  ['pdf.report'],
  'Paginated plain text with standard Latin fonts; not arbitrary layout, HTML rendering or complex-script typography.',
);
rule(
  /^Combine PDFs/i,
  ['pdf.merge'],
  'Merge 2–3 unencrypted PDF attachments, at most 100 total pages and bounded file size.',
);
rule(
  /^Split PDFs/i,
  ['pdf.split'],
  'Extract/reorder selected unique page numbers from one bounded unencrypted PDF.',
);
rule(
  /^Convert files between formats/i,
  ['image.format'],
  'Raster PNG/JPEG/WebP/single-frame GIF conversion only; no generic office/audio/video converter.',
  'partial',
);
rule(
  /^Compress image files/i,
  ['image.format'],
  'Bounded raster format conversion, including quality for JPEG/WebP; animation is flattened to the first frame.',
);
rule(
  /^Create custom emojis from images/i,
  ['image.resize', 'image.format', 'emoji.create'],
  'Manual image resize/format then explicit base64 emoji upload; Discord validates emoji constraints.',
  'partial',
);
rule(
  /^Detect duplicate media using hashes/i,
  ['file.hash'],
  'Compute SHA-256 to manually compare exact file duplicates; no perceptual hashing or persistent duplicate-media index.',
  'partial',
);
rule(
  /^Generate (?:CSV exports|spreadsheets)/i,
  ['analytics.export', 'community.export'],
  'Audit CSV and community JSON exports only; native XLSX generation is not implemented.',
  'partial',
);
rule(
  /^(?:Read uploaded documents|Extract text from images|Analyze PDFs|Analyze uploaded files)/i,
  [],
  'AI can analyze explicitly supplied images, PDF and supported text/code files; no general archive/document parser.',
  'partial',
  undefined,
  ['/ask'],
);
rule(/^Transcribe recordings/i, ['ai.transcribe']);
rule(
  /^Upload processed files into Discord/i,
  ['message.send'],
  'Send bounded supplied base64 files and generated AI images; no general media-processing pipeline.',
  'partial',
);

rule(
  /^(?:Run trivia games|Run quizzes)/i,
  ['trivia.start', 'trivia.answer'],
  'A small fixed text trivia question bank with persisted per-user sessions.',
);
rule(
  /^Create fictional currencies/i,
  ['economy.balance', 'economy.grant'],
  'One built-in fictional coin denomination; no custom currency definitions.',
  'partial',
);
rule(/^Maintain virtual currency balances/i, ['economy.balance', 'economy.transfer']);
rule(/^Create inventories/i, ['shop.inventory']);
rule(/^Run virtual item shops/i, ['shop.set', 'shop.list']);
rule(/^Manage virtual item purchases/i, ['shop.buy']);
rule(/^(?:Maintain experience points|Implement leveling systems)/i, [
  'level.profile',
  'level.leaderboard',
  'community.configure',
]);
rule(/^Manage leaderboards/i, ['level.leaderboard', 'economy.leaderboard']);
rule(/^Run daily-reward systems/i, ['economy.daily']);
rule(/^Organize giveaways/i, ['giveaway.create', 'giveaway.enter', 'giveaway.list']);
rule(
  /^Select giveaway winners/i,
  ['giveaway.create'],
  'Eligible entrants are selected by bounded background maintenance after the deadline.',
);
rule(
  /^Verify giveaway eligibility/i,
  ['giveaway.enter'],
  'Current non-bot guild membership; no external or configurable achievement requirements.',
  'partial',
);

rule(/^Create private ticket channels/i, ['ticket.open']);
rule(
  /^Assign tickets to staff members/i,
  ['ticket.claim'],
  'Configured support staff may claim tickets for themselves.',
  'partial',
);
rule(/^Close tickets/i, ['ticket.close']);
rule(
  /^Archive tickets/i,
  ['ticket.close'],
  'Retains the channel and history with owner sending disabled; no archival storage or thread conversion.',
  'partial',
);
rule(
  /^Generate ticket transcripts/i,
  ['ticket.transcript'],
  'At most 100 recent accessible messages; explicitly marked partial.',
  'partial',
);
rule(/^Publish community announcements/i, ['message.send', 'webhook.send']);
rule(/^Create community polls/i, ['poll.create']);
rule(/^Send opt-in reminders/i, ['reminder.create']);
rule(
  /^Provide multilingual support responses/i,
  [],
  'On-demand AI text responses; no automatic ticket routing or locale policy.',
  'partial',
  undefined,
  ['/ask'],
);
rule(
  /^Create notification roles/i,
  ['role.create', 'selfrole.list'],
  'Create roles and use allowlisted self-role actions; notification broadcasts/role panels are not included.',
  'partial',
);

rule(/^(?:Count command usage|Track command popularity)/i, ['analytics.commands']);
rule(/^Track bot uptime/i, ['system.status']);
rule(
  /^Track API errors/i,
  ['analytics.commands'],
  'Action failure counts and structured error classes; no full observability backend.',
  'partial',
);
rule(
  /^Monitor system resource usage/i,
  ['system.status'],
  'RSS memory, uptime and Gateway ping; CPU telemetry is not implemented.',
  'partial',
);
rule(
  /^Track moderation actions/i,
  ['system.audit'],
  'Bot-dispatched actions only; no complete server event history.',
  'partial',
);
rule(
  /^Track available message counts/i,
  ['level.profile'],
  'Counts cooldown-eligible observed XP messages only, not every message.',
  'partial',
);
rule(
  /^Track support ticket volumes/i,
  ['ticket.list'],
  'Stored ticket list; no time-series support analytics.',
  'partial',
);
rule(/^Track giveaway participation/i, ['giveaway.list']);
rule(/^Track poll statistics/i, ['poll.results']);
rule(/^Create leaderboards/i, ['level.leaderboard', 'economy.leaderboard']);
rule(
  /^Store historical analytics in databases/i,
  ['system.audit'],
  'SQLite action audit history and community state; no arbitrary time-series analytics.',
  'partial',
);
rule(
  /^Export data to (?:CSV files|spreadsheets)/i,
  ['analytics.export'],
  'Bot audit CSV export, not XLSX.',
  'partial',
);

rule(/^Use databases for long-term memory/i, ['ai.memory.save', 'ai.knowledge.add']);
rule(/^Change bot nicknames in individual servers/i, ['bot.nickname']);
rule(/^Generate server invitation links/i, ['invite.create']);
rule(/^Configure invitation (?:expiration|usage limits)/i, ['invite.create']);
rule(/^Retrieve manageable invitations/i, ['invite.list']);
rule(/^Revoke manageable invitations/i, ['invite.delete']);
rule(
  /^Track available invitation activity/i,
  ['invite.list'],
  'On-demand invite usage counts only; no reliable member-to-inviter attribution.',
  'partial',
);
rule(/^Create webhooks/i, ['webhook.create']);
rule(/^Edit webhooks/i, ['webhook.edit']);
rule(/^Delete webhooks/i, ['webhook.delete']);
rule(/^Send webhook messages/i, ['webhook.send']);
rule(/^Customize webhook display names/i, ['webhook.send', 'webhook.edit']);
rule(/^Customize webhook avatars/i, ['webhook.edit']);
rule(
  /^Queue tasks for later processing/i,
  ['reminder.create'],
  'Durable reminder text jobs only; no arbitrary general-purpose job queue.',
  'partial',
);
rule(
  /^Retry failed operations/i,
  ['reminder.create', 'temprole.assign'],
  'Bounded reminder/temporary-role retries only; no automatic retry of arbitrary mutations.',
  'partial',
);
rule(
  /^Maintain event logs/i,
  ['system.audit'],
  'Audit of bot action requests/results; not all Gateway event types.',
  'partial',
);
rule(
  /^Prevent duplicate actions/i,
  [],
  'Confirmations are atomically single use. Network delivery cannot be guaranteed exactly once.',
  'partial',
  undefined,
  ['/confirm'],
);
rule(
  /^Query available SKUs/i,
  ['premium.skus'],
  'Reads existing Portal-configured SKUs. Eligibility/onboarding and SKU creation remain external setup.',
);
rule(
  /^Check premium entitlements/i,
  ['premium.entitlements'],
  'Reads existing server-scoped entitlements; automatic premium feature gating/lifecycle handling is not implemented.',
  'partial',
);

// These are independent products/accounts, not latent capabilities of either supplied credential.
rule(
  /(?:GitHub|GitLab|Google Calendar|Google Sheets|Google Drive|email services|project-management software|task-tracking systems|Trello|Notion|cloud storage|YouTube|Twitch|gaming statistics APIs|external gaming statistics|SMS notifications|emails through external providers|calendar integrations|CAPTCHA|OAuth|external website verification|external reputation services|malware-scanning services|security APIs|authorized cloud infrastructure)/i,
  [],
  'No service connector is included. Implement and configure the external service authorization, required scopes and hosting before use.',
  'external_setup',
);
rule(
  /^(?:Use OAuth2 authorization|Retrieve authorized user identity information|Retrieve account information within granted scopes|Link Discord identities to external accounts|Verify external account ownership|Support Discord Linked Roles|Configure Linked Roles metadata|Authorize external dashboards with Discord login|Support explicit OAuth2 account-joining flows)/i,
  [],
  'Requires user OAuth authorization, callback hosting and additional application configuration; no account-linking server is included.',
  'external_setup',
);
rule(
  /.*/,
  [],
  'Requires a separately implemented and hosted Activity/frontend (Embedded App SDK), application configuration and any needed user grants. No Activity frontend is included.',
  'external_setup',
  [19],
);
rule(
  /.*/,
  [],
  'Requires Discord monetization/distribution eligibility and Portal offering setup; premium purchase flows, feature gates, subscription lifecycle and Store configuration are not implemented.',
  'external_setup',
  [20],
);
rule(
  /^(?:Build bots with (?:Python|Rust|Go|Java\.|C#|other compatible languages)|Maintain multiple databases|Support Redis caching|Support vector databases|Scale across multiple machines|Shard bots across Gateway connections|Use HTTP interaction endpoints)/i,
  [],
  'Alternative architecture, not enabled in this single-process TypeScript/SQLite/Gateway deployment.',
  'architectural_alternative',
  [21],
);
rule(
  /^Build bots with (?:JavaScript|TypeScript)/i,
  [],
  'TypeScript source compiles to Node.js JavaScript.',
  'implemented',
  [21],
  ['build', 'start'],
);
rule(
  /^(?:Run continuously on a computer|Run continuously on a server|Host on VPS platforms|Host on cloud platforms|Deploy using Docker containers|Run on Linux|Run on Windows)/i,
  [],
  'Deployment assets support Node.js 24 and Docker; real uptime and environment compatibility require deployment validation.',
  'partial',
  [21],
  ['start'],
);
rule(
  /^(?:Use Discord's REST API|Use Discord's Gateway WebSocket|Support multiple servers from one application|Organize features into modules|Run multiple tasks concurrently|Use asynchronous programming)/i,
  [],
  'Implemented in the modular discord.js Gateway/REST runtime.',
  'implemented',
  [21],
  ['start'],
);
rule(
  /^(?:Independently enable features|Independently disable features|Store server-specific configurations|Support live configuration changes)/i,
  ['system.features', 'community.configure'],
);
rule(/^Store user-specific configurations/i, ['ai.memory.save']);
rule(
  /^Support SQL databases/i,
  [],
  'Embedded SQLite only; PostgreSQL/MySQL adapters are not included.',
  'partial',
  [21],
);
rule(
  /^Use job queues/i,
  ['reminder.create'],
  'Bounded durable SQLite reminder jobs; no distributed workers.',
  'partial',
);
rule(
  /^Create structured diagnostic logs/i,
  [],
  'Structured JSON diagnostics redact configured credentials.',
  'implemented',
  [21],
  ['start'],
);
rule(/^Measure memory consumption/i, ['system.status']);
rule(
  /^Monitor API latency/i,
  ['system.status'],
  'Gateway ping only; no per-REST/OpenAI latency histogram.',
  'partial',
);
rule(/^Track failed requests/i, ['analytics.commands']);
rule(
  /^Handle Discord API rate limits/i,
  [],
  'discord.js REST bucket handling is used; no hardcoded attempt to bypass Discord limits.',
  'implemented',
  [21],
  ['start'],
);
rule(
  /^Rotate credentials securely/i,
  [],
  'Replace secrets locally and restart; automatic rotation/provisioning is not implemented.',
  'partial',
  [21],
);
rule(
  /^Run automated tests/i,
  [],
  'Offline node:test suite plus strict TypeScript compilation. Live credentials/server tests remain separate.',
  'implemented',
  [21],
  ['test', 'typecheck'],
);
rule(
  /^Implement database backups/i,
  [],
  'Offline SQLite backup script; restore requires an operator and stopped bot.',
  'implemented',
  [21],
  ['backup'],
);
rule(/^Audit sensitive administrative operations/i, ['system.audit']);

// High-level summary bullets intentionally receive partial coverage rather than a false all-in-one claim.
rule(
  /^(?:Server administration|Role management|Channel management|Member management|Moderation systems|Messaging and chat automation|Interactive menus and forms|Voice and audio systems|Music playback|Scheduled events|Reminders and timed automation|Games and entertainment|Virtual economies|Experience and leveling systems|Community engagement|Support-ticket management|Server analytics|Data reporting|Database storage|Scheduled background jobs|Multiple concurrently running feature modules|Multi-server operation)\./i,
  [],
  'Selected functions in this area are implemented. Refer to the detailed sections and actual action schemas for exact limits.',
  'partial',
  [22],
);
rule(
  /^(?:AI-powered conversations|Short-term conversational memory|Natural-language commands|Mention-based commands)\./i,
  [],
  'In an installed server, /ask provides private bounded member/server/channel context and permission-checked tool proposals with confirmations. Leading mentions and configured prefixes provide help or bounded public AI chat without administrative tools, preferences or retained history; public action requests redirect to private commands.',
  'implemented',
  [22],
  ['/ask', '@bot help', '@bot <prompt>'],
);
rule(/^(?:AI image generation|Image editing)\./i, ['ai.image', 'ai.image.edit']);
rule(/^Speech recognition\./i, ['ai.transcribe', 'voice.consent']);
rule(/^Text-to-speech\./i, ['voice.speak']);
rule(
  /^Conversational voice AI\./i,
  ['voice.consent'],
  'Individually consented local/OpenAI transcription, name-triggered ordinary Realtime replies and guarded typed-tool requests use bounded per-speaker turns and related follow-ups. Transcripts use a verified private channel; spoken output applies public-safe tool restrictions and fresh permissions. Smart confirmation policy and cancellation leases also apply to voice actions.',
  'partial',
);
rule(/^Slash commands\./i, [], 'Guild-installed slash commands.', 'implemented', undefined, [
  '/help',
  '/action',
  '/ask',
]);
rule(
  /^Long-term conversational memory\./i,
  ['ai.memory.save'],
  'Explicit saved preferences and bounded retained conversations.',
  'partial',
);
rule(
  /^Web research through external services\./i,
  [],
  'Optional OpenAI web_search, subject to model access and billing.',
  'implemented',
  undefined,
  ['/ask'],
);

const requirements = readFileSync(new URL('../docs/requirements.md', import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../docs/actions.json', import.meta.url), 'utf8')) as {
  id: string;
}[];
const ids = new Set(catalog.map((action) => action.id));
if (ids.size !== catalog.length) throw new Error('The action catalog contains duplicate IDs.');
if (reviewedCoverage.size !== 297)
  throw new Error('Every one of the 297 previously incomplete/alternative rows needs an explicit review.');
const knownConfiguration = new Set(
  readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []),
);
for (const field of [...OPTIONAL_INTEGRATION_FIELDS, ...ADDITIONAL_SERVICE_FIELDS])
  knownConfiguration.add(field.name);
let sectionNumber = 0,
  section = '',
  number = 0;
const entries: Capability[] = [];
for (const line of requirements.split(/\r?\n/)) {
  const heading = /^#{1,2} (\d+)\. (.+)$/.exec(line);
  if (heading) {
    sectionNumber = Number(heading[1]);
    section = heading[2]!;
    number = 0;
    continue;
  }
  if (!line.startsWith('- ')) continue;
  if (!sectionNumber) throw new Error('Requirement has no section heading.');
  const capability = line.slice(2).trim();
  const id = `s${String(sectionNumber).padStart(2, '0')}-${String(++number).padStart(3, '0')}`;
  const mapping = rules.find(
    (candidate) =>
      (!candidate.sectionNumbers || candidate.sectionNumbers.includes(sectionNumber)) &&
      candidate.test.test(capability),
  );
  const coverage: Coverage = reviewedCoverage.get(id) ??
    mapping ?? {
      status: 'unimplemented',
      actionIds: [],
      entryPoints: [],
      notes: 'No dedicated implementation is included in this build. This remains a backlog requirement.',
    };
  if (coverage.status === 'implemented' && !coverage.actionIds.length && !coverage.entryPoints.length)
    throw new Error(`Implemented capability has no executable evidence: ${capability}`);
  for (const actionId of coverage.actionIds)
    if (!ids.has(actionId)) throw new Error(`${id} references an unavailable action: ${actionId}`);
  if (coverage.evidence) {
    if (!coverage.evidence.sourceFiles.length || !coverage.evidence.testFiles.length)
      throw new Error(`${id} needs concrete source and test evidence.`);
    for (const path of [...coverage.evidence.sourceFiles, ...coverage.evidence.testFiles])
      if (path.startsWith('/') || path.includes('..') || !existsSync(new URL('../' + path, import.meta.url)))
        throw new Error(`${id} references an unavailable evidence file: ${path}`);
    for (const field of coverage.evidence.configuration)
      if (!knownConfiguration.has(field))
        throw new Error(`${id} references an undocumented configuration field: ${field}`);
  }
  entries.push({
    id,
    sectionNumber,
    section,
    capability,
    status: coverage.status,
    actionIds: coverage.actionIds,
    entryPoints: coverage.entryPoints,
    notes: coverage.notes,
    ...(coverage.evidence ? { evidence: coverage.evidence } : {}),
    ...(coverage.status === 'resolved_architecture'
      ? {
          architectureDecision: {
            selected:
              'TypeScript on Node.js 24; one Gateway owner and primary SQLite WAL database, bounded workers and optional companion services',
            resolution: coverage.notes,
          },
        }
      : {}),
  });
}
if (entries.length !== 909) throw new Error(`Expected all 909 original bullets; found ${entries.length}.`);
for (const id of reviewedCoverage.keys())
  if (!entries.some((entry) => entry.id === id))
    throw new Error(`Reviewed requirement is absent from the original list: ${id}`);
const counts = Object.fromEntries(
  (
    [
      'implemented',
      'partial',
      'external_setup',
      'unimplemented',
      'architectural_alternative',
      'resolved_architecture',
    ] as Status[]
  ).map((status) => [status, entries.filter((item) => item.status === status).length]),
);
const summary = Array.from(new Set(entries.map((entry) => entry.sectionNumber)))
  .map((n) => {
    const items = entries.filter((entry) => entry.sectionNumber === n);
    const count = (status: Status) => items.filter((item) => item.status === status).length;
    return `| ${n}. ${items[0]!.section} | ${count('implemented')} | ${count('partial')} | ${count('external_setup')} | ${count('unimplemented')} | ${count('resolved_architecture')} |`;
  })
  .join('\n');
const markdown = [
  '# Capability coverage',
  '',
  'The supplied list contains **909 bullets across 22 sections**. These bullets overlap and include alternative implementation choices; they are not 909 independent commands. This build registers **' +
    catalog.length +
    ' executable action schemas**. [requirements.md](requirements.md) preserves the original list, [capabilities.json](capabilities.json) records every bullet, and [actions.json](actions.json) lists the actual action inputs.',
  '',
  '**Implemented** means a concrete registered action or source entrypoint exists. A configurable optional adapter counts as implemented code while its required fields are blank; blank fields keep it unavailable. This is separate from live credentials, hosting, grants, billing, platform eligibility and acceptance testing. **External setup** below is reserved for a literal platform operation that a bot API cannot perform. **Resolved architecture** records a deliberately unselected alternative, not a claim that another language/distributed backend was implemented. Partial/unimplemented counts, if nonzero, are unfinished code and must not be hidden by setup language.',
  '',
  'The [reviewed acceptance matrix](ACCEPTANCE_MATRIX.md) documents the 297 previously partial, externally dependent, missing or alternative rows with concrete behavior, source/test files and exact configuration fields. Bounds, consent, current permissions, supported formats and honest observation gaps are part of each implemented contract.',
  '',
  '## Counts',
  '',
  '| Status | Original bullets |',
  '| --- | ---: |',
  ...Object.entries(counts).map(([status, count]) => '| ' + status + ' | ' + count + ' |'),
  '',
  '| Original section | Implemented | Partial | Platform setup | Unimplemented | Resolved design |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  summary,
  '',
  '## Platform operations that remain with the account owner',
  '',
  ...entries
    .filter((entry) => entry.status === 'external_setup')
    .map((entry) => '- **' + entry.id + ' — ' + entry.capability + '** ' + entry.notes),
  '',
  'Discord requires offering creation/pricing, Store configuration and discovery publication in its Developer Portal. The implemented premium module handles native purchase buttons, current user/guild entitlements, durable/consumable benefits, action/AI allowances, actual dashboard appearance, usage/lifecycle analytics and support. It does not impersonate unsupported SKU/pricing/publication APIs. See [managing SKUs](https://docs.discord.com/developers/monetization/managing-skus), [monetization setup](https://docs.discord.com/developers/monetization/enabling-monetization) and [discovery setup](https://support-dev.discord.com/hc/en-us/articles/6378525413143-App-Directory-App-profile-pages).',
  '',
  '## Selected operating design',
  '',
  '[Architecture](ARCHITECTURE.md) selects TypeScript on Node.js 24, one Gateway owner and primary SQLite WAL database, bounded worker threads/subprocesses, optional named provider adapters and companion HTTP services. Alternative language rewrites, HTTP interaction dispatch, Redis/a separate vector database and distributed primary/sharded deployment are resolved design choices. Optional approved PostgreSQL reads, remote host agents and independent monitors have their own concrete implementations; they do not distribute primary SQLite ownership.',
  '',
  '## Working contracts',
  '',
  '- Actions use strict schemas, current member/bot permissions, role hierarchy, per-server policies and exact expiring confirmations for changes. Durable plans and staged approvals share one engine. Unknown remote outcomes require inspection/reconciliation instead of blind write retry.',
  '- [Optional service adapters](OPTIONAL_INTEGRATIONS.md) implement real selected Google, GitHub, GitLab, Trello, Notion, YouTube, Twitch, email/SMS, reputation, CAPTCHA, Steam, parcel, commerce, social, video and cloud APIs. [Optional setup and OAuth](OPTIONAL_SETUP.md) supplies account-owned grants; host shared credentials require operator authority. Empty provider fields disable discovery/execution; supplied fields do not prove account authorization.',
  '- [AI workflows](AI_WORKFLOWS.md) add exact arithmetic, private durable pins, source/role-scoped knowledge, bounded paginated analysis, deterministic configured model routes, per-person/admin policies and immutable reviewed multi-step plans. [Ticket AI](TICKET_AI.md) can use approved readable content, private-thread tickets, priority/locale and fixed category routing.',
  '- [Voice](VOICE.md) verifies the actual lazy Opus/DAVE runtime, supports compressed authorized attachments and fixed audio sources, durable music references, current-track volume and voice/Stage moves. Receiving, acoustic VAD, transcription, spoken commands/replies, summaries and persistent individual WAV archives require their disclosed separate consent and bounds.',
  '- [Media](MEDIA.md) and [audio/video](AUDIO_MEDIA.md) produce real bounded image/file outputs: typed ordered filters, transparent backgrounds, charts/cards/statistics bindings, XLSX, emoji/soundboard preparation, perceptual duplicate indexing and FFmpeg effects. Supported file formats are explicit; no universal binary/layout converter is claimed.',
  '- Hosted [Activities](ACTIVITIES.md) are actual bundled Embedded App SDK applications with authenticated shared games, quizzes/learning, whiteboard, tasks/editor, maps, simulation and room statistics. [Native Game Stats Widgets](GAME_STATS_WIDGETS.md) use the separate actual Application Identity Profile API, with a verified personal grant and operator-approved game identity/stat source. Native game claiming and widget layout configuration remain Portal setup.',
  '- [Premium](PREMIUM.md), authenticated dashboards, signed inbound/outbound event routes, approved local/remote operations, immutable code deployment/rollback and independent uptime monitoring have concrete modules. The database, backups, retained consented data, configuration files and host privileges require normal operator protection.',
  '',
  'Offline tests verify executable behavior, schemas, codecs, real media processing, durable recovery and adversarial authority/source changes. They do not prove live Discord/OpenAI/provider login, UDP reachability, privileged intents, product eligibility or production uptime. [Verification](VERIFICATION.md) records the actual checks and remaining live acceptance work.',
  '',
  '## Regeneration',
  '',
  'Run `pnpm capabilities` after action changes. Generation checks all 909 original IDs, every mapped registered action, all 297 reviewed rows, cited source/test files and configuration field names. Source/test references are evidence pointers, not a substitute for running the tests or manual live acceptance.',
  '',
].join('\n');
const escapeCell = (value: string) => value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
const links = (paths: string[]) => paths.map((path) => '[' + path + '](../' + path + ')').join('<br>');
const matrix = [
  '# Reviewed acceptance matrix',
  '',
  'This matrix covers all **297 previously incomplete or alternative rows**. A source/test reference identifies the concrete contract to inspect. Optional configuration remains separate from implementation and live acceptance. The authoritative list of all 909 original bullets is [capabilities.json](capabilities.json).',
  '',
  '| ID and original requirement | Decision / concrete behavior | Actions | Source / tests | Optional fields / operator setup |',
  '| --- | --- | --- | --- | --- |',
  ...entries
    .filter((entry) => reviewedCoverage.has(entry.id))
    .map((entry) => {
      const evidence = entry.evidence!;
      return (
        '| ' +
        escapeCell(entry.id + ' — ' + entry.capability) +
        ' | ' +
        escapeCell(entry.status + ': ' + entry.notes) +
        ' | ' +
        escapeCell(entry.actionIds.join(', ') || 'Source entrypoint / design decision') +
        ' | ' +
        links([...evidence.sourceFiles, ...evidence.testFiles]) +
        ' | ' +
        escapeCell(
          [...evidence.configuration, ...evidence.operatorSetup].join('; ') ||
            'Normal bot permissions and deployment setup',
        ) +
        ' |'
      );
    }),
  '',
].join('\n');
writeFileSync(
  new URL('../docs/capabilities.json', import.meta.url),
  JSON.stringify(
    {
      schemaVersion: 2,
      source: 'requirements.md',
      actionCount: catalog.length,
      counts,
      semantics: {
        implemented: 'Executable supported code; optional setup/live verification separate',
        external_setup: 'Literal account/platform operation requiring Developer Portal or service owner',
        resolved_architecture: 'Alternative resolved by the selected TypeScript/Gateway/SQLite architecture',
      },
      architecture: {
        decision:
          'TypeScript/Node.js24 modular monolith, primary Gateway/SQLite WAL, bounded workers and optional companion services',
        document: 'ARCHITECTURE.md',
      },
      capabilities: entries,
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  new URL('../docs/CAPABILITIES.md', import.meta.url),
  await format(markdown, { parser: 'markdown' }),
);
writeFileSync(
  new URL('../docs/ACCEPTANCE_MATRIX.md', import.meta.url),
  await format(matrix, { parser: 'markdown' }),
);
process.stdout.write(
  JSON.stringify({
    requirements: entries.length,
    actions: catalog.length,
    reviewed: reviewedCoverage.size,
    ...counts,
  }) + '\n',
);
