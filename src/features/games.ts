import { randomBytes, randomInt } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits as P,
  type Client,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import type { AiService } from './ai.js';
import { resolveChannel, resolveMember, resolveRole } from '../core/permissions.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
import { UserError } from '../core/errors.js';
import { getProfile, levelForXp } from './community.js';
const id = z.string().regex(/^\d{17,20}$/),
  token = z.string().regex(/^[a-f0-9]{12}$/),
  slug = z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,49}$/)
    .refine((value) => !['constructor', 'prototype'].includes(value), 'Reserved item key'),
  empty = z.strictObject({});
const kinds = [
  'tic-tac-toe',
  'connect-four',
  'hangman',
  'number-guess',
  'word-chain',
  'puzzle',
  'adventure',
  'boss',
  'story',
] as const;
type Kind = (typeof kinds)[number];
export interface Game {
  id: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  kind: Kind;
  players: string[];
  invitedUserId?: string;
  status: 'waiting' | 'active' | 'won' | 'lost' | 'draw';
  turn: number;
  revision: number;
  board: number[];
  createdAt: number;
  updatedAt: number;
  secret?: string;
  guesses: string[];
  attempts: number;
  question?: string;
  room: number;
  items: string[];
  health: Record<string, number>;
  bossHp: number;
  story: string[];
  winnerId?: string;
  messageId?: string;
}
interface Stats {
  wins: number;
  losses: number;
  draws: number;
  played: number;
  badges: string[];
  rewardDay: string;
  rewarded: number;
}
const words = [
  'galaxy',
  'harmony',
  'orchard',
  'compass',
  'lantern',
  'sapphire',
  'penguin',
  'volcano',
  'library',
  'crystal',
  'thunder',
  'journey',
  'meadow',
  'pyramid',
  'harvest',
  'whisper',
];
const key = (guild: string, user: string) => `${guild}:${user}`;
const initialStats = (): Stats => ({
  wins: 0,
  losses: 0,
  draws: 0,
  played: 0,
  badges: [],
  rewardDay: '',
  rewarded: 0,
});
function disabled(store: Store, guildId: string): boolean {
  return (store.get<string[]>('core.disabled', guildId) ?? []).includes('games');
}
function requireGame(ctx: ActionContext, value: string, allowExpired = false): Game {
  const game = ctx.store.get<Game>('games.sessions', key(ctx.guild.id, value));
  if (!game) throw new UserError('Game not found in this server.');
  if (!allowExpired && game.updatedAt < Date.now() - 86400000 && ['waiting', 'active'].includes(game.status))
    throw new UserError('This game expired after 24 hours of inactivity.');
  return game;
}
export function publicGame(game: Game): Record<string, unknown> {
  return {
    id: game.id,
    kind: game.kind,
    status: game.status,
    players: game.players,
    invitedUserId: game.invitedUserId,
    currentPlayer: game.players[game.turn % game.players.length],
    revision: game.revision,
    board: game.board.length ? game.board : undefined,
    guesses: game.guesses,
    attempts: game.attempts,
    question: game.question,
    word:
      game.kind === 'hangman'
        ? game.secret
            ?.split('')
            .map((letter) => (game.guesses.includes(letter) || game.status !== 'active' ? letter : '_'))
            .join(' ')
        : undefined,
    range: game.kind === 'number-guess' ? '1–100' : undefined,
    room: [
      'Entrance: north to forest, east to cave.',
      'Forest: search for a key, south to entrance.',
      'Cave: attack the guardian, east to vault, west to entrance.',
      'Vault: open the treasure with a key, west to cave.',
    ][game.room],
    items: game.items,
    health: game.health,
    bossHp: ['boss', 'adventure'].includes(game.kind) ? game.bossHp : undefined,
    story: game.story.slice(-3),
    winnerId: game.winnerId,
  };
}
function updateInventory(store: Store, guildId: string, userId: string, item: string, amount: number): void {
  const inventory = store.get<Record<string, number>>('community.inventory', key(guildId, userId)) ?? {};
  const next = (inventory[item] ?? 0) + amount;
  if (!Number.isSafeInteger(next) || next < 0 || next > 1000000)
    throw new UserError('Inventory balance is insufficient or would exceed its limit.');
  if (next) inventory[item] = next;
  else delete inventory[item];
  store.set('community.inventory', key(guildId, userId), inventory);
}
function coins(store: Store, guildId: string, userId: string, change: number): number {
  const profile = getProfile(store, guildId, userId);
  if (
    !Number.isSafeInteger(profile.balance + change) ||
    profile.balance + change < 0 ||
    profile.balance + change > 1e12
  )
    throw new UserError('Insufficient fictional coins or balance limit reached.');
  profile.balance += change;
  store.set('community.profiles', key(guildId, userId), profile);
  return profile.balance;
}
function finishGame(store: Store, game: Game): void {
  const day = new Date().toISOString().slice(0, 10);
  for (const userId of game.players) {
    const stats = store.get<Stats>('games.stats', key(game.guildId, userId)) ?? initialStats();
    stats.played++;
    const competitive = ['tic-tac-toe', 'connect-four'].includes(game.kind);
    const won = game.status === 'won' && (!competitive || game.winnerId === userId);
    if (game.status === 'draw') stats.draws++;
    else if (won) stats.wins++;
    else stats.losses++;
    if (won && !stats.badges.includes('first_win')) stats.badges.push('first_win');
    if (stats.wins >= 10 && !stats.badges.includes('ten_wins')) stats.badges.push('ten_wins');
    if (stats.rewardDay !== day) {
      stats.rewardDay = day;
      stats.rewarded = 0;
    }
    if (stats.rewarded < 3) {
      coins(
        store,
        game.guildId,
        userId,
        Math.max(0, Math.min(won ? 20 : 5, 1e12 - getProfile(store, game.guildId, userId).balance)),
      );
      stats.rewarded++;
    }
    store.set('games.stats', key(game.guildId, userId), stats);
  }
}
export function boardWinner(board: readonly number[], columns: number, rows: number, length: number): number {
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const value = board[row * columns + column];
      if (!value) continue;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [-1, 1],
      ]) {
        let count = 0;
        for (let n = 0; n < length; n++) {
          const x = column + n * dx!,
            y = row + n * dy!;
          if (x < 0 || x >= columns || y < 0 || y >= rows || board[y * columns + x] !== value) break;
          count++;
        }
        if (count === length) return value;
      }
    }
  return 0;
}
export function applyGameMove(store: Store, game: Game, userId: string, input: string): Game {
  if (game.status !== 'active' || !game.players.includes(userId))
    throw new UserError('Join an active game before moving.');
  const turnBased = ['tic-tac-toe', 'connect-four', 'word-chain', 'boss'].includes(game.kind);
  if (turnBased && game.players[game.turn % game.players.length] !== userId)
    throw new UserError('It is another player’s turn.');
  let value = input.toLowerCase().trim();
  if (['tic-tac-toe', 'connect-four'].includes(game.kind)) {
    if (!/^\d{1,2}$/.test(value)) throw new UserError('Choose a numbered cell or column.');
    let position = Number(value);
    const player = game.players.indexOf(userId) + 1;
    if (game.kind === 'tic-tac-toe') {
      if (position < 0 || position > 8 || game.board[position])
        throw new UserError('Choose an empty cell from 0 to 8.');
    } else {
      if (position < 0 || position > 6) throw new UserError('Choose a column from 0 to 6.');
      let row = 5;
      while (row >= 0 && game.board[row * 7 + position]) row--;
      if (row < 0) throw new UserError('This column is full.');
      position = row * 7 + position;
    }
    game.board[position] = player;
    const winner = boardWinner(
      game.board,
      game.kind === 'tic-tac-toe' ? 3 : 7,
      game.kind === 'tic-tac-toe' ? 3 : 6,
      game.kind === 'tic-tac-toe' ? 3 : 4,
    );
    if (winner) {
      game.status = 'won';
      game.winnerId = game.players[winner - 1];
    } else if (game.board.every(Boolean)) game.status = 'draw';
  } else if (game.kind === 'hangman') {
    if (!/^[a-z]$/.test(value) || game.guesses.includes(value))
      throw new UserError('Guess one previously unused letter.');
    game.guesses.push(value);
    if (!game.secret!.includes(value)) game.attempts--;
    if ([...game.secret!].every((letter) => game.guesses.includes(letter))) game.status = 'won';
    else if (!game.attempts) game.status = 'lost';
  } else if (game.kind === 'number-guess') {
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100)
      throw new UserError('Guess an integer from 1 to 100.');
    value = String(Number(value));
    if (game.guesses.includes(value)) throw new UserError('This number was already guessed.');
    game.guesses.push(value);
    game.attempts--;
    if (value === game.secret) game.status = 'won';
    else game.question = Number(value) < Number(game.secret) ? 'Try a higher number.' : 'Try a lower number.';
    if (!game.attempts && game.status === 'active') game.status = 'lost';
  } else if (game.kind === 'puzzle') {
    if (!/^-?\d{1,6}$/.test(value)) throw new UserError('Enter an integer answer.');
    value = String(Number(value));
    game.attempts--;
    if (value === game.secret) game.status = 'won';
    else if (!game.attempts) game.status = 'lost';
  } else if (game.kind === 'word-chain') {
    if (
      !/^[a-z]{3,30}$/.test(value) ||
      game.guesses.includes(value) ||
      (game.secret && !value.startsWith(game.secret))
    )
      throw new UserError(
        `Use a new alphabetic word starting with ${game.secret ?? 'any letter'}. This game enforces chaining, not a dictionary.`,
      );
    game.guesses.push(value);
    game.secret = value.at(-1);
    if (game.guesses.length >= 20) game.status = 'won';
  } else if (game.kind === 'adventure') {
    if (value === 'north' && game.room === 0) game.room = 1;
    else if (value === 'south' && game.room === 1) game.room = 0;
    else if (value === 'east' && game.room === 0) game.room = 2;
    else if (value === 'west' && game.room === 2) game.room = 0;
    else if (value === 'east' && game.room === 2) game.room = 3;
    else if (value === 'west' && game.room === 3) game.room = 2;
    else if (value === 'search' && game.room === 1) {
      if (!game.items.includes('key')) game.items.push('key');
      game.question = 'You found the vault key.';
    } else if (value === 'attack' && game.room === 2 && game.bossHp > 0) {
      game.bossHp = Math.max(0, game.bossHp - randomInt(5, 13));
      game.health[userId] = Math.max(0, (game.health[userId] ?? 30) - randomInt(1, 7));
      if (!game.health[userId]) game.status = 'lost';
    } else if (value === 'open' && game.room === 3) {
      if (!game.items.includes('key') || game.bossHp > 0)
        throw new UserError('Find the key and defeat the guardian first.');
      game.status = 'won';
      game.items.push('treasure');
    } else throw new UserError('That action is unavailable in this room. View the room instructions.');
  } else if (game.kind === 'boss') {
    if ((game.health[userId] ?? 0) <= 0) throw new UserError('Your character is knocked out.');
    if (value === 'heal') {
      updateInventory(store, game.guildId, userId, 'potion', -1);
      game.health[userId] = Math.min(30, game.health[userId]! + 15);
    } else if (value === 'attack') {
      game.bossHp = Math.max(0, game.bossHp - randomInt(6, 15));
      game.health[userId] = Math.max(0, game.health[userId]! - randomInt(1, 7));
    } else throw new UserError('Choose attack, or heal with a potion in your inventory.');
    if (!game.bossHp) game.status = 'won';
    else if (game.players.every((player) => (game.health[player] ?? 0) <= 0)) game.status = 'lost';
  } else throw new UserError('Use story.continue for AI story games.');
  game.turn++;
  if (game.kind === 'boss' && game.status === 'active')
    for (
      let i = 0;
      i < game.players.length && (game.health[game.players[game.turn % game.players.length]!] ?? 0) <= 0;
      i++
    )
      game.turn++;
  game.revision++;
  game.updatedAt = Date.now();
  if (game.status !== 'active') finishGame(store, game);
  store.set('games.sessions', key(game.guildId, game.id), game);
  return game;
}
function gameMessage(game: Game) {
  const value = publicGame(game);
  let board = '';
  if (game.board.length) {
    const cols = game.kind === 'tic-tac-toe' ? 3 : 7;
    for (let row = 0; row < game.board.length / cols; row++)
      board +=
        game.board
          .slice(row * cols, row * cols + cols)
          .map((cell, index) =>
            cell === 1
              ? '❌'
              : cell === 2
                ? '⭕'
                : game.kind === 'tic-tac-toe'
                  ? String(row * cols + index)
                  : '·',
          )
          .join(' ') + '\n';
  }
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (['tic-tac-toe', 'connect-four'].includes(game.kind)) {
    const slots = game.kind === 'tic-tac-toe' ? 9 : 7;
    for (let start = 0; start < slots; start += game.kind === 'tic-tac-toe' ? 3 : 4) {
      const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
      for (let i = start; i < Math.min(slots, start + (game.kind === 'tic-tac-toe' ? 3 : 4)); i++)
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`game:play:${game.id}:${game.revision}:${i}`)
            .setLabel(String(i))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(game.status !== 'active' || (game.kind === 'tic-tac-toe' && !!game.board[i])),
        );
      components.push(row);
    }
  }
  return {
    content: `**${game.kind} · ${game.id}**\n${board}Status: ${game.status}. Turn: <@${String(value.currentPlayer)}> · revision ${game.revision}.\nJoin: /action game.join {"id":"${game.id}"}. Other games move through game.move with id, revision and input.`,
    components,
    allowedMentions: { parse: [] as never[] },
  };
}
async function refreshBoard(ctx: ActionContext, game: Game): Promise<void> {
  if (!game.messageId) return;
  try {
    const channel = await resolveChannel(ctx, game.channelId);
    if (!channel.isTextBased()) return;
    const message = await channel.messages.fetch(game.messageId);
    const latest = requireGame(ctx, game.id);
    if (message.author.id === ctx.client.user?.id) await message.edit(gameMessage(latest));
  } catch {
    /* State remains authoritative; game.view always returns its current revision. */
  }
}
export function registerGameActions(registry: ActionRegistry, ai?: AiService): void {
  const base = {
    category: 'games',
    userPermissions: [] as bigint[],
    botPermissions: [] as bigint[],
    risk: 'write' as const,
  };
  registry.register({
    ...base,
    id: 'game.create',
    description:
      'Create a persistent turn-based, word, guessing, puzzle, adventure, boss or AI story session.',
    schema: z.strictObject({ kind: z.enum(kinds), opponentId: id.optional() }),
    execute: async (ctx, input) => {
      if (input.opponentId) {
        if (input.opponentId === ctx.member.id) throw new UserError('Choose another player.');
        const member = await resolveMember(ctx, input.opponentId);
        if (member.user.bot) throw new UserError('Choose a human player.');
      }
      const active = ctx.store
        .list<Game>('games.sessions', `${ctx.guild.id}:`)
        .filter(
          (row) =>
            ['active', 'waiting'].includes(row.value.status) && row.value.updatedAt > Date.now() - 86400000,
        );
      if (active.length >= 50 || active.filter((row) => row.value.ownerId === ctx.member.id).length >= 5)
        throw new UserError('Active game limit reached (5 per owner, 50 per server).');
      const token = randomBytes(6).toString('hex'),
        now = Date.now(),
        a = randomInt(2, 20),
        b = randomInt(2, 20);
      const game: Game = {
        id: token,
        guildId: ctx.guild.id,
        channelId: ctx.channelId,
        ownerId: ctx.member.id,
        kind: input.kind,
        players: [ctx.member.id],
        invitedUserId: input.opponentId,
        status: ['tic-tac-toe', 'connect-four'].includes(input.kind) ? 'waiting' : 'active',
        turn: 0,
        revision: 0,
        board: Array(input.kind === 'tic-tac-toe' ? 9 : input.kind === 'connect-four' ? 42 : 0).fill(0),
        createdAt: now,
        updatedAt: now,
        guesses: [],
        attempts: input.kind === 'hangman' ? 8 : input.kind === 'number-guess' ? 10 : 5,
        room: 0,
        items: [],
        health: { [ctx.member.id]: 30 },
        bossHp: input.kind === 'adventure' ? 25 : 100,
        story: [],
        secret:
          input.kind === 'hangman'
            ? words[randomInt(words.length)]
            : input.kind === 'number-guess'
              ? String(randomInt(1, 101))
              : input.kind === 'puzzle'
                ? String(a * b)
                : undefined,
        question: input.kind === 'puzzle' ? `What is ${a} × ${b}?` : undefined,
      };
      ctx.store.set('games.sessions', key(ctx.guild.id, token), game);
      return publicGame(game);
    },
  });
  registry.register({
    ...base,
    id: 'game.join',
    description: 'Accept a player invitation or join an open cooperative game.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      const existing = requireGame(ctx, input.id);
      await resolveChannel(ctx, existing.channelId);
      const game = ctx.store.transaction(() => {
        const current = requireGame(ctx, input.id);
        if (!['waiting', 'active'].includes(current.status) || current.players.includes(ctx.member.id))
          throw new UserError('Game is closed or you already joined.');
        if (current.invitedUserId && current.invitedUserId !== ctx.member.id)
          throw new UserError('This invitation belongs to another player.');
        const maximum = ['tic-tac-toe', 'connect-four'].includes(current.kind) ? 2 : 10;
        if (current.players.length >= maximum) throw new UserError('Game is full.');
        current.players.push(ctx.member.id);
        current.health[ctx.member.id] = 30;
        current.status = 'active';
        current.updatedAt = Date.now();
        current.revision++;
        ctx.store.set('games.sessions', key(ctx.guild.id, current.id), current);
        return current;
      });
      await refreshBoard(ctx, game);
      return publicGame(game);
    },
  });
  registry.register({
    ...base,
    id: 'game.move',
    description:
      'Make a validated game move; revision protects against stale buttons and simultaneous updates.',
    schema: z.strictObject({
      id: token,
      revision: z.number().int().min(0),
      input: z.string().min(1).max(100),
    }),
    execute: async (ctx, input) => {
      await resolveChannel(ctx, requireGame(ctx, input.id).channelId);
      const game = ctx.store.transaction(() => {
        const current = requireGame(ctx, input.id);
        if (current.revision !== input.revision)
          throw new UserError('Game changed. View its current revision and retry.');
        return applyGameMove(ctx.store, current, ctx.member.id, input.input);
      });
      await refreshBoard(ctx, game);
      if (!['waiting', 'active'].includes(game.status))
        for (const userId of game.players)
          await awardGameRoles(ctx.client, ctx.store, ctx.guild.id, userId).catch(() => {});
      return publicGame(game);
    },
  });
  registry.register({
    ...base,
    id: 'game.view',
    risk: 'read',
    description: 'View current game state without revealing hidden answers.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      const game = requireGame(ctx, input.id);
      await resolveChannel(ctx, game.channelId);
      return publicGame(game);
    },
  });
  registry.register({
    ...base,
    id: 'game.list',
    risk: 'read',
    description: 'List your active game sessions in channels you can currently view.',
    schema: empty,
    execute: async (ctx) => {
      const games: unknown[] = [];
      for (const row of ctx.store.list<Game>('games.sessions', `${ctx.guild.id}:`)) {
        if (!row.value.players.includes(ctx.member.id) || !['active', 'waiting'].includes(row.value.status))
          continue;
        try {
          await resolveChannel(ctx, row.value.channelId);
          games.push(publicGame(row.value));
        } catch {}
      }
      return games.slice(0, 50);
    },
  });
  registry.register({
    ...base,
    id: 'game.close',
    description: 'Owner closes an unfinished game without awarding match results.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      const game = requireGame(ctx, input.id, true);
      await resolveChannel(ctx, game.channelId);
      if (game.ownerId !== ctx.member.id) throw new UserError('Only the game owner can close it.');
      if (!['active', 'waiting'].includes(game.status)) throw new UserError('Game is already complete.');
      game.status = 'draw';
      game.updatedAt = Date.now();
      game.revision++;
      ctx.store.set('games.sessions', key(ctx.guild.id, game.id), game);
      return publicGame(game);
    },
  });
  registry.register({
    ...base,
    id: 'game.panel',
    botPermissions: [P.SendMessages],
    description:
      'Publish an interactive tic-tac-toe/Connect Four board or game instructions in the session channel.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      const game = requireGame(ctx, input.id);
      if (game.ownerId !== ctx.member.id) throw new UserError('Only the owner may publish this game.');
      if (game.messageId) throw new UserError('This game already has a published panel.');
      const channel = await resolveChannel(ctx, game.channelId);
      if (!channel.isSendable() || !channel.permissionsFor(ctx.member)?.has(P.SendMessages))
        throw new UserError('Cannot send in that channel.');
      ctx.store.transaction(() => {
        if (ctx.store.get('games.panels', key(ctx.guild.id, game.id)))
          throw new UserError('A panel is already being created or needs manual reconciliation.');
        ctx.store.set('games.panels', key(ctx.guild.id, game.id), {
          createdAt: Date.now(),
          state: 'creating',
        });
      });
      const message = await channel.send(gameMessage(game));
      const latest = requireGame(ctx, game.id);
      latest.messageId = message.id;
      ctx.store.set('games.sessions', key(ctx.guild.id, game.id), latest);
      ctx.store.set('games.panels', key(ctx.guild.id, game.id), {
        createdAt: Date.now(),
        state: 'published',
        messageId: message.id,
      });
      await refreshBoard(ctx, latest);
      return { messageId: message.id, gameId: game.id };
    },
  });
  registry.register({
    ...base,
    id: 'game.stats',
    risk: 'read',
    description: 'Read your match results, achievements and daily participation reward count.',
    schema: empty,
    execute: (ctx) => ctx.store.get('games.stats', key(ctx.guild.id, ctx.member.id)) ?? initialStats(),
  });
  registry.register({
    ...base,
    id: 'game.leaderboard',
    risk: 'read',
    description: 'Rank observed game wins, losses and draws in this server.',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<Stats>('games.stats', `${ctx.guild.id}:`)
        .map((row) => ({ userId: row.key.split(':')[1], ...row.value }))
        .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
        .slice(0, 25),
  });
  registry.register({
    ...base,
    id: 'story.continue',
    description:
      'Continue a participant-controlled AI story game; uses the configured AI quota and no Discord administration tools.',
    schema: z.strictObject({
      id: token,
      revision: z.number().int().min(0),
      choice: z.string().min(1).max(1000),
    }),
    execute: async (ctx, input) => {
      const game = requireGame(ctx, input.id);
      await resolveChannel(ctx, game.channelId);
      if (
        game.kind !== 'story' ||
        game.status !== 'active' ||
        !game.players.includes(ctx.member.id) ||
        game.revision !== input.revision
      )
        throw new UserError('Join an active story session at its current revision.');
      if (!ai) throw new UserError('AI service is unavailable.');
      const result = await ai.chat(
        ctx,
        `Continue this fictional interactive story in at most 200 words, then offer 3 choices. This is creative content and cannot perform Discord actions. Previous chapters:\n${game.story.slice(-3).join('\n').slice(0, 5000)}\nPlayer choice: ${input.choice}`,
        undefined,
        false,
        {
          memoryScope: `story:${game.id}`,
          usePreferences: false,
          retainHistory: false,
          allowWebSearch: false,
        },
      );
      return ctx.store.transaction(() => {
        const latest = requireGame(ctx, input.id);
        if (latest.revision !== input.revision)
          throw new UserError('Another chapter arrived first. Retry with the current revision.');
        latest.story.push(result.text.slice(0, 3000));
        latest.story = latest.story.slice(-10);
        latest.revision++;
        latest.updatedAt = Date.now();
        ctx.store.set('games.sessions', key(ctx.guild.id, latest.id), latest);
        return publicGame(latest);
      });
    },
  });
  registry.register({
    ...base,
    id: 'team.randomize',
    description: 'Randomly distribute selected current members into balanced teams; does not change roles.',
    schema: z.strictObject({ userIds: z.array(id).min(2).max(50), teams: z.number().int().min(2).max(10) }),
    execute: async (ctx, input) => {
      if (new Set(input.userIds).size !== input.userIds.length || input.teams > input.userIds.length)
        throw new UserError('Use unique members with at least one person per team.');
      for (const user of input.userIds) await resolveMember(ctx, user);
      const pool = [...input.userIds];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      return Array.from({ length: input.teams }, (_, n) => ({
        team: n + 1,
        userIds: pool.filter((_, i) => i % input.teams === n),
      }));
    },
  });
  registry.register({
    ...base,
    id: 'game.leave',
    description:
      'Leave a cooperative session or forfeit a competitive game; lets you detach before personal erasure.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      const initial = requireGame(ctx, input.id, true);
      await resolveChannel(ctx, initial.channelId);
      const game = ctx.store.transaction(() => {
        const current = requireGame(ctx, input.id, true);
        if (!current.players.includes(ctx.member.id)) throw new UserError('You are not a participant.');
        if (
          ['tic-tac-toe', 'connect-four'].includes(current.kind) &&
          current.players.length === 2 &&
          current.status === 'active'
        ) {
          current.status = 'won';
          current.winnerId = current.players.find((user) => user !== ctx.member.id);
          finishGame(ctx.store, current);
        }
        current.players = current.players.filter((user) => user !== ctx.member.id);
        delete current.health[ctx.member.id];
        if (current.ownerId === ctx.member.id) current.ownerId = current.players[0] ?? ctx.member.id;
        if (!current.players.length) {
          ctx.store.delete('games.sessions', key(ctx.guild.id, current.id));
          ctx.store.delete('games.panels', key(ctx.guild.id, current.id));
          return null;
        }
        current.revision++;
        current.updatedAt = Date.now();
        ctx.store.set('games.sessions', key(ctx.guild.id, current.id), current);
        return current;
      });
      if (game) await refreshBoard(ctx, game);
      return { left: input.id };
    },
  });
  registry.register({
    ...base,
    id: 'game.panel.reconcile',
    description:
      'Owner reconciles an interrupted panel creation: provide the already-created bot message, or explicitly clear the reservation before retrying.',
    schema: z.strictObject({ id: token, messageId: id.nullable() }),
    execute: async (ctx, input) => {
      const game = requireGame(ctx, input.id, true);
      if (game.ownerId !== ctx.member.id) throw new UserError('Only the owner can reconcile this panel.');
      const channel = await resolveChannel(ctx, game.channelId);
      if (input.messageId) {
        if (!channel.isTextBased()) throw new UserError('A text channel is required.');
        const message = await channel.messages.fetch(input.messageId);
        if (message.author.id !== ctx.client.user?.id || !message.content.includes(game.id))
          throw new UserError('Choose this game’s existing bot message.');
        game.messageId = message.id;
        ctx.store.set('games.panels', key(ctx.guild.id, game.id), {
          state: 'published',
          messageId: message.id,
          createdAt: Date.now(),
        });
      } else {
        game.messageId = undefined;
        ctx.store.delete('games.panels', key(ctx.guild.id, game.id));
      }
      ctx.store.set('games.sessions', key(ctx.guild.id, game.id), game);
      return { gameId: game.id, messageId: game.messageId ?? null };
    },
  });
  registerProgressionActions(registry);
}
interface Trade {
  from: string;
  to: string;
  offer: Record<string, number>;
  want: Record<string, number>;
  coins: number;
  expiresAt: number;
  state: 'open' | 'accepted' | 'cancelled';
}
interface Pet {
  name: string;
  kind: string;
  hunger: number;
  energy: number;
  happiness: number;
  health: number;
  updatedAt: number;
  lastAction: number;
}
const tradeItems = z
  .record(slug, z.number().int().min(1).max(10000))
  .refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 10,
    'Choose 1–10 item types',
  );
