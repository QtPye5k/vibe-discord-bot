import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Client,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService, AiReply } from '../src/features/ai.js';
import {
  formatMessageRequest,
  handleMessageWorkflow,
  registerMessageWorkflowActions,
  statusPanelContent,
  sweepMessageWorkflowTasks,
} from '../src/features/message-workflows.js';

const GUILD = '540000000000000001',
  OWNER = '540000000000000002',
  AUTHOR = '540000000000000003',
  BOT = '540000000000000004',
  CHANNEL = '540000000000000005';
interface StoredMessage {
  id: string;
  guildId: string;
  channelId: string;
  author: { id: string; bot: boolean };
  webhookId: string | null;
  content: string;
  edit: (payload: Record<string, unknown>) => Promise<StoredMessage>;
}
interface Panel {
  id: string;
  version: string;
  state: string;
  nextAt: number;
  messageId: string;
  attempts: number;
  intervalSeconds: number;
}
function fixture(t: TestContext, store?: Store, guildId = GUILD) {
  if (!store) {
    store = new Store(':memory:');
    const active = store;
    t.after(() => active.close());
  }
  const active = store;
  const owner = {
      id: OWNER,
      user: { id: OWNER, bot: false },
      permissions: new PermissionsBitField(P.ManageGuild),
      roles: { cache: new Collection() },
    },
    author = {
      ...owner,
      id: AUTHOR,
      user: { id: AUTHOR, bot: false },
      permissions: new PermissionsBitField(P.ViewChannel),
    },
    bot = { ...owner, id: BOT, user: { id: BOT, bot: true } };
  const members = new Map([
      [OWNER, owner],
      [AUTHOR, author],
      [BOT, bot],
    ]),
    hidden = new Set<string>(),
    noHistory = new Set<string>();
  const sends: Record<string, unknown>[] = [],
    edits: Record<string, unknown>[] = [],
    calls: Parameters<AiService['chat']>[] = [],
    messages = new Map<string, StoredMessage>();
  const hooks: {
    ai?: (args: Parameters<AiService['chat']>) => Promise<void> | void;
    send?: (message: StoredMessage) => Promise<void> | void;
    edit?: () => Promise<void> | void;
    fetch?: () => Promise<void> | void;
  } = {};
  let serial = 540000000000000100n,
    reads = 0;
  function stored(content: string, userId = AUTHOR): StoredMessage {
    const message: StoredMessage = {
      id: String(serial++),
      guildId,
      channelId: CHANNEL,
      author: { id: userId, bot: userId === BOT },
      webhookId: null,
      content,
      edit: async (payload) => {
        edits.push(payload);
        await hooks.edit?.();
        message.content = String(payload.content);
        return message;
      },
    };
    messages.set(message.id, message);
    return message;
  }
  const channel = {
    id: CHANNEL,
    guildId,
    type: 0,
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (member: { id: string }) =>
      new PermissionsBitField(
        hidden.has(member.id)
          ? 0n
          : noHistory.has(member.id)
            ? [P.ViewChannel, P.SendMessages]
            : P.Administrator,
      ),
    messages: {
      fetch: async (input: string | { message: string }) => {
        await hooks.fetch?.();
        const message = messages.get(typeof input === 'string' ? input : input.message);
        if (!message) throw Object.assign(new Error('Unknown message'), { code: 10008 });
        return message;
      },
    },
    send: async (payload: Record<string, unknown>) => {
      sends.push(payload);
      const result = stored(String(payload.content), BOT);
      await hooks.send?.(result);
      return result;
    },
  };
  const guild = {
    id: guildId,
    ownerId: OWNER,
    name: 'Workflow test',
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const member = members.get(typeof input === 'string' ? input : input.user);
        if (!member) throw new Error('Unknown member');
        return member;
      },
    },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) },
  };
  for (const member of members.values()) Object.assign(member, { guild });
  const client = {
    user: { id: BOT, username: 'Test bot' },
    ws: { ping: 12 },
    guilds: {
      fetch: async (_id: string) => {
        reads++;
        return guild;
      },
    },
  } as unknown as Client;
  const ctx = { client, guild, member: owner, store: active, channelId: CHANNEL } as unknown as ActionContext,
    registry = new ActionRegistry(120, async (context) => context);
  registerMessageWorkflowActions(registry);
  const execute = async <T = unknown>(id: string, input: unknown = {}, member = owner): Promise<T> => {
    const action = registry.get(id);
    return (await action.execute(
      { ...ctx, member } as unknown as ActionContext,
      action.schema.parse(input),
    )) as T;
  };
  const ai: Pick<AiService, 'chat'> = {
    chat: async (...args) => {
      calls.push(args);
      await hooks.ai?.(args);
      return { text: 'Bonjour', pending: [] } satisfies AiReply;
    },
  };
  const source = (text = 'Hello') =>
    Object.assign(stored(text), { guild, client, system: false }) as unknown as Message;
  const configureTranslation = () =>
    execute('translation.configure', { channelId: CHANNEL, enabled: true, targetLanguage: 'French' });
  const consent = () => execute('translation.consent', { enabled: true, targetLanguage: 'French' }, author);
  const translate = (message: Message, allowed: readonly string[] = []) =>
    handleMessageWorkflow(message, active, ai, allowed);
  const panel = () => active.get<Panel>('message.statusPanels', `${guildId}:${CHANNEL}`)!;
  const sweep = (now = Date.now(), allowed: readonly string[] = []) =>
    sweepMessageWorkflowTasks(client, active, now, allowed);
  return {
    store: active,
    ctx,
    registry,
    execute,
    owner,
    author,
    bot,
    hidden,
    noHistory,
    hooks,
    sends,
    edits,
    calls,
    messages,
    stored,
    source,
    configureTranslation,
    consent,
    translate,
    panel,
    sweep,
    client,
    guild,
    reads: () => reads,
  };
}

