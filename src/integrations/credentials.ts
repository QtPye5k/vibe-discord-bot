import { createHash } from 'node:crypto';
import type { ActionContext } from '../core/types.js';
import { UserError } from '../core/errors.js';
import { providerHttp, providerJson, type ProviderTransport } from './http.js';
import {
  configuredValue,
  integrationEnvironment,
  integrationStatus,
  type IntegrationEnvironment,
} from './provider-catalog.js';
export interface OwnedCredential {
  token: string;
  subjectUserId: string;
  subjectGuildId: string;
  providerAccountId: string;
  scopes: string[];
  authorizationId?: string;
  current?: () => boolean;
}
export type ResolvedCredential = { token: string; kind: 'shared' } | (OwnedCredential & { kind: 'owned' });
export interface CredentialOptions {
  env: IntegrationEnvironment;
  transport?: ProviderTransport;
  now?: () => number;
  token?: (
    provider: 'google' | 'twitch',
    ctx: ActionContext,
  ) => Promise<string | OwnedCredential | undefined>;
}
export function createCredentials(options: CredentialOptions) {
  const now = options.now ?? Date.now,
    cache = new Map<string, { value: string; expiresAt: number }>(),
    pending = new Map<string, Promise<string>>();
  const issued = new Set<string>();
  let closed = false;
  const remember = (token: string) => {
    if (issued.size >= 100) issued.delete(issued.values().next().value!);
    issued.add(token);
    return token;
  };
  const env = () => integrationEnvironment(options.env);
  const value = (name: string) => configuredValue(env(), name);
  const available = (provider: string) =>
    integrationStatus(env()).some((row) => row.id === provider && row.enabled) ||
    (provider === 'google' &&
      !!options.token &&
      !!value('GOOGLE_CLIENT_ID') &&
      !!value('GOOGLE_CLIENT_SECRET'));
  const requireProvider = (provider: string) => {
    if (closed) throw new UserError('External credentials are closed.');
    const status = integrationStatus(env()).find((row) => row.id === provider);
    if (!available(provider))
      throw new UserError(
        `${provider} is unavailable. Configure ${status?.missing.join(', ') || 'the service'} locally and restart.`,
      );
  };
  const secrets = () => [
    ...issued,
    ...Object.entries(env())
      .filter(([name, value]) => /(?:TOKEN|SECRET|API_KEY|PASSWORD)/i.test(name) && !!value)
      .map(([, value]) => value!),
  ];
  async function linked(
    provider: 'google' | 'twitch',
    ctx: ActionContext,
  ): Promise<ResolvedCredential | undefined> {
    if (closed) throw new UserError('External credentials are closed.');
    const raw = await options.token?.(provider, ctx);
    if (closed) throw new UserError('External credentials are closed.');
    if (raw === undefined) return undefined;
    const token = typeof raw === 'string' ? raw : raw.token;
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token))
      throw new UserError('Invalid linked service credential.');
    remember(token);
    if (typeof raw === 'string') return { kind: 'shared', token };
    if (
      raw.subjectUserId !== ctx.member.id ||
      raw.subjectGuildId !== ctx.guild.id ||
      typeof raw.providerAccountId !== 'string' ||
      !raw.providerAccountId ||
      raw.providerAccountId.length > 256 ||
      !Array.isArray(raw.scopes) ||
      raw.scopes.length > 50 ||
      raw.scopes.some((scope) => typeof scope !== 'string' || scope.length > 256) ||
      (raw.authorizationId !== undefined &&
        (typeof raw.authorizationId !== 'string' || !raw.authorizationId || raw.authorizationId.length > 128))
    )
      throw new UserError('Linked credentials do not belong to this member/server.');
    if (raw.current && !raw.current()) throw new UserError('Your linked service authorization was revoked.');
    return { ...raw, kind: 'owned' };
  }
  async function token(
    provider: 'google' | 'twitch',
    ctx: ActionContext,
    beforeSend?: () => Promise<void>,
  ): Promise<string> {
    if (closed) throw new UserError('External credentials are closed.');
    const delegated = await linked(provider, ctx);
    if (closed) throw new UserError('External credentials are closed.');
    if (delegated) return delegated.token;
    requireProvider(provider);
    const direct = value(provider === 'google' ? 'GOOGLE_ACCESS_TOKEN' : 'TWITCH_ACCESS_TOKEN');
    if (direct) return remember(direct);
    if (provider === 'google' && !value('GOOGLE_REFRESH_TOKEN'))
      throw new UserError(
        'Link your Google account with oauth.start, or configure a shared GOOGLE_REFRESH_TOKEN locally.',
      );
    const fields =
      provider === 'google'
        ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']
        : ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'];
    const key =
      provider +
      ':' +
      createHash('sha256')
        .update(JSON.stringify(fields.map(value)))
        .digest('hex');
    const saved = cache.get(key);
    if (saved && saved.expiresAt > now() + 60000) return saved.value;
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      const request = providerHttp(
        provider,
        provider === 'google' ? 'https://oauth2.googleapis.com' : 'https://id.twitch.tv',
        options.transport,
      );
      const result = providerJson(
        await request(
          provider === 'google' ? '/token' : '/oauth2/token',
          {
            method: 'POST',
            form:
              provider === 'google'
                ? {
                    client_id: value('GOOGLE_CLIENT_ID'),
                    client_secret: value('GOOGLE_CLIENT_SECRET'),
                    refresh_token: value('GOOGLE_REFRESH_TOKEN'),
                    grant_type: 'refresh_token',
                  }
                : {
                    client_id: value('TWITCH_CLIENT_ID'),
                    client_secret: value('TWITCH_CLIENT_SECRET'),
                    grant_type: 'client_credentials',
                  },
          },
          beforeSend,
        ),
        provider,
      ) as { access_token?: unknown; expires_in?: unknown };
      if (
        typeof result.access_token !== 'string' ||
        !result.access_token ||
        result.access_token.length > 16384 ||
        /[\r\n]/.test(result.access_token)
      )
        throw new UserError(`${provider} returned no usable access token.`);
      const seconds =
        typeof result.expires_in === 'number' && Number.isFinite(result.expires_in)
          ? Math.max(60, Math.min(86400, result.expires_in))
          : 300;
      if (closed) throw new UserError('External credentials are closed.');
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(key, { value: result.access_token, expiresAt: now() + seconds * 1000 });
      return remember(result.access_token);
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }
  return {
    env,
    value,
    available,
    requireProvider,
    secrets,
    token,
    linked,
    clear() {
      closed = true;
      issued.clear();
      cache.clear();
      pending.clear();
    },
  };
}
