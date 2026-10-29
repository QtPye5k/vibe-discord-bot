import { randomUUID } from 'node:crypto';
import {
  EntitlementType,
  PermissionFlagsBits as P,
  SKUFlags,
  SKUType,
  type Client,
  type Entitlement,
  type GuildMember,
} from 'discord.js';
import { z } from 'zod';
import { UserError } from '../core/errors.js';
import { assertOperator } from '../core/operator.js';
import {
  assertHierarchy,
  assertRoleHierarchy,
  freshContext,
  resolveChannel,
  resolveMember,
  resolveRole,
} from '../core/permissions.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
import type { ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import type { ActionContext } from '../core/types.js';

const id = z.string().regex(/^\d{17,20}$/);
const POLICY = 'entitlement.roles.policy',
  GRANTS = 'entitlement.roles.grants',
  JOBS = 'entitlement.roles.jobs';
export const ENTITLEMENT_ROLE_LIMITS = Object.freeze({
  mappings: 10,
  policies: 100,
  pageSize: 100,
  pages: 5,
  refreshMs: 300000,
  jobs: 1000,
  guildJobs: 200,
  grants: 5000,
  guildGrants: 500,
  concurrent: 2,
  sweepJobs: 5,
  attempts: 3,
});
export interface EntitlementRoleOptions {
  operatorIds?: readonly string[];
  allowedGuildIds?: readonly string[];
  now?: () => number;
}
interface Mapping {
  skuId: string;
  roleId: string;
}
interface Policy {
  applicationId: string;
  authorId: string;
  channelId: string;
  version: string;
  mappings: Mapping[];
}
interface Grant {
  id: string;
  guildId: string;
  userId: string;
  skuId: string;
  roleId: string;
  version: string;
  state: 'pending-add' | 'owned' | 'uncertain' | 'detached' | 'removed' | 'unowned';
  confirmedAdded: boolean;
  nextAt: number;
  updatedAt: number;
}
interface Job {
  id: string;
  guildId: string;
  userId: string;
  version: string;
  attempts: number;
  retryAt: number;
  status: 'pending' | 'failed';
  lastError?: string;
}
const mappingSchema = z
  .strictObject({
    mappings: z.array(z.strictObject({ skuId: id, roleId: id })).max(ENTITLEMENT_ROLE_LIMITS.mappings),
  })
  .refine(
    ({ mappings }) =>
      new Set(mappings.map((row) => row.skuId)).size === mappings.length &&
      new Set(mappings.map((row) => row.roleId)).size === mappings.length,
    'Use one-to-one SKU/role mappings.',
  );
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;
const grantKey = (guildId: string, userId: string, roleId: string) => `${key(guildId, userId)}:${roleId}`;
const clock = (options: EntitlementRoleOptions) => (options.now ?? Date.now)();
function enabled(store: Store, guildId: string, options: EntitlementRoleOptions): void {
  if (options.allowedGuildIds?.length && !options.allowedGuildIds.includes(guildId))
    throw new UserError('This server is outside the configured guild allowlist.');
  if ((store.get<string[]>('core.disabled', guildId) ?? []).includes('membership'))
    throw new UserError('Membership features are disabled.');
}
async function checked<T>(run: () => Promise<T>, current: () => void): Promise<T> {
  current();
  const value = await run();
  current();
  return value;
}
async function manager(
  ctx: ActionContext,
  options: EntitlementRoleOptions,
  current: () => void,
): Promise<ActionContext> {
  current();
  if (!ctx.client.application) throw new UserError('The bot application is unavailable.');
  await checked(() => ctx.client.application!.fetch(), current);
  const fresh = await checked(() => freshContext(ctx), current);
  assertOperator(fresh, options.operatorIds);
  if (
    !fresh.member.permissions.has([P.ManageGuild, P.ManageRoles]) ||
    !fresh.guild.members.me?.permissions.has(P.ManageRoles)
  )
    throw new UserError(
      'The configuring operator and bot need current Manage Server/Manage Roles authority.',
    );
  await checked(() => resolveChannel(fresh, fresh.channelId), current);
  assertOperator(fresh, options.operatorIds);
  if (
    !fresh.member.permissions.has([P.ManageGuild, P.ManageRoles]) ||
    !fresh.guild.members.me?.permissions.has(P.ManageRoles)
  )
    throw new UserError('Current operator/manager and bot role permissions were revoked.');
  return fresh;
}
async function sku(client: Client, skuId: string, applicationId: string, current: () => void): Promise<void> {
  if (!client.application || client.application.id !== applicationId)
    throw new UserError('Entitlements must belong to this bot application.');
  const values = await checked(() => client.application!.fetchSKUs(), current);
  const value = values.get(skuId),
    flags = Number(value?.flags.bitfield);
  if (
    values.size > 1000 ||
    !value ||
    value.id !== skuId ||
    value.applicationId !== applicationId ||
    value.type !== SKUType.Subscription ||
    ![SKUFlags.UserSubscription, SKUFlags.UserSubscription | SKUFlags.Available].includes(flags)
  )
    throw new UserError(
      'Choose this application’s individual UserSubscription SKU (type 5); guild, group, one-time and unknown SKU scopes are unsupported.',
    );
}
async function roleTarget(ctx: ActionContext, userId: string, roleId: string, current: () => void) {
  const target = await checked(() => resolveMember(ctx, userId), current),
    role = await checked(() => resolveRole(ctx, roleId), current);
  if (target.id !== userId || target.user.bot)
    throw new UserError('Subscription roles are only for the selected current human member.');
  assertHierarchy(ctx, target);
  assertRoleHierarchy(ctx, role);
  assertOrdinaryRole(role, ctx.guild.members.me!);
  current();
  return { target, role };
}
/** Fetch every page in one cursor direction. An incomplete/invalid result can never prove entitlement absence. */
async function entitlements(
  client: Client,
  applicationId: string,
  userId: string,
  skus: string[],
  current: () => void,
): Promise<Entitlement[]> {
  let after = '0';
  const result: Entitlement[] = [],
    seen = new Set<string>();
  for (let page = 0; page < ENTITLEMENT_ROLE_LIMITS.pages; page++) {
    if (!client.application || client.application.id !== applicationId)
      throw new UserError('The bot application changed.');
    const values = await checked(
      () =>
        client.application!.entitlements.fetch({
          user: userId,
          skus,
          limit: ENTITLEMENT_ROLE_LIMITS.pageSize,
          after,
          excludeEnded: false,
          excludeDeleted: false,
          cache: false,
        }),
      current,
    );
    if (values.size > ENTITLEMENT_ROLE_LIMITS.pageSize)
      throw new UserError('Entitlement response exceeded its page bound.');
    let maximum = BigInt(after);
    for (const value of values.values()) {
      if (
        !id.safeParse(value.id).success ||
        seen.has(value.id) ||
        BigInt(value.id) <= BigInt(after) ||
        value.applicationId !== applicationId ||
        value.userId !== userId ||
        !skus.includes(value.skuId) ||
        value.guildId !== null ||
        value.type !== EntitlementType.ApplicationSubscription ||
        typeof value.deleted !== 'boolean' ||
        typeof value.consumed !== 'boolean' ||
        ![value.startsTimestamp, value.endsTimestamp].every(
          (time) => time === null || (typeof time === 'number' && Number.isFinite(time)),
        ) ||
        (value.startsTimestamp !== null &&
          value.endsTimestamp !== null &&
          value.startsTimestamp > value.endsTimestamp)
      )
        throw new UserError(
          'Entitlement response had an invalid, foreign, duplicate or unsupported user subscription record.',
        );
      seen.add(value.id);
      result.push(value);
      maximum = BigInt(value.id) > maximum ? BigInt(value.id) : maximum;
    }
    if (values.size < ENTITLEMENT_ROLE_LIMITS.pageSize) return result;
    after = maximum.toString();
  }
  throw new UserError('Entitlement pagination is incomplete at its 500-record bound; no roles were changed.');
}
function active(value: Entitlement, now: number): boolean {
  return (
    !value.deleted &&
    !value.consumed &&
    (value.startsTimestamp === null || value.startsTimestamp <= now) &&
    (value.endsTimestamp === null || value.endsTimestamp > now)
  );
}
function queue(
  store: Store,
  guildId: string,
  userId: string,
  policy: Policy,
  now: number,
  reset = false,
): Job {
  const jobKey = key(guildId, userId),
    existing = store.get<Job>(JOBS, jobKey);
  if (!reset && existing?.version === policy.version) return existing;
  if (
    !existing &&
    (store.list(JOBS).length >= ENTITLEMENT_ROLE_LIMITS.jobs ||
      store.list(JOBS, `${guildId}:`).length >= ENTITLEMENT_ROLE_LIMITS.guildJobs)
  )
    throw new UserError('Entitlement reconciliation queue is full.');
  const job: Job = {
    id: randomUUID(),
    guildId,
    userId,
    version: policy.version,
    attempts: 0,
    retryAt: now,
    status: 'pending',
  };
  store.set(JOBS, jobKey, job);
  return job;
}
let running = 0;
const users = new WeakMap<Store, Set<string>>(),
  sweeping = new WeakSet<Store>();
async function admitted<T>(store: Store, userKey: string, run: () => Promise<T>): Promise<T> {
  const set = users.get(store) ?? new Set<string>();
  users.set(store, set);
  if (set.has(userKey) || running >= ENTITLEMENT_ROLE_LIMITS.concurrent)
    throw new UserError('Entitlement role reconciliations are busy.');
  set.add(userKey);
  running++;
  try {
    return await run();
  } finally {
    set.delete(userKey);
    running--;
  }
}
async function reconcile(
  client: Client,
  store: Store,
  job: Job,
  options: EntitlementRoleOptions,
): Promise<unknown> {
  const policy = store.get<Policy>(POLICY, job.guildId),
    deadline = performance.now() + 20000;
  const current = () => {
    enabled(store, job.guildId, options);
    const latest = store.get<Job>(JOBS, key(job.guildId, job.userId));
    if (
      !policy ||
      policy.version !== job.version ||
      store.get<Policy>(POLICY, job.guildId)?.version !== job.version ||
      latest?.id !== job.id ||
      latest.status !== 'pending' ||
      performance.now() > deadline
    )
      throw new UserError('Entitlement reconciliation was cancelled or exceeded its work deadline.');
  };
  current();
  const guild = await checked(() => client.guilds.fetch(job.guildId), current);
  const base = {
    client,
    store,
    guild,
    member: { id: policy!.authorId } as GuildMember,
    channelId: policy!.channelId,
  };
  await manager(base, options, current);
  const values = await entitlements(
    client,
    policy!.applicationId,
    job.userId,
    policy!.mappings.map((row) => row.skuId),
    current,
  );
  const added: string[] = [],
    removed: string[] = [],
    preserved: string[] = [],
    review: string[] = [];
  for (const mapping of policy!.mappings) {
    current();
    let ctx = await manager(base, options, current);
    await sku(client, mapping.skuId, policy!.applicationId, current);
    const { target, role } = await roleTarget(ctx, job.userId, mapping.roleId, current);
    ctx = await manager(ctx, options, current);
    assertHierarchy(ctx, target);
    assertRoleHierarchy(ctx, role);
    assertOrdinaryRole(role, ctx.guild.members.me!);
    const recordKey = grantKey(job.guildId, job.userId, mapping.roleId);
    const existing = store.get<Grant>(GRANTS, recordKey);
    if (
      existing &&
      (existing.version !== policy!.version ||
        ['detached', 'uncertain', 'pending-add'].includes(existing.state))
    ) {
      review.push(role.id);
      continue;
    }
    const now = clock(options),
      matching = values.filter((value) => value.skuId === mapping.skuId && active(value, now));
    const present = target.roles.cache.has(role.id);
    if (matching.length && present && (existing?.state !== 'owned' || !existing.confirmedAdded)) {
      preserved.push(role.id);
      continue;
    }
    if (!matching.length && (existing?.state !== 'owned' || !existing.confirmedAdded)) {
      if (present) preserved.push(role.id);
      continue;
    }
    if (
      !existing &&
      (store.list(GRANTS).length >= ENTITLEMENT_ROLE_LIMITS.grants ||
        store.list(GRANTS, `${job.guildId}:`).length >= ENTITLEMENT_ROLE_LIMITS.guildGrants)
    )
      throw new UserError('Entitlement role ownership record limit reached.');
    const record: Grant = {
      id: existing?.id ?? randomUUID(),
      guildId: job.guildId,
      userId: job.userId,
      skuId: mapping.skuId,
      roleId: role.id,
      version: policy!.version,
      state: matching.length ? 'owned' : 'removed',
      confirmedAdded: existing?.confirmedAdded ?? false,
      nextAt: matching.length
        ? Math.min(
            now + ENTITLEMENT_ROLE_LIMITS.refreshMs,
            ...matching.map((value) => value.endsTimestamp ?? Infinity),
          )
        : 0,
      updatedAt: now,
    };
    if ((matching.length && !present) || (!matching.length && present)) {
      current();
      store.set(GRANTS, recordKey, { ...record, state: matching.length ? 'pending-add' : 'uncertain' });
      try {
        if (matching.length) {
          await target.roles.add(role, `Verified app entitlement role ${record.id}`);
          record.confirmedAdded = true;
          added.push(role.id);
        } else {
          await target.roles.remove(role, `Expired app entitlement role ${record.id}`);
          removed.push(role.id);
        }
      } catch (error) {
        const latest = store.get<Grant>(GRANTS, recordKey);
        if (latest?.id === record.id && ['pending-add', 'uncertain'].includes(latest.state))
          store.set(GRANTS, recordKey, { ...record, state: 'uncertain' });
        throw error;
      }
      // Record confirmed provenance even if a policy was cancelled during an already-sent REST operation.
      const latest = store.get<Grant>(GRANTS, recordKey);
      if (latest?.id === record.id && ['pending-add', 'uncertain'].includes(latest.state))
        store.set(GRANTS, recordKey, record);
      current();
    } else store.set(GRANTS, recordKey, record);
  }
  current();
  store.delete(JOBS, key(job.guildId, job.userId));
  return {
    userId: job.userId,
    added,
    removed,
    preserved,
    review,
    notice:
      'Only confirmed bot-added roles are automatically removed; preserved/manual-review roles remain untouched.',
  };
}
function failed(store: Store, job: Job, error: unknown, now: number): void {
  const current = store.get<Job>(JOBS, key(job.guildId, job.userId));
  if (current?.id !== job.id || store.get<Policy>(POLICY, job.guildId)?.version !== job.version) return;
  const attempts = job.attempts + 1;
  store.set(JOBS, key(job.guildId, job.userId), {
    ...job,
    attempts,
    status: attempts >= ENTITLEMENT_ROLE_LIMITS.attempts ? 'failed' : 'pending',
    retryAt: now + 60000 * 2 ** (attempts - 1),
    lastError: error instanceof Error ? error.name : 'Error',
  } satisfies Job);
}
async function requestTarget(
  ctx: ActionContext,
  userId: string,
  options: EntitlementRoleOptions,
): Promise<void> {
  if (userId === ctx.member.id) return;
  await manager(ctx, options, () => enabled(ctx.store, ctx.guild.id, options));
}

export function registerEntitlementRoleActions(
  registry: ActionRegistry,
  options: EntitlementRoleOptions = {},
): void {
  const base = {
    category: 'membership',
    risk: 'write' as const,
    userPermissions: [] as bigint[],
    botPermissions: [] as bigint[],
  };
  const admin = { ...base, userPermissions: [P.ManageGuild, P.ManageRoles], botPermissions: [P.ManageRoles] };
  registry.register({
    ...admin,
    id: 'entitlement.roles.configure',
    description:
      'Operator + Manage Server/Roles: map this application’s individual subscription SKUs to ordinary roles. Empty mappings cancels automation and preserves existing roles for review.',
    schema: mappingSchema,
    execute: async (ctx, { mappings }) => {
      const previous = ctx.store.get<Policy>(POLICY, ctx.guild.id);
      const current = () => {
        enabled(ctx.store, ctx.guild.id, options);
        if (ctx.store.get<Policy>(POLICY, ctx.guild.id)?.version !== previous?.version)
          throw new UserError('Entitlement role policy changed while it was being configured.');
      };
      let fresh = await manager(ctx, options, current);
      for (const mapping of mappings) {
        await sku(ctx.client, mapping.skuId, ctx.client.application!.id, current);
        const role = await checked(() => resolveRole(fresh, mapping.roleId), current);
        assertRoleHierarchy(fresh, role);
        assertOrdinaryRole(role, fresh.guild.members.me!);
      }
      fresh = await manager(fresh, options, current);
      if (!previous && mappings.length && ctx.store.list(POLICY).length >= ENTITLEMENT_ROLE_LIMITS.policies)
        throw new UserError('Entitlement role policy limit reached.');
      const policy: Policy = {
        applicationId: ctx.client.application!.id,
        authorId: fresh.member.id,
        channelId: ctx.channelId,
        version: randomUUID(),
        mappings,
      };
      current();
      if (mappings.length) ctx.store.set(POLICY, ctx.guild.id, policy);
      else ctx.store.delete(POLICY, ctx.guild.id);
      for (const row of ctx.store.list<Job>(JOBS, `${ctx.guild.id}:`)) ctx.store.delete(JOBS, row.key);
      return {
        ...policy,
        enabled: mappings.length > 0,
        notice:
          'Prior-version bot-added roles are retained for explicit review/resume; policy removal never triggers automatic removals.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'entitlement.roles.policy',
    risk: 'read',
    description:
      'Inspect this server’s own-application subscription-role mapping and automation policy version.',
    schema: z.strictObject({}),
    execute: (ctx) => ctx.store.get(POLICY, ctx.guild.id) ?? null,
  });
  registry.register({
    ...base,
    id: 'entitlement.roles.grants',
    risk: 'read',
    description:
      'Inspect your tracked subscription roles, or an operator-reviewed member’s ownership and retry state.',
    schema: z.strictObject({ userId: id.optional() }),
    execute: async (ctx, input) => {
      const userId = input.userId ?? ctx.member.id;
      await requestTarget(ctx, userId, options);
      return {
        grants: ctx.store.list<Grant>(GRANTS, `${key(ctx.guild.id, userId)}:`).map((row) => row.value),
        job: ctx.store.get(JOBS, key(ctx.guild.id, userId)) ?? null,
      };
    },
  });
  registry.register({
    ...base,
    id: 'entitlement.roles.sync',
    description:
      'Confirm a fresh own-application entitlement reconciliation for yourself; operator managers may select another current member. Never trusts Gateway grant data.',
    schema: z.strictObject({ userId: id.optional() }),
    execute: async (ctx, input) => {
      const userId = input.userId ?? ctx.member.id;
      enabled(ctx.store, ctx.guild.id, options);
      await requestTarget(ctx, userId, options);
      return admitted(ctx.store, key(ctx.guild.id, userId), async () => {
        const policy = ctx.store.get<Policy>(POLICY, ctx.guild.id);
        if (!policy) throw new UserError('An operator must configure subscription role mappings first.');
        const job = queue(ctx.store, ctx.guild.id, userId, policy, clock(options), true);
        try {
          return await reconcile(ctx.client, ctx.store, job, options);
        } catch (error) {
          failed(ctx.store, job, error, clock(options));
          throw error;
        }
      });
    },
  });
  registry.register({
    ...admin,
    id: 'entitlement.roles.review',
    description:
      'Operator review of a tracked bot-added role: detach for manual ownership, explicitly remove, or resume against the current mapping and fresh entitlements.',
    schema: z.strictObject({ userId: id, roleId: id, operation: z.enum(['detach', 'remove', 'resume']) }),
    execute: async (ctx, input) => {
      return admitted(ctx.store, key(ctx.guild.id, input.userId), async () => {
        const recordKey = grantKey(ctx.guild.id, input.userId, input.roleId),
          record = ctx.store.get<Grant>(GRANTS, recordKey);
        if (!record)
          throw new UserError(
            'No bot ownership/intent record exists for this role; pre-existing roles are never claimed.',
          );
        const current = () => {
          enabled(ctx.store, ctx.guild.id, options);
          if (ctx.store.get<Grant>(GRANTS, recordKey)?.id !== record.id)
            throw new UserError('Role review was cancelled.');
        };
        const fresh = await manager(ctx, options, current);
        if (input.operation === 'resume') {
          const policy = ctx.store.get<Policy>(POLICY, ctx.guild.id);
          if (
            !policy?.mappings.some(
              (mapping) => mapping.roleId === record.roleId && mapping.skuId === record.skuId,
            )
          )
            throw new UserError('Resume requires the same SKU/role pair in the current approved policy.');
          const job = queue(ctx.store, ctx.guild.id, input.userId, policy, clock(options), true);
          ctx.store.set(GRANTS, recordKey, {
            ...record,
            state: record.confirmedAdded ? 'owned' : 'unowned',
            version: policy.version,
            nextAt: clock(options),
          });
          try {
            return await reconcile(ctx.client, ctx.store, job, options);
          } catch (error) {
            failed(ctx.store, job, error, clock(options));
            throw error;
          }
        }
        if (input.operation === 'remove') {
          if (record.state !== 'owned' || !record.confirmedAdded)
            throw new UserError(
              'Only confirmed current bot ownership may be removed; detached, ambiguous or already-removed roles need explicit resume or manual Discord review.',
            );
          const { target, role } = await roleTarget(fresh, input.userId, input.roleId, current);
          const latestManager = await manager(fresh, options, current);
          assertHierarchy(latestManager, target);
          assertRoleHierarchy(latestManager, role);
          assertOrdinaryRole(role, latestManager.guild.members.me!);
          if (target.roles.cache.has(role.id)) {
            ctx.store.set(GRANTS, recordKey, {
              ...record,
              state: 'uncertain',
              nextAt: 0,
              updatedAt: clock(options),
            });
            await target.roles.remove(role, `Explicit subscription-role review ${record.id}`);
            current();
          }
        }
        current();
        ctx.store.set(GRANTS, recordKey, {
          ...record,
          state: 'detached',
          nextAt: 0,
          updatedAt: clock(options),
        });
        ctx.store.delete(JOBS, key(ctx.guild.id, input.userId));
        return {
          userId: input.userId,
          roleId: input.roleId,
          operation: input.operation,
          automatedOwnership: false,
        };
      });
    },
  });
}

/** Gateway events are hints only: enqueue matching users and verify the own-application REST API before every change. */
export function observeEntitlementRoleEvent(
  client: Client,
  store: Store,
  event: Pick<Entitlement, 'applicationId' | 'skuId' | 'userId' | 'guildId'>,
  options: EntitlementRoleOptions = {},
  now = clock(options),
): void {
  if (
    !client.application ||
    event.applicationId !== client.application.id ||
    !id.safeParse(event.userId).success ||
    event.guildId !== null
  )
    return;
  for (const row of store.list<Policy>(POLICY)) {
    try {
      enabled(store, row.key, options);
      if (
        row.value.applicationId === event.applicationId &&
        row.value.mappings.some((mapping) => mapping.skuId === event.skuId)
      )
        queue(store, row.key, event.userId, row.value, now);
    } catch {
      /* A hint never bypasses configured limits/policy. */
    }
  }
}
export async function sweepEntitlementRoleTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  options: EntitlementRoleOptions = {},
): Promise<void> {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const deadline = performance.now() + 20000;
  try {
    for (const row of store.list<Job>(JOBS))
      if (row.value.status === 'failed' && row.value.retryAt < now - 7 * 86400000)
        store.delete(JOBS, row.key);
    for (const row of store.list<Grant>(GRANTS)) {
      const grant = row.value,
        policy = store.get<Policy>(POLICY, grant.guildId);
      if (grant.state === 'owned' && grant.nextAt <= now && policy?.version === grant.version) {
        try {
          enabled(store, grant.guildId, options);
          queue(store, grant.guildId, grant.userId, policy, now);
        } catch {
          /* Existing grants remain intact while unavailable. */
        }
      }
    }
    const jobs = store
      .list<Job>(JOBS)
      .filter((row) => row.value.status === 'pending' && row.value.retryAt <= now)
      .slice(0, ENTITLEMENT_ROLE_LIMITS.sweepJobs);
    for (const row of jobs) {
      if (performance.now() >= deadline || running >= ENTITLEMENT_ROLE_LIMITS.concurrent) break;
      const job = row.value;
      if (users.get(store)?.has(row.key)) continue;
      try {
        enabled(store, job.guildId, options);
      } catch {
        continue;
      }
      if (store.get<Policy>(POLICY, job.guildId)?.version !== job.version) {
        store.delete(JOBS, row.key);
        continue;
      }
      try {
        await admitted(store, row.key, () => reconcile(client, store, job, options));
      } catch (error) {
        failed(store, job, error, now);
      }
    }
  } finally {
    sweeping.delete(store);
  }
}
