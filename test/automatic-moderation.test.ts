import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  Collection,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Client,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import {
  createAutomaticModeration,
  moderationPolicySchema,
  type ExplicitClassification,
} from '../src/moderation/service.js';
const G = '910000000000000001',
  USER = '910000000000000002',
  BOT = '910000000000000003',
  TEXT = '910000000000000004',
  HONEY = '910000000000000005',
  LOG = '910000000000000006',
  OWNER = '910000000000000007',
  THREAD = '910000000000000008';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    current = new Map<string, Message>();
  const state = {
    deletes: [] as string[],
    bans: [] as string[],
    logs: [] as unknown[],
    errors: [] as string[],
    scans: [] as Message[],
    classifier: undefined as
      ((message: Message, signal?: AbortSignal) => Promise<ExplicitClassification>) | undefined,
    beforeBan: undefined as (() => Promise<void> | void) | undefined,
    banError: false,
    memberError: undefined as unknown,
    messageError: undefined as unknown,
    deleteError: false,
    banPermission: true,
    deletePermission: true,
    bannable: true,
    targetPosition: 1,
    publicLog: false,
  };
  const permissions = new PermissionsBitField(P.Administrator),
    everyone = { id: G },
    bot = {
      id: BOT,
      guild: { id: G },
      user: { id: BOT, bot: true },
      get permissions() {
        return new PermissionsBitField(state.banPermission ? [P.BanMembers] : []);
      },
      roles: {
        cache: new Collection(),
        highest: { position: 100, comparePositionTo: (other: { position: number }) => 100 - other.position },
      },
    },
    target = {
      id: USER,
      guild: { id: G },
      user: { id: USER, bot: false },
      permissions,
      get bannable() {
        return state.bannable;
      },
      roles: {
        cache: new Collection(),
        get highest() {
          return { position: state.targetPosition };
        },
      },
    };
  const roles = new Collection([[G, everyone]]);
  const channel = (id: string, parentId?: string) => ({
    id,
    guildId: G,
    type: parentId ? ChannelType.PublicThread : ChannelType.GuildText,
    parentId,
    isThread: () => !!parentId,
    isTextBased: () => true,
    isSendable: () => true,
    permissionOverwrites: {
      cache: new Collection([
        [
          G,
          {
            id: G,
            type: OverwriteType.Role,
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(P.ViewChannel),
          },
        ],
      ]),
    },
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        principal.id === G
          ? state.publicLog
            ? P.ViewChannel
            : 0n
          : [P.ViewChannel, P.SendMessages, ...(state.deletePermission ? [P.ManageMessages] : [])],
      ),
    messages: {
      fetch: async (input: { message: string; force: boolean }) => {
        assert.equal(input.force, true);
        if (state.messageError) throw state.messageError;
        const found = current.get(input.message);
        if (!found) throw new Error('Missing message');
        return found;
      },
    },
    send: async (payload: unknown) => {
      state.logs.push(payload);
    },
  });
  const channels = new Map([TEXT, HONEY, LOG].map((id) => [id, channel(id)]));
  channels.set(THREAD, channel(THREAD, HONEY));
  const guild = {
    id: G,
    ownerId: OWNER,
    roles: { everyone, cache: roles, fetch: async () => roles },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: { user: string }) => {
        if (state.memberError) throw state.memberError;
        return {
          ...target,
          id: input.user,
          get bannable() {
            return state.bannable;
          },
          roles: target.roles,
        };
      },
      ban: async (id: string, options: { deleteMessageSeconds: number }) => {
        assert.equal(options.deleteMessageSeconds, 0);
        state.bans.push(id);
        await state.beforeBan?.();
        if (state.banError) throw new Error('PRIVATE_PROVIDER_ERROR');
        return { id };
      },
    },
  };
  let sequence = 100;
  const makeMessage = (patch: Partial<Omit<Message, 'valueOf'>> = {}) => {
    const message = {
      id: `91000000000000${++sequence}`,
      guildId: G,
      guild,
      channelId: TEXT,
      channel: channels.get(TEXT),
      author: { id: USER, bot: false },
      content: 'PRIVATE RAW CONTENT',
      cleanContent: 'PRIVATE RAW CONTENT',
      editedTimestamp: null,
      attachments: new Collection(),
      embeds: [],
      stickers: new Collection(),
      system: false,
      webhookId: null,
      deletable: true,
      delete: async () => {
        state.deletes.push(message.id);
        if (state.deleteError) throw new Error('PRIVATE_DELETE_ERROR');
        return message;
      },
      ...patch,
    } as unknown as Message;
    if (patch.channelId) Object.assign(message, { channel: channels.get(patch.channelId) });
    current.set(message.id, message);
    return message;
  };
  const client = { user: { id: BOT } } as Client;
  const service = createAutomaticModeration({
    store,
    client,
    allowedGuildIds: [G],
    classify: async (message, signal) => {
      state.scans.push(message);
      return state.classifier
        ? state.classifier(message, signal)
        : { remove: true, categories: ['sexual'], scannedImages: 1 };
    },
    onError: (error) => state.errors.push(error.message),
  });
  const setPolicy = (changes: Record<string, unknown> = {}) =>
    store.set(
      'moderation.automatic',
      G,
      moderationPolicySchema.parse({
        enabled: true,
        textEnabled: true,
        imagesEnabled: true,
        honeypotChannelId: HONEY,
        logChannelId: LOG,
        ...changes,
      }),
    );
  setPolicy();
  t.after(async () => {
    await service.close();
    store.close();
  });
  return { service, store, state, makeMessage, setPolicy, current, channels };
}

