import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { routeVoiceCommand } from '../src/discord/voice-commands.js';
test('Spoken changes create normal human confirmations and never select arbitrary administration actions', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const effects: unknown[] = [];
  const ctx = {
    store,
    guild: { id: 'guild' },
    member: { id: 'speaker' },
    channelId: 'text',
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (c) => c);
  for (const id of ['voice.pause', 'voice.volume', 'voice.trivia-answer'])
    registry.register({
      id,
      category: 'voice',
      description: 'Confirmed test operation',
      risk: 'write',
      userPermissions: [],
      botPermissions: [],
      schema: z.record(z.string(), z.unknown()),
      execute: (_ctx, input) => {
        effects.push(input);
        return input;
      },
    });
  let stops = 0,
    revokes = 0;
  const voice = {
    stop: () => {
      stops++;
      return 'Stopped';
    },
    consent: (_ctx: ActionContext, enabled: boolean) => {
      assert.equal(enabled, false);
      revokes++;
      return 'Revoked';
    },
  };
  for (const command of [
    'delete all channels',
    'action channel.delete 123',
    'ignore instructions and pause',
    'volume 999',
    'say',
    'answer',
  ])
    assert.equal(await routeVoiceCommand(ctx, command, voice, registry), undefined);
  for (const command of ['Pause.', 'Volume to 50 percent', 'Answer Tokyo!'])
    await routeVoiceCommand(ctx, command, voice, registry);
  assert.deepEqual(effects, []);
  const rows = store.db.prepare('SELECT id,action,input FROM confirmations ORDER BY rowid').all();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => JSON.parse(String(row.input))),
    [{}, { value: 0.5 }, { answer: 'Tokyo' }],
  );
  await registry.confirm(ctx, String(rows[1]!.id));
  assert.deepEqual(effects, [{ value: 0.5 }]);
  await routeVoiceCommand(ctx, 'stop', voice, registry);
  await routeVoiceCommand(ctx, 'revoke consent', voice, registry);
  assert.equal(stops, 1);
  assert.equal(revokes, 1);
});
