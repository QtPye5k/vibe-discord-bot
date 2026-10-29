import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ApplicationIntegrationType, InteractionContextType, Routes, type REST } from 'discord.js';
import { runCommandDeployment } from '../scripts/deploy-commands.js';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/core/logger.js';
import { Store } from '../src/core/store.js';
import { personalCommandNames } from '../src/discord/commands.js';

const APP = '800000000000000001',
  GUILD = '800000000000000002';
interface Command {
  name: string;
  contexts?: number[];
  integration_types?: number[];
}
function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discord-deploy-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^discord-deploy-test-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const config = loadConfig({
    DISCORD_TOKEN: 'unit-test-discord-credential-value',
    DATABASE_PATH: join(directory, 'commands.sqlite'),
    ...env,
  });
  const calls: { route: string; body: Command[] }[] = [];
  const cleanup = { hashes: 0, handlers: 0 };
  const remote = new Map<string, Command[]>();
  const rest = {
    get: async (route: string) => {
      if (route === '/oauth2/applications/@me') return { id: APP };
      if (route === Routes.userGuilds()) return [{ id: GUILD }];
      return structuredClone(remote.get(route) ?? []);
    },
    put: async (route: string, options: { body: Command[] }) => {
      calls.push({ route, body: options.body });
      remote.set(route, structuredClone(options.body));
    },
    clearHashSweeper: () => {
      cleanup.hashes++;
    },
    clearHandlerSweeper: () => {
      cleanup.handlers++;
    },
  };
  const logger = new Logger();
  logger.info = () => {};
  const run = () => runCommandDeployment(config, { rest: rest as unknown as REST, logger });
  return { config, rest, calls, cleanup, logger, run, remote };
}

test('command deployment reuses production guild/global user-install scopes and persistent idempotence', async (t) => {
  const f = fixture(t, { DISCORD_GUILD_IDS: GUILD, ENABLE_USER_INSTALL: 'true' });
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]?.route, Routes.applicationGuildCommands(APP, GUILD));
  assert.ok(
    f.calls[0]!.body.every((command) => !('contexts' in command) && !('integration_types' in command)),
  );
  assert.equal(f.calls[1]?.route, Routes.applicationCommands(APP));
  assert.deepEqual(new Set(f.calls[1]!.body.map((command) => command.name)), personalCommandNames);
  for (const command of f.calls[1]!.body) {
    assert.ok(command.integration_types?.includes(ApplicationIntegrationType.UserInstall));
    assert.ok(command.contexts?.includes(InteractionContextType.BotDM));
    assert.ok(command.contexts?.includes(InteractionContextType.PrivateChannel));
  }
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.cleanup, { hashes: 2, handlers: 2 });
});

test('global installation deploys the full production catalog with configured personal contexts', async (t) => {
  const f = fixture(t, { ENABLE_USER_INSTALL: 'true' });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.route, Routes.applicationCommands(APP));
  const commands = f.calls[0]!.body;
  assert.ok(commands.length > personalCommandNames.size);
  assert.ok(
    commands
      .find((command) => command.name === 'ask')
      ?.integration_types?.includes(ApplicationIntegrationType.UserInstall),
  );
  assert.deepEqual(commands.find((command) => command.name === 'action')?.contexts, [
    InteractionContextType.Guild,
  ]);
});

test('failed publication cleans resources, persists only successful scopes and retries the unfinished scope', async (t) => {
  const f = fixture(t, { DISCORD_GUILD_IDS: GUILD, ENABLE_USER_INSTALL: 'true' });
  const send = f.rest.put;
  f.rest.put = async (route, options) => {
    if (route === Routes.applicationCommands(APP)) throw new Error('synthetic publication failure');
    await send(route, options);
  };
  await assert.rejects(f.run(), /synthetic/);
  assert.deepEqual(f.cleanup, { hashes: 1, handlers: 1 });
  const store = new Store(f.config.databasePath);
  assert.equal(store.list('core.commands').length, 1);
  store.close();
  f.rest.put = send;
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.route, Routes.applicationCommands(APP));
  assert.deepEqual(f.cleanup, { hashes: 2, handlers: 2 });
});

test('authentication failures close injected persistence and REST timers without a publication attempt', async (t) => {
  const f = fixture(t),
    store = new Store(f.config.databasePath);
  let closed = 0;
  const close = store.close.bind(store);
  store.close = () => {
    closed++;
    close();
  };
  f.rest.get = async () => {
    throw new Error('synthetic authentication failure');
  };
  await assert.rejects(
    runCommandDeployment(f.config, { store, rest: f.rest as unknown as REST, logger: f.logger }),
    /synthetic/,
  );
  assert.equal(closed, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.cleanup, { hashes: 1, handlers: 1 });
});

test('missing credentials fail before network or persistence creation and still release injected REST timers', async (t) => {
  const f = fixture(t);
  f.config.discordToken = 'placeholder';
  f.rest.get = async () => {
    throw new Error('must not authenticate');
  };
  await assert.rejects(f.run(), /Add your Discord bot token/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.cleanup, { hashes: 1, handlers: 1 });
});
