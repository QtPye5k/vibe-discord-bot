import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type Message } from 'discord.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import {
  communitySettingsSchema,
  getProfile,
  onCommunityMessage,
  registerCommunityActions,
  settings,
  type CommunitySettings,
} from '../src/features/community.js';

let sequence = 0;
function fixture(t: TestContext, configuration: Partial<CommunitySettings> = {}) {
  const store = new Store(':memory:'),
    guildId = String(100000000000001000n + BigInt(sequence++)),
    member = { id: '100000000000000002', permissions: new PermissionsBitField(P.ViewChannel) },
    bot = { id: '100000000000000003' },
    channelId = '100000000000000004',
    replies: unknown[] = [];
  t.after(() => store.close());
  let deletes = 0,
    deleteAllowed = true,
    deleteFailure = false,
    refresh: (() => Promise<void>) | undefined;
  const observed = new Map<string, Message>(),
    deletedIds: string[] = [];
  const channel = {
    id: channelId,
    guildId,
    isSendable: () => true,
    permissionsFor: () =>
      new PermissionsBitField(
        deleteAllowed ? P.ViewChannel | P.ReadMessageHistory | P.ManageMessages : P.ViewChannel,
      ),
    messages: {
      fetch: async (input: { message: string }) =>
        observed.get(input.message) ??
        (input.message === message.id ? (message as unknown as Message) : undefined),
    },
    send: async (payload: unknown) => {
      replies.push(payload);
      return { id: 'alert' };
    },
  };
  const guild = {
    id: guildId,
    members: {
      me: bot,
      fetchMe: async () => {
        await refresh?.();
        return bot;
      },
    },
    channels: { fetch: async () => channel },
  };
  const client = { channels: { fetch: async () => channel } },
    message = {
      id: 'message',
      guild,
      author: { id: member.id, bot: false },
      member,
      webhookId: null,
      client,
      channel,
      channelId,
      content: 'ordinary message',
      attachments: new Collection<string, { url: string }>(),
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      deletable: true,
      delete: async () => {
        deletes++;
        deletedIds.push(message.id);
        if (deleteFailure) throw new Error('Missing Permissions');
      },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
    };
  store.set('community.settings', guildId, { antiSpamEnabled: true, ...configuration });
  return {
    store,
    guildId,
    member,
    message,
    replies,
    deletedIds,
    get deletes() {
      return deletes;
    },
    receive: (content = message.content, options?: Parameters<typeof onCommunityMessage>[2]) => {
      message.content = content;
      return onCommunityMessage(message as unknown as Message, store, options);
    },
    receiveDistinct: (id: string, content: string) => {
      const item = {
        ...message,
        id,
        content,
        delete: async () => {
          deletes++;
          deletedIds.push(id);
          if (deleteFailure) throw new Error('Missing Permissions');
        },
      } as unknown as Message;
      observed.set(id, item);
      return onCommunityMessage(item, store, { spamOnly: true });
    },
    configure: (patch: Partial<CommunitySettings>) => {
      store.set('community.settings', guildId, { ...settings(store, guildId), ...patch });
    },
    context: { guild, client, member, store, channelId } as unknown as ActionContext,
    losePermission: () => {
      deleteAllowed = false;
    },
    failDeletion: () => {
      deleteFailure = true;
    },
    holdRefresh: (operation: () => Promise<void>) => {
      refresh = operation;
    },
  };
}

test('antispam staff exemption keeps its old default and actual configuration patches preserve an explicit false', async (t) => {
  const f = fixture(t),
    registry = new ActionRegistry();
  registerCommunityActions(registry);
  const action = registry.get('community.configure');
  assert.equal(communitySettingsSchema.parse({}).antiSpamExemptStaff, true);
  assert.equal(communitySettingsSchema.parse({}).repeatLimit, 4);
  await action.execute(
    f.context,
    action.schema.parse({ antiSpamExemptStaff: false, mentionLimit: 12, repeatLimit: 3 }),
  );
  await action.execute(f.context, action.schema.parse({ xpEnabled: true }));
  assert.equal(settings(f.store, f.guildId).antiSpamExemptStaff, false);
  assert.equal(settings(f.store, f.guildId).antiSpamEnabled, true);
  assert.equal(settings(f.store, f.guildId).mentionLimit, 12);
  assert.equal(settings(f.store, f.guildId).repeatLimit, 3);
  assert.equal(settings(f.store, f.guildId).xpEnabled, true);
});

test('staff and administrator spam is filtered when staff exemption is disabled', async (t) => {
  for (const permission of [P.ManageMessages, P.Administrator])
    await t.test(permission.toString(), async (sub) => {
      const f = fixture(sub, { blockedKeywords: ['forbidden'] });
      f.member.permissions = new PermissionsBitField(permission);
      assert.equal(await f.receive('forbidden message'), false);
      assert.equal(f.deletes, 0, 'existing installations retain the staff exemption');
      f.configure({ antiSpamExemptStaff: false });
      assert.equal(await f.receive('forbidden message'), true);
      assert.equal(f.deletes, 1);
    });
});

