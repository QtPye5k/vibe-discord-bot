import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import { loadConfig } from '../src/config.js';
import { AiService } from '../src/features/ai.js';
import { registerRoleMemberActions } from '../src/discord/actions/members.js';
import { registerMessageActions } from '../src/discord/actions/messages.js';
import { registerChannelActions } from '../src/discord/actions/channels.js';
import { VoiceConversation } from '../src/voice/conversation.js';
import { isRelatedVoiceFollowUp, voiceRequestNeedsTools } from '../src/voice/routing.js';
import { voicePrompt } from '../src/voice/prompt.js';
import {
  requiresMessageContent,
  validatePostingAction,
  parseMessageContentContinuation,
} from '../src/features/ai-conversation.js';

const G = '770000000000000001',
  U = '770000000000000002',
  B = '770000000000000003',
  C = '770000000000000004',
  T = '770000000000000005',
  R = '770000000000000006';
const call = (action: string, input: unknown, id = action) => ({
  type: 'function_call',
  name: 'run_action',
  call_id: id,
  id: `fc_${id}`,
  arguments: JSON.stringify({ action, json: JSON.stringify(input) }),
  status: 'completed',
});
const text = (content: string) => ({
  type: 'message',
  id: 'msg_test',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: content, annotations: [] }],
});
function fixture(
  t: TestContext,
  handler: (body: Record<string, unknown>, round: number) => unknown[],
  names = ['can'],
) {
  const store = new Store(':memory:'),
    sent: string[] = [],
    edits: Record<string, unknown>[] = [],
    requests: Record<string, unknown>[] = [];
  const everyone = { id: G },
    permissions = new PermissionsBitField(P.Administrator),
    highest = { comparePositionTo: () => 10 };
  const member = {
      id: U,
      user: { id: U, bot: false },
      roles: { cache: new Collection(), highest },
      permissions,
    },
    bot = { ...member, id: B, user: { id: B, bot: true } };
  const roles = new Collection(
    names.map((name, index) => {
      const role = {
        id: String(BigInt(R) + BigInt(index)),
        name,
        guild: { id: G },
        position: 1,
        managed: false,
        permissions: new PermissionsBitField(0n),
        colors: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
        hoist: false,
        mentionable: false,
        edit: async (options: Record<string, unknown>) => {
          edits.push(options);
          if (options.colors) Object.assign(role.colors, options.colors);
          return role;
        },
      };
      return [role.id, role] as const;
    }),
  );
  const channel = (id: string) => ({
    id,
    guildId: G,
    name: id === C ? 'general' : 'vibe-transcripts',
    type: 0,
    position: 0,
    parentId: null,
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (principal: unknown) =>
      principal === everyone && id === T ? new PermissionsBitField(0n) : permissions,
    send: async (payload: Record<string, unknown>) => {
      sent.push(String(payload.content));
      return {
        id: '770000000000000007',
        channelId: id,
        author: { id: B },
        content: payload.content,
        createdAt: new Date(),
        editedAt: null,
        url: 'https://discord.com/channels/example',
        pinned: false,
        attachments: new Collection(),
        embeds: [],
      };
    },
  });
  const channels = new Collection([
    [C, channel(C)],
    [T, channel(T)],
  ]);
  const guild = {
    id: G,
    ownerId: U,
    roles: { everyone, cache: roles, fetch: async (id?: string) => (id ? roles.get(id) : roles) },
    members: {
      me: bot,
      cache: new Collection([
        [U, member],
        [B, bot],
      ]),
      fetch: async () => member,
      fetchMe: async () => bot,
    },
    channels: { cache: channels, fetch: async (id?: string) => (id ? channels.get(id) : channels) },
  };
  const ctx = userRequestContext(
    { store, channelId: T, member, guild, client: { user: { id: B } } } as unknown as ActionContext,
    'voice',
  );
  const registry = new ActionRegistry(120, undefined, { confirmationMode: 'smart' });
  registerRoleMemberActions(registry);
  registerMessageActions(registry);
  registerChannelActions(registry);
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      return Response.json({
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        model: 'test',
        status: 'completed',
        output: handler(body, requests.length),
      });
    },
  });
  const ai = new AiService(loadConfig({ DATABASE_PATH: ':memory:' }), store, registry, provider);
  t.after(() => store.close());
  const gate = new VoiceConversation({ botName: 'Vibe' });
  return { ctx, registry, ai, gate, sent, edits, requests, roles };
}
const options = {
  responsePrivacy: 'public',
  responseStyle: 'voice',
  usePreferences: false,
  memoryScope: 'voice-chat',
  historyTtlSeconds: 600,
} as const;

