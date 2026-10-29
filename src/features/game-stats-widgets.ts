import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry } from '../core/registry.js';
import { assertPermissions, freshContext } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import type { OwnedCredential } from '../integrations/credentials.js';
import { publicUrl } from './integrations.js';
import { recordApiMetric } from './api-metrics.js';

const snowflake = z.string().regex(/^\d{17,20}$/),
  externalId = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  text = z.string().max(100),
  count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  media = z.strictObject({
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          publicUrl(value);
          return true;
        } catch {
          return false;
        }
      }, 'Use a public HTTPS media URL.'),
  });
const primarySchema = z.strictObject({
  season: text.optional(),
  rank_name: text.optional(),
  rank_image: media.optional(),
  highest_rank: text.optional(),
  highest_rank_image: media.optional(),
  featured_played_character: text.optional(),
  featured_played_character_image: media.optional(),
  playtime_hours: z.number().finite().min(0).max(1e9).optional(),
  total_wins: count.optional(),
  current_period_wins: count.optional(),
  total_games: count.optional(),
  current_period_games: count.optional(),
  total_kills: count.optional(),
  current_period_kills: count.optional(),
  total_assists: count.optional(),
  current_period_assists: count.optional(),
  total_deaths: count.optional(),
  current_period_deaths: count.optional(),
});
const dynamicSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(1), name: text.min(1), value: text }),
  z.strictObject({
    type: z.literal(2),
    name: text.min(1),
    value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ type: z.literal(3), name: text.min(1), value: media }),
]);
export const gameStatsDataSchema = z
  .strictObject({ primary: primarySchema.optional(), dynamic: z.array(dynamicSchema).max(30).optional() })
  .refine(
    (value) => new Set(value.dynamic?.map((field) => field.name)).size === (value.dynamic?.length ?? 0),
    'Dynamic stat names must be unique.',
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) < 10_000,
    'Serialized stat data must be smaller than 10,000 bytes.',
  );
export const gameStatsProfileSchema = z
  .strictObject({ username: z.string().max(1024).optional(), data: gameStatsDataSchema.optional() })
  .refine(
    (value) => value.username !== undefined || value.data !== undefined,
    'Supply a username or the complete replacement data.',
  );
const sourceSchema = z
  .strictObject({
    version: z.literal(1),
    profiles: z
      .array(
        z.strictObject({
          discordUserId: snowflake,
          providerIssuedUserId: externalId,
          profile: gameStatsProfileSchema,
        }),
      )
      .max(1000),
  })
  .refine(
    (value) => new Set(value.profiles.map((profile) => profile.discordUserId)).size === value.profiles.length,
    'Each Discord user may have only one approved source profile.',
  );
const identitySchema = z.object({
  user_id: snowflake,
  provider_type: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
  provider_issued_user_id: externalId,
  provider_id: externalId.optional(),
});
type Identity = z.infer<typeof identitySchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface GameStatsWidgetOptions {
  /** Fixed operator-approved export, never a path supplied through Discord. Blank disables the module. */
  profilesFile?: string;
  credential: (ctx: ActionContext) => Promise<OwnedCredential | undefined>;
  /** Production defaults to the existing bot-authenticated discord.js REST client, without another token. */
  request?: (
    ctx: ActionContext,
    method: 'get' | 'patch' | 'post',
    path: `/${string}`,
    body?: unknown,
  ) => Promise<unknown>;
}
async function approvedSource(path: string, userId: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1048576)
      throw new UserError('The approved game profile source must be a regular file at most 1 MiB.');
    const bytes = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    if (read > info.size) throw new UserError('The approved game profile source changed while reading.');
    const source = sourceSchema.parse(JSON.parse(bytes.subarray(0, read).toString('utf8'))),
      profile = source.profiles.find((profile) => profile.discordUserId === userId);
    if (!profile)
      throw new UserError('The game operator has not approved a profile source for your Discord account.');
    return { ...profile, sourceHash: digest(profile) };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      'The approved game profile source is unavailable or invalid. Ask the game operator to validate its local configuration.',
    );
  } finally {
    await handle?.close();
  }
}

