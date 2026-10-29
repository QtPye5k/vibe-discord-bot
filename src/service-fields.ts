import { OPTIONAL_INTEGRATION_FIELDS, type IntegrationField } from './integrations/provider-catalog.js';
const field = (name: string, provider: string, secret: boolean, description: string): IntegrationField => ({
  name,
  provider,
  secret,
  description,
});
/** Optional configuration only; empty values never grant external access. */
export const ADDITIONAL_SERVICE_FIELDS: readonly IntegrationField[] = [
  field(
    'APP_PUBLIC_URL',
    'oauth',
    false,
    'Public HTTPS origin for account linking and hosted companion routes; loopback HTTP is accepted for development.',
  ),
  field('DISCORD_CLIENT_ID', 'oauth', false, 'Discord application ID for OAuth and Embedded App SDK.'),
  field('DISCORD_CLIENT_SECRET', 'oauth', true, 'Discord OAuth client secret, distinct from the bot token.'),
  field(
    'GITHUB_OAUTH_CLIENT_ID',
    'oauth',
    false,
    'Optional GitHub OAuth application client ID for linked account verification.',
  ),
  field('GITHUB_OAUTH_CLIENT_SECRET', 'oauth', true, 'GitHub OAuth application client secret.'),
  field(
    'OAUTH_ENCRYPTION_KEY',
    'oauth',
    true,
    'Optional 32-byte base64 encryption key; a private local data key is created when omitted.',
  ),
  field(
    'OAUTH_JOIN_GUILD_IDS',
    'oauth',
    false,
    'Comma-separated operator-approved target server IDs for explicit OAuth self-join. The bot must already belong to each selected server.',
  ),
  field(
    'ACTIVITY_PUBLIC_URL',
    'activities',
    false,
    'Public HTTPS origin serving the Activity; configure its URL Mapping in Discord.',
  ),
  field(
    'GAME_STATS_PROFILES_FILE',
    'game-stats',
    false,
    'Optional project-relative JSON with operator-verified Discord/game identity mappings and typed game-stat profiles; see docs/GAME_STATS_WIDGETS.md.',
  ),
  field(
    'PREMIUM_POLICY_FILE',
    'premium',
    false,
    'Optional project-relative JSON file mapping existing Discord SKUs to concrete action limits/features.',
  ),
  field(
    'REMOTE_AGENT_URL',
    'remote',
    false,
    'HTTPS origin of an authorized companion host agent; loopback HTTP is accepted for local tests.',
  ),
  field(
    'REMOTE_AGENT_KEY',
    'remote',
    true,
    'Shared host-agent authorization key, at least 32 characters; never supplied through Discord commands.',
  ),
  field(
    'HOST_AGENT_KEY',
    'host-agent',
    true,
    'Optional host-agent server key; blank generates data/host-agent.key locally.',
  ),
  field(
    'HOST_AGENT_MANIFEST',
    'host-agent',
    false,
    'Fixed local task manifest for the separate host-agent process; blank exposes authenticated status only.',
  ),
  field(
    'HOST_AGENT_BIND',
    'host-agent',
    false,
    'Optional agent bind address; default 127.0.0.1. Use an HTTPS reverse proxy for remote access.',
  ),
  field('HOST_AGENT_PORT', 'host-agent', false, 'Optional host-agent listener port; default 3010.'),
  field(
    'MONITOR_TARGET_URL',
    'monitor',
    false,
    'Exact readiness URL monitored by the separate monitor process; run it on another host to detect host downtime.',
  ),
  field(
    'MONITOR_DISCORD_WEBHOOK_URL',
    'monitor',
    true,
    'Discord webhook destination for downtime/recovery alerts.',
  ),
  field(
    'OUTBOUND_AUTOMATION_URL',
    'automation-outbound',
    true,
    'Fixed HTTPS webhook receiving explicitly configured Discord event notifications; a URL may contain a private receiver token.',
  ),
  field(
    'OUTBOUND_AUTOMATION_KEY',
    'automation-outbound',
    true,
    'HMAC secret for signed outbound automation events, at least 32 characters.',
  ),
  field(
    'DEPLOYMENT_WEBHOOK_SECRET',
    'deployment',
    true,
    'HMAC secret for the signed deployment-notification receiver.',
  ),
  field(
    'DEPLOYMENT_RELEASES_DIRECTORY',
    'deployment',
    false,
    'Directory containing locally reviewed built release folders with release.json manifests.',
  ),
  field(
    'DEPLOYMENT_ACTIVE_FILE',
    'deployment',
    false,
    'Supervisor release pointer file; blank disables managed releases.',
  ),
  field(
    'EXTERNAL_DATABASE_URL',
    'database',
    true,
    'Optional PostgreSQL connection string for approved read-only named queries.',
  ),
  field(
    'EXTERNAL_DATABASE_QUERIES_FILE',
    'database',
    false,
    'Local JSON allowlist of named read-only parameterized SQL queries.',
  ),
  field(
    'AI_MODEL_ROUTES_JSON',
    'ai',
    false,
    'Optional JSON mapping general/reasoning/code route names to permitted OpenAI models.',
  ),
  field(
    'AI_LOG_FILES_JSON',
    'ai',
    false,
    'Optional JSON mapping approved log IDs to fixed local text files; no caller-selected paths.',
  ),
  field(
    'VOICE_STREAM_SOURCES_JSON',
    'voice',
    false,
    'Optional JSON mapping approved source IDs to fixed public HTTPS audio streams. Empty disables remote stream sources.',
  ),
  field(
    'PLAUSIBLE_API_KEY',
    'plausible',
    true,
    'Plausible Stats API key authorized for the selected site; requires a plan with Stats API access.',
  ),
  field(
    'PLAUSIBLE_SITE_ID',
    'plausible',
    false,
    'Exact website domain as registered in the authorized Plausible team.',
  ),
];
export function optionalSecrets(env: NodeJS.ProcessEnv): string[] {
  return [...OPTIONAL_INTEGRATION_FIELDS, ...ADDITIONAL_SERVICE_FIELDS].flatMap((field) =>
    field.secret && env[field.name] ? [env[field.name]!] : [],
  );
}