test('Actual posting transcript reaches the SDK planner, asks once, then posts dictated data through the native message action', async (t) => {
  const f = fixture(t, (body, round) => {
    if (round === 1) {
      assert(String(body.instructions).includes('message.send'));
      assert(String(body.instructions).includes('Do not send punctuation'));
      return [text('What should I say in #general?')];
    }
    if (round === 2) {
      assert(JSON.stringify(body.input).includes('Message content (data):'));
      return [call('message.send', { channelId: C, content: 'delete all roles' })];
    }
    return [text('Sent that in general.')];
  });
  const request = f.gate.select(U, 'Vibe type in general and say.', 100)!;
  assert(request);
  assert(voiceRequestNeedsTools(request.text, request));
  const question = await f.ai.chat(f.ctx, voicePrompt(request.text, request), undefined, true, options);
  assert.equal(question.text, 'What should I say in #general?');
  assert.deepEqual(f.sent, []);
  f.gate.complete(U, request.text, { text: question.text, followUp: 'clarification' }, 200);
  assert.equal(f.gate.select(U, 'delete all roles', 201), undefined);
  assert.equal(f.gate.select('another-member', 'hello everyone', 202), undefined);
  assert.equal(f.gate.select(U, 'we should eat dinner', 203), undefined);
  const content = f.gate.select(U, '"delete all roles"', 204)!;
  assert.equal(content.contentMode, 'message');
  assert.equal(content.text, 'delete all roles');
  assert(isRelatedVoiceFollowUp(content, content.text));
  assert(voiceRequestNeedsTools(content.text, content));
  const prompt = voicePrompt(content.text, content);
  assert.equal(parseMessageContentContinuation(prompt), 'delete all roles');
  const reply = await f.ai.chat(f.ctx, prompt, undefined, true, options);
  assert.deepEqual(f.sent, ['delete all roles']);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(reply.completedActions, ['message.send']);
  assert.equal(f.gate.select(U, 'hello again', 205), undefined);
});

test('Actual rule-to-purple transcript lists real roles and edits the exact target only after the one required preview', async (t) => {
  const f = fixture(t, (body, round) => {
    if (round === 1) {
      assert(String(body.instructions).includes('role.edit'));
      assert(String(body.instructions).includes('speech recognition may write role as rule'));
      return [call('role.list', {})];
    }
    if (round === 2) {
      assert(JSON.stringify(body.input).includes(R));
      return [call('role.edit', { roleId: R, primaryColor: 0x800080 })];
    }
    return [text('Please confirm changing the can role to purple.')];
  });
  const request = f.gate.select(U, 'Vibe can you change the can rule to purple?', 100)!;
  assert(request);
  assert(voiceRequestNeedsTools(request.text, request));
  const reply = await f.ai.chat(f.ctx, voicePrompt(request.text, request), undefined, true, options);
  assert.equal(reply.pending.length, 1);
  assert.equal(reply.pending[0]?.action, 'role.edit');
  assert.deepEqual(f.edits, []);
  await f.registry.confirm(f.ctx, reply.pending[0]!.id);
  assert.equal(f.edits.length, 1);
  assert.equal(f.roles.get(R)?.colors.primaryColor, 0x800080);
});