const jobs = {
  miner: { item: 'stone', minimum: 20, maximum: 40 },
  farmer: { item: 'food', minimum: 20, maximum: 40 },
  builder: { item: 'wood', minimum: 25, maximum: 50 },
};
function decayedPet(pet: Pet, now = Date.now()): Pet {
  const hours = Math.max(0, Math.floor((now - pet.updatedAt) / 3600000));
  return {
    ...pet,
    hunger: Math.min(100, pet.hunger + hours * 4),
    energy: Math.min(100, pet.energy + hours * 2),
    happiness: Math.max(0, pet.happiness - hours * 2),
    health: Math.max(0, pet.health - Math.max(0, hours - Math.max(0, Math.floor((80 - pet.hunger) / 4))) * 2),
  };
}
function registerProgressionActions(registry: ActionRegistry): void {
  const base = {
    category: 'games',
    userPermissions: [] as bigint[],
    botPermissions: [] as bigint[],
    risk: 'write' as const,
  };
  registry.register({
    ...base,
    id: 'trade.offer',
    description:
      'Offer collectible items in exchange for other items and fictional coins. Recipient must separately accept.',
    schema: z.strictObject({
      userId: id,
      offer: tradeItems,
      want: tradeItems,
      coins: z.number().int().min(0).max(1000000).default(0),
    }),
    execute: async (ctx, input) => {
      if (input.userId === ctx.member.id) throw new UserError('Choose another member.');
      await resolveMember(ctx, input.userId);
      const own =
        ctx.store.get<Record<string, number>>('community.inventory', key(ctx.guild.id, ctx.member.id)) ?? {};
      for (const [item, count] of Object.entries(input.offer))
        if ((own[item] ?? 0) < count) throw new UserError(`You do not own enough ${item}.`);
      if (
        ctx.store
          .list<Trade>('games.trades', `${ctx.guild.id}:`)
          .filter(
            (row) =>
              row.value.from === ctx.member.id &&
              row.value.state === 'open' &&
              row.value.expiresAt > Date.now(),
          ).length >= 10
      )
        throw new UserError('At most 10 active trade offers.');
      const value = randomBytes(6).toString('hex');
      ctx.store.set('games.trades', key(ctx.guild.id, value), {
        from: ctx.member.id,
        to: input.userId,
        offer: input.offer,
        want: input.want,
        coins: input.coins,
        expiresAt: Date.now() + 86400000,
        state: 'open',
      } satisfies Trade);
      return { id: value, expiresAt: new Date(Date.now() + 86400000).toISOString() };
    },
  });
  registry.register({
    ...base,
    id: 'trade.view',
    risk: 'read',
    description: 'Read a trade offer only if you are one of its participants.',
    schema: z.strictObject({ id: token }),
    execute: (ctx, input) => {
      const trade = ctx.store.get<Trade>('games.trades', key(ctx.guild.id, input.id));
      if (!trade || ![trade.from, trade.to].includes(ctx.member.id))
        throw new UserError('Trade not found for you.');
      return trade;
    },
  });
  registry.register({
    ...base,
    id: 'trade.accept',
    description:
      'Accept an offer addressed to you. Item and coin exchanges commit atomically after holdings are rechecked.',
    schema: z.strictObject({ id: token }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const trade = ctx.store.get<Trade>('games.trades', key(ctx.guild.id, input.id));
        if (!trade || trade.to !== ctx.member.id || trade.state !== 'open' || trade.expiresAt <= Date.now())
          throw new UserError('Open trade is unavailable or addressed to another person.');
        for (const [item, count] of Object.entries(trade.offer)) {
          updateInventory(ctx.store, ctx.guild.id, trade.from, item, -count);
          updateInventory(ctx.store, ctx.guild.id, trade.to, item, count);
        }
        for (const [item, count] of Object.entries(trade.want)) {
          updateInventory(ctx.store, ctx.guild.id, trade.to, item, -count);
          updateInventory(ctx.store, ctx.guild.id, trade.from, item, count);
        }
        if (trade.coins) {
          coins(ctx.store, ctx.guild.id, trade.to, -trade.coins);
          coins(ctx.store, ctx.guild.id, trade.from, trade.coins);
        }
        trade.state = 'accepted';
        ctx.store.set('games.trades', key(ctx.guild.id, input.id), trade);
        return { accepted: input.id };
      }),
  });
  registry.register({
    ...base,
    id: 'trade.cancel',
    description: 'Either participant may cancel an unaccepted trade.',
    schema: z.strictObject({ id: token }),
    execute: (ctx, input) => {
      const trade = ctx.store.get<Trade>('games.trades', key(ctx.guild.id, input.id));
      if (!trade || ![trade.from, trade.to].includes(ctx.member.id) || trade.state !== 'open')
        throw new UserError('Open trade not found.');
      trade.state = 'cancelled';
      ctx.store.set('games.trades', key(ctx.guild.id, input.id), trade);
      return { cancelled: input.id };
    },
  });
  registry.register({
    ...base,
    id: 'pet.adopt',
    description: 'Adopt a fictional server pet with persistent hunger, happiness, health and energy.',
    schema: z.strictObject({
      name: z.string().min(1).max(40),
      kind: z.enum(['cat', 'dog', 'dragon', 'fox']),
    }),
    execute: (ctx, input) => {
      if (ctx.store.get('games.pets', key(ctx.guild.id, ctx.member.id)))
        throw new UserError('You already have a pet in this server.');
      const pet: Pet = {
        ...input,
        hunger: 20,
        energy: 100,
        happiness: 80,
        health: 100,
        updatedAt: Date.now(),
        lastAction: 0,
      };
      ctx.store.set('games.pets', key(ctx.guild.id, ctx.member.id), pet);
      return pet;
    },
  });
  registry.register({
    ...base,
    id: 'pet.view',
    risk: 'read',
    description: 'View your pet’s current, time-adjusted condition.',
    schema: empty,
    execute: (ctx) => {
      const pet = ctx.store.get<Pet>('games.pets', key(ctx.guild.id, ctx.member.id));
      if (!pet) throw new UserError('Adopt a pet first.');
      return decayedPet(pet);
    },
  });
  registry.register({
    ...base,
    id: 'pet.care',
    description:
      'Feed (10 fictional coins), play with, or let your pet sleep. Actions have a one-minute cooldown.',
    schema: z.strictObject({ action: z.enum(['feed', 'play', 'sleep']) }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const saved = ctx.store.get<Pet>('games.pets', key(ctx.guild.id, ctx.member.id));
        if (!saved) throw new UserError('Adopt a pet first.');
        if (Date.now() - saved.lastAction < 60000)
          throw new UserError('Your pet needs a minute before another activity.');
        const pet = decayedPet(saved);
        if (input.action === 'feed') {
          coins(ctx.store, ctx.guild.id, ctx.member.id, -10);
          pet.hunger = Math.max(0, pet.hunger - 35);
          pet.health = Math.min(100, pet.health + 10);
        } else if (input.action === 'play') {
          if (pet.energy < 15) throw new UserError('Let your pet sleep first.');
          pet.energy -= 15;
          pet.hunger = Math.min(100, pet.hunger + 10);
          pet.happiness = Math.min(100, pet.happiness + 20);
        } else pet.energy = Math.min(100, pet.energy + 40);
        pet.updatedAt = Date.now();
        pet.lastAction = Date.now();
        ctx.store.set('games.pets', key(ctx.guild.id, ctx.member.id), pet);
        return pet;
      }),
  });
  registry.register({
    ...base,
    id: 'card.daily',
    description:
      'Claim one fictional collectible card every 24 hours; cards use your tradeable community inventory.',
    schema: empty,
    execute: (ctx) =>
      ctx.store.transaction(() => {
        const last = ctx.store.get<number>('games.cardDaily', key(ctx.guild.id, ctx.member.id)) ?? 0;
        if (Date.now() - last < 86400000) throw new UserError('Daily card is not ready.');
        const roll = randomInt(100),
          item = roll < 80 ? 'card_explorer' : roll < 98 ? 'card_guardian' : 'card_dragon';
        updateInventory(ctx.store, ctx.guild.id, ctx.member.id, item, 1);
        ctx.store.set('games.cardDaily', key(ctx.guild.id, ctx.member.id), Date.now());
        return { item, rarity: roll < 80 ? 'common' : roll < 98 ? 'rare' : 'legendary' };
      }),
  });
  registry.register({
    ...base,
    id: 'job.work',
    description: 'Do a fictional hourly job for bounded coins and crafting materials.',
    schema: z.strictObject({ job: z.enum(['miner', 'farmer', 'builder']) }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const state = ctx.store.get<{ last: number; times: number }>(
          'games.jobs',
          key(ctx.guild.id, ctx.member.id),
        ) ?? { last: 0, times: 0 };
        if (Date.now() - state.last < 3600000)
          throw new UserError('A fictional job is available once per hour.');
        const job = jobs[input.job],
          reward = randomInt(job.minimum, job.maximum + 1);
        coins(ctx.store, ctx.guild.id, ctx.member.id, reward);
        updateInventory(ctx.store, ctx.guild.id, ctx.member.id, job.item, 1);
        ctx.store.set('games.jobs', key(ctx.guild.id, ctx.member.id), {
          last: Date.now(),
          times: state.times + 1,
          job: input.job,
        });
        return { coins: reward, item: job.item, times: state.times + 1 };
      }),
  });
  registry.register({
    ...base,
    id: 'craft.recipe.set',
    userPermissions: [P.ManageGuild],
    description: 'Configure a collectible crafting recipe with validated ingredient costs and output.',
    schema: z.strictObject({
      id: slug,
      ingredients: tradeItems,
      output: slug,
      count: z.number().int().min(1).max(100).default(1),
    }),
    execute: (ctx, input) => {
      if (
        ctx.store.list('games.recipes', `${ctx.guild.id}:`).length >= 100 &&
        !ctx.store.get('games.recipes', key(ctx.guild.id, input.id))
      )
        throw new UserError('At most 100 recipes per server.');
      ctx.store.set('games.recipes', key(ctx.guild.id, input.id), input);
      return input;
    },
  });
  registry.register({
    ...base,
    id: 'craft.recipes',
    risk: 'read',
    description: 'List this server’s collectible crafting recipes.',
    schema: empty,
    execute: (ctx) => ctx.store.list('games.recipes', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...base,
    id: 'craft.make',
    description: 'Atomically consume collectible ingredients and create the configured output.',
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) =>
      ctx.store.transaction(() => {
        const recipe = ctx.store.get<{ ingredients: Record<string, number>; output: string; count: number }>(
          'games.recipes',
          key(ctx.guild.id, input.id),
        );
        if (!recipe) throw new UserError('Recipe not found.');
        for (const [item, count] of Object.entries(recipe.ingredients))
          updateInventory(ctx.store, ctx.guild.id, ctx.member.id, item, -count);
        updateInventory(ctx.store, ctx.guild.id, ctx.member.id, recipe.output, recipe.count);
        return { crafted: recipe.output, count: recipe.count };
      }),
  });
  registry.register({
    ...base,
    id: 'character.set',
    description: 'Create or rename your persistent roleplaying character and choose a class.',
    schema: z.strictObject({
      name: z.string().min(1).max(40),
      class: z.enum(['warrior', 'mage', 'ranger', 'healer']),
    }),
    execute: (ctx, input) => {
      ctx.store.set('games.characters', key(ctx.guild.id, ctx.member.id), input);
      return { ...input, level: levelForXp(getProfile(ctx.store, ctx.guild.id, ctx.member.id).xp) };
    },
  });
  registry.register({
    ...base,
    id: 'character.view',
    risk: 'read',
    description: 'View your roleplaying character and participation progression.',
    schema: empty,
    execute: (ctx) => ({
      character: ctx.store.get('games.characters', key(ctx.guild.id, ctx.member.id)) ?? null,
      level: levelForXp(getProfile(ctx.store, ctx.guild.id, ctx.member.id).xp),
      stats: ctx.store.get('games.stats', key(ctx.guild.id, ctx.member.id)) ?? initialStats(),
    }),
  });
  registry.register({
    ...base,
    id: 'reward.roles.configure',
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageRoles],
    description:
      'Configure safe level and win achievement roles; future grants recheck the configuring administrator’s authority.',
    schema: z.strictObject({
      rules: z
        .array(
          z.strictObject({
            roleId: id,
            level: z.number().int().min(0).max(1000).default(0),
            wins: z.number().int().min(0).max(100000).default(0),
          }),
        )
        .max(20),
    }),
    execute: async (ctx, input) => {
      for (const rule of input.rules) {
        const role = await resolveRole(ctx, rule.roleId);
        assertOrdinaryRole(role, ctx.guild.members.me!);
        if (ctx.member.id !== ctx.guild.ownerId && ctx.member.roles.highest.comparePositionTo(role) <= 0)
          throw new UserError('You must outrank every reward role.');
      }
      ctx.store.set('games.rewardRoles', ctx.guild.id, { authorId: ctx.member.id, rules: input.rules });
      return { configured: input.rules.length };
    },
  });
  registry.register({
    ...base,
    id: 'games.erase.mine',
    description:
      'Erase your game statistics, pet, characters, personal cooldowns and closed trade records; active games must first be closed.',
    schema: empty,
    execute: (ctx) => {
      if (
        ctx.store
          .list<Game>('games.sessions', `${ctx.guild.id}:`)
          .some(
            (row) =>
              row.value.players.includes(ctx.member.id) &&
              ['waiting', 'active'].includes(row.value.status) &&
              row.value.updatedAt > Date.now() - 86400000,
          )
      )
        throw new UserError('Close your active games before erasing game data.');
      for (const namespace of [
        'games.stats',
        'games.pets',
        'games.characters',
        'games.jobs',
        'games.cardDaily',
      ])
        ctx.store.delete(namespace, key(ctx.guild.id, ctx.member.id));
      for (const row of ctx.store.list<Game>('games.sessions', `${ctx.guild.id}:`))
        if (row.value.players.includes(ctx.member.id)) {
          ctx.store.delete('games.sessions', row.key);
          ctx.store.delete('games.panels', row.key);
        }
      for (const row of ctx.store.list<Trade>('games.trades', `${ctx.guild.id}:`))
        if ([row.value.from, row.value.to].includes(ctx.member.id)) ctx.store.delete('games.trades', row.key);
      return {
        erased: true,
        notice: 'Community inventory and moderation records have separate erasure actions.',
      };
    },
  });
}
export async function awardGameRoles(
  client: Client,
  store: Store,
  guildId: string,
  userId: string,
): Promise<void> {
  if (disabled(store, guildId)) return;
  const policy = store.get<{ authorId: string; rules: { roleId: string; level: number; wins: number }[] }>(
    'games.rewardRoles',
    guildId,
  );
  if (!policy) return;
  const guild = await client.guilds.fetch(guildId);
  const [member, author, bot] = await Promise.all([
    guild.members.fetch({ user: userId, force: true }),
    guild.members.fetch({ user: policy.authorId, force: true }),
    guild.members.fetchMe({ force: true }),
  ]);
  if (!author.permissions.has([P.ManageGuild, P.ManageRoles]) || !bot.permissions.has(P.ManageRoles)) return;
  const level = levelForXp(getProfile(store, guildId, userId).xp),
    stats = store.get<Stats>('games.stats', key(guildId, userId)) ?? initialStats();
  for (const rule of policy.rules) {
    if (level < rule.level || stats.wins < rule.wins || member.roles.cache.has(rule.roleId)) continue;
    const role = await guild.roles.fetch(rule.roleId, { force: true });
    if (!role) continue;
    try {
      assertOrdinaryRole(role, bot);
      if (author.id !== guild.ownerId && author.roles.highest.comparePositionTo(role) <= 0) continue;
      await member.roles.add(role, 'Configured participation/achievement reward');
    } catch {
      /* Changed role policy is never overridden. */
    }
  }
}
export function sweepGameTasks(
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): void {
  for (const row of store.list<Game>('games.sessions'))
    if (
      (!allowedGuildIds.length || allowedGuildIds.includes(row.value.guildId)) &&
      row.value.updatedAt < now - 30 * 86400000
    ) {
      store.delete('games.sessions', row.key);
      store.delete('games.panels', row.key);
    }
  for (const row of store.list<Trade>('games.trades'))
    if (
      (!allowedGuildIds.length || allowedGuildIds.includes(row.key.split(':')[0]!)) &&
      row.value.expiresAt < now - 7 * 86400000
    )
      store.delete('games.trades', row.key);
}
