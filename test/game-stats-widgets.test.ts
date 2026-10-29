import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type Guild } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { OwnedCredential } from '../src/integrations/credentials.js';
import { registerGameStatsWidgetActions, gameStatsDataSchema } from '../src/features/game-stats-widgets.js';

const G = '960000000000000001',
  U = '960000000000000002',
  B = '960000000000000003',
  C = '960000000000000004';
type Identity = {
  user_id: string;
  provider_type: string;
  provider_issued_user_id: string;
  provider_id?: string;
};
type Request = { method: string; path: string; body?: unknown };
async function fixture(t: TestContext, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-game-widget-')),
    file = join(directory, 'profiles.json'),
    store = new Store(':memory:');
  const member = {
      id: U,
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection() },
    },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  let visible = true,
    current = true;
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    permissionsFor: () => new PermissionsBitField(visible ? P.Administrator : 0n),
  };
  const guild = {
    id: G,
    ownerId: U,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  } as unknown as Guild;
  const ctx = {
    store,
    guild,
    member,
    channelId: C,
    client: { application: { id: B } },
  } as unknown as ActionContext;
  let profile: unknown = {
      username: 'Verified player',
      data: { primary: { total_wins: 12, total_games: 20 }, dynamic: [{ type: 2, name: 'level', value: 4 }] },
    },
    identities: Identity[] = [];
  const save = async (value: unknown = profile, providerIssuedUserId = 'game-player-42') =>
    writeFile(
      file,
      JSON.stringify({ version: 1, profiles: [{ discordUserId: U, providerIssuedUserId, profile: value }] }),
    );
  await save();
  let grant: OwnedCredential | undefined = {
    token: 'synthetic-never-uploaded-oauth-token',
    subjectUserId: U,
    subjectGuildId: G,
    providerAccountId: U,
    scopes: ['identify', 'application_identities.write'],
    authorizationId: 'stable-grant-version',
    current: () => current,
  };
  const requests: Request[] = [];
  let hook: ((request: Request) => Promise<void> | void) | undefined;
  const registry = new ActionRegistry();
  registerGameStatsWidgetActions(registry, {
    profilesFile: configured ? file : '',
    credential: async () => grant,
    request: async (_ctx, method, path, body) => {
      const req = { method, path, body };
      requests.push(req);
      await hook?.(req);
      if (method === 'get' && path.includes('/application-identities/')) return { identities };
      if (method === 'get') return profile;
      if (method === 'patch') {
        profile = body;
        identities = [{ user_id: U, provider_type: 'NONE', provider_issued_user_id: 'game-player-42' }];
        return undefined;
      }
      identities = [];
      return undefined;
    },
  });
  const execute = async (id: string, input: unknown = {}) => {
    const requested = await registry.request(ctx, id, input),
      done = requested.status === 'confirmation' ? await registry.confirm(ctx, requested.id) : requested;
    assert.equal(done.status, 'completed');
    return done.status === 'completed' ? done.result : undefined;
  };
  t.after(async () => {
    store.close();
    assert.equal(dirname(directory), tmpdir());
    assert.match(basename(directory), /^discord-game-widget-/);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ctx,
    registry,
    requests,
    execute,
    save,
    setHook(value: typeof hook) {
      hook = value;
    },
    revoke() {
      current = false;
    },
    hide() {
      visible = false;
    },
    setGrant(value: OwnedCredential | undefined) {
      grant = value;
    },
    getGrant: () => grant!,
    setIdentities(value: Identity[]) {
      identities = value;
    },
  };
}

