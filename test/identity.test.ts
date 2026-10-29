import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityType,
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Client,
  type Message,
} from 'discord.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService } from '../src/features/ai.js';
import {
  registerIdentityActions,
  restorePresence,
  identityContext,
  onIdentityMessage,
  sweepIdentityTasks,
} from '../src/features/identity.js';

const GUILD = '520000000000000001',
  USER = '520000000000000002',
  OTHER = '520000000000000003',
  BOT = '520000000000000004',
  CHANNEL = '520000000000000005',
  OTHER_GUILD = '520000000000000006';
function fixture(t: TestContext, operatorIds: readonly string[] = []) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sends: Record<string, unknown>[] = [],
    presences: unknown[] = [],
    edits: unknown[] = [],
    lookups: unknown[] = [];
  const dm = {
    id: 'dm-channel',
    send: async (payload: Record<string, unknown>) => {
      sends.push(payload);
      return { id: 'message' };
    },
  };
  const member = {
    id: USER,
    user: { id: USER },
    roles: { cache: new Map() },
    permissions: new PermissionsBitField(P.Administrator),
    createDM: async () => dm,
    send: async (payload: Record<string, unknown>) => dm.send(payload),
  };
  const gateway = {
    fetchMember: async (input: unknown) => {
      lookups.push(input);
      return member;
    },
  };
  const guild = {
    id: GUILD,
    name: 'Test server',
    ownerId: USER,
    members: {
      fetch: async (input: unknown) => gateway.fetchMember(input),
      editMe: async (input: unknown) => {
        edits.push(input);
        return { nickname: 'New name', avatarURL: () => null, bannerURL: () => null };
      },
    },
  };
  const client = {
    user: {
      id: BOT,
      setPresence: (input: unknown) => presences.push(input),
      edit: async (input: unknown) => {
        edits.push(input);
        return { id: BOT, username: 'Updated', avatarURL: () => null, bannerURL: () => null };
      },
    },
    application: {
      owner: { id: OTHER },
      edit: async (input: unknown) => {
        edits.push(input);
        return { id: BOT, name: 'Bot', description: 'Test', tags: [] };
      },
      editRoleConnectionMetadataRecords: async (input: unknown) => input,
    },
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  const ctx = { store, client, guild, member, channelId: CHANNEL } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (context) => context);
  registerIdentityActions(registry, operatorIds);
  const execute = async (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  const consent = (guildId = GUILD) => {
    store.set('notifications.consent', `${guildId}:${USER}`, {
      enabled: true,
      dm: true,
      createdAt: Date.now(),
    });
    store.set('notifications.default', USER, guildId);
  };
  const remind = async (content = 'Do the task') =>
    execute('notification.remind', {
      content,
      dueAt: new Date(Date.now() + 60000).toISOString(),
    }) as Promise<{ id: string }>;
  return {
    store,
    client,
    ctx,
    registry,
    execute,
    member,
    gateway,
    guild,
    sends,
    presences,
    edits,
    lookups,
    consent,
    remind,
  };
}
function fakeMessage(client: Client, content: string, userId = USER) {
  const replies: unknown[] = [];
  const typing: string[] = [];
  const message = {
    guild: null,
    client,
    author: { id: userId, bot: false },
    channel: {
      isDMBased: () => true,
      sendTyping: async () => {
        typing.push('typing');
      },
    },
    channelId: 'dm-channel',
    content,
    attachments: new Collection(),
    reply: async (payload: unknown) => {
      replies.push(payload);
      return {};
    },
  } as unknown as Message;
  return { message, replies, typing };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('Server administrators cannot modify global bot identity without application ownership or operator configuration', async (t) => {
  const f = fixture(t);
  for (const [action, input] of [
    ['bot.profile.global', { username: 'New name' }],
    ['bot.presence', { status: 'online' }],
    ['bot.application.profile', { description: 'Changed' }],
    ['bot.linked-role.metadata', { records: [] }],
  ] as const)
    await assert.rejects(f.execute(action, input), /application owner|OPERATOR_IDS/);
  assert.equal(f.edits.length, 0);
  assert.equal(f.presences.length, 0);
});

test('Application owner, team owner and configured operator can change global presence with persistent restoration', async (t) => {
  const f = fixture(t, [USER]);
  await f.execute('bot.presence', { status: 'dnd', activity: 'Reviewing builds', kind: 'watching' });
  assert.deepEqual(f.presences[0], {
    status: 'dnd',
    activities: [{ name: 'Reviewing builds', type: ActivityType.Watching }],
  });
  restorePresence(f.client, f.store);
  assert.deepEqual(f.presences[1], f.presences[0]);
  const owner = { ...f.ctx, member: { ...f.member, id: OTHER } } as unknown as ActionContext;
  await f.execute('bot.profile.global', { username: 'Owned bot' }, owner);
  assert.equal(f.edits.length, 1);
  Object.assign(f.client.application!, { owner: { ownerId: USER } });
  await f.execute('bot.application.profile', { description: 'Team-owned' }, f.ctx);
  assert.equal(f.edits.length, 2);
});

test('Identity schemas reject remote image URLs, filesystem paths, excessive tags and unknown mutation fields', (t) => {
  const f = fixture(t, [USER]);
  for (const avatar of ['file:///secret', 'https://example.com/avatar.png', 'data:text/html;base64,SGk='])
    assert.throws(() => f.registry.get('bot.profile.global').schema.parse({ avatar }));
  assert.throws(() => f.registry.get('bot.application.profile').schema.parse({ tags: Array(6).fill('tag') }));
  assert.throws(() =>
    f.registry.get('bot.profile.global').schema.parse({ username: 'Valid', token: 'not allowed' }),
  );
  assert.equal(f.registry.get('bot.profile.guild').userPermissions.includes(P.ManageGuild), true);
});

test('Notification opt-in targets only the requesting member and saves explicit server-scoped consent', async (t) => {
  const f = fixture(t);
  const result = (await f.execute('notification.subscribe', { enabled: true, dm: true })) as {
    dmOpened: boolean;
  };
  assert.equal(result.dmOpened, true);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0]?.allowedMentions, { parse: [] });
  assert.equal(f.store.get('notifications.default', USER), GUILD);
  assert.deepEqual(
    await f.execute('notification.preferences'),
    f.store.get('notifications.consent', `${GUILD}:${USER}`),
  );
  assert.throws(() =>
    f.registry.get('notification.subscribe').schema.parse({ enabled: true, dm: true, userId: OTHER }),
  );
  await f.execute('notification.subscribe', { enabled: false });
  assert.equal(f.store.get('notifications.default', USER), undefined);
});

