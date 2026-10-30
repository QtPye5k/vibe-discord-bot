import { createHash } from 'node:crypto';
import { PermissionFlagsBits as P, type GuildBasedChannel, type GuildMember, type Message } from 'discord.js';
import type { Store } from '../core/store.js';

export const EXPLICIT_STRIKES = 'moderation.automatic.strikes';
export const EXPLICIT_VIOLATIONS = 'moderation.automatic.violations';
export interface ExplicitPenalty {
  guildId: string;
  userId: string;
  messageId: string;
  channelId: string;
  caseId: string;
  count: number;
  action: 'warning' | 'timeout' | 'ban';
  state: 'reserved' | 'attempted' | 'completed' | 'blocked' | 'uncertain';
  createdAt: number;
  timeoutUntil?: number;
  warned?: boolean;
  banned?: boolean;
  issue?: string;
}
export interface ExplicitStrikeCount {
  count: number;
  lastCaseId: string;
  updatedAt: number;
}
interface Application {
  message: Message;
  caseId: string;
  /** Includes service cancellation, guild/module scope and the exact policy revision. */
  current: () => boolean;
  wait: <T>(work: Promise<T>) => Promise<T>;
}
export interface ExplicitPenaltyOutcome {
  penalty?: ExplicitPenalty;
  issue?: string;
  duplicate?: boolean;
}
const durations = [0, 5, 15, 30] as const;

