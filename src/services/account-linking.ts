import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { publicOrigin, HttpError, jsonResponse } from '../core/http.js';
import { projectPath } from '../core/paths.js';
import { providerHttp, providerJson, type ProviderTransport } from '../integrations/http.js';

type Provider = 'discord' | 'google' | 'github';
interface Tokens {
  access: string;
  refresh?: string;
  expiresAt: number;
  scopes: string[];
}
interface Identity {
  id: string;
  name: string;
  email?: string;
  verified?: boolean;
}
interface Flow {
  id: string;
  provider: Provider;
  guildId: string;
  userId: string;
  channelId: string;
  purpose: string;
  verifier: string;
  expiresAt: number;
  epoch: number;
  cookieHash?: string;
  status: 'created' | 'started' | 'processing' | 'pending' | 'failed';
  identity?: Identity;
  encrypted?: string;
  joinGuildId?: string;
}
interface Account {
  provider: Provider;
  guildId: string;
  userId: string;
  identity: Identity;
  encrypted: string;
  version: string;
  createdAt: number;
  joinGuildId?: string;
}
interface AccountSession {
  guildId: string;
  userId: string;
  channelId: string;
  expiresAt: number;
}
const providerSchema = z.enum(['discord', 'google', 'github']),
  empty = z.strictObject({}),
  tokenId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (value: string) => createHash('sha256').update(value).digest('hex'),
  secret = () => randomBytes(32).toString('base64url');
