import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  MessageFlags,
  type Interaction,
  type Role,
} from 'discord.js';
import { z } from 'zod';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import { registerCommunityActions } from '../src/features/community.js';
import {
  registerInterfaceActions,
  handleInterfaceInteraction,
  formDefinitionSchema,
  formFieldSchema,
  startFormSession,
  buildFormModal,
  type InterfaceOptions,
} from '../src/features/interfaces.js';

const GUILD = '510000000000000001',
  USER = '510000000000000002',
  OTHER = '510000000000000003',
  CHANNEL = '510000000000000004',
  BOT = '510000000000000005',
  ROLE = '510000000000000006';
function fixture(t: TestContext, interfaceOptions: InterfaceOptions = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const roles = new Map<string, unknown>();
  const role = {
    id: ROLE,
    name: 'Member',
    guild: { id: GUILD },
    managed: false,
    position: 2,
    permissions: new PermissionsBitField(0n),
  };
  roles.set(ROLE, role);
  const makeMember = (id: string) => ({
    id,
    user: { id, bot: false, username: id, createdTimestamp: Date.now() - 30 * 86400000 },
    pending: false,
    joinedTimestamp: Date.now() - 86400000,
    permissions: new PermissionsBitField(P.Administrator),
    roles: {
      cache: new Collection<string, Role>(),
      highest: { position: 100, comparePositionTo: (target: { position: number }) => 100 - target.position },
      add: async (_role: unknown) => {},
      remove: async () => {},
    },
  });
  const member = makeMember(USER),
    other = makeMember(OTHER),
    bot = makeMember(BOT);
  const members = new Map([
    [USER, member],
    [OTHER, other],
    [BOT, bot],
  ]);
  const sends: Record<string, unknown>[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  let serial = 0;
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    isSendable: () => true,
    isTextBased: () => true,
    permissionsFor: (target: { id: string }) =>
      new PermissionsBitField(target.id === GUILD ? 0n : P.Administrator),
    send: async (payload: Record<string, unknown>) => {
      sends.push(payload);
      const message = {
        id: `message-${++serial}`,
        author: { id: BOT },
        edit: async (update: unknown) => {
          Object.assign(message, { lastUpdate: update });
          return message;
        },
        delete: async () => {
          messages.delete(message.id);
        },
      };
      messages.set(message.id, message);
      return message;
    },
    messages: {
      fetch: async (id: string) => {
        const message = messages.get(id);
        if (!message) throw Object.assign(new Error('missing'), { code: 10008 });
        return message;
      },
    },
  };
  const channels = new Map([[CHANNEL, channel]]);
  const guild = {
    id: GUILD,
    ownerId: USER,
    name: 'Test',
    roles: { everyone: { id: GUILD }, fetch: async (id: string) => roles.get(id) ?? null },
    members: {
      me: bot,
      fetch: async (input: string | { user: string }) => {
        const value = members.get(typeof input === 'string' ? input : input.user);
        if (!value) throw new Error('Member missing');
        return value;
      },
      fetchMe: async () => bot,
    },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
  };
  for (const value of members.values()) Object.assign(value, { guild });
  const client = {
    user: { id: BOT },
    application: { fetchSKUs: async () => new Collection() },
    guilds: { fetch: async () => guild },
  };
  const ctx = { client, guild, member, store, channelId: CHANNEL } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (context) => context);
  registerCommunityActions(registry);
  registerInterfaceActions(registry, interfaceOptions);
  const execute = async (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  return {
    store,
    registry,
    ctx,
    execute,
    member,
    other,
    bot,
    role,
    roles,
    channel,
    channels,
    sends,
    messages,
  };
}
function fake(
  kind: 'button' | 'select' | 'modal',
  customId: string,
  options: {
    userId?: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
    values?: string[];
    answers?: Record<string, unknown>;
  } = {},
) {
  const events: string[] = [],
    payloads: unknown[] = [];
  const answer = (id: string) => options.answers?.[id.replace(/^field:/, '')];
  const data = {
    customId,
    user: { id: options.userId ?? USER },
    guildId: options.guildId ?? GUILD,
    channelId: options.channelId ?? CHANNEL,
    message: { id: options.messageId ?? 'message-1' },
    values: options.values ?? [],
    deferred: false,
    replied: false,
    inGuild: () => true,
    isMessageComponent: () => kind !== 'modal',
    isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'select',
    fields: {
      getTextInputValue: (id: string) => String(answer(id) ?? ''),
      getRadioGroup: (id: string) => answer(id) ?? null,
      getCheckbox: (id: string) => answer(id) ?? false,
      getCheckboxGroup: (id: string) => answer(id) ?? [],
      getStringSelectValues: (id: string) => answer(id) ?? [],
      getSelectedUsers: (id: string) =>
        new Collection(((answer(id) as string[]) ?? []).map((id) => [id, { id }])),
      getSelectedRoles: (id: string) =>
        new Collection(((answer(id) as string[]) ?? []).map((id) => [id, { id }])),
      getSelectedChannels: (id: string) =>
        new Collection(((answer(id) as string[]) ?? []).map((id) => [id, { id }])),
      getSelectedMentionables: (id: string) => ({
        users: new Collection(((answer(id) as string[]) ?? []).map((id) => [id, { id }])),
        roles: new Collection(),
      }),
      getUploadedFiles: (id: string) =>
        new Collection(
          ((answer(id) as { name: string; size: number; url: string }[]) ?? []).map((file, index) => [
            String(index),
            file,
          ]),
        ),
    },
    async showModal(payload: { toJSON(): unknown }) {
      events.push('modal');
      payloads.push(payload.toJSON());
      data.replied = true;
    },
    async deferReply(payload: unknown) {
      events.push('defer');
      payloads.push(payload);
      data.deferred = true;
    },
    async editReply(payload: unknown) {
      events.push('edit');
      payloads.push(payload);
      return payload;
    },
    async reply(payload: unknown) {
      events.push('reply');
      payloads.push(payload);
      data.replied = true;
      return payload;
    },
  };
  return { interaction: data as unknown as Interaction, data, events, payloads };
}
const getContent = (value: unknown) => String((value as { content?: string })?.content ?? '');
const simpleForm = {
  id: 'apply',
  title: 'Application',
  fields: [{ id: 'name', label: 'Your name', kind: 'short' as const }],
};

