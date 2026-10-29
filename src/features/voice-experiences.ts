import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import { UserError } from '../core/errors.js';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { VoiceService } from './voice.js';

const QUESTIONS = [
  {
    id: 'arithmetic',
    question: 'What is seven multiplied by eight?',
    answers: ['56', 'fifty six', 'fifty-six'],
  },
  { id: 'japan', question: 'What is the capital city of Japan?', answers: ['Tokyo'] },
  { id: 'triangle', question: 'How many sides does a triangle have?', answers: ['3', 'three'] },
  { id: 'planet', question: 'Which planet in our solar system is called the red planet?', answers: ['Mars'] },
  {
    id: 'ocean',
    question: 'What is the largest ocean on Earth?',
    answers: ['Pacific', 'Pacific Ocean', 'the Pacific Ocean'],
  },
  { id: 'water', question: 'What is the chemical formula for water?', answers: ['H2O', 'H two O'] },
  {
    id: 'minutes',
    question: 'How many minutes are in two hours?',
    answers: ['120', 'one hundred twenty', 'one hundred and twenty'],
  },
  { id: 'hexagon', question: 'How many sides does a hexagon have?', answers: ['6', 'six'] },
] as const;
const questionId = z.enum([
  'arithmetic',
  'japan',
  'triangle',
  'planet',
  'ocean',
  'water',
  'minutes',
  'hexagon',
]);
const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
export const VOICE_TRIVIA_LIMITS = Object.freeze({
  questionMs: 60000,
  scoresMs: 30 * 60000,
  participants: 25,
  attempts: 3,
  servers: 100,
});
interface Trivia {
  revision: string;
  channelId: string;
  question: (typeof QUESTIONS)[number];
  expiresAt: number;
  scoresExpireAt: number;
  pending: boolean;
  answered: boolean;
  attempts: Map<string, number>;
  scores: Map<string, number>;
}