test('DM reminders require consent, validate their deadline and enforce 25 active reminders per person/server', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.remind(), /Opt into/);
  f.consent();
  await assert.rejects(
    f.execute('notification.remind', { content: 'past', dueAt: new Date(Date.now() - 1000).toISOString() }),
    /Deadline/,
  );
  for (let index = 0; index < 25; index++) await f.remind(`Reminder ${index}`);
  await assert.rejects(f.remind('too many'), /25 active/);
  assert.equal(f.store.list('notifications.jobs').length, 25);
});

test('DM context rechecks configured server membership and refuses missing consent or excluded servers', async (t) => {
  const f = fixture(t);
  await assert.rejects(identityContext(f.client, f.store, USER, 'dm'), /Opt into/);
  f.consent();
  await assert.rejects(identityContext(f.client, f.store, USER, 'dm', [OTHER_GUILD]), /configured server/);
  const context = await identityContext(f.client, f.store, USER, 'dm', [GUILD]);
  assert.equal(context.guild.id, GUILD);
  assert.deepEqual(f.lookups.at(-1), { user: USER, force: true });
  f.store.set('notifications.consent', `${GUILD}:${USER}`, { enabled: false, dm: false });
  await assert.rejects(identityContext(f.client, f.store, USER, 'dm'), /disabled/);
});