test('general pagination publishes real controls, advances privately and rejects another owner', async (t) => {
  const f = fixture(t);
  const row = (await f.execute('ui.pages.publish', {
    channelId: CHANNEL,
    title: 'Reviewed list',
    pages: ['First page', 'Second page'],
  })) as { id: string };
  assert.match(getContent(f.sends[0]), /First page/);
  const next = fake('button', `ui:pages:${row.id}:1`);
  await handleInterfaceInteraction(next.interaction, f.ctx, f.registry);
  assert.match(getContent(next.payloads.at(-1)), /Second page/);
  assert.deepEqual(next.payloads[0], { flags: MessageFlags.Ephemeral });
  const other = fake('button', `ui:pages:${row.id}:1`, { userId: OTHER });
  await handleInterfaceInteraction(
    other.interaction,
    { ...f.ctx, member: f.other } as unknown as ActionContext,
    f.registry,
  );
  assert.match(getContent(other.payloads.at(-1)), /another person/);
});

test('CAPTCHA-required verification fails closed until a bound proof gate succeeds and consumes it once', async (t) => {
  let proof = false,
    consumed = 0,
    granted = 0;
  const f = fixture(t, {
    assertCaptcha: async (ctx, version) => {
      assert.equal(ctx.member.id, USER);
      assert.equal(ctx.store.get<{ version: string }>('ui.verification', GUILD)!.version, version);
      if (!proof) throw new Error('Complete the configured CAPTCHA');
      proof = false;
      consumed++;
    },
  });
  f.member.roles.add = async () => {
    granted++;
  };
  await f.execute('verification.configure', { roleId: ROLE, rules: 'Read rules', captchaRequired: true });
  await assert.rejects(() => f.execute('verification.complete'), /CAPTCHA/);
  assert.equal(granted, 0);
  proof = true;
  await f.execute('verification.complete');
  assert.equal(consumed, 1);
  assert.equal(granted, 1);
  await assert.rejects(() => f.execute('verification.complete'), /CAPTCHA/);
  assert.equal(granted, 1);
});

test('missing CAPTCHA configuration and policy replacement during proof consumption cannot grant a role', async (t) => {
  const f = fixture(t);
  await f.execute('verification.configure', { roleId: ROLE, rules: 'Rules', captchaRequired: true });
  await assert.rejects(() => f.execute('verification.complete'), /provider is not configured/);
  let grants = 0;
  const changed = fixture(t, {
    assertCaptcha: async (ctx) => {
      const row = ctx.store.get<Record<string, unknown>>('ui.verification', GUILD)!;
      row.version = 'changed';
      ctx.store.set('ui.verification', GUILD, row);
    },
  });
  changed.member.roles.add = async () => {
    grants++;
  };
  await changed.execute('verification.configure', { roleId: ROLE, rules: 'Rules', captchaRequired: true });
  await assert.rejects(() => changed.execute('verification.complete'), /policy changed/);
  assert.equal(grants, 0);
});

test('Interface action catalog is strict, described, serializable and has no unguarded action execution proxy', (t) => {
  const f = fixture(t);
  const actions = f.registry.list().filter((action) => action.category === 'interfaces');
  assert.ok(actions.length >= 28);
  for (const action of actions) {
    assert.ok(action.description);
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(action.schema)));
  }
  assert.throws(() =>
    f.registry
      .get('ui.roles.publish')
      .schema.parse({ channelId: CHANNEL, roleIds: [ROLE], execute: 'arbitrary' }),
  );
});

test('Typed form definition validates unique fields and choices before any configuration is saved', () => {
  assert.equal(formDefinitionSchema.parse(simpleForm).fields[0]?.required, true);
  assert.throws(() =>
    formDefinitionSchema.parse({ ...simpleForm, fields: [...simpleForm.fields, ...simpleForm.fields] }),
  );
  assert.throws(() => formFieldSchema.parse({ id: 'choice', label: 'Choice', kind: 'radio' }));
  assert.throws(() =>
    formFieldSchema.parse({
      id: 'choice',
      label: 'Choice',
      kind: 'select',
      options: [
        { label: 'A', value: 'same' },
        { label: 'B', value: 'same' },
      ],
    }),
  );
  assert.throws(() =>
    formDefinitionSchema.parse({
      ...simpleForm,
      fields: Array.from({ length: 21 }, (_, i) => ({ id: `field${i}`, label: 'Field', kind: 'short' })),
    }),
  );
});

