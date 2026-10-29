import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Client,
  type Role,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService } from '../src/features/ai.js';
import {
  awardGameRoles,
  boardWinner,
  publicGame,
  registerGameActions,
  sweepGameTasks,
  type Game,
} from '../src/features/games.js';
import { getProfile } from '../src/features/community.js';

const GUILD = '720000000000000001',
  USER = '720000000000000002',
  OTHER = '720000000000000003',
  THIRD = '720000000000000004',
  BOT = '720000000000000005',
  CHANNEL = '720000000000000006',
  ROLE = '720000000000000007',
  OWNER = '720000000000000008',
  OTHER_GUILD = '720000000000000009';
const gameKey = (id: string) => `${GUILD}:${id}`;
function fixture(t: TestContext, ai?: AiService) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const permissions = new Map([
    [USER, new PermissionsBitField(P.Administrator)],
    [OTHER, new PermissionsBitField(P.Administrator)],
    [THIRD, new PermissionsBitField(P.Administrator)],
    [BOT, new PermissionsBitField(P.Administrator)],
  ]);
  const role = {
    id: ROLE,
    guild: { id: GUILD },
    name: 'Winner',
    position: 1,
    managed: false,
    permissions: new PermissionsBitField(0n),
  };
  const additions: { userId: string; roleId: string }[] = [];
  const members = new Collection(
    [USER, OTHER, THIRD, BOT].map(
      (userId) =>
        [
          userId,
          {
            id: userId,
            user: { id: userId, bot: userId === BOT },
            permissions: permissions.get(userId)!,
            roles: {
              cache: new Collection<string, unknown>(),
              highest: {
                comparePositionTo: (item: { position?: number }) =>
                  (userId === BOT ? 1000 : 100) - (item.position ?? 0),
              },
              add: async (item: Role) => {
                additions.push({ userId, roleId: item.id });
              },
            },
          },
        ] as const,
    ),
  );
  const sends: unknown[] = [],
    edits: unknown[] = [];
  let serial = 0;
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (member: { id: string }) => permissions.get(member.id) ?? new PermissionsBitField(0n),
    async send(options: unknown) {
      sends.push(options);
      return { id: String(++serial) };
    },
    messages: {
      fetch: async () => ({
        author: { id: BOT },
        edit: async (options: unknown) => {
          edits.push(options);
        },
      }),
    },
  };
  const guild = {
    id: GUILD,
    ownerId: OWNER,
    members: {
      me: members.get(BOT),
      fetchMe: async () => members.get(BOT),
      fetch: async (input: string | { user: string }) => {
        const member = members.get(typeof input === 'string' ? input : input.user);
        if (!member) throw new Error('Missing member');
        return member;
      },
    },
    roles: { fetch: async (id: string) => (id === ROLE ? role : null) },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) },
  };
  for (const member of members.values()) Object.assign(member, { guild });
  const client = { user: { id: BOT }, guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = {
    store,
    guild,
    client,
    member: members.get(USER),
    channelId: CHANNEL,
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerGameActions(registry, ai);
  const execute = async (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  const asUser = (user: string) => ({ ...ctx, member: members.get(user) }) as unknown as ActionContext;
  const inventory = (user: string, value: Record<string, number>) =>
    store.set('community.inventory', `${GUILD}:${user}`, value);
  const balance = (user: string, value: number) =>
    store.set('community.profiles', `${GUILD}:${user}`, {
      ...getProfile(store, GUILD, user),
      balance: value,
    });
  const game = async (kind: Game['kind'] = 'puzzle', opponentId?: string) => {
    const created = (await execute('game.create', { kind, opponentId })) as { id: string };
    return store.get<Game>('games.sessions', gameKey(created.id))!;
  };
  return {
    store,
    ctx,
    registry,
    execute,
    asUser,
    members,
    permissions,
    role,
    additions,
    sends,
    edits,
    channel,
    guild,
    client,
    inventory,
    balance,
    game,
  };
}

test('Board winner detection handles rows, columns, diagonals and excludes edge wraparound', () => {
  assert.equal(boardWinner([1, 1, 1, 0, 2, 0, 2, 0, 0], 3, 3, 3), 1);
  assert.equal(boardWinner([2, 1, 0, 2, 1, 0, 2, 0, 0], 3, 3, 3), 2);
  assert.equal(boardWinner([1, 0, 2, 0, 1, 2, 0, 0, 1], 3, 3, 3), 1);
  assert.equal(boardWinner([0, 0, 1, 1, 1, 0, 0, 0, 0], 3, 3, 3), 0);
  const board = Array(42).fill(0);
  for (const index of [21, 15, 9, 3]) board[index] = 2;
  assert.equal(boardWinner(board, 7, 6, 4), 2);
});

test('Games invite a specific opponent and require that participant to join before competitive moves', async (t) => {
  const f = fixture(t);
  const game = await f.game('tic-tac-toe', OTHER);
  await assert.rejects(f.execute('game.move', { id: game.id, revision: 0, input: '0' }), /active/);
  await assert.rejects(f.execute('game.join', { id: game.id }, f.asUser(THIRD)), /invitation/);
  const joined = (await f.execute('game.join', { id: game.id }, f.asUser(OTHER))) as {
    status: string;
    revision: number;
  };
  assert.equal(joined.status, 'active');
  assert.equal(joined.revision, 1);
  await assert.rejects(f.execute('game.join', { id: game.id }, f.asUser(THIRD)), /invitation|full/);
});

test('Game moves reject stale revisions, wrong turns and occupied cells while a valid win records both players once', async (t) => {
  const f = fixture(t);
  const game = await f.game('tic-tac-toe', OTHER);
  await f.execute('game.join', { id: game.id }, f.asUser(OTHER));
  await assert.rejects(f.execute('game.move', { id: game.id, revision: 0, input: '0' }), /changed/);
  await f.execute('game.move', { id: game.id, revision: 1, input: '0' });
  await assert.rejects(f.execute('game.move', { id: game.id, revision: 2, input: '1' }), /another player/);
  await assert.rejects(
    f.execute('game.move', { id: game.id, revision: 2, input: '0' }, f.asUser(OTHER)),
    /empty/,
  );
  for (const [user, input, revision] of [
    [OTHER, '3', 2],
    [USER, '1', 3],
    [OTHER, '4', 4],
    [USER, '2', 5],
  ] as const)
    await f.execute('game.move', { id: game.id, revision, input }, f.asUser(user));
  const saved = f.store.get<Game>('games.sessions', gameKey(game.id))!;
  assert.equal(saved.status, 'won');
  assert.equal(saved.winnerId, USER);
  assert.equal(((await f.execute('game.stats')) as { wins: number }).wins, 1);
  assert.equal(((await f.execute('game.stats', {}, f.asUser(OTHER))) as { losses: number }).losses, 1);
  await assert.rejects(f.execute('game.move', { id: game.id, revision: 6, input: '8' }), /active/);
  assert.equal(((await f.execute('game.stats')) as { played: number }).played, 1);
});

test('Connect Four uses gravity and rejects a full column without changing the saved revision', async (t) => {
  const f = fixture(t);
  const game = await f.game('connect-four', OTHER);
  await f.execute('game.join', { id: game.id }, f.asUser(OTHER));
  for (let index = 0; index < 6; index++)
    await f.execute(
      'game.move',
      { id: game.id, revision: index + 1, input: '0' },
      f.asUser(index % 2 ? OTHER : USER),
    );
  const current = f.store.get<Game>('games.sessions', gameKey(game.id))!;
  assert.equal(current.board[35], 1);
  assert.equal(current.board[0], 2);
  await assert.rejects(f.execute('game.move', { id: game.id, revision: 7, input: '0' }), /full/);
  assert.equal(f.store.get<Game>('games.sessions', gameKey(game.id))?.revision, 7);
});

test('Public game state hides active hangman, number and puzzle answers and reveals completed hangman words', async (t) => {
  const f = fixture(t);
  for (const kind of ['hangman', 'number-guess', 'puzzle'] as const) {
    const game = await f.game(kind);
    const value = publicGame(game);
    assert.equal('secret' in value, false);
    if (kind === 'hangman') {
      assert.equal(String(value.word).replaceAll(' ', ''), '_'.repeat(game.secret!.length));
      game.status = 'lost';
      assert.equal(String(publicGame(game).word).replaceAll(' ', ''), game.secret);
    }
  }
});

test('Number guessing treats leading-zero guesses as the same integer or rejects noncanonical spelling', async (t) => {
  const f = fixture(t);
  const game = await f.game('number-guess');
  game.secret = '37';
  f.store.set('games.sessions', gameKey(game.id), game);
  try {
    await f.execute('game.move', { id: game.id, revision: 0, input: '037' });
  } catch {
    assert.equal(f.store.get<Game>('games.sessions', gameKey(game.id))?.revision, 0);
    return;
  }
  assert.equal(f.store.get<Game>('games.sessions', gameKey(game.id))?.status, 'won');
});

test('Channel visibility and guild scoping protect game view, move and close results', async (t) => {
  const f = fixture(t);
  const game = await f.game('story');
  game.story = ['private story'];
  f.store.set('games.sessions', gameKey(game.id), game);
  const outside = { ...f.ctx, guild: { ...f.ctx.guild, id: OTHER_GUILD } } as ActionContext;
  await assert.rejects(f.execute('game.view', { id: game.id }, outside), /server/);
  f.permissions.set(USER, new PermissionsBitField(0n));
  await assert.rejects(f.execute('game.view', { id: game.id }), /view/);
  await assert.rejects(f.execute('game.close', { id: game.id }), /view/);
  assert.equal(f.store.get<Game>('games.sessions', gameKey(game.id))?.status, 'active');
});

test('Only game owner can close or publish a session', async (t) => {
  const f = fixture(t);
  const game = await f.game();
  await assert.rejects(f.execute('game.close', { id: game.id }, f.asUser(OTHER)), /owner/);
  await assert.rejects(f.execute('game.panel', { id: game.id }, f.asUser(OTHER)), /owner/);
  assert.equal(f.sends.length, 0);
});

test('Game publication reserves its panel before awaiting Discord so concurrent requests cannot duplicate it', async (t) => {
  const f = fixture(t);
  const game = await f.game('tic-tac-toe', OTHER);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.channel.send = async (options) => {
    f.sends.push(options);
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { id: 'panel' };
  };
  const first = f.execute('game.panel', { id: game.id });
  await started;
  const second = f.execute('game.panel', { id: game.id });
  const settlement = second.then(
    () => 'fulfilled',
    () => 'rejected',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await first;
  assert.equal(await settlement, 'rejected');
  assert.equal(f.sends.length, 1);
});

test('Completed game rewards have a durable three-participation daily cap and cannot be replayed', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    const game = await f.game('puzzle');
    game.secret = '4';
    f.store.set('games.sessions', gameKey(game.id), game);
    await f.execute('game.move', { id: game.id, revision: 0, input: '4' });
  }
  assert.equal(getProfile(f.store, GUILD, USER).balance, 60);
  const stats = (await f.execute('game.stats')) as { played: number; wins: number; rewarded: number };
  assert.equal(stats.played, 4);
  assert.equal(stats.wins, 4);
  assert.equal(stats.rewarded, 3);
});

test('Trades recheck holdings and atomically exchange both item directions and fictional coins exactly once', async (t) => {
  const f = fixture(t);
  f.inventory(USER, { wood: 5 });
  f.inventory(OTHER, { stone: 10 });
  f.balance(OTHER, 100);
  const offered = (await f.execute('trade.offer', {
    userId: OTHER,
    offer: { wood: 3 },
    want: { stone: 4 },
    coins: 25,
  })) as { id: string };
  await assert.rejects(f.execute('trade.accept', { id: offered.id }, f.asUser(THIRD)), /another person/);
  await f.execute('trade.accept', { id: offered.id }, f.asUser(OTHER));
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { wood: 2, stone: 4 });
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${OTHER}`), { stone: 6, wood: 3 });
  assert.equal(getProfile(f.store, GUILD, USER).balance, 25);
  assert.equal(getProfile(f.store, GUILD, OTHER).balance, 75);
  await assert.rejects(f.execute('trade.accept', { id: offered.id }, f.asUser(OTHER)), /unavailable/);
});

test('Trade failure rolls back earlier item movements and offer state when a later ingredient or coin constraint fails', async (t) => {
  const f = fixture(t);
  f.inventory(USER, { wood: 5 });
  f.inventory(OTHER, { stone: 2 });
  f.balance(OTHER, 100);
  const offered = (await f.execute('trade.offer', {
    userId: OTHER,
    offer: { wood: 3 },
    want: { stone: 4 },
    coins: 25,
  })) as { id: string };
  await assert.rejects(f.execute('trade.accept', { id: offered.id }, f.asUser(OTHER)), /insufficient/);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { wood: 5 });
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${OTHER}`), { stone: 2 });
  assert.equal(((await f.execute('trade.view', { id: offered.id })) as { state: string }).state, 'open');
  f.inventory(OTHER, { stone: 10 });
  f.balance(USER, 1e12);
  await assert.rejects(f.execute('trade.accept', { id: offered.id }, f.asUser(OTHER)), /limit/);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { wood: 5 });
  assert.equal(getProfile(f.store, GUILD, OTHER).balance, 100);
});

