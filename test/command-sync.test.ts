import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Routes, ApplicationCommandType, type REST } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import {
  desiredCommandScopes,
  installedCommandGuildIds,
  normalizedCommandDefinitions,
  reconcileApplicationCommands,
} from '../src/discord/command-sync.js';

const APP = '810000000000000001',
  G = '810000000000000002',
  OTHER = '810000000000000003';
type Definition = Record<string, unknown>;
function fixture(t: TestContext, env: NodeJS.ProcessEnv = { DISCORD_GUILD_IDS: G }) {
  const store = new Store(':memory:'),
    config = loadConfig(env),
    remote = new Map<string, Definition[]>(),
    puts: { route: string; body: Definition[] }[] = [],
    reads: string[] = [];
  const rest = {
    get: async (route: string) => {
      reads.push(route);
      if (route === Routes.userGuilds()) return [{ id: G }];
      return structuredClone(remote.get(route) ?? []);
    },
    put: async (route: string, options: { body: Definition[] }) => {
      puts.push({ route, body: structuredClone(options.body) });
      remote.set(route, structuredClone(options.body));
    },
  };
  t.after(() => store.close());
  const run = () =>
    reconcileApplicationCommands({
      applicationId: APP,
      config,
      rest: rest as unknown as REST,
      store,
      logger: { info: () => {} },
    });
  return {
    store,
    config,
    remote,
    puts,
    reads,
    rest,
    run,
    global: Routes.applicationCommands(APP),
    guild: Routes.applicationGuildCommands(APP, G),
  };
}
test('guild publication removes obsolete global /voice and stale /ask question while installing one canonical command surface', async (t) => {
  const f = fixture(t);
  f.remote.set(f.global, [
    { name: 'voice', type: 1, description: 'old' },
    {
      name: 'ask',
      type: 1,
      description: 'old',
      options: [{ type: 3, name: 'question', description: 'old', required: true }],
    },
  ]);
  const result = await f.run();
  assert.equal(result.published, 2);
  assert.equal(result.removed, 2);
  assert.deepEqual(f.remote.get(f.global), []);
  const guild = f.remote.get(f.guild)!;
  assert(!guild.some((item) => item.name === 'voice'));
  assert(guild.some((item) => item.name === 'join'));
  assert.deepEqual(
    (guild.find((item) => item.name === 'ask')!.options as Definition[]).map((item) => item.name),
    ['prompt', 'file'],
  );
  assert(f.store.get('core.commands', `${APP}:global`));
});
test('a matching local checkpoint never hides removed or modified remote definitions', async (t) => {
  const f = fixture(t);
  await f.run();
  const checkpoint = f.store.get('core.commands', `${APP}:${G}`);
  assert(checkpoint);
  f.puts.length = 0;
  f.remote.set(f.guild, [
    {
      name: 'ask',
      type: 1,
      description: 'outdated',
      options: [{ name: 'question', type: 3, description: 'outdated', required: true }],
    },
  ]);
  await f.run();
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0]!.route, f.guild);
  assert.equal(f.store.get('core.commands', `${APP}:${G}`), checkpoint);
  f.remote.set(f.guild, []);
  await f.run();
  assert.equal(f.puts.length, 2);
});
test('server IDs, versions, harmless defaults, localization map ordering and command ordering do not cause republishing', async (t) => {
  const f = fixture(t);
  await f.run();
  f.puts.length = 0;
  const current = f.remote.get(f.guild)!;
  f.remote.set(
    f.guild,
    current
      .map((command, index) => ({
        ...command,
        id: String(index),
        application_id: APP,
        guild_id: G,
        version: 'v2',
        default_member_permissions: null,
        nsfw: false,
        options: command.options ?? [],
        description: command.description ?? '',
        name_localizations: command.name_localizations ?? null,
        description_localizations: command.description_localizations ?? null,
      }))
      .reverse(),
  );
  await f.run();
  assert.equal(f.puts.length, 0);
  assert(f.reads.filter((route) => route === f.global).length >= 2);
});
test('global publication clears this app’s old guild shadows only in installed servers', async (t) => {
  const f = fixture(t, {}),
    outside = Routes.applicationGuildCommands(APP, OTHER);
  f.remote.set(f.guild, [{ name: 'voice', type: 1, description: 'obsolete' }]);
  f.remote.set(outside, [{ name: 'external', type: 1, description: 'outside current installation' }]);
  await f.run();
  assert.deepEqual(f.remote.get(f.guild), []);
  assert.equal(f.remote.get(outside)!.length, 1);
  assert(!f.reads.includes(outside));
  assert(f.remote.get(f.global)!.some((item) => item.name === 'join'));
});
test('user-install personal names have one global definition and no duplicate guild definition', () => {
  const scopes = desiredCommandScopes(loadConfig({ DISCORD_GUILD_IDS: G, ENABLE_USER_INSTALL: 'true' })),
    global = scopes.find((scope) => scope.id === 'global')!.body,
    guild = scopes.find((scope) => scope.id === G)!.body;
  for (const command of global) assert(!guild.some((other) => other.name === command.name));
  assert(global.some((item) => item.name === 'ask'));
  assert(guild.some((item) => item.name === 'join'));
});
test('native primary entry point stays global and an obsolete primary entry point is removed when disabled', async (t) => {
  const f = fixture(t, {
    DISCORD_GUILD_IDS: G,
    ACTIVITY_PUBLIC_URL: 'https://activity.example.org',
    DISCORD_CLIENT_SECRET: 'fixture-secret',
  });
  await f.run();
  assert.equal(
    f.remote.get(f.global)!.filter((item) => item.type === ApplicationCommandType.PrimaryEntryPoint).length,
    1,
  );
  assert(!f.remote.get(f.guild)!.some((item) => item.type === ApplicationCommandType.PrimaryEntryPoint));
  f.config.optionalEnvironment = {};
  await f.run();
  assert.deepEqual(f.remote.get(f.global), []);
});
test('unverified write results never become successful checkpoints', async (t) => {
  const f = fixture(t);
  f.rest.put = async () => {};
  await assert.rejects(f.run(), /verification failed/);
  assert.equal(f.store.list('core.commands').length, 0);
});
test('configured uninstalled servers and malformed lists fail before command writes', async (t) => {
  const f = fixture(t, { DISCORD_GUILD_IDS: OTHER });
  await assert.rejects(f.run(), /not currently installed/);
  assert.equal(f.puts.length, 0);
  assert.throws(() => normalizedCommandDefinitions({ commands: [] }, true), /invalid/);
});
test('behavioral option drift includes requirements, constraints, localization and choice changes', () => {
  const base = [
    {
      name: 'ask',
      description: 'Chat',
      type: 1,
      options: [{ type: 3, name: 'prompt', description: 'Question', required: true, max_length: 6000 }],
    },
  ];
  const canonical = JSON.stringify(normalizedCommandDefinitions(base, false));
  for (const delta of [
    { required: false },
    { max_length: 1000 },
    { name_localizations: { 'es-ES': 'pregunta' } },
    { choices: [{ name: 'A', value: 'a' }] },
  ]) {
    const modified = structuredClone(base);
    Object.assign(modified[0]!.options[0]!, delta);
    assert.notEqual(JSON.stringify(normalizedCommandDefinitions(modified, false)), canonical);
  }
});
test('REST-only guild discovery paginates with the actual final snowflake', async () => {
  const ids = Array.from({ length: 201 }, (_, index) => String(820000000000000000n + BigInt(index))),
    queries: URLSearchParams[] = [];
  const rest = {
    get: async (_route: string, options: { query: URLSearchParams }) => {
      queries.push(options.query);
      return (queries.length === 1 ? ids.slice(0, 200) : ids.slice(200)).map((id) => ({ id }));
    },
  };
  assert.deepEqual(await installedCommandGuildIds(rest as unknown as REST), ids);
  assert.equal(queries[1]!.get('after'), ids[199]);
});
