import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  DiscordAPIError,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import { registerHistoryModerationActions, type HistoryCleanupResult } from '../src/moderation/history.js';
import { moderationPolicySchema, type ExplicitClassification } from '../src/moderation/service.js';

const G = '940000000000000001',
  U = '940000000000000002',
  B = '940000000000000003',
  C = '940000000000000004',
  LOG = '940000000000000005';
function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    messages = new Map<string, Message>(),
    state = {
      userManage: true,
      botManage: true,
      hostEnabled: true,
      calls: 0,
      pages: [] as { limit: number; before?: string }[],
      deleted: [] as string[],
      classify: undefined as ((message: Message) => Promise<ExplicitClassification>) | undefined,
      beforeFresh: undefined as ((messageId: string) => void) | undefined,
    };
  t.after(() => store.close());
  const permissions = (manage: boolean) =>
      new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, ...(manage ? [P.ManageMessages] : [])]),
    member = {
      id: U,
      user: { id: U, bot: false },
      permissions: permissions(true),
      roles: { cache: new Collection() },
    },
    bot = { id: B, permissions: permissions(true) };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    permissionsFor: (who: { id: string }) => permissions(who.id === U ? state.userManage : state.botManage),
    messages: {
      fetch: async (input: { message?: string; limit?: number; before?: string; force?: boolean }) => {
        if (input.message) {
          assert.equal(input.force, true);
          state.beforeFresh?.(input.message);
          const found = messages.get(input.message);
          if (!found)
            throw new DiscordAPIError(
              { message: 'Unknown Message', code: 10008 },
              10008,
              404,
              'GET',
              'https://discord.com/api/example',
              {},
            );
          return found;
        }
        assert(input.limit && input.limit <= 100);
        state.pages.push({ limit: input.limit, before: input.before });
        return new Collection(
          [...messages.values()]
            .filter((message) => !input.before || BigInt(message.id) < BigInt(input.before))
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
            .slice(0, input.limit)
            .map((message) => [message.id, message]),
        );
      },
    },
    delete: () => {
      throw new Error('A cleanup must never delete the channel');
    },
    bulkDelete: () => {
      throw new Error('Cleanup must individually remove old posts');
    },
  };
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async (id: string) => (id === C ? channel : null) },
  };
  const client = { user: { id: B } },
    ctx = userRequestContext(
      { client, guild, member, channelId: C, store } as unknown as ActionContext,
      'command',
    ),
    registry = new ActionRegistry(120, async (context) => context, { confirmationMode: 'smart' });
  store.set(
    'moderation.automatic',
    G,
    moderationPolicySchema.parse({
      enabled: true,
      textEnabled: true,
      imagesEnabled: true,
      logChannelId: LOG,
    }),
  );
  registerHistoryModerationActions(registry, {
    hostEnabled: () => state.hostEnabled,
    classify: async (message) => {
      state.calls++;
      return state.classify
        ? state.classify(message)
        : { remove: message.content === 'flagged', categories: [], scannedImages: 0 };
    },
  });
  let sequence = 0;
  const add = (content: string, patch: Partial<Omit<Message, 'valueOf'>> = {}) => {
    const id = String(950000000000000000n + BigInt(++sequence));
    const message = {
      id,
      guildId: G,
      guild,
      channelId: C,
      channel,
      content,
      cleanContent: content,
      author: { id: U, bot: false },
      member,
      system: false,
      editedTimestamp: null,
      createdTimestamp: Date.now() - 30 * 86400000 + sequence * 1000,
      attachments: new Collection(),
      stickers: new Collection(),
      embeds: [],
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      deletable: true,
      delete: async () => {
        state.deleted.push(id);
        messages.delete(id);
      },
      ...patch,
    } as unknown as Message;
    messages.set(id, message);
    return message;
  };
  const run = async (input: Record<string, unknown> = {}) => {
    const result = await registry.request(ctx, 'moderation.history.clean', input);
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('An explicit smart-mode cleanup should run directly');
    return result.result as HistoryCleanupResult;
  };
  return { store, state, messages, add, run, registry, ctx };
}

