import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTranscription } from '../src/voice/transcript-filter.js';
import { acousticVoiceActivity } from '../src/voice/recordings.js';

test('Pure known non-speech markers and repeated marker sequences are discarded', () => {
  for (const text of [
    '[BLANK_AUDIO]',
    '[BLANK_AUDIO] [BLANK_AUDIO] [BLANK_AUDIO]',
    ' [BLANK_AUDIO]\n[blank audio]. ',
    '[NO_SPEECH]',
    '<|nospeech|>',
    '<|endoftext|>',
    '[shh]',
    '(blows kiss)',
    '(blows a kiss)',
    '[breathing]',
    '[coughing]',
    '[music] ... (laughter) — [shh]!',
    '［ＢＬＡＮＫ＿ＡＵＤＩＯ］',
  ])
    assert.equal(filterTranscription(text), '', text);
});
test('Short commands, wake names and ordinary spoken words are preserved', () => {
  for (const text of [
    'Vibe',
    'Vibe, join',
    'confirm',
    'yes',
    'no',
    'stop',
    'cancel',
    'help',
    'shh',
    'music',
    'blows kiss',
    'hmm',
    'Hi.',
    'Vibe, can you hear me?',
    'Vibe, stop the music',
  ])
    assert.equal(filterTranscription(text), text, text);
});
test('Quoted labels, unknown bracketed speech and annotations embedded in genuine words remain intact', () => {
  for (const text of [
    'Say "[BLANK_AUDIO]" exactly',
    '"[BLANK_AUDIO]"',
    '[Vibe] join',
    '[confirm]',
    'Vibe [shh] stop',
    '(blows kiss) Vibe, hello',
    '[BLANK_AUDIO] yes',
    'I heard [music] in the room',
    'Explain (silence) in that poem',
    '[unknown sound]',
    'The code is BLANK_AUDIO',
  ])
    assert.equal(filterTranscription(text), text, text);
  assert.equal(filterTranscription('  Vibe, join  '), 'Vibe, join');
});
test('A long marker-only result is filtered before a caller can truncate through its final marker', () => {
  assert.equal(filterTranscription('[BLANK_AUDIO] '.repeat(400)), '');
});
test('Zero-energy PCM is unambiguously silent, while the optional energy threshold can reject quiet nonzero audio', () => {
  const zero = acousticVoiceActivity(Buffer.alloc(48000 * 4));
  assert.equal(zero.peak, 0);
  assert.equal(zero.active, false);
  const quiet = Buffer.alloc(48000 * 4);
  for (let frame = 0; frame < 48000; frame++) {
    const value = Math.round(100 * Math.sin((2 * Math.PI * 220 * frame) / 48000));
    quiet.writeInt16LE(value, frame * 4);
    quiet.writeInt16LE(value, frame * 4 + 2);
  }
  const activity = acousticVoiceActivity(quiet);
  assert.equal(activity.peak, 100);
  assert.equal(activity.active, false);
  assert(activity.rmsDb < -50 && activity.rmsDb > -55);
});
