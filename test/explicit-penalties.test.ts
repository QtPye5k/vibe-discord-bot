import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Collection,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Client,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { createAutomaticModeration, moderationPolicySchema } from '../src/moderation/service.js';
import {
  createExplicitPenalties,
  EXPLICIT_STRIKES,
  EXPLICIT_VIOLATIONS,
  type ExplicitStrikeCount,
} from '../src/moderation/penalties.js';

const G = '950000000000000001',
  USER = '950000000000000002',
  BOT = '950000000000000003',
  TEXT = '950000000000000004',
  LOG = '950000000000000005',
  OWNER = '950000000000000006',
  OTHER = '950000000000000007';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, path = ':memory:') {
  const store = new Store(path),
    messages = new Map<string, Message>();
  const state = {
    current: true,
    targetPosition: 1,
    botPosition: 100,
    moderatePermission: true,
    banPermission: true,
    moderatable: true,
    bannable: true,
    administrator: false,
    existingTimeout: 0,
    roleFetches: 0,
    warningFailure: false,
    timeoutFailure: false,
    banFailure: false,
    memberFailure: false,
    publicLog: false,
    beforeRoles: undefined as ((count: number) => Promise<void> | void) | undefined,
    beforeWarning: undefined as (() => Promise<void> | void) | undefined,
    warnings: [] as { content: string; allowedMentions: unknown; nonce: string; enforceNonce: boolean }[],
    timeouts: [] as { userId: string; until: number; reason: string }[],
    bans: [] as { userId: string; deleteMessageSeconds: number; reason: string }[],
    deletions: [] as string[],
    privateLogs: [] as { content: string; allowedMentions: unknown }[],
    errors: [] as string[],
  };
  const everyone = { id: G },
    roles = new Collection([[G, everyone]]);
  const bot = {
    id: BOT,
    guild: { id: G },
    user: { id: BOT, bot: true },
    roles: {
      cache: new Collection(),
      get highest() {
        return {
          position: state.botPosition,
          comparePositionTo: (target: { position: number }) => state.botPosition - target.position,
        };
      },
    },
    get permissions() {
      return new PermissionsBitField([
        ...(state.moderatePermission ? [P.ModerateMembers] : []),
        ...(state.banPermission ? [P.BanMembers] : []),
      ]);
    },
  };
  function member(userId: string) {
    return {
      id: userId,
      guild: { id: G },
      user: { id: userId, bot: false },
      get permissions() {
        return new PermissionsBitField(state.administrator ? P.Administrator : 0n);
      },
      get moderatable() {
        return state.moderatable;
      },
      get bannable() {
        return state.bannable;
      },
      get communicationDisabledUntilTimestamp() {
        return state.existingTimeout || null;
      },
      roles: {
        cache: new Collection(),
        get highest() {
          return { position: state.targetPosition };
        },
      },
      disableCommunicationUntil: async (until: number, reason: string) => {
        state.timeouts.push({ userId, until, reason });
        if (state.timeoutFailure) throw new Error('PRIVATE_TIMEOUT_TRANSPORT');
        return member(userId);
      },
    };
  }
  const channel = (id: string) => ({
    id,
    guildId: G,
    type: ChannelType.GuildText,
    isThread: () => false,
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
          : [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages],
      ),
    messages: {
      fetch: async (input: { message: string }) => {
        const message = messages.get(input.message);
        if (!message) throw new Error('Unknown fixture message');
        return message;
      },
    },
    send: async (payload: {
      content: string;
      allowedMentions: unknown;
      nonce: string;
      enforceNonce: boolean;
    }) => {
      if (id === LOG) state.privateLogs.push(payload);
      else {
        state.warnings.push(payload);
        await state.beforeWarning?.();
        if (state.warningFailure) throw new Error('PRIVATE_WARNING_TRANSPORT');
      }
      return { id: 'notice' };
    },
  });
  const channels = new Map([
    [TEXT, channel(TEXT)],
    [LOG, channel(LOG)],
  ]);
  const guild = {
    id: G,
    ownerId: OWNER,
    roles: {
      everyone,
      cache: roles,
      fetch: async () => {
        state.roleFetches++;
        await state.beforeRoles?.(state.roleFetches);
        return roles;
      },
    },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: { user: string }) => {
        if (state.memberFailure) throw new Error('PRIVATE_MEMBER_TRANSPORT');
        return member(input.user);
      },
      ban: async (userId: string, options: { deleteMessageSeconds: number; reason: string }) => {
        state.bans.push({ userId, ...options });
        if (state.banFailure) throw new Error('PRIVATE_BAN_TRANSPORT');
        return { id: userId };
      },
    },
  };
  let serial = 0;
  const makeMessage = (patch: Record<string, unknown> = {}) => {
    const value = {
      id: String(950000000000001000n + BigInt(serial++)),
      guild,
      guildId: G,
      channelId: TEXT,
      channel: channels.get(TEXT),
      author: { id: USER, bot: false },
      content: 'PRIVATE_RAW_CLASSIFIED_CONTENT',
      cleanContent: 'PRIVATE_RAW_CLASSIFIED_CONTENT',
      attachments: new Collection(),
      embeds: [],
      stickers: new Collection(),
      editedTimestamp: null,
      system: false,
      webhookId: null,
      deletable: true,
      delete: async () => {
        state.deletions.push(value.id);
        return value;
      },
      ...patch,
    } as unknown as Message;
    messages.set(value.id, value);
    return value;
  };
  const setPolicy = (patch: Record<string, unknown> = {}) =>
    store.set(
      'moderation.automatic',
      G,
      moderationPolicySchema.parse({
        enabled: true,
        textEnabled: true,
        imagesEnabled: true,
        logChannelId: LOG,
        ...patch,
      }),
    );
  setPolicy();
  const service = createAutomaticModeration({
    store,
    client: { user: { id: BOT } } as Client,
    allowedGuildIds: [G],
    classify: async () => ({ remove: true, categories: ['sexual'], scannedImages: 0 }),
    onError: (error) => state.errors.push(error.message),
  });
  const penalties = createExplicitPenalties(store);
  const apply = (message: Message) =>
    penalties.apply({
      message,
      caseId: `case-${message.id}`,
      current: () => state.current,
      wait: async (work) => work,
    });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
    store.close();
  };
  t.after(close);
  return { store, state, makeMessage, setPolicy, service, apply, close, messages };
}