test('Conversational DM replies use the default consenting server and explicitly disable administration tools', async (t) => {
  const f = fixture(t);
  f.consent();
  const calls: unknown[][] = [];
  const ai = {
    chat: async (...args: unknown[]) => {
      calls.push(args);
      return { text: 'Answer', pending: [] };
    },
  } as unknown as AiService;
  const message = fakeMessage(f.client, 'Hello');
  assert.equal(await onIdentityMessage(message.message, f.store, ai, [GUILD]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[3], false);
  assert.equal((calls[0]?.[0] as ActionContext).guild.id, GUILD);
  assert.equal((calls[0]?.[0] as ActionContext).member.id, USER);
  assert.equal(message.replies.length, 1);
  const unsolicited = fakeMessage(f.client, 'Hello', OTHER);
  await onIdentityMessage(unsolicited.message, f.store, ai);
  assert.equal(unsolicited.replies.length, 0);
  assert.equal(calls.length, 1);
});

test('Bot, unconsented and empty DMs do not trigger typing or AI', async (t) => {
  for (const mode of ['bot', 'unsolicited', 'disabled', 'empty'] as const)
    await t.test(mode, async (sub) => {
      const f = fixture(sub),
        message = fakeMessage(f.client, mode === 'empty' ? '   ' : 'Hello');
      let calls = 0;
      if (mode !== 'unsolicited') f.consent();
      if (mode === 'bot') Object.assign(message.message.author, { bot: true });
      if (mode === 'disabled')
        f.store.set('notifications.consent', `${GUILD}:${USER}`, {
          enabled: false,
          dm: false,
          createdAt: Date.now(),
        });
      const ai = {
        chat: async () => {
          calls++;
          return { text: 'Unexpected', pending: [] };
        },
      } as unknown as AiService;
      await onIdentityMessage(message.message, f.store, ai, [GUILD]);
      assert.equal(calls, 0);
      assert.equal(message.typing.length, 0);
    });
});

test('Consented DM typing starts after membership authorization, refreshes during AI and stops on completion or failure', async (t) => {
  for (const fail of [false, true])
    await t.test(fail ? 'AI failure' : 'AI success', async (sub) => {
      sub.mock.timers.enable({ apis: ['setInterval'] });
      const f = fixture(sub);
      f.consent();
      const message = fakeMessage(f.client, 'Hello'),
        membership = latch(),
        authorized = latch(),
        entered = latch(),
        complete = latch();
      f.gateway.fetchMember = async () => {
        membership.release();
        await authorized.promise;
        return f.member;
      };
      const ai = {
        chat: async () => {
          assert.equal(message.typing.length, 1);
          entered.release();
          await complete.promise;
          if (fail) throw new Error('Synthetic API failure');
          return { text: 'Answer', pending: [] };
        },
      } as unknown as AiService;
      const work = onIdentityMessage(message.message, f.store, ai, [GUILD]);
      try {
        await membership.promise;
        assert.equal(message.typing.length, 0);
        authorized.release();
        await entered.promise;
        await Promise.resolve();
        await Promise.resolve();
        sub.mock.timers.tick(8000);
        await Promise.resolve();
        assert.equal(message.typing.length, 2);
      } finally {
        authorized.release();
        complete.release();
        await work;
      }
      assert.equal(message.replies.length, 1);
      const count = message.typing.length;
      sub.mock.timers.tick(24000);
      await Promise.resolve();
      assert.equal(message.typing.length, count);
    });
});

test('DM consent changes during AI suppress late success and error replies and release typing', async (t) => {
  for (const mode of ['revoke', 'replace', 'disable', 'error'] as const)
    await t.test(mode, async (sub) => {
      sub.mock.timers.enable({ apis: ['setInterval'] });
      const f = fixture(sub);
      f.consent();
      const message = fakeMessage(f.client, 'Hello'),
        entered = latch(),
        complete = latch();
      const ai = {
        chat: async () => {
          entered.release();
          await complete.promise;
          if (mode === 'error') throw new Error('Synthetic API failure');
          return { text: 'Late answer', pending: [] };
        },
      } as unknown as AiService;
      const work = onIdentityMessage(message.message, f.store, ai, [GUILD]);
      try {
        await entered.promise;
        if (mode === 'disable') f.store.set('core.disabled', GUILD, ['notifications']);
        else
          f.store.set('notifications.consent', `${GUILD}:${USER}`, {
            enabled: mode === 'replace',
            dm: mode === 'replace',
            createdAt: Date.now(),
            version: 'changed-consent',
          });
      } finally {
        complete.release();
        await work;
      }
      assert.equal(message.replies.length, 0);
      assert.equal(message.typing.length, 1);
      sub.mock.timers.tick(24000);
      await Promise.resolve();
      assert.equal(message.typing.length, 1);
    });
});

test('DM consent withdrawn during membership lookup produces neither typing nor a late error DM', async (t) => {
  const f = fixture(t);
  f.consent();
  const message = fakeMessage(f.client, 'Hello');
  let calls = 0;
  f.gateway.fetchMember = async () => {
    f.store.set('notifications.consent', `${GUILD}:${USER}`, {
      enabled: false,
      dm: false,
      createdAt: Date.now(),
    });
    return f.member;
  };
  const ai = {
    chat: async () => {
      calls++;
      return { text: 'Unexpected', pending: [] };
    },
  } as unknown as AiService;
  await onIdentityMessage(message.message, f.store, ai, [GUILD]);
  assert.equal(calls, 0);
  assert.equal(message.typing.length, 0);
  assert.equal(message.replies.length, 0);
});

test('STOP revokes personal DMs without requiring current server membership and cancels other consenting sources', async (t) => {
  const f = fixture(t);
  f.consent();
  await f.remind();
  f.consent(OTHER_GUILD);
  const ai = {
    chat: async () => {
      throw new Error('STOP must not call AI');
    },
  } as unknown as AiService;
  f.gateway.fetchMember = async () => {
    throw new Error('Member left server');
  };
  const message = fakeMessage(f.client, 'STOP');
  await onIdentityMessage(message.message, f.store, ai, [GUILD]);
  assert.equal(f.store.get('notifications.default', USER), undefined);
  for (const row of f.store.list<{ enabled: boolean; dm: boolean }>('notifications.consent'))
    assert.equal(row.value.enabled && row.value.dm, false);
  assert.equal(f.store.list('notifications.jobs').length, 0);
  assert.equal(message.replies.length, 1);
});

test('Due personal reminders send once with stable nonce, suppressed mentions and fresh member lookup', async (t) => {
  const f = fixture(t);
  f.consent();
  const created = await f.remind();
  const row = f.store.list<{ dueAt: number; nonce: string; state: string }>('notifications.jobs')[0]!;
  await sweepIdentityTasks(f.client, f.store, row.value.dueAt, [GUILD]);
  await sweepIdentityTasks(f.client, f.store, row.value.dueAt, [GUILD]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.nonce, created.id);
  assert.equal(f.sends[0]?.enforceNonce, true);
  assert.deepEqual(f.sends[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(f.lookups[0], { user: USER, force: true });
  assert.equal(f.store.get<{ state: string }>('notifications.jobs', row.key)?.state, 'done');
});

test('Revocation or cancellation completed during member lookup suppresses the eventual DM', async (t) => {
  for (const mode of ['revoke', 'cancel'] as const)
    await t.test(mode, async (sub) => {
      const f = fixture(sub);
      f.consent();
      const created = await f.remind();
      const row = f.store.list<{ dueAt: number }>('notifications.jobs')[0]!;
      let release!: () => void, started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.gateway.fetchMember = async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return f.member;
      };
      const running = sweepIdentityTasks(f.client, f.store, row.value.dueAt);
      await entered;
      if (mode === 'revoke') await f.execute('notification.subscribe', { enabled: false });
      else await f.execute('notification.cancel', { id: created.id });
      release();
      await running;
      assert.equal(f.sends.length, 0);
      assert.equal(f.store.get('notifications.jobs', row.key), undefined);
    });
});

test('Disabling notifications during member lookup pauses a claimed DM before send', async (t) => {
  const f = fixture(t);
  f.consent();
  await f.remind();
  const row = f.store.list<{ dueAt: number }>('notifications.jobs')[0]!;
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.gateway.fetchMember = async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.member;
  };
  const running = sweepIdentityTasks(f.client, f.store, row.value.dueAt);
  await entered;
  f.store.set('core.disabled', GUILD, ['notifications']);
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.get<{ state: string }>('notifications.jobs', row.key)?.state, 'pending');
});

