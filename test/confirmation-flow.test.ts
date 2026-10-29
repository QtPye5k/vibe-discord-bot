import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ActionRegistry, type ActionOutcome, type ConfirmationMode } from '../src/core/registry.js';
import { userRequestContext, isCurrentUserRequest, type ActionContext } from '../src/core/types.js';
import {
  handleConversationAction,
  rememberConversationActions,
  clearConversationActions,
} from '../src/core/conversation-actions.js';
import { Store } from '../src/core/store.js';
import { UserError } from '../src/core/errors.js';
const G = '780000000000000001',
  U = '780000000000000002',
  C = '780000000000000003',
  OTHER = '780000000000000004';
type Pending = Extract<ActionOutcome, { status: 'confirmation' }>;
function fixture(t: TestContext, mode: ConfirmationMode = 'smart') {
  const store = new Store(':memory:'),
    effects: string[] = [];
  let guards = 0,
    deny = false;
  const ctx = {
    guild: { id: G },
    member: { id: U, roles: { cache: new Map() } },
    channelId: C,
    store,
  } as unknown as ActionContext;
  const registry = new ActionRegistry(
    120,
    async (fresh) => {
      guards++;
      if (deny) throw new UserError('Current permission was withdrawn.');
      return { ...fresh };
    },
    { confirmationMode: mode },
  );
  for (const [id, risk, category] of [
    ['test.write', 'write', 'testing'],
    ['test.delete', 'destructive', 'testing'],
    ['role.assign', 'write', 'roles'],
    ['system.action-policy.set', 'write', 'system'],
  ] as const)
    registry.register({
      id,
      category,
      risk,
      description: 'Fixture operation',
      schema: z.strictObject({ name: z.string() }),
      userPermissions: [],
      botPermissions: [],
      execute: (_ctx, input) => {
        effects.push(input.name);
        return input.name;
      },
    });
  t.after(() => store.close());
  return {
    ctx,
    store,
    registry,
    effects,
    request: userRequestContext(ctx, 'chat'),
    guards: () => guards,
    deny: () => {
      deny = true;
    },
  };
}
function pending(value: ActionOutcome): Pending {
  assert.equal(value.status, 'confirmation');
  if (value.status !== 'confirmation') throw new Error('No preview');
  return value;
}