test('four repeated messages inside eight seconds are suppressed, then the window expires', async (t) => {
  const f = fixture(t);
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  for (const content of ['same text', ' SAME TEXT ', 'same   text']) {
    assert.equal(await f.receive(content), false);
    now += 1000;
  }
  assert.equal(await f.receive('same text'), true);
  assert.equal(f.deletes, 1);
  now += 8000;
  assert.equal(await f.receive('same text'), false);
  assert.equal(f.deletes, 1);
});
test('A fourth repeated post removes all four observed exact IDs and preserves a nonspam neighbor', async (t) => {
  const f = fixture(t);
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(await f.receiveDistinct('first', 'repeat me'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('neighbor', 'a legitimate different message'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('second', 'repeat me'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('third', 'repeat me'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('fourth', 'repeat me'), true);
  assert.deepEqual(f.deletedIds, ['first', 'second', 'third', 'fourth']);
});
test('A configured repeat limit of three removes all three posts and preserves a distinct neighbor', async (t) => {
  const f = fixture(t, { repeatLimit: 3 });
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(await f.receiveDistinct('first', 'h'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('neighbor', 'a legitimate different message'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('second', 'h'), false);
  now += 1000;
  assert.equal(await f.receiveDistinct('third', 'h'), true);
  assert.deepEqual(f.deletedIds, ['first', 'second', 'third']);
});

test('attachment-only repeats use stable URLs without confusing different attachments or empty messages', async (t) => {
  const repeated = fixture(t);
  for (let count = 0; count < 4; count++) {
    repeated.message.attachments.set('file', {
      url: `https://cdn.discordapp.com/attachments/1/2/test.png?ex=${count}`,
    });
    assert.equal(await repeated.receive(''), count === 3);
  }
  assert.equal(repeated.deletes, 1);
  const different = fixture(t);
  for (let count = 0; count < 4; count++) {
    different.message.attachments.set('file', {
      url: `https://cdn.discordapp.com/attachments/1/${count}/test.png`,
    });
    assert.equal(await different.receive(''), false);
  }
  const empty = fixture(t);
  for (let count = 0; count < 4; count++) assert.equal(await empty.receive(''), false);
  assert.equal(different.deletes, 0);
  assert.equal(empty.deletes, 0);
});

test('flooding and user, role or everyone mentions independently trigger suppression', async (t) => {
  const flood = fixture(t);
  for (let count = 0; count < 8; count++)
    assert.equal(await flood.receive(`different content ${count}`), false);
  assert.equal(await flood.receive('ninth message'), true);
  assert.equal(flood.deletes, 1);
  for (const kind of ['users', 'roles', 'everyone'] as const)
    await t.test(kind, async (sub) => {
      const f = fixture(sub, { mentionLimit: 3 });
      if (kind === 'everyone') f.message.mentions.everyone = true;
      else for (let count = 0; count < 3; count++) f.message.mentions[kind].set(String(count), {});
      assert.equal(await f.receive(), true);
      assert.equal(f.deletes, 1);
    });
});

test('handled spam receives no XP or FAQ response while ordinary content keeps both behaviors', async (t) => {
  const f = fixture(t, { xpEnabled: true, faqEnabled: true, blockedKeywords: ['forbidden'] });
  f.store.set('community.faq', `${f.guildId}:forbidden`, 'Do not send this reply.');
  f.store.set('community.faq', `${f.guildId}:rules`, 'Be kind.');
  assert.equal(await f.receive('forbidden'), true);
  assert.equal(getProfile(f.store, f.guildId, f.member.id).xp, 0);
  assert.deepEqual(f.replies, []);
  assert.equal(await f.receive('rules'), false);
  assert.equal(getProfile(f.store, f.guildId, f.member.id).xp, 15);
  assert.deepEqual(f.replies, [{ content: 'Be kind.', allowedMentions: { parse: [], repliedUser: false } }]);
});

test('separate spam and reward phases do not award unreviewed content or count one message twice', async (t) => {
  const f = fixture(t, { xpEnabled: true, faqEnabled: true, messageLimit: 3 });
  f.store.set('community.faq', `${f.guildId}:rules`, 'Be kind.');
  assert.equal(await f.receive('rules', { spamOnly: true }), false);
  assert.equal(getProfile(f.store, f.guildId, f.member.id).xp, 0);
  assert.deepEqual(f.replies, [], 'content awaiting an explicit-content decision has no FAQ response');
  // The caller admits the content only after every other moderation check.
  assert.equal(await f.receive('rules', { skipSpam: true }), false);
  assert.equal(getProfile(f.store, f.guildId, f.member.id).xp, 15);
  assert.equal(f.replies.length, 1);
  for (let count = 0; count < 2; count++) {
    assert.equal(await f.receive('rules', { spamOnly: true }), false);
    assert.equal(await f.receive('rules', { skipSpam: true }), false);
  }
  assert.equal(f.deletes, 0, 'three received messages have not been double-counted');
  assert.equal(await f.receive('rules', { spamOnly: true }), true);
  assert.equal(f.deletes, 1, 'the fourth received message triggers repeat/flood protection');
  assert.equal(f.replies.length, 1);
  assert.equal(getProfile(f.store, f.guildId, f.member.id).messages, 1);
});

test('lost deletion permissions and failed deletes keep spam handled without XP or FAQ', async (t) => {
  for (const change of ['permissions', 'deletable', 'api-failure', 'disabled'] as const)
    await t.test(change, async (sub) => {
      const f = fixture(sub, { xpEnabled: true, faqEnabled: true, blockedKeywords: ['forbidden'] });
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      f.store.set('community.faq', `${f.guildId}:forbidden`, 'No reply.');
      f.holdRefresh(async () => {
        entered();
        await gate;
      });
      const work = f.receive('forbidden');
      await ready;
      if (change === 'permissions') f.losePermission();
      if (change === 'deletable') f.message.deletable = false;
      if (change === 'api-failure') f.failDeletion();
      if (change === 'disabled') f.store.set('core.disabled', f.guildId, ['moderation']);
      release();
      assert.equal(await work, true);
      assert.equal(f.deletes, change === 'api-failure' ? 1 : 0);
      assert.equal(getProfile(f.store, f.guildId, f.member.id).xp, 0);
      assert.deepEqual(f.replies, []);
    });
});