/** Fixed-answer, current-session voice trivia. No generated questions, external statistics or administrative tools. */
export class VoiceExperienceService {
  private readonly trivia = new Map<string, Trivia>();
  private cursor = 0;
  constructor(
    private readonly voice: VoiceService,
    private readonly now: () => number = Date.now,
  ) {}
  private prune(): void {
    for (const [guildId, game] of this.trivia)
      if (game.scoresExpireAt <= this.now()) this.trivia.delete(guildId);
  }
  private current(ctx: ActionContext): Trivia {
    this.prune();
    const game = this.trivia.get(ctx.guild.id);
    if (!game) throw new UserError('No voice trivia session. Start a spoken question first.');
    if (game.revision !== this.voice.sessionRevision(ctx)) {
      this.trivia.delete(ctx.guild.id);
      throw new UserError('Voice trivia was cancelled by a session change or stop.');
    }
    if (game.channelId !== ctx.channelId)
      throw new UserError('Use the text channel where this spoken trivia session was started.');
    return game;
  }
  private scores(game: Trivia) {
    return [...game.scores]
      .map(([userId, points]) => ({ userId, points }))
      .sort((a, b) => b.points - a.points || a.userId.localeCompare(b.userId));
  }
  async start(ctx: ActionContext, id?: z.infer<typeof questionId>): Promise<unknown> {
    if (id !== undefined) questionId.parse(id);
    const fresh = await this.voice.currentContext(ctx),
      revision = this.voice.sessionRevision(fresh);
    this.prune();
    const previous = this.trivia.get(ctx.guild.id);
    if (
      previous?.revision === revision &&
      (previous.pending || (!previous.answered && previous.expiresAt > this.now()))
    )
      throw new UserError('A spoken question is already pending or open for answers.');
    if (!previous && this.trivia.size >= VOICE_TRIVIA_LIMITS.servers)
      throw new UserError('Voice trivia sessions are busy.');
    const state = this.voice.status(fresh) as { playing: string | null; queue: string[]; paused: boolean };
    if (state.playing || state.queue.length || state.paused)
      throw new UserError('Start spoken trivia while voice playback is idle and resumed.');
    const question = id
      ? QUESTIONS.find((value) => value.id === id)!
      : QUESTIONS[this.cursor++ % QUESTIONS.length]!;
    const game: Trivia = {
      revision,
      channelId: ctx.channelId,
      question,
      expiresAt: this.now() + VOICE_TRIVIA_LIMITS.questionMs,
      scoresExpireAt: this.now() + VOICE_TRIVIA_LIMITS.scoresMs,
      pending: true,
      answered: false,
      attempts: new Map(),
      scores: previous?.revision === revision ? previous.scores : new Map(),
    };
    this.trivia.set(ctx.guild.id, game);
    try {
      await this.voice.speak(fresh, `Voice trivia. ${question.question} You have sixty seconds to answer.`);
      await this.voice.currentContext(fresh);
      if (this.current(fresh) !== game) throw new UserError('Spoken trivia question was replaced.');
      game.pending = false;
      game.expiresAt = this.now() + VOICE_TRIVIA_LIMITS.questionMs;
      return {
        questionId: question.id,
        question: question.question,
        expiresAt: game.expiresAt,
        notice:
          'Fixed known answer; at most three guesses per participant. Answer in this text channel or explicitly opt into allowlisted voice commands.',
      };
    } catch (error) {
      if (this.trivia.get(ctx.guild.id) === game) this.trivia.delete(ctx.guild.id);
      throw error;
    }
  }
  async answer(ctx: ActionContext, text: string): Promise<unknown> {
    z.string().trim().min(1).max(100).parse(text);
    const fresh = await this.voice.currentContext(ctx),
      game = this.current(fresh);
    if (game.pending) throw new UserError('The spoken question is still being prepared.');
    if (game.answered || game.expiresAt <= this.now())
      throw new UserError('This question is closed or expired. Start another spoken question.');
    const attempts = game.attempts.get(fresh.member.id) ?? 0;
    if (!attempts && game.attempts.size >= VOICE_TRIVIA_LIMITS.participants)
      throw new UserError('This question has reached its 25-participant limit.');
    if (attempts >= VOICE_TRIVIA_LIMITS.attempts)
      throw new UserError('You have used all three guesses for this question.');
    if (!game.scores.has(fresh.member.id) && game.scores.size >= VOICE_TRIVIA_LIMITS.participants)
      throw new UserError('This session has reached its 25-scored-participant limit.');
    game.attempts.set(fresh.member.id, attempts + 1);
    const correct = game.question.answers.some((answer) => normalize(answer) === normalize(text));
    if (correct) {
      game.answered = true;
      game.scores.set(fresh.member.id, (game.scores.get(fresh.member.id) ?? 0) + 1);
      game.scoresExpireAt = this.now() + VOICE_TRIVIA_LIMITS.scoresMs;
      return { correct: true, answer: game.question.answers[0], scores: this.scores(game) };
    }
    return { correct: false, guessesRemaining: VOICE_TRIVIA_LIMITS.attempts - attempts - 1 };
  }
  async status(ctx: ActionContext): Promise<unknown> {
    const fresh = await this.voice.currentContext(ctx),
      game = this.current(fresh);
    return {
      questionId: game.question.id,
      question: game.question.question,
      pending: game.pending,
      closed: game.answered || game.expiresAt <= this.now(),
      expiresAt: game.expiresAt,
      scores: this.scores(game),
      retention: 'In-memory current voice session only; scores expire after 30 minutes.',
    };
  }
  async stop(ctx: ActionContext): Promise<string> {
    const fresh = await this.voice.currentContext(ctx);
    this.current(fresh);
    this.trivia.delete(fresh.guild.id);
    this.voice.stop(fresh);
    return 'Voice trivia and its in-memory scores cleared; voice playback stopped.';
  }
}

