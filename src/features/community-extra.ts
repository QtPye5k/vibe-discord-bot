import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PermissionFlagsBits as P, type Client, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { freshContext, resolveChannel, resolveMember } from '../core/permissions.js';

const id = z.string().regex(/^\d{17,20}$/),
  slug = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  empty = z.strictObject({});
const key = (guildId: string, value: string) => `${guildId}:${value}`;
const DAY = 86400000,
  MAX = 1000000000000;
interface Currency {
  id: string;
  name: string;
  symbol: string;
  maxSupply: number;
  supply: number;
  createdAt: number;
}
interface Wallet {
  balance: number;
  updatedAt: number;
}
const walletKey = (guildId: string, currencyId: string, userId: string) =>
  key(guildId, `${currencyId}:${userId}`);
const balance = (store: Store, guildId: string, currencyId: string, userId: string) =>
  store.get<Wallet>('currency.wallets', walletKey(guildId, currencyId, userId))?.balance ?? 0;
function currency(ctx: ActionContext, id: string) {
  const value = ctx.store.get<Currency>('currency.definitions', key(ctx.guild.id, id));
  if (!value) throw new UserError('Currency is not configured.');
  return value;
}
function ledger(ctx: ActionContext, record: Record<string, unknown>) {
  const records = ctx.store.list('currency.ledger', `${ctx.guild.id}:`);
  if (records.length >= 5000)
    for (const row of records.slice(0, 1000)) ctx.store.delete('currency.ledger', row.key);
  ctx.store.set('currency.ledger', key(ctx.guild.id, randomBytes(8).toString('hex')), {
    ...record,
    actorId: ctx.member.id,
    at: Date.now(),
  });
}
interface Raffle {
  id: string;
  guildId: string;
  authorId: string;
  originChannelId: string;
  channelId: string;
  title: string;
  prize: string;
  freeEntry: true;
  closesAt: number;
  winnerCount: number;
  roleIds: string[];
  minimumAccountDays: number;
  minimumMemberDays: number;
  minimumLevel: number;
  entries: Record<string, { number: number; at: number }>;
  nextNumber: number;
  state: 'open' | 'drawing' | 'drawn' | 'cancelled';
  pool?: string[];
  pendingUser?: string;
  winners: string[];
  drawnAt?: number;
  entryDigest?: string;
  announcement?: 'sending' | 'sent' | 'unknown';
  messageId?: string;
  retryAt?: number;
  lastError?: string;
}
function raffle(ctx: ActionContext, id: string) {
  const row = ctx.store.get<Raffle>('community.raffles', key(ctx.guild.id, id));
  if (!row) throw new UserError('Raffle does not exist.');
  return row;
}
function canEnter(store: Store, row: Raffle, member: GuildMember, now: number): boolean {
  if (member.user.bot || row.roleIds.some((id) => !member.roles.cache.has(id))) return false;
  if (
    row.minimumAccountDays &&
    (!member.user.createdTimestamp || now - member.user.createdTimestamp < row.minimumAccountDays * DAY)
  )
    return false;
  if (
    row.minimumMemberDays &&
    (!member.joinedTimestamp || now - member.joinedTimestamp < row.minimumMemberDays * DAY)
  )
    return false;
  const profile = store.get<{ xp: number }>('community.profiles', key(row.guildId, member.id));
  return Math.floor(Math.sqrt((profile?.xp ?? 0) / 100)) >= row.minimumLevel;
}
const drawings = new WeakMap<Store, Set<string>>();
function currentPolicy(ctx: ActionContext, action: string) {
  if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('community'))
    throw new UserError('Community features are disabled.');
  const policy = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
    'core.actionPolicies',
    key(ctx.guild.id, action),
  );
  if (
    policy &&
    (!policy.enabled ||
      (policy.roleIds.length && !policy.roleIds.some((id) => ctx.member.roles.cache.has(id))) ||
      (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId)))
  )
    throw new UserError('Raffle policy is no longer authorized.');
}
async function draw(ctx: ActionContext, row: Raffle, now: number) {
  let locks = drawings.get(ctx.store);
  if (!locks) {
    locks = new Set();
    drawings.set(ctx.store, locks);
  }
  const rowKey = key(row.guildId, row.id);
  if (locks.has(rowKey)) throw new UserError('This raffle draw is active.');
  locks.add(rowKey);
  try {
    if (row.state === 'drawn' || row.state === 'cancelled') return row;
    if (now < row.closesAt) throw new UserError('The raffle has not closed.');
    ctx = await freshContext(ctx);
    if (!ctx.member.permissions.has(P.ManageGuild))
      throw new UserError('Current raffle manager authority is required.');
    await resolveChannel(ctx, row.channelId);
    currentPolicy({ ...ctx, channelId: row.originChannelId }, 'raffle.create');
    if (row.state === 'open') {
      row.state = 'drawing';
      row.pool = Object.keys(row.entries);
      row.entryDigest = createHash('sha256').update(JSON.stringify(row.entries)).digest('hex');
      ctx.store.set('community.raffles', rowKey, row);
    }
    const deadline = Date.now() + 10000;
    for (
      let checked = 0;
      checked < 10 && Date.now() < deadline && row.winners.length < row.winnerCount && row.pool!.length;
      checked++
    ) {
      row.pendingUser ??= row.pool![randomInt(row.pool!.length)]!;
      ctx.store.set('community.raffles', rowKey, row);
      let member: GuildMember | null;
      try {
        member = await resolveMember(ctx, row.pendingUser);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) member = null;
        else throw error;
      }
      ctx = await freshContext(ctx);
      if (!ctx.member.permissions.has(P.ManageGuild))
        throw new UserError('Raffle manager authority changed.');
      const latest = raffle(ctx, row.id);
      if (latest.state !== 'drawing') throw new UserError('The raffle changed during drawing.');
      currentPolicy({ ...ctx, channelId: row.originChannelId }, 'raffle.create');
      if (member && canEnter(ctx.store, row, member, now)) row.winners.push(member.id);
      row.pool = row.pool!.filter((id) => id !== row.pendingUser);
      delete row.pendingUser;
      ctx.store.set('community.raffles', rowKey, row);
    }
    if (row.winners.length >= row.winnerCount || !row.pool!.length) {
      row.state = 'drawn';
      row.drawnAt = now;
      delete row.pool;
      delete row.pendingUser;
      ctx.store.set('community.raffles', rowKey, row);
    }
    return row;
  } finally {
    locks.delete(rowKey);
  }
}
async function announce(ctx: ActionContext, row: Raffle) {
  if (row.state !== 'drawn' || row.announcement) return;
  ctx = await freshContext(ctx);
  if (!ctx.member.permissions.has(P.ManageGuild))
    throw new UserError('Current raffle manager authority is required.');
  const channel = await resolveChannel(ctx, row.channelId);
  if (!channel.isSendable() || !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages))
    throw new UserError('Raffle announcement channel is unavailable.');
  const latest = raffle(ctx, row.id);
  if (latest.state !== 'drawn' || latest.announcement) return;
  currentPolicy({ ...ctx, channelId: row.originChannelId }, 'raffle.create');
  row.announcement = 'sending';
  ctx.store.set('community.raffles', key(row.guildId, row.id), row);
  try {
    const message = await channel.send({
      content: `Free-entry raffle ${row.id}: ${row.title}\nPrize: ${row.prize}\nWinners: ${row.winners.length ? row.winners.join(', ') : 'No eligible entries.'}`,
      allowedMentions: { parse: [] },
      nonce: createHash('sha256').update(`raffle:${row.guildId}:${row.id}`).digest('hex').slice(0, 24),
      enforceNonce: true,
    });
    row.announcement = 'sent';
    row.messageId = message.id;
  } catch {
    row.announcement = 'unknown';
    row.lastError = 'AnnouncementOutcomeUnknown';
  }
  ctx.store.set('community.raffles', key(row.guildId, row.id), row);
}
export function registerCommunityExtraActions(registry: ActionRegistry) {
  const base = { category: 'community', userPermissions: [], botPermissions: [], risk: 'write' as const };
  registry.register({
    ...base,
    id: 'currency.create',
    description:
      'Create a named integer-denomination fictional currency with an explicit supply cap; no cash value or purchase mechanism.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      id: slug,
      name: z.string().min(1).max(50),
      symbol: z.string().min(1).max(12),
      maxSupply: z.number().int().min(1).max(MAX).default(MAX),
    }),
    execute: (ctx, input) => {
      if (ctx.store.get('currency.definitions', key(ctx.guild.id, input.id)))
        throw new UserError('Currency already exists.');
      if (ctx.store.list('currency.definitions', `${ctx.guild.id}:`).length >= 20)
        throw new UserError('Limit: 20 fictional currencies per server.');
      const row: Currency = { ...input, supply: 0, createdAt: Date.now() };
      ctx.store.set('currency.definitions', key(ctx.guild.id, input.id), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'currency.list',
    risk: 'read',
    description: 'List this server’s fictional currency definitions and supply totals.',
    schema: empty,
    execute: (ctx) => ctx.store.list('currency.definitions', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...base,
    id: 'currency.history',
    risk: 'read',
    description:
      'Read your retained fictional-currency ledger entries, without disclosing unrelated members’ transactions.',
    schema: z.strictObject({ currencyId: slug }),
    execute: (ctx, input) => {
      currency(ctx, input.currencyId);
      return ctx.store
        .list<Record<string, unknown>>('currency.ledger', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter(
          (row) =>
            row.currencyId === input.currencyId &&
            (row.actorId === ctx.member.id ||
              row.userId === ctx.member.id ||
              row.fromUserId === ctx.member.id),
        )
        .sort((a, b) => Number(b.at) - Number(a.at))
        .slice(0, 100);
    },
  });
  registry.register({
    ...base,
    id: 'currency.delete',
    risk: 'destructive',
    description: 'Delete a fictional currency only after its outstanding supply has been burned to zero.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ currencyId: slug }),
    execute: (ctx, input) => {
      const row = currency(ctx, input.currencyId);
      if (row.supply !== 0) throw new UserError('Burn outstanding balances before deleting the currency.');
      for (const wallet of ctx.store.list('currency.wallets', `${ctx.guild.id}:${row.id}:`))
        ctx.store.delete('currency.wallets', wallet.key);
      ctx.store.delete('currency.definitions', key(ctx.guild.id, row.id));
      return { deleted: row.id };
    },
  });
  registry.register({
    ...base,
    id: 'currency.balance',
    risk: 'read',
    description: 'Read a current member’s balance in one configured fictional currency.',
    schema: z.strictObject({ currencyId: slug, userId: id.optional() }),
    execute: async (ctx, input) => {
      currency(ctx, input.currencyId);
      const user = await resolveMember(ctx, input.userId ?? ctx.member.id);
      return {
        currencyId: input.currencyId,
        userId: user.id,
        balance: balance(ctx.store, ctx.guild.id, input.currencyId, user.id),
      };
    },
  });
  registry.register({
    ...base,
    id: 'currency.adjust',
    description:
      'Mint or burn a reviewed number of fictional currency units for a current member, checking supply and balance atomically.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      currencyId: slug,
      userId: id,
      delta: z
        .number()
        .int()
        .min(-MAX)
        .max(MAX)
        .refine((value) => value !== 0),
      reason: z.string().min(1).max(400),
    }),
    execute: async (ctx, input) => {
      const user = await resolveMember(ctx, input.userId);
      if (user.user.bot) throw new UserError('Fictional wallets are for human members.');
      return ctx.store.transaction(() => {
        const row = currency(ctx, input.currencyId),
          next = balance(ctx.store, ctx.guild.id, row.id, user.id) + input.delta,
          supply = row.supply + input.delta;
        if (!Number.isSafeInteger(next) || next < 0 || next > MAX || supply < 0 || supply > row.maxSupply)
          throw new UserError('Balance or supply cap would be exceeded.');
        row.supply = supply;
        ctx.store.set('currency.definitions', key(ctx.guild.id, row.id), row);
        ctx.store.set('currency.wallets', walletKey(ctx.guild.id, row.id, user.id), {
          balance: next,
          updatedAt: Date.now(),
        });
        ledger(ctx, { kind: 'adjust', ...input });
        return { currencyId: row.id, userId: user.id, balance: next, supply };
      });
    },
  });
  registry.register({
    ...base,
    id: 'currency.transfer',
    description:
      'Transfer fictional units to another current human member using an atomic debit/credit transaction.',
    schema: z.strictObject({ currencyId: slug, userId: id, amount: z.number().int().min(1).max(MAX) }),
    execute: async (ctx, input) => {
      if (input.userId === ctx.member.id) throw new UserError('Choose another member.');
      const target = await resolveMember(ctx, input.userId);
      if (target.user.bot) throw new UserError('Fictional wallets are for human members.');
      return ctx.store.transaction(() => {
        currency(ctx, input.currencyId);
        const from = balance(ctx.store, ctx.guild.id, input.currencyId, ctx.member.id),
          to = balance(ctx.store, ctx.guild.id, input.currencyId, target.id);
        if (from < input.amount || to + input.amount > MAX)
          throw new UserError('Insufficient balance or recipient capacity.');
        ctx.store.set('currency.wallets', walletKey(ctx.guild.id, input.currencyId, ctx.member.id), {
          balance: from - input.amount,
          updatedAt: Date.now(),
        });
        ctx.store.set('currency.wallets', walletKey(ctx.guild.id, input.currencyId, target.id), {
          balance: to + input.amount,
          updatedAt: Date.now(),
        });
        ledger(ctx, { kind: 'transfer', ...input, fromUserId: ctx.member.id });
        return {
          currencyId: input.currencyId,
          amount: input.amount,
          fromUserId: ctx.member.id,
          toUserId: target.id,
        };
      });
    },
  });
  registry.register({
    ...base,
    id: 'raffle.create',
    description:
      'Create a free-entry raffle with one numbered entry per eligible member, a fixed deadline, immutable prizes and current-eligibility winner checks.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      id: slug,
      title: z.string().min(1).max(100),
      prize: z.string().min(1).max(300),
      freeEntry: z.literal(true),
      channelId: id,
      closesAt: z.iso.datetime(),
      winnerCount: z.number().int().min(1).max(20).default(1),
      roleIds: z.array(id).max(10).default([]),
      minimumAccountDays: z.number().int().min(0).max(3650).default(0),
      minimumMemberDays: z.number().int().min(0).max(3650).default(0),
      minimumLevel: z.number().int().min(0).max(1000).default(0),
    }),
    execute: async (ctx, input) => {
      const closesAt = Date.parse(input.closesAt);
      if (closesAt < Date.now() + 60000 || closesAt > Date.now() + 30 * DAY)
        throw new UserError('Raffles must close between one minute and 30 days from now.');
      const channel = await resolveChannel(ctx, input.channelId);
      if (!channel.isSendable() || !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages))
        throw new UserError('The bot must be able to announce in that channel.');
      for (const roleId of input.roleIds)
        if (!(await ctx.guild.roles.fetch(roleId))) throw new UserError('Eligibility role is unavailable.');
      if (ctx.store.get('community.raffles', key(ctx.guild.id, input.id)))
        throw new UserError('Raffle ID already exists.');
      if (ctx.store.list('community.raffles', `${ctx.guild.id}:`).length >= 100)
        throw new UserError('Limit: 100 retained raffles per server.');
      const row: Raffle = {
        ...input,
        closesAt,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        entries: {},
        nextNumber: 1,
        state: 'open',
        winners: [],
      };
      ctx.store.set('community.raffles', key(ctx.guild.id, row.id), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'raffle.enter',
    description:
      'Enter a free raffle once, receiving a persistent numbered receipt after current age, membership, role and level eligibility checks.',
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const row = raffle(ctx, input.id);
      await resolveChannel(ctx, row.channelId);
      if (row.state !== 'open' || row.closesAt <= Date.now())
        throw new UserError('Raffle entries are closed.');
      if (!canEnter(ctx.store, row, ctx.member, Date.now()))
        throw new UserError('You do not meet this raffle’s eligibility rules.');
      return ctx.store.transaction(() => {
        const latest = raffle(ctx, input.id);
        if (latest.state !== 'open' || latest.closesAt <= Date.now())
          throw new UserError('Raffle entries are closed.');
        if (latest.entries[ctx.member.id])
          return { raffleId: row.id, entry: latest.entries[ctx.member.id], alreadyEntered: true };
        if (Object.keys(latest.entries).length >= 1000)
          throw new UserError('Raffle entrant capacity reached.');
        const entry = { number: latest.nextNumber++, at: Date.now() };
        latest.entries[ctx.member.id] = entry;
        ctx.store.set('community.raffles', key(ctx.guild.id, row.id), latest);
        return { raffleId: row.id, entry };
      });
    },
  });
  registry.register({
    ...base,
    id: 'raffle.withdraw',
    description: 'Withdraw your own entry before a free raffle closes.',
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) => {
      const row = raffle(ctx, input.id);
      if (row.state !== 'open' || row.closesAt <= Date.now())
        throw new UserError('The draw has already started.');
      delete row.entries[ctx.member.id];
      ctx.store.set('community.raffles', key(ctx.guild.id, row.id), row);
      return { withdrawn: true };
    },
  });
  registry.register({
    ...base,
    id: 'raffle.draw',
    description:
      'Continue a closed free-entry raffle’s durable cryptographic draw; rechecks selected winners and preserves interrupted candidate choices.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const row = await draw(ctx, raffle(ctx, input.id), Date.now());
      await announce(ctx, row);
      return { ...row, entries: undefined, pool: undefined };
    },
  });
  registry.register({
    ...base,
    id: 'raffle.view',
    risk: 'read',
    description:
      'Read raffle rules, entry count, your receipt and finalized winner/announcement state without exposing the entrant list.',
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const row = raffle(ctx, input.id);
      await resolveChannel(ctx, row.channelId);
      const { entries, pool: _pool, pendingUser: _pending, ...view } = row;
      return {
        ...view,
        winners: row.state === 'drawn' ? row.winners : [],
        entrantCount: Object.keys(entries).length,
        ownEntry: entries[ctx.member.id] ?? null,
      };
    },
  });
  registry.register({
    ...base,
    id: 'raffle.cancel',
    description: 'Cancel an open or drawing raffle without selecting or announcing any further winners.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) => {
      const row = raffle(ctx, input.id);
      if (row.state === 'drawn') throw new UserError('Finalized draws are immutable.');
      row.state = 'cancelled';
      ctx.store.set('community.raffles', key(ctx.guild.id, row.id), row);
      return { cancelled: true };
    },
  });
  registry.register({
    ...base,
    id: 'raffle.export',
    risk: 'read',
    description:
      'Export a free raffle’s retained entry receipts, rules and finalized draw record for an authorized server manager.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const row = raffle(ctx, input.id);
      await resolveChannel(ctx, row.channelId);
      return { attachment: Buffer.from(JSON.stringify(row, null, 2)), name: `raffle-${row.id}.json` };
    },
  });
  registry.register({
    ...base,
    id: 'raffle.delete',
    risk: 'destructive',
    description:
      'Delete a finalized or cancelled raffle’s retained records after your separate export/retention review.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ id: slug, reviewedRetention: z.literal(true) }),
    execute: (ctx, input) => {
      const row = raffle(ctx, input.id);
      if (!['drawn', 'cancelled'].includes(row.state))
        throw new UserError('Cancel the raffle before deleting active records.');
      ctx.store.delete('community.raffles', key(ctx.guild.id, row.id));
      return { deleted: row.id };
    },
  });
}
const sweeping = new WeakSet<Store>();
export async function sweepCommunityExtra(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
) {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  try {
    let count = 0;
    const deadline = Date.now() + 20000;
    for (const { key: rowKey, value: row } of store.list<Raffle>('community.raffles')) {
      if (count >= 5 || Date.now() >= deadline) break;
      if (
        (allowedGuildIds.length && !allowedGuildIds.includes(row.guildId)) ||
        (store.get<string[]>('core.disabled', row.guildId) ?? []).includes('community') ||
        row.closesAt > now ||
        row.state === 'cancelled' ||
        (row.state === 'drawn' && row.announcement) ||
        (row.retryAt ?? 0) > now
      )
        continue;
      count++;
      try {
        const guild = await client.guilds.fetch(row.guildId),
          member = await guild.members.fetch({ user: row.authorId, force: true });
        await guild.members.fetchMe({ force: true });
        const ctx = { client, store, guild, member, channelId: row.originChannelId };
        await resolveChannel(ctx, ctx.channelId);
        const current = await draw(ctx, row, now);
        await announce(ctx, current);
      } catch (error) {
        const current = store.get<Raffle>('community.raffles', rowKey);
        if (current && current.state !== 'cancelled') {
          current.retryAt = now + 60000;
          current.lastError = error instanceof Error ? error.name : 'Error';
          if (current.announcement === 'sending') current.announcement = 'unknown';
          store.set('community.raffles', rowKey, current);
        }
      }
    }
  } finally {
    sweeping.delete(store);
  }
}
export function eraseCommunityExtra(ctx: ActionContext) {
  for (const { value: row } of ctx.store.list<Currency>('currency.definitions', `${ctx.guild.id}:`)) {
    const k = walletKey(ctx.guild.id, row.id, ctx.member.id),
      wallet = ctx.store.get<Wallet>('currency.wallets', k);
    if (wallet) {
      row.supply -= wallet.balance;
      ctx.store.set('currency.definitions', key(ctx.guild.id, row.id), row);
      ctx.store.delete('currency.wallets', k);
    }
  }
  for (const { key: k, value: row } of ctx.store.list<Raffle>('community.raffles', `${ctx.guild.id}:`))
    if (row.state === 'open' && row.entries[ctx.member.id]) {
      delete row.entries[ctx.member.id];
      ctx.store.set('community.raffles', k, row);
    }
  for (const { key: k, value: row } of ctx.store.list<Record<string, unknown>>(
    'currency.ledger',
    `${ctx.guild.id}:`,
  ))
    if ([row.actorId, row.userId, row.fromUserId].includes(ctx.member.id))
      ctx.store.delete('currency.ledger', k);
}