test('Automatic moderation defaults to disabled and ignores own/system messages and unconfigured guilds', async (t) => {
  const f = fixture(t);
  f.store.delete('moderation.automatic', G);
  assert.equal(await f.service.processMessage(f.makeMessage()), false);
  f.setPolicy();
  for (const message of [
    f.makeMessage({ author: { id: BOT, bot: true } as Message['author'] }),
    f.makeMessage({ system: true }),
    f.makeMessage({ guild: null, guildId: null }),
    f.makeMessage({ guild: { id: OWNER } as Message['guild'], guildId: OWNER }),
  ])
    assert.equal(await f.service.processMessage(message), false);
  assert.equal(f.state.scans.length, 0);
  assert.deepEqual(f.state.bans, []);
});
test('A confirmed Unknown Message race is handled without classification or downstream delivery', async (t) => {
  const f = fixture(t);
  f.state.messageError = new DiscordAPIError(
    { message: 'Unknown Message', code: 10008 },
    10008,
    404,
    'GET',
    'https://discord.com/api/private-context',
    {},
  );
  assert.equal(await f.service.processMessage(f.makeMessage()), true);
  assert.equal(f.state.scans.length, 0);
  assert.deepEqual(f.state.deletes, []);
});
test('Fetch diagnostics include only safe error class/code/status and omit provider bodies and URLs', async (t) => {
  const f = fixture(t);
  f.state.messageError = new DiscordAPIError(
    { message: 'PRIVATE RESPONSE BODY', code: 50013 },
    50013,
    403,
    'GET',
    'https://discord.com/api/private-context',
    {},
  );
  assert.equal(await f.service.processMessage(f.makeMessage()), false);
  const logged = f.state.errors.join('\n');
  assert.match(logged, /fresh message.*name=DiscordAPIError code=50013 status=403/);
  assert(!logged.includes('PRIVATE RESPONSE BODY'));
  assert(!logged.includes('private-context'));
});
test('Newly populated link-preview metadata invalidates a clean result even when URL and edit timestamp stay unchanged', async (t) => {
  for (const field of ['title', 'author', 'footer', 'provider'])
    await t.test(field, async (sub) => {
      const f = fixture(sub),
        base = { url: 'https://example.com/opaque' },
        message = f.makeMessage({ embeds: [base] as Message['embeds'] });
      f.state.classifier = async () => ({ remove: false, categories: [], scannedImages: 0 });
      assert.equal(await f.service.processMessage(message), false);
      const changed =
        field === 'title'
          ? { title: 'Watch free porn videos' }
          : field === 'author'
            ? { author: { name: 'Watch free porn videos' } }
            : field === 'footer'
              ? { footer: { text: 'Watch free porn videos' } }
              : { provider: { url: 'https://pornhub.com' } };
      const updated = { ...message, embeds: [{ ...base, ...changed }] } as unknown as Message;
      f.current.set(message.id, updated);
      assert.equal(await f.service.processMessage(updated, { edited: true }), true);
      assert.deepEqual(f.state.deletes, [message.id]);
      assert.equal(f.state.scans.length, 1);
    });
});
test('Explicit content is deleted once across duplicate events, never bans, and private records contain no raw content or image URL', async (t) => {
  const f = fixture(t),
    message = f.makeMessage();
  const first = f.service.processMessage(message),
    duplicate = f.service.processMessage(message);
  assert.equal(first, duplicate);
  assert.equal(await first, true);
  assert.equal(await f.service.processMessage(message, { edited: true }), true);
  assert.equal(f.state.scans.length, 1);
  assert.deepEqual(f.state.deletes, [message.id]);
  assert.deepEqual(f.state.bans, []);
  assert.equal(f.state.logs.length, 1);
  assert(!JSON.stringify(f.store.list('moderation.automatic.cases')).includes('PRIVATE RAW CONTENT'));
  assert(!JSON.stringify(f.state.logs).includes('PRIVATE RAW CONTENT'));
});
test('Positive explicit scans remain handled when deletion is forbidden or its result is uncertain', async (t) => {
  for (const kind of ['permission', 'network'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      if (kind === 'permission') f.state.deletePermission = false;
      else f.state.deleteError = true;
      const message = f.makeMessage();
      assert.equal(await f.service.processMessage(message), true);
      assert.equal(await f.service.processMessage(message), true);
      assert.equal(f.state.scans.length, 1, 'duplicate positive events reuse the durable handled result');
      assert.equal(f.state.deletes.length, kind === 'permission' ? 0 : 1);
      assert.deepEqual(f.state.bans, []);
    });
});
test('Explicit text and images from other bots and webhooks are scanned and removed without a ban', async (t) => {
  const f = fixture(t);
  for (const webhookId of [null, OWNER]) {
    const message = f.makeMessage({ webhookId, author: { id: USER, bot: true } as Message['author'] });
    assert.equal(await f.service.processMessage(message), true);
  }
  assert.equal(f.state.scans.length, 2);
  assert.equal(f.state.deletes.length, 2);
  assert.deepEqual(f.state.bans, []);
});
test('Honeypot messages ban bannable staff and other bots without classifier calls or confirmations, including child threads', async (t) => {
  for (const channelId of [HONEY, THREAD])
    await t.test(channelId, async (sub) => {
      const f = fixture(sub),
        message = f.makeMessage({ channelId, author: { id: USER, bot: true } as Message['author'] });
      assert.equal(await f.service.processMessage(message), true);
      assert.deepEqual(f.state.deletes, [message.id]);
      assert.deepEqual(f.state.bans, [USER]);
      assert.equal(f.state.scans.length, 0);
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
      await f.service.processMessage(message);
      assert.equal(f.state.bans.length, 1);
    });
});
test('A honeypot webhook post is deleted and recorded without banning an unrelated webhook identity', async (t) => {
  const f = fixture(t),
    message = f.makeMessage({ channelId: HONEY, webhookId: OWNER });
  assert.equal(await f.service.processMessage(message), true);
  assert.deepEqual(f.state.deletes, [message.id]);
  assert.deepEqual(f.state.bans, []);
  assert.match(JSON.stringify(f.store.list('moderation.automatic.cases')), /webhook-has-no-bannable-member/);
});
test('Honeypot owner, hierarchy, bannable and current Ban Members permissions are enforced', async (t) => {
  for (const kind of ['owner', 'hierarchy', 'bannable', 'permission'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      if (kind === 'hierarchy') f.state.targetPosition = 100;
      if (kind === 'bannable') f.state.bannable = false;
      if (kind === 'permission') f.state.banPermission = false;
      const message = f.makeMessage({
        channelId: HONEY,
        ...(kind === 'owner' ? { author: { id: OWNER, bot: false } as Message['author'] } : {}),
      });
      await f.service.processMessage(message);
      assert.deepEqual(f.state.bans, []);
      assert.match(JSON.stringify(f.store.list('moderation.automatic.cases')), /target-or-bot-authority/);
    });
});
test('An ambiguous ban failure has durable suppression and is never automatically retried by later events', async (t) => {
  const f = fixture(t);
  f.state.banError = true;
  const message = f.makeMessage({ channelId: HONEY });
  await f.service.processMessage(message);
  await f.service.processMessage(message);
  await f.service.processMessage(f.makeMessage({ channelId: HONEY }));
  assert.deepEqual(f.state.bans, [USER]);
  assert.equal(f.service.status(G).uncertainTargets, 1);
  assert(!JSON.stringify(f.store.list('moderation.automatic.cases')).includes('PRIVATE_PROVIDER_ERROR'));
});
test('A confirmed Discord Unknown Member response still bans a departed honeypot author by ID exactly once', async (t) => {
  const f = fixture(t),
    message = f.makeMessage({ channelId: HONEY });
  f.state.memberError = new DiscordAPIError(
    { message: 'Unknown Member', code: 10007 },
    10007,
    404,
    'GET',
    'https://discord.com/api/guilds/example/members/example',
    {},
  );
  assert.equal(await f.service.processMessage(message), true);
  assert.equal(await f.service.processMessage(message), true);
  assert.deepEqual(f.state.bans, [USER]);
});
test('A member lookup network failure, forbidden response or unverified error never authorizes a departed-member ban', async (t) => {
  const errors = [
    new Error('network unavailable'),
    new DiscordAPIError(
      { message: 'Missing Access', code: 50001 },
      50001,
      403,
      'GET',
      'https://discord.com/api/guilds/example/members/example',
      {},
    ),
    { code: 10007, status: 404 },
    new DiscordAPIError(
      { message: 'Unknown Member', code: 10007 },
      10007,
      403,
      'GET',
      'https://discord.com/api/guilds/example/members/example',
      {},
    ),
  ];
  for (const [index, error] of errors.entries())
    await t.test(String(index), async (sub) => {
      const f = fixture(sub);
      f.state.memberError = error;
      assert.equal(await f.service.processMessage(f.makeMessage({ channelId: HONEY })), true);
      assert.deepEqual(f.state.bans, []);
      assert.match(
        JSON.stringify(f.store.list('moderation.automatic.cases')),
        /ban-authority-could-not-be-verified/,
      );
    });
});
test('The departed-member fallback still protects the owner and requires current bot Ban Members permission', async (t) => {
  for (const kind of ['owner', 'permission'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      f.state.memberError = new DiscordAPIError(
        { message: 'Unknown Member', code: 10007 },
        10007,
        404,
        'GET',
        'https://discord.com/api/guilds/example/members/example',
        {},
      );
      if (kind === 'permission') f.state.banPermission = false;
      const message = f.makeMessage({
        channelId: HONEY,
        ...(kind === 'owner' ? { author: { id: OWNER, bot: false } as Message['author'] } : {}),
      });
      assert.equal(await f.service.processMessage(message), true);
      assert.deepEqual(f.state.bans, []);
      assert.match(JSON.stringify(f.store.list('moderation.automatic.cases')), /target-or-bot-authority/);
    });
});
test('A provider failure leaves the message intact and is reported without recording clean success', async (t) => {
  const f = fixture(t);
  f.state.classifier = async () => {
    throw new Error('PRIVATE_PROVIDER_ERROR');
  };
  assert.equal(await f.service.processMessage(f.makeMessage()), false);
  assert.deepEqual(f.state.deletes, []);
  assert.deepEqual(f.state.bans, []);
  assert.equal(f.store.list('moderation.automatic.seen').length, 0);
  assert(f.state.errors.some((error) => error.includes('scan failed')));
  assert(!JSON.stringify(f.state.errors).includes('PRIVATE_PROVIDER_ERROR'));
});
test('Unscannable images are allowed with a private failure notice and no false clean record', async (t) => {
  const f = fixture(t);
  f.state.classifier = async () => ({
    remove: false,
    categories: [],
    scannedImages: 0,
    unscannable: ['https://private.example/image.png'],
  });
  assert.equal(await f.service.processMessage(f.makeMessage()), false);
  assert.deepEqual(f.state.deletes, []);
  assert.equal(f.state.logs.length, 1);
  assert.equal(f.store.list('moderation.automatic.seen').length, 0);
  assert.match(JSON.stringify(f.state.logs), /image-scan-incomplete/);
  assert(!JSON.stringify(f.state.logs).includes('private.example'));
});
test('Delayed classifications cannot delete a message edited since admission or after policy revocation', async (t) => {
  for (const kind of ['edited', 'disabled'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub),
        entered = latch(),
        release = latch(),
        message = f.makeMessage();
      f.state.classifier = async () => {
        entered.resolve();
        await release.promise;
        return { remove: true, categories: ['sexual'], scannedImages: 0 };
      };
      const pending = f.service.processMessage(message);
      await entered.promise;
      if (kind === 'edited')
        f.current.set(message.id, {
          ...message,
          content: 'safe edited text',
          editedTimestamp: Date.now(),
        } as Message);
      else f.setPolicy({ enabled: false });
      release.resolve();
      assert.equal(await pending, false);
      assert.deepEqual(f.state.deletes, []);
      assert.deepEqual(f.state.bans, []);
    });
});
test('Disabled input classes are stripped before classification while metadata freshness uses the original event', async (t) => {
  const f = fixture(t);
  f.setPolicy({ textEnabled: false, imagesEnabled: true });
  f.state.classifier = async (message) => {
    assert.equal(message.content, '');
    assert.equal(message.cleanContent, '');
    return { remove: false, categories: [], scannedImages: 0 };
  };
  await f.service.processMessage(f.makeMessage());
  f.setPolicy({ textEnabled: true, imagesEnabled: false });
  f.state.classifier = async (message) => {
    assert.equal(message.content, 'PRIVATE RAW CONTENT');
    assert.equal(message.attachments.size, 0);
    assert(message.embeds.every((embed) => !embed.image && !embed.thumbnail && !embed.video));
    return { remove: false, categories: [], scannedImages: 0 };
  };
  await f.service.processMessage(
    f.makeMessage({ embeds: [{ image: { url: 'https://example.com/private.png' } }] as Message['embeds'] }),
  );
  assert.deepEqual(f.state.errors, []);
});
test('Public moderation logs are rejected with no fallback while moderation effects remain recorded privately', async (t) => {
  const f = fixture(t);
  f.state.publicLog = true;
  assert.equal(await f.service.processMessage(f.makeMessage()), true);
  assert.equal(f.state.deletes.length, 1);
  assert.deepEqual(f.state.logs, []);
  assert(f.state.errors.some((error) => error.includes('private log')));
});
test('Three active scans and 64 queued events stay bounded; deadlines discard late results and drain settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t),
    release = latch();
  let active = 0,
    peak = 0;
  f.state.classifier = async () => {
    active++;
    peak = Math.max(active, peak);
    await release.promise;
    active--;
    return { remove: true, categories: ['sexual'], scannedImages: 0 };
  };
  const pending = Array.from({ length: 67 }, () => f.service.processMessage(f.makeMessage()));
  await tick();
  assert.equal(f.service.status(G).active, 3);
  assert.equal(f.service.status(G).queued, 64);
  assert.equal(peak, 3);
  assert.equal(await f.service.processMessage(f.makeMessage()), false);
  t.mock.timers.tick(30001);
  assert((await Promise.all(pending)).every((value) => value === false));
  await f.service.drain();
  assert.equal(f.service.status(G).queued, 0);
  release.resolve();
  await tick();
  assert.deepEqual(f.state.deletes, []);
  assert.deepEqual(f.state.bans, []);
  assert.equal(peak, 3);
});
test('Honeypot channels and child threads retain immediate ban capacity while the ordinary scan lane is full', async (t) => {
  for (const channelId of [HONEY, THREAD])
    await t.test(channelId, async (sub) => {
      const f = fixture(sub),
        release = latch();
      f.state.classifier = async () => {
        await release.promise;
        return { remove: false, categories: [], scannedImages: 0 };
      };
      const ordinary = Array.from({ length: 67 }, () => f.service.processMessage(f.makeMessage()));
      try {
        await tick();
        assert.equal(f.service.status(G).normalActive, 3);
        assert.equal(f.service.status(G).normalQueued, 64);
        assert.equal(await f.service.processMessage(f.makeMessage({ channelId })), true);
        assert.deepEqual(f.state.bans, [USER]);
        assert.equal(f.state.scans.length, 3, 'honeypot processing did not wait for the blocked classifiers');
        assert.equal(f.service.status(G).normalQueued, 64);
      } finally {
        release.resolve();
        await Promise.all(ordinary);
      }
    });
});
test('The reserved honeypot lane has two active slots and at most 64 waiting events', async (t) => {
  const f = fixture(t),
    release = latch();
  f.state.beforeBan = () => release.promise;
  const pending = Array.from({ length: 66 }, (_, index) =>
    f.service.processMessage(
      f.makeMessage({
        channelId: HONEY,
        author: { id: String(930000000000000000n + BigInt(index)), bot: false } as Message['author'],
      }),
    ),
  );
  try {
    await tick();
    assert.equal(f.service.status(G).honeypotActive, 2);
    assert.equal(f.service.status(G).honeypotQueued, 64);
    assert.equal(await f.service.processMessage(f.makeMessage({ channelId: HONEY })), false);
    assert.equal(f.state.bans.length, 2);
    assert.equal(f.state.scans.length, 0);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
});
test('Close aborts and awaits running workflows; a late uncooperative classifier cannot read or write persistence', async (t) => {
  const f = fixture(t),
    entered = latch(),
    release = latch();
  f.state.classifier = async () => {
    entered.resolve();
    await release.promise;
    return { remove: true, categories: ['sexual'], scannedImages: 0 };
  };
  const pending = f.service.processMessage(f.makeMessage());
  await entered.promise;
  await f.service.close();
  await f.service.drain();
  assert.equal(await pending, false);
  assert.equal(f.service.status(G).active, 0);
  let lateReads = 0,
    lateWrites = 0;
  const get = f.store.get.bind(f.store),
    set = f.store.set.bind(f.store);
  t.mock.method(f.store, 'get', (namespace: string, key: string) => {
    lateReads++;
    return get(namespace, key);
  });
  t.mock.method(f.store, 'set', (namespace: string, key: string, value: unknown) => {
    lateWrites++;
    return set(namespace, key, value);
  });
  release.resolve();
  await tick();
  assert.equal(lateReads, 0);
  assert.equal(lateWrites, 0);
  assert.deepEqual(f.state.deletes, []);
});