test('Trade views and cancellation are participant-only and expire safely', async (t) => {
  const f = fixture(t);
  f.inventory(USER, { wood: 1 });
  const offer = (await f.execute('trade.offer', {
    userId: OTHER,
    offer: { wood: 1 },
    want: { stone: 1 },
  })) as { id: string };
  await assert.rejects(f.execute('trade.view', { id: offer.id }, f.asUser(THIRD)), /not found/);
  await assert.rejects(f.execute('trade.cancel', { id: offer.id }, f.asUser(THIRD)), /not found/);
  const stored = f.store.get<Record<string, unknown>>('games.trades', gameKey(offer.id))!;
  stored.expiresAt = Date.now() - 1;
  f.store.set('games.trades', gameKey(offer.id), stored);
  await assert.rejects(f.execute('trade.accept', { id: offer.id }, f.asUser(OTHER)), /unavailable/);
});

test('Valid hyphenated community shop item IDs remain tradeable and usable as crafting ingredients', async (t) => {
  const f = fixture(t);
  f.inventory(USER, { 'blue-card': 2 });
  await f.execute('trade.offer', { userId: OTHER, offer: { 'blue-card': 1 }, want: { stone: 1 } });
  await f.execute('craft.recipe.set', {
    id: 'card_bundle',
    ingredients: { 'blue-card': 2 },
    output: 'bundle',
  });
  await f.execute('craft.make', { id: 'card_bundle' });
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { bundle: 1 });
});