test('All supported modal input types serialize into real labeled Discord components', async (t) => {
  const f = fixture(t);
  const kinds = [
    'short',
    'paragraph',
    'radio',
    'checkbox',
    'checkboxes',
    'select',
    'user',
    'role',
    'channel',
    'mentionable',
    'file',
  ] as const;
  await f.execute('form.create', {
    id: 'survey',
    title: 'Survey',
    fields: kinds.map((kind, index) => ({
      id: `f${index}`,
      label: kind,
      kind,
      ...(['radio', 'checkboxes', 'select'].includes(kind)
        ? {
            options: [
              { label: 'One', value: 'one' },
              { label: 'Two', value: 'two' },
            ],
          }
        : {}),
    })),
  });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'survey');
  const form = f.store.get<Parameters<typeof buildFormModal>[0]>('ui.forms', `${GUILD}:survey`)!;
  const types: number[] = [];
  for (let step = 0; step < 3; step++) {
    const modal = buildFormModal(form, { ...draft, step }).toJSON();
    assert.ok(modal.components.length <= 5);
    for (const component of modal.components) {
      assert.equal(component.type, 18);
      if ('component' in component) types.push(component.component.type);
    }
  }
  assert.deepEqual(types, [4, 4, 21, 23, 22, 3, 5, 6, 8, 7, 19]);
});

test('Form opening acknowledges with a modal before performing slow Discord context authorization', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const panel = (await f.execute('form.publish', { formId: 'apply', channelId: CHANNEL })) as {
    id: string;
    messageId: string;
  };
  let contextCalls = 0;
  const i = fake('button', `ui:formopen:${panel.id}`, { messageId: panel.messageId });
  assert.equal(
    await handleInterfaceInteraction(
      i.interaction,
      async () => {
        contextCalls++;
        throw new Error('Must not fetch for public modal presentation');
      },
      f.registry,
      f.store,
    ),
    true,
  );
  assert.deepEqual(i.events, ['modal']);
  assert.equal(contextCalls, 0);
  assert.equal(f.store.list('ui.drafts').length, 1);
});

test('Multi-step form drafts are bound to their actor, guild and channel and reject reordered/replayed steps', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', {
    ...simpleForm,
    fields: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, kind: 'short' })),
  });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  const submit = fake('modal', `ui:formsubmit:${draft.id}:0`, {
    answers: { f0: 'A', f1: 'B', f2: 'C', f3: 'D', f4: 'E' },
  });
  await handleInterfaceInteraction(submit.interaction, f.ctx, f.registry);
  assert.deepEqual(submit.events, ['defer', 'edit']);
  assert.equal(f.store.get<{ step: number }>('ui.drafts', `${GUILD}:${draft.id}`)?.step, 1);
  const stolen = fake('button', `ui:formnext:${draft.id}`, { userId: OTHER });
  await handleInterfaceInteraction(
    stolen.interaction,
    { ...f.ctx, member: f.other } as unknown as ActionContext,
    f.registry,
  );
  assert.match(getContent(stolen.payloads.at(-1)), /another person/);
  const wrongChannel = fake('button', `ui:formnext:${draft.id}`, { channelId: OTHER });
  await handleInterfaceInteraction(wrongChannel.interaction, f.ctx, f.registry);
  assert.match(getContent(wrongChannel.payloads.at(-1)), /another person or channel/);
  const replay = fake('modal', `ui:formsubmit:${draft.id}:0`, { answers: { f0: 'replace' } });
  await handleInterfaceInteraction(replay.interaction, f.ctx, f.registry);
  assert.match(getContent(replay.payloads.at(-1)), /already submitted|out of order/);
  const final = fake('modal', `ui:formsubmit:${draft.id}:1`, { answers: { f5: 'F' } });
  await handleInterfaceInteraction(final.interaction, f.ctx, f.registry);
  assert.match(getContent(final.payloads.at(-1)), /Review your answers/);
  assert.equal(f.store.list('ui.submissions').length, 0);
  const pending = f.store.db.prepare('SELECT id FROM confirmations').get();
  assert.ok(pending);
  await f.registry.confirm(f.ctx, String(pending.id));
  assert.equal(f.store.list('ui.submissions').length, 1);
});

test('Single-use form submission preserves exact draft answers and limits duplicate submissions', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  const submit = fake('modal', `ui:formsubmit:${draft.id}:0`, { answers: { name: 'Alice' } });
  await handleInterfaceInteraction(submit.interaction, f.ctx, f.registry);
  const confirmation = f.store.db.prepare('SELECT id FROM confirmations').get()!;
  await f.registry.confirm(f.ctx, String(confirmation.id));
  const row = f.store.list<{ answers: unknown }>('ui.submissions')[0]!;
  assert.deepEqual(row.value.answers, { name: 'Alice' });
  await assert.rejects(f.execute('form.submit', { sessionId: draft.id }), /another person/);
  const second = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${second.id}`, { ...second, ready: true, answers: { name: 'Bob' } });
  await assert.rejects(f.execute('form.submit', { sessionId: second.id }), /submission limit/);
});

test('Form revision changes and twenty-minute expiry invalidate pending drafts', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  await f.execute('form.create', { ...simpleForm, title: 'Updated' });
  await assert.rejects(f.execute('form.draft', { sessionId: draft.id }), /updated/);
  const newer = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${newer.id}`, { ...newer, expiresAt: Date.now() - 1 });
  await assert.rejects(f.execute('form.draft', { sessionId: newer.id }), /expired/);
  assert.equal(f.store.get('ui.drafts', `${GUILD}:${newer.id}`), undefined);
});

