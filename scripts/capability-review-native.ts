import type { CapabilityStatus } from './capability-review.js';
export type NativeCapabilityReviewer = (
  ids: string,
  actions: string,
  sources: string,
  tests: string,
  notes: string,
  configuration?: string[],
  status?: CapabilityStatus,
  operatorSetup?: string[],
) => void;
/** Literal requirement review: domain summaries inherit their concrete implementations and account setup. */
export function registerNativeCapabilityReviews(review: NativeCapabilityReviewer): void {
  review(
    's13-006',
    'character.set character.view game.create game.move',
    'src/features/games.ts',
    'test/games.test.ts',
    'Persist character profiles and run the supported adventure/roleplaying game state through validated game actions; the requirement does not prescribe an unrestricted tabletop rules engine.',
  );
  review(
    's13-012',
    'currency.create currency.list currency.balance currency.adjust currency.transfer currency.history currency.delete',
    'src/features/community-extra.ts',
    'test/community-extra.test.ts',
    'Define separate fictional integer currencies with supply caps, isolated wallets, atomic transfers, bounded ledger history and zero-supply deletion. No cash value or payment entry is implied.',
  );
  review(
    's13-039',
    'giveaway.create giveaway.enter',
    'src/features/community.ts',
    'test/community.test.ts',
    'Configure required roles, account age, membership age and community level; verify at entry and again for each currently selected winner. Persist the random candidate before awaited lookup so interruptions do not rerandomize it.',
  );
  review(
    's13-040',
    'raffle.create raffle.enter raffle.withdraw raffle.draw raffle.view raffle.export raffle.cancel raffle.delete',
    'src/features/community-extra.ts',
    'test/community-extra.test.ts',
    'Run explicitly free-entry raffles with immutable rules, numbered receipts, current candidate eligibility, cryptographic random selection, persisted draw digest and review of ambiguous announcements. Paid gambling and monetary consideration are excluded by the actual free-entry contract.',
  );
  review(
    's13-043',
    'game.leaderboard integration.steam.stats',
    'src/features/games.ts src/features/optional-integrations.ts',
    'test/games.test.ts test/optional-integrations.test.ts',
    'Display persisted local game rankings and optionally fetch real authorized Steam player/game statistics. External scores are reported as provider data, not falsely merged into local rankings.',
    ['STEAM_API_KEY'],
  );
  review(
    's13-044',
    'integration.watch schedule.set workflow.set',
    'src/features/integrations.ts src/features/automation.ts',
    'test/integrations.test.ts test/automation.test.ts',
    'Announce operator-scheduled game maintenance and monitor an authorized game service public HTTPS uptime/status page for changes. Native game-protocol status is separately supported by integration.minecraft-status; arbitrary private game administration is not inferred.',
  );
  review(
    's13-045',
    'integration.steam.achievements integration.provider-watch.create',
    'src/features/optional-integrations.ts',
    'test/optional-integrations.test.ts',
    'Fetch actual Steam game achievements and poll a selected SteamID/AppID for achievement changes with a durable baseline and permission-checked notification destination. Private profiles remain subject to provider access.',
    ['STEAM_API_KEY'],
  );
  review(
    's14-005',
    'ai.knowledge.add ai.knowledge.search ai.knowledge.shared-add ai.knowledge.shared-ask',
    'src/features/ai.ts src/features/knowledge.ts src/features/ai-enhancements.ts',
    'test/knowledge.test.ts test/ai-enhancements.test.ts',
    'Search bounded private/shared semantic knowledge with role/source/version checks, cited source excerpts and no private-memory disclosure to shared requests.',
    ['OPENAI_API_KEY'],
  );
  review(
    's14-015',
    'ticket.archive',
    'src/features/community.ts',
    'test/community.test.ts',
    'Archive a retained support channel by preserving history and explicitly denying the ticket owner access. Archival metadata and staff access remain available; no third-party file-storage provider is required by the literal action.',
  );
  review(
    's14-016',
    'ticket.transcript ticket.thread-transcript',
    'src/features/community.ts src/features/thread-tickets.ts src/features/history.ts',
    'test/community.test.ts test/thread-tickets.test.ts test/native-completion.test.ts',
    'Export readable channel/private-thread history with source IDs, attachment links, before/after ranges, bounded pages and exact continuation until complete. Current participant, private-thread membership and history access are checked during and after reading. Deleted content cannot be reconstructed.',
  );
  review(
    's14-026',
    'form.publish form.submit form.review',
    'src/features/interfaces.ts',
    'test/interfaces.test.ts',
    'Validate, persist, route and apply configured accepted-application role effects through the durable form lifecycle, with separate current staff review and hierarchy checks. Automatic processing does not imply automatic approval of every application.',
  );
  review(
    's14-035',
    'calendar.create calendar.rsvp calendar.checkin calendar.export',
    'src/features/automation.ts',
    'test/automation.test.ts',
    'Persist event signups, capacities, FIFO waitlists, withdrawal/promotion and attendance/export for the selected local event.',
  );
  review(
    's14-037',
    'translation.configure translation.consent translation.preferences',
    'src/features/message-workflows.ts src/features/ticket-ai.ts',
    'test/message-workflows.test.ts test/ticket-ai.test.ts',
    'Translate messages in the approved support channel after per-author consent and retain optional inferred ticket locale in classification. The source policy and author consent are refreshed before publishing; private support content is not passively uploaded without consent.',
    ['OPENAI_API_KEY'],
  );
  review(
    's14-038',
    'role.create ui.roles.publish notification.subscribe',
    'src/discord/actions/members.ts src/features/interfaces.ts src/features/identity.ts',
    'test/discord-actions.test.ts test/interfaces.test.ts test/identity.test.ts',
    'Create ordinary notification roles and publish self-service role controls, with current role hierarchy/safe-role checks. Individual DM notification subscriptions are independently opt-in.',
  );

  review(
    's18-025',
    'workflow.set premium.subscriptions premium.analytics',
    'src/features/automation.ts src/features/premium.ts src/features/webhook-events.ts',
    'test/automation.test.ts test/premium.test.ts test/webhook-events.test.ts',
    'Record actual application subscription lifecycle events independently of guild attribution; route only attributable allowed-guild workflows and reconcile premium access from authoritative Discord subscription/entitlement state.',
    ['PREMIUM_POLICY_FILE'],
  );
  review(
    's18-030 s18-031',
    'workflow.set webhook.events.status ai.plan.step',
    'src/features/automation.ts src/features/webhook-events.ts src/features/ai-enhancements.ts src/core/registry.ts',
    'test/automation.test.ts test/webhook-events.test.ts test/ai-enhancements.test.ts',
    'Deduplicate signed/event fingerprints, claim one-use confirmations, persist completed plan/workflow steps and retain stable message nonces. Unknown effects require reconciliation; distributed exactly-once delivery across external APIs is not claimed.',
  );
  review(
    's18-032',
    'automation.external.configure automation.external.status automation.external.remove',
    'src/features/external-automation.ts src/integrations/http.ts',
    'test/deployment-database-automation.test.ts',
    'Send selected Discord event metadata through a durable bounded outbox to the fixed operator HTTPS endpoint. Sign exact bodies, pin public DNS, reauthorize after DNS and retry with a stable receiver idempotency key. Message content is excluded.',
    ['OUTBOUND_AUTOMATION_URL', 'OUTBOUND_AUTOMATION_KEY'],
  );
  review(
    's18-033',
    'approval.chain.create approval.chain.view approval.chain.review approval.chain.withdraw approval.chain.renew approval.chain.cancel',
    'src/features/approval-chains.ts src/features/ai-enhancements.ts',
    'test/approval-chains.test.ts',
    'Attach staged independent reviewer quorums to the immutable shared AI plan engine. Bind votes to exact content, prohibit self/multi-stage votes, revalidate every reviewer and stop future steps on rejection, withdrawal, expiry or changed authority.',
  );
  review(
    's18-035',
    'dashboard.login analytics.observed statuspanel.create',
    'src/features/dashboard.ts src/features/security.ts src/features/message-workflows.ts',
    'test/dashboard.test.ts test/security.test.ts test/message-workflows.test.ts',
    'Render persisted event-derived metrics and process status in the authenticated web dashboard and a persistent Discord status panel; bounded polling delivers updates without inventing an unrestricted widget builder or a streaming transport requirement.',
    ['ENABLE_DASHBOARD', 'DASHBOARD_BASE_URL'],
  );

  review(
    's21-001 s21-002 s21-003 s21-004 s21-005 s21-006 s21-007',
    '',
    'src/main.ts src/app.ts scripts/start.mjs scripts/supervise.mjs Dockerfile compose.yaml',
    'test/app.test.ts test/portable.test.ts test/startup-release.test.ts test/supervisor.test.ts',
    'Provide Node24 continuous-process startup, controlled restart/drain, readiness health checks and a non-root Linux Docker deployment. Portable paths and destination-platform dependency installation support Windows/Linux and appropriately configured VPS/cloud hosts. Actual uptime depends on the operator running the supplied deployment; an offline test cannot certify a specific unprovisioned host.',
    ['DISCORD_TOKEN'],
    'implemented',
    [
      'Install Node24 and locked platform-compatible dependencies, or build the supplied Docker image. Configure persistent data and the host process/service or container restart policy.',
    ],
  );
  review(
    's21-008 s21-011 s21-012 s21-013 s21-014 s21-015',
    '',
    'docs/ARCHITECTURE.md package.json src/main.ts',
    'test/portable.test.ts test/app.test.ts',
    'The user authorized choosing one architecture. TypeScript/Node24 is the selected maintainable implementation; Python, Rust, Go, Java, C# and unspecified alternative-language rewrites are resolved design alternatives, not runtime features claimed to exist.',
    [],
    'resolved_architecture',
  );
  review(
    's21-018',
    '',
    'docs/ARCHITECTURE.md src/app.ts src/core/http.ts',
    'test/app.test.ts test/hosted-services.test.ts',
    'Gateway interaction dispatch is selected. HTTP companions implement health, OAuth, dashboards, Activities and signed webhooks; a second HTTP interaction dispatcher is an unselected transport alternative.',
    [],
    'resolved_architecture',
  );
  review(
    's21-026 s21-027',
    'database.queries database.query',
    'src/core/store.ts src/features/external-database.ts',
    'test/core.test.ts test/deployment-database-automation.test.ts',
    'Maintain the primary prepared-statement SQLite WAL store and optionally query a separate PostgreSQL database through named parameterized reads in read-only transactions. This supports multiple SQL databases without claiming SQLite itself is a distributed store or an unsupported MySQL adapter.',
    ['EXTERNAL_DATABASE_URL', 'EXTERNAL_DATABASE_QUERIES_FILE'],
  );
  review(
    's21-028 s21-029',
    '',
    'docs/ARCHITECTURE.md src/core/store.ts src/features/knowledge.ts',
    'test/core.test.ts test/knowledge.test.ts',
    'SQLite-backed bounded caches and local semantic-vector retrieval are the selected low-overhead design. Redis and a separate vector database are resolved alternatives for an operating envelope that does not need distributed cache/database ownership.',
    [],
    'resolved_architecture',
  );
  review(
    's21-031 s21-035',
    'image.resize file.extract',
    'src/features/media.ts src/features/files.ts',
    'test/media.test.ts test/files.test.ts',
    'Offload real expensive image/document work to bounded worker_threads using additional CPU cores while preserving a responsive primary Gateway event loop. The requirement does not require primary SQLite writes to become a multi-process cluster.',
  );
  review(
    's21-036 s21-037',
    '',
    'docs/ARCHITECTURE.md src/app.ts src/features/remote-host.ts src/host-agent/service.ts',
    'test/app.test.ts test/host-agent.test.ts',
    'One primary Gateway/database process is selected. Separate authenticated host agents and monitors can run elsewhere, but primary multi-machine work distribution and Gateway sharding remain explicitly unselected alternatives requiring a future ownership/leadership design.',
    [],
    'resolved_architecture',
  );
  review(
    's21-042',
    'analytics.api-latency analytics.command-latency analytics.resources',
    'src/features/security.ts',
    'test/security.test.ts',
    'Measure an actual harmless Discord GET /gateway REST round trip and retain30 samples, alongside Gateway heartbeat and observed action duration averages. REST timing includes SDK queue/network overhead; it does not pretend to provide endpoint-wide OpenAI histograms.',
  );
  review(
    's21-045',
    '',
    'scripts/configure-env.ts src/core/environment.ts scripts/supervise.mjs docs/ARCHITECTURE.md',
    'test/configure-env.test.ts test/supervisor.test.ts',
    'Support host-only provider credential replacement through local environment configuration and a controlled restart, without exposing secret values through Discord. Provider key issuance/revocation remains the operator’s authorized account operation; no unsupported autonomous key-provisioning API is claimed.',
  );
  review(
    's21-047',
    'deployment.releases deployment.activate deployment.status',
    'src/features/deployment.ts scripts/stage-release.mjs scripts/start.mjs scripts/supervise.mjs',
    'test/deployment-database-automation.test.ts test/startup-release.test.ts test/supervisor.test.ts',
    'Stage reviewed immutable built releases, verify the exact manifest and every listed file hash, create a consistent SQLite snapshot, atomically select code and restart through a verifying launcher. Operator authority and supported schema are rechecked; backup/history retention is bounded.',
    ['DEPLOYMENT_RELEASES_DIRECTORY', 'DEPLOYMENT_ACTIVE_FILE', 'OPERATOR_IDS'],
  );
  review(
    's21-048',
    'deployment.rollback deployment.status',
    'src/features/deployment.ts scripts/start.mjs scripts/supervise.mjs',
    'test/deployment-database-automation.test.ts test/startup-release.test.ts',
    'Select only the exact known previous compatible release after verification and a fresh consistent SQLite snapshot. Rollback switches code and preserves current database content; it does not reverse remote Discord effects or claim automatic schema/data rollback.',
    ['DEPLOYMENT_RELEASES_DIRECTORY', 'DEPLOYMENT_ACTIVE_FILE', 'OPERATOR_IDS'],
  );
  review(
    's21-049',
    '',
    'src/monitor/service.ts src/monitor/main.ts',
    'test/monitor.test.ts',
    'Run an independent readiness monitor with repeated-observation outage/recovery thresholds and persisted pending transition notifications. Failed notifications retry after ticks/restart; bounded overflow is summarized. Ambiguous remote acceptance can duplicate an alert.',
    ['MONITOR_TARGET_URL', 'MONITOR_DISCORD_WEBHOOK_URL'],
    'implemented',
    ['Run the monitor separately; another host is needed to observe the bot host itself being offline.'],
  );
  review(
    's21-052',
    'dashboard.login oauth.start',
    'src/features/dashboard.ts src/services/account-linking.ts src/discord/dashboard-page.ts',
    'test/dashboard.test.ts test/account-linking.test.ts',
    'Serve a real authenticated remote control dashboard using exact registry schemas, source-bound sessions, current permissions and one-use action confirmations. Optional Discord OAuth login provides an account-authenticated route; this remains an operator/staff surface rather than an unauthenticated public control panel.',
    [
      'ENABLE_DASHBOARD',
      'DASHBOARD_BASE_URL',
      'APP_PUBLIC_URL',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
    ],
  );

  review(
    's22-001',
    'guild.edit guild.community guild.onboarding-edit layout.snapshot.save layout.restore.plan',
    'src/discord/actions/guild.ts src/features/server-layout.ts',
    'test/native-completion.test.ts test/server-layout.test.ts',
    'Umbrella server administration uses typed guild editors, topology snapshots and exact reviewed restore plans; see detailed server requirements for supported settings and Discord eligibility.',
  );
  review(
    's22-002',
    'role.create role.edit role.assign-many',
    'src/discord/actions/members.ts',
    'test/discord-actions.test.ts',
    'Umbrella role management includes typed creation/editing, permission and hierarchy checks and reviewed assignments. Managed roles and Discord’s hierarchy restrictions remain platform rules.',
  );
  review(
    's22-003',
    'channel.create channel.edit channel.lock channel.unlock thread.edit',
    'src/discord/actions/channels.ts',
    'test/discord-actions.test.ts test/native-completion.test.ts',
    'Umbrella channel/thread/forum management uses native schemas and exact-lock snapshot recovery; see detailed channel actions.',
  );
  review(
    's22-004',
    'member.kick member.ban member.timeout member.permissions-compare',
    'src/discord/actions/members.ts',
    'test/discord-actions.test.ts test/native-completion.test.ts',
    'Umbrella member management uses current guild membership, hierarchy and action-specific native permissions.',
  );
  review(
    's22-005',
    'warning.configure warning.issue moderation.tempban case.list appeal.review',
    'src/features/moderation.ts src/features/temporary-bans.ts src/features/community.ts',
    'test/moderation.test.ts test/temporary-bans.test.ts test/community.test.ts',
    'Umbrella moderation combines native punishments, warning escalation, durable marked expiry, unified cases and staff-reviewed appeals.',
  );
  review(
    's22-006',
    'security.configure security.lockdown.apply integration.security.url-report',
    'src/features/security.ts src/features/optional-integrations.ts',
    'test/security.test.ts test/optional-integrations.test.ts',
    'Umbrella security includes opt-in raid/content/administrative-change detection, immediate privilege alerts, bounded recoverable lockdown and optional real VirusTotal reputation. Detection is evidence-based and cannot guarantee classification of every threat.',
    ['VIRUSTOTAL_API_KEY'],
  );
  review(
    's22-007',
    'message.send relay.configure tracking.watch conversation.channel.configure',
    'src/discord/actions/messages.ts src/features/message-automation.ts',
    'test/native-completion.test.ts test/message-automation.test.ts',
    'Umbrella messaging includes reviewed delivery, explicit mentions, resumable history, author-consented continuous relays, reaction/reply tracking and separately scoped public conversations.',
    ['OPENAI_API_KEY'],
  );
  review(
    's22-012 s22-013',
    'voice.join voice.play voice.queue.restore audio.convert',
    'src/features/voice.ts src/features/audio-media.ts src/voice/runtime.ts',
    'test/voice.test.ts test/voice-runtime.test.ts test/audio-media.test.ts',
    'Umbrella voice/audio/music uses lazy verified transport/codec loading, authorized playback sources, durable queue references and real FFmpeg processing. Actual UDP/Discord voice connectivity still requires live account/network setup.',
    ['ENABLE_VOICE'],
  );
  review(
    's22-016',
    'voice.consent',
    'src/features/voice.ts src/app.ts',
    'test/voice.test.ts',
    'Conversational voice AI processes separately consented speaker utterances into AI text/synthetic speech, with actual silence rejection and fresh source/consent checks. Bounded turns are the implemented conversational contract.',
    ['ENABLE_VOICE', 'OPENAI_API_KEY'],
  );
  review(
    's22-017',
    'event.create calendar.create calendar.rsvp eventroles.configure tournament.schedule',
    'src/discord/actions/resources.ts src/features/automation.ts src/features/event-roles.ts',
    'test/discord-actions.test.ts test/automation.test.ts test/event-roles.test.ts',
    'Umbrella scheduled events combines native Discord scheduled events, durable local signups/waitlists/attendance, temporary event-role synchronization and dated tournament announcements.',
  );
  review(
    's22-018 s22-047',
    'reminder.create schedule.set operation.schedule.set',
    'src/core/scheduler.ts src/features/automation.ts src/features/operations.ts',
    'test/core.test.ts test/automation.test.ts test/operations.test.ts',
    'Persist reminders, UTC cron announcements, one-time match announcements and approved fixed local operations with bounded execution, current authority and restart-safe state.',
  );
  review(
    's22-021',
    'ai.memory.save ai.memory.pin ai.memory.pins ai.memory.forget',
    'src/features/ai.ts src/features/ai-enhancements.ts',
    'test/ai.test.ts test/ai-enhancements.test.ts',
    'Keep explicit private preferences and pinned long-term memories alongside bounded retained conversational context; owner erasure invalidates pending private work.',
    ['OPENAI_API_KEY'],
  );
  review(
    's22-025',
    'video.convert video.thumbnail integration.video.generate integration.video.render',
    'src/features/audio-media.ts src/features/optional-integrations.ts',
    'test/audio-media.test.ts test/optional-integrations.test.ts',
    'Process uploaded MP4/WebM through fixed FFmpeg pipelines and optionally create provider video/timeline renders. Exact supported formats, durations, provider access and privacy remain explicit.',
    ['RUNWAY_API_KEY', 'SHOTSTACK_API_KEY'],
  );
  review(
    's22-026 s22-027',
    'file.convert file.xlsx file.docx file.pptx file.extract',
    'src/features/files.ts src/core/files.ts',
    'test/files.test.ts',
    'Generate and convert supported Office/tabular/text/PDF/raster artifacts using real parsers/workers; supported format and layout bounds are stated instead of implying a universal converter.',
  );
  review(
    's22-028',
    'file.extract ai.document.analyze',
    'src/features/files.ts src/features/ai-enhancements.ts',
    'test/files.test.ts test/ai-enhancements.test.ts',
    'Extract supported document contents and analyze explicitly selected document/image inputs with bounded source coverage and no execution of document instructions.',
    ['OPENAI_API_KEY'],
  );
  review(
    's22-029',
    'game.create game.move pet.adopt trade.offer tournament.create',
    'src/features/games.ts src/features/automation.ts src/activities/state.ts',
    'test/games.test.ts test/automation.test.ts test/activity-state.test.ts',
    'Run persistent text/board/adventure games, collectibles, trading and tournament brackets, plus the implemented authoritative graphical Activity modes. Each game exposes explicit supported rules.',
  );
  review(
    's22-030',
    'economy.balance economy.transfer currency.create currency.transfer',
    'src/features/community.ts src/features/community-extra.ts',
    'test/community.test.ts test/community-extra.test.ts',
    'Provide the built-in fictional coin economy and separately named supply-capped currencies with transactional accounting and bounded ledgers; balances have no real-money value.',
  );
  review(
    's22-031',
    'level.profile level.leaderboard',
    'src/features/community.ts',
    'test/community.test.ts',
    'Award opted-in observed XP with cooldowns, compute levels and display server-scoped profiles/rankings; unavailable offline activity is not reconstructed.',
  );
  review(
    's22-032',
    'group.enroll engagement.questions.set engagement.milestone.set suggestion.submit calendar.rsvp',
    'src/features/engagement.ts src/features/interfaces.ts src/features/automation.ts',
    'test/engagement.test.ts test/interfaces.test.ts test/automation.test.ts',
    'Umbrella engagement includes consented groups/waitlists, questions/milestones, forms, suggestions, safe rewards and event signups with finite per-server limits.',
  );
  review(
    's22-033',
    'ticket.open ticket.thread-open ticket.archive ticket.transcript ticket.thread-transcript',
    'src/features/community.ts src/features/thread-tickets.ts src/features/ticket-ai.ts',
    'test/community.test.ts test/thread-tickets.test.ts test/ticket-ai.test.ts',
    'Manage authorized channel/private-thread support tickets, assignments, classification, archival, satisfaction and resumable transcripts while preserving current staff/participant/source access.',
  );
  review(
    's22-034 s22-035',
    'analytics.observed analytics.compare analytics.observed.export analytics.command-latency',
    'src/features/security.ts',
    'test/security.test.ts',
    'Report/export retained observed server aggregates, activity, week comparisons and action timing; private/erased/unobserved histories remain excluded.',
  );
  review(
    's22-036',
    'integration.github integration.google-calendar.events integration.steam.achievements integration.security.url-report',
    'src/features/optional-integrations.ts src/features/public-services.ts src/integrations/http.ts',
    'test/optional-integrations.test.ts test/public-services.test.ts',
    'Provide concrete fixed-origin typed third-party adapters and public-service protocols; each adapter remains unavailable until its required credentials/account permissions are configured. See detailed integration rows and the optional integration guide.',
  );
  review(
    's22-037',
    'operation.tasks operation.run operation.schedule.set host.tasks host.run',
    'src/features/operations.ts src/features/remote-host.ts src/host-agent/service.ts',
    'test/operations.test.ts test/host-agent.test.ts',
    'Run only host-curated fixed local/remote tasks with immutable reviewed definitions, operator authority, signatures, deadlines and explicit reconciliation of interrupted tasks. No Discord shell or arbitrary executable path is exposed.',
    ['LOCAL_OPERATIONS_MANIFEST', 'REMOTE_AGENT_URL', 'REMOTE_AGENT_KEY'],
  );
  review(
    's22-038',
    'oauth.start oauth.link.confirm oauth.accounts oauth.identity oauth.unlink oauth.guild.join oauth.linked-role.update',
    'src/services/account-linking.ts',
    'test/account-linking.test.ts',
    'Implement consent-bound Discord/GitHub authorization, expiring state/PKCE, encrypted server-side tokens, explicit ownership proof, own-identity reads, Linked Role updates, self-join and unlink/revocation. Public callback URLs and provider scopes must be registered to the operator’s application.',
    [
      'APP_PUBLIC_URL',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'GITHUB_OAUTH_CLIENT_ID',
      'GITHUB_OAUTH_CLIENT_SECRET',
    ],
  );
  review(
    's22-039',
    'webhook.events.status deployment.notifications.configure automation.external.configure',
    'src/features/webhook-events.ts src/features/external-automation.ts',
    'test/webhook-events.test.ts test/deployment-database-automation.test.ts',
    'Process signed Discord application events, signed deployment notifications and fixed outgoing metadata webhooks using durable deduplication, current routing policies and bounded recovery. Public HTTPS/Portal subscriptions remain hosting/account setup.',
    ['DEPLOYMENT_WEBHOOK_SECRET', 'OUTBOUND_AUTOMATION_URL', 'OUTBOUND_AUTOMATION_KEY'],
  );
  review(
    's22-041 s22-042',
    '',
    'src/activities/service.ts src/activities/state.ts web/activity.js web/activity.css',
    'test/activity-state.test.ts test/hosted-services.test.ts',
    'Ship the Embedded App SDK graphical frontend and authoritative persisted Activity state with authenticated sessions, source/channel access, revision checks, bounded polling and supported shared games/boards/widgets. Configure its public HTTPS URL Mapping in Discord before launch.',
    ['ACTIVITY_PUBLIC_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  );
  review(
    's22-043 s22-044',
    'premium.catalog premium.purchase premium.status premium.claim premium.subscriptions premium.usage premium.analytics',
    'src/features/premium.ts src/features/entitlement-roles.ts',
    'test/premium.test.ts test/entitlement-roles.test.ts',
    'Implement configured existing-SKU purchase buttons, verified entitlement/subscription access, durable consumable credit claims/usage, premium themes/interfaces, role lifecycle, support and analytics. SKU creation, listing/pricing, discovery and payout eligibility remain explicitly platform setup in the detailed premium rows; this umbrella does not claim an unsupported billing administration API.',
    ['PREMIUM_POLICY_FILE'],
    'implemented',
    [
      'Create/approve the desired SKUs, prices, store listing and payout/account setup in the Developer Portal, then map existing own-application SKUs in the local premium policy.',
    ],
  );
  review(
    's22-045',
    'dashboard.login oauth.start',
    'src/features/dashboard.ts src/services/account-linking.ts src/discord/dashboard-page.ts',
    'test/dashboard.test.ts test/account-linking.test.ts',
    'Provide the authenticated optional web dashboard and exact confirmed action console with observed event metrics, source-bound sessions, current operator/staff authority and optional OAuth account login.',
    [
      'ENABLE_DASHBOARD',
      'DASHBOARD_BASE_URL',
      'APP_PUBLIC_URL',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
    ],
  );
  review(
    's22-046',
    'database.queries database.query',
    'src/core/store.ts src/features/external-database.ts',
    'test/core.test.ts test/deployment-database-automation.test.ts',
    'Use prepared SQLite WAL persistence for domain state and optionally access a separate approved read-only PostgreSQL data source; schema guards and consistent snapshots protect supported upgrades.',
    ['EXTERNAL_DATABASE_URL', 'EXTERNAL_DATABASE_QUERIES_FILE'],
  );
  review(
    's22-048 s22-049',
    '',
    'src/app.ts src/core/store.ts src/core/registry.ts',
    'test/app.test.ts test/core.test.ts test/community.test.ts',
    'Compose concurrently usable feature modules around one registry and guild-scoped state/permissions/quotas, supporting multiple admitted Discord servers. A single primary process is the chosen architecture and does not imply Gateway sharding or multi-machine SQLite writers.',
  );
  review(
    's22-050',
    'integration.watch analytics.resources analytics.api-latency host.status',
    'src/features/integrations.ts src/features/security.ts src/features/remote-host.ts src/monitor/service.ts',
    'test/integrations.test.ts test/security.test.ts test/host-agent.test.ts test/monitor.test.ts',
    'Monitor authorized public uptime/content, actual REST latency, local process resources and authenticated remote-host status; the independent persisted-notification monitor detects bot downtime. Run its process on another host to detect host-wide outages.',
    ['REMOTE_AGENT_URL', 'REMOTE_AGENT_KEY', 'MONITOR_TARGET_URL', 'MONITOR_DISCORD_WEBHOOK_URL'],
  );
}