test('Crafting consumes ingredients and output atomically and rolls back missing ingredients or output overflow', async (t) => {
  const f = fixture(t);
  await f.execute('craft.recipe.set', { id: 'potion', ingredients: { food: 2, wood: 1 }, output: 'potion' });
  f.inventory(USER, { food: 2 });
  await assert.rejects(f.execute('craft.make', { id: 'potion' }), /insufficient/);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { food: 2 });
  f.inventory(USER, { food: 2, wood: 1, potion: 1000000 });
  await assert.rejects(f.execute('craft.make', { id: 'potion' }), /limit/);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), {
    food: 2,
    wood: 1,
    potion: 1000000,
  });
  f.inventory(USER, { food: 2, wood: 1 });
  await f.execute('craft.make', { id: 'potion' });
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { potion: 1 });
});

test('Fictional jobs enforce hourly cooldowns, bounded reward ranges, and atomic overflow rollback', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const job = (await f.execute('job.work', { job: 'miner' })) as { coins: number };
  assert.ok(job.coins >= 20 && job.coins <= 40);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { stone: 1 });
  await assert.rejects(f.execute('job.work', { job: 'farmer' }), /hour/);
  now += 3600000;
  f.balance(USER, 1e12);
  await assert.rejects(f.execute('job.work', { job: 'farmer' }), /limit/);
  assert.deepEqual(f.store.get('community.inventory', `${GUILD}:${USER}`), { stone: 1 });
  f.balance(USER, 0);
  await f.execute('job.work', { job: 'farmer' });
  assert.equal(f.store.get<{ times: number }>('games.jobs', `${GUILD}:${USER}`)?.times, 2);
});