test('formatting is deterministic, bounded and keeps literal code inside one fence', () => {
  assert.equal(formatMessageRequest('ordinary text', '!format'), null);
  assert.equal(
    formatMessageRequest('!format code lang=js\nconst answer = 42;', '!format'),
    '```js\nconst answer = 42;\n```',
  );
  assert.equal(formatMessageRequest('!format list first\n2. second', '!format'), '- first\n- second');
  assert.equal(formatMessageRequest('!format quote first\nsecond', '!format'), '> first\n> second');
  assert.throws(() => formatMessageRequest('!format code ```unsafe```', '!format'), /embedded/);
  assert.throws(() => formatMessageRequest('!format quote ' + 'x'.repeat(1701), '!format'), /1700/);
});

test('translation configuration alone never sends member content to AI', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.translate(f.source());
  assert.equal(f.calls.length + f.sends.length, 0);
  await assert.rejects(
    f.execute('translation.consent', { enabled: true }, f.author),
    /reviewed targetLanguage/,
  );
  await assert.rejects(
    f.execute('translation.consent', { enabled: true, targetLanguage: 'German' }, f.author),
    /current target language/,
  );
});

test('automatic translation uses the actual author, isolated AI options and a same-channel reply', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.consent();
  const message = f.source('Hello');
  await f.translate(message);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![0].member.id, AUTHOR);
  assert.equal(f.calls[0]![3], false);
  assert.deepEqual(f.calls[0]![4], {
    memoryScope: 'translation',
    usePreferences: false,
    retainHistory: false,
    allowWebSearch: false,
  });
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0]!.content), /Translation \(French\)/);
  assert.deepEqual(f.sends[0]!.reply, { messageReference: message.id, failIfNotExists: true });
  assert.deepEqual(f.sends[0]!.allowedMentions, { parse: [], repliedUser: false });
  await f.translate(f.source('Another message'));
  assert.equal(f.calls.length, 1);
});