test('DM transport failures back off durably, preserve identity and stop after three attempts', async (t) => {
  const f = fixture(t);
  f.consent();
  await f.remind();
  const row = f.store.list<{ dueAt: number; nonce: string }>('notifications.jobs')[0]!;
  let attempts = 0;
  f.member.send = async () => {
    attempts++;
    throw new Error('provider message containing secret');
  };
  let now = row.value.dueAt;
  for (let index = 0; index < 3; index++) {
    await sweepIdentityTasks(f.client, f.store, now);
    const state = f.store.get<{ retryAt: number; nonce: string; state: string; attempts: number }>(
      'notifications.jobs',
      row.key,
    )!;
    assert.equal(state.nonce, row.value.nonce);
    assert.equal(state.attempts, index + 1);
    now = state.retryAt;
  }
  assert.equal(f.store.get<{ state: string }>('notifications.jobs', row.key)?.state, 'failed');
  await sweepIdentityTasks(f.client, f.store, now);
  assert.equal(attempts, 3);
  assert.ok(!JSON.stringify(f.store.get('notifications.jobs', row.key)).includes('secret'));
});

test('Excluded or disabled server reminders remain paused and never send', async (t) => {
  const f = fixture(t);
  f.consent();
  await f.remind();
  const row = f.store.list<{ dueAt: number }>('notifications.jobs')[0]!;
  await sweepIdentityTasks(f.client, f.store, row.value.dueAt, [OTHER_GUILD]);
  assert.equal(f.sends.length, 0);
  f.store.set('core.disabled', GUILD, ['notifications']);
  await sweepIdentityTasks(f.client, f.store, row.value.dueAt, [GUILD]);
  assert.equal(f.sends.length, 0);
});

test('Reminder cancellation and listings are isolated to the requesting user/server', async (t) => {
  const f = fixture(t);
  f.consent();
  const created = await f.remind();
  const outsider = { ...f.ctx, member: { ...f.member, id: OTHER } } as unknown as ActionContext;
  await assert.rejects(f.execute('notification.cancel', { id: created.id }, outsider), /not found/);
  assert.deepEqual(await f.execute('notification.reminders', {}, outsider), []);
  assert.equal(((await f.execute('notification.reminders')) as unknown[]).length, 1);
});