test('Explicit historical cleanup deletes old offending posts individually, preserves benign/Vibe posts and never deletes a channel', async (t) => {
  const f = fixture(t),
    old = f.add('flagged'),
    benign = f.add('a safe neighboring message'),
    own = f.add('flagged', { author: { id: B, bot: true } as Message['author'] });
  assert(old.createdTimestamp < Date.now() - 14 * 86400000);
  const result = await f.run();
  assert.equal(result.scanned, 3);
  assert.equal(result.deleted, 1);
  assert.equal(result.exhausted, true);
  assert.equal(result.continuation, null);
  assert.deepEqual(f.state.deleted, [old.id]);
  assert(f.messages.has(benign.id));
  assert(f.messages.has(own.id));
  assert(!JSON.stringify(result).includes('safe neighboring'));
});
test('Historical spam cleanup removes all four repeats in an eight-second burst and preserves a distinct neighbor', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', G, { antiSpamEnabled: true, antiSpamExemptStaff: false });
  const first = f.add('same spam'),
    second = f.add('same spam'),
    neighbor = f.add('benign neighbor'),
    third = f.add('same spam'),
    fourth = f.add('same spam');
  const result = await f.run();
  assert.equal(result.deleted, 4);
  assert.deepEqual(new Set(f.state.deleted), new Set([first.id, second.id, third.id, fourth.id]));
  assert(f.messages.has(neighbor.id));
});
test('Historical cleanup honors a configured three-repeat limit for previously retained short spam', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', G, { antiSpamEnabled: true, antiSpamExemptStaff: false, repeatLimit: 3 });
  const first = f.add('h'),
    second = f.add('h'),
    neighbor = f.add('legitimate neighbor'),
    third = f.add('h');
  const result = await f.run();
  assert.equal(result.deleted, 3);
  assert.deepEqual(new Set(f.state.deleted), new Set([first.id, second.id, third.id]));
  assert(f.messages.has(neighbor.id));
});
test('Local content-policy rules remove matching history without making a provider request', async (t) => {
  const f = fixture(t),
    message = f.add('Watch free porn videos');
  const result = await f.run();
  assert.equal(result.deleted, 1);
  assert.deepEqual(f.state.deleted, [message.id]);
  assert.equal(f.state.calls, 0);
});
test('History limits and before cursors paginate a bounded channel scan without exporting content', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 105; index++) f.add(`safe message ${index}`);
  const first = await f.run({ limit: 100 });
  assert.equal(first.scanned, 100);
  assert.equal(first.exhausted, false);
  assert(first.continuation);
  const second = await f.run({ limit: 100, before: first.continuation });
  assert.equal(second.scanned, 5);
  assert.equal(second.exhausted, true);
  assert.equal(second.continuation, null);
  assert(f.state.pages.every((page) => page.limit <= 100));
  await assert.rejects(f.run({ limit: 501 }), /500/);
});
test('Historical cleanup rechecks message revision and current Manage Messages access before each delete', async (t) => {
  for (const kind of ['edited', 'permission'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub),
        message = f.add('flagged');
      f.state.classify = async () => {
        if (kind === 'edited')
          f.messages.set(message.id, {
            ...message,
            content: 'safe edited content',
            editedTimestamp: Date.now(),
          } as Message);
        else f.state.userManage = false;
        return { remove: true, categories: [], scannedImages: 0 };
      };
      const result = await f.run();
      assert.deepEqual(f.state.deleted, []);
      if (kind === 'permission') assert.match(result.stopped ?? '', /permissions/);
      else assert.equal(result.skipped, 1);
    });
});
test('A mid-run moderation-policy revocation stops cleanup before deleting and provider failures remain visible', async (t) => {
  const f = fixture(t);
  f.add('flagged');
  f.state.classify = async () => {
    f.store.set('moderation.automatic', G, { enabled: false });
    return { remove: true, categories: [], scannedImages: 0 };
  };
  const result = await f.run();
  assert.equal(result.deleted, 0);
  assert.match(result.stopped ?? '', /enabled|settings/);
  const failed = fixture(t);
  for (let index = 0; index < 5; index++) failed.add('safe');
  failed.state.classify = async () => {
    throw new Error('PRIVATE_PROVIDER_MESSAGE');
  };
  const failures = await failed.run();
  assert.equal(failures.providerFailures, 3);
  assert.equal(failures.deleted, 0);
  assert.equal(failures.exhausted, false);
  assert(!JSON.stringify(failures).includes('PRIVATE_PROVIDER_MESSAGE'));
});
test('History cleanup never scans the private moderation case log and cannot run with disabled policy or host', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ channelId: LOG }), /log is preserved/);
  f.state.hostEnabled = false;
  await assert.rejects(f.run(), /enabled/);
  assert.equal(f.state.calls, 0);
  assert.deepEqual(f.state.deleted, []);
});
