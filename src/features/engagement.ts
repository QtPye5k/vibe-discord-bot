import { createHash, randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client, type Guild } from 'discord.js';
import { z } from 'zod';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry, ActionPolicy } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { freshContext, resolveChannel, resolveMember, resolveRole } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { nextReportAt } from './reports.js';

const DAY = 86_400_000;
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  snowflake = z.string().regex(/^\d{17,20}$/);
const key = (guild: string, id: string) => `${guild}:${id}`;
const token = () => randomBytes(8).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const paused = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('engagement');
interface Group {
  id: string;
  kind: 'club' | 'group' | 'team' | 'volunteer' | 'staff';
  name: string;
  description: string;
  channelId: string;
  managerRoleId: string | null;
  capacity: number;
  waitlistCapacity: number;
  members: string[];
  waitlist: string[];
  revision: number;
}
interface Assignment {
  id: string;
  groupId: string;
  userId: string;
  authorId: string;
  task: string;
  createdAt: number;
  status: 'proposed' | 'accepted' | 'declined' | 'completed';
  updatedAt: number;
}
interface BasePolicy {
  id: string;
  guildId: string;
  authorId: string;
  originChannelId: string;
  channelId: string;
  version: string;
  enabled: boolean;
  lastError?: string;
}
interface Questions extends BasePolicy {
  kind: 'questions';
  questions: string[];
  hourUtc: number;
  minuteUtc: number;
  cursor: number;
  nextAt: number;
}
interface Milestone extends BasePolicy {
  kind: 'milestone';
  thresholds: number[];
  template: string;
  baseline: number;
  queued: number[];
  announced: number[];
}
type Policy = Questions | Milestone;
interface Delivery {
  id: string;
  guildId: string;
  policyId: string;
  version: string;
  kind: Policy['kind'];
  content: string;
  threshold?: number;
  dueAt: number;
  retryAt: number;
  attempts: number;
  status: 'pending' | 'done' | 'failed';
  updatedAt: number;
  lastError?: string;
}
const policyNamespace = 'engagement.posts',
  deliveryNamespace = 'engagement.deliveries';