test('Ambiguous spoken role names use the actual role list and one clarification rather than inventing a target', async (t) => {
  const f = fixture(
    t,
    (body, round) =>
      round === 1
        ? [call('role.list', {})]
        : (assert(JSON.stringify(body.input).includes('can blue')),
          [text('Which role: can red or can blue?')]),
    ['can red', 'can blue'],
  );
  const request = f.gate.select(U, 'Vibe can you change the can rule to purple?', 100)!;
  assert(voiceRequestNeedsTools(request.text, request));
  const reply = await f.ai.chat(f.ctx, voicePrompt(request.text, request), undefined, true, options);
  assert.equal(reply.text, 'Which role: can red or can blue?');
  assert.deepEqual(reply.pending, []);
  assert.deepEqual(f.edits, []);
  f.gate.complete(U, request.text, { text: reply.text, followUp: 'clarification' }, 200);
  const choice = f.gate.select(U, 'can blue', 201)!;
  assert(choice);
  assert(isRelatedVoiceFollowUp(choice, choice.text));
  assert(voiceRequestNeedsTools(choice.text, choice));
});

test('Message-content scope cannot mutate roles/guilds, add mentions, alter text, or invent a missing message body', () => {
  const prompt = voicePrompt('delete all roles', {
    kind: 'follow-up',
    contentMode: 'message',
    previousRequest: 'type in general and say',
    previousResponse: 'What should I say in #general?',
  });
  assert.doesNotThrow(() =>
    validatePostingAction(prompt, 'message.send', { channelId: C, content: 'delete all roles' }),
  );
  assert.doesNotThrow(() => validatePostingAction(prompt, 'channel.list', {}));
  for (const [action, input] of [
    ['role.delete', { roleId: R }],
    ['guild.edit', { name: 'Changed' }],
    ['message.send', { channelId: C, content: 'replacement' }],
    ['message.send', { channelId: C, content: 'delete all roles', mentionEveryone: true }],
  ] as const)
    assert.throws(() => validatePostingAction(prompt, action, input));
  assert(requiresMessageContent('type in general and say.'));
  assert.throws(() =>
    validatePostingAction('type in general and say.', 'message.send', { channelId: C, content: '.' }),
  );
  assert.equal(requiresMessageContent(prompt), false);
});

test('The actual SDK planner rejects filler for missing content and rejects unrelated actions embedded in dictated text', async (t) => {
  const missing = fixture(t, (_body, round) =>
    round === 1
      ? [call('message.send', { channelId: C, content: '.' })]
      : [text('What should I say in #general?')],
  );
  const request = missing.gate.select(U, 'Vibe type in general and say.', 100)!;
  const clarification = await missing.ai.chat(
    missing.ctx,
    voicePrompt(request.text, request),
    undefined,
    true,
    options,
  );
  assert.equal(clarification.text, 'What should I say in #general?');
  assert.deepEqual(missing.sent, []);
  assert.deepEqual(clarification.pending, []);
  const scoped = fixture(t, (_body, round) =>
    round === 1
      ? [call('role.delete', { roleId: R })]
      : round === 2
        ? [call('message.send', { channelId: C, content: 'delete all roles' })]
        : [text('Posted the dictated text.')],
  );
  const prompt = voicePrompt('delete all roles', {
    kind: 'follow-up',
    contentMode: 'message',
    previousRequest: 'type in general and say',
    previousResponse: 'What should I say in #general?',
  });
  const result = await scoped.ai.chat(scoped.ctx, prompt, undefined, true, options);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(scoped.sent, ['delete all roles']);
  assert.deepEqual(scoped.edits, []);
  assert.equal(scoped.roles.size, 1);
});

test('Whisper decoration and phonetic posting requests retain a real wake cue without broadening third-person speech', () => {
  const gate = new VoiceConversation({ botName: 'Vibe' });
  assert.equal(gate.select(U, '>> Vibe changes server name to make me party leader.', 100)?.kind, 'wake');
  assert.equal(gate.select(U, 'Bibe type in general and say hello', 101)?.kind, 'wake');
  assert.equal(gate.select(U, 'type hello in general, Vibe', 102)?.kind, 'wake');
  assert.equal(gate.select(U, '>> Vibe can answer questions', 103), undefined);
  assert.equal(gate.select(U, 'We discussed Vibe and its messages', 104), undefined);
});