test('author consent withdrawal during the provider request suppresses the finished translation', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.consent();
  f.hooks.ai = async () => {
    await f.execute('translation.optout', {}, f.author);
  };
  await f.translate(f.source());
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 0);
});

test('policy changes, source edits, deletion and lost history permission after provider work prevent public output', async (t) => {
  for (const change of ['policy', 'edit', 'delete', 'history']) {
    const f = fixture(t);
    await f.configureTranslation();
    await f.consent();
    const message = f.source();
    f.hooks.ai = async () => {
      if (change === 'policy') await f.configureTranslation();
      if (change === 'edit') f.messages.get(message.id)!.content = 'Edited after the request';
      if (change === 'delete') f.messages.delete(message.id);
      if (change === 'history') f.noHistory.add(AUTHOR);
    };
    await f.translate(message);
    assert.equal(f.calls.length, 1, change);
    assert.equal(f.sends.length, 0, change);
  }
});

test('current manager authority and action restrictions are revalidated before translation replies', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.consent();
  f.hooks.ai = () => {
    f.owner.permissions = new PermissionsBitField(0n);
  };
  await f.translate(f.source());
  assert.equal(f.sends.length, 0);
  const g = fixture(t);
  await g.configureTranslation();
  await g.consent();
  g.store.set('core.actionPolicies', `${GUILD}:translation.consent`, {
    enabled: false,
    roleIds: [],
    channelIds: [],
  });
  await g.translate(g.source());
  assert.equal(g.calls.length, 0);
});

test('feature toggles, revoked AI roles and replaced consent cancel completed provider work', async (t) => {
  for (const change of ['module', 'ai', 'role', 'consent']) {
    const f = fixture(t);
    await f.configureTranslation();
    await f.consent();
    f.hooks.ai = async () => {
      if (change === 'module' || change === 'ai') {
        const category = change === 'module' ? 'message-workflows' : 'ai';
        // A disable/re-enable can finish before the provider responds; the epoch still changes.
        f.store.set('core.featureEpochs', `${GUILD}:${category}`, 2);
      }
      if (change === 'role') f.store.set('core.aiRoles', GUILD, ['540000000000000099']);
      if (change === 'consent') {
        await f.execute('translation.consent', { enabled: false }, f.author);
        await f.consent();
      }
    };
    await f.translate(f.source());
    assert.equal(f.calls.length, 1, change);
    assert.equal(f.sends.length, 0, change);
  }
});

test('translation preference reads require current access to the requested channel', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.consent();
  f.hidden.add(AUTHOR);
  await assert.rejects(f.execute('translation.preferences', {}, f.author), /view/);
  // Withdrawal does not depend on retaining access to the channel.
  await f.execute('translation.consent', { enabled: false }, f.author);
  assert.equal(f.store.list('message.translationConsent').length, 0);
});

test('AI/module disabling, excluded guilds, bot messages and webhooks cause no AI or Discord work', async (t) => {
  const f = fixture(t);
  await f.configureTranslation();
  await f.consent();
  const message = f.source();
  await f.translate(message, ['540000000000000099']);
  f.store.set('core.disabled', GUILD, ['ai']);
  await f.translate(message);
  f.store.set('core.disabled', GUILD, []);
  await f.translate({ ...message, author: { ...message.author, bot: true } } as Message);
  await f.translate({ ...message, webhookId: 'webhook' } as Message);
  assert.equal(f.calls.length + f.sends.length + f.reads(), 0);
});

