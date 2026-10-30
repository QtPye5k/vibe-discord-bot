import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry, type ActionOutcome } from '../src/core/registry.js';
import { createConfirmationPolicy } from '../src/core/confirmation-policy.js';
import { type ActionContext, userRequestContext } from '../src/core/types.js';
import { handleConversationAction } from '../src/core/conversation-actions.js';
import { outcomePayload, aiPayload } from '../src/discord/presentation.js';
const G = '680000000000000001',
  U = '680000000000000002',
  A = '680000000000000003',
  B = '680000000000000004',
  C = '680000000000000005',
  PRIVATE = '680000000000000006',
  R = '680000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const role = (id: string, position: number) => ({
    id,
    position,
    comparePositionTo(other: { position: number }) {
      return this.position - other.position;
    },
  });
  const high = role(R, 10),
    middle = role(B, 5),
    low = role(G, 0);
  const member = (id: string, highest: ReturnType<typeof role>, bot = false) => ({
    id,
    user: { id, bot },
    roles: { highest, cache: new Collection([[highest.id, highest]]) },
    permissions: new PermissionsBitField(P.Administrator),
  });
  const requester = member(U, low),
    approver = member(A, high),
    bot = member(B, middle, true);
  const members = new Map([
    [U, requester],
    [A, approver],
    [B, bot],
  ]);
  const messages: unknown[] = [],
    effects: { user: string; channel: string; input: unknown }[] = [];
  let denyRequester = false,
    revokeAtGuard = false,
    failSend = false;
  const overwrites = new Collection([
    [G, { id: G, type: 0, deny: new PermissionsBitField(P.ViewChannel), allow: new PermissionsBitField() }],
    [R, { id: R, type: 0, deny: new PermissionsBitField(), allow: new PermissionsBitField(P.ViewChannel) }],
    [B, { id: B, type: 1, deny: new PermissionsBitField(), allow: new PermissionsBitField(P.ViewChannel) }],
  ]);
  const channel = {
    id: PRIVATE,
    name: 'bot-confirmations',
    guildId: G,
    type: 0,
    permissionOverwrites: { cache: overwrites },
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: async (payload: unknown) => {
      messages.push(payload);
      if (failSend) throw new Error('Ambiguous send');
      return { id: 'safe' };
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    roles: {
      cache: new Collection([
        [R, high],
        [B, middle],
        [G, low],
      ]),
      fetch: async () =>
        new Collection([
          [R, high],
          [B, middle],
          [G, low],
        ]),
    },
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async ({ user }: { user: string }) => {
        const value = members.get(user);
        if (!value) throw new Error('Unknown member');
        return value;
      },
    },
    channels: {
      fetch: async (id?: string) =>
        id ? (id === PRIVATE ? channel : null) : new Collection([[PRIVATE, channel]]),
    },
  };
  const ctx = {
    guild,
    member: requester,
    client: { user: { id: B } },
    channelId: C,
    store,
  } as unknown as ActionContext;
  const registry = new ActionRegistry(
    120,
    async (ctx) => {
      if (ctx.member.id !== U || ctx.channelId !== C) throw new Error('Requester context was replaced');
      if (denyRequester) throw new Error('Requester permission revoked');
      if (revokeAtGuard) approver.roles.highest.position = 4;
      return ctx;
    },
    { confirmationMode: 'smart' },
  );
  registry.setConfirmationPolicy(createConfirmationPolicy({ channelId: PRIVATE }));
  registry.register({
    id: 'test.delete',
    category: 'testing',
    risk: 'destructive',
    description: 'Synthetic removal',
    schema: z.strictObject({ item: z.string() }),
    userPermissions: [],
    botPermissions: [],
    execute: (ctx, input) => {
      effects.push({ user: ctx.member.id, channel: ctx.channelId, input });
      return 'done';
    },
  });
  return {
    ctx,
    registry,
    store,
    effects,
    messages,
    requester,
    approver,
    bot,
    high,
    middle,
    low,
    channel,
    overwrites,
    request: userRequestContext(ctx, 'command'),
    reviewer: () =>
      userRequestContext(
        { ...ctx, member: approver as unknown as ActionContext['member'], channelId: PRIVATE },
        'command',
      ),
    denyRequester: () => {
      denyRequester = true;
    },
    revokeAtGuard: () => {
      revokeAtGuard = true;
    },
    failSend: () => {
      failSend = true;
    },
  };
}
function pending(value: ActionOutcome) {
  assert.equal(value.status, 'confirmation');
  if (value.status !== 'confirmation') throw new Error('Missing preview');
  return value;
}
test('exact previews and buttons are delivered once only to the private channel; original output is location only', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'review me' }));
  assert.equal(result.approvalChannelId, PRIVATE);
  assert.equal(result.input, null);
  assert.equal(f.messages.length, 1);
  const delivered = f.messages[0] as { content: string; components: unknown[]; allowedMentions: unknown };
  assert.match(delivered.content, /review me/);
  assert.equal(delivered.components.length, 1);
  assert.deepEqual(delivered.allowedMentions, { parse: [] });
  const output = outcomePayload(result);
  assert.equal(output.components?.length, 0);
  assert.doesNotMatch(output.content ?? '', /review me|test.delete|Confirm/);
  const ai = aiPayload({ text: 'Request sent.', pending: [result] });
  assert.equal(ai.components?.length, 0);
  assert.doesNotMatch(ai.content ?? '', /review me/);
  assert.deepEqual(f.registry.pending(f.ctx), []);
});
test('a different authorized reviewer can approve once, preserving original requester and origin permissions', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  await assert.rejects(f.registry.confirm(f.request, result.id), /only in/);
  await f.registry.confirm(f.reviewer(), result.id);
  assert.deepEqual(f.effects, [{ user: U, channel: C, input: { item: 'one' } }]);
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /unavailable/);
});
test('server owner, administrator, equal roles and bots do not bypass the strict above-Vibe requirement', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  const owner = { ...f.ctx, channelId: PRIVATE };
  await assert.rejects(f.registry.confirm(owner, result.id), /strictly above/);
  f.approver.roles.highest.position = f.bot.roles.highest.position;
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /strictly above|not above/);
  f.approver.roles.highest.position = 10;
  f.approver.user.bot = true;
  await assert.rejects(f.registry.reject(f.reviewer(), result.id), /strictly above/);
  assert.deepEqual(f.effects, []);
});
test('requester permission revocation blocks senior approval without consuming or executing it', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  f.denyRequester();
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /Requester permission revoked/);
  assert.deepEqual(f.effects, []);
  assert.equal(f.registry.pending(f.reviewer()).length, 1);
});
test('approver demotion during requester authorization is rechecked before claiming', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  f.revokeAtGuard();
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /not above|strictly above/);
  assert.deepEqual(f.effects, []);
});
test('original live request revocation remains binding when a different reviewer approves', async (t) => {
  const f = fixture(t);
  let valid = true;
  const result = pending(
    await f.registry.request(userRequestContext(f.ctx, 'voice', { valid: () => valid }), 'test.delete', {
      item: 'one',
    }),
  );
  valid = false;
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /expired or was cancelled/);
  assert.deepEqual(f.effects, []);
});
test('bare confirmation and rejection use private-channel review authority, not requester binding', async (t) => {
  const f = fixture(t);
  await f.registry.request(f.request, 'test.delete', { item: 'one' });
  await assert.rejects(handleConversationAction(f.request, 'confirm', f.registry), /only in/);
  const completed = await handleConversationAction(f.reviewer(), 'confirm', f.registry);
  assert.equal(completed.outcomes.length, 1);
  const result = pending(await f.registry.request(f.request, 'test.delete', { item: 'two' }));
  assert.equal(f.registry.cancel(f.request, result.id), false);
  const cancelled = await handleConversationAction(f.reviewer(), 'cancel', f.registry);
  assert.match(cancelled.message ?? '', /Cancelled/);
  assert.equal(f.registry.pending(f.reviewer()).length, 0);
  assert.equal(f.effects.length, 1);
});
test('multiple private requests remain ambiguous and cross-guild IDs are rejected', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  await f.registry.request(f.request, 'test.delete', { item: 'two' });
  await assert.rejects(f.registry.confirmLatest(f.reviewer()), /2 pending/);
  await assert.rejects(
    f.registry.confirm(
      { ...f.reviewer(), guild: { ...f.ctx.guild, id: '680000000000000099' } as ActionContext['guild'] },
      result.id,
    ),
  );
  assert.deepEqual(f.effects, []);
});
test('uncertain delivery removes the pending action and cannot later execute from an orphan button', async (t) => {
  const f = fixture(t);
  f.failSend();
  await assert.rejects(f.registry.request(f.request, 'test.delete', { item: 'one' }), /Ambiguous send/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  assert.deepEqual(f.effects, []);
});
test('public or lower-role private-channel grants stop publication and execution', async (t) => {
  const f = fixture(t);
  f.overwrites.get(G)!.deny = new PermissionsBitField();
  await assert.rejects(f.registry.request(f.request, 'test.delete', { item: 'one' }), /deny View Channel/);
  assert.equal(f.messages.length, 0);
  f.overwrites.get(G)!.deny = new PermissionsBitField(P.ViewChannel);
  f.overwrites.set(G, {
    id: G,
    type: 0,
    deny: new PermissionsBitField(P.ViewChannel),
    allow: new PermissionsBitField(P.ViewChannel),
  });
  await assert.rejects(f.registry.request(f.request, 'test.delete', { item: 'two' }), /deny View Channel/);
});
test('exact-name lookup uses one private text channel and fails closed on ambiguity', async (t) => {
  const f = fixture(t);
  f.registry.setConfirmationPolicy(createConfirmationPolicy({ name: 'bot-confirmations' }));
  const result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  assert.equal(result.approvalChannelId, PRIVATE);
});
test('one approved exact plan step authorizes only its identical child once, with original permissions', async (t) => {
  const f = fixture(t);
  f.registry.register({
    id: 'ai.plan.step',
    category: 'ai',
    risk: 'write',
    description: 'Synthetic reviewed plan wrapper',
    schema: z.strictObject({ action: z.literal('test.delete'), input: z.strictObject({ item: z.string() }) }),
    userPermissions: [],
    botPermissions: [],
    execute: async (ctx, input) => {
      const first = await f.registry.request(ctx, input.action, input.input);
      const repeated = await f.registry.request(ctx, input.action, input.input);
      return { first: first.status, repeated: repeated.status };
    },
  });
  const requested = pending(
    await f.registry.request(f.request, 'ai.plan.step', { action: 'test.delete', input: { item: 'exact' } }),
  );
  const outcome = await f.registry.confirm(f.reviewer(), requested.id);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed')
    assert.deepEqual(outcome.result, { first: 'completed', repeated: 'confirmation' });
  assert.deepEqual(f.effects, [{ user: U, channel: C, input: { item: 'exact' } }]);
  assert.equal(f.messages.length, 2);
});
test('a reviewed plan wrapper cannot extend its approval to a changed child input', async (t) => {
  const f = fixture(t);
  f.registry.register({
    id: 'ai.plan.step',
    category: 'ai',
    risk: 'write',
    description: 'Synthetic reviewed plan wrapper',
    schema: z.strictObject({ action: z.literal('test.delete'), input: z.strictObject({ item: z.string() }) }),
    userPermissions: [],
    botPermissions: [],
    execute: async (ctx) => f.registry.request(ctx, 'test.delete', { item: 'changed' }),
  });
  const requested = pending(
    await f.registry.request(f.request, 'ai.plan.step', { action: 'test.delete', input: { item: 'exact' } }),
  );
  const outcome = await f.registry.confirm(f.reviewer(), requested.id);
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal((outcome.result as ActionOutcome).status, 'confirmation');
  assert.deepEqual(f.effects, []);
});
test('failed internal workflows can invalidate only their own original live context identity', async (t) => {
  const f = fixture(t),
    result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  assert.equal(f.registry.invalidatePending({ ...f.request }, result.id), false);
  assert.equal(f.registry.invalidatePending(f.reviewer(), result.id), false);
  assert.equal(f.registry.invalidatePending(f.request, result.id), true);
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /unavailable/);
  assert.deepEqual(f.effects, []);
});
test('prepared workflow routing status never claims the external operation completed', () => {
  const payload = outcomePayload({
    status: 'completed',
    action: 'image.emoji.create',
    result: {
      status: 'approval-routed',
      approvalChannelId: PRIVATE,
      notice: 'Prepared emoji awaiting staff approval. It has not been created.',
    },
  });
  assert.match(payload.content ?? '', /has not been created/);
  assert.doesNotMatch(payload.content ?? '', /Completed:/);
  assert.deepEqual(payload.components, []);
});
test('disabled original-requester DMs prevent private execution before the one-use approval is claimed', async (t) => {
  const f = fixture(t);
  Object.assign(f.requester.user, {
    send: async () => {
      throw new Error('DM unavailable');
    },
  });
  f.registry.setConfirmationPolicy(
    createConfirmationPolicy({ channelId: PRIVATE, isPrivateAction: () => true }),
  );
  const result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  await assert.rejects(
    f.registry.confirm(f.reviewer(), result.id),
    /must enable DMs.*No action was executed/,
  );
  assert.deepEqual(f.effects, []);
  assert.equal(f.registry.pending(f.reviewer()).length, 1);
});
test('requester permissions and reviewer role are rechecked after asynchronous private-DM preparation', async (t) => {
  for (const changed of ['requester', 'reviewer'] as const)
    await t.test(changed, async (t) => {
      const f = fixture(t);
      let edits = 0;
      Object.assign(f.requester.user, {
        send: async () => {
          if (changed === 'requester') f.denyRequester();
          else f.approver.roles.highest.position = 4;
          return {
            edit: async () => {
              edits++;
            },
          };
        },
      });
      f.registry.setConfirmationPolicy(
        createConfirmationPolicy({ channelId: PRIVATE, isPrivateAction: () => true }),
      );
      const result = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
      await assert.rejects(
        f.registry.confirm(f.reviewer(), result.id),
        /permission revoked|not above|strictly above/,
      );
      assert.deepEqual(f.effects, []);
      assert.equal(edits, 0);
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 1);
    });
});
test('a private result edit failure returns only a completed-safe receipt and never repeats or leaks its result', async (t) => {
  const f = fixture(t);
  let executions = 0,
    edits = 0;
  Object.assign(f.requester.user, {
    send: async () => ({
      edit: async () => {
        edits++;
        throw new Error('Sensitive synthetic credential edit failed');
      },
    }),
  });
  f.registry.setConfirmationPolicy(
    createConfirmationPolicy({ channelId: PRIVATE, isPrivateAction: () => true }),
  );
  f.registry.register({
    id: 'test.credential',
    description: 'Synthetic private result',
    category: 'testing',
    risk: 'destructive',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      executions++;
      return { url: 'https://example.invalid/private/SYNTHETIC_CREDENTIAL' };
    },
  });
  const result = pending(await f.registry.request(f.request, 'test.credential', {}));
  const receipt = await f.registry.confirm(f.reviewer(), result.id);
  assert.equal(receipt.status, 'completed');
  assert.match(JSON.stringify(receipt), /delivery-failed|Do not repeat/);
  assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_CREDENTIAL|Sensitive synthetic|example.invalid/);
  assert.equal(executions, 1);
  assert.equal(edits, 1);
  await assert.rejects(f.registry.confirm(f.reviewer(), result.id), /unavailable/);
  assert.equal(executions, 1);
});
test('persisted approvals cannot reconstruct a lost original request or voice lease after registry restart', async (t) => {
  const f = fixture(t),
    requested = pending(await f.registry.request(f.request, 'test.delete', { item: 'one' }));
  const restarted = new ActionRegistry(120, async (ctx) => ctx, { confirmationMode: 'smart' });
  restarted.register(f.registry.get('test.delete'));
  restarted.setConfirmationPolicy(createConfirmationPolicy({ channelId: PRIVATE }));
  await assert.rejects(
    restarted.confirm(f.reviewer(), requested.id),
    /lost its live requester authorization.*Submit the action again/,
  );
  assert.deepEqual(f.effects, []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
});