test('Five explicit violations warn, then apply exact 5/15/30 minute timeouts and one permanent ban', async (t) => {
  const f = fixture(t),
    now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let count = 1; count <= 5; count++)
    assert.equal(await f.service.processMessage(f.makeMessage()), true);
  assert.equal(f.state.warnings.length, 1);
  assert.match(f.state.warnings[0]!.content, /violation 1 of 5/);
  assert.deepEqual(
    f.state.timeouts.map((timeout) => timeout.until - now),
    [5, 15, 30].map((minutes) => minutes * 60_000),
  );
  assert.equal(f.state.bans.length, 1);
  assert.equal(f.state.bans[0]!.userId, USER);
  assert.equal(f.state.bans[0]!.deleteMessageSeconds, 0);
  assert.equal(f.state.deletions.length, 5);
  assert.equal(f.state.privateLogs.length, 5);
  assert.deepEqual(f.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${USER}`)?.count, 5);
  assert.equal(f.store.list(EXPLICIT_VIOLATIONS, `${G}:`).length, 5);
  assert.equal(f.store.list('moderation.temporaryBans').length, 0);
  assert(
    !JSON.stringify(f.store.list('moderation.automatic.cases')).includes('PRIVATE_RAW_CLASSIFIED_CONTENT'),
  );
  assert(!JSON.stringify(f.state.privateLogs).includes('PRIVATE_RAW_CLASSIFIED_CONTENT'));
  assert.match(f.state.privateLogs[4]!.content, /5\/5; ban: completed/);
  assert.deepEqual(f.state.privateLogs[4]!.allowedMentions, { parse: [] });
});

test('Duplicate create events, content edits and provider reprocessing keep one permanent message strike', async (t) => {
  const f = fixture(t),
    original = f.makeMessage();
  await Promise.all([f.service.processMessage(original), f.service.processMessage(original)]);
  const edited = f.makeMessage({
    id: original.id,
    content: 'DIFFERENT_PRIVATE_RAW_CONTENT',
    editedTimestamp: Date.now(),
  });
  await f.service.processMessage(edited, { edited: true });
  await f.service.processMessage(edited, { edited: true });
  assert.equal(f.state.warnings.length, 1);
  assert.equal(f.state.timeouts.length, 0);
  assert.equal(f.state.bans.length, 0);
  assert.equal(f.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${USER}`)?.count, 1);
  assert.equal(f.store.list(EXPLICIT_VIOLATIONS).length, 1);
});

