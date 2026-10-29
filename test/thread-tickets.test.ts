import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Client,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  registerThreadTicketActions,
  sweepThreadTicketTasks,
  threadTicketName,
  type ThreadTicket,
} from '../src/features/thread-tickets.js';
const G = '580000000000000001',
  A = '580000000000000002',
  B = '580000000000000003',
  U = '580000000000000004',
  S = '580000000000000005',
  X = '580000000000000006',
  C = '580000000000000007';
const records = 'support.threadTickets',
  DAY = 86400000;
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ordinary = [P.ViewChannel, P.SendMessagesInThreads, P.ReadMessageHistory];
  const member = (id: string, permissions: bigint | bigint[]) => ({
    id,
    user: { id, bot: id === B },
    permissions: new PermissionsBitField(permissions),
    roles: { cache: new Collection<string, unknown>() },
  });
  const manager = member(A, P.Administrator),
    bot = member(B, P.Administrator),
    owner = member(U, ordinary),
    staff = member(S, [...ordinary, P.ModerateMembers]),
    outsider = member(X, ordinary);
  const members = new Map([manager, bot, owner, staff, outsider].map((member) => [member.id, member]));
  const hidden = new Set<string>(),
    noHistory = new Set<string>(),
    creates: Record<string, unknown>[] = [],
    invites: string[] = [],
    edits: Record<string, unknown>[] = [];
  const hooks: {
    create?: () => Promise<void> | void;
    invite?: (userId: string) => Promise<void> | void;
    messages?: () => Promise<void> | void;
    channel?: () => Promise<void> | void;
  } = {};
  const permissionsFor = (principal: { id: string; permissions?: PermissionsBitField }) =>
    new PermissionsBitField(
      hidden.has(principal.id)
        ? 0n
        : noHistory.has(principal.id)
          ? [P.ViewChannel, P.SendMessagesInThreads]
          : (principal.permissions ?? ordinary),
    );
  const threads = new Map<string, ReturnType<typeof thread>>();
  let serial = 580000000000000100n;
  function thread(id: string, input: Record<string, unknown>) {
    const participants = new Set([B]);
    const result = {
      id,
      guildId: G,
      type: ChannelType.PrivateThread as ChannelType.PrivateThread,
      parentId: C,
      ownerId: B,
      name: String(input.name),
      invitable: false,
      archived: false,
      locked: false,
      isTextBased: () => true,
      isThread: () => true,
      permissionsFor,
      members: {
        fetch: async (id: string) => {
          if (!participants.has(id)) throw new Error('Not a private thread member');
          return { id };
        },
        add: async (id: string) => {
          invites.push(id);
          await hooks.invite?.(id);
          participants.add(id);
        },
      },
      participants,
      messages: {
        fetch: async () => {
          await hooks.messages?.();
          return new Collection([
            [
              '580000000000000999',
              {
                id: '580000000000000999',
                createdTimestamp: Date.now(),
                createdAt: new Date(),
                author: { id: U },
                content: 'Private answer',
                attachments: new Collection(),
              },
            ],
          ]);
        },
      },
      edit: async (input: Record<string, unknown>) => {
        edits.push(input);
        result.archived = Boolean(input.archived);
        result.locked = Boolean(input.locked);
        return result;
      },
    };
    threads.set(id, result);
    return result;
  }
  let archivedHasMore = false;
  const parent = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText as ChannelType,
    permissionsFor,
    threads: {
      create: async (input: Record<string, unknown>) => {
        creates.push(input);
        const result = thread(String(serial++), input);
        await hooks.create?.();
        return result;
      },
      fetchActive: async () => ({
        threads: new Collection([...threads].filter(([, thread]) => !thread.archived)),
      }),
      fetchArchived: async () => ({
        threads: new Collection([...threads].filter(([, thread]) => thread.archived)),
        hasMore: archivedHasMore,
      }),
    },
  };
  const guild = {
    id: G,
    ownerId: A,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const value = members.get(typeof input === 'string' ? input : input.user);
        if (!value) throw new Error('Unknown member');
        return value;
      },
    },
    channels: {
      fetch: async (id: string) => {
        await hooks.channel?.();
        return id === C ? parent : (threads.get(id) ?? null);
      },
    },
  };
  for (const member of members.values()) Object.assign(member, { guild });
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const registry = new ActionRegistry(120, async (ctx) => ctx),
    ctx = { client, store, guild, member: manager, channelId: C } as unknown as ActionContext;
  registerThreadTicketActions(registry);
  async function execute<T = unknown>(id: string, input: unknown = {}, actor = manager): Promise<T> {
    const action = registry.get(id);
    return (await action.execute(
      { ...ctx, member: actor } as unknown as ActionContext,
      action.schema.parse(input),
    )) as T;
  }
  const configure = () =>
    execute<{ version: string }>('ticket.thread-configure', { parentChannelId: C, staffUserIds: [S] });
  const open = async () =>
    execute<ThreadTicket>(
      'ticket.thread-open',
      {
        subject: 'Help with access',
        configurationVersion: store.get<{ version: string }>('support.threadSettings', G)!.version,
      },
      owner,
    );
  const ticket = (id: string) => store.get<ThreadTicket>(records, `${G}:${id}`)!;
  const sweep = (now = Date.now(), allow: readonly string[] = []) =>
    sweepThreadTicketTasks(client, store, now, allow);
  return {
    store,
    manager,
    bot,
    owner,
    staff,
    outsider,
    members,
    hidden,
    noHistory,
    creates,
    invites,
    edits,
    hooks,
    threads,
    parent,
    execute,
    configure,
    open,
    ticket,
    sweep,
    setArchivedHasMore: (value: boolean) => {
      archivedHasMore = value;
    },
  };
}
test('thread tickets use only approved private parent and persist reservation/ID before invitation', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    const saved = f.store.list<ThreadTicket>(records)[0]!.value;
    assert.equal(saved.state, 'creating');
    assert.equal(saved.threadId, undefined);
  };
  f.hooks.invite = () => {
    const saved = f.store.list<ThreadTicket>(records)[0]!.value;
    assert.ok(saved.threadId);
    assert.equal(saved.state, 'inviting');
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'open');
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.invites, [U, S]);
  assert.equal(f.creates[0]!.type, ChannelType.PrivateThread);
  assert.equal(f.creates[0]!.invitable, false);
  assert.equal(f.creates[0]!.name, threadTicketName(ticket));
  assert.equal(ticket.userId, U);
  await assert.rejects(() => f.open(), /existing active/);
});
test('configuration refuses public/unsupported parent, ineligible staff and obsolete version', async (t) => {
  const f = fixture(t);
  f.parent.type = ChannelType.GuildAnnouncement;
  await assert.rejects(() => f.configure(), /ordinary server text/);
  f.parent.type = ChannelType.GuildText;
  f.staff.permissions = new PermissionsBitField([P.ViewChannel, P.SendMessagesInThreads]);
  await assert.rejects(() => f.configure(), /staff member/);
  f.staff.permissions = new PermissionsBitField([P.ViewChannel, P.SendMessagesInThreads, P.ModerateMembers]);
  const first = await f.configure();
  await f.configure();
  await assert.rejects(
    () =>
      f.execute('ticket.thread-open', { subject: 'Example', configurationVersion: first.version }, f.owner),
    /review the current/,
  );
  assert.equal(f.creates.length, 0);
});
test('role-based current staff eligibility can use configured community staff role', async (t) => {
  const f = fixture(t);
  f.staff.permissions = new PermissionsBitField([P.ViewChannel, P.SendMessagesInThreads]);
  f.staff.roles.cache.set('staff', {});
  f.store.set('community.settings', G, { staffRoleId: 'staff' });
  await f.configure();
  assert.equal((await f.open()).state, 'open');
  f.staff.roles.cache.clear();
  await assert.rejects(
    () => f.execute('ticket.thread-view', { id: f.store.list<ThreadTicket>(records)[0]!.value.id }, f.staff),
    /current approved staff/,
  );
});
test('owner and staff parent access and bot thread-management privileges are required', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hidden.add(U);
  await assert.rejects(() => f.open(), /able to view/);
  assert.equal(f.creates.length, 0);
  f.hidden.delete(U);
  f.bot.permissions = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads]);
  await assert.rejects(() => f.open(), /bot needs/);
});
test('uncertain creation never repeats and an exact created thread can be reconciled by staff', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    throw new Error('Lost response');
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'needs-review');
  await f.sweep();
  await assert.rejects(() => f.open(), /existing active/);
  assert.equal(f.creates.length, 1);
  const real = [...f.threads.values()][0]!;
  await assert.rejects(
    () =>
      f.execute(
        'ticket.thread-reconcile',
        { id: ticket.id, outcome: 'created', threadId: C, reviewedServerState: true },
        f.staff,
      ),
    /exact bot-owned/,
  );
  const recovered = await f.execute<ThreadTicket>(
    'ticket.thread-reconcile',
    { id: ticket.id, outcome: 'created', threadId: real.id, reviewedServerState: true },
    f.staff,
  );
  assert.equal(recovered.state, 'open');
  assert.equal(recovered.threadId, real.id);
  assert.deepEqual(f.invites, [U, S]);
});
test('wrong owner/name/parent/thread type cannot be bound during reconciliation', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    throw new Error('lost');
  };
  const ticket = await f.open(),
    real = [...f.threads.values()][0]!;
  real.ownerId = X;
  await assert.rejects(
    () =>
      f.execute(
        'ticket.thread-reconcile',
        { id: ticket.id, outcome: 'created', threadId: real.id, reviewedServerState: true },
        f.staff,
      ),
    /exact bot-owned/,
  );
  real.ownerId = B;
  real.name = 'unrelated-private';
  await assert.rejects(
    () =>
      f.execute(
        'ticket.thread-reconcile',
        { id: ticket.id, outcome: 'created', threadId: real.id, reviewedServerState: true },
        f.staff,
      ),
    /exact bot-owned/,
  );
  assert.equal(f.ticket(ticket.id).state, 'needs-review');
  assert.equal(f.invites.length, 0);
});
test('absent-thread release needs manager, waiting period and bounded active/archived review', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    throw new Error('lost');
  };
  const ticket = await f.open();
  await assert.rejects(
    () =>
      f.execute(
        'ticket.thread-reconcile',
        { id: ticket.id, outcome: 'not-created', reviewedServerState: true },
        f.staff,
      ),
    /Manage Server/,
  );
  await assert.rejects(
    () =>
      f.execute('ticket.thread-reconcile', {
        id: ticket.id,
        outcome: 'not-created',
        reviewedServerState: true,
      }),
    /Wait two minutes/,
  );
  f.store.set(records, `${G}:${ticket.id}`, { ...ticket, createdAt: Date.now() - 180000 });
  await assert.rejects(
    () =>
      f.execute('ticket.thread-reconcile', {
        id: ticket.id,
        outcome: 'not-created',
        reviewedServerState: true,
      }),
    /matching private thread exists/,
  );
  f.threads.clear();
  f.setArchivedHasMore(true);
  await assert.rejects(
    () =>
      f.execute('ticket.thread-reconcile', {
        id: ticket.id,
        outcome: 'not-created',
        reviewedServerState: true,
      }),
    /Archived inventory/,
  );
  f.setArchivedHasMore(false);
  await f.execute('ticket.thread-reconcile', {
    id: ticket.id,
    outcome: 'not-created',
    reviewedServerState: true,
  });
  assert.equal(f.ticket(ticket.id).state, 'closed');
  assert.equal(f.store.get('support.threadActive', `${G}:${U}`), undefined);
});
test('partial invitations retry only known thread and resume without a second creation', async (t) => {
  const f = fixture(t);
  await f.configure();
  let failures = 1;
  f.hooks.invite = (id) => {
    if (id === S && failures-- > 0) throw new Error('Temporary transport');
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'inviting');
  assert.deepEqual(ticket.pendingUserIds, [S]);
  await f.sweep(Date.now() + 60000);
  assert.equal(f.ticket(ticket.id).state, 'open');
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.invites, [U, S, S]);
});
test('three failed invite attempts require explicit known-thread retry', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.invite = () => {
    throw new Error('Temporary');
  };
  const ticket = await f.open();
  await f.sweep(Date.now() + 60000);
  await f.sweep(Date.now() + 180000);
  assert.equal(f.ticket(ticket.id).state, 'failed');
  f.hooks.invite = undefined;
  await f.sweep(Date.now() + 360000);
  assert.equal(f.ticket(ticket.id).state, 'failed');
  await f.execute('ticket.thread-retry', { id: ticket.id }, f.owner);
  assert.equal(f.ticket(ticket.id).state, 'open');
  assert.equal(f.creates.length, 1);
});
test('configuration and module revocation after creation stop pending sharing', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    f.store.set('support.threadSettings', G, {
      ...f.store.get<object>('support.threadSettings', G),
      version: 'a'.repeat(24),
    });
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'failed');
  assert.ok(ticket.threadId);
  assert.equal(f.invites.length, 0);
  const g = fixture(t);
  await g.configure();
  g.hooks.create = () => {
    g.store.set('core.disabled', G, ['support']);
  };
  const second = await g.open();
  assert.equal(second.state, 'failed');
  assert.equal(g.invites.length, 0);
});
test('bot and staff revocation between participant additions is checked again', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.invite = (id) => {
    if (id === U) f.staff.permissions = new PermissionsBitField(P.ViewChannel);
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'failed');
  assert.deepEqual(f.invites, [U]);
  const g = fixture(t);
  await g.configure();
  g.hooks.invite = (id) => {
    if (id === U) g.bot.permissions = new PermissionsBitField(P.ViewChannel);
  };
  const second = await g.open();
  assert.equal(second.state, 'failed');
  assert.deepEqual(g.invites, [U]);
});
test('private membership and current approved staff control reads and closure', async (t) => {
  const f = fixture(t);
  await f.configure();
  const ticket = await f.open();
  await assert.rejects(
    () => f.execute('ticket.thread-view', { id: ticket.id }, f.outsider),
    /Only the ticket owner/,
  );
  const thread = f.threads.get(ticket.threadId!)!;
  thread.participants.delete(U);
  await assert.rejects(() => f.execute('ticket.thread-view', { id: ticket.id }, f.owner), /must belong/);
  thread.participants.add(U);
  f.staff.permissions = new PermissionsBitField([
    P.ViewChannel,
    P.SendMessagesInThreads,
    P.ReadMessageHistory,
  ]);
  await assert.rejects(
    () => f.execute('ticket.thread-close', { id: ticket.id }, f.staff),
    /Only the ticket owner/,
  );
  const closed = await f.execute<ThreadTicket>('ticket.thread-close', { id: ticket.id }, f.owner);
  assert.equal(closed.state, 'closed');
  assert.equal(thread.locked, true);
  assert.equal(thread.archived, true);
  assert.equal(f.threads.size, 1);
  assert.equal(f.store.get('support.threadActive', `${G}:${U}`), undefined);
});
test('transcript reports complete retained ranges and denies history or private membership loss during fetch', async (t) => {
  const f = fixture(t);
  await f.configure();
  const ticket = await f.open();
  const result = await f.execute<{ attachment: Buffer; partial: boolean; messageIds: string[] }>(
    'ticket.thread-transcript',
    { id: ticket.id },
    f.owner,
  );
  assert.equal(result.partial, false);
  assert.match(result.attachment.toString(), /Private answer/);
  assert.equal(result.messageIds.length, 1);
  f.hooks.messages = () => {
    f.noHistory.add(U);
  };
  await assert.rejects(
    () => f.execute('ticket.thread-transcript', { id: ticket.id }, f.owner),
    /required permissions|History access changed/,
  );
  f.noHistory.delete(U);
  f.hooks.messages = () => {
    f.threads.get(ticket.threadId!)!.participants.delete(U);
  };
  await assert.rejects(
    () => f.execute('ticket.thread-transcript', { id: ticket.id }, f.owner),
    /must belong/,
  );
});
test('opening lock prevents concurrent reservations and persisted interrupted create needs review', async (t) => {
  const f = fixture(t);
  await f.configure();
  const results = await Promise.allSettled([f.open(), f.open()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.creates.length, 1);
  const ticket = f.store.list<ThreadTicket>(records)[0]!.value;
  f.store.set(records, `${G}:${ticket.id}`, { ...ticket, state: 'creating', threadId: undefined });
  await f.sweep();
  assert.equal(f.ticket(ticket.id).state, 'needs-review');
  assert.equal(f.creates.length, 1);
});
test('daily quota and support pause prevent new requests before POST', async (t) => {
  const f = fixture(t);
  await f.configure();
  const day = new Date().toISOString().slice(0, 10);
  f.store.set('support.threadDaily', `${G}:${U}:${day}`, 10);
  await assert.rejects(() => f.open(), /ten new thread-ticket/);
  assert.equal(f.creates.length, 0);
  f.store.delete('support.threadDaily', `${G}:${U}:${day}`);
  f.store.set('core.disabled', G, ['support']);
  await assert.rejects(() => f.open(), /Support is disabled/);
  assert.equal(f.creates.length, 0);
});
test('retention removes only old closed metadata and respects allowed servers for queued work', async (t) => {
  const f = fixture(t);
  await f.configure();
  const ticket = await f.open();
  await f.execute('ticket.thread-close', { id: ticket.id }, f.owner);
  f.store.set(records, `${G}:${ticket.id}`, { ...f.ticket(ticket.id), closedAt: Date.now() - 31 * DAY });
  await f.sweep(Date.now(), ['580000000000000999']);
  assert.ok(f.ticket(ticket.id));
  await f.sweep();
  assert.equal(f.ticket(ticket.id), undefined);
  assert.equal(f.threads.size, 1);
});
test('action policy revoked during creation stops invitations without recreating', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    f.store.set('core.actionPolicies', `${G}:ticket.thread-open`, {
      enabled: false,
      roleIds: [],
      channelIds: [],
    });
  };
  const ticket = await f.open();
  assert.equal(ticket.state, 'failed');
  assert.equal(f.invites.length, 0);
  assert.equal(f.creates.length, 1);
});