test('Form sessions enforce per-user limits and purge expired sessions before admitting new ones', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const first = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  assert.throws(() => startFormSession(f.store, GUILD, USER, CHANNEL, 'apply'), /current forms/);
  f.store.set('ui.drafts', `${GUILD}:${first.id}`, { ...first, expiresAt: Date.now() - 1 });
  assert.ok(startFormSession(f.store, GUILD, USER, CHANNEL, 'apply').id);
});

test('Staff submissions remain private, self-review is denied and CSV export neutralizes formulas', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
    ...draft,
    ready: true,
    answers: { name: '=HYPERLINK("danger")' },
  });
  const record = (await f.execute('form.submit', { sessionId: draft.id })) as { submitted: string };
  f.other.permissions = new PermissionsBitField(0n);
  const outsider = { ...f.ctx, member: f.other } as unknown as ActionContext;
  await assert.rejects(f.execute('form.responses', { formId: 'apply' }, outsider), /restricted/);
  await assert.rejects(
    f.execute('form.response', { submissionId: record.submitted }, outsider),
    /unavailable/,
  );
  await assert.rejects(
    f.execute('form.review', { submissionId: record.submitted, decision: 'accepted' }, f.ctx),
    /own submission/,
  );
  f.other.permissions = new PermissionsBitField(P.ManageGuild);
  await f.execute(
    'form.review',
    { submissionId: record.submitted, decision: 'accepted', note: 'Private staff note' },
    outsider,
  );
  const mine = (await f.execute('form.mine')) as Record<string, unknown>[];
  assert.equal(mine[0]?.note, undefined);
  const exported = (await f.execute('form.export', { formId: 'apply' })) as { attachment: Buffer };
  assert.ok(exported.attachment.toString().includes("'=HYPERLINK"));
});

test('Anonymous forms disclose the identity contract before confirmation and redact every normal reviewer/export path', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', {
    ...simpleForm,
    anonymous: true,
    staffRoleId: ROLE,
    reviewChannelId: CHANNEL,
  });
  const definitions = (await f.execute('form.list')) as { anonymous: boolean; identityDisclosure: string }[];
  assert.equal(definitions[0]!.anonymous, true);
  assert.match(definitions[0]!.identityDisclosure, /bot operators can access audit\/internal records/);
  await f.execute('form.publish', { formId: 'apply', channelId: CHANNEL });
  assert.match(String(f.sends[0]!.content), /Identity is hidden in normal staff review\/export/);
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  const submit = fake('modal', `ui:formsubmit:${draft.id}:0`, { answers: { name: '=HYPERLINK("example")' } });
  await handleInterfaceInteraction(submit.interaction, f.ctx, f.registry);
  const previewText = getContent(submit.payloads.at(-1));
  assert.match(previewText, /Identity is hidden in normal staff review\/export/);
  assert.match(previewText, /audit entries may correlate/);
  assert.match(previewText, /Answers and files can identify you/);
  assert.equal(f.store.list('ui.submissions').length, 0);
  const pending = f.store.db.prepare('SELECT id,input FROM confirmations').get()!;
  assert.equal(JSON.parse(String(pending.input)).anonymousDisclosureAccepted, true);
  await f.registry.confirm(f.ctx, String(pending.id));
  const saved = f.store.list<{ id: string; userId: string; anonymous: boolean }>('ui.submissions')[0]!.value;
  assert.equal(saved.userId, USER);
  assert.equal(saved.anonymous, true);
  f.other.permissions = new PermissionsBitField(0n);
  f.other.roles.cache.set(ROLE, f.role as unknown as Role);
  const reviewer = { ...f.ctx, member: f.other } as unknown as ActionContext;
  const normal = await f.registry.request(reviewer, 'form.response', { submissionId: saved.id });
  assert.equal(normal.status, 'completed');
  assert.ok(!JSON.stringify(normal).includes(USER));
  const response = (await f.execute('form.response', { submissionId: saved.id }, reviewer)) as Record<
    string,
    unknown
  >;
  assert.equal(response.userId, undefined);
  assert.equal(response.anonymous, true);
  assert.deepEqual(response.answers, { name: '=HYPERLINK("example")' });
  const summary = await f.execute('form.responses', { formId: 'apply' }, reviewer);
  assert.ok(!JSON.stringify(summary).includes(USER));
  assert.ok(!JSON.stringify(summary).includes('HYPERLINK'));
  await f.execute(
    'form.review',
    { submissionId: saved.id, decision: 'accepted', note: 'Private staff discussion' },
    reviewer,
  );
  const exported = (await f.execute('form.export', { formId: 'apply' }, reviewer)) as { attachment: Buffer };
  assert.ok(!exported.attachment.toString().includes(USER));
  assert.match(exported.attachment.toString(), /hidden from reviewers/);
  assert.match(exported.attachment.toString(), /'=HYPERLINK/);
  const mine = (await f.execute('form.mine')) as Record<string, unknown>[];
  assert.equal(mine[0]!.userId, undefined);
  assert.equal(mine[0]!.note, undefined);
  assert.equal(mine[0]!.reviewerId, undefined);
  assert.ok(f.sends.every((payload) => !String(payload.content).includes(USER)));
  // Even a server manager gets the same redacted ordinary view. There is no operator reveal endpoint.
  assert.equal(
    ((await f.execute('form.response', { submissionId: saved.id })) as Record<string, unknown>).userId,
    undefined,
  );
});