test('Pet care charges coins atomically and persists a shared one-minute cooldown', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await f.execute('pet.adopt', { name: 'Milo', kind: 'cat' });
  await assert.rejects(f.execute('pet.care', { action: 'feed' }), /Insufficient/);
  assert.equal(((await f.execute('pet.view')) as { hunger: number }).hunger, 20);
  f.balance(USER, 50);
  await f.execute('pet.care', { action: 'feed' });
  assert.equal(getProfile(f.store, GUILD, USER).balance, 40);
  await assert.rejects(f.execute('pet.care', { action: 'play' }), /minute/);
  now += 60000;
  await f.execute('pet.care', { action: 'play' });
});

test('Pet starvation decay requires elapsed hours and is not charged again during each minute of care', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.store.set('games.pets', `${GUILD}:${USER}`, {
    name: 'Milo',
    kind: 'cat',
    hunger: 100,
    energy: 50,
    happiness: 50,
    health: 80,
    updatedAt: now - 60000,
    lastAction: now - 60000,
  });
  const result = (await f.execute('pet.care', { action: 'sleep' })) as { health: number };
  assert.equal(result.health, 80);
});

test('Safe achievement roles revalidate administrator authority and changed role permissions before granting', async (t) => {
  const f = fixture(t);
  await f.execute('reward.roles.configure', { rules: [{ roleId: ROLE, wins: 1 }] });
  f.store.set('games.stats', `${GUILD}:${OTHER}`, { wins: 2 });
  await awardGameRoles(f.client, f.store, GUILD, OTHER);
  assert.deepEqual(f.additions, [{ userId: OTHER, roleId: ROLE }]);
  f.additions.length = 0;
  f.role.permissions.add(P.Administrator);
  await awardGameRoles(f.client, f.store, GUILD, OTHER);
  assert.equal(f.additions.length, 0);
  f.role.permissions.remove(P.Administrator);
  f.permissions.get(USER)!.remove(P.Administrator);
  await awardGameRoles(f.client, f.store, GUILD, OTHER);
  assert.equal(f.additions.length, 0);
});

