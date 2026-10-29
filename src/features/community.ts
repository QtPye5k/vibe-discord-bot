import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits as P,
  type Client,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type Role,
} from 'discord.js';
import { z } from 'zod';
import { UserError } from '../core/errors.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
import {
  resolveChannel,
  resolveMember,
  resolveRole,
  assertHierarchy,
  assertRoleHierarchy,
  freshContext,
} from '../core/permissions.js';
import type { ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import type { Action, ActionContext } from '../core/types.js';
import { readMessageRange } from './history.js';
import { sendMemberWelcome } from './welcome.js';
import {
  registerCommunityExtraActions,
  sweepCommunityExtra,
  eraseCommunityExtra,
} from './community-extra.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'Expected a Discord ID.');
const label = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(1800);
const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value), 'Reserved item identifier.');
const empty = z.strictObject({});
const NO_MENTIONS = { parse: [] as never[] };
const DAY = 86_400_000;
const MAX_BALANCE = 1_000_000_000_000;

export const communitySettingsSchema = z.strictObject({
  welcomeChannelId: snowflake.nullable().default(null),
  goodbyeChannelId: snowflake.nullable().default(null),
  newcomerRoleId: snowflake.nullable().default(null),
  staffRoleId: snowflake.nullable().default(null),
  ticketCategoryId: snowflake.nullable().default(null),
  moderationLogChannelId: snowflake.nullable().default(null),
  welcomeTemplate: z.string().min(1).max(1500).default('Welcome {user} to {server}!'),
  welcomeStyle: z.enum(['text', 'embed']).default('embed'),
  welcomeTitle: z.string().trim().min(1).max(256).default('Welcome to {server}!'),
  welcomeColor: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default('#8b5cf6'),
  welcomeMention: z.boolean().default(true),
  goodbyeTemplate: z.string().min(1).max(1500).default('{name} left {server}.'),
  xpEnabled: z.boolean().default(false),
  xpCooldownSeconds: z.number().int().min(15).max(3600).default(60),
  xpPerMessage: z.number().int().min(1).max(100).default(15),
  faqEnabled: z.boolean().default(false),
  antiSpamEnabled: z.boolean().default(false),
  antiSpamExemptStaff: z.boolean().default(true),
  mentionLimit: z.number().int().min(3).max(100).default(8),
  messageLimit: z.number().int().min(3).max(30).default(8),
  repeatLimit: z.number().int().min(2).max(10).default(4),
  blockedKeywords: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
  selfRoleIds: z.array(snowflake).max(25).default([]),
});
export type CommunitySettings = z.infer<typeof communitySettingsSchema>;
// Strip field defaults before making an update optional. Zod otherwise applies defaults to missing patch fields.
export const communityPatchSchema = z.strictObject({
  welcomeChannelId: communitySettingsSchema.shape.welcomeChannelId.removeDefault().optional(),
  goodbyeChannelId: communitySettingsSchema.shape.goodbyeChannelId.removeDefault().optional(),
  newcomerRoleId: communitySettingsSchema.shape.newcomerRoleId.removeDefault().optional(),
  staffRoleId: communitySettingsSchema.shape.staffRoleId.removeDefault().optional(),
  ticketCategoryId: communitySettingsSchema.shape.ticketCategoryId.removeDefault().optional(),
  moderationLogChannelId: communitySettingsSchema.shape.moderationLogChannelId.removeDefault().optional(),
  welcomeTemplate: communitySettingsSchema.shape.welcomeTemplate.removeDefault().optional(),
  welcomeStyle: communitySettingsSchema.shape.welcomeStyle.removeDefault().optional(),
  welcomeTitle: communitySettingsSchema.shape.welcomeTitle.removeDefault().optional(),
  welcomeColor: communitySettingsSchema.shape.welcomeColor.removeDefault().optional(),
  welcomeMention: communitySettingsSchema.shape.welcomeMention.removeDefault().optional(),
  goodbyeTemplate: communitySettingsSchema.shape.goodbyeTemplate.removeDefault().optional(),
  xpEnabled: communitySettingsSchema.shape.xpEnabled.removeDefault().optional(),
  xpCooldownSeconds: communitySettingsSchema.shape.xpCooldownSeconds.removeDefault().optional(),
  xpPerMessage: communitySettingsSchema.shape.xpPerMessage.removeDefault().optional(),
  faqEnabled: communitySettingsSchema.shape.faqEnabled.removeDefault().optional(),
  antiSpamEnabled: communitySettingsSchema.shape.antiSpamEnabled.removeDefault().optional(),
  antiSpamExemptStaff: communitySettingsSchema.shape.antiSpamExemptStaff.removeDefault().optional(),
  mentionLimit: communitySettingsSchema.shape.mentionLimit.removeDefault().optional(),
  messageLimit: communitySettingsSchema.shape.messageLimit.removeDefault().optional(),
  repeatLimit: communitySettingsSchema.shape.repeatLimit.removeDefault().optional(),
  blockedKeywords: communitySettingsSchema.shape.blockedKeywords.removeDefault().optional(),
  selfRoleIds: communitySettingsSchema.shape.selfRoleIds.removeDefault().optional(),
});
export interface Profile {
  xp: number;
  balance: number;
  lastDaily: number;
  dailyStreak?: number;
  bestDailyStreak?: number;
  lastDailyReward?: number;
  lastXpAt: number;
  messages: number;
}
interface ShopItem {
  id: string;
  name: string;
  description: string;
  price: number;
}
interface CaseRecord {
  id: string;
  userId: string;
  moderatorId: string;
  reason: string;
  createdAt: number;
  notes: { authorId: string; text: string; createdAt: number }[];
  kind?: string;
  details?: Record<string, unknown>;
  appeal?: {
    text: string;
    createdAt: number;
    status: 'pending' | 'approved' | 'denied';
    reviewerId?: string;
    decision?: string;
  };
}
interface ReportRecord {
  id: string;
  authorId: string;
  targetId: string;
  reason: string;
  createdAt: number;
  status: 'open' | 'closed';
  assigneeId?: string;
  resolution?: string;
}
interface TicketRecord {
  id: string;
  userId: string;
  channelId: string;
  subject: string;
  createdAt: number;
  status: 'opening' | 'open' | 'closed' | 'archived';
  assigneeId?: string;
  closedAt?: number;
  archivedAt?: number;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  tags?: string[];
  categoryId?: string | null;
  feedback?: { score: number; comment: string; createdAt: number };
}
interface TicketReservation {
  reservation: string;
  subject: string;
  createdAt: number;
  channelId?: string;
  state?: 'creating' | 'needs-review' | 'open';
  lastError?: string;
}
const ticketLocks = new WeakMap<Store, Set<string>>();
async function lockedTicket<T>(store: Store, key: string, operation: () => Promise<T>): Promise<T> {
  let locks = ticketLocks.get(store);
  if (!locks) {
    locks = new Set();
    ticketLocks.set(store, locks);
  }
  if (locks.has(key)) throw new UserError('This ticket operation is still active. Wait for it to finish.');
  locks.add(key);
  try {
    return await operation();
  } finally {
    locks.delete(key);
  }
}
function ticketTopic(reservation: TicketReservation, userId: string): string {
  return `Support request ${reservation.reservation} for ${userId}: ${reservation.subject}`;
}
function visibleTicket(ticket: TicketRecord, staff: boolean): TicketRecord {
  if (staff) return ticket;
  const result = { ...ticket };
  delete result.priority;
  delete result.tags;
  return result;
}
function saveRecoveredTicket(
  store: Store,
  guildId: string,
  userId: string,
  reservation: TicketReservation,
  channelId: string,
): TicketRecord {
  return store.transaction(() => {
    const current = store.get<TicketReservation>('community.activeTickets', scoped(guildId, userId));
    if (!current || current.reservation !== reservation.reservation || current.channelId)
      throw new UserError('Ticket reservation changed during reconciliation.');
    const ticket: TicketRecord = {
      id: channelId,
      channelId,
      userId,
      subject: reservation.subject ?? 'Recovered support ticket',
      createdAt: reservation.createdAt,
      status: 'open',
      priority: 'normal',
      tags: [],
    };
    store.set('community.tickets', scoped(guildId, channelId), ticket);
    store.set('community.activeTickets', scoped(guildId, userId), {
      ...reservation,
      channelId,
      state: 'open',
    });
    return ticket;
  });
}
async function ticketAccess(ctx: ActionContext, channelId: string, staffOnly = false) {
  const current = await freshContext(ctx);
  await resolveChannel(current, current.channelId);
  const channel = await resolveChannel(current, channelId);
  const ticket = requireRecord<TicketRecord>(current.store, 'community.tickets', current.guild.id, channelId);
  if (staffOnly ? !isStaff(current) : ticket.userId !== current.member.id && !isStaff(current))
    throw new UserError(
      staffOnly
        ? 'Support staff role or Moderate Members permission required.'
        : 'Only the ticket owner or support staff may access it.',
    );
  if (channel.type !== ChannelType.GuildText) throw new UserError('Ticket channel must be a text channel.');
  return { ctx: current, channel, ticket };
}
interface Giveaway {
  id: string;
  channelId: string;
  prize: string;
  createdBy: string;
  endsAt: number;
  winnerCount: number;
  entrants: string[];
  status: 'open' | 'drawn' | 'cancelled';
  winners?: string[];
  announced?: boolean;
  announcementAttempts?: number;
  announcementRetryAt?: number;
  roleIds?: string[];
  minimumAccountDays?: number;
  minimumMemberDays?: number;
  minimumLevel?: number;
  drawing?: { pool: string[]; winners: string[]; pending?: string; retryAt?: number };
}
function giveawayEligible(
  store: Store,
  guildId: string,
  giveaway: Giveaway,
  member: GuildMember,
  now: number,
): boolean {
  return (
    !member.user.bot &&
    !(giveaway.roleIds ?? []).some((id) => !member.roles.cache.has(id)) &&
    (!(giveaway.minimumAccountDays ?? 0) ||
      Boolean(
        member.user.createdTimestamp &&
        now - member.user.createdTimestamp >= giveaway.minimumAccountDays! * DAY,
      )) &&
    (!(giveaway.minimumMemberDays ?? 0) ||
      Boolean(member.joinedTimestamp && now - member.joinedTimestamp >= giveaway.minimumMemberDays! * DAY)) &&
    levelForXp(getProfile(store, guildId, member.id).xp) >= (giveaway.minimumLevel ?? 0)
  );
}
interface TemporaryRole {
  userId: string;
  roleId: string;
  expiresAt: number;
  attempts: number;
  lastError?: string;
}
interface TriviaSession {
  questionIndex: number;
  createdAt: number;
  attempts: number;
}
const TRIVIA = [
  { question: 'What is the capital of Japan?', answer: 'tokyo' },
  { question: 'Which planet is known as the red planet?', answer: 'mars' },
  { question: 'What is 12 multiplied by 12?', answer: '144' },
  { question: 'What chemical symbol represents gold?', answer: 'au' },
  { question: 'How many sides does a hexagon have?', answer: '6', alternatives: ['six'] },
  { question: 'Which ocean is the largest?', answer: 'pacific', alternatives: ['pacific ocean'] },
  { question: 'Who wrote Pride and Prejudice?', answer: 'jane austen' },
  { question: 'What is the binary representation of decimal 5?', answer: '101' },
];