test('native widget actions are unavailable when their optional approved source is blank', async (t) => {
  const f = await fixture(t, false);
  for (const id of [
    'game-stats.identities',
    'game-stats.source',
    'game-stats.profile',
    'game-stats.update',
    'game-stats.remove',
  ])
    assert.equal(f.registry.get(id).available?.(), false);
  await assert.rejects(() => f.execute('game-stats.source'), /GAME_STATS_PROFILES_FILE/);
  assert.deepEqual(f.requests, []);
});
test('native widget synchronization confirms the exact complete approved payload before the actual documented PATCH', async (t) => {
  const f = await fixture(t),
    source = (await f.execute('game-stats.source')) as { nextUpdateRequest: unknown; notice: string };
  assert.match(source.notice, /fully replaces/);
  const pending = await f.registry.request(f.ctx, 'game-stats.update', source.nextUpdateRequest);
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.requests.length, 0);
  if (pending.status !== 'confirmation') throw new Error();
  await f.registry.confirm(f.ctx, pending.id);
  assert.deepEqual(
    f.requests.map((row) => [row.method, row.path]),
    [
      ['get', `/users/${U}/application-identities/${B}`],
      ['patch', `/applications/${B}/users/${U}/identities/game-player-42/profile`],
    ],
  );
  assert.equal(
    (f.requests[1]!.body as { data: { primary: { total_wins: number } } }).data.primary.total_wins,
    12,
  );
  assert.doesNotMatch(JSON.stringify(f.requests), /synthetic-never-uploaded|stable-grant-version/);
  const remote = (await f.execute('game-stats.profile', { providerIssuedUserId: 'game-player-42' })) as {
    username: string;
  };
  assert.equal(remote.username, 'Verified player');
  await assert.rejects(
    () => f.registry.confirm(f.ctx, pending.id),
    /expired|used|not found|invalid|unavailable/i,
  );
});
test('a caller cannot claim another game identity or forge approved game statistics', async (t) => {
  const f = await fixture(t),
    source = (await f.execute('game-stats.source')) as {
      nextUpdateRequest: { sourceHash: string; providerIssuedUserId: string; profile: unknown };
    };
  await assert.rejects(
    () =>
      f.execute('game-stats.update', { ...source.nextUpdateRequest, providerIssuedUserId: 'someone-else' }),
    /approved source/,
  );
  await assert.rejects(
    () =>
      f.execute('game-stats.update', {
        ...source.nextUpdateRequest,
        profile: { data: { primary: { total_wins: 999999 } } },
      }),
    /approved source/,
  );
  f.setIdentities([{ user_id: U, provider_type: 'STEAM', provider_issued_user_id: 'different-verified-id' }]);
  await assert.rejects(
    () => f.execute('game-stats.update', source.nextUpdateRequest),
    /existing game identity differs/,
  );
  assert.equal(f.requests.filter((req) => req.method === 'patch').length, 0);
  await assert.rejects(
    () => f.execute('game-stats.profile', { providerIssuedUserId: 'someone-else' }),
    /not currently linked/,
  );
});
test('identity, exact scope and live linked-authorization ownership are mandatory before any widget API request', async (t) => {
  for (const field of ['scope', 'user', 'guild', 'identity', 'version'] as const) {
    const f = await fixture(t),
      original = f.getGrant();
    f.setGrant({
      ...original,
      ...(field === 'scope'
        ? { scopes: ['identify'] }
        : field === 'user'
          ? { subjectUserId: B }
          : field === 'guild'
            ? { subjectGuildId: B }
            : field === 'identity'
              ? { providerAccountId: B }
              : { authorizationId: undefined }),
    });
    await assert.rejects(() => f.execute('game-stats.identities'), /own Discord account/);
    assert.equal(f.requests.length, 0);
  }
});
test('source replacement or grant revocation during native identity lookup prevents a profile write', async (t) => {
  for (const change of ['source', 'grant', 'access'] as const) {
    const f = await fixture(t),
      source = (await f.execute('game-stats.source')) as { nextUpdateRequest: unknown };
    f.setHook(async (request) => {
      if (request.method === 'get') {
        if (change === 'source') await f.save({ data: { primary: { total_wins: 99 } } });
        else if (change === 'grant') f.revoke();
        else f.hide();
      }
    });
    await assert.rejects(
      () => f.execute('game-stats.update', source.nextUpdateRequest),
      /changed|view|access|permission/i,
    );
    assert.equal(
      f.requests.some((request) => request.method === 'patch'),
      false,
    );
  }
});
test('native identity removal uses documented POST delete with exact verified provider fields and never queries other users', async (t) => {
  const f = await fixture(t);
  f.setIdentities([
    {
      user_id: U,
      provider_type: 'STEAM',
      provider_id: 'steam-app',
      provider_issued_user_id: 'game/player 42',
    },
  ]);
  await assert.rejects(
    () => f.execute('game-stats.remove', { providerType: 'STEAM', providerIssuedUserId: 'game/player 42' }),
    /exact identity/,
  );
  assert.equal(
    f.requests.some((request) => request.method === 'post'),
    false,
  );
  await f.execute('game-stats.remove', {
    providerType: 'STEAM',
    providerId: 'steam-app',
    providerIssuedUserId: 'game/player 42',
  });
  const removal = f.requests.at(-1)!;
  assert.equal(removal.method, 'post');
  assert.equal(removal.path, `/users/${U}/application-identities/${B}/STEAM/game%2Fplayer%2042/delete`);
  assert.deepEqual(removal.body, { provider_id: 'steam-app' });
});
test('late revocation withholds a profile response and same-user admission rejects overlapping widget work', async (t) => {
  const f = await fixture(t);
  f.setIdentities([{ user_id: U, provider_type: 'NONE', provider_issued_user_id: 'game-player-42' }]);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  f.setHook(async (request) => {
    if (request.path.endsWith('/profile')) {
      started();
      await gate;
    }
  });
  const pending = f.execute('game-stats.profile', { providerIssuedUserId: 'game-player-42' }),
    rejected = assert.rejects(pending, /authorization|settings changed/);
  await entered;
  await assert.rejects(() => f.execute('game-stats.identities'), /busy/);
  f.revoke();
  release();
  await rejected;
});
test('widget schemas enforce real field types, media URLs, Unicode byte bounds and complete bounded dynamic data', () => {
  assert.equal(
    gameStatsDataSchema.parse({ primary: { playtime_hours: 0.25, total_wins: 0 } }).primary?.playtime_hours,
    0.25,
  );
  assert.throws(() =>
    gameStatsDataSchema.parse({
      dynamic: Array.from({ length: 31 }, (_, i) => ({ type: 2, name: String(i), value: i })),
    }),
  );
  assert.throws(
    () =>
      gameStatsDataSchema.parse({
        dynamic: [
          { type: 1, name: 'same', value: 'one' },
          { type: 2, name: 'same', value: 2 },
        ],
      }),
    /unique/,
  );
  assert.throws(
    () => gameStatsDataSchema.parse({ primary: { rank_image: { url: 'http://127.0.0.1/private.png' } } }),
    /public HTTPS/,
  );
  assert.throws(
    () =>
      gameStatsDataSchema.parse({
        dynamic: Array.from({ length: 30 }, (_, i) => ({
          type: 1,
          name: String(i) + '🙂'.repeat(49),
          value: '🙂'.repeat(50),
        })),
      }),
    /10,000 bytes/,
  );
  assert.throws(() => gameStatsDataSchema.parse({ primary: { total_wins: 1.5 } }));
});
