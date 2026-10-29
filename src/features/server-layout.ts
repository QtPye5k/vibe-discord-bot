import { randomBytes } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  OverwriteType,
  type GuildEditOptions,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { UserError } from '../core/errors.js';
import { freshContext, resolveChannel, resolveRole, assertRoleHierarchy } from '../core/permissions.js';

const id = z.string().regex(/^\d{17,20}$/),
  ref = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
  slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const bits = z
  .string()
  .regex(/^\d{1,30}$/)
  .refine((value) => (BigInt(value) & ~PermissionsBitField.All) === 0n, 'Unknown permission flags');
const required = [P.ManageGuild, P.ManageRoles, P.ManageChannels];
const channelTypes = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
} as const;
const typeNames = new Map<number, keyof typeof channelTypes>(
  Object.entries(channelTypes).map(([name, value]) => [value, name as keyof typeof channelTypes]),
);
export const layoutRoleSchema = z.strictObject({
  key: ref.refine((value) => value !== 'everyone', 'everyone is reserved for the server default role'),
  name: z.string().min(1).max(100),
  existingId: id.optional(),
  permissions: bits.default('0'),
  color: z.number().int().min(0).max(0xffffff).default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
  position: z.number().int().min(1).max(249).optional(),
});
const overwriteSchema = z
  .strictObject({
    roleRef: ref.optional(),
    roleId: id.optional(),
    memberId: id.optional(),
    allow: bits.default('0'),
    deny: bits.default('0'),
  })
  .refine(
    (value) => [value.roleRef, value.roleId, value.memberId].filter(Boolean).length === 1,
    'Choose exactly one overwrite target',
  )
  .refine((value) => (BigInt(value.allow) & BigInt(value.deny)) === 0n, 'Allow and deny cannot overlap');
export const layoutChannelSchema = z.strictObject({
  key: ref,
  name: z.string().min(1).max(100),
  type: z.enum(['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media']),
  existingId: id.optional(),
  parentRef: ref.nullable().default(null),
  topic: z.string().max(4096).nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmode: z.number().int().min(0).max(21600).optional(),
  bitrate: z.number().int().min(8000).max(384000).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  position: z.number().int().min(0).max(499).optional(),
  overwrites: z.array(overwriteSchema).max(100).default([]),
});
const guildSettingsSchema = z.strictObject({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(120).nullable().optional(),
  verificationLevel: z.number().int().min(0).max(4).optional(),
  defaultMessageNotifications: z.number().int().min(0).max(1).optional(),
  explicitContentFilter: z.number().int().min(0).max(2).optional(),
  afkTimeout: z
    .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
    .optional(),
  systemChannelFlags: z.number().int().min(0).max(65535).optional(),
  afkChannelRef: ref.nullable().optional(),
  systemChannelRef: ref.nullable().optional(),
  rulesChannelRef: ref.nullable().optional(),
  publicUpdatesChannelRef: ref.nullable().optional(),
});
export const layoutDefinitionSchema = z
  .strictObject({
    roles: z.array(layoutRoleSchema).max(100).default([]),
    channels: z.array(layoutChannelSchema).max(100).default([]),
    settings: guildSettingsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const roles = new Set(value.roles.map((role) => role.key)),
      channels = new Map(value.channels.map((channel) => [channel.key, channel]));
    if (roles.size !== value.roles.length || channels.size !== value.channels.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Role/channel reference keys must be unique within their resource type.',
      });
    for (const resources of [value.roles, value.channels]) {
      const existing = resources.flatMap((resource) => (resource.existingId ? [resource.existingId] : []));
      if (new Set(existing).size !== existing.length)
        ctx.addIssue({ code: 'custom', message: 'Each existing resource ID can appear only once.' });
    }
    for (const channel of value.channels) {
      if (!['forum', 'media'].includes(channel.type) && (channel.topic?.length ?? 0) > 1024)
        ctx.addIssue({ code: 'custom', message: 'This channel type limits topics to 1024 characters.' });
      if (channel.parentRef && channels.get(channel.parentRef)?.type !== 'category')
        ctx.addIssue({
          code: 'custom',
          message: `Parent reference ${channel.parentRef} must name a category.`,
        });
      if (channel.type === 'category' && channel.parentRef)
        ctx.addIssue({ code: 'custom', message: 'Categories cannot have parents.' });
      for (const overwrite of channel.overwrites)
        if (overwrite.roleRef && overwrite.roleRef !== 'everyone' && !roles.has(overwrite.roleRef))
          ctx.addIssue({ code: 'custom', message: `Unknown role reference ${overwrite.roleRef}.` });
    }
    for (const field of [
      'afkChannelRef',
      'systemChannelRef',
      'rulesChannelRef',
      'publicUpdatesChannelRef',
    ] as const) {
      const reference = value.settings?.[field];
      if (reference && !channels.has(reference))
        ctx.addIssue({ code: 'custom', message: `Unknown channel reference ${reference}.` });
      if (
        reference &&
        field === 'afkChannelRef' &&
        channels.has(reference) &&
        channels.get(reference)!.type !== 'voice'
      )
        ctx.addIssue({ code: 'custom', message: 'AFK channel reference must be a voice channel.' });
    }
  });