test('Anonymous direct submission requires the explicit disclosure acknowledgement and private audit preserves confirmation ownership', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', { ...simpleForm, anonymous: true });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
    ...draft,
    ready: true,
    answers: { name: 'No contact details' },
  });
  const ownDraft = (await f.execute('form.draft', { sessionId: draft.id })) as { identityDisclosure: string };
  assert.match(ownDraft.identityDisclosure, /not absolute anonymity/);
  const denied = await f.registry.request(f.ctx, 'form.submit', { sessionId: draft.id });
  assert.equal(denied.status, 'confirmation');
  if (denied.status === 'confirmation')
    await assert.rejects(() => f.registry.confirm(f.ctx, denied.id), /anonymousDisclosureAccepted:true/);
  assert.equal(f.store.list('ui.submissions').length, 0);
  const approved = await f.registry.request(f.ctx, 'form.submit', {
    sessionId: draft.id,
    anonymousDisclosureAccepted: true,
  });
  assert.equal(approved.status, 'confirmation');
  if (approved.status === 'confirmation') {
    assert.equal(
      f.store.db.prepare('SELECT user_id FROM confirmations WHERE id=?').get(approved.id)?.user_id,
      USER,
    );
    await f.registry.confirm(f.ctx, approved.id);
  }
  await f.execute('form.create', { ...simpleForm, id: 'identified', anonymous: false });
  const identifiedDraft = startFormSession(f.store, GUILD, USER, CHANNEL, 'identified');
  f.store.set('ui.drafts', `${GUILD}:${identifiedDraft.id}`, {
    ...identifiedDraft,
    ready: true,
    answers: { name: 'Identified author' },
  });
  const identifiedApproval = await f.registry.request(f.ctx, 'form.submit', {
    sessionId: identifiedDraft.id,
  });
  if (identifiedApproval.status === 'confirmation') {
    assert.equal(
      f.store.db.prepare('SELECT user_id FROM confirmations WHERE id=?').get(identifiedApproval.id)?.user_id,
      USER,
    );
    await f.registry.confirm(f.ctx, identifiedApproval.id);
  }
  const audit = f.store.db.prepare("SELECT user_id,status FROM audit WHERE action='form.submit'").all();
  assert.ok(audit.length >= 6);
  assert.ok(audit.every((row) => row.user_id === 'private-submission'));
  assert.ok(audit.some((row) => row.status === 'failure'));
  assert.ok(audit.some((row) => row.status === 'success'));
});