test('one active translation per guild and two globally prevent parallel provider overload', async (t) => {
  const f = fixture(t),
    g = fixture(t, f.store, '540000000000000011'),
    h = fixture(t, f.store, '540000000000000021');
  for (const value of [f, g, h]) {
    await value.configureTranslation();
    await value.consent();
  }
  let releaseF!: () => void, releaseG!: () => void, arrivedF!: () => void, arrivedG!: () => void;
  const startedF = new Promise<void>((resolve) => {
      arrivedF = resolve;
    }),
    startedG = new Promise<void>((resolve) => {
      arrivedG = resolve;
    });
  f.hooks.ai = async () => {
    arrivedF();
    await new Promise<void>((resolve) => {
      releaseF = resolve;
    });
  };
  g.hooks.ai = async () => {
    arrivedG();
    await new Promise<void>((resolve) => {
      releaseG = resolve;
    });
  };
  const first = f.translate(f.source());
  await startedF;
  await f.translate(f.source('second'));
  const second = g.translate(g.source());
  await startedG;
  await h.translate(h.source());
  assert.equal(f.calls.length, 1);
  assert.equal(g.calls.length, 1);
  assert.equal(h.calls.length, 0);
  releaseF();
  releaseG();
  await Promise.all([first, second]);
});

test('formatter replies require an explicit configured prefix and never call AI or edit the author message', async (t) => {
  const f = fixture(t);
  await f.execute('formatter.configure', { channelId: CHANNEL, enabled: true, prefix: '!format' });
  const plain = f.source('ordinary text');
  await f.translate(plain);
  assert.equal(f.sends.length, 0);
  const request = f.source('!format quote Hello');
  await f.translate(request);
  assert.equal(f.sends[0]!.content, '> Hello');
  assert.equal(f.messages.get(request.id)!.content, '!format quote Hello');
  assert.equal(f.edits.length + f.calls.length, 0);
});

test('status panels edit only the configured bot message on their cadence', async (t) => {
  const f = fixture(t);
  const result = await f.execute<{ messageId: string; panelId: string }>('statuspanel.create', {
    channelId: CHANNEL,
    title: 'Bot status',
    intervalSeconds: 60,
  });
  assert.equal(f.sends.length, 1);
  assert.equal(f.panel().messageId, result.messageId);
  await f.sweep(f.panel().nextAt - 1);
  assert.equal(f.edits.length, 0);
  await f.sweep(f.panel().nextAt);
  assert.equal(f.edits.length, 1);
  assert.equal(f.sends.length, 1);
  assert.match(String(f.edits[0]!.content), new RegExp(result.panelId));
  assert.equal(f.panel().attempts, 0);
});

test('uncertain status panel sends retain their marker and reconcile without creating another message', async (t) => {
  const f = fixture(t);
  f.hooks.send = () => {
    throw new Error('Lost response');
  };
  await assert.rejects(f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Status' }), /Lost/);
  assert.equal(f.panel().state, 'needs-review');
  await assert.rejects(
    f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Again' }),
    /already has/,
  );
  assert.equal(f.sends.length, 1);
  const sent = [...f.messages.values()][0]!;
  await f.execute('statuspanel.reconcile', { channelId: CHANNEL, messageId: sent.id });
  assert.equal(f.panel().state, 'active');
  assert.equal(f.panel().messageId, sent.id);
  await f.sweep();
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.length, 1);
});

test('binding rejects another user’s message and stops if another operation replaces its status marker', async (t) => {
  const f = fixture(t),
    user = f.stored('User content');
  await assert.rejects(
    f.execute('statuspanel.bind', { channelId: CHANNEL, messageId: user.id, title: 'Status' }),
    /expected bot status panel/,
  );
  const bot = f.stored('Previous bot content', BOT);
  await f.execute('statuspanel.bind', { channelId: CHANNEL, messageId: bot.id, title: 'Status' });
  await f.sweep();
  assert.equal(f.edits.length, 1);
  bot.content = 'Another feature replaced this message';
  await f.sweep(f.panel().nextAt);
  assert.equal(f.edits.length, 1);
  assert.equal(f.panel().state, 'failed');
});