test('Smart mode executes an explicit ordinary user write once, while background and always-mode requests retain previews', async (t) => {
  const f = fixture(t);
  assert(isCurrentUserRequest(f.request));
  assert.equal((await f.registry.request(f.request, 'test.write', { name: 'now' })).status, 'completed');
  assert.deepEqual(f.effects, ['now']);
  assert.equal(f.registry.pending(f.ctx).length, 0);
  assert.equal(f.guards(), 1);
  assert.equal(
    (await f.registry.request(f.ctx, 'test.write', { name: 'background' })).status,
    'confirmation',
  );
  const strict = fixture(t, 'always');
  assert.equal(
    (await strict.registry.request(strict.request, 'test.write', { name: 'later' })).status,
    'confirmation',
  );
  assert.deepEqual(strict.effects, []);
});
test('User request provenance cannot cross actors/channels or survive JSON persistence, and expires after five minutes', async (t) => {
  const f = fixture(t),
    otherChannel = { ...f.request, channelId: OTHER },
    otherMember = { ...f.request, member: { ...f.ctx.member, id: OTHER } as ActionContext['member'] };
  assert.equal(isCurrentUserRequest(otherChannel), false);
  assert.equal(isCurrentUserRequest(otherMember), false);
  await assert.rejects(
    f.registry.request(otherChannel, 'test.write', { name: 'wrong channel' }),
    /expired or was cancelled/,
  );
  await assert.rejects(
    f.registry.request(otherMember, 'test.write', { name: 'wrong member' }),
    /expired or was cancelled/,
  );
  const decoded = JSON.parse(JSON.stringify({ ...f.request, store: undefined }));
  decoded.store = f.store;
  assert.equal(isCurrentUserRequest(decoded), false);
  assert.equal((await f.registry.request(decoded, 'test.write', { name: 'job' })).status, 'confirmation');
  const time = Date.now();
  t.mock.method(Date, 'now', () => time + 300001);
  assert.equal(isCurrentUserRequest(f.request), false);
  await assert.rejects(
    f.registry.request(f.request, 'test.write', { name: 'expired' }),
    /expired or was cancelled/,
  );
  assert.deepEqual(f.effects, []);
});
test('Destructive and authority-changing writes retain one exact confirmation with current checks and single-use claims', async (t) => {
  const f = fixture(t);
  for (const id of ['test.delete', 'role.assign', 'system.action-policy.set']) {
    const preview = pending(await f.registry.request(f.request, id, { name: id }));
    assert.deepEqual(f.effects.includes(id), false);
    assert.equal((await f.registry.confirm(f.request, preview.id)).status, 'completed');
    await assert.rejects(() => f.registry.confirm(f.request, preview.id), /unavailable/);
  }
  assert.equal(f.guards(), 6);
  assert.deepEqual(f.effects, ['test.delete', 'role.assign', 'system.action-policy.set']);
  const preview = pending(await f.registry.request(f.request, 'test.delete', { name: 'revoked' }));
  f.deny();
  await assert.rejects(() => f.registry.confirm(f.request, preview.id), /permission/);
  assert.equal(f.effects.includes('revoked'), false);
});
test('Smart writes retain strict input bounds, current module/policy checks and one premium admission', async (t) => {
  const f = fixture(t);
  let authorize = 0,
    begin = 0,
    finish = 0;
  f.registry.setAccessGate({
    authorize: async () => {
      authorize++;
      return 'proof';
    },
    begin: (_ctx, _action, grant) => {
      assert.equal(grant, 'proof');
      begin++;
      return {
        finish: (status) => {
          assert.equal(status, 'success');
          finish++;
        },
      };
    },
  });
  await f.registry.request(f.request, 'test.write', { name: 'metered' });
  assert.deepEqual([authorize, begin, finish], [1, 1, 1]);
  await assert.rejects(
    () => f.registry.request(f.request, 'test.write', { name: 'x'.repeat(12000000) }),
    /12 MB/,
  );
  assert.equal(begin, 1);
  f.store.set('core.actionPolicies', `${G}:test.write`, { enabled: false, roleIds: [], channelIds: [] });
  await assert.rejects(() => f.registry.request(f.request, 'test.write', { name: 'blocked' }), /disabled/);
  assert.equal(begin, 1);
});
test('A bare conversational confirmation executes the one real pending change, never prose, another actor or channel', async (t) => {
  const f = fixture(t),
    preview = pending(await f.registry.request(f.ctx, 'test.delete', { name: 'one' }));
  const outside = { ...f.ctx, channelId: OTHER };
  await assert.rejects(
    () => handleConversationAction(outside, `confirm ${preview.id}`, f.registry),
    /unavailable/,
  );
  const result = await handleConversationAction(f.request, 'Confirm!', f.registry);
  assert.equal(result.handled, true);
  assert.equal(result.outcomes.length, 1);
  assert.deepEqual(f.effects, ['one']);
  const repeated = await handleConversationAction(f.request, 'confirm', f.registry);
  assert.equal(repeated.outcomes.length, 0);
  assert.match(repeated.message!, /no pending/i);
  rememberConversationActions(f.ctx, [{ ...preview, id: 'fakepreview1234567' }]);
  assert.match((await handleConversationAction(f.ctx, 'confirm', f.registry)).message!, /no pending/i);
  assert.deepEqual(f.effects, ['one']);
});
test('One explicit gesture confirms the exact previews remembered from the displayed turn, leaving other previews alone', async (t) => {
  const f = fixture(t),
    first = pending(await f.registry.request(f.ctx, 'test.delete', { name: 'first' })),
    second = pending(await f.registry.request(f.ctx, 'test.delete', { name: 'second' }));
  await f.registry.request(f.ctx, 'test.delete', { name: 'unrelated' });
  rememberConversationActions(f.ctx, [first, second]);
  const result = await handleConversationAction(f.request, 'go ahead', f.registry);
  assert.equal(result.outcomes.length, 2);
  assert.deepEqual(f.effects, ['first', 'second']);
  assert.equal(f.registry.pending(f.ctx).length, 1);
  assert.match((await handleConversationAction(f.ctx, 'confirm', f.registry)).message!, /no pending/i);
  await handleConversationAction(f.ctx, 'confirm last', f.registry);
  assert.deepEqual(f.effects, ['first', 'second', 'unrelated']);
});
test('Ambiguous unbound previews ask once for a choice; expired displayed groups execute nothing; concurrent confirms execute once', async (t) => {
  const f = fixture(t),
    first = pending(await f.registry.request(f.ctx, 'test.delete', { name: 'first' }));
  await f.registry.request(f.ctx, 'test.delete', { name: 'second' });
  await assert.rejects(() => handleConversationAction(f.ctx, 'confirm', f.registry), /2 pending/);
  rememberConversationActions(f.ctx, [first]);
  f.store.db.prepare('UPDATE confirmations SET expires_at=? WHERE id=?').run(Date.now() - 1, first.id);
  await assert.rejects(() => handleConversationAction(f.ctx, 'confirm', f.registry), /expired or changed/);
  assert.deepEqual(f.effects, []);
  clearConversationActions(f.ctx);
  const newest = f.registry.pending(f.ctx)[0]!;
  const attempts = await Promise.allSettled([
    handleConversationAction(f.ctx, `Confirm ${newest.id}`, f.registry),
    handleConversationAction(f.ctx, `confirm ${newest.id}`, f.registry),
  ]);
  assert.equal(attempts.filter((row) => row.status === 'fulfilled').length, 1);
  assert.deepEqual(f.effects, ['second']);
});
test('Ordinary answers are not blanket approvals, and cancellation stays within the exact current conversation', async (t) => {
  const f = fixture(t);
  assert.equal((await handleConversationAction(f.ctx, 'yes', f.registry)).handled, false);
  await f.registry.request(f.ctx, 'test.delete', { name: 'own' });
  await f.registry.request({ ...f.ctx, channelId: OTHER }, 'test.delete', { name: 'other channel' });
  for (const text of [
    'do not confirm',
    'what does confirm mean',
    'confirm the capitalized W',
    'I said yes yesterday',
  ])
    assert.equal((await handleConversationAction(f.ctx, text, f.registry)).handled, false);
  const result = await handleConversationAction(f.ctx, 'cancel all', f.registry);
  assert.match(result.message!, /Cancelled that change/);
  assert.equal(f.registry.pending(f.ctx).length, 0);
  assert.equal(f.registry.pending({ ...f.ctx, channelId: OTHER }).length, 1);
  assert.deepEqual(f.effects, []);
});
test('A conversational approval is bound to the displayed arguments, not merely a reused pending ID', async (t) => {
  const f = fixture(t),
    preview = pending(await f.registry.request(f.ctx, 'test.delete', { name: 'displayed' }));
  rememberConversationActions(f.ctx, [preview]);
  f.store.db
    .prepare('UPDATE confirmations SET input=? WHERE id=?')
    .run(JSON.stringify({ name: 'changed behind the preview' }), preview.id);
  await assert.rejects(() => handleConversationAction(f.ctx, 'yes', f.registry), /expired or changed/);
  assert.deepEqual(f.effects, []);
});