function group(ctx: ActionContext, id: string): Group {
  const row = ctx.store.get<Group>('engagement.groups', key(ctx.guild.id, id));
  if (!row) throw new UserError('Group does not exist in this server.');
  return row;
}
function manager(ctx: ActionContext, row: Group): boolean {
  return (
    ctx.member.permissions.has(P.ManageGuild) ||
    (row.managerRoleId !== null && ctx.member.roles.cache.has(row.managerRoleId))
  );
}
async function groupAccess(ctx: ActionContext, row: Group, manage = false): Promise<void> {
  await resolveChannel(ctx, row.channelId);
  if (manage && !manager(ctx, row))
    throw new UserError('Manage Server or the current configured manager role is required.');
}
function displayGroup(row: Group, userId: string, manage: boolean) {
  return {
    ...row,
    members: manage ? row.members : undefined,
    waitlist: manage ? row.waitlist : undefined,
    enrolled: row.members.includes(userId),
    waitingPosition: row.waitlist.includes(userId) ? row.waitlist.indexOf(userId) + 1 : null,
    memberCount: row.members.length,
    waitingCount: row.waitlist.length,
    notice:
      'Enrollment and assignments are local opt-in records. They do not grant Discord roles, staff authority or send DMs.',
  };
}
function removeEnrollment(row: Group, userId: string): boolean {
  const removed = row.members.includes(userId) || row.waitlist.includes(userId);
  row.members = row.members.filter((id) => id !== userId);
  row.waitlist = row.waitlist.filter((id) => id !== userId);
  while (row.members.length < row.capacity && row.waitlist.length) row.members.push(row.waitlist.shift()!);
  if (removed) row.revision++;
  return removed;
}
function enabled(ctx: ActionContext): void {
  if (paused(ctx.store, ctx.guild.id)) throw new UserError('Engagement is disabled in this server.');
}
async function sendable(ctx: ActionContext, channelId: string) {
  const channel = await resolveChannel(ctx, channelId),
    bot = ctx.guild.members.me;
  if (
    !bot ||
    !channel.isSendable() ||
    !channel.permissionsFor(ctx.member)?.has(P.SendMessages) ||
    !channel.permissionsFor(bot)?.has(P.SendMessages)
  )
    throw new UserError('You and the bot need sending access in the configured channel.');
  return channel;
}
function policyKey(guildId: string, kind: Policy['kind'], id: string): string {
  return `${guildId}:${kind}:${id}`;
}
function currentPolicy(store: Store, delivery: Delivery): Policy | undefined {
  const row = store.get<Policy>(
    policyNamespace,
    policyKey(delivery.guildId, delivery.kind, delivery.policyId),
  );
  return row?.version === delivery.version && row.enabled ? row : undefined;
}
function checkPolicyAuthority(ctx: ActionContext, policy: Policy): void {
  if (!ctx.member.permissions.has(P.ManageGuild))
    throw new UserError('Post policy author no longer has Manage Server.');
  const action = `engagement.${policy.kind === 'questions' ? 'questions' : 'milestone'}.set`;
  const rule = ctx.store.get<ActionPolicy>('core.actionPolicies', key(ctx.guild.id, action));
  if (
    rule &&
    (!rule.enabled ||
      (rule.channelIds.length && !rule.channelIds.includes(policy.originChannelId)) ||
      (rule.roleIds.length && !rule.roleIds.some((role) => ctx.member.roles.cache.has(role))))
  )
    throw new UserError('Post policy authorization was revoked.');
}
function addPolicy(ctx: ActionContext, policy: Policy): void {
  const policyId = policyKey(ctx.guild.id, policy.kind, policy.id);
  if (
    !ctx.store.get(policyNamespace, policyId) &&
    ctx.store.list(policyNamespace, `${ctx.guild.id}:${policy.kind}:`).length >= 5
  )
    throw new UserError('Limit: five question policies and five milestone policies per server.');
  ctx.store.set(policyNamespace, policyId, policy);
}
export function registerEngagementActions(registry: ActionRegistry): void {
  const base = { category: 'engagement', userPermissions: [] as bigint[], botPermissions: [] as bigint[] };
  registry.register({
    ...base,
    id: 'group.configure',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    description:
      'Create a capacity-limited opt-in club/group/team/volunteer/staff roster. This grants no Discord roles.',
    schema: z.strictObject({
      id,
      kind: z.enum(['club', 'group', 'team', 'volunteer', 'staff']),
      name: z.string().min(1).max(100),
      description: z.string().max(1000).default(''),
      channelId: snowflake,
      managerRoleId: snowflake.nullable().default(null),
      capacity: z.number().int().min(1).max(500),
      waitlistCapacity: z.number().int().min(0).max(500).default(100),
    }),
    execute: async (ctx, input) => {
      await resolveChannel(ctx, input.channelId);
      if (input.managerRoleId) await resolveRole(ctx, input.managerRoleId);
      enabled(ctx);
      return ctx.store.transaction(() => {
        const previous = ctx.store.get<Group>('engagement.groups', key(ctx.guild.id, input.id));
        if (!previous && ctx.store.list('engagement.groups', `${ctx.guild.id}:`).length >= 25)
          throw new UserError('Limit: 25 rosters per server.');
        if (
          previous &&
          (input.capacity < previous.members.length || input.waitlistCapacity < previous.waitlist.length)
        )
          throw new UserError('Remove or increase capacity before shrinking below existing enrollment.');
        const row: Group = {
          ...input,
          members: previous?.members ?? [],
          waitlist: previous?.waitlist ?? [],
          revision: (previous?.revision ?? 0) + 1,
        };
        while (row.members.length < row.capacity && row.waitlist.length)
          row.members.push(row.waitlist.shift()!);
        ctx.store.set('engagement.groups', key(ctx.guild.id, row.id), row);
        return displayGroup(row, ctx.member.id, true);
      });
    },
  });
  registry.register({
    ...base,
    id: 'group.list',
    risk: 'read',
    description: 'List currently visible opt-in rosters and your enrollment/waitlist state.',
    schema: z.strictObject({}),
    execute: async (ctx) => {
      const result: unknown[] = [];
      for (const { value: row } of ctx.store.list<Group>('engagement.groups', `${ctx.guild.id}:`)) {
        try {
          await groupAccess(ctx, row);
          result.push(displayGroup(row, ctx.member.id, manager(ctx, row)));
        } catch {
          /* Hidden roster stays hidden. */
        }
      }
      return result;
    },
  });
  registry.register({
    ...base,
    id: 'group.enroll',
    risk: 'write',
    description: 'Opt yourself into a visible roster, or its FIFO waitlist if full. No role or DM is sent.',
    schema: z.strictObject({ id }),
    execute: async (ctx, input) => {
      const original = group(ctx, input.id);
      await groupAccess(ctx, original);
      enabled(ctx);
      return ctx.store.transaction(() => {
        const row = group(ctx, input.id);
        if (row.revision !== original.revision)
          throw new UserError('Roster changed during authorization. Try again.');
        if (!row.members.includes(ctx.member.id) && !row.waitlist.includes(ctx.member.id)) {
          if (row.members.length < row.capacity) row.members.push(ctx.member.id);
          else if (row.waitlist.length < row.waitlistCapacity) row.waitlist.push(ctx.member.id);
          else throw new UserError('The roster and its waitlist are full.');
          row.revision++;
          ctx.store.set('engagement.groups', key(ctx.guild.id, row.id), row);
        }
        return displayGroup(row, ctx.member.id, manager(ctx, row));
      });
    },
  });
  registry.register({
    ...base,
    id: 'group.leave',
    risk: 'write',
    description:
      'Leave your enrollment/waitlist and promote the next consented waiting record. Available while engagement is disabled.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const row = group(ctx, input.id);
        const removed = removeEnrollment(row, ctx.member.id);
        ctx.store.set('engagement.groups', key(ctx.guild.id, row.id), row);
        return { removed, memberCount: row.members.length, waitingCount: row.waitlist.length };
      }),
  });
  registry.register({
    ...base,
    id: 'group.member.remove',
    risk: 'write',
    description:
      'A current roster manager removes a local enrollment/waitlist record without changing Discord roles.',
    schema: z.strictObject({ id, userId: snowflake }),
    execute: async (ctx, input) => {
      await groupAccess(ctx, group(ctx, input.id), true);
      enabled(ctx);
      return ctx.store.transaction(() => {
        const row = group(ctx, input.id);
        if (!manager(ctx, row)) throw new UserError('Roster manager role changed.');
        const removed = removeEnrollment(row, input.userId);
        ctx.store.set('engagement.groups', key(ctx.guild.id, row.id), row);
        return { removed };
      });
    },
  });
  registry.register({
    ...base,
    id: 'group.delete',
    risk: 'destructive',
    userPermissions: [P.ManageGuild],
    description:
      'Delete one local roster and its assignments. No Discord role, channel or member is removed.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const removed = ctx.store.delete('engagement.groups', key(ctx.guild.id, input.id));
        let assignments = 0;
        for (const row of ctx.store.list<Assignment>(
          'engagement.assignments',
          `${ctx.guild.id}:${input.id}:`,
        ))
          if (ctx.store.delete('engagement.assignments', row.key)) assignments++;
        return { removed, assignmentsDeleted: assignments };
      }),
  });
  registry.register({
    ...base,
    id: 'group.assignment.set',
    risk: 'write',
    description:
      'A current roster manager proposes a local volunteer/staff/team task to an enrolled member. The target must accept it.',
    schema: z.strictObject({ groupId: id, id, userId: snowflake, task: z.string().min(1).max(500) }),
    execute: async (ctx, input) => {
      const row = group(ctx, input.groupId);
      await groupAccess(ctx, row, true);
      await resolveMember(ctx, input.userId);
      enabled(ctx);
      return ctx.store.transaction(() => {
        const fresh = group(ctx, input.groupId);
        if (fresh.revision !== row.revision)
          throw new UserError('Roster changed during authorization. Try again.');
        if (!manager(ctx, fresh)) throw new UserError('Roster manager role changed.');
        if (!fresh.members.includes(input.userId))
          throw new UserError('The target must explicitly enroll and hold a roster seat first.');
        const assignmentKey = `${ctx.guild.id}:${input.groupId}:${input.id}`;
        if (
          !ctx.store.get('engagement.assignments', assignmentKey) &&
          ctx.store.list('engagement.assignments', `${ctx.guild.id}:${input.groupId}:`).length >= 100
        )
          throw new UserError('Limit: 100 assignments per roster.');
        const assignment: Assignment = {
          ...input,
          authorId: ctx.member.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'proposed',
        };
        ctx.store.set('engagement.assignments', assignmentKey, assignment);
        return assignment;
      });
    },
  });
  registry.register({
    ...base,
    id: 'group.assignment.list',
    risk: 'read',
    description: 'Read local assignments; roster managers see all and enrolled members see only their own.',
    schema: z.strictObject({ groupId: id }),
    execute: async (ctx, input) => {
      const row = group(ctx, input.groupId);
      await groupAccess(ctx, row);
      return ctx.store
        .list<Assignment>('engagement.assignments', `${ctx.guild.id}:${row.id}:`)
        .map((entry) => entry.value)
        .filter((assignment) => manager(ctx, row) || assignment.userId === ctx.member.id);
    },
  });
  registry.register({
    ...base,
    id: 'group.assignment.respond',
    risk: 'write',
    description:
      'Accept, decline or complete your own proposed local task. Declining remains available while engagement is disabled.',
    schema: z.strictObject({ groupId: id, id, status: z.enum(['accepted', 'declined', 'completed']) }),
    execute: async (ctx, input) => {
      if (input.status !== 'declined') {
        await groupAccess(ctx, group(ctx, input.groupId));
        enabled(ctx);
      }
      return ctx.store.transaction(() => {
        const assignmentKey = `${ctx.guild.id}:${input.groupId}:${input.id}`;
        const assignment = ctx.store.get<Assignment>('engagement.assignments', assignmentKey);
        if (!assignment || assignment.userId !== ctx.member.id)
          throw new UserError('This assignment belongs to another person or is unavailable.');
        if (input.status === 'completed' && assignment.status !== 'accepted')
          throw new UserError('Accept a task before marking it complete.');
        if (input.status === 'accepted' && !group(ctx, input.groupId).members.includes(ctx.member.id))
          throw new UserError('Enroll before accepting this task.');
        if (assignment.status === 'completed' && input.status !== 'completed')
          throw new UserError('A completed task cannot be reopened by a response.');
        assignment.status = input.status;
        assignment.updatedAt = Date.now();
        ctx.store.set('engagement.assignments', assignmentKey, assignment);
        return assignment;
      });
    },
  });
  registry.register({
    ...base,
    id: 'group.assignment.remove',
    risk: 'write',
    description: 'A current roster manager removes one local assignment.',
    schema: z.strictObject({ groupId: id, id }),
    execute: async (ctx, input) => {
      await groupAccess(ctx, group(ctx, input.groupId), true);
      return {
        removed: ctx.store.delete('engagement.assignments', `${ctx.guild.id}:${input.groupId}:${input.id}`),
      };
    },
  });
  registry.register({
    ...base,
    id: 'group.erase.mine',
    risk: 'destructive',
    description:
      'Erase your own roster seats, waitlist entries and assignments in this server; no role or DM changes.',
    schema: z.strictObject({}),
    execute: (ctx) =>
      ctx.store.transaction(() => {
        let rosters = 0,
          assignments = 0;
        for (const row of ctx.store.list<Group>('engagement.groups', `${ctx.guild.id}:`))
          if (removeEnrollment(row.value, ctx.member.id)) {
            ctx.store.set('engagement.groups', row.key, row.value);
            rosters++;
          }
        for (const row of ctx.store.list<Assignment>('engagement.assignments', `${ctx.guild.id}:`))
          if (row.value.userId === ctx.member.id && ctx.store.delete('engagement.assignments', row.key))
            assignments++;
        return { rostersRemovedFrom: rosters, assignmentsDeleted: assignments };
      }),
  });
  registry.register({
    ...base,
    id: 'engagement.questions.set',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    description:
      'Configure rotating daily UTC question posts with a durable queue and current author/channel permission checks.',
    schema: z.strictObject({
      id,
      channelId: snowflake,
      questions: z.array(z.string().min(1).max(1000)).min(1).max(100),
      hourUtc: z.number().int().min(0).max(23).default(9),
      minuteUtc: z.number().int().min(0).max(59).default(0),
    }),
    execute: async (ctx, input) => {
      await sendable(ctx, input.channelId);
      enabled(ctx);
      const row: Questions = {
        ...input,
        kind: 'questions',
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        version: token(),
        enabled: true,
        cursor: 0,
        nextAt: nextReportAt(
          { cadence: 'daily', hourUtc: input.hourUtc, minuteUtc: input.minuteUtc },
          Date.now(),
        ),
      };
      addPolicy(ctx, row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'engagement.milestone.set',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    description:
      'Configure once-only future observed member-count threshold announcements. Initial count is a silent baseline.',
    schema: z.strictObject({
      id,
      channelId: snowflake,
      thresholds: z
        .array(z.number().int().min(2).max(10000000))
        .min(1)
        .max(25)
        .refine((values) => new Set(values).size === values.length, 'Use unique thresholds.'),
      template: z.string().min(1).max(1500).default('{server} reached {count} members!'),
    }),
    execute: async (ctx, input) => {
      await sendable(ctx, input.channelId);
      enabled(ctx);
      const count = ctx.guild.memberCount;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new UserError('A current observed member count is unavailable.');
      const row: Milestone = {
        ...input,
        thresholds: [...input.thresholds].sort((a, b) => a - b),
        kind: 'milestone',
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        version: token(),
        enabled: true,
        baseline: count,
        queued: [],
        announced: [],
      };
      addPolicy(ctx, row);
      ctx.store.set('engagement.memberCounts', ctx.guild.id, { count, at: Date.now(), name: ctx.guild.name });
      return row;
    },
  });
  for (const kind of ['questions', 'milestone'] as const) {
    registry.register({
      ...base,
      id: `engagement.${kind}.list`,
      risk: 'read',
      userPermissions: [P.ManageGuild],
      description: `Inspect configured ${kind} policies and their durable pending/failed delivery state.`,
      schema: z.strictObject({}),
      execute: (ctx) => ({
        policies: ctx.store.list<Policy>(policyNamespace, `${ctx.guild.id}:${kind}:`).map((row) => row.value),
        jobs: ctx.store
          .list<Delivery>(deliveryNamespace, `${ctx.guild.id}:`)
          .map((row) => row.value)
          .filter((row) => row.kind === kind)
          .map(({ content, ...metadata }) => metadata),
      }),
    });
    registry.register({
      ...base,
      id: `engagement.${kind}.remove`,
      risk: 'write',
      userPermissions: [P.ManageGuild],
      description: `Cancel a ${kind} policy and its queued announcements.`,
      schema: z.strictObject({ id }),
      execute: (ctx, input) =>
        ctx.store.transaction(() => {
          const removed = ctx.store.delete(policyNamespace, policyKey(ctx.guild.id, kind, input.id));
          let jobs = 0;
          for (const row of ctx.store.list<Delivery>(deliveryNamespace, `${ctx.guild.id}:`))
            if (
              row.value.kind === kind &&
              row.value.policyId === input.id &&
              ctx.store.delete(deliveryNamespace, row.key)
            )
              jobs++;
          return { removed, jobsCancelled: jobs };
        }),
    });
  }
}

/** Gateway callback only saves observed metadata; all network notifications happen in the durable sweeper. */
export function observeEngagementMemberCount(
  guild: Pick<Guild, 'id' | 'memberCount' | 'name'>,
  store: Store,
  now = Date.now(),
): void {
  if (!Number.isSafeInteger(guild.memberCount) || guild.memberCount < 0 || paused(store, guild.id)) return;
  if (!store.list<Milestone>(policyNamespace, `${guild.id}:milestone:`).some((row) => row.value.enabled))
    return;
  store.set('engagement.memberCounts', guild.id, { count: guild.memberCount, at: now, name: guild.name });
}
function queuePosts(store: Store, now: number, allowed: (guildId: string) => boolean): void {
  for (const { key: policyId, value: policy } of store.list<Policy>(policyNamespace)) {
    if (!policy.enabled || paused(store, policy.guildId) || !allowed(policy.guildId)) continue;
    const pendingCount = store
      .list<Delivery>(deliveryNamespace, `${policy.guildId}:`)
      .filter((row) => row.value.status === 'pending').length;
    if (pendingCount >= 100) continue;
    if (policy.kind === 'questions') {
      if (policy.nextAt > now) continue;
      const jobId = hash(`${policyId}:${policy.version}:${policy.nextAt}`),
        jobKey = key(policy.guildId, jobId);
      if (!store.get(deliveryNamespace, jobKey)) {
        const row: Delivery = {
          id: jobId,
          guildId: policy.guildId,
          kind: policy.kind,
          policyId: policy.id,
          version: policy.version,
          content: `Question of the day\n${policy.questions[policy.cursor % policy.questions.length]}`,
          dueAt: policy.nextAt,
          retryAt: now,
          attempts: 0,
          status: 'pending',
          updatedAt: now,
        };
        store.transaction(() => {
          store.set(deliveryNamespace, jobKey, row);
          policy.cursor++;
          policy.nextAt = nextReportAt(
            { cadence: 'daily', hourUtc: policy.hourUtc, minuteUtc: policy.minuteUtc },
            now,
          );
          store.set(policyNamespace, policyId, policy);
        });
      }
    } else {
      const observed = store.get<{ count: number; at: number; name: string }>(
        'engagement.memberCounts',
        policy.guildId,
      );
      if (!observed || now - observed.at > DAY) continue;
      let queued = 0;
      for (const threshold of policy.thresholds) {
        if (
          threshold <= policy.baseline ||
          threshold > observed.count ||
          policy.queued.includes(threshold) ||
          policy.announced.includes(threshold) ||
          pendingCount + queued >= 100
        )
          continue;
        const jobId = hash(`${policyId}:${policy.version}:${threshold}`);
        const row: Delivery = {
          id: jobId,
          guildId: policy.guildId,
          kind: policy.kind,
          policyId: policy.id,
          version: policy.version,
          threshold,
          content: policy.template
            .replaceAll('{count}', String(threshold))
            .replaceAll('{server}', observed.name)
            .slice(0, 1900),
          dueAt: now,
          retryAt: now,
          attempts: 0,
          status: 'pending',
          updatedAt: now,
        };
        store.transaction(() => {
          store.set(deliveryNamespace, key(policy.guildId, jobId), row);
          policy.queued.push(threshold);
          store.set(policyNamespace, policyId, policy);
        });
        queued++;
      }
    }
  }
}
const sweeping = new WeakSet<Store>();
export async function sweepEngagementTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const stopAt = Date.now() + 20000;
  const allowed = (guildId: string) => !allowedGuildIds.length || allowedGuildIds.includes(guildId);
  try {
    queuePosts(store, now, allowed);
    for (const { key: jobKey, value: job } of store
      .list<Delivery>(deliveryNamespace)
      .filter(
        (row) =>
          row.value.status === 'pending' &&
          row.value.retryAt <= now &&
          allowed(row.value.guildId) &&
          !paused(store, row.value.guildId),
      )
      .sort(
        (a, b) =>
          a.value.retryAt - b.value.retryAt ||
          a.value.dueAt - b.value.dueAt ||
          (a.value.threshold ?? 0) - (b.value.threshold ?? 0),
      )
      .slice(0, 10)) {
      if (Date.now() >= stopAt) break;
      if (!store.get(deliveryNamespace, jobKey)) continue;
      const policy = currentPolicy(store, job);
      if (!policy) {
        job.status = 'failed';
        job.lastError = 'PolicyChanged';
        job.updatedAt = now;
        store.set(deliveryNamespace, jobKey, job);
        continue;
      }
      try {
        const guild = await client.guilds.fetch(job.guildId);
        const ctx = await freshContext({
          client,
          store,
          guild,
          member: { id: policy.authorId } as ActionContext['member'],
          channelId: policy.originChannelId,
        });
        if (ctx.member.guild.id !== guild.id)
          throw new UserError('Post policy author no longer belongs to the server.');
        await resolveChannel(ctx, policy.originChannelId);
        const channel = await sendable(ctx, policy.channelId);
        checkPolicyAuthority(ctx, policy);
        if (!currentPolicy(store, job) || paused(store, job.guildId) || !store.get(deliveryNamespace, jobKey))
          continue;
        await channel.send({
          content: job.content,
          allowedMentions: { parse: [] },
          nonce: job.id,
          enforceNonce: true,
        });
        if (!store.get(deliveryNamespace, jobKey) || !currentPolicy(store, job)) continue;
        job.status = 'done';
        job.updatedAt = now;
        delete job.lastError;
        store.set(deliveryNamespace, jobKey, job);
        const latest = currentPolicy(store, job);
        if (
          latest?.kind === 'milestone' &&
          job.threshold !== undefined &&
          !latest.announced.includes(job.threshold)
        ) {
          latest.announced.push(job.threshold);
          store.set(policyNamespace, policyKey(job.guildId, job.kind, job.policyId), latest);
        }
      } catch (error) {
        const latest = currentPolicy(store, job);
        if (!latest || !store.get(deliveryNamespace, jobKey)) continue;
        job.attempts++;
        job.lastError = error instanceof Error ? error.name : 'Error';
        job.updatedAt = now;
        const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
        if (
          error instanceof UserError ||
          [10003, 10004, 10007, 50001, 50013].includes(code) ||
          job.attempts >= 3
        ) {
          job.status = 'failed';
          latest.enabled = false;
          latest.lastError = job.lastError;
          store.set(policyNamespace, policyKey(job.guildId, job.kind, job.policyId), latest);
        } else job.retryAt = now + 30000 * 2 ** (job.attempts - 1);
        store.set(deliveryNamespace, jobKey, job);
      }
    }
    for (const row of store.list<Delivery>(deliveryNamespace))
      if (row.value.status !== 'pending' && row.value.updatedAt < now - 7 * DAY)
        store.delete(deliveryNamespace, row.key);
  } finally {
    sweeping.delete(store);
  }
}