const html = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const constantEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const googleScopes: Record<string, string[]> = {
  identity: [],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  all: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
};
export interface LinkedCredential {
  token: string;
  subjectUserId: string;
  subjectGuildId: string;
  providerAccountId: string;
  authorizationId: string;
  scopes: string[];
  current: () => boolean;
}
export function createAccountLinking(options: {
  env: NodeJS.ProcessEnv;
  store: Store;
  client: Client;
  registry: ActionRegistry;
  allowedGuildIds: readonly string[];
  transport?: ProviderTransport;
  now?: () => number;
  encryptionKey?: Buffer;
}) {
  const { store, client, registry, env } = options,
    now = options.now ?? Date.now;
  let base: URL | undefined;
  try {
    if (env.APP_PUBLIC_URL) base = publicOrigin(env.APP_PUBLIC_URL);
  } catch {
    /* Malformed optional origins disable account linking only. */
  }
  let closed = false,
    active = 0,
    keyPromise: Promise<Buffer> | undefined;
  const sessions = new Map<string, AccountSession>(),
    refreshing = new Map<string, Promise<LinkedCredential | undefined>>();
  const requestedJoinGuilds = (env.OAUTH_JOIN_GUILD_IDS ?? '').split(/[\s,]+/).filter(Boolean);
  const joinGuildIds =
    requestedJoinGuilds.length <= 20 && requestedJoinGuilds.every((value) => /^\d{17,20}$/.test(value))
      ? new Set(requestedJoinGuilds)
      : new Set<string>();
  const inFlightJoins = new Set<string>();
  const clientId = (provider: Provider) =>
    provider === 'discord'
      ? env.DISCORD_CLIENT_ID || client.application?.id || client.user?.id || ''
      : env[provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'GITHUB_OAUTH_CLIENT_ID'] || '';
  const clientSecret = (provider: Provider) =>
    env[
      provider === 'discord'
        ? 'DISCORD_CLIENT_SECRET'
        : provider === 'google'
          ? 'GOOGLE_CLIENT_SECRET'
          : 'GITHUB_OAUTH_CLIENT_SECRET'
    ] || '';
  const enabled = (provider: Provider) =>
    !closed && !!base && !!clientId(provider) && !!clientSecret(provider);
  const recordKey = (guild: string, user: string, provider: Provider) => `${guild}:${user}:${provider}`;
  const cookie = (name: string, value: string, age: number, path = '/oauth') =>
    `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${base?.protocol === 'https:' ? '; Secure' : ''}`;
  const readCookie = (request: IncomingMessage, name: string) => {
    const parts = (request.headers.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${name}=`));
    return parts.length === 1 ? parts[0]!.slice(name.length + 1) : '';
  };
  async function key(): Promise<Buffer> {
    if (options.encryptionKey) {
      if (options.encryptionKey.length !== 32) throw new Error('Invalid OAuth encryption key.');
      return options.encryptionKey;
    }
    return (keyPromise ??= (async () => {
      if (env.OAUTH_ENCRYPTION_KEY) {
        const data = Buffer.from(env.OAUTH_ENCRYPTION_KEY, 'base64');
        if (data.length !== 32) throw new UserError('OAUTH_ENCRYPTION_KEY must be32bytes in base64.');
        return data;
      }
      await mkdir(projectPath('data'), { recursive: true });
      const path = projectPath('data/oauth.key');
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile())
          throw new UserError('OAuth encryption key must be a private ordinary local file.');
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        try {
          await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
        } catch (failure) {
          if (!(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'EEXIST'))
            throw failure;
        }
      }
      const data = await readFile(path);
      if (data.length !== 32) throw new UserError('Invalid saved OAuth encryption key.');
      return data;
    })());
  }
  async function encrypt(tokens: Tokens, owner: string): Promise<string> {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', await key(), iv);
    cipher.setAAD(Buffer.from(owner));
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  async function decrypt(value: string, owner: string): Promise<Tokens> {
    try {
      const data = Buffer.from(value, 'base64'),
        cipher = createDecipheriv('aes-256-gcm', await key(), data.subarray(0, 12));
      cipher.setAAD(Buffer.from(owner));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
      ) as Tokens;
    } catch {
      throw new UserError(
        'Saved authorization cannot be decrypted. Restore its matching local key or link the account again.',
      );
    }
  }
  function scopes(provider: Provider, purpose: string): string[] {
    return provider === 'google'
      ? ['openid', 'profile', 'email', ...(googleScopes[purpose] || [])]
      : provider === 'github'
        ? ['read:user', 'user:email', 'offline_access']
        : [
            'identify',
            ...(purpose === 'linked-role'
              ? ['role_connections.write']
              : purpose === 'join'
                ? ['guilds.join']
                : purpose === 'game-stats'
                  ? ['application_identities.write']
                  : []),
          ];
  }
  function providerEndpoints(provider: Provider) {
    return provider === 'google'
      ? {
          authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenOrigin: 'https://oauth2.googleapis.com',
          tokenPath: '/token',
          identityOrigin: 'https://openidconnect.googleapis.com',
          identityPath: '/v1/userinfo',
        }
      : provider === 'github'
        ? {
            authorize: 'https://github.com/login/oauth/authorize',
            tokenOrigin: 'https://github.com',
            tokenPath: '/login/oauth/access_token',
            identityOrigin: 'https://api.github.com',
            identityPath: '/user',
          }
        : {
            authorize: 'https://discord.com/oauth2/authorize',
            tokenOrigin: 'https://discord.com',
            tokenPath: '/api/v10/oauth2/token',
            identityOrigin: 'https://discord.com',
            identityPath: '/api/v10/users/@me',
          };
  }
  async function exchange(
    provider: Provider,
    input: Record<string, string>,
    requested: string[],
  ): Promise<Tokens> {
    const endpoint = providerEndpoints(provider),
      raw = providerJson(
        await providerHttp(
          `oauth-${provider}`,
          endpoint.tokenOrigin,
          options.transport,
        )(endpoint.tokenPath, {
          method: 'POST',
          form: { client_id: clientId(provider), client_secret: clientSecret(provider), ...input },
        }),
        provider,
      ) as Record<string, unknown>;
    if (
      typeof raw.access_token !== 'string' ||
      raw.access_token.length < 8 ||
      raw.access_token.length > 16384
    )
      throw new UserError('Authorization provider returned no usable token.');
    return {
      access: raw.access_token,
      ...(typeof raw.refresh_token === 'string' ? { refresh: raw.refresh_token } : {}),
      expiresAt:
        typeof raw.expires_in === 'number'
          ? now() + Math.max(1, Math.min(31536000, raw.expires_in)) * 1000
          : 0,
      scopes:
        typeof raw.scope === 'string'
          ? raw.scope.split(/[ ,]+/).filter((scope) => requested.includes(scope))
          : requested,
    };
  }
  async function identity(provider: Provider, access: string): Promise<Identity> {
    const endpoint = providerEndpoints(provider),
      raw = providerJson(
        await providerHttp(
          `oauth-${provider}`,
          endpoint.identityOrigin,
          options.transport,
        )(endpoint.identityPath, {
          headers: {
            Authorization: `Bearer ${access}`,
            ...(provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
          },
        }),
        provider,
      ) as Record<string, unknown>;
    const id = String(provider === 'google' ? raw.sub : raw.id);
    if (!id || id === 'undefined' || id.length > 128)
      throw new UserError('Authorization provider returned no verified account identity.');
    return {
      id,
      name: String(raw.name || raw.global_name || raw.login || raw.username || id).slice(0, 200),
      ...(typeof raw.email === 'string' ? { email: raw.email.slice(0, 254) } : {}),
      ...(typeof raw.email_verified === 'boolean' ? { verified: raw.email_verified } : {}),
    };
  }
  async function context(guildId: string, userId: string, channelId: string): Promise<ActionContext> {
    if (closed || (options.allowedGuildIds.length && !options.allowedGuildIds.includes(guildId)))
      throw new UserError('This account-linking context is unavailable.');
    const guild = await client.guilds.fetch(guildId),
      member = await guild.members.fetch({ user: userId, force: true }),
      ctx = await freshContext({ client, store, guild, member, channelId });
    await resolveChannel(ctx, channelId);
    return ctx;
  }
  function prune() {
    for (const row of store.list<Flow>('oauth.flows'))
      if (row.value.expiresAt <= now()) store.delete('oauth.flows', row.key);
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }
  const flowCurrent = (flow: Flow, status: Flow['status']) =>
    !closed &&
    flow.expiresAt > now() &&
    store.get<Flow>('oauth.flows', flow.id)?.status === status &&
    (store.get<number>('core.featureEpochs', `${flow.guildId}:identity`) ?? 0) === flow.epoch &&
    !(store.get<string[]>('core.disabled', flow.guildId) ?? []).includes('identity');
  function status() {
    return (['discord', 'google', 'github'] as const).map((provider) => ({
      id: provider,
      enabled: enabled(provider),
      missing: [
        ...(!base ? ['APP_PUBLIC_URL'] : []),
        ...(!clientId(provider)
          ? [
              provider === 'discord'
                ? 'DISCORD_CLIENT_ID'
                : provider === 'google'
                  ? 'GOOGLE_CLIENT_ID'
                  : 'GITHUB_OAUTH_CLIENT_ID',
            ]
          : []),
        ...(!clientSecret(provider)
          ? [
              provider === 'discord'
                ? 'DISCORD_CLIENT_SECRET'
                : provider === 'google'
                  ? 'GOOGLE_CLIENT_SECRET'
                  : 'GITHUB_OAUTH_CLIENT_SECRET',
            ]
          : []),
      ],
    }));
  }
  function registerActions() {
    const common = { category: 'identity', userPermissions: [], botPermissions: [] };
    registry.register({
      ...common,
      id: 'oauth.start',
      risk: 'write',
      available: () => status().some((row) => row.enabled),
      description:
        'Create a private single-use account authorization link. Choose identity or explicit Google data permissions; verify the returned account in Discord before saving.',
      schema: z
        .strictObject({
          provider: providerSchema,
          purpose: z
            .enum(['identity', 'linked-role', 'calendar', 'drive', 'sheets', 'all', 'join', 'game-stats'])
            .default('identity'),
          joinGuildId: z
            .string()
            .regex(/^\d{17,20}$/)
            .optional(),
        })
        .refine(
          (input) =>
            input.purpose === 'join'
              ? input.provider === 'discord' && !!input.joinGuildId
              : input.joinGuildId === undefined,
          'Join consent requires one exact Discord target; other purposes cannot supply a target.',
        ),
      execute: async (ctx, input) => {
        if (!enabled(input.provider))
          throw new UserError('Configure this provider and its public OAuth callback origin on the host.');
        if (
          (input.provider === 'discord' &&
            !['identity', 'linked-role', 'join', 'game-stats'].includes(input.purpose)) ||
          (input.provider === 'github' && input.purpose !== 'identity') ||
          (input.provider === 'google' && ['linked-role', 'join', 'game-stats'].includes(input.purpose))
        )
          throw new UserError('Unsupported authorization purpose for this provider.');
        const expectedEpoch = store.get<number>('core.featureEpochs', `${ctx.guild.id}:identity`) ?? 0;
        const fresh = await context(ctx.guild.id, ctx.member.id, ctx.channelId);
        registry.assertPolicy(fresh, 'oauth.start');
        if ((store.get<number>('core.featureEpochs', `${ctx.guild.id}:identity`) ?? 0) !== expectedEpoch)
          throw new UserError('Account-linking settings changed. Request a new link.');
        if (input.purpose === 'join' && !joinGuildIds.has(input.joinGuildId!))
          throw new UserError('That server is not an operator-approved OAUTH_JOIN_GUILD_IDS target.');
        prune();
        const rows = store.list<Flow>('oauth.flows');
        if (
          rows.length >= 1000 ||
          rows.filter((row) => row.value.guildId === ctx.guild.id && row.value.userId === ctx.member.id)
            .length >= 5
        )
          throw new UserError('Complete or wait for earlier account links to expire.');
        const id = secret(),
          flow: Flow = {
            id: hash(id),
            provider: input.provider,
            guildId: ctx.guild.id,
            userId: ctx.member.id,
            channelId: ctx.channelId,
            purpose: input.purpose,
            verifier: secret(),
            expiresAt: now() + 600000,
            epoch: store.get<number>('core.featureEpochs', `${ctx.guild.id}:identity`) ?? 0,
            status: 'created',
            ...(input.joinGuildId ? { joinGuildId: input.joinGuildId } : {}),
          };
        store.set('oauth.flows', flow.id, flow);
        return {
          url: new URL(`/oauth/start/${id}`, base).href,
          expiresAt: flow.expiresAt,
          scopes: scopes(input.provider, input.purpose),
          ...(flow.joinGuildId ? { joinGuildId: flow.joinGuildId } : {}),
          notice:
            'Private authorization link. Complete provider consent, then confirm the exact returned account ID in Discord.',
        };
      },
    });
    registry.register({
      ...common,
      id: 'oauth.link.confirm',
      risk: 'write',
      description:
        'Save an exact provider-verified account authorization belonging to your private linking flow; another Discord account cannot approve it.',
      schema: z.strictObject({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        provider: providerSchema,
        accountId: z.string().min(1).max(128),
      }),
      execute: async (ctx, input) => {
        const flow = store.get<Flow>('oauth.flows', input.id);
        if (
          !flow ||
          !flowCurrent(flow, 'pending') ||
          flow.provider !== input.provider ||
          flow.identity?.id !== input.accountId ||
          flow.guildId !== ctx.guild.id ||
          flow.userId !== ctx.member.id ||
          flow.channelId !== ctx.channelId ||
          !flow.encrypted
        )
          throw new UserError(
            'This account authorization expired or does not belong to your exact context/account.',
          );
        const fresh = await context(flow.guildId, flow.userId, flow.channelId);
        registry.assertPolicy(fresh, 'oauth.link.confirm');
        const current = store.get<Flow>('oauth.flows', flow.id);
        if (!flowCurrent(flow, 'pending') || current?.encrypted !== flow.encrypted)
          throw new UserError('Account authorization changed. Start again.');
        const key = recordKey(flow.guildId, flow.userId, flow.provider),
          account: Account = {
            provider: flow.provider,
            guildId: flow.guildId,
            userId: flow.userId,
            identity: flow.identity,
            encrypted: flow.encrypted,
            version: secret(),
            createdAt: now(),
            ...(flow.joinGuildId ? { joinGuildId: flow.joinGuildId } : {}),
          };
        store.transaction(() => {
          store.set('oauth.accounts', key, account);
          store.delete('oauth.flows', flow.id);
        });
        return { linked: true, provider: flow.provider, identity: flow.identity };
      },
    });
    registry.register({
      ...common,
      id: 'oauth.accounts',
      risk: 'read',
      description:
        'List only your own linked account identities and granted scopes; no access or refresh tokens are returned.',
      schema: empty,
      execute: async (ctx) => {
        const accounts = store.list<Account>('oauth.accounts', `${ctx.guild.id}:${ctx.member.id}:`);
        return Promise.all(
          accounts.map(async (row) => {
            const tokens = await decrypt(row.value.encrypted, row.key);
            if (store.get<Account>('oauth.accounts', row.key)?.version !== row.value.version)
              throw new UserError('Account links changed during this request.');
            return {
              provider: row.value.provider,
              identity: row.value.identity,
              createdAt: row.value.createdAt,
              scopes: tokens.scopes,
            };
          }),
        );
      },
    });
    registry.register({
      ...common,
      id: 'oauth.identity',
      risk: 'read',
      description:
        'Retrieve your own authorized external account identity through its live provider, without disclosing saved tokens.',
      schema: z.strictObject({ provider: providerSchema }),
      execute: async (ctx, input) => {
        const auth = await credential(input.provider, ctx);
        if (!auth) throw new UserError('Link this account first with oauth.start.');
        const result = await identity(input.provider, auth.token);
        if (!auth.current()) throw new UserError('Account link was revoked during the request.');
        return result;
      },
    });
    registry.register({
      ...common,
      id: 'oauth.guild.join',
      risk: 'write',
      available: () => enabled('discord') && joinGuildIds.size > 0,
      unavailableReason: 'Configure Discord OAuth and an operator-reviewed OAUTH_JOIN_GUILD_IDS target list.',
      description:
        'Join your own verified Discord account to the exact operator-approved server selected in your explicit guilds.join OAuth consent; no roles, nickname or screening bypass are supplied.',
      schema: z.strictObject({
        guildId: z.string().regex(/^\d{17,20}$/),
        remoteStateReviewed: z.boolean().default(false),
      }),
      execute: async (ctx, input) => {
        if (!joinGuildIds.has(input.guildId))
          throw new UserError('That server is not an approved OAuth join target.');
        const owner = recordKey(ctx.guild.id, ctx.member.id, 'discord'),
          account = store.get<Account>('oauth.accounts', owner),
          expectedEpoch = store.get<number>('core.featureEpochs', `${ctx.guild.id}:identity`) ?? 0;
        if (!account || account.identity.id !== ctx.member.id || account.joinGuildId !== input.guildId)
          throw new UserError(
            'Authorize Discord with oauth.start purpose join and this exact joinGuildId, then confirm your own account first.',
          );
        const auth = await credential('discord', ctx);
        if (!auth || auth.providerAccountId !== ctx.member.id || !auth.scopes.includes('guilds.join'))
          throw new UserError('Your own Discord account must explicitly grant guilds.join for this target.');
        const current = () => {
          if (
            !auth.current() ||
            closed ||
            !joinGuildIds.has(input.guildId) ||
            (store.get<number>('core.featureEpochs', `${ctx.guild.id}:identity`) ?? 0) !== expectedEpoch
          )
            throw new UserError(
              'The account authorization changed. A dispatched join may have completed; inspect the target before retrying.',
            );
        };
        const source = async () => {
          const fresh = await context(ctx.guild.id, ctx.member.id, ctx.channelId);
          registry.assertPolicy(fresh, 'oauth.guild.join');
          current();
          return fresh;
        };
        await source();
        const target = await client.guilds.fetch(input.guildId),
          bot = await target.members.fetchMe({ force: true });
        if (
          target.id !== input.guildId ||
          !bot.permissions.has(P.CreateInstantInvite) ||
          clientId('discord') !== client.application?.id
        )
          throw new UserError(
            'The same application bot must belong to that exact target with Create Instant Invite permission.',
          );
        await source();
        const attemptKey = `${ctx.guild.id}:${ctx.member.id}:${input.guildId}`,
          prior = store.get<{ state: string }>('oauth.joins', attemptKey);
        if (inFlightJoins.has(attemptKey))
          throw new UserError('Your join request to this server is still running.');
        if (prior && ['dispatching', 'unknown'].includes(prior.state) && !input.remoteStateReviewed)
          throw new UserError(
            'A previous join outcome is uncertain. Inspect your target-server membership, then explicitly confirm remoteStateReviewed:true before retrying.',
          );
        if (
          !prior &&
          Number(
            store.db.prepare("SELECT count(*) AS n FROM kv WHERE namespace='oauth.joins'").get()?.n ?? 0,
          ) >= 20000
        )
          throw new UserError('OAuth join outcome retention is full. Ask the host operator to review it.');
        const attempt = {
          id: secret(),
          userId: ctx.member.id,
          sourceGuildId: ctx.guild.id,
          targetGuildId: input.guildId,
          authorizationId: auth.authorizationId,
          consentedAt: account.createdAt,
          dispatchedAt: now(),
          state: 'dispatching',
          reviewedPreviousOutcome: input.remoteStateReviewed,
        };
        store.set('oauth.joins', attemptKey, attempt);
        inFlightJoins.add(attemptKey);
        try {
          current();
          const joined = await target.members.add(ctx.member.id, {
            accessToken: auth.token,
            force: true,
            fetchWhenExisting: false,
          });
          await source();
          current();
          const state = joined ? 'joined' : 'already-member';
          store.set('oauth.joins', attemptKey, { ...attempt, state, completedAt: now() });
          return {
            userId: ctx.member.id,
            guildId: input.guildId,
            state,
            pendingScreening: joined?.pending ?? null,
            notice:
              'Complete any target server membership screening in Discord. No role or screening bypass was requested.',
          };
        } catch {
          store.set('oauth.joins', attemptKey, { ...attempt, state: 'unknown', completedAt: now() });
          throw new UserError(
            'The join outcome requires review. No automatic retry was made; inspect your target-server membership before an explicitly reviewed retry.',
          );
        } finally {
          inFlightJoins.delete(attemptKey);
        }
      },
    });
    registry.register({
      ...common,
      id: 'oauth.unlink',
      risk: 'destructive',
      description:
        'Erase your local authorization, pending links and account sessions for one provider. Revoke any remaining provider-side grant in that provider’s account settings.',
      schema: z.strictObject({ provider: providerSchema }),
      execute: (ctx, input) => {
        const key = recordKey(ctx.guild.id, ctx.member.id, input.provider);
        store.delete('oauth.accounts', key);
        for (const row of store.list<Flow>('oauth.flows'))
          if (
            row.value.guildId === ctx.guild.id &&
            row.value.userId === ctx.member.id &&
            row.value.provider === input.provider
          )
            store.delete('oauth.flows', row.key);
        for (const [id, session] of sessions)
          if (session.guildId === ctx.guild.id && session.userId === ctx.member.id) sessions.delete(id);
        return {
          erased: true,
          provider: input.provider,
          notice:
            'Local tokens were erased. Use the provider’s connected-app settings to revoke any authorization retained by that provider.',
        };
      },
    });
    registry.register({
      ...common,
      id: 'oauth.linked-role.update',
      risk: 'write',
      description:
        'Update your own Discord Linked Role connection using your explicit role_connections.write authorization and registered metadata fields.',
      schema: z.strictObject({
        platformName: z.string().min(1).max(50),
        platformUsername: z.string().min(1).max(100),
        metadata: z
          .record(z.string().regex(/^[a-z0-9_]{1,50}$/), z.string().max(100))
          .refine((value) => Object.keys(value).length <= 10),
      }),
      execute: async (ctx, input) => {
        const auth = await credential('discord', ctx);
        if (!auth || !auth.scopes.includes('role_connections.write'))
          throw new UserError('Authorize Discord Linked Roles first.');
        return providerJson(
          await providerHttp('discord-linked-roles', 'https://discord.com', options.transport)(
            `/api/v10/users/@me/applications/${encodeURIComponent(clientId('discord'))}/role-connection`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${auth.token}` },
              json: {
                platform_name: input.platformName,
                platform_username: input.platformUsername,
                metadata: input.metadata,
              },
            },
            async () => {
              if (!auth.current()) throw new UserError('Account link was revoked.');
            },
          ),
          'discord',
        );
      },
    });
  }
  async function credential(provider: Provider, ctx: ActionContext): Promise<LinkedCredential | undefined> {
    const id = recordKey(ctx.guild.id, ctx.member.id, provider),
      account = store.get<Account>('oauth.accounts', id);
    if (!account) return undefined;
    const current = () => !closed && store.get<Account>('oauth.accounts', id)?.version === account.version;
    const tokens = await decrypt(account.encrypted, id);
    if (!current()) throw new UserError('Account authorization was revoked.');
    const result = (access: string): LinkedCredential => ({
      token: access,
      subjectUserId: account.userId,
      subjectGuildId: account.guildId,
      providerAccountId: account.identity.id,
      authorizationId: account.version,
      scopes: tokens.scopes,
      current,
    });
    if (!tokens.expiresAt || tokens.expiresAt > now() + 60000) return result(tokens.access);
    if (!tokens.refresh || !enabled(provider))
      throw new UserError('External authorization expired. Link the account again.');
    const existing = refreshing.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const fresh = await exchange(
        provider,
        { grant_type: 'refresh_token', refresh_token: tokens.refresh! },
        tokens.scopes,
      );
      if (!current()) throw new UserError('Account authorization was revoked during refresh.');
      fresh.refresh ??= tokens.refresh;
      account.encrypted = await encrypt(fresh, id);
      if (!current()) throw new UserError('Account authorization was revoked during refresh.');
      store.set('oauth.accounts', id, account);
      return { ...result(fresh.access), scopes: fresh.scopes };
    })();
    refreshing.set(id, pending);
    try {
      return await pending;
    } finally {
      refreshing.delete(id);
    }
  }
  function page(response: ServerResponse, title: string, content: string, statusCode = 200) {
    response.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(title)}</title><main><h1>${html(title)}</h1>${content}</main></html>`,
    );
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url || '/', base?.origin || 'http://127.0.0.1');
    if (!url.pathname.startsWith('/oauth/') && url.pathname !== '/account') return false;
    if (!base || closed) {
      jsonResponse(response, 503, { error: 'Account linking is not configured.' });
      return true;
    }
    if (request.headers.host !== base.host) {
      jsonResponse(response, 403, { error: 'Unexpected account-linking host.' });
      return true;
    }
    if (active >= 16) {
      jsonResponse(response, 429, { error: 'Account linking is busy.' });
      return true;
    }
    active++;
    try {
      if (request.method !== 'GET')
        throw new HttpError(405, 'Use the authorization link returned in Discord.');
      prune();
      if (url.pathname === '/account') {
        const token = readCookie(request, 'account_session'),
          session = sessions.get(hash(token));
        if (!session || session.expiresAt <= now())
          throw new HttpError(401, 'Sign in to Discord through oauth.start first.');
        await context(session.guildId, session.userId, session.channelId);
        if (sessions.get(hash(token)) !== session || session.expiresAt <= now())
          throw new HttpError(401, 'Account session was withdrawn. Sign in again.');
        const accounts = store
          .list<Account>('oauth.accounts', `${session.guildId}:${session.userId}:`)
          .map((row) => ({ provider: row.value.provider, identity: row.value.identity }));
        page(
          response,
          'Your linked accounts',
          `<p>Authenticated Discord account: ${html(session.userId)}.</p><pre>${html(JSON.stringify(accounts, null, 2))}</pre><p>Manage and remove links using private Discord commands.</p>`,
        );
        return true;
      }
      if (url.pathname.startsWith('/oauth/start/')) {
        const token = tokenId.parse(url.pathname.slice('/oauth/start/'.length)),
          flow = store.get<Flow>('oauth.flows', hash(token));
        if (!flow || flow.status !== 'created' || flow.expiresAt <= now() || !enabled(flow.provider))
          throw new HttpError(410, 'Authorization link expired or was already opened.');
        const authorized = await context(flow.guildId, flow.userId, flow.channelId);
        registry.assertPolicy(authorized, 'oauth.start');
        if (!flowCurrent(flow, 'created'))
          throw new HttpError(409, 'Authorization link was already opened or withdrawn.');
        const nonce = secret();
        flow.cookieHash = hash(nonce);
        flow.status = 'started';
        store.set('oauth.flows', flow.id, flow);
        const destination = new URL(providerEndpoints(flow.provider).authorize);
        for (const [name, value] of Object.entries({
          client_id: clientId(flow.provider),
          redirect_uri: new URL(`/oauth/callback/${flow.provider}`, base).href,
          response_type: 'code',
          scope: scopes(flow.provider, flow.purpose).join(' '),
          state: token,
          code_challenge: Buffer.from(hash(flow.verifier), 'hex').toString('base64url'),
          code_challenge_method: 'S256',
          ...(flow.provider === 'google'
            ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
            : {}),
        }))
          destination.searchParams.set(name, value);
        response.writeHead(302, {
          Location: destination.href,
          'Set-Cookie': cookie('oauth_state', nonce, 600),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end();
        return true;
      }
      if (url.pathname.startsWith('/oauth/callback/')) {
        const provider = providerSchema.parse(url.pathname.slice('/oauth/callback/'.length)),
          state = tokenId.parse(url.searchParams.get('state')),
          flow = store.get<Flow>('oauth.flows', hash(state)),
          browser = readCookie(request, 'oauth_state');
        if (
          !flow ||
          flow.provider !== provider ||
          flow.status !== 'started' ||
          flow.expiresAt <= now() ||
          !flow.cookieHash ||
          !constantEqual(flow.cookieHash, hash(browser))
        )
          throw new HttpError(401, 'Authorization state or browser binding is invalid.');
        if (url.searchParams.has('error')) {
          flow.status = 'failed';
          store.set('oauth.flows', flow.id, flow);
          throw new HttpError(400, 'Authorization was declined. No account was linked.');
        }
        const code = z.string().min(1).max(4096).parse(url.searchParams.get('code'));
        const initial = await context(flow.guildId, flow.userId, flow.channelId);
        registry.assertPolicy(initial, 'oauth.start');
        if (!flowCurrent(flow, 'started'))
          throw new HttpError(409, 'Authorization was withdrawn or expired.');
        flow.status = 'processing';
        store.set('oauth.flows', flow.id, flow);
        const tokens = await exchange(
            provider,
            {
              grant_type: 'authorization_code',
              code,
              code_verifier: flow.verifier,
              redirect_uri: new URL(`/oauth/callback/${provider}`, base).href,
            },
            scopes(provider, flow.purpose),
          ),
          profile = await identity(provider, tokens.access);
        if (provider === 'discord' && profile.id !== flow.userId)
          throw new HttpError(403, 'Sign in with the same Discord account that requested this link.');
        const authorized = await context(flow.guildId, flow.userId, flow.channelId);
        registry.assertPolicy(authorized, 'oauth.start');
        if (!flowCurrent(flow, 'processing'))
          throw new HttpError(409, 'Authorization was withdrawn or expired.');
        flow.encrypted = await encrypt(tokens, recordKey(flow.guildId, flow.userId, flow.provider));
        if (!flowCurrent(flow, 'processing'))
          throw new HttpError(409, 'Authorization was withdrawn or expired.');
        flow.identity = profile;
        flow.status = 'pending';
        flow.verifier = '';
        store.set('oauth.flows', flow.id, flow);
        const cookies = [cookie('oauth_state', '', 0)];
        if (provider === 'discord') {
          if (sessions.size >= 500) throw new HttpError(429, 'Account session limit reached.');
          const session = secret();
          sessions.set(hash(session), {
            guildId: flow.guildId,
            userId: flow.userId,
            channelId: flow.channelId,
            expiresAt: now() + 900000,
          });
          cookies.push(cookie('account_session', session, 900, '/account'));
        }
        response.setHeader('Set-Cookie', cookies);
        page(
          response,
          'Verify your linked account',
          `<p>Provider verified: ${html(provider)}. Account: ${html(profile.name)} (${html(profile.id)}).</p>${flow.joinGuildId ? `<p>Explicit join consent target server: ${html(flow.joinGuildId)}. Linking alone does not join this server.</p>` : ''}<p>Return to the original private Discord channel and confirm this exact account before it is saved:</p><pre>${html(`/action name:oauth.link.confirm input:${JSON.stringify({ id: flow.id, provider, accountId: profile.id })}`)}</pre>${provider === 'discord' ? '<p><a href="/account">Open your OAuth-authenticated account dashboard</a></p>' : ''}`,
        );
        return true;
      }
      throw new HttpError(404, 'Unknown account route.');
    } catch (error) {
      page(
        response,
        'Account authorization unavailable',
        `<p>${html(error instanceof HttpError ? error.message : 'The authorization could not be completed. No successful account link is assumed; start a new flow in Discord.')}</p>`,
        error instanceof HttpError ? error.status : 400,
      );
    } finally {
      active--;
    }
    return true;
  }
  async function authenticateActivity(code: string) {
    if (closed || !clientId('discord') || !clientSecret('discord'))
      throw new UserError('Configure Discord OAuth credentials to authenticate Activities.');
    const tokens = await exchange('discord', { grant_type: 'authorization_code', code }, ['identify']);
    const profile = await identity('discord', tokens.access);
    if (closed) throw new UserError('Activity authentication was cancelled.');
    return { accessToken: tokens.access, identity: profile, expiresAt: tokens.expiresAt };
  }
  return {
    registerActions,
    handle,
    status,
    credential,
    authenticateActivity,
    close() {
      closed = true;
      sessions.clear();
      refreshing.clear();
    },
  };
}
