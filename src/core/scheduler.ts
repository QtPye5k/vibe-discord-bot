import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { Store } from './store.js';
import type { ActionRegistry } from './registry.js';
import { resolveChannel } from './permissions.js';
import { UserError } from './errors.js';
import type { Logger } from './logger.js';

export interface Job {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string;
  content: string;
  due_at: number;
  interval_ms: number | null;
  attempts: number;
  status: string;
  last_error: string | null;
  nonce: string;
}
export class Scheduler {
  private running = false;
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly allowedGuildIds: readonly string[] = [],
  ) {
    store.db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const guildClause = this.allowedGuildIds.length
        ? ` AND guild_id IN (${this.allowedGuildIds.map(() => '?').join(',')})`
        : '';
      const due = this.store.db
        .prepare(
          `SELECT * FROM jobs WHERE status='pending' AND due_at<=? AND retry_at<=? ${guildClause}
        AND NOT EXISTS (SELECT 1 FROM kv k,json_each(k.value) j WHERE k.namespace='core.disabled' AND k.key=jobs.guild_id AND j.value='automation')
        ORDER BY due_at LIMIT 10`,
        )
        .all(now, now, ...this.allowedGuildIds) as unknown as Job[];
      for (const job of due) {
        if (
          this.store.db
            .prepare("UPDATE jobs SET status='running' WHERE id=? AND status='pending'")
            .run(job.id).changes !== 1
        )
          continue;
        try {
          if (this.allowedGuildIds.length && !this.allowedGuildIds.includes(job.guild_id))
            throw new UserError('Reminder server is outside the configured server allowlist.');
          const guild = await this.client.guilds.fetch(job.guild_id);
          const member = await guild.members.fetch({ user: job.user_id, force: true });
          await guild.members.fetchMe({ force: true });
          const channel = await resolveChannel(
            { client: this.client, guild, member, channelId: job.channel_id, store: this.store },
            job.channel_id,
          );
          if (
            !channel.isTextBased() ||
            !channel.isSendable() ||
            !channel.permissionsFor(member)?.has(P.SendMessages) ||
            !channel.permissionsFor(guild.members.me!)?.has(P.SendMessages)
          )
            throw new UserError('Reminder permissions no longer available.');
          if (this.store.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)?.status !== 'running')
            continue;
          if ((this.store.get<string[]>('core.disabled', job.guild_id) ?? []).includes('automation')) {
            this.store.db
              .prepare("UPDATE jobs SET status='pending' WHERE id=? AND status='running'")
              .run(job.id);
            continue;
          }
          const nonce = job.nonce || job.id;
          await channel.send({
            content: `Reminder for <@${job.user_id}>: ${job.content}`,
            allowedMentions: { parse: [] },
            nonce,
            enforceNonce: true,
          });
          if (job.interval_ms) {
            const next =
              job.due_at + (Math.floor((now - job.due_at) / job.interval_ms) + 1) * job.interval_ms;
            this.store.db
              .prepare(
                "UPDATE jobs SET status='pending',due_at=?,nonce=?,retry_at=0,attempts=0,last_error=NULL WHERE id=? AND status='running'",
              )
              .run(next, randomBytes(8).toString('hex'), job.id);
          } else
            this.store.db
              .prepare("UPDATE jobs SET status='done' WHERE id=? AND status='running'")
              .run(job.id);
        } catch (error) {
          const attempts = job.attempts + 1;
          const retry = !(error instanceof UserError) && attempts < 3;
          this.store.db
            .prepare(
              "UPDATE jobs SET status=?,attempts=?,last_error=?,retry_at=? WHERE id=? AND status='running'",
            )
            .run(
              retry ? 'pending' : 'failed',
              attempts,
              error instanceof Error ? error.name : 'Error',
              now + 30000 * 2 ** attempts,
              job.id,
            );
          this.logger.error('reminder.failed', error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
export function registerScheduleActions(registry: ActionRegistry): void {
  registry.register({
    id: 'reminder.create',
    category: 'automation',
    description: 'Create a durable reminder; dueAt is ISO-8601 with timezone. Optional repeating interval.',
    schema: z.strictObject({
      content: z.string().min(1).max(1500),
      dueAt: z.iso.datetime({ offset: true }),
      intervalMinutes: z.number().int().min(5).max(43200).optional(),
      channelId: z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
    }),
    userPermissions: [],
    botPermissions: [P.SendMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const due = Date.parse(input.dueAt);
      if (due < Date.now() + 5000 || due > Date.now() + 365 * 86400000)
        throw new UserError('Reminder must be 5 seconds to 365 days in the future.');
      const count = Number(
        ctx.store.db
          .prepare("SELECT count(*) AS n FROM jobs WHERE guild_id=? AND status IN ('pending','running')")
          .get(ctx.guild.id)?.n,
      );
      const own = Number(
        ctx.store.db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE guild_id=? AND user_id=? AND status IN ('pending','running')",
          )
          .get(ctx.guild.id, ctx.member.id)?.n,
      );
      if (count >= 100 || own >= 25)
        throw new UserError('Active reminder limit reached (25 per person, 100 per server).');
      const channel = await resolveChannel(ctx, input.channelId ?? ctx.channelId);
      if (
        !channel.isTextBased() ||
        !channel.isSendable() ||
        !channel.permissionsFor(ctx.member)?.has(P.SendMessages)
      )
        throw new UserError('Choose a channel where you can send messages.');
      const id = randomBytes(6).toString('hex');
      ctx.store.db
        .prepare(
          'INSERT INTO jobs(id,guild_id,user_id,channel_id,content,due_at,interval_ms,nonce) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          ctx.guild.id,
          ctx.member.id,
          channel.id,
          input.content,
          due,
          input.intervalMinutes ? input.intervalMinutes * 60000 : null,
          randomBytes(8).toString('hex'),
        );
      return { id, dueAt: new Date(due).toISOString(), repeats: !!input.intervalMinutes };
    },
  });
  registry.register({
    id: 'reminder.list',
    category: 'automation',
    description: 'List your reminders in this server.',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: (ctx) =>
      ctx.store.db
        .prepare(
          'SELECT id,channel_id,content,due_at,interval_ms,status,last_error FROM jobs WHERE guild_id=? AND user_id=? ORDER BY due_at DESC LIMIT 50',
        )
        .all(ctx.guild.id, ctx.member.id),
  });
  registry.register({
    id: 'reminder.cancel',
    category: 'automation',
    description: 'Cancel one of your own reminders.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{12}$/) }),
    userPermissions: [],
    botPermissions: [],
    risk: 'write',
    execute: (ctx, input) => {
      const result = ctx.store.db
        .prepare(
          "UPDATE jobs SET status='cancelled' WHERE id=? AND guild_id=? AND user_id=? AND status IN ('pending','running')",
        )
        .run(input.id, ctx.guild.id, ctx.member.id);
      if (!result.changes) throw new UserError('Active reminder not found.');
      return { cancelled: input.id };
    },
  });
}
