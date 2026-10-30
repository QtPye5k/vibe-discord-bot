import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatCommand } from '../src/discord/chat-commands.js';

test('Mention alternatives cover exact slash utility commands without an AI request', () => {
  const mappings = {
    status: 'system.status',
    forget: 'ai.memory.forget',
    join: 'voice.join',
    leave: 'voice.leave',
    stop: 'voice.stop',
    revoke: 'voice.consent',
    balance: 'economy.balance',
    daily: 'economy.daily',
  };
  for (const [command, action] of Object.entries(mappings)) {
    assert.equal(parseChatCommand(command)?.kind, 'action');
    assert.equal((parseChatCommand(`/${command}`) as { action: string }).action, action);
  }
  assert.deepEqual(parseChatCommand('help roles'), { kind: 'help', query: 'roles' });
  assert.deepEqual(parseChatCommand('schema role.edit'), { kind: 'schema', action: 'role.edit' });
  assert.deepEqual(parseChatCommand('revoke'), {
    kind: 'action',
    action: 'voice.consent',
    input: { enabled: false, replies: false },
  });
});

test('Parameterized slash alternatives preserve user data and typed registry inputs', () => {
  assert.deepEqual(parseChatCommand('action message.send {"content":"hello"}'), {
    kind: 'action',
    action: 'message.send',
    input: { content: 'hello' },
  });
  assert.deepEqual(parseChatCommand('speak hello everyone'), {
    kind: 'action',
    action: 'voice.speak',
    input: { text: 'hello everyone' },
  });
  assert.deepEqual(parseChatCommand('consent commands'), {
    kind: 'action',
    action: 'voice.consent',
    input: { enabled: true, replies: false },
  });
  assert.deepEqual(parseChatCommand('ticket Need help'), {
    kind: 'action',
    action: 'ticket.open',
    input: { subject: 'Need help' },
  });
  assert.deepEqual(parseChatCommand('report <@11111111111111111> a problem'), {
    kind: 'action',
    action: 'report.submit',
    input: { userId: '11111111111111111', reason: 'a problem' },
  });
  const reminder = parseChatCommand('remind me in 5 minutes drink water');
  assert.equal(reminder?.kind, 'action');
  const data = (reminder as { input: { dueAt: string; content: string } }).input;
  assert.equal(data.content, 'drink water');
  assert(Math.abs(Date.parse(data.dueAt) - Date.now() - 300000) < 1000);
});

test('Other natural language remains available to the assistant and malformed exact inputs fail', () => {
  assert.equal(parseChatCommand('Could you create a purple role?'), undefined);
  assert.throws(() => parseChatCommand('action guild.edit {broken}'));
  assert.throws(() => parseChatCommand('remind me in 0 minutes do it'));
});