test('Member strikes and message deduplication survive database close and service reconstruction', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-explicit-')),
    path = join(dir, 'bot.sqlite'),
    first = fixture(t, path);
  const message = first.makeMessage();
  await first.apply(message);
  await first.close();
  const restarted = fixture(t, path),
    repeated = restarted.makeMessage({ id: message.id });
  const outcome = await restarted.apply(repeated);
  assert.equal(outcome.duplicate, true);
  assert.equal(restarted.state.warnings.length, 0);
  await restarted.apply(restarted.makeMessage());
  assert.equal(restarted.state.timeouts.length, 1);
  assert.equal(restarted.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${USER}`)?.count, 2);
  t.after(async () => {
    await restarted.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'vibe-explicit-')));
    rmSync(dir, { recursive: true, force: true });
  });
});

test('Concurrent violations serialize member penalties instead of racing or losing persistent counts', async (t) => {
  const f = fixture(t),
    entered = latch(),
    release = latch();
  f.state.beforeWarning = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.apply(f.makeMessage());
  await entered.promise;
  const second = f.apply(f.makeMessage()),
    third = f.apply(f.makeMessage());
  await tick();
  assert.equal(f.state.timeouts.length, 0);
  assert.equal(f.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${USER}`)?.count, 1);
  release.resolve();
  const outcomes = await Promise.all([first, second, third]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.penalty?.count),
    [1, 2, 3],
  );
  assert.equal(f.state.timeouts.length, 2);
});

test('Only current members strictly below the bot count as eligible; owner, bot, peers, higher roles and webhooks do not', async (t) => {
  for (const kind of ['peer', 'higher', 'owner', 'self', 'webhook', 'missing'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      if (kind === 'peer') f.state.targetPosition = f.state.botPosition;
      if (kind === 'higher') f.state.targetPosition = f.state.botPosition + 1;
      if (kind === 'missing') f.state.memberFailure = true;
      const message = f.makeMessage(
        kind === 'owner'
          ? { author: { id: OWNER, bot: false } }
          : kind === 'self'
            ? { author: { id: BOT, bot: true } }
            : kind === 'webhook'
              ? { webhookId: OTHER }
              : {},
      );
      await f.apply(message);
      assert.equal(f.store.list(EXPLICIT_STRIKES).length, 0);
      assert.equal(f.store.list(EXPLICIT_VIOLATIONS).length, 0);
      assert.deepEqual(f.state.warnings, []);
      assert.deepEqual(f.state.timeouts, []);
      assert.deepEqual(f.state.bans, []);
    });
});

test('A role promotion during fresh authority checks prevents both counting and punishment', async (t) => {
  const f = fixture(t);
  f.state.beforeRoles = (count) => {
    if (count === 2) f.state.targetPosition = f.state.botPosition;
  };
  const result = await f.apply(f.makeMessage());
  assert.match(result.issue ?? '', /no-longer-eligible/);
  assert.equal(f.store.list(EXPLICIT_STRIKES).length, 0);
  assert.equal(f.state.warnings.length, 0);
});

test('Current Moderate Members loss and administrator immunity block timeout without pretending success', async (t) => {
  for (const kind of ['permission', 'administrator', 'moderatable'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      f.store.set(EXPLICIT_STRIKES, `${G}:${USER}`, {
        count: 1,
        lastCaseId: 'previous',
        updatedAt: Date.now(),
      });
      if (kind === 'permission')
        f.state.beforeRoles = (count) => {
          if (count === 2) f.state.moderatePermission = false;
        };
      if (kind === 'administrator') f.state.administrator = true;
      if (kind === 'moderatable') f.state.moderatable = false;
      const outcome = await f.apply(f.makeMessage());
      assert.equal(outcome.penalty?.count, 2);
      assert.equal(outcome.penalty?.state, 'blocked');
      assert.match(outcome.penalty?.issue ?? '', /timeout-authority/);
      assert.equal(f.state.timeouts.length, 0);
    });
});

test('Current Ban Members loss or unbannable members block the fifth penalty', async (t) => {
  for (const kind of ['permission', 'bannable'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      f.store.set(EXPLICIT_STRIKES, `${G}:${USER}`, {
        count: 4,
        lastCaseId: 'previous',
        updatedAt: Date.now(),
      });
      if (kind === 'permission')
        f.state.beforeRoles = (count) => {
          if (count === 2) f.state.banPermission = false;
        };
      else f.state.bannable = false;
      const outcome = await f.apply(f.makeMessage());
      assert.equal(outcome.penalty?.count, 5);
      assert.equal(outcome.penalty?.state, 'blocked');
      assert.equal(f.state.bans.length, 0);
    });
});

