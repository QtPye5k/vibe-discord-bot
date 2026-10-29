import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceConversation, type VoiceTurnMeta } from '../src/voice/conversation.js';
import { isRelatedVoiceFollowUp, voiceRequestNeedsTools } from '../src/voice/routing.js';

const turn = (previousRequest: string, previousResponse: string): VoiceTurnMeta => ({
  kind: 'follow-up',
  previousRequest,
  previousResponse,
});
const serverName = turn('change the server name to W', 'Rename the server to capital W. Please confirm.');
const event = turn(
  'create an event for playing Roblox',
  'What time, timezone and duration? Which voice channel and who can attend?',
);
const science = turn('explain how a rainbow works', 'Light bends and separates into colors in raindrops.');

test('Capability questions use the bot planner while an explicit request to talk keeps the quick conversational renderer', () => {
  for (const text of ['What can you do?', 'How can you help?', 'Explain your abilities.'])
    assert.equal(voiceRequestNeedsTools(text, { kind: 'wake' }), true, text);
  for (const text of ['Can you talk to me?', 'Chat with me.'])
    assert.equal(voiceRequestNeedsTools(text, { kind: 'wake' }), false, text);
});

test('voice routing sends state, lookup, scheduling and media requests to tools', () => {
  for (const request of [
    'change the server name to W',
    'create an event for nine tonight playing Roblox',
    'who is in the voice channel',
    'make a role for my friends',
    'give Taylor administrator permissions',
    'delete the old messages',
    'ban that person',
    'mute Taylor',
    'pin this',
    'send hello to Taylor',
    'schedule the meeting',
    'remind me in five minutes',
    'set a timer for thirty seconds',
    'find a good restaurant',
    'look up the documentation',
    'search for Roblox updates',
    'open this website',
    'what is the weather in Boston',
    'give me the latest news',
    'what is the current time',
    'what are today’s games',
    'what is the price of gold',
    'play my favorite song',
    'pause it',
    'skip this track',
    'lower the volume',
    'find a Spotify playlist',
    'generate an image of a dog',
    'make a meme',
    'export my settings to a file',
    'what are my preferences',
    'what are your capabilities',
    'type in general and say',
    'write hello into general',
    'say hello in #general',
    'can you change the can rule to purple',
    'delete my story',
    'could you toggle it',
  ])
    assert.equal(voiceRequestNeedsTools(request, { kind: 'wake' }), true, request);
});

test('voice routing keeps ordinary conversation on Realtime', () => {
  for (const request of [
    'hello',
    'how are you',
    'what is up',
    'tell me something interesting',
    'explain how a rainbow works',
    'why is the sky blue',
    'what is a black hole',
    'what is electrical current',
    'write a short poem',
    'tell me a story about a dragon',
    'help me think through a problem',
    'your voice sounds good',
    'thank you',
    '',
  ])
    assert.equal(voiceRequestNeedsTools(request, { kind: 'wake' }), false, request);
});

test('an explicit wake name accepts a new subject while follow-ups require context', () => {
  assert.equal(isRelatedVoiceFollowUp({ kind: 'wake' }, 'what about dinner'), true);
  assert.equal(isRelatedVoiceFollowUp({ kind: 'follow-up' }, 'confirm'), false);
  assert.equal(isRelatedVoiceFollowUp(turn('called your name', 'Yes?'), 'what about dinner'), true);
  assert.equal(isRelatedVoiceFollowUp(event, ''), false);
  assert.equal(isRelatedVoiceFollowUp(event, 'a'.repeat(301)), false);
});

test('natural confirmations retain tools and never need an extra classifier', () => {
  for (const request of ['confirm', 'confirm the capitalized W', 'yes', 'go ahead', 'do it', 'cancel that']) {
    assert.equal(isRelatedVoiceFollowUp(serverName, request), true, request);
    assert.equal(voiceRequestNeedsTools(request, serverName), true, request);
  }
  assert.equal(isRelatedVoiceFollowUp(science, 'yes'), false);
  assert.equal(isRelatedVoiceFollowUp(science, 'confirm'), false);
});