function add<S extends z.ZodType>(
  registry: ActionRegistry,
  spec: Omit<Action<S>, 'category' | 'userPermissions' | 'botPermissions'> &
    Partial<Pick<Action<S>, 'category' | 'userPermissions' | 'botPermissions'>>,
): void {
  registry.register({ category: 'community', userPermissions: [], botPermissions: [], ...spec });
}
function scoped(guildId: string, id: string): string {
  return `${guildId}:${id}`;
}
export function settings(store: Store, guildId: string): CommunitySettings {
  return communitySettingsSchema.parse(store.get('community.settings', guildId) ?? {});
}
export function getProfile(store: Store, guildId: string, userId: string): Profile {
  return (
    store.get<Profile>('community.profiles', scoped(guildId, userId)) ?? {
      xp: 0,
      balance: 0,
      lastDaily: 0,
      lastXpAt: 0,
      messages: 0,
    }
  );
}
function saveProfile(store: Store, guildId: string, userId: string, profile: Profile): void {
  if (!Number.isSafeInteger(profile.balance) || profile.balance < 0 || profile.balance > MAX_BALANCE)
    throw new UserError('Balance would exceed the supported range.');
  store.set('community.profiles', scoped(guildId, userId), profile);
}
export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}
export function claimDaily(store: Store, guildId: string, userId: string, now = Date.now()): Profile {
  return store.transaction(() => {
    const profile = getProfile(store, guildId, userId);
    if (profile.lastDaily && now - profile.lastDaily < DAY)
      throw new UserError(`Daily reward available <t:${Math.ceil((profile.lastDaily + DAY) / 1000)}:R>.`);
    const streak =
      profile.lastDaily && now - profile.lastDaily <= 2 * DAY ? (profile.dailyStreak ?? 1) + 1 : 1;
    const reward = 100 + (streak % 7 === 0 ? 50 : 0);
    profile.balance += reward;
    profile.lastDaily = now;
    profile.dailyStreak = streak;
    profile.bestDailyStreak = Math.max(streak, profile.bestDailyStreak ?? 0);
    profile.lastDailyReward = reward;
    saveProfile(store, guildId, userId, profile);
    return profile;
  });
}
export function transferCoins(
  store: Store,
  guildId: string,
  fromId: string,
  toId: string,
  amount: number,
): { fromBalance: number; toBalance: number } {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000)
    throw new UserError('Amount must be a positive integer up to one billion.');
  if (fromId === toId) throw new UserError('Choose another member.');
  return store.transaction(() => {
    const from = getProfile(store, guildId, fromId),
      to = getProfile(store, guildId, toId);
    if (from.balance < amount) throw new UserError('Insufficient coins.');
    if (to.balance + amount > MAX_BALANCE) throw new UserError('Recipient balance is at its limit.');
    from.balance -= amount;
    to.balance += amount;
    saveProfile(store, guildId, fromId, from);
    saveProfile(store, guildId, toId, to);
    return { fromBalance: from.balance, toBalance: to.balance };
  });
}
export function awardObservedXp(store: Store, guildId: string, userId: string, now = Date.now()): boolean {
  const config = settings(store, guildId);
  if (!config.xpEnabled) return false;
  return store.transaction(() => {
    const profile = getProfile(store, guildId, userId);
    if (profile.lastXpAt && now - profile.lastXpAt < config.xpCooldownSeconds * 1000) return false;
    if (profile.xp > Number.MAX_SAFE_INTEGER - config.xpPerMessage) return false;
    profile.xp += config.xpPerMessage;
    profile.lastXpAt = now;
    profile.messages += 1;
    saveProfile(store, guildId, userId, profile);
    return true;
  });
}
function sequence(store: Store, guildId: string, kind: string): string {
  return store.transaction(() => {
    const key = scoped(guildId, kind),
      value = (store.get<number>('community.sequence', key) ?? 0) + 1;
    store.set('community.sequence', key, value);
    return String(value);
  });
}
function requireRecord<T>(store: Store, namespace: string, guildId: string, id: string): T {
  const value = store.get<T>(namespace, scoped(guildId, id));
  if (!value) throw new UserError('Record not found in this server.');
  return value;
}
function requireSafeRole(role: Role, bot: GuildMember): void {
  assertOrdinaryRole(role, bot);
}
function isStaff(ctx: ActionContext, config = settings(ctx.store, ctx.guild.id)): boolean {
  return (
    ctx.member.permissions.has(P.ModerateMembers) ||
    !!(config.staffRoleId && ctx.member.roles.cache.has(config.staffRoleId))
  );
}
async function sendConfigured(
  client: Client,
  guildId: string,
  channelId: string | null,
  content: string,
): Promise<boolean> {
  if (!channelId) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('guildId' in channel) || channel.guildId !== guildId || !channel.isSendable())
      return false;
    await channel.send({ content: content.slice(0, 1900), allowedMentions: NO_MENTIONS });
    return true;
  } catch {
    return false;
  }
}
async function notifyStaff(ctx: ActionContext, content: string): Promise<boolean> {
  return sendConfigured(
    ctx.client,
    ctx.guild.id,
    settings(ctx.store, ctx.guild.id).moderationLogChannelId,
    content,
  );
}