/** Actual native Discord Profile Board widget data, distinct from the hosted Activity’s room statistics. */
export function registerGameStatsWidgetActions(
  registry: ActionRegistry,
  options: GameStatsWidgetOptions,
): void {
  const available = () => Boolean(options.profilesFile?.trim()),
    active = new Set<string>();
  const request =
    options.request ??
    (async (ctx, method, path, body) => ctx.client.rest[method](path, body === undefined ? {} : { body }));
  const base = {
    category: 'activities',
    risk: 'read' as const,
    userPermissions: [],
    botPermissions: [],
    available,
    unavailableReason:
      'Set GAME_STATS_PROFILES_FILE, claim/configure your game widget in Discord and link your own Discord game-stats authorization first.',
  };
  async function run<T>(
    initial: ActionContext,
    action: string,
    fn: (access: {
      ctx: () => ActionContext;
      verify: () => Promise<void>;
      call: (
        method: 'get' | 'patch' | 'post',
        path: `/${string}`,
        body?: unknown,
        beforeSend?: () => Promise<void>,
      ) => Promise<unknown>;
      applicationId: string;
    }) => Promise<T>,
  ): Promise<T> {
    const key = `${initial.guild.id}:${initial.member.id}`;
    if (active.size >= 4 || active.has(key))
      throw new UserError('Game profile synchronization is busy; wait for the current request.');
    active.add(key);
    try {
      let ctx = initial;
      const epoch = ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:activities`) ?? 0,
        grant = await options.credential(ctx);
      if (
        !grant ||
        grant.subjectUserId !== ctx.member.id ||
        grant.subjectGuildId !== ctx.guild.id ||
        grant.providerAccountId !== ctx.member.id ||
        !grant.scopes.includes('application_identities.write') ||
        !grant.authorizationId ||
        typeof grant.current !== 'function' ||
        !grant.current()
      )
        throw new UserError(
          'Link your own Discord account with oauth.start purpose game-stats before accessing game profile data.',
        );
      const verify = async () => {
        ctx = await freshContext(ctx);
        await assertPermissions(ctx, [], [], {});
        registry.assertPolicy(ctx, action);
        if (
          !available() ||
          !grant.current!() ||
          (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:activities`) ?? 0) !== epoch
        )
          throw new UserError(
            'Game profile authorization or server settings changed; the result was cancelled.',
          );
      };
      await verify();
      const applicationId = ctx.client.application?.id ?? ctx.client.user?.id;
      if (!applicationId || !snowflake.safeParse(applicationId).success)
        throw new UserError('The current bot application is unavailable.');
      const call = async (
        method: 'get' | 'patch' | 'post',
        path: `/${string}`,
        body?: unknown,
        beforeSend?: () => Promise<void>,
      ) => {
        await verify();
        await beforeSend?.();
        registry.assertPolicy(ctx, action);
        if (
          !grant.current!() ||
          (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:activities`) ?? 0) !== epoch
        )
          throw new UserError('Game profile authorization changed before dispatch.');
        const started = performance.now();
        let success = false;
        try {
          const result = await request(ctx, method, path, body);
          success = true;
          await verify();
          return result;
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError(
            'The Discord game profile request failed. Check game claiming, widget setup, account grant and the current identity; inspect remote state before retrying a write.',
          );
        } finally {
          recordApiMetric(
            ctx.store,
            ctx.guild.id,
            'discord',
            'game-stats.' + method,
            success,
            performance.now() - started,
          );
        }
      };
      return await fn({ ctx: () => ctx, verify, call, applicationId });
    } finally {
      active.delete(key);
    }
  }
  async function identities(access: Parameters<Parameters<typeof run>[2]>[0]): Promise<Identity[]> {
    const result = z
      .object({ identities: z.array(identitySchema).max(100) })
      .parse(
        await access.call(
          'get',
          `/users/${access.ctx().member.id}/application-identities/${access.applicationId}`,
        ),
      );
    if (result.identities.some((identity) => identity.user_id !== access.ctx().member.id))
      throw new UserError('Discord returned an identity belonging to a different account.');
    return result.identities;
  }
  const identityInput = { providerIssuedUserId: externalId };
  registry.register({
    ...base,
    id: 'game-stats.identities',
    description:
      'Discover your own native Discord Application Identities after the exact game-stats OAuth grant; no other player IDs can be queried.',
    schema: z.strictObject({}),
    execute: (ctx) => run(ctx, 'game-stats.identities', identities),
  });
  registry.register({
    ...base,
    id: 'game-stats.source',
    description:
      'Review your operator-approved game-ID mapping and complete stat payload, with the exact immutable input for a separately confirmed native widget update.',
    schema: z.strictObject({}),
    execute: (ctx) =>
      run(ctx, 'game-stats.source', async (access) => {
        const source = await approvedSource(options.profilesFile!, ctx.member.id);
        await access.verify();
        return {
          ...source,
          nextUpdateRequest: {
            sourceHash: source.sourceHash,
            providerIssuedUserId: source.providerIssuedUserId,
            profile: source.profile,
          },
          notice:
            'Review the complete payload. Including data fully replaces the previous widget data; fields omitted from data are removed.',
        };
      }),
  });
  registry.register({
    ...base,
    id: 'game-stats.profile',
    description:
      'Read your own native Game Stats Widget profile using a currently verified Application Identity, not a caller-claimed game account.',
    schema: z.strictObject(identityInput),
    execute: (ctx, input) =>
      run(ctx, 'game-stats.profile', async (access) => {
        if (
          !(await identities(access)).some(
            (identity) => identity.provider_issued_user_id === input.providerIssuedUserId,
          )
        )
          throw new UserError('That game identity is not currently linked to your Discord account.');
        const result = await access.call(
          'get',
          `/applications/${access.applicationId}/users/${ctx.member.id}/identities/${encodeURIComponent(input.providerIssuedUserId)}/profile`,
        );
        if (Buffer.byteLength(JSON.stringify(result)) > 65536)
          throw new UserError('The returned game profile exceeds the response bound.');
        return z
          .object({
            username: z.string().max(1024).nullable().optional(),
            data: gameStatsDataSchema.nullable().optional(),
          })
          .parse(result);
      }),
  });
  registry.register({
    ...base,
    id: 'game-stats.update',
    risk: 'write',
    description:
      'Confirm an exact approved full game-stat payload and source hash, then update your native Discord widget using the existing bot token and current personal grant.',
    schema: z.strictObject({
      ...identityInput,
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      profile: gameStatsProfileSchema,
    }),
    execute: (ctx, input) =>
      run(ctx, 'game-stats.update', async (access) => {
        const source = await approvedSource(options.profilesFile!, ctx.member.id);
        const exact = () =>
          source.sourceHash === input.sourceHash &&
          source.providerIssuedUserId === input.providerIssuedUserId &&
          digest(source.profile) === digest(input.profile);
        if (!exact())
          throw new UserError('The reviewed game profile differs from the operator-approved source.');
        const linked = await identities(access);
        if (
          linked.length &&
          !linked.some((identity) => identity.provider_issued_user_id === input.providerIssuedUserId)
        )
          throw new UserError(
            'Your existing game identity differs. Review and remove the exact stale identity before creating a new profile.',
          );
        await access.call(
          'patch',
          `/applications/${access.applicationId}/users/${ctx.member.id}/identities/${encodeURIComponent(input.providerIssuedUserId)}/profile`,
          input.profile,
          async () => {
            const current = await approvedSource(options.profilesFile!, ctx.member.id);
            if (current.sourceHash !== source.sourceHash)
              throw new UserError('The game profile source changed; review its new payload before updating.');
          },
        );
        return {
          updated: true,
          providerIssuedUserId: input.providerIssuedUserId,
          sourceHash: input.sourceHash,
          dataFullyReplaced: input.profile.data !== undefined,
          notice:
            'Discord accepted the profile update. Display additionally requires the claimed-game widget configuration and the player adding it to their profile.',
        };
      }),
  });
  registry.register({
    ...base,
    id: 'game-stats.remove',
    risk: 'destructive',
    description:
      'Confirm deletion of one exact currently verified own Application Identity and its widget data. Discord may block removal of the last account-linking identity.',
    schema: z.strictObject({
      ...identityInput,
      providerType: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
      providerId: externalId.optional(),
    }),
    execute: (ctx, input) =>
      run(ctx, 'game-stats.remove', async (access) => {
        const identity = (await identities(access)).find(
          (identity) =>
            identity.provider_type === input.providerType &&
            identity.provider_issued_user_id === input.providerIssuedUserId &&
            (identity.provider_id ?? undefined) === input.providerId,
        );
        if (!identity)
          throw new UserError('That exact identity is not currently linked to your Discord account.');
        // The documented deletion operation is POST .../delete, not HTTP DELETE.
        await access.call(
          'post',
          `/users/${ctx.member.id}/application-identities/${access.applicationId}/${encodeURIComponent(input.providerType)}/${encodeURIComponent(input.providerIssuedUserId)}/delete`,
          input.providerId ? { provider_id: input.providerId } : undefined,
        );
        return { deleted: true, providerIssuedUserId: input.providerIssuedUserId };
      }),
  });
}