test('anaphoric conversation uses its previous topic and only inherits tools when needed', () => {
  for (const request of [
    'tell me more',
    'explain that',
    'please repeat the last answer',
    'can you clarify that',
    'say that again',
    'how does it work',
    'who is that',
    'what does that mean',
    'why is that',
    'why',
  ]) {
    assert.equal(isRelatedVoiceFollowUp(science, request), true, request);
    assert.equal(voiceRequestNeedsTools(request, science), false, request);
    assert.equal(isRelatedVoiceFollowUp(event, request), true, request);
    assert.equal(voiceRequestNeedsTools(request, event), true, request);
  }
});

test('ambient topic changes cannot become a new tool request or conversation', () => {
  for (const request of [
    'what about dinner',
    'tell me more about dinner',
    'explain quantum physics',
    'what about the restaurant around the corner',
    'actually we should get dinner',
    'I think Roblox is boring',
    'we should play Roblox later',
    'search for restaurants',
    'delete all roles',
    'today I went to get dinner',
    'my dinner is at 9',
  ]) {
    assert.equal(isRelatedVoiceFollowUp(event, request), false, request);
    assert.equal(voiceRequestNeedsTools(request, event), false, request);
  }
});

test('event and object follow-ups must share the topic or supply a requested field', () => {
  for (const request of [
    'what about the event',
    'tell me more about Roblox',
    'what about tomorrow',
    'what about 9pm',
    'today, est, 9pm, 2 hours, vc, publix, everyone',
    'at nine tonight',
    '2 hours',
    'everyone',
    'the first one',
    'make it tomorrow',
    'change it to nine tonight',
  ]) {
    assert.equal(isRelatedVoiceFollowUp(event, request), true, request);
    assert.equal(voiceRequestNeedsTools(request, event), true, request);
  }
});

test('short clarification values are scoped to the actual question', () => {
  const name = turn('rename the server', 'What name should I use?');
  const channel = turn('create an event', 'Which voice channel?');
  const audience = turn('create an event', 'Should it be public or private?');
  const choice = turn('choose a color for my poem', 'Which option: red or blue?');
  for (const value of ['W', 'capital W', 'The Hangout']) {
    assert.equal(isRelatedVoiceFollowUp(name, value), true, value);
    assert.equal(voiceRequestNeedsTools(value, name), true, value);
  }
  for (const value of ['general', '#lounge', 'vc'])
    assert.equal(isRelatedVoiceFollowUp(channel, value), true, value);
  for (const value of ['public', 'private', 'everyone'])
    assert.equal(isRelatedVoiceFollowUp(audience, value), true, value);
  for (const value of ['blue', 'the second one']) {
    assert.equal(isRelatedVoiceFollowUp(choice, value), true, value);
    assert.equal(voiceRequestNeedsTools(value, choice), false, value);
  }
  for (const value of ['what about dinner', 'delete all channels', 'search restaurants', 'we should eat'])
    assert.equal(isRelatedVoiceFollowUp(name, value), false, value);
  assert.equal(isRelatedVoiceFollowUp(science, 'W'), false);
});

test('admitted conversational attention permits a new subject while preserving task continuation routing', () => {
  const conversation = new VoiceConversation({ followUpSeconds: 20 });
  conversation.complete(
    'alice',
    event.previousRequest!,
    { text: event.previousResponse!, followUp: 'clarification' },
    100,
  );
  const candidate = conversation.select('alice', 'what about dinner', 200);
  assert(candidate);
  assert.equal(candidate.attention, 'conversation');
  assert.equal(isRelatedVoiceFollowUp(candidate, candidate.text), true);
  assert.equal(voiceRequestNeedsTools(candidate.text, candidate), false);

  conversation.complete(
    'alice',
    serverName.previousRequest!,
    { text: serverName.previousResponse!, followUp: 'confirmation' },
    300,
  );
  const confirmation = conversation.select('alice', 'confirm the capitalized W', 400);
  assert(confirmation);
  assert.equal(isRelatedVoiceFollowUp(confirmation, confirmation.text), true);
  assert.equal(voiceRequestNeedsTools(confirmation.text, confirmation), true);
});