export function registerCommunityActions(registry: ActionRegistry): void {
  registerCommunityExtraActions(registry);
  add(registry, {
    id: 'community.settings',
    description: 'Read server community settings.',
    risk: 'read',
    userPermissions: [P.ManageGuild],
    schema: empty,
    execute: (ctx) => settings(ctx.store, ctx.guild.id),
  });
  add(registry, {
    id: 'community.configure',
    description: 'Configure welcome, safe newcomer roles, XP, tickets, FAQ and simple antispam.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: communityPatchSchema,
    execute: async (ctx, input) => {
      for (const id of [input.welcomeChannelId, input.goodbyeChannelId, input.moderationLogChannelId]) {
        if (id) {
          const channel = await resolveChannel(ctx, id);
          if (!channel.isSendable())
            throw new UserError('Configured notification channels must accept messages.');
        }
      }
      if (input.ticketCategoryId) {
        const category = await resolveChannel(ctx, input.ticketCategoryId);
        if (category.type !== ChannelType.GuildCategory)
          throw new UserError('Ticket category must be a category channel.');
      }
      if (input.staffRoleId) {
        const role = await resolveRole(ctx, input.staffRoleId);
        if (role.id === ctx.guild.id) throw new UserError('The staff role cannot be @everyone.');
      }
      const bot = await ctx.guild.members.fetchMe();
      for (const id of [input.newcomerRoleId, ...(input.selfRoleIds ?? [])]) {
        if (!id) continue;
        const role = await resolveRole(ctx, id);
        assertRoleHierarchy(ctx, role);
        requireSafeRole(role, bot);
      }
      const next = communitySettingsSchema.parse({ ...settings(ctx.store, ctx.guild.id), ...input });
      ctx.store.set('community.settings', ctx.guild.id, next);
      return next;
    },
  });

  add(registry, {
    id: 'faq.set',
    description: 'Add or update an exact-keyword FAQ response.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ keyword: z.string().trim().min(2).max(80), response: text }),
    execute: (ctx, input) => {
      const key = scoped(ctx.guild.id, input.keyword.toLowerCase());
      if (
        !ctx.store.get('community.faq', key) &&
        ctx.store.list('community.faq', `${ctx.guild.id}:`).length >= 100
      )
        throw new UserError('This server already has 100 FAQ entries.');
      ctx.store.set('community.faq', key, input.response);
      return { keyword: input.keyword.toLowerCase() };
    },
  });
  add(registry, {
    id: 'faq.remove',
    description: 'Remove a configured FAQ response.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ keyword: z.string().trim().min(2).max(80) }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('community.faq', scoped(ctx.guild.id, input.keyword.toLowerCase())),
    }),
  });
  add(registry, {
    id: 'faq.list',
    description: 'List public FAQ answers in this server.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<string>('community.faq', `${ctx.guild.id}:`)
        .map((row) => ({ keyword: row.key.slice(ctx.guild.id.length + 1), response: row.value })),
  });

  add(registry, {
    id: 'level.profile',
    description: 'Read XP, observed active messages, and level for a member.',
    risk: 'read',
    schema: z.strictObject({ userId: snowflake.optional() }),
    execute: async (ctx, input) => {
      const userId = input.userId ?? ctx.member.id;
      await resolveMember(ctx, userId);
      const p = getProfile(ctx.store, ctx.guild.id, userId);
      return {
        userId,
        xp: p.xp,
        level: levelForXp(p.xp),
        nextLevelXp: (levelForXp(p.xp) + 1) ** 2 * 100,
        observedActiveMessages: p.messages,
      };
    },
  });
  add(registry, {
    id: 'level.leaderboard',
    description: 'Read up to 25 observed XP leaders.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<Profile>('community.profiles', `${ctx.guild.id}:`)
        .sort((a, b) => b.value.xp - a.value.xp)
        .slice(0, 25)
        .map((row, i) => ({
          rank: i + 1,
          userId: row.key.split(':')[1],
          xp: row.value.xp,
          level: levelForXp(row.value.xp),
        })),
  });
  add(registry, {
    id: 'economy.balance',
    description: 'Read your fictional coin balance and next daily reward time.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => {
      const p = getProfile(ctx.store, ctx.guild.id, ctx.member.id);
      return {
        coins: p.balance,
        nextDailyAt: p.lastDaily ? new Date(p.lastDaily + DAY).toISOString() : null,
        currency: 'fictional coins; no cash value',
      };
    },
  });
  add(registry, {
    id: 'economy.daily',
    description:
      'Claim 100 fictional coins every 24 hours; every seventh consecutive claim within 48 hours earns a 50-coin streak bonus.',
    risk: 'write',
    schema: empty,
    execute: (ctx) => {
      const profile = claimDaily(ctx.store, ctx.guild.id, ctx.member.id);
      return {
        coins: profile.balance,
        reward: profile.lastDailyReward,
        streak: profile.dailyStreak,
        bestStreak: profile.bestDailyStreak,
      };
    },
  });
  add(registry, {
    id: 'economy.streak',
    description:
      'Read your daily-claim streak and best streak. The streak expires 48 hours after your last successful claim.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => {
      const profile = getProfile(ctx.store, ctx.guild.id, ctx.member.id);
      return {
        current:
          profile.lastDaily && Date.now() - profile.lastDaily <= 2 * DAY ? (profile.dailyStreak ?? 1) : 0,
        best: profile.bestDailyStreak ?? 0,
        lastReward: profile.lastDailyReward ?? null,
        graceHours: 48,
        bonusEveryClaims: 7,
        bonusCoins: 50,
      };
    },
  });
  add(registry, {
    id: 'economy.transfer',
    description: 'Transfer fictional coins to another member atomically.',
    risk: 'write',
    schema: z.strictObject({ userId: snowflake, amount: z.number().int().min(1).max(1_000_000_000) }),
    execute: async (ctx, input) => {
      const recipient = await resolveMember(ctx, input.userId);
      if (recipient.user.bot) throw new UserError('Bots cannot receive coins.');
      return transferCoins(ctx.store, ctx.guild.id, ctx.member.id, input.userId, input.amount);
    },
  });
  add(registry, {
    id: 'economy.leaderboard',
    description: 'Read the 25 highest fictional coin balances.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<Profile>('community.profiles', `${ctx.guild.id}:`)
        .sort((a, b) => b.value.balance - a.value.balance)
        .slice(0, 25)
        .map((row, i) => ({ rank: i + 1, userId: row.key.split(':')[1], coins: row.value.balance })),
  });
  add(registry, {
    id: 'economy.grant',
    description: 'Add or remove fictional coins as a server administrator.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      userId: snowflake,
      amount: z
        .number()
        .int()
        .min(-1_000_000_000)
        .max(1_000_000_000)
        .refine((n) => n !== 0),
    }),
    execute: async (ctx, input) => {
      await resolveMember(ctx, input.userId);
      return ctx.store.transaction(() => {
        const p = getProfile(ctx.store, ctx.guild.id, input.userId);
        p.balance += input.amount;
        saveProfile(ctx.store, ctx.guild.id, input.userId, p);
        return { userId: input.userId, coins: p.balance };
      });
    },
  });
  add(registry, {
    id: 'shop.set',
    description: 'Create an inventory-only collectible sold for fictional coins.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      itemId: slug,
      name: label,
      description: z.string().max(500).default(''),
      price: z.number().int().min(1).max(1_000_000_000),
    }),
    execute: (ctx, input) => {
      const key = scoped(ctx.guild.id, input.itemId);
      if (
        !ctx.store.get('community.shop', key) &&
        ctx.store.list('community.shop', `${ctx.guild.id}:`).length >= 100
      )
        throw new UserError('Maximum 100 shop items per server.');
      const item: ShopItem = {
        id: input.itemId,
        name: input.name,
        description: input.description,
        price: input.price,
      };
      ctx.store.set('community.shop', key, item);
      return item;
    },
  });
  add(registry, {
    id: 'shop.remove',
    description: 'Remove a shop item; existing inventory remains owned.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ itemId: slug }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('community.shop', scoped(ctx.guild.id, input.itemId)),
    }),
  });
  add(registry, {
    id: 'shop.list',
    description: 'List this server’s collectible shop.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => ctx.store.list<ShopItem>('community.shop', `${ctx.guild.id}:`).map((row) => row.value),
  });
  add(registry, {
    id: 'shop.buy',
    description: 'Purchase fictional collectibles with an atomic balance update.',
    risk: 'write',
    schema: z.strictObject({ itemId: slug, quantity: z.number().int().min(1).max(100).default(1) }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const item = requireRecord<ShopItem>(ctx.store, 'community.shop', ctx.guild.id, input.itemId),
          profile = getProfile(ctx.store, ctx.guild.id, ctx.member.id);
        const cost = item.price * input.quantity;
        if (profile.balance < cost) throw new UserError('Insufficient coins.');
        const key = scoped(ctx.guild.id, ctx.member.id),
          inventory = ctx.store.get<Record<string, number>>('community.inventory', key) ?? {};
        if (Object.keys(inventory).length >= 100 && !inventory[input.itemId])
          throw new UserError('Inventory item limit reached.');
        const total = (inventory[input.itemId] ?? 0) + input.quantity;
        if (total > 1_000_000) throw new UserError('Inventory quantity limit reached.');
        profile.balance -= cost;
        inventory[input.itemId] = total;
        saveProfile(ctx.store, ctx.guild.id, ctx.member.id, profile);
        ctx.store.set('community.inventory', key, inventory);
        return { item: item.name, quantity: input.quantity, cost, coins: profile.balance };
      }),
  });
  add(registry, {
    id: 'shop.inventory',
    description: 'Read your collectible inventory.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => ctx.store.get('community.inventory', scoped(ctx.guild.id, ctx.member.id)) ?? {},
  });

  add(registry, {
    id: 'game.dice',
    description: 'Roll up to 20 dice with cryptographic randomness.',
    risk: 'read',
    schema: z.strictObject({
      sides: z.number().int().min(2).max(1000).default(6),
      count: z.number().int().min(1).max(20).default(1),
    }),
    execute: (_ctx, input) => {
      const rolls = Array.from({ length: input.count }, () => randomInt(1, input.sides + 1));
      return { rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) };
    },
  });
  add(registry, {
    id: 'game.coinflip',
    description: 'Flip a fair virtual coin without wagering.',
    risk: 'read',
    schema: empty,
    execute: () => ({ result: randomInt(2) ? 'heads' : 'tails' }),
  });
  add(registry, {
    id: 'trivia.start',
    description: 'Start a five-minute general-knowledge question.',
    risk: 'write',
    schema: empty,
    execute: (ctx) => {
      const key = scoped(ctx.guild.id, ctx.member.id),
        existing = ctx.store.get<TriviaSession>('community.trivia', key);
      if (existing && Date.now() - existing.createdAt < 300_000)
        return {
          question: TRIVIA[existing.questionIndex]!.question,
          expiresAt: existing.createdAt + 300_000,
        };
      const session: TriviaSession = {
        questionIndex: randomInt(TRIVIA.length),
        createdAt: Date.now(),
        attempts: 0,
      };
      ctx.store.set('community.trivia', key, session);
      return { question: TRIVIA[session.questionIndex]!.question, expiresAt: session.createdAt + 300_000 };
    },
  });
  add(registry, {
    id: 'trivia.answer',
    description: 'Answer your active question; a correct answer awards 25 fictional coins.',
    risk: 'write',
    schema: z.strictObject({ answer: z.string().trim().min(1).max(200) }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const key = scoped(ctx.guild.id, ctx.member.id),
          session = ctx.store.get<TriviaSession>('community.trivia', key);
        if (!session || Date.now() - session.createdAt > 300_000) {
          ctx.store.delete('community.trivia', key);
          throw new UserError('No active question. Start one with trivia.start.');
        }
        const question = TRIVIA[session.questionIndex]!;
        const correct = [
          question.answer,
          ...('alternatives' in question ? (question.alternatives ?? []) : []),
        ].includes(input.answer.toLowerCase());
        session.attempts += 1;
        if (correct) {
          const p = getProfile(ctx.store, ctx.guild.id, ctx.member.id);
          p.balance += 25;
          saveProfile(ctx.store, ctx.guild.id, ctx.member.id, p);
          ctx.store.delete('community.trivia', key);
          return { correct: true, reward: 25, coins: p.balance };
        }
        if (session.attempts >= 3) ctx.store.delete('community.trivia', key);
        else ctx.store.set('community.trivia', key, session);
        return { correct: false, attemptsLeft: Math.max(0, 3 - session.attempts) };
      }),
  });

  add(registry, {
    id: 'case.warn',
    description: 'Record a member warning, with moderation hierarchy checks.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ userId: snowflake, reason: text }),
    execute: async (ctx, input) => {
      const target = await resolveMember(ctx, input.userId);
      assertHierarchy(ctx, target);
      const id = sequence(ctx.store, ctx.guild.id, 'case');
      const record: CaseRecord = {
        id,
        userId: target.id,
        moderatorId: ctx.member.id,
        reason: input.reason,
        createdAt: Date.now(),
        notes: [],
      };
      ctx.store.set('community.cases', scoped(ctx.guild.id, id), record);
      return {
        ...record,
        staffNotified: await notifyStaff(
          ctx,
          `Warning case #${id}: member ${target.id}, moderator ${ctx.member.id}. Reason: ${input.reason}`,
        ),
      };
    },
  });
  add(registry, {
    id: 'case.list',
    description:
      'Read the unified warning and native-moderation case journal, optionally filtered by member.',
    category: 'moderation',
    risk: 'read',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({
      userId: snowflake.optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    execute: (ctx, input) =>
      ctx.store
        .list<CaseRecord>('community.cases', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => !input.userId || row.userId === input.userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, input.limit),
  });
  add(registry, {
    id: 'case.note',
    description: 'Add a staff-only note to a warning case.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ caseId: z.string().regex(/^\d{1,12}$/), note: text }),
    execute: (ctx, input) => {
      const record = requireRecord<CaseRecord>(ctx.store, 'community.cases', ctx.guild.id, input.caseId);
      if (record.notes.length >= 100) throw new UserError('Case note limit reached.');
      record.notes.push({ authorId: ctx.member.id, text: input.note, createdAt: Date.now() });
      ctx.store.set('community.cases', scoped(ctx.guild.id, input.caseId), record);
      return record;
    },
  });
  add(registry, {
    id: 'case.mine',
    description: 'Read your warnings and appeal status without staff notes.',
    category: 'moderation',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<CaseRecord>('community.cases', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.userId === ctx.member.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map(({ notes: _notes, ...record }) => record),
  });
  add(registry, {
    id: 'appeal.submit',
    description: 'Submit one appeal for one of your warning or native-moderation cases.',
    category: 'moderation',
    risk: 'write',
    schema: z.strictObject({ caseId: z.string().regex(/^\d{1,12}$/), explanation: text }),
    execute: async (ctx, input) => {
      const record = requireRecord<CaseRecord>(ctx.store, 'community.cases', ctx.guild.id, input.caseId);
      if (record.userId !== ctx.member.id) throw new UserError('You may appeal only your own case.');
      if (record.appeal) throw new UserError('This case already has an appeal.');
      record.appeal = { text: input.explanation, createdAt: Date.now(), status: 'pending' };
      ctx.store.set('community.cases', scoped(ctx.guild.id, input.caseId), record);
      return {
        caseId: record.id,
        status: 'pending',
        staffNotified: await notifyStaff(
          ctx,
          `Appeal submitted for warning case #${record.id} by member ${ctx.member.id}.`,
        ),
      };
    },
  });
  add(registry, {
    id: 'appeal.review',
    description: 'Approve or deny a warning appeal; records decision without applying unrelated punishments.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ caseId: z.string().regex(/^\d{1,12}$/), approve: z.boolean(), decision: text }),
    execute: (ctx, input) => {
      const record = requireRecord<CaseRecord>(ctx.store, 'community.cases', ctx.guild.id, input.caseId);
      if (!record.appeal || record.appeal.status !== 'pending')
        throw new UserError('No pending appeal for this case.');
      if (record.userId === ctx.member.id) throw new UserError('You cannot review your own appeal.');
      record.appeal.status = input.approve ? 'approved' : 'denied';
      record.appeal.decision = input.decision;
      record.appeal.reviewerId = ctx.member.id;
      ctx.store.set('community.cases', scoped(ctx.guild.id, input.caseId), record);
      return record;
    },
  });
  add(registry, {
    id: 'report.submit',
    description: 'Submit a private staff report about a server member.',
    category: 'moderation',
    risk: 'write',
    schema: z.strictObject({ userId: snowflake, reason: text }),
    execute: async (ctx, input) => {
      await resolveMember(ctx, input.userId);
      const since = Date.now() - 3_600_000,
        own = ctx.store
          .list<ReportRecord>('community.reports', `${ctx.guild.id}:`)
          .filter((row) => row.value.authorId === ctx.member.id && row.value.createdAt > since);
      if (own.length >= 5) throw new UserError('Maximum five reports per hour.');
      const id = sequence(ctx.store, ctx.guild.id, 'report');
      const record: ReportRecord = {
        id,
        authorId: ctx.member.id,
        targetId: input.userId,
        reason: input.reason,
        createdAt: Date.now(),
        status: 'open',
      };
      ctx.store.set('community.reports', scoped(ctx.guild.id, id), record);
      return {
        reportId: id,
        status: record.status,
        staffNotified: await notifyStaff(
          ctx,
          `New report #${id}: member ${input.userId}, reporter ${ctx.member.id}.`,
        ),
      };
    },
  });
  add(registry, {
    id: 'report.list',
    description: 'Read a staff report queue.',
    category: 'moderation',
    risk: 'read',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ status: z.enum(['open', 'closed']).default('open') }),
    execute: (ctx, input) =>
      ctx.store
        .list<ReportRecord>('community.reports', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.status === input.status)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, 100),
  });
  add(registry, {
    id: 'report.claim',
    description: 'Assign an open report to yourself.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ reportId: z.string().regex(/^\d{1,12}$/) }),
    execute: (ctx, input) => {
      const report = requireRecord<ReportRecord>(
        ctx.store,
        'community.reports',
        ctx.guild.id,
        input.reportId,
      );
      if (report.status !== 'open') throw new UserError('Report is closed.');
      if (report.assigneeId && report.assigneeId !== ctx.member.id)
        throw new UserError('Another moderator has claimed this report.');
      report.assigneeId = ctx.member.id;
      ctx.store.set('community.reports', scoped(ctx.guild.id, report.id), report);
      return report;
    },
  });
  add(registry, {
    id: 'report.assign',
    description:
      'Assign or reassign an open report to a current authorized moderator, excluding the reporter and reported member.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ reportId: z.string().regex(/^\d{1,12}$/), moderatorId: snowflake }),
    execute: async (ctx, input) => {
      const moderator = await resolveMember(ctx, input.moderatorId);
      if (!isStaff({ ...ctx, member: moderator }))
        throw new UserError('The assignee must be a current support/moderation staff member.');
      const report = requireRecord<ReportRecord>(
        ctx.store,
        'community.reports',
        ctx.guild.id,
        input.reportId,
      );
      if (report.status !== 'open') throw new UserError('Report is closed.');
      if ([report.authorId, report.targetId].includes(moderator.id))
        throw new UserError('The reporter and reported member cannot handle this report.');
      report.assigneeId = moderator.id;
      ctx.store.set('community.reports', scoped(ctx.guild.id, report.id), report);
      return report;
    },
  });
  add(registry, {
    id: 'report.resolve',
    description: 'Close a staff report with a resolution.',
    category: 'moderation',
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    schema: z.strictObject({ reportId: z.string().regex(/^\d{1,12}$/), resolution: text }),
    execute: (ctx, input) => {
      const report = requireRecord<ReportRecord>(
        ctx.store,
        'community.reports',
        ctx.guild.id,
        input.reportId,
      );
      if (report.status !== 'open') throw new UserError('Report is already closed.');
      report.status = 'closed';
      report.resolution = input.resolution;
      report.assigneeId ??= ctx.member.id;
      ctx.store.set('community.reports', scoped(ctx.guild.id, report.id), report);
      return report;
    },
  });

  add(registry, {
    id: 'ticket.open',
    description: 'Create one private support channel for yourself.',
    category: 'support',
    risk: 'write',
    botPermissions: [P.ManageChannels, P.ManageRoles],
    schema: z.strictObject({ subject: label }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      await resolveChannel(ctx, ctx.channelId);
      const config = settings(ctx.store, ctx.guild.id);
      if (!config.staffRoleId) throw new UserError('Configure a staffRoleId before opening tickets.');
      const staff = await resolveRole(ctx, config.staffRoleId);
      if (staff.id === ctx.guild.id) throw new UserError('The staff role cannot be @everyone.');
      if (config.ticketCategoryId) {
        const category = await resolveChannel(ctx, config.ticketCategoryId);
        if (category.type !== ChannelType.GuildCategory)
          throw new UserError('Ticket category must be a category channel.');
      }
      const bot = await ctx.guild.members.fetchMe();
      const userKey = scoped(ctx.guild.id, ctx.member.id);
      const reservation = randomUUID();
      ctx.store.transaction(() => {
        const existing = ctx.store.get<{ reservation: string; channelId?: string }>(
          'community.activeTickets',
          userKey,
        );
        if (existing)
          throw new UserError(
            existing.channelId
              ? `Your existing ticket is <#${existing.channelId}>.`
              : 'A ticket is already being created.',
          );
        if (ctx.store.list('community.activeTickets', `${ctx.guild.id}:`).length >= 500)
          throw new UserError(
            'This server has 500 active or unresolved ticket requests. Close or reconcile existing requests first.',
          );
        ctx.store.set('community.activeTickets', userKey, {
          reservation,
          subject: input.subject,
          createdAt: Date.now(),
          state: 'creating',
        });
      });
      return lockedTicket(ctx.store, `opening:${userKey}`, async () => {
        try {
          const channel = await ctx.guild.channels.create({
            name: `ticket-${ctx.member.id.slice(-8)}`,
            type: ChannelType.GuildText,
            parent: config.ticketCategoryId ?? undefined,
            topic: `Support request ${reservation} for ${ctx.member.id}: ${input.subject}`,
            permissionOverwrites: [
              { id: ctx.guild.id, deny: [P.ViewChannel] },
              {
                id: ctx.member.id,
                allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles],
              },
              { id: bot.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
              { id: staff.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            ],
            reason: `Support ticket requested by ${ctx.member.id}`,
          });
          const record = saveRecoveredTicket(
            ctx.store,
            ctx.guild.id,
            ctx.member.id,
            ctx.store.get<TicketReservation>('community.activeTickets', userKey)!,
            channel.id,
          );
          await channel
            .send({
              content: `Support ticket opened for <@${ctx.member.id}>.\n${input.subject}\nUse ticket.close when resolved.`,
              allowedMentions: NO_MENTIONS,
            })
            .catch(() => undefined);
          return visibleTicket(record, isStaff(ctx));
        } catch (error) {
          const value = ctx.store.get<TicketReservation>('community.activeTickets', userKey);
          if (value?.reservation === reservation && !value.channelId) {
            const rejected =
              error &&
              typeof error === 'object' &&
              'status' in error &&
              typeof error.status === 'number' &&
              error.status >= 400 &&
              error.status < 500 &&
              error.status !== 408;
            if (rejected) ctx.store.delete('community.activeTickets', userKey);
            else
              ctx.store.set('community.activeTickets', userKey, {
                ...value,
                state: 'needs-review',
                lastError: error instanceof Error ? error.name : 'Error',
              });
          }
          throw error;
        }
      });
    },
  });
  add(registry, {
    id: 'ticket.list',
    description: 'Read accessible tickets among the 100 most recent owned or staff-managed tickets.',
    category: 'support',
    risk: 'read',
    schema: empty,
    execute: async (ctx) => {
      ctx = await freshContext(ctx);
      await resolveChannel(ctx, ctx.channelId);
      const candidates = ctx.store.db
        .prepare(
          `SELECT value FROM kv WHERE namespace=? AND key>=? AND key<?
        AND (?=1 OR json_extract(value,'$.userId')=?) ORDER BY CAST(json_extract(value,'$.createdAt') AS INTEGER) DESC LIMIT 100`,
        )
        .all('community.tickets', `${ctx.guild.id}:`, `${ctx.guild.id};`, Number(isStaff(ctx)), ctx.member.id)
        .map((row) => JSON.parse(String(row.value)) as TicketRecord);
      const channels = await ctx.guild.channels.fetch();
      return candidates
        .filter((ticket) => {
          const channel = channels.get(ticket.channelId);
          return (
            channel?.guildId === ctx.guild.id &&
            channel.type === ChannelType.GuildText &&
            channel.permissionsFor(ctx.member)?.has(P.ViewChannel) &&
            channel.permissionsFor(ctx.guild.members.me!)?.has(P.ViewChannel)
          );
        })
        .map((ticket) => visibleTicket(ticket, isStaff(ctx)));
    },
  });
  add(registry, {
    id: 'ticket.claim',
    description: 'Assign an open support ticket to yourself.',
    category: 'support',
    risk: 'write',
    schema: z.strictObject({ channelId: snowflake }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        const access = await ticketAccess(ctx, input.channelId, true);
        ctx = access.ctx;
        const { ticket } = access;
        if (ticket.status !== 'open') throw new UserError('Ticket is closed.');
        if (ticket.assigneeId && ticket.assigneeId !== ctx.member.id)
          throw new UserError('Another staff member has claimed this ticket.');
        ticket.assigneeId = ctx.member.id;
        ctx.store.set('community.tickets', scoped(ctx.guild.id, ticket.id), ticket);
        return ticket;
      }),
  });
  add(registry, {
    id: 'ticket.close',
    description: 'Close your support ticket or a staff-managed ticket, retaining history.',
    category: 'support',
    risk: 'write',
    botPermissions: [P.ManageChannels, P.ManageRoles],
    schema: z.strictObject({ channelId: snowflake }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        const access = await ticketAccess(ctx, input.channelId);
        ctx = access.ctx;
        const { ticket, channel } = access;
        if (ticket.status !== 'open') throw new UserError('Ticket is already closed.');
        if (!channel.permissionsFor(ctx.guild.members.me!)?.has([P.ManageChannels, P.ManageRoles]))
          throw new UserError('The bot needs Manage Channels and Manage Roles in this ticket.');
        await channel.permissionOverwrites.edit(
          ticket.userId,
          {
            SendMessages: false,
            SendMessagesInThreads: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          },
          { reason: `Ticket closed by ${ctx.member.id}` },
        );
        ticket.status = 'closed';
        ticket.closedAt = Date.now();
        ctx.store.transaction(() => {
          ctx.store.set('community.tickets', scoped(ctx.guild.id, ticket.id), ticket);
          const activeKey = scoped(ctx.guild.id, ticket.userId);
          if (ctx.store.get<TicketReservation>('community.activeTickets', activeKey)?.channelId === ticket.id)
            ctx.store.delete('community.activeTickets', activeKey);
        });
        return visibleTicket(ticket, isStaff(ctx));
      }),
  });
  add(registry, {
    id: 'ticket.status',
    description:
      'Read your durable ticket creation reservation; support staff may inspect another member’s reservation.',
    category: 'support',
    risk: 'read',
    schema: z.strictObject({ userId: snowflake.optional() }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const userId = input.userId ?? ctx.member.id;
      if (userId !== ctx.member.id && !isStaff(ctx))
        throw new UserError('Only support staff may inspect another member’s reservation.');
      return {
        userId,
        reservation:
          ctx.store.get<TicketReservation>('community.activeTickets', scoped(ctx.guild.id, userId)) ?? null,
      };
    },
  });
  add(registry, {
    id: 'ticket.reconcile',
    description:
      'Recover a channel matching an uncertain creation reservation, or explicitly release it after verifying no channel was created.',
    category: 'support',
    risk: 'write',
    botPermissions: [P.ManageChannels],
    schema: z.strictObject({
      userId: snowflake.optional(),
      reservation: z.string().uuid(),
      outcome: z.enum(['created', 'not-created']),
      channelId: snowflake.optional(),
    }),
    execute: async (ctx, input) => {
      const userId = input.userId ?? ctx.member.id,
        userKey = scoped(ctx.guild.id, userId);
      return lockedTicket(ctx.store, `opening:${userKey}`, async () => {
        ctx = await freshContext(ctx);
        await resolveChannel(ctx, ctx.channelId);
        if (userId !== ctx.member.id && !isStaff(ctx))
          throw new UserError('Only support staff may reconcile another member’s reservation.');
        const reservation = ctx.store.get<TicketReservation>('community.activeTickets', userKey);
        if (!reservation || reservation.reservation !== input.reservation || reservation.channelId)
          throw new UserError('No matching unresolved ticket reservation.');
        if (input.outcome === 'created') {
          if (!input.channelId)
            throw new UserError('Provide the actual channel ID created for this reservation.');
          const channel = await resolveChannel(ctx, input.channelId);
          if (channel.type !== ChannelType.GuildText || channel.topic !== ticketTopic(reservation, userId))
            throw new UserError('Channel topic/owner does not match the exact creation reservation.');
          return saveRecoveredTicket(ctx.store, ctx.guild.id, userId, reservation, channel.id);
        }
        if (!isStaff(ctx))
          throw new UserError(
            'Support staff must verify that an uncertain request did not create a channel.',
          );
        if (Date.now() - reservation.createdAt < 120_000)
          throw new UserError(
            'Wait two minutes for the creation request to settle before releasing its reservation.',
          );
        const channels = await ctx.guild.channels.fetch();
        if (
          channels.some(
            (channel) =>
              channel?.type === ChannelType.GuildText && channel.topic === ticketTopic(reservation, userId),
          )
        )
          throw new UserError('A matching channel exists. Reconcile it as created instead.');
        ctx = await freshContext(ctx);
        if (!isStaff(ctx)) throw new UserError('Support staff authorization changed during reconciliation.');
        const current = ctx.store.get<TicketReservation>('community.activeTickets', userKey);
        if (!current || current.reservation !== reservation.reservation || current.channelId)
          throw new UserError('Reservation changed during reconciliation.');
        ctx.store.delete('community.activeTickets', userKey);
        return { released: true, userId, reservation: reservation.reservation };
      });
    },
  });
  add(registry, {
    id: 'ticket.transfer',
    description:
      'Assign or unassign an open ticket. A new assignee must currently be support staff and able to view its channel.',
    category: 'support',
    risk: 'write',
    schema: z.strictObject({ channelId: snowflake, assigneeId: snowflake.nullable() }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        let access = await ticketAccess(ctx, input.channelId, true);
        ctx = access.ctx;
        if (input.assigneeId) {
          const assignee = await resolveMember(ctx, input.assigneeId);
          if (
            assignee.user.bot ||
            !isStaff({ ...ctx, member: assignee }) ||
            !access.channel.permissionsFor(assignee)?.has(P.ViewChannel)
          )
            throw new UserError('Assignee must currently be human support staff with access to this ticket.');
          access = await ticketAccess(ctx, input.channelId, true);
          ctx = access.ctx;
        }
        const { ticket } = access;
        if (ticket.status !== 'open') throw new UserError('Only open tickets can be transferred.');
        if (input.assigneeId) ticket.assigneeId = input.assigneeId;
        else delete ticket.assigneeId;
        ctx.store.set('community.tickets', scoped(ctx.guild.id, ticket.id), ticket);
        return ticket;
      }),
  });
  add(registry, {
    id: 'ticket.update',
    description:
      'Set a support ticket’s staff-only priority and tags without publishing them to its channel.',
    category: 'support',
    risk: 'write',
    schema: z
      .strictObject({
        channelId: snowflake,
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        tags: z.array(slug).max(10).optional(),
      })
      .refine(
        (value) => value.priority !== undefined || value.tags !== undefined,
        'Provide priority or tags.',
      ),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        const { ctx: current, ticket } = await ticketAccess(ctx, input.channelId, true);
        if (input.priority !== undefined) ticket.priority = input.priority;
        if (input.tags !== undefined) ticket.tags = [...new Set(input.tags)];
        current.store.set('community.tickets', scoped(current.guild.id, ticket.id), ticket);
        return ticket;
      }),
  });
  add(registry, {
    id: 'ticket.category',
    description:
      'Move a support ticket to a visible category while preserving its explicit private permission overwrites.',
    category: 'support',
    risk: 'write',
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    schema: z.strictObject({ channelId: snowflake, categoryId: snowflake.nullable() }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        let access = await ticketAccess(ctx, input.channelId, true);
        ctx = access.ctx;
        const destination = input.categoryId ? await resolveChannel(ctx, input.categoryId) : null;
        if (input.categoryId) {
          const category = destination!;
          if (
            category.type !== ChannelType.GuildCategory ||
            !category.permissionsFor(ctx.member)?.has(P.ManageChannels) ||
            !category.permissionsFor(ctx.guild.members.me!)?.has(P.ManageChannels)
          )
            throw new UserError(
              'You and the bot need access and Manage Channels in the destination category.',
            );
        }
        access = await ticketAccess(ctx, input.channelId, true);
        ctx = access.ctx;
        for (const channel of [access.channel, ...(destination ? [destination] : [])])
          if (
            !channel.permissionsFor(ctx.member)?.has(P.ManageChannels) ||
            !channel.permissionsFor(ctx.guild.members.me!)?.has(P.ManageChannels)
          )
            throw new UserError('Manage Channels authorization changed during the category move.');
        await access.channel.setParent(input.categoryId, {
          lockPermissions: false,
          reason: `Ticket moved by ${ctx.member.id}`,
        });
        access.ticket.categoryId = input.categoryId;
        ctx.store.set('community.tickets', scoped(ctx.guild.id, access.ticket.id), access.ticket);
        return access.ticket;
      }),
  });
  add(registry, {
    id: 'ticket.archive',
    description:
      'Archive a closed ticket by denying its owner channel visibility and posting; staff retain their existing access and history.',
    category: 'support',
    risk: 'write',
    botPermissions: [P.ManageChannels, P.ManageRoles],
    schema: z.strictObject({ channelId: snowflake }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.channelId), async () => {
        const { ctx: current, channel, ticket } = await ticketAccess(ctx, input.channelId, true);
        if (ticket.status !== 'closed') throw new UserError('Close the ticket before archiving it.');
        if (!channel.permissionsFor(current.guild.members.me!)?.has([P.ManageChannels, P.ManageRoles]))
          throw new UserError('The bot needs Manage Channels and Manage Roles in this ticket.');
        await channel.permissionOverwrites.edit(
          ticket.userId,
          {
            ViewChannel: false,
            SendMessages: false,
            SendMessagesInThreads: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
          },
          { reason: `Ticket archived by ${current.member.id}` },
        );
        ticket.status = 'archived';
        ticket.archivedAt = Date.now();
        current.store.set('community.tickets', scoped(current.guild.id, ticket.id), ticket);
        return {
          ticket,
          notice:
            'The owner overwrite is hidden; server owners and administrators still bypass channel overwrites.',
        };
      }),
  });
  add(registry, {
    id: 'ticket.rate',
    description:
      'Submit one private satisfaction score and optional feedback for your closed or archived ticket within thirty days.',
    category: 'support',
    risk: 'write',
    schema: z.strictObject({
      ticketId: snowflake,
      score: z.number().int().min(1).max(5),
      comment: z.string().trim().max(1000).default(''),
    }),
    execute: async (ctx, input) =>
      lockedTicket(ctx.store, scoped(ctx.guild.id, input.ticketId), async () => {
        ctx = await freshContext(ctx);
        await resolveChannel(ctx, ctx.channelId);
        const ticket = requireRecord<TicketRecord>(
          ctx.store,
          'community.tickets',
          ctx.guild.id,
          input.ticketId,
        );
        if (ticket.userId !== ctx.member.id)
          throw new UserError('Only the ticket owner may submit satisfaction feedback.');
        if (!['closed', 'archived'].includes(ticket.status) || !ticket.closedAt)
          throw new UserError('Close the ticket before rating support.');
        if (ticket.feedback) throw new UserError('Satisfaction feedback was already submitted.');
        if (Date.now() - ticket.closedAt > 30 * DAY)
          throw new UserError('The thirty-day feedback window expired.');
        ticket.feedback = { score: input.score, comment: input.comment, createdAt: Date.now() };
        ctx.store.set('community.tickets', scoped(ctx.guild.id, ticket.id), ticket);
        return { ticketId: ticket.id, feedback: ticket.feedback };
      }),
  });
  add(registry, {
    id: 'ticket.feedback',
    description:
      'Read your submitted ticket feedback; staff need current channel access to read someone else’s feedback.',
    category: 'support',
    risk: 'read',
    schema: z.strictObject({ ticketId: snowflake }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const ticket = requireRecord<TicketRecord>(
        ctx.store,
        'community.tickets',
        ctx.guild.id,
        input.ticketId,
      );
      if (ticket.userId !== ctx.member.id) await ticketAccess(ctx, input.ticketId, true);
      return { ticketId: ticket.id, feedback: ticket.feedback ?? null };
    },
  });
  add(registry, {
    id: 'ticket.transcript',
    description:
      'Generate a permission-scoped ticket transcript over a resumable history range, with explicit completion and continuation state.',
    category: 'support',
    risk: 'read',
    botPermissions: [P.ReadMessageHistory],
    schema: z.strictObject({
      channelId: snowflake,
      before: snowflake.optional(),
      after: snowflake.optional(),
      maxMessages: z.number().int().min(1).max(5000).default(1000),
    }),
    execute: async (ctx, input) => {
      const access = await ticketAccess(ctx, input.channelId);
      ctx = access.ctx;
      const { channel } = access;
      if (
        !channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory) ||
        !channel.permissionsFor(ctx.guild.members.me!)?.has(P.ReadMessageHistory)
      )
        throw new UserError('You and the bot need Read Message History permission.');
      const transcript = await readMessageRange(ctx, input.channelId, input);
      await ticketAccess(ctx, input.channelId);
      return transcript;
    },
  });

  add(registry, {
    id: 'selfrole.list',
    description: 'List ordinary roles explicitly approved for self-assignment.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => ({ roleIds: settings(ctx.store, ctx.guild.id).selfRoleIds }),
  });
  for (const operation of ['add', 'remove'] as const)
    add(registry, {
      id: `selfrole.${operation}`,
      description: `${operation === 'add' ? 'Join' : 'Leave'} an administrator-approved, nonprivileged self-service role.`,
      risk: 'write',
      botPermissions: [P.ManageRoles],
      schema: z.strictObject({ roleId: snowflake }),
      execute: async (ctx, input) => {
        if (!settings(ctx.store, ctx.guild.id).selfRoleIds.includes(input.roleId))
          throw new UserError('This role is not approved for self-assignment.');
        const role = await resolveRole(ctx, input.roleId);
        const bot = await ctx.guild.members.fetchMe();
        requireSafeRole(role, bot);
        const member = await ctx.guild.members.fetch(ctx.member.id);
        if (operation === 'add') await member.roles.add(role, 'Approved self-service role');
        else await member.roles.remove(role, 'Self-service role removal');
        return { roleId: role.id, operation };
      },
    });
  add(registry, {
    id: 'temprole.assign',
    description: 'Assign an ordinary role until a durable expiration deadline.',
    risk: 'write',
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    schema: z.strictObject({
      userId: snowflake,
      roleId: snowflake,
      minutes: z.number().int().min(1).max(525_600),
    }),
    execute: async (ctx, input) => {
      const member = await resolveMember(ctx, input.userId),
        role = await resolveRole(ctx, input.roleId);
      assertHierarchy(ctx, member);
      assertRoleHierarchy(ctx, role);
      requireSafeRole(role, await ctx.guild.members.fetchMe());
      if (member.roles.cache.has(role.id))
        throw new UserError(
          'Member already has this role; refusing to schedule removal of a pre-existing assignment.',
        );
      const key = scoped(ctx.guild.id, `${member.id}:${role.id}`);
      if (ctx.store.get('community.tempRoles', key))
        throw new UserError('A temporary role assignment is already tracked for this member and role.');
      const deadline: TemporaryRole = {
        userId: member.id,
        roleId: role.id,
        expiresAt: Date.now() + input.minutes * 60_000,
        attempts: 0,
      };
      ctx.store.set('community.tempRoles', key, deadline);
      try {
        await member.roles.add(role, `Temporary role by ${ctx.member.id}`);
      } catch (error) {
        ctx.store.delete('community.tempRoles', key);
        throw error;
      }
      return deadline;
    },
  });
  add(registry, {
    id: 'temprole.list',
    description: 'Inspect tracked temporary roles and expiration retry failures.',
    risk: 'read',
    userPermissions: [P.ManageRoles],
    schema: z.strictObject({ userId: snowflake.optional() }),
    execute: (ctx, input) =>
      ctx.store
        .list<TemporaryRole>('community.tempRoles', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((role) => !input.userId || role.userId === input.userId)
        .slice(0, 100),
  });

  add(registry, {
    id: 'giveaway.create',
    description: 'Create a timed, fictional-prize giveaway in a channel.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({
      channelId: snowflake,
      prize: label,
      minutes: z.number().int().min(1).max(43_200),
      winners: z.number().int().min(1).max(20).default(1),
      roleIds: z.array(snowflake).max(10).default([]),
      minimumAccountDays: z.number().int().min(0).max(3650).default(0),
      minimumMemberDays: z.number().int().min(0).max(3650).default(0),
      minimumLevel: z.number().int().min(0).max(10000).default(0),
    }),
    execute: async (ctx, input) => {
      const channel = await resolveChannel(ctx, input.channelId);
      if (!channel.isSendable()) throw new UserError('Choose a message channel.');
      for (const roleId of input.roleIds) await resolveRole(ctx, roleId);
      const active = ctx.store
        .list<Giveaway>('community.giveaways', `${ctx.guild.id}:`)
        .filter((row) => row.value.status === 'open');
      if (active.length >= 20) throw new UserError('Maximum 20 active giveaways per server.');
      const giveaway: Giveaway = {
        id: randomUUID().slice(0, 8),
        channelId: channel.id,
        prize: input.prize,
        createdBy: ctx.member.id,
        endsAt: Date.now() + input.minutes * 60_000,
        winnerCount: input.winners,
        entrants: [],
        status: 'open',
        roleIds: [...new Set(input.roleIds)],
        minimumAccountDays: input.minimumAccountDays,
        minimumMemberDays: input.minimumMemberDays,
        minimumLevel: input.minimumLevel,
      };
      await channel.send({
        content: `Giveaway ${giveaway.id}: ${giveaway.prize}\nEnds <t:${Math.floor(giveaway.endsAt / 1000)}:R>. Enter using giveaway.enter with giveawayId ${giveaway.id}.`,
        allowedMentions: NO_MENTIONS,
      });
      ctx.store.set('community.giveaways', scoped(ctx.guild.id, giveaway.id), giveaway);
      return giveaway;
    },
  });
  add(registry, {
    id: 'giveaway.enter',
    description: 'Enter an open giveaway once.',
    risk: 'write',
    schema: z.strictObject({ giveawayId: z.string().regex(/^[a-f0-9-]{8}$/) }),
    execute: async (ctx, input) => {
      const preview = requireRecord<Giveaway>(
        ctx.store,
        'community.giveaways',
        ctx.guild.id,
        input.giveawayId,
      );
      await resolveChannel(ctx, preview.channelId);
      ctx = await freshContext(ctx);
      if (!giveawayEligible(ctx.store, ctx.guild.id, preview, ctx.member, Date.now()))
        throw new UserError(
          'You do not meet this giveaway’s current role, account age, membership age or level requirements.',
        );
      return ctx.store.transaction(() => {
        const giveaway = requireRecord<Giveaway>(
          ctx.store,
          'community.giveaways',
          ctx.guild.id,
          input.giveawayId,
        );
        if (giveaway.status !== 'open' || giveaway.endsAt <= Date.now())
          throw new UserError('Giveaway is closed.');
        if (giveaway.entrants.length >= 10_000 && !giveaway.entrants.includes(ctx.member.id))
          throw new UserError('Giveaway entry limit reached.');
        if (!giveaway.entrants.includes(ctx.member.id)) giveaway.entrants.push(ctx.member.id);
        ctx.store.set('community.giveaways', scoped(ctx.guild.id, giveaway.id), giveaway);
        return { giveawayId: giveaway.id, entered: true, entrants: giveaway.entrants.length };
      });
    },
  });
  add(registry, {
    id: 'giveaway.list',
    description: 'Read giveaways in channels you can view.',
    risk: 'read',
    schema: empty,
    execute: async (ctx) => {
      const visible = [];
      for (const row of ctx.store.list<Giveaway>('community.giveaways', `${ctx.guild.id}:`).slice(-100)) {
        try {
          await resolveChannel(ctx, row.value.channelId);
          const { entrants, drawing: _drawing, ...giveaway } = row.value;
          visible.push({ ...giveaway, entrantCount: entrants.length });
        } catch {
          /* inaccessible channel */
        }
      }
      return visible;
    },
  });
  add(registry, {
    id: 'giveaway.cancel',
    description: 'Cancel a server giveaway.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ giveawayId: z.string().regex(/^[a-f0-9-]{8}$/) }),
    execute: (ctx, input) => {
      const giveaway = requireRecord<Giveaway>(
        ctx.store,
        'community.giveaways',
        ctx.guild.id,
        input.giveawayId,
      );
      if (giveaway.status !== 'open') throw new UserError('Giveaway is already closed.');
      giveaway.status = 'cancelled';
      ctx.store.set('community.giveaways', scoped(ctx.guild.id, giveaway.id), giveaway);
      return { giveawayId: giveaway.id, status: giveaway.status };
    },
  });
  add(registry, {
    id: 'community.export',
    description: 'Export your community profile and collectible inventory.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => ({
      userId: ctx.member.id,
      guildId: ctx.guild.id,
      profile: getProfile(ctx.store, ctx.guild.id, ctx.member.id),
      inventory: ctx.store.get('community.inventory', scoped(ctx.guild.id, ctx.member.id)) ?? {},
    }),
  });
  add(registry, {
    id: 'community.erase',
    description:
      'Erase your XP, coin balance, inventory and trivia state. Moderation and ticket records are retained.',
    risk: 'destructive',
    schema: empty,
    execute: (ctx) =>
      ctx.store.transaction(() => {
        eraseCommunityExtra(ctx);
        for (const namespace of ['community.profiles', 'community.inventory', 'community.trivia'])
          ctx.store.delete(namespace, scoped(ctx.guild.id, ctx.member.id));
        return {
          erased: ['XP', 'fictional coins', 'collectible inventory', 'trivia'],
          retained: ['moderation records', 'support records'],
        };
      }),
  });
}