test('a failed first bound-panel update cannot overwrite later changes by another bot feature', async (t) => {
  const f = fixture(t),
    bot = f.stored('Original content', BOT);
  await f.execute('statuspanel.bind', { channelId: CHANNEL, messageId: bot.id, title: 'Status' });
  f.hooks.edit = () => {
    throw new Error('Uncertain edit response');
  };
  await f.sweep();
  assert.equal(f.edits.length, 1);
  bot.content = 'Another feature took ownership';
  f.hooks.edit = undefined;
  await f.sweep(f.panel().nextAt);
  assert.equal(f.edits.length, 1);
  assert.equal(f.panel().state, 'failed');
});

test('a concurrent binding does not replace a newly created panel during message validation', async (t) => {
  const f = fixture(t),
    bot = f.stored('Existing bot message', BOT);
  let created = false;
  f.hooks.fetch = async () => {
    if (created) return;
    created = true;
    await f.execute('statuspanel.create', { channelId: CHANNEL, title: 'New panel' });
  };
  await assert.rejects(
    f.execute('statuspanel.bind', { channelId: CHANNEL, messageId: bot.id, title: 'Replacement' }),
    /changed during binding/,
  );
  assert.notEqual(f.panel().messageId, bot.id);
  assert.equal(f.sends.length, 1);
});

test('current action policy and feature epoch are checked after the panel message fetch', async (t) => {
  for (const change of ['action', 'feature', 'history', 'manager']) {
    const f = fixture(t);
    await f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Status' });
    f.hooks.fetch = () => {
      if (change === 'action')
        f.store.set('core.actionPolicies', `${GUILD}:statuspanel.create`, {
          enabled: false,
          roleIds: [],
          channelIds: [],
        });
      if (change === 'feature') f.store.set('core.featureEpochs', `${GUILD}:message-workflows`, 2);
      if (change === 'history') f.noHistory.add(OWNER);
      if (change === 'manager') f.owner.permissions = new PermissionsBitField(0n);
    };
    await f.sweep(f.panel().nextAt);
    assert.equal(f.edits.length, 0, change);
  }
});

test('status panel removal while authorization is pending prevents the next edit and never resurrects its binding', async (t) => {
  const f = fixture(t);
  await f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Status' });
  let removed = false;
  f.hooks.fetch = async () => {
    if (!removed) {
      removed = true;
      await f.execute('statuspanel.remove', { panelId: f.panel().id });
    }
  };
  await f.sweep(f.panel().nextAt);
  assert.equal(f.edits.length, 0);
  assert.equal(f.panel(), undefined);
});

test('status panels respect current manager permissions, module pauses and excluded guilds', async (t) => {
  const f = fixture(t);
  await f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Status' });
  const now = f.panel().nextAt;
  f.store.set('core.disabled', GUILD, ['message-workflows']);
  await f.sweep(now);
  assert.equal(f.reads(), 0);
  f.store.set('core.disabled', GUILD, []);
  await f.sweep(now, ['540000000000000099']);
  assert.equal(f.reads(), 0);
  f.owner.permissions = new PermissionsBitField(0n);
  await f.sweep(now);
  assert.equal(f.edits.length, 0);
  assert.equal(f.panel().state, 'failed');
});

test('status panel update failures back off and stop after five attempts without creating replacements', async (t) => {
  const f = fixture(t);
  await f.execute('statuspanel.create', { channelId: CHANNEL, title: 'Status' });
  f.hooks.edit = () => {
    throw new Error('SENSITIVE raw response');
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await f.sweep(f.panel().nextAt);
    assert.equal(f.panel().attempts, attempt);
  }
  assert.equal(f.panel().state, 'failed');
  assert.equal(f.sends.length, 1);
  assert.equal(f.edits.length, 5);
});

test('status text handles unavailable Gateway latency without exposing private conversation state', () => {
  const content = statusPanelContent(
    { user: { username: 'Bot' }, ws: { ping: -1 } } as unknown as Client,
    { id: 'panel', title: 'Status' },
    1800000000000,
  );
  assert.match(content, /unavailable/);
  assert.match(content, /Status panel panel/);
  assert.equal(content.includes('undefined'), false);
});