type Layout = z.infer<typeof layoutDefinitionSchema>;
type RoleDefinition = z.infer<typeof layoutRoleSchema>;
type ChannelDefinition = z.infer<typeof layoutChannelSchema>;
export const layoutOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('role'), mode: z.enum(['create', 'edit']), definition: layoutRoleSchema }),
  z.strictObject({
    kind: z.literal('channel'),
    mode: z.enum(['create', 'edit']),
    definition: layoutChannelSchema,
  }),
  z.strictObject({ kind: z.literal('settings'), settings: guildSettingsSchema }),
]);
type Operation = z.infer<typeof layoutOperationSchema>;
interface Mapping {
  roles: Record<string, string>;
  channels: Record<string, string>;
}
interface Snapshot {
  id: string;
  guildId: string;
  capturedAt: number;
  createdBy: string;
  layout: Layout;
  omissions: string[];
}
interface Plan {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  operations: Operation[];
  mapping: Mapping;
  cursor: number;
  state: 'ready' | 'applying' | 'needs-review' | 'done' | 'aborted';
  inFlight?: number;
  lastError?: string;
  completed: { index: number; kind: Operation['kind']; resourceId?: string }[];
}
const activePlans = new WeakMap<ActionContext['store'], Set<string>>();
const token = () => randomBytes(8).toString('hex'),
  key = (guildId: string, value: string) => `${guildId}:${value}`;