test('Submission privacy is immutable across form mode changes, deletion and recreation', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', {
    ...simpleForm,
    anonymous: true,
    staffRoleId: ROLE,
    maxSubmissionsPerUser: 2,
  });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
    ...draft,
    ready: true,
    answers: { name: 'Anonymous answer' },
  });
  const anonymous = (await f.execute('form.submit', {
    sessionId: draft.id,
    anonymousDisclosureAccepted: true,
  })) as { submitted: string };
  await f.execute('form.create', { ...simpleForm, staffRoleId: ROLE, maxSubmissionsPerUser: 2 });
  assert.equal(
    ((await f.execute('form.response', { submissionId: anonymous.submitted })) as Record<string, unknown>)
      .userId,
    undefined,
  );
  const otherCtx = { ...f.ctx, member: f.other } as unknown as ActionContext;
  const identifiedDraft = startFormSession(f.store, GUILD, OTHER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${identifiedDraft.id}`, {
    ...identifiedDraft,
    ready: true,
    answers: { name: 'Identified answer' },
  });
  const identified = (await f.execute('form.submit', { sessionId: identifiedDraft.id }, otherCtx)) as {
    submitted: string;
  };
  assert.equal(
    ((await f.execute('form.response', { submissionId: identified.submitted })) as Record<string, unknown>)
      .userId,
    OTHER,
  );
  await f.execute('form.delete', { formId: 'apply' });
  assert.equal(
    ((await f.execute('form.response', { submissionId: anonymous.submitted })) as Record<string, unknown>)
      .userId,
    undefined,
  );
  await f.execute('form.create', { ...simpleForm, anonymous: false, staffRoleId: ROLE });
  const exportRows = (await f.execute('form.export', { formId: 'apply' })) as { attachment: Buffer };
  assert.ok(!exportRows.attachment.toString().includes(USER));
  assert.ok(exportRows.attachment.toString().includes(OTHER));
});

test('Anonymous review keeps current-role checks, own erasure and other owners records intact', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', { ...simpleForm, anonymous: true, staffRoleId: ROLE });
  async function submit(userId: string, context: ActionContext) {
    const draft = startFormSession(f.store, GUILD, userId, CHANNEL, 'apply');
    f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
      ...draft,
      ready: true,
      answers: { name: 'Private feedback' },
    });
    return (await f.execute(
      'form.submit',
      { sessionId: draft.id, anonymousDisclosureAccepted: true },
      context,
    )) as { submitted: string };
  }
  const own = await submit(USER, f.ctx),
    otherCtx = { ...f.ctx, member: f.other } as unknown as ActionContext,
    other = await submit(OTHER, otherCtx);
  f.other.permissions = new PermissionsBitField(0n);
  f.other.roles.cache.set(ROLE, f.role as unknown as Role);
  assert.ok(await f.execute('form.response', { submissionId: own.submitted }, otherCtx));
  f.other.roles.cache.clear();
  for (const [action, input] of [
    ['form.response', { submissionId: own.submitted }],
    ['form.responses', { formId: 'apply' }],
    ['form.export', { formId: 'apply' }],
    ['form.review', { submissionId: own.submitted, decision: 'accepted' }],
  ] as const)
    await assert.rejects(f.execute(action, input, otherCtx), /unavailable|restricted/);
  f.store.set('core.disabled', GUILD, ['interfaces']);
  const erase = await f.registry.request(f.ctx, 'form.erase-own', {});
  if (erase.status === 'confirmation') await f.registry.confirm(f.ctx, erase.id);
  assert.equal(f.store.get('ui.submissions', `${GUILD}:${own.submitted}`), undefined);
  assert.ok(f.store.get('ui.submissions', `${GUILD}:${other.submitted}`));
});

test('Identified forms keep ordinary author metadata and anonymous answers are not falsely claimed to hide self-identification', async (t) => {
  const f = fixture(t);
  assert.equal(formDefinitionSchema.parse(simpleForm).anonymous, false);
  await f.execute('form.create', simpleForm);
  let draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, { ...draft, ready: true, answers: { name: 'Alice' } });
  const identified = (await f.execute('form.submit', { sessionId: draft.id })) as { submitted: string };
  const response = (await f.execute('form.response', { submissionId: identified.submitted })) as Record<
    string,
    unknown
  >;
  assert.equal(response.userId, USER);
  assert.deepEqual(response.answers, { name: 'Alice' });
  const exported = (await f.execute('form.export', { formId: 'apply' })) as { attachment: Buffer };
  assert.ok(exported.attachment.toString().includes(USER));
  await f.execute('form.create', { ...simpleForm, id: 'anonymous', anonymous: true });
  draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'anonymous');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
    ...draft,
    ready: true,
    answers: { name: `My Discord ID is ${USER}` },
  });
  const submitted = (await f.execute('form.submit', {
    sessionId: draft.id,
    anonymousDisclosureAccepted: true,
  })) as { submitted: string };
  const voluntary = (await f.execute('form.response', { submissionId: submitted.submitted })) as Record<
    string,
    unknown
  >;
  assert.equal(voluntary.userId, undefined);
  assert.match(JSON.stringify(voluntary.answers), new RegExp(USER));
});

test('File and typed choice fields reject oversized, missing and forged values without advancing the draft', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', {
    ...simpleForm,
    fields: [
      {
        id: 'choice',
        label: 'Pick one',
        kind: 'radio',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
      { id: 'attachment', label: 'Attachment', kind: 'file' },
    ],
  });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  const forged = fake('modal', `ui:formsubmit:${draft.id}:0`, {
    answers: { choice: 'forged', attachment: [] },
  });
  await handleInterfaceInteraction(forged.interaction, f.ctx, f.registry);
  assert.match(getContent(forged.payloads.at(-1)), /Invalid choice/);
  const large = fake('modal', `ui:formsubmit:${draft.id}:0`, {
    answers: {
      choice: 'a',
      attachment: [
        { name: 'large.bin', size: 9 * 1024 * 1024, url: 'https://cdn.discordapp.com/attachments/1/a' },
      ],
    },
  });
  await handleInterfaceInteraction(large.interaction, f.ctx, f.registry);
  assert.match(getContent(large.payloads.at(-1)), /8 MiB/);
  assert.equal(f.store.get<{ step: number }>('ui.drafts', `${GUILD}:${draft.id}`)?.step, 0);
});

test('Role panels are restricted to configured self-service roles and clicks only create common confirmations', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.execute('ui.roles.publish', { channelId: CHANNEL, roleIds: [ROLE] }), /approved/);
  f.store.set('community.settings', GUILD, { selfRoleIds: [ROLE] });
  const panel = (await f.execute('ui.roles.publish', { channelId: CHANNEL, roleIds: [ROLE] })) as {
    id: string;
    messageId: string;
  };
  const click = fake('button', `ui:roles:${panel.id}:${ROLE}`, { messageId: panel.messageId });
  let fetched = false;
  await handleInterfaceInteraction(
    click.interaction,
    async () => {
      assert.equal(click.events[0], 'defer');
      fetched = true;
      return f.ctx;
    },
    f.registry,
    f.store,
  );
  assert.ok(fetched);
  assert.match(getContent(click.payloads.at(-1)), /Awaiting confirmation/);
  assert.equal(f.store.db.prepare('SELECT action FROM confirmations').get()?.action, 'selfrole.add');
  f.role.permissions.add(P.Administrator);
  const pending = String(f.store.db.prepare('SELECT id FROM confirmations').get()?.id);
  await assert.rejects(f.registry.confirm(f.ctx, pending), /privileged|ordinary|permissions/);
});

test('Forged role IDs and copied panel IDs from another message are rejected', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { selfRoleIds: [ROLE] });
  const panel = (await f.execute('ui.roles.publish', { channelId: CHANNEL })) as {
    id: string;
    messageId: string;
  };
  const forged = fake('select', `ui:roles:${panel.id}:select`, {
    values: [OTHER],
    messageId: panel.messageId,
  });
  await handleInterfaceInteraction(forged.interaction, f.ctx, f.registry);
  assert.match(getContent(forged.payloads.at(-1)), /not part/);
  const copied = fake('button', `ui:roles:${panel.id}:${ROLE}`, { messageId: 'another-message' });
  await handleInterfaceInteraction(copied.interaction, f.ctx, f.registry);
  assert.match(getContent(copied.payloads.at(-1)), /unavailable/);
});

test('Ticket panel opens a subject modal before authorization I/O and submits via existing ticket.open', async (t) => {
  const f = fixture(t);
  const panel = (await f.execute('ui.ticket.publish', { channelId: CHANNEL })) as {
    id: string;
    messageId: string;
  };
  const open = fake('button', `ui:ticket:${panel.id}`, { messageId: panel.messageId });
  await handleInterfaceInteraction(
    open.interaction,
    async () => {
      throw new Error('No context call before modal');
    },
    f.registry,
    f.store,
  );
  assert.deepEqual(open.events, ['modal']);
  const submit = fake('modal', `ui:ticket-submit:${panel.id}`, { answers: { subject: 'Need assistance' } });
  await handleInterfaceInteraction(submit.interaction, f.ctx, f.registry);
  assert.equal(f.store.db.prepare('SELECT action FROM confirmations').get()?.action, 'ticket.open');
  assert.equal(f.store.list('community.tickets').length, 0);
});

test('Verification revalidates safe role permissions, membership screening and account age before assignment', async (t) => {
  const f = fixture(t);
  await f.execute('verification.configure', {
    roleId: ROLE,
    rules: 'Read and accept the rules',
    minimumAccountAgeHours: 24,
  });
  let grants = 0;
  f.member.roles.add = async () => {
    grants++;
  };
  f.member.pending = true;
  await assert.rejects(f.execute('verification.complete'), /screening/);
  f.member.pending = false;
  f.member.user.createdTimestamp = Date.now();
  await assert.rejects(f.execute('verification.complete'), /old enough/);
  f.member.user.createdTimestamp = Date.now() - 7 * 86400000;
  f.role.permissions.add(P.ManageGuild);
  await assert.rejects(f.execute('verification.complete'), /without privileged permissions/);
  f.role.permissions.remove(P.ManageGuild);
  f.role.permissions.add(1n << 100n);
  await assert.rejects(f.execute('verification.complete'), /without privileged permissions/);
  f.role.permissions.remove(1n << 100n);
  assert.deepEqual(await f.execute('verification.complete'), { verified: true, roleId: ROLE });
  assert.equal(grants, 1);
});

test('Suggestions keep one vote per actor, conserve concurrent votes and require channel moderation authority', async (t) => {
  const f = fixture(t);
  await f.execute('suggestion.configure', { channelId: CHANNEL });
  const row = (await f.execute('suggestion.submit', { content: 'Please add a project channel' })) as {
    id: string;
    messageId: string;
  };
  await Promise.all([
    f.execute('suggestion.vote', { suggestionId: row.id, vote: 'up' }),
    f.execute('suggestion.vote', { suggestionId: row.id, vote: 'down' }, {
      ...f.ctx,
      member: f.other,
    } as unknown as ActionContext),
  ]);
  await f.execute('suggestion.vote', { suggestionId: row.id, vote: 'down' });
  const saved = f.store.get<{ votes: Record<string, string> }>('ui.suggestions', `${GUILD}:${row.id}`)!;
  assert.deepEqual(saved.votes, { [USER]: 'down', [OTHER]: 'down' });
  const click = fake('button', `ui:suggest:${row.id}:up`, { messageId: row.messageId });
  await handleInterfaceInteraction(click.interaction, f.ctx, f.registry);
  assert.equal(f.store.db.prepare('SELECT action FROM confirmations').get()?.action, 'suggestion.vote');
  await f.execute('suggestion.review', { suggestionId: row.id, decision: 'accepted', note: 'Approved' });
  await assert.rejects(f.execute('suggestion.vote', { suggestionId: row.id, vote: 'up' }), /closed/);
});

test('Suggestion quota reservations prevent concurrent sends from exceeding five per day', async (t) => {
  const f = fixture(t);
  await f.execute('suggestion.configure', { channelId: CHANNEL });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      f.execute('suggestion.submit', { content: `Suggestion number ${i}` }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
  assert.equal(f.sends.length, 5);
});

test('Components V2 announcements build real containers, gallery, thumbnail, links and separators', async (t) => {
  const f = fixture(t);
  await f.execute('ui.message.publish', {
    channelId: CHANNEL,
    text: 'Announcement',
    thumbnail: 'https://cdn.discordapp.com/attachments/1/thumb.png',
    images: ['https://cdn.discordapp.com/attachments/1/image.png'],
    links: [{ label: 'Read more', url: 'https://example.com' }],
  });
  const sent = f.sends[0]!;
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(sent.content, undefined);
  const container = (sent.components as { toJSON(): { type: number; components: unknown[] } }[])[0]!.toJSON();
  assert.equal(container.type, 17);
  assert.ok(container.components.length >= 4);
  await assert.rejects(
    f.execute('ui.message.publish', { channelId: CHANNEL, text: 'Bad', thumbnail: 'https://127.0.0.1/file' }),
    /Discord attachment/,
  );
  await assert.rejects(
    f.execute('ui.message.publish', { channelId: CHANNEL, text: 'SKU', premiumSkuId: ROLE }),
    /SKU must already belong/,
  );
});

test('Private reviewer notifications refuse a channel visible to everyone', async (t) => {
  const f = fixture(t);
  f.channel.permissionsFor = () => new PermissionsBitField(P.Administrator);
  await assert.rejects(f.execute('form.create', { ...simpleForm, reviewChannelId: CHANNEL }), /staff-only/);
  assert.equal(f.store.list('ui.forms').length, 0);
});

test('Feature disable blocks interface clicks; unrelated custom IDs are left for the main router', async (t) => {
  const f = fixture(t);
  const unrelated = fake('button', 'confirm:other');
  assert.equal(await handleInterfaceInteraction(unrelated.interaction, f.ctx, f.registry), false);
  assert.equal(unrelated.events.length, 0);
  f.store.set('core.disabled', GUILD, ['interfaces']);
  const disabled = fake('button', 'ui:settings:missing');
  assert.equal(await handleInterfaceInteraction(disabled.interaction, f.ctx, f.registry), true);
  assert.match(getContent(disabled.payloads.at(-1)), /disabled/);
});

test('Personal form erasure cannot delete another user’s drafts or submitted data', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', simpleForm);
  const own = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply'),
    other = startFormSession(f.store, GUILD, OTHER, CHANNEL, 'apply');
  await f.execute('form.erase-own');
  assert.equal(f.store.get('ui.drafts', `${GUILD}:${own.id}`), undefined);
  assert.ok(f.store.get('ui.drafts', `${GUILD}:${other.id}`));
});

test('Interactive quiz forms grade submitted answers without exposing the answer key in public form listings', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', {
    id: 'quiz',
    title: 'Quiz',
    purpose: 'quiz',
    fields: [
      { id: 'capital', label: 'Capital of Japan?', kind: 'short' },
      { id: 'agree', label: 'Acknowledge', kind: 'checkbox' },
      {
        id: 'choices',
        label: 'Pick both',
        kind: 'checkboxes',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
    ],
    answerKey: { capital: 'Tokyo', agree: true, choices: ['a', 'b'] },
  });
  const publicForms = await f.execute('form.list');
  assert.ok(!JSON.stringify(publicForms).includes('answerKey'));
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'quiz');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, {
    ...draft,
    ready: true,
    answers: { capital: ' tokyo ', agree: true, choices: ['b', 'a'] },
  });
  const result = (await f.execute('form.submit', { sessionId: draft.id })) as { score: unknown };
  assert.deepEqual(result.score, { correct: 3, total: 3 });
  assert.throws(() => formDefinitionSchema.parse({ ...simpleForm, answerKey: { name: 'answer' } }));
});

test('Updating the reviewer role immediately revokes former reviewer access to existing responses', async (t) => {
  const f = fixture(t);
  await f.execute('form.create', { ...simpleForm, staffRoleId: ROLE });
  const draft = startFormSession(f.store, GUILD, USER, CHANNEL, 'apply');
  f.store.set('ui.drafts', `${GUILD}:${draft.id}`, { ...draft, ready: true, answers: { name: 'Private' } });
  const result = (await f.execute('form.submit', { sessionId: draft.id })) as { submitted: string };
  f.other.permissions = new PermissionsBitField(0n);
  f.other.roles.cache.set(ROLE, f.role as unknown as Role);
  const reviewer = { ...f.ctx, member: f.other } as unknown as ActionContext;
  assert.ok(await f.execute('form.response', { submissionId: result.submitted }, reviewer));
  await f.execute('form.create', { ...simpleForm, staffRoleId: null });
  await assert.rejects(
    f.execute('form.response', { submissionId: result.submitted }, reviewer),
    /unavailable/,
  );
});

test('Concurrent suggestion display updates coalesce and finish with the newest authoritative vote counts', async (t) => {
  const f = fixture(t);
  await f.execute('suggestion.configure', { channelId: CHANNEL });
  const row = (await f.execute('suggestion.submit', { content: 'Add a release channel' })) as {
    id: string;
    messageId: string;
  };
  const message = f.messages.get(row.messageId)!;
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const updates: string[] = [];
  let calls = 0;
  message.edit = async (payload: { content: string }) => {
    if (++calls === 1) {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    updates.push(payload.content);
    return message;
  };
  const first = f.execute('suggestion.vote', { suggestionId: row.id, vote: 'up' });
  await entered;
  const second = f.execute('suggestion.vote', { suggestionId: row.id, vote: 'down' }, {
    ...f.ctx,
    member: f.other,
  } as unknown as ActionContext);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.match(updates.at(-1)!, /👍 1 · 👎 1/);
  assert.equal(calls, 2);
});
