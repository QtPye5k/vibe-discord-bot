export interface IntegrationField {
  name: string;
  provider: string;
  secret: boolean;
  required?: boolean;
  default?: string;
  description: string;
}
const field = (
  name: string,
  provider: string,
  secret: boolean,
  description: string,
  required = false,
  fallback?: string,
): IntegrationField => ({
  name,
  provider,
  secret,
  description,
  required,
  ...(fallback ? { default: fallback } : {}),
});
/** Names only: runtime credentials remain in the operator environment, never in action inputs/catalog exports. */
export const OPTIONAL_INTEGRATION_FIELDS: readonly IntegrationField[] = Object.freeze([
  field(
    'GITHUB_TOKEN',
    'github',
    true,
    'GitHub fine-grained or installation token restricted to intended repositories and API permissions.',
    true,
  ),
  field(
    'GOOGLE_CLIENT_ID',
    'google',
    false,
    'OAuth client ID; with client secret and refresh token, enables renewable Google authorization.',
  ),
  field('GOOGLE_CLIENT_SECRET', 'google', true, 'Google OAuth confidential client secret.'),
  field(
    'GOOGLE_REFRESH_TOKEN',
    'google',
    true,
    'Authorized Google refresh token with Calendar, Sheets and/or Drive scopes.',
  ),
  field(
    'GOOGLE_ACCESS_TOKEN',
    'google',
    true,
    'Optional short-lived access token alternative; renewable OAuth configuration is preferred.',
  ),
  field('GOOGLE_CALENDAR_ID', 'google', false, 'Default authorized calendar ID.', false, 'primary'),
  field(
    'GITLAB_TOKEN',
    'gitlab',
    true,
    'GitLab personal/project access token with the needed API scope.',
    true,
  ),
  field(
    'GITLAB_BASE_URL',
    'gitlab',
    false,
    'Trusted public HTTPS GitLab origin; no path, credentials or custom port.',
    false,
    'https://gitlab.com',
  ),
  field('TRELLO_API_KEY', 'trello', true, 'Trello application API key.', true),
  field('TRELLO_TOKEN', 'trello', true, 'Trello authorized user token.', true),
  field(
    'NOTION_TOKEN',
    'notion',
    true,
    'Notion integration token; explicitly share desired pages/data sources with the integration.',
    true,
  ),
  field('YOUTUBE_API_KEY', 'youtube', true, 'YouTube Data API v3 key with the API enabled.', true),
  field('TWITCH_CLIENT_ID', 'twitch', false, 'Twitch application client ID.', true),
  field(
    'TWITCH_CLIENT_SECRET',
    'twitch',
    true,
    'Twitch application secret; creates an app access token when no access token is supplied.',
  ),
  field(
    'TWITCH_ACCESS_TOKEN',
    'twitch',
    true,
    'Optional Twitch access token alternative to client-credentials acquisition.',
  ),
  field('RESEND_API_KEY', 'email', true, 'Resend sending/receiving API key.', true),
  field('EMAIL_FROM', 'email', false, 'Verified Resend sender address.', true),
  field('TWILIO_ACCOUNT_SID', 'sms', false, 'Twilio account SID.', true),
  field('TWILIO_AUTH_TOKEN', 'sms', true, 'Twilio account authorization token.', true),
  field('TWILIO_FROM', 'sms', false, 'Approved Twilio sender in E.164 format.', true),
  field('VIRUSTOTAL_API_KEY', 'virustotal', true, 'VirusTotal API key; provider access/quotas apply.', true),
  field(
    'TURNSTILE_SITE_KEY',
    'captcha',
    false,
    'Public Cloudflare Turnstile site key for the companion verification page.',
  ),
  field('TURNSTILE_SECRET_KEY', 'captcha', true, 'Cloudflare Turnstile Siteverify secret.', true),
  field(
    'TURNSTILE_EXPECTED_HOSTNAME',
    'captcha',
    false,
    'Exact hostname expected in successful Turnstile verifications.',
    true,
  ),
  field('STEAM_API_KEY', 'steam', true, 'Steam Web API key for game/player statistics.', true),
  field('AFTERSHIP_API_KEY', 'parcels', true, 'AfterShip Tracking API key.', true),
  field(
    'SHOPIFY_SHOP',
    'commerce',
    false,
    'Authorized Shopify shop hostname, e.g. example.myshopify.com.',
    true,
  ),
  field(
    'SHOPIFY_ADMIN_TOKEN',
    'commerce',
    true,
    'Shopify Admin API token with read_products and read_inventory scopes.',
    true,
  ),
  field('SHOPIFY_API_VERSION', 'commerce', false, 'Pinned Shopify Admin API version.', false, '2026-10'),
  field('MASTODON_BASE_URL', 'social', false, 'Trusted public HTTPS Mastodon instance origin.', true),
  field('MASTODON_ACCESS_TOKEN', 'social', true, 'Mastodon user application token.', true),
  field('RUNWAY_API_KEY', 'video-generation', true, 'Runway API organization key.', true),
  field(
    'RUNWAY_VIDEO_MODEL',
    'video-generation',
    false,
    'Runway model used for text/image-to-video generation.',
    false,
    'gen4.5',
  ),
  field('SHOTSTACK_API_KEY', 'video-processing', true, 'Shotstack Edit API key.', true),
  field(
    'SHOTSTACK_ENVIRONMENT',
    'video-processing',
    false,
    'Shotstack render environment: stage or v1.',
    false,
    'stage',
  ),
  field(
    'CLOUDFLARE_API_TOKEN',
    'cloud',
    true,
    'Cloudflare API token restricted to the intended account/zone permissions.',
    true,
  ),
  field('CLOUDFLARE_ACCOUNT_ID', 'cloud', false, 'Cloudflare account ID.', true),
]);
export const OPTIONAL_PROVIDER_IDS = Object.freeze([
  ...new Set(OPTIONAL_INTEGRATION_FIELDS.map((field) => field.provider)),
]);
export type IntegrationEnvironment = NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
export const integrationEnvironment = (env: IntegrationEnvironment) =>
  typeof env === 'function' ? env() : env;
export function configuredValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() || OPTIONAL_INTEGRATION_FIELDS.find((field) => field.name === name)?.default || '';
}
export function integrationStatus(
  env: NodeJS.ProcessEnv,
): { id: string; enabled: boolean; missing: string[] }[] {
  return OPTIONAL_PROVIDER_IDS.map((id) => {
    let missing = OPTIONAL_INTEGRATION_FIELDS.filter(
      (field) => field.provider === id && field.required && !configuredValue(env, field.name),
    ).map((field) => field.name);
    if (id === 'google' && !env.GOOGLE_ACCESS_TOKEN?.trim())
      missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter(
        (name) => !env[name]?.trim(),
      );
    if (id === 'twitch' && !env.TWITCH_ACCESS_TOKEN?.trim() && !env.TWITCH_CLIENT_SECRET?.trim())
      missing.push('TWITCH_CLIENT_SECRET or TWITCH_ACCESS_TOKEN');
    return { id, enabled: !missing.length, missing };
  });
}