export function canonicalLayout(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLayout).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((name) => (value as Record<string, unknown>)[name] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalLayout((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function authority(ctx: ActionContext): Promise<ActionContext> {
  const current = await freshContext(ctx);
  if (!current.member.permissions.has(required) || !current.guild.members.me?.permissions.has(required))
    throw new UserError(
      'You and the bot need Manage Server, Manage Roles and Manage Channels at the server level for layout operations.',
    );
  await resolveChannel(current, current.channelId);
  return current;
}
function enabled(ctx: ActionContext): void {
  if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('layouts'))
    throw new UserError('layouts is disabled in this server.');
}
async function existingChannel(ctx: ActionContext, channelId: string) {
  try {
    return await ctx.guild.channels.fetch(channelId, { force: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10003) return null;
    throw error;
  }
}
async function snapshotAccess(ctx: ActionContext, snapshot: Snapshot): Promise<void> {
  for (const channel of snapshot.layout.channels) {
    if (!channel.existingId) continue;
    const existing = await existingChannel(ctx, channel.existingId);
    if (existing) await resolveChannel(ctx, existing.id);
  }
}
function grantable(ctx: ActionContext, value: string): void {
  const permission = BigInt(bits.parse(value));
  if (!ctx.member.permissions.has(permission) || !ctx.guild.members.me?.permissions.has(permission))
    throw new UserError('Layout grants cannot exceed permissions currently held by you and the bot.');
}
function positionAllowed(ctx: ActionContext, position: number | undefined): void {
  if (
    position !== undefined &&
    (position >= ctx.guild.members.me!.roles.highest.position ||
      (ctx.member.id !== ctx.guild.ownerId && position >= ctx.member.roles.highest.position))
  )
    throw new UserError('Role positions must remain below both the bot and the requesting administrator.');
}
async function checkedChannel(ctx: ActionContext, channelId: string) {
  const channel = await resolveChannel(ctx, channelId);
  if (
    channel.isThread() ||
    !channel.permissionsFor(ctx.member)?.has([P.ManageChannels, P.ManageRoles]) ||
    !channel.permissionsFor(ctx.guild.members.me!)?.has([P.ManageChannels, P.ManageRoles])
  )
    throw new UserError(
      'You and the bot need channel access, Manage Channels and Manage Roles for each affected channel.',
    );
  return channel;
}
async function checkedOverwriteRole(ctx: ActionContext, roleId: string): Promise<void> {
  if (roleId === ctx.guild.id) return;
  const role = await resolveRole(ctx, roleId);
  if (
    ctx.guild.members.me!.roles.highest.comparePositionTo(role) <= 0 ||
    (ctx.member.id !== ctx.guild.ownerId && ctx.member.roles.highest.comparePositionTo(role) <= 0)
  )
    throw new UserError('Overwrite roles must be below the bot and requesting administrator.');
}
async function overwrites(ctx: ActionContext, definition: ChannelDefinition, mapping: Mapping) {
  const result = [];
  const seen = new Set<string>();
  for (const overwrite of definition.overwrites) {
    grantable(ctx, overwrite.allow);
    grantable(ctx, overwrite.deny);
    const roleId = overwrite.roleRef
      ? overwrite.roleRef === 'everyone'
        ? ctx.guild.id
        : mapping.roles[overwrite.roleRef]
      : overwrite.roleId;
    const target = roleId ?? overwrite.memberId;
    if (!target) throw new UserError('A required role mapping has not been created yet.');
    if (seen.has(target)) throw new UserError('A channel may not contain duplicate overwrite targets.');
    seen.add(target);
    if (roleId) await checkedOverwriteRole(ctx, roleId);
    else {
      const member = await ctx.guild.members.fetch({ user: target, force: true });
      if (member.guild.id !== ctx.guild.id)
        throw new UserError('Overwrite member does not belong to this server.');
    }
    result.push({
      id: target,
      type: roleId ? OverwriteType.Role : OverwriteType.Member,
      allow: BigInt(overwrite.allow),
      deny: BigInt(overwrite.deny),
    });
  }
  return result;
}
function nextBatch(plan: Plan) {
  return plan.state === 'ready'
    ? { planId: plan.id, operations: plan.operations.slice(plan.cursor, plan.cursor + 10) }
    : null;
}
function summary(plan: Plan) {
  return {
    id: plan.id,
    label: plan.label,
    state: plan.state,
    completed: plan.cursor,
    total: plan.operations.length,
    remaining: plan.operations.length - plan.cursor,
    expiresAt: new Date(plan.expiresAt).toISOString(),
    lastError: plan.lastError ?? null,
    inFlight: plan.inFlight ?? null,
    mapping: plan.mapping,
    nextBatch: nextBatch(plan),
    warning:
      'Each confirmed batch is incremental, not atomic. Completed changes are not automatically rolled back.',
  };
}
function ownPlan(ctx: ActionContext, planId: string, allowExpired = false): Plan {
  const plan = ctx.store.get<Plan>('layout.plans', key(ctx.guild.id, planId));
  if (!plan || plan.userId !== ctx.member.id || plan.channelId !== ctx.channelId)
    throw new UserError('This layout plan belongs to another person, server or channel.');
  if (!allowExpired && plan.expiresAt < Date.now())
    throw new UserError('Layout plan expired. Preserve its mapping and create a fresh plan.');
  return plan;
}

export async function captureLayout(ctx: ActionContext, snapshotId: string): Promise<Snapshot> {
  const current = await authority(ctx);
  const [guild, roles, channels] = await Promise.all([
    current.guild.fetch(),
    current.guild.roles.fetch(),
    current.guild.channels.fetch(),
  ]);
  const readable = [...channels.values()].filter(
    (channel): channel is NonNullable<typeof channel> =>
      !!channel &&
      !channel.isThread() &&
      !!channel.permissionsFor(current.member)?.has(P.ViewChannel) &&
      !!channel.permissionsFor(current.guild.members.me!)?.has(P.ViewChannel) &&
      typeNames.has(channel.type),
  );
  const manageable = [...roles.values()].filter((role) => role.id !== guild.id && !role.managed);
  if (manageable.length > 100 || readable.length > 100)
    throw new UserError(
      'A layout snapshot is limited to 100 ordinary roles and 100 accessible channels. Use a scoped declarative layout for larger servers.',
    );
  const roleKeys = new Map(manageable.map((role) => [role.id, `r_${role.id}`]));
  const channelKeys = new Map(readable.map((channel) => [channel.id, `c_${channel.id}`]));
  const layout = layoutDefinitionSchema.parse({
    roles: manageable
      .sort((a, b) => a.position - b.position)
      .map((role) => ({
        key: roleKeys.get(role.id),
        existingId: role.id,
        name: role.name,
        permissions: role.permissions.bitfield.toString(),
        color: role.colors.primaryColor,
        hoist: role.hoist,
        mentionable: role.mentionable,
        position: role.position || 1,
      })),
    channels: readable
      .sort((a, b) => a.position - b.position)
      .map((channel) => ({
        key: channelKeys.get(channel.id),
        existingId: channel.id,
        name: channel.name,
        type: typeNames.get(channel.type),
        parentRef: channel.parentId ? (channelKeys.get(channel.parentId) ?? null) : null,
        position: channel.position,
        ...('topic' in channel ? { topic: channel.topic } : {}),
        ...('nsfw' in channel ? { nsfw: channel.nsfw } : {}),
        ...('rateLimitPerUser' in channel ? { slowmode: channel.rateLimitPerUser } : {}),
        ...('bitrate' in channel ? { bitrate: channel.bitrate } : {}),
        ...('userLimit' in channel ? { userLimit: channel.userLimit } : {}),
        overwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
          ...(overwrite.type === OverwriteType.Member
            ? { memberId: overwrite.id }
            : overwrite.id === guild.id
              ? { roleRef: 'everyone' }
              : roleKeys.has(overwrite.id)
                ? { roleRef: roleKeys.get(overwrite.id) }
                : { roleId: overwrite.id }),
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString(),
        })),
      })),
    settings: {
      name: guild.name,
      description: guild.description,
      verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter,
      afkTimeout: guild.afkTimeout,
      systemChannelFlags: guild.systemChannelFlags.bitfield,
      ...(guild.afkChannelId === null
        ? { afkChannelRef: null }
        : guild.afkChannelId && channelKeys.has(guild.afkChannelId)
          ? { afkChannelRef: channelKeys.get(guild.afkChannelId) }
          : {}),
      ...(guild.systemChannelId === null
        ? { systemChannelRef: null }
        : guild.systemChannelId && channelKeys.has(guild.systemChannelId)
          ? { systemChannelRef: channelKeys.get(guild.systemChannelId) }
          : {}),
      ...(guild.rulesChannelId === null
        ? { rulesChannelRef: null }
        : guild.rulesChannelId && channelKeys.has(guild.rulesChannelId)
          ? { rulesChannelRef: channelKeys.get(guild.rulesChannelId) }
          : {}),
      ...(guild.publicUpdatesChannelId === null
        ? { publicUpdatesChannelRef: null }
        : guild.publicUpdatesChannelId && channelKeys.has(guild.publicUpdatesChannelId)
          ? { publicUpdatesChannelRef: channelKeys.get(guild.publicUpdatesChannelId) }
          : {}),
    },
  });
  return {
    id: snapshotId,
    guildId: guild.id,
    capturedAt: Date.now(),
    createdBy: current.member.id,
    layout,
    omissions: [
      'Only accessible supported non-thread channels are included.',
      'Messages, files, member assignments, managed roles, everyone base permissions, expressions, integrations, entitlements, invites and original resource IDs are not restorable.',
      'Role icons/enhanced colors, forum tags and server image assets are outside this snapshot format.',
    ],
  };
}
export function diffLayouts(
  before: unknown,
  after: unknown,
  path = '',
): { path: string; before: unknown; after: unknown }[] {
  if (canonicalLayout(before) === canonicalLayout(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((name) => diffLayouts(a[name], b[name], path ? `${path}.${name}` : name));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}
async function preparePlan(ctx: ActionContext, layout: Layout, label: string): Promise<Plan> {
  const current = await authority(ctx);
  const mapping: Mapping = { roles: {}, channels: {} };
  const operations: Operation[] = [];
  // Resolve exact existing IDs once. A deleted resource is recreated rather than matched to an unrelated duplicate name.
  for (const role of layout.roles) {
    grantable(current, role.permissions);
    positionAllowed(current, role.position);
    const existing = role.existingId
      ? await current.guild.roles.fetch(role.existingId, { force: true })
      : null;
    if (existing) {
      assertRoleHierarchy(current, existing);
      mapping.roles[role.key] = existing.id;
      operations.push({ kind: 'role', mode: 'edit', definition: role });
    } else {
      const { existingId: _old, ...definition } = role;
      operations.push({ kind: 'role', mode: 'create', definition });
    }
  }
  const ordered = [
    ...layout.channels.filter((channel) => channel.type === 'category'),
    ...layout.channels.filter((channel) => channel.type !== 'category'),
  ];
  for (const channel of ordered) {
    for (const overwrite of channel.overwrites) {
      grantable(current, overwrite.allow);
      grantable(current, overwrite.deny);
      if (overwrite.roleId) await checkedOverwriteRole(current, overwrite.roleId);
      if (overwrite.memberId) {
        const member = await current.guild.members.fetch({ user: overwrite.memberId, force: true });
        if (member.guild.id !== ctx.guild.id)
          throw new UserError('Overwrite member belongs to another server.');
      }
    }
    const existing = channel.existingId ? await existingChannel(current, channel.existingId) : null;
    if (existing) {
      await checkedChannel(current, existing.id);
      if (existing.type !== channelTypes[channel.type])
        throw new UserError('A restore target channel changed type. Use a new declarative channel instead.');
      mapping.channels[channel.key] = existing.id;
      operations.push({ kind: 'channel', mode: 'edit', definition: channel });
    } else {
      const { existingId: _old, ...definition } = channel;
      operations.push({ kind: 'channel', mode: 'create', definition });
    }
  }
  if (layout.settings && Object.keys(layout.settings).length)
    operations.push({ kind: 'settings', settings: layout.settings });
  if (operations.length > 201) throw new UserError('Layout plans are limited to 201 operations.');
  const plans = current.store.list<Plan>('layout.plans', `${current.guild.id}:`);
  for (const row of plans)
    if (['done', 'aborted'].includes(row.value.state) && Date.now() - row.value.createdAt > 7 * 86400000)
      current.store.delete('layout.plans', row.key);
  if (plans.filter((row) => !['done', 'aborted'].includes(row.value.state)).length >= 20)
    throw new UserError('Maximum 20 active layout plans per server. Complete or abort old plans first.');
  const plan: Plan = {
    id: token(),
    guildId: current.guild.id,
    userId: current.member.id,
    channelId: current.channelId,
    label,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    operations,
    mapping,
    cursor: 0,
    state: operations.length ? 'ready' : 'done',
    completed: [],
  };
  current.store.set('layout.plans', key(current.guild.id, plan.id), plan);
  return plan;
}
function roleData(definition: RoleDefinition) {
  return {
    name: definition.name,
    permissions: BigInt(definition.permissions),
    color: definition.color,
    hoist: definition.hoist,
    mentionable: definition.mentionable,
    position: definition.position,
  };
}
async function channelData(ctx: ActionContext, definition: ChannelDefinition, mapping: Mapping) {
  const parent = definition.parentRef ? mapping.channels[definition.parentRef] : null;
  if (definition.parentRef && !parent) throw new UserError('Parent category mapping is not available yet.');
  if (parent) {
    const channel = await checkedChannel(ctx, parent);
    if (channel.type !== ChannelType.GuildCategory) throw new UserError('Mapped parent is not a category.');
  }
  return {
    name: definition.name,
    parent,
    position: definition.position,
    topic: definition.topic,
    nsfw: definition.nsfw,
    rateLimitPerUser: definition.slowmode,
    bitrate: definition.bitrate,
    userLimit: definition.userLimit,
    permissionOverwrites: await overwrites(ctx, definition, mapping),
  };
}
async function executeOperation(
  ctx: ActionContext,
  operation: Operation,
  mapping: Mapping,
): Promise<string | undefined> {
  const reason = `Layout batch requested by ${ctx.member.id}`;
  if (operation.kind === 'role') {
    const definition = operation.definition;
    grantable(ctx, definition.permissions);
    positionAllowed(ctx, definition.position);
    if (operation.mode === 'create') {
      const role = await ctx.guild.roles.create({ ...roleData(definition), reason });
      mapping.roles[definition.key] = role.id;
      return role.id;
    }
    const target = await resolveRole(ctx, definition.existingId!);
    assertRoleHierarchy(ctx, target);
    await target.edit({ ...roleData(definition), reason });
    mapping.roles[definition.key] = target.id;
    return target.id;
  }
  if (operation.kind === 'channel') {
    const definition = operation.definition;
    const data = await channelData(ctx, definition, mapping);
    if (operation.mode === 'create') {
      const channel = await ctx.guild.channels.create({
        ...data,
        topic: data.topic ?? undefined,
        type: channelTypes[definition.type],
        reason,
      });
      mapping.channels[definition.key] = channel.id;
      return channel.id;
    }
    const channel = await checkedChannel(ctx, definition.existingId!);
    if (channel.type !== channelTypes[definition.type])
      throw new UserError('Target channel type no longer matches the plan.');
    await ctx.guild.channels.edit(channel.id, { ...data, reason });
    mapping.channels[definition.key] = channel.id;
    return channel.id;
  }
  const { afkChannelRef, systemChannelRef, rulesChannelRef, publicUpdatesChannelRef, ...settings } =
    operation.settings;
  const options: GuildEditOptions = { ...settings, reason };
  for (const [reference, field] of [
    [afkChannelRef, 'afkChannel'],
    [systemChannelRef, 'systemChannel'],
    [rulesChannelRef, 'rulesChannel'],
    [publicUpdatesChannelRef, 'publicUpdatesChannel'],
  ] as const) {
    if (reference === undefined) continue;
    if (reference === null) {
      options[field] = null;
      continue;
    }
    const target = mapping.channels[reference];
    if (!target) throw new UserError('Server setting references an unavailable channel mapping.');
    await checkedChannel(ctx, target);
    options[field] = target;
  }
  await ctx.guild.edit(options);
  return undefined;
}
export async function applyLayoutBatch(
  ctx: ActionContext,
  planId: string,
  rawOperations: unknown,
): Promise<unknown> {
  enabled(ctx);
  const operations = z.array(layoutOperationSchema).min(1).max(10).parse(rawOperations);
  const plan = ownPlan(ctx, planId);
  if (plan.state !== 'ready')
    throw new UserError('Plan is not ready. Reconcile an interrupted operation or abort before continuing.');
  if (canonicalLayout(operations) !== canonicalLayout(plan.operations.slice(plan.cursor, plan.cursor + 10)))
    throw new UserError(
      'Batch differs from the saved immutable plan. Copy nextBatch exactly from layout.status.',
    );
  const planKey = key(ctx.guild.id, plan.id);
  // Synchronous claim before authorization I/O prevents two confirmations running the same batch.
  ctx.store.transaction(() => {
    const latest = ownPlan(ctx, planId);
    if (latest.state !== 'ready' || latest.cursor !== plan.cursor)
      throw new UserError('This batch has already been claimed.');
    latest.state = 'applying';
    latest.inFlight = latest.cursor;
    ctx.store.set('layout.plans', planKey, latest);
  });
  let active = activePlans.get(ctx.store);
  if (!active) {
    active = new Set();
    activePlans.set(ctx.store, active);
  }
  active.add(plan.id);
  try {
    for (const operation of operations) {
      const index = plan.cursor;
      plan.state = 'applying';
      plan.inFlight = index;
      ctx.store.set('layout.plans', planKey, plan);
      try {
        const current = await authority(ctx);
        enabled(current);
        const latest = ownPlan(current, planId);
        if (latest.state !== 'applying' || latest.cursor !== index)
          throw new UserError('Layout plan changed during authorization.');
        const resourceId = await executeOperation(current, operation, plan.mapping);
        plan.completed.push({ index, kind: operation.kind, ...(resourceId ? { resourceId } : {}) });
        plan.cursor++;
        delete plan.inFlight;
        delete plan.lastError;
        ctx.store.set('layout.plans', planKey, plan);
      } catch (error) {
        plan.state = 'needs-review';
        plan.lastError = error instanceof Error ? error.name : 'Error';
        ctx.store.set('layout.plans', planKey, plan);
        return {
          ...summary(plan),
          warning:
            'Stopped without retrying. A failed HTTP response may still have created or changed a resource. Inspect Discord and reconcile this exact operation before resuming.',
        };
      }
    }
    plan.state = plan.cursor >= plan.operations.length ? 'done' : 'ready';
    ctx.store.set('layout.plans', planKey, plan);
    return summary(plan);
  } finally {
    active.delete(plan.id);
  }
}

export function registerServerLayoutActions(registry: ActionRegistry): void {
  const base = { category: 'layouts', userPermissions: required, botPermissions: required };
  registry.register({
    ...base,
    id: 'layout.snapshot.save',
    description:
      'Save a bounded supported server configuration snapshot with roles, accessible channels, overwrites and selected server settings.',
    risk: 'write',
    schema: z.strictObject({ name: slug }),
    execute: async (ctx, input) => {
      const snapshot = await captureLayout(ctx, input.name);
      if (
        !ctx.store.get('layout.snapshots', key(ctx.guild.id, input.name)) &&
        ctx.store.list('layout.snapshots', `${ctx.guild.id}:`).length >= 20
      )
        throw new UserError('Maximum 20 snapshots per server.');
      ctx.store.set('layout.snapshots', key(ctx.guild.id, input.name), snapshot);
      return {
        id: snapshot.id,
        capturedAt: new Date(snapshot.capturedAt).toISOString(),
        roles: snapshot.layout.roles.length,
        channels: snapshot.layout.channels.length,
        omissions: snapshot.omissions,
      };
    },
  });
  registry.register({
    ...base,
    id: 'layout.snapshot.list',
    description: 'List stored server configuration snapshots.',
    risk: 'read',
    schema: z.strictObject({}),
    execute: (ctx) =>
      ctx.store.list<Snapshot>('layout.snapshots', `${ctx.guild.id}:`).map((row) => ({
        id: row.value.id,
        capturedAt: new Date(row.value.capturedAt).toISOString(),
        roles: row.value.layout.roles.length,
        channels: row.value.layout.channels.length,
      })),
  });
  registry.register({
    ...base,
    id: 'layout.snapshot.export',
    description: 'Export a saved supported layout as JSON, without messages or credentials.',
    risk: 'read',
    schema: z.strictObject({ name: slug }),
    execute: async (ctx, input) => {
      const snapshot = ctx.store.get<Snapshot>('layout.snapshots', key(ctx.guild.id, input.name));
      if (!snapshot) throw new UserError('Snapshot not found.');
      await snapshotAccess(ctx, snapshot);
      return {
        attachment: Buffer.from(JSON.stringify(snapshot, null, 2)),
        name: `layout-${input.name}.json`,
      };
    },
  });
  registry.register({
    ...base,
    id: 'layout.snapshot.delete',
    description: 'Delete a saved layout snapshot without changing Discord resources.',
    risk: 'destructive',
    schema: z.strictObject({ name: slug }),
    execute: (ctx, input) => ({
      deleted: ctx.store.delete('layout.snapshots', key(ctx.guild.id, input.name)),
    }),
  });
  registry.register({
    ...base,
    id: 'layout.snapshot.diff',
    description: 'Compare a saved snapshot with the current supported server configuration.',
    risk: 'read',
    schema: z.strictObject({ name: slug }),
    execute: async (ctx, input) => {
      const before = ctx.store.get<Snapshot>('layout.snapshots', key(ctx.guild.id, input.name));
      if (!before) throw new UserError('Snapshot not found.');
      await snapshotAccess(ctx, before);
      const after = await captureLayout(ctx, 'current');
      const differences = diffLayouts(before.layout, after.layout);
      return {
        from: input.name,
        totalDifferences: differences.length,
        differences: differences.slice(0, 1000),
        truncated: differences.length > 1000,
      };
    },
  });
  registry.register({
    ...base,
    id: 'layout.plan',
    description:
      'Prepare an immutable declarative channel/role topology. This creates only a local plan; Discord changes require confirmed batches.',
    risk: 'read',
    schema: z.strictObject({ label: z.string().min(1).max(100), layout: layoutDefinitionSchema }),
    execute: async (ctx, input) => summary(await preparePlan(ctx, input.layout, input.label)),
  });
  registry.register({
    ...base,
    id: 'layout.restore.plan',
    description:
      'Prepare merge/recreate operations for a saved supported snapshot; existing unrelated resources are preserved.',
    risk: 'read',
    schema: z.strictObject({ name: slug }),
    execute: async (ctx, input) => {
      const snapshot = ctx.store.get<Snapshot>('layout.snapshots', key(ctx.guild.id, input.name));
      if (!snapshot) throw new UserError('Snapshot not found.');
      return summary(
        await preparePlan(ctx, layoutDefinitionSchema.parse(snapshot.layout), `Restore ${input.name}`),
      );
    },
  });
  registry.register({
    ...base,
    id: 'layout.status',
    description: 'Read your layout progress, resource mapping and exact next batch payload.',
    risk: 'read',
    schema: z.strictObject({ planId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => summary(ownPlan(ctx, input.planId, true)),
  });
  registry.register({
    ...base,
    id: 'layout.apply',
    description:
      'Apply at most ten exact reviewed layout operations. Each operation rechecks current authorization; ambiguous failures stop for explicit reconciliation.',
    risk: 'destructive',
    schema: z.strictObject({
      planId: z.string().regex(/^[a-f0-9]{16}$/),
      operations: z.array(layoutOperationSchema).min(1).max(10),
    }),
    execute: (ctx, input) => applyLayoutBatch(ctx, input.planId, input.operations),
  });
  registry.register({
    ...base,
    id: 'layout.abort',
    description: 'Stop a layout plan without undoing already completed changes.',
    risk: 'destructive',
    schema: z.strictObject({ planId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const plan = ownPlan(ctx, input.planId, true);
      if (plan.state === 'applying')
        throw new UserError('An operation may be in flight. Wait or reconcile it before aborting.');
      plan.state = 'aborted';
      ctx.store.set('layout.plans', key(ctx.guild.id, plan.id), plan);
      return summary(plan);
    },
  });
  registry.register({
    ...base,
    id: 'layout.reconcile',
    description:
      'After inspecting Discord, mark one interrupted operation applied with its verified ID, or explicitly verify it was not applied before permitting retry.',
    risk: 'destructive',
    schema: z.strictObject({
      planId: z.string().regex(/^[a-f0-9]{16}$/),
      operationIndex: z.number().int().min(0).max(200),
      outcome: z.enum(['applied', 'not-applied']),
      resourceId: id.optional(),
    }),
    execute: async (ctx, input) => {
      const current = await authority(ctx);
      const plan = ownPlan(current, input.planId, true);
      if (activePlans.get(ctx.store)?.has(plan.id))
        throw new UserError('This operation is still active. Wait for it to finish before reconciliation.');
      if (
        !['needs-review', 'applying'].includes(plan.state) ||
        plan.inFlight !== input.operationIndex ||
        plan.cursor !== input.operationIndex
      )
        throw new UserError('No matching interrupted operation is awaiting review.');
      const operation = plan.operations[plan.cursor]!;
      if (input.outcome === 'applied') {
        let resourceId: string | undefined;
        if (operation.kind === 'role') {
          resourceId = input.resourceId ?? operation.definition.existingId;
          if (!resourceId)
            throw new UserError('Provide the actual role ID created by the interrupted operation.');
          const role = await resolveRole(current, resourceId);
          assertRoleHierarchy(current, role);
          if (
            role.name !== operation.definition.name ||
            role.permissions.bitfield.toString() !== operation.definition.permissions
          )
            throw new UserError('Role identity/permissions do not match the interrupted operation.');
          plan.mapping.roles[operation.definition.key] = role.id;
        }
        if (operation.kind === 'channel') {
          resourceId = input.resourceId ?? operation.definition.existingId;
          if (!resourceId)
            throw new UserError('Provide the actual channel ID created by the interrupted operation.');
          const channel = await checkedChannel(current, resourceId);
          if (
            channel.name !== operation.definition.name ||
            channel.type !== channelTypes[operation.definition.type]
          )
            throw new UserError('Channel identity/type does not match the interrupted operation.');
          const expectedParent = operation.definition.parentRef
            ? plan.mapping.channels[operation.definition.parentRef]
            : null;
          if (channel.parentId !== expectedParent)
            throw new UserError('Channel parent does not match the interrupted operation.');
          plan.mapping.channels[operation.definition.key] = channel.id;
        }
        plan.completed.push({
          index: plan.cursor,
          kind: operation.kind,
          ...(resourceId ? { resourceId } : {}),
        });
        plan.cursor++;
      }
      delete plan.inFlight;
      delete plan.lastError;
      plan.state = plan.cursor >= plan.operations.length ? 'done' : 'ready';
      current.store.set('layout.plans', key(current.guild.id, plan.id), plan);
      return summary(plan);
    },
  });
  registry.register({
    ...base,
    id: 'layout.report',
    description:
      'Generate a current server administration configuration report with counts, dangerous role flags and snapshot coverage.',
    risk: 'read',
    schema: z.strictObject({}),
    execute: async (ctx) => {
      const snapshot = await captureLayout(ctx, 'report');
      return {
        guildId: ctx.guild.id,
        capturedAt: new Date(snapshot.capturedAt).toISOString(),
        roles: snapshot.layout.roles.length,
        channels: snapshot.layout.channels.length,
        channelsByType: Object.fromEntries(
          Object.keys(channelTypes).map((type) => [
            type,
            snapshot.layout.channels.filter((channel) => channel.type === type).length,
          ]),
        ),
        privilegedRoles: snapshot.layout.roles
          .filter((role) =>
            new PermissionsBitField(BigInt(role.permissions)).any([
              P.Administrator,
              P.ManageGuild,
              P.ManageRoles,
              P.BanMembers,
            ]),
          )
          .map((role) => ({ name: role.name, permissions: role.permissions })),
        omissions: snapshot.omissions,
      };
    },
  });
  registry.register({
    ...base,
    id: 'layout.template.plan',
    description:
      'Convert a public Discord template into an immutable merge plan for this server; does not create a new server.',
    risk: 'read',
    schema: z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
    execute: async (ctx, input) => {
      const template = await ctx.client.fetchGuildTemplate(input.code);
      const raw = template.serializedGuild as unknown as Record<string, unknown>;
      const sourceRole = z.object({
        id: z.union([z.string(), z.number().int().safe()]),
        name: z.string(),
        permissions: z.union([z.string(), z.number().int().safe()]),
        color: z.number().optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        position: z.number().optional(),
      });
      const sourceChannel = z.object({
        id: z.union([z.string(), z.number().int().safe()]),
        name: z.string(),
        type: z.number(),
        parent_id: z.union([z.string(), z.number().int().safe()]).nullable().optional(),
        position: z.number().optional(),
        topic: z.string().nullable().optional(),
        nsfw: z.boolean().optional(),
        rate_limit_per_user: z.number().optional(),
        bitrate: z.number().optional(),
        user_limit: z.number().optional(),
        permission_overwrites: z
          .array(
            z.object({
              id: z.union([z.string(), z.number().int().safe()]),
              type: z.number().default(0),
              allow: z.union([z.string(), z.number().int().safe()]),
              deny: z.union([z.string(), z.number().int().safe()]),
            }),
          )
          .default([]),
      });
      const roles = z.array(sourceRole).max(101).parse(raw.roles),
        channels = z.array(sourceChannel).max(100).parse(raw.channels);
      if (channels.some((channel) => !typeNames.has(channel.type)))
        throw new UserError('Template contains unsupported channel types.');
      const everyone = roles.find((role) => role.name === '@everyone');
      const layout = layoutDefinitionSchema.parse({
        roles: roles
          .filter((role) => role !== everyone)
          .map((role) => ({
            key: `r_${role.id}`,
            name: role.name,
            permissions: String(role.permissions),
            color: role.color ?? 0,
            hoist: role.hoist ?? false,
            mentionable: role.mentionable ?? false,
            position: role.position,
          })),
        channels: channels.map((channel) => ({
          key: `c_${channel.id}`,
          name: channel.name,
          type: typeNames.get(channel.type),
          parentRef:
            channel.parent_id === null || channel.parent_id === undefined ? null : `c_${channel.parent_id}`,
          position: channel.position,
          topic: channel.topic,
          nsfw: channel.nsfw,
          slowmode: channel.rate_limit_per_user,
          ...(['voice', 'stage'].includes(typeNames.get(channel.type)!)
            ? { bitrate: channel.bitrate, userLimit: channel.user_limit }
            : {}),
          overwrites: channel.permission_overwrites.map((overwrite) => {
            if (overwrite.type !== 0)
              throw new UserError(
                'Template member overwrites cannot be mapped to target-server accounts automatically.',
              );
            return {
              roleRef:
                everyone && String(overwrite.id) === String(everyone.id) ? 'everyone' : `r_${overwrite.id}`,
              allow: String(overwrite.allow),
              deny: String(overwrite.deny),
            };
          }),
        })),
      });
      return {
        ...summary(await preparePlan(ctx, layout, `Template ${template.name}`)),
        templateCode: template.code,
        omissions: [
          'Copies supported role/channel structures only. Everyone base permissions, images, message history, managed resources and template guild identity are not applied.',
        ],
      };
    },
  });
}