/** Serialize one member's progressive sanctions while other members can still be inspected concurrently. */
export function createExplicitPenalties(store: Store) {
  const lanes = new Map<string, Promise<unknown>>();
  async function eligible(
    application: Application,
  ): Promise<{ bot: GuildMember; target: GuildMember } | undefined> {
    if (!application.current() || !application.message.guild || application.message.webhookId) return;
    const { message, wait } = application;
    const [bot, target] = await wait(
      Promise.all([
        message.guild!.members.fetchMe({ force: true }),
        message.guild!.members.fetch({ user: message.author.id, force: true }),
        message.guild!.roles.fetch(),
      ]),
    );
    if (
      !application.current() ||
      target.id !== message.author.id ||
      target.guild.id !== message.guildId ||
      bot.guild.id !== message.guildId ||
      target.id === message.guild!.ownerId ||
      target.id === bot.id ||
      bot.roles.highest.comparePositionTo(target.roles.highest) <= 0
    )
      return;
    return { bot, target };
  }
  async function run(application: Application): Promise<ExplicitPenaltyOutcome> {
    if (!application.current()) return {};
    const { message, caseId, wait, current } = application;
    const guildId = message.guildId!,
      memberKey = `${guildId}:${message.author.id}`,
      violationKey = `${guildId}:${message.channelId}:${message.id}:${message.author.id}`;
    let authority: Awaited<ReturnType<typeof eligible>>;
    try {
      authority = await eligible(application);
    } catch {
      return { issue: current() ? 'explicit-penalty-member-authority-unavailable' : undefined };
    }
    if (!current()) return {};
    if (!authority) return { issue: 'explicit-penalty-member-not-eligible' };
    const existing = store.get<ExplicitPenalty>(EXPLICIT_VIOLATIONS, violationKey);
    if (existing) return { penalty: existing, duplicate: true };
    let warningChannel: GuildBasedChannel | null | undefined;
    try {
      if ((store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, memberKey)?.count ?? 0) === 0)
        warningChannel = await wait(message.guild!.channels.fetch(message.channelId, { force: true }));
      // Recheck after channel I/O and immediately before reserving a violation and dispatching effects.
      authority = await eligible(application);
    } catch {
      return { issue: current() ? 'explicit-penalty-authority-could-not-be-refreshed' : undefined };
    }
    if (!current()) return {};
    if (!authority) return { issue: 'explicit-penalty-member-no-longer-eligible' };
    const penalty = store.transaction(() => {
      const previous = store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, memberKey);
      const count = Math.min(5, (previous?.count ?? 0) + 1),
        now = Date.now();
      const value: ExplicitPenalty = {
        guildId,
        userId: message.author.id,
        messageId: message.id,
        channelId: message.channelId,
        caseId,
        count,
        action: count === 1 ? 'warning' : count < 5 ? 'timeout' : 'ban',
        state: (previous?.count ?? 0) >= 5 ? 'blocked' : 'reserved',
        createdAt: now,
        ...(count > 1 && count < 5 ? { timeoutUntil: now + durations[count - 1]! * 60_000 } : {}),
        ...((previous?.count ?? 0) >= 5
          ? { issue: 'final-explicit-penalty-already-attempted-review-required' }
          : {}),
      };
      // Five durable message identities are sufficient; a terminal target cannot grow this ledger without bound.
      if ((previous?.count ?? 0) >= 5) return value;
      store.set(EXPLICIT_STRIKES, memberKey, {
        count,
        lastCaseId: caseId,
        updatedAt: now,
      } satisfies ExplicitStrikeCount);
      // The message identity deliberately excludes its revision: edits and reprocessing never earn another strike.
      store.set(EXPLICIT_VIOLATIONS, violationKey, value);
      return value;
    });
    const save = () => {
      if (current()) store.set(EXPLICIT_VIOLATIONS, violationKey, penalty);
    };
    if (penalty.state === 'blocked') return { penalty };
    try {
      const { bot, target } = authority;
      if (
        penalty.action === 'warning' &&
        (!warningChannel?.isSendable() ||
          !warningChannel
            .permissionsFor(bot)
            ?.has([P.ViewChannel, warningChannel.isThread() ? P.SendMessagesInThreads : P.SendMessages]))
      ) {
        penalty.state = 'blocked';
        penalty.issue = 'explicit-warning-channel-unavailable';
        save();
        return { penalty };
      }
      if (
        penalty.action === 'timeout' &&
        (!bot.permissions.has(P.ModerateMembers) ||
          !target.moderatable ||
          target.permissions.has(P.Administrator))
      ) {
        penalty.state = 'blocked';
        penalty.issue = 'explicit-timeout-authority-unavailable';
        save();
        return { penalty };
      }
      if (penalty.action === 'ban' && (!bot.permissions.has(P.BanMembers) || !target.bannable)) {
        penalty.state = 'blocked';
        penalty.issue = 'explicit-ban-authority-unavailable';
        save();
        return { penalty };
      }
      const reason = `Automatic explicit-content violation ${penalty.count}/5; case ${createHash('sha256').update(caseId).digest('hex').slice(0, 16)}`;
      if (
        penalty.action === 'timeout' &&
        (target.communicationDisabledUntilTimestamp ?? 0) >= penalty.timeoutUntil!
      ) {
        penalty.timeoutUntil = target.communicationDisabledUntilTimestamp!;
        penalty.state = 'completed';
        save();
        return { penalty };
      }
      penalty.state = 'attempted';
      save();
      if (!current()) return { penalty };
      try {
        if (penalty.action === 'warning') {
          await wait(
            warningChannel!.isSendable()
              ? warningChannel!.send({
                  content: `<@${target.id}> Warning: explicit content is not allowed. This is violation 1 of 5. Further violations receive 5, 15 and 30 minute timeouts; the fifth results in a permanent server ban.`,
                  allowedMentions: { parse: [], users: [target.id] },
                  nonce: createHash('sha256').update(violationKey).digest('hex').slice(0, 24),
                  enforceNonce: true,
                })
              : Promise.reject(new Error('Warning channel unavailable')),
          );
          penalty.warned = true;
        } else if (penalty.action === 'timeout') {
          await wait(target.disableCommunicationUntil(penalty.timeoutUntil!, reason));
        } else {
          await wait(message.guild!.members.ban(target.id, { deleteMessageSeconds: 0, reason }));
          penalty.banned = true;
        }
        penalty.state = 'completed';
      } catch {
        penalty.state = 'uncertain';
        penalty.issue = `explicit-${penalty.action}-result-unknown-review-required`;
      }
    } catch {
      penalty.state = 'blocked';
      penalty.issue = 'explicit-penalty-authority-could-not-be-refreshed';
    }
    save();
    return { penalty };
  }
  return {
    apply(application: Application): Promise<ExplicitPenaltyOutcome> {
      const key = `${application.message.guildId}:${application.message.author.id}`,
        previous = lanes.get(key) ?? Promise.resolve();
      const operation = application.wait(previous.catch(() => {})).then(() => run(application));
      lanes.set(key, operation);
      void operation
        .finally(() => {
          if (lanes.get(key) === operation) lanes.delete(key);
        })
        .catch(() => {});
      return operation;
    },
  };
}