export function registerVoiceExperienceActions(
  registry: ActionRegistry,
  voice: VoiceService,
  options: { now?: () => number } = {},
): VoiceExperienceService {
  const service = new VoiceExperienceService(voice, options.now);
  const base = {
    category: 'voice',
    userPermissions: [] as bigint[],
    botPermissions: [P.ViewChannel, P.Connect, P.Speak],
    risk: 'write' as const,
  };
  registry.register({
    ...base,
    id: 'voice.library',
    risk: 'read',
    description: 'List up to 50 safe file IDs in the fixed operator-approved local PCM16 WAV library.',
    schema: z.strictObject({}),
    execute: (ctx) => voice.library(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.library-play',
    description: 'Queue one fixed approved PCM16 WAV by safe library ID; no user file paths or URLs.',
    schema: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/) }),
    execute: (ctx, input) => voice.playLocal(ctx, input.id),
  });
  registry.register({
    ...base,
    id: 'voice.alert',
    description: 'Queue a short deterministic notice, success or warning tone without an AI request.',
    schema: z.strictObject({ kind: z.enum(['notice', 'success', 'warning']).default('notice') }),
    execute: (ctx, input) => voice.alert(ctx, input.kind),
  });
  registry.register({
    ...base,
    id: 'voice.trivia-start',
    description:
      'Speak one fixed known-answer trivia question in an idle voice session; answers expire after 60 seconds.',
    schema: z.strictObject({ questionId: questionId.optional() }),
    execute: (ctx, input) => service.start(ctx, input.questionId),
  });
  registry.register({
    ...base,
    id: 'voice.trivia-answer',
    description:
      'Submit one of three bounded guesses for the current spoken question; first correct answer earns one session point.',
    schema: z.strictObject({ answer: z.string().trim().min(1).max(100) }),
    execute: (ctx, input) => service.answer(ctx, input.answer),
  });
  registry.register({
    ...base,
    id: 'voice.trivia-status',
    risk: 'read',
    description: 'Show the current spoken question, expiry and bounded in-memory session scores.',
    schema: z.strictObject({}),
    execute: (ctx) => service.status(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.trivia-stop',
    description: 'Clear current voice trivia and scores, cancel pending work and stop playback.',
    schema: z.strictObject({}),
    execute: (ctx) => service.stop(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.attendance.report',
    risk: 'read',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    description:
      'Export a permission-checked local event attendance CSV or retained observed member voice durations; gaps are not reconstructed.',
    schema: z.strictObject({
      eventId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
        .optional(),
      limit: z.number().int().min(1).max(1000).default(1000),
    }),
    execute: async (ctx, input) => {
      if (input.eventId) {
        const outcome = await registry.request(ctx, 'calendar.export', { id: input.eventId });
        if (outcome.status !== 'completed') throw new UserError('Attendance export did not complete.');
        return outcome.result;
      }
      const outcome = await registry.request(ctx, 'analytics.activity', {
        inactiveDays: 0,
        limit: input.limit,
      });
      if (outcome.status !== 'completed' || !Array.isArray(outcome.result))
        throw new UserError('Observed attendance data is unavailable.');
      const rows = outcome.result as { user_id: string; voice_seconds: number; last_seen: number }[];
      const csv = ['user_id,observed_voice_seconds,last_observed_utc'];
      for (const row of rows)
        csv.push(
          [row.user_id, row.voice_seconds, new Date(row.last_seen).toISOString()]
            .map((value) => `"${String(value).replaceAll('"', '""')}"`)
            .join(','),
        );
      return {
        attachment: Buffer.from(csv.join('\r\n')),
        name: 'observed-voice-attendance.csv',
        notice:
          'Retained opt-in observations only. Downtime, disabled collection and missed events create gaps. This is not a complete join/leave log.',
        rows: rows.length,
      };
    },
  });
  return service;
}