test('A pre-existing longer timeout is preserved without issuing a shorter timeout request', async (t) => {
  const f = fixture(t);
  f.store.set(EXPLICIT_STRIKES, `${G}:${USER}`, { count: 1, lastCaseId: 'previous', updatedAt: Date.now() });
  f.state.existingTimeout = Date.now() + 60 * 60_000;
  const outcome = await f.apply(f.makeMessage());
  assert.equal(outcome.penalty?.timeoutUntil, f.state.existingTimeout);
  assert.equal(outcome.penalty?.state, 'completed');
  assert.equal(f.state.timeouts.length, 0);
});

test('Ambiguous permanent ban results are recorded once and later events cannot automatically retry the ban', async (t) => {
  const f = fixture(t);
  f.store.set(EXPLICIT_STRIKES, `${G}:${USER}`, { count: 4, lastCaseId: 'previous', updatedAt: Date.now() });
  f.state.banFailure = true;
  const message = f.makeMessage(),
    outcome = await f.apply(message);
  assert.equal(outcome.penalty?.state, 'uncertain');
  assert.match(outcome.penalty?.issue ?? '', /ban-result-unknown/);
  await f.apply(message);
  await f.apply(f.makeMessage());
  assert.equal(f.state.bans.length, 1);
  assert.equal(f.store.list(EXPLICIT_VIOLATIONS).length, 1);
  assert(!JSON.stringify(f.store.list(EXPLICIT_VIOLATIONS)).includes('PRIVATE_BAN_TRANSPORT'));
});

test('Warning transport ambiguity is not retried for a repeated message and uses one stable mention-limited nonce', async (t) => {
  const f = fixture(t);
  f.state.warningFailure = true;
  const message = f.makeMessage(),
    outcome = await f.apply(message);
  assert.equal(outcome.penalty?.state, 'uncertain');
  await f.apply(message);
  assert.equal(f.state.warnings.length, 1);
  assert.deepEqual(f.state.warnings[0]!.allowedMentions, { parse: [], users: [USER] });
  assert.equal(f.state.warnings[0]!.enforceNonce, true);
  assert.ok(f.state.warnings[0]!.nonce.length <= 25);
});

test('Cancellation or policy changes during authority I/O create no late strike or penalty', async (t) => {
  const f = fixture(t),
    entered = latch(),
    release = latch();
  f.state.beforeRoles = async (count) => {
    if (count === 2) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.apply(f.makeMessage());
  await entered.promise;
  f.state.current = false;
  release.resolve();
  await pending;
  assert.equal(f.store.list(EXPLICIT_STRIKES).length, 0);
  assert.equal(f.state.warnings.length, 0);
});

test('Legacy policies inherit escalation without overwriting existing text/image/honeypot/log settings', async (t) => {
  const f = fixture(t),
    legacy = {
      enabled: true,
      textEnabled: true,
      imagesEnabled: false,
      honeypotChannelId: null,
      logChannelId: LOG,
    };
  f.store.set('moderation.automatic', G, legacy);
  assert.equal(f.service.policy(G).explicitEscalationEnabled, true);
  await f.service.processMessage(f.makeMessage());
  assert.equal(f.state.warnings.length, 1);
  assert.deepEqual(f.store.get('moderation.automatic', G), legacy);
});

test('Explicit escalation can be disabled independently while the existing content deletion policy remains active', async (t) => {
  const f = fixture(t);
  f.setPolicy({ explicitEscalationEnabled: false });
  await f.service.processMessage(f.makeMessage());
  assert.equal(f.state.deletions.length, 1);
  assert.equal(f.state.warnings.length, 0);
  assert.equal(f.store.list(EXPLICIT_STRIKES).length, 0);
});

test('Per-member and per-server counts remain separate and public log destinations never receive private outcomes', async (t) => {
  const f = fixture(t);
  f.store.set(EXPLICIT_STRIKES, `${OTHER}:${USER}`, {
    count: 5,
    lastCaseId: 'different-server',
    updatedAt: Date.now(),
  });
  await f.apply(f.makeMessage());
  await f.apply(f.makeMessage({ author: { id: OTHER, bot: false } }));
  assert.equal(f.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${USER}`)?.count, 1);
  assert.equal(f.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${G}:${OTHER}`)?.count, 1);
  f.state.publicLog = true;
  await f.service.processMessage(f.makeMessage());
  assert.equal(f.state.privateLogs.length, 0);
  assert.ok(f.state.errors.some((error) => error.includes('private log')));
});