test('A timed-out game cannot permanently block personal game-data erasure', async (t) => {
  const f = fixture(t);
  const game = await f.game();
  game.updatedAt = Date.now() - 2 * 86400000;
  f.store.set('games.sessions', gameKey(game.id), game);
  f.store.set('games.stats', `${GUILD}:${USER}`, { wins: 5 });
  await f.execute('games.erase.mine');
  assert.equal(f.store.get('games.stats', `${GUILD}:${USER}`), undefined);
});

test('Game maintenance respects allowed servers and removes stale sessions without touching another server', async (t) => {
  const f = fixture(t);
  const game = await f.game();
  game.updatedAt = Date.now() - 31 * 86400000;
  f.store.set('games.sessions', gameKey(game.id), game);
  f.store.set('games.sessions', `${OTHER_GUILD}:abcdef123456`, {
    ...game,
    id: 'abcdef123456',
    guildId: OTHER_GUILD,
  });
  sweepGameTasks(f.store, Date.now(), [GUILD]);
  assert.equal(f.store.get('games.sessions', gameKey(game.id)), undefined);
  assert.ok(f.store.get('games.sessions', `${OTHER_GUILD}:abcdef123456`));
});

test('AI story continuation disables administrative tools and serializes concurrent chapter revisions', async (t) => {
  let resolveFirst!: (value: { text: string; pending: [] }) => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0,
    toolsEnabled: unknown;
  const ai = {
    chat: async (_ctx: ActionContext, _text: string, _attachment: unknown, allowActions: boolean) => {
      toolsEnabled = allowActions;
      if (++calls === 1) {
        started();
        return new Promise<{ text: string; pending: [] }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { text: 'Second chapter', pending: [] };
    },
  } as unknown as AiService;
  const f = fixture(t, ai);
  const game = await f.game('story');
  await f.execute('game.join', { id: game.id }, f.asUser(OTHER));
  const first = f.execute('story.continue', { id: game.id, revision: 1, choice: 'forest' });
  await entered;
  await f.execute('story.continue', { id: game.id, revision: 1, choice: 'cave' }, f.asUser(OTHER));
  resolveFirst({ text: 'First chapter', pending: [] });
  await assert.rejects(first, /chapter arrived/);
  assert.equal(toolsEnabled, false);
  assert.deepEqual(f.store.get<Game>('games.sessions', gameKey(game.id))?.story, ['Second chapter']);
});