// Observed activity only; no historical reconstruction or message-content database.
const recentMessages = new Map<
  string,
  { at: number; fingerprint: string; id: string; channelId: string; attempted?: boolean }[]
>();
const faqCooldown = new Map<string, number>();
function boundedRemember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 10_000) map.delete(map.keys().next().value!);
}
export async function onCommunityMessage(
  message: Message,
  store: Store,
  options: { spamOnly?: boolean; skipSpam?: boolean } = {},
): Promise<boolean> {
  if (!message.guild || message.author.bot || !message.member || message.webhookId) return false;
  const disabled = store.get<string[]>('core.disabled', message.guild.id) ?? [];
  if (disabled.includes('community')) return false;
  const config = settings(store, message.guild.id),
    now = Date.now(),
    key = scoped(message.guild.id, message.author.id);
  if (
    !options.skipSpam &&
    config.antiSpamEnabled &&
    !disabled.includes('moderation') &&
    !(config.antiSpamExemptStaff && message.member.permissions.has(P.ManageMessages))
  ) {
    const recent = (recentMessages.get(key) ?? []).filter((row) => now - row.at < 8000);
    const normalized = message.content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
      attachments = [...(message.attachments?.values() ?? [])]
        .slice(0, 10)
        .map((attachment) => attachment.url.split(/[?#]/, 1)[0]!)
        .sort(),
      fingerprint = createHash('sha256')
        .update(JSON.stringify([normalized, attachments]))
        .digest('hex')
        .slice(0, 32);
    recent.push({ at: now, fingerprint, id: message.id, channelId: message.channelId });
    boundedRemember(recentMessages, key, recent.slice(-30));
    const mentions =
      message.mentions.users.size +
      message.mentions.roles.size +
      (message.mentions.everyone ? config.mentionLimit : 0);
    const repeated =
      (normalized.length > 0 || attachments.length > 0) &&
      recent.filter((row) => row.fingerprint === fingerprint).length >= config.repeatLimit;
    const blocked = config.blockedKeywords.some((word) => normalized.includes(word.toLowerCase()));
    if (mentions >= config.mentionLimit || recent.length > config.messageLimit || repeated || blocked) {
      // Refresh only at a trigger. Discord also checks deletion permission on
      // the request itself; a lost permission must not let spam reach AI/XP/FAQ.
      const [bot, channel] = await Promise.all([
        message.guild.members.fetchMe({ force: true }).catch(() => null),
        message.guild.channels.fetch(message.channelId, { force: true }).catch(() => null),
      ]);
      const current = settings(store, message.guild.id),
        currentDisabled = store.get<string[]>('core.disabled', message.guild.id) ?? [],
        active =
          current.antiSpamEnabled &&
          !currentDisabled.includes('community') &&
          !currentDisabled.includes('moderation') &&
          !(current.antiSpamExemptStaff && message.member.permissions.has(P.ManageMessages));
      if (active && bot && channel?.permissionsFor(bot)?.has([P.ViewChannel, P.ManageMessages])) {
        // The threshold establishes the whole observed burst as spam. Only exact IDs
        // from this author/window are candidates; unrelated neighboring posts stay intact.
        const candidates = repeated
          ? recent.filter((row) => row.fingerprint === fingerprint)
          : recent.length > config.messageLimit
            ? recent
            : recent.slice(-1);
        const unique = new Map(
          candidates
            .filter((row) => !row.attempted && now - row.at < 8000)
            .map((row) => [`${row.channelId}:${row.id}`, row]),
        );
        for (const row of unique.values()) {
          const latest = settings(store, message.guild.id),
            switches = store.get<string[]>('core.disabled', message.guild.id) ?? [];
          if (
            !latest.antiSpamEnabled ||
            switches.includes('community') ||
            switches.includes('moderation') ||
            (latest.antiSpamExemptStaff && message.member.permissions.has(P.ManageMessages))
          )
            break;
          const [freshBot, destination] = await Promise.all([
            message.guild.members.fetchMe({ force: true }).catch(() => null),
            message.guild.channels.fetch(row.channelId, { force: true }).catch(() => null),
          ]);
          if (
            !freshBot ||
            !destination
              ?.permissionsFor(freshBot)
              ?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages])
          )
            continue;
          if (latest.antiSpamExemptStaff && typeof message.guild.members.fetch === 'function') {
            const currentMember = await message.guild.members
              .fetch({ user: message.author.id, force: true })
              .catch(() => null);
            if (!currentMember || currentMember.permissions.has(P.ManageMessages)) break;
          }
          let target: Message | undefined;
          if ('messages' in destination)
            target = await destination.messages
              .fetch({ message: row.id, force: true })
              .catch(() => undefined);
          else if (row.id === message.id && row.channelId === message.channelId) target = message;
          if (
            !target ||
            target.id !== row.id ||
            target.guild?.id !== message.guild.id ||
            target.author.id !== message.author.id ||
            target.channelId !== row.channelId ||
            !target.deletable
          )
            continue;
          const latestNormalized = target.content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
            latestAttachments = [...(target.attachments?.values() ?? [])]
              .slice(0, 10)
              .map((item) => item.url.split(/[?#]/, 1)[0]!)
              .sort(),
            latestFingerprint = createHash('sha256')
              .update(JSON.stringify([latestNormalized, latestAttachments]))
              .digest('hex')
              .slice(0, 32);
          if (latestFingerprint !== row.fingerprint) continue;
          const final = settings(store, message.guild.id),
            finalSwitches = store.get<string[]>('core.disabled', message.guild.id) ?? [];
          if (
            !final.antiSpamEnabled ||
            finalSwitches.includes('community') ||
            finalSwitches.includes('moderation') ||
            (final.antiSpamExemptStaff && message.member.permissions.has(P.ManageMessages))
          )
            break;
          for (const observed of recent)
            if (observed.id === row.id && observed.channelId === row.channelId) observed.attempted = true;
          await target.delete().catch(() => undefined);
        }
      }
      if (active && current.moderationLogChannelId) {
        const throttleKey = `${key}:alert`,
          previous = faqCooldown.get(throttleKey) ?? 0;
        if (now - previous >= 30_000) {
          boundedRemember(faqCooldown, throttleKey, now);
          await sendConfigured(
            message.client,
            message.guild.id,
            current.moderationLogChannelId,
            `Custom antispam flag: member ${message.author.id}, channel ${message.channelId}, message ${message.id}. Trigger: ${blocked ? 'keyword' : repeated ? 'repeated messages' : mentions >= config.mentionLimit ? 'mentions' : 'flood'}.`,
          );
        }
      }
      return true;
    }
  }
  if (options.spamOnly) return false;
  if (message.content.trim().length >= 5) awardObservedXp(store, message.guild.id, message.author.id, now);
  if (!config.faqEnabled || !message.channel.isSendable()) return false;
  const keyword = message.content.trim().toLowerCase();
  if (keyword.length > 80) return false;
  const answer = store.get<string>('community.faq', scoped(message.guild.id, keyword));
  if (!answer) return false;
  const faqKey = `${key}:${message.channelId}`;
  if (now - (faqCooldown.get(faqKey) ?? 0) < 30_000) return false;
  boundedRemember(faqCooldown, faqKey, now);
  await message.reply({ content: answer, allowedMentions: { parse: [], repliedUser: false } });
  return false;
}
function greeting(template: string, member: GuildMember | PartialGuildMember): string {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{name}', member.user.username)
    .replaceAll('{server}', member.guild.name);
}
export async function onMemberJoin(member: GuildMember, store: Store): Promise<void> {
  if (member.user.bot || (store.get<string[]>('core.disabled', member.guild.id) ?? []).includes('community'))
    return;
  const config = settings(store, member.guild.id);
  if (config.newcomerRoleId && !member.user.bot) {
    try {
      const role = await member.guild.roles.fetch(config.newcomerRoleId);
      const bot = await member.guild.members.fetchMe();
      if (role && bot.permissions.has(P.ManageRoles)) {
        requireSafeRole(role, bot);
        await member.roles.add(role, 'Configured newcomer role');
      }
    } catch {
      /* Role may have been deleted or moved above bot. */
    }
  }
  await sendMemberWelcome(member, store, () => settings(store, member.guild.id));
}
export async function onMemberLeave(member: GuildMember | PartialGuildMember, store: Store): Promise<void> {
  if ((store.get<string[]>('core.disabled', member.guild.id) ?? []).includes('community')) return;
  const config = settings(store, member.guild.id);
  await sendConfigured(
    member.client,
    member.guild.id,
    config.goodbyeChannelId,
    greeting(config.goodbyeTemplate, member),
  );
}
export function drawGiveaway(entrants: string[], winnerCount: number): string[] {
  const pool = [...new Set(entrants)],
    winners: string[] = [];
  while (pool.length && winners.length < winnerCount)
    winners.push(pool.splice(randomInt(pool.length), 1)[0]!);
  return winners;
}
export async function sweepCommunityTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  await sweepCommunityExtra(client, store, now, allowedGuildIds);
  const allowed = (guildId: string) => !allowedGuildIds.length || allowedGuildIds.includes(guildId);
  const enabled = (guildId: string, category: string) =>
    !(store.get<string[]>('core.disabled', guildId) ?? []).includes(category);
  let processed = 0;
  for (const row of store.list<TemporaryRole>('community.tempRoles')) {
    if (processed >= 100) break;
    const role = row.value;
    const guildId = row.key.split(':')[0]!;
    // Existing time-limited assignments still expire when new community actions are disabled.
    if (!allowed(guildId) || role.expiresAt > now || role.attempts >= 20) continue;
    processed += 1;
    try {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(role.userId).catch((error) => {
        if (typeof error === 'object' && error && 'code' in error && error.code === 10007) return null;
        throw error;
      });
      if (member) await member.roles.remove(role.roleId, 'Temporary role expired');
      store.delete('community.tempRoles', row.key);
    } catch (error) {
      role.attempts += 1;
      role.lastError = error instanceof Error ? error.name : 'RoleExpiryError';
      role.expiresAt = now + Math.min(3_600_000, 30_000 * 2 ** Math.min(role.attempts, 7));
      store.set('community.tempRoles', row.key, role);
    }
  }
  for (const row of store.list<Giveaway>('community.giveaways')) {
    if (processed >= 100) break;
    const giveaway = row.value;
    const guildId = row.key.split(':')[0]!;
    if (!allowed(guildId) || !enabled(guildId, 'community')) continue;
    if (giveaway.status === 'open' && giveaway.endsAt <= now) {
      giveaway.drawing ??= { pool: [...new Set(giveaway.entrants)], winners: [] };
      if ((giveaway.drawing.retryAt ?? 0) > now) continue;
      const progress = giveaway.drawing,
        deadline = Date.now() + 10000;
      let stopped = false;
      for (
        let checked = 0;
        checked < 20 &&
        Date.now() < deadline &&
        progress.pool.length &&
        progress.winners.length < giveaway.winnerCount;
        checked++
      ) {
        progress.pending ??= progress.pool[randomInt(progress.pool.length)]!;
        store.set('community.giveaways', row.key, giveaway);
        try {
          const guild = await client.guilds.fetch(guildId),
            member = await guild.members.fetch({ user: progress.pending, force: true }).catch((error) => {
              if (typeof error === 'object' && error && 'code' in error && error.code === 10007) return null;
              throw error;
            });
          if (!enabled(guildId, 'community')) {
            stopped = true;
            break;
          }
          const current = store.get<Giveaway>('community.giveaways', row.key);
          if (!current || current.status !== 'open') {
            stopped = true;
            break;
          }
          const channel = await guild.channels.fetch(giveaway.channelId, { force: true });
          if (
            !enabled(guildId, 'community') ||
            store.get<Giveaway>('community.giveaways', row.key)?.status !== 'open'
          ) {
            stopped = true;
            break;
          }
          if (
            member &&
            channel?.permissionsFor(member)?.has(P.ViewChannel) &&
            giveawayEligible(store, guildId, giveaway, member, now)
          )
            progress.winners.push(member.id);
          progress.pool = progress.pool.filter((id) => id !== progress.pending);
          delete progress.pending;
          delete progress.retryAt;
          store.set('community.giveaways', row.key, giveaway);
        } catch {
          progress.retryAt = now + 60000;
          store.set('community.giveaways', row.key, giveaway);
          stopped = true;
          break;
        }
      }
      if (stopped || (progress.pool.length && progress.winners.length < giveaway.winnerCount)) continue;
      giveaway.winners = progress.winners;
      giveaway.status = 'drawn';
      delete giveaway.drawing;
      store.set('community.giveaways', row.key, giveaway);
    }
    if (
      giveaway.status !== 'drawn' ||
      giveaway.announced ||
      (giveaway.announcementAttempts ?? 0) >= 5 ||
      (giveaway.announcementRetryAt ?? 0) > now
    )
      continue;
    processed += 1;
    // Mark before send: avoid duplicate prize announcements after a crash; delivery can require manual review.
    giveaway.announced = true;
    giveaway.announcementAttempts = (giveaway.announcementAttempts ?? 0) + 1;
    store.set('community.giveaways', row.key, giveaway);
    const delivered = await sendConfigured(
      client,
      guildId,
      giveaway.channelId,
      `Giveaway ${giveaway.id} ended: ${giveaway.prize}.\n${giveaway.winners?.length ? `Winners: ${giveaway.winners.map((id) => `<@${id}>`).join(', ')}` : 'No eligible entries.'}`,
    );
    if (!delivered) {
      giveaway.announced = false;
      giveaway.announcementRetryAt = now + Math.min(3_600_000, 30_000 * 2 ** giveaway.announcementAttempts);
      store.set('community.giveaways', row.key, giveaway);
    }
  }
  // Recover confirmed creations, but never release an uncertain request automatically.
  for (const row of store.list<TicketReservation>('community.activeTickets')) {
    const [guildId, userId] = row.key.split(':');
    if (!guildId || !userId) continue;
    if (
      !allowed(guildId) ||
      !enabled(guildId, 'support') ||
      row.value.channelId ||
      ticketLocks.get(store)?.has(`opening:${row.key}`) ||
      now - row.value.createdAt <= 600_000 ||
      processed >= 100
    )
      continue;
    processed += 1;
    try {
      const guild = await client.guilds.fetch(guildId),
        channels = await guild.channels.fetch();
      if (!enabled(guildId, 'support') || ticketLocks.get(store)?.has(`opening:${row.key}`)) continue;
      const existing = channels.filter(
        (channel) =>
          channel?.type === ChannelType.GuildText &&
          (row.value.subject
            ? channel.topic === ticketTopic(row.value, userId)
            : channel.topic?.startsWith(`Support request ${row.value.reservation} for ${userId}:`)),
      );
      if (existing.size === 1) saveRecoveredTicket(store, guildId, userId, row.value, existing.first()!.id);
      else {
        const current = store.get<TicketReservation>('community.activeTickets', row.key);
        if (current?.reservation === row.value.reservation && !current.channelId)
          store.set('community.activeTickets', row.key, { ...current, state: 'needs-review' });
      }
    } catch {
      /* Retry reconciliation after the next successful guild fetch. */
    }
  }
  for (const row of store.list<TriviaSession>('community.trivia'))
    if (allowed(row.key.split(':')[0]!) && now - row.value.createdAt >= 300_000)
      store.delete('community.trivia', row.key);
  for (const row of store.list<Giveaway>('community.giveaways'))
    if (allowed(row.key.split(':')[0]!) && row.value.status !== 'open' && now - row.value.endsAt > 30 * DAY)
      store.delete('community.giveaways', row.key);
}
