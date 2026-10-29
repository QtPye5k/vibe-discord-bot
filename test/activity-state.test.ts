import test from 'node:test';
import assert from 'node:assert/strict';
import { newActivityRoom, applyActivityOperation, publicActivityRoom } from '../src/activities/state.js';
const room = () => {
  const value = newActivityRoom(
    {
      id: 'room',
      guildId: 'guild',
      channelId: 'voice',
      instanceId: 'instance',
      userId: 'alice',
      name: 'Alice',
    },
    100,
  );
  value.participants.push({ id: 'bob', name: 'Bob', lastSeen: 100 });
  return value;
};
test('Multiplayer game enforces participant turns, stale revisions and one terminal score', () => {
  let game = room();
  assert.throws(() => applyActivityOperation(game, 'bob', { kind: 'game.move', cell: 0 }, 0, 200), /turn/);
  for (const [user, cell] of [
    ['alice', 0],
    ['bob', 3],
    ['alice', 1],
    ['bob', 4],
    ['alice', 2],
  ] as const)
    game = applyActivityOperation(game, user, { kind: 'game.move', cell }, game.revision, 200);
  assert.equal(game.winner, 'alice');
  assert.equal(game.scores.alice, 1);
  assert.throws(
    () => applyActivityOperation(game, 'alice', { kind: 'game.move', cell: 8 }, 0, 200),
    /changed/,
  );
  assert.throws(
    () => applyActivityOperation(game, 'bob', { kind: 'game.move', cell: 8 }, game.revision, 200),
    /unavailable/,
  );
});
test('Collaborative editor uses compare-and-swap, whiteboard undo preserves other authors, and host settings remain controlled', () => {
  let state = room();
  state = applyActivityOperation(state, 'bob', { kind: 'editor', text: 'Shared draft' }, 0, 200);
  assert.equal(state.text, 'Shared draft');
  assert.throws(
    () => applyActivityOperation(state, 'alice', { kind: 'editor', text: 'Lost edit' }, 0, 200),
    /changed/,
  );
  state = applyActivityOperation(
    state,
    'alice',
    {
      kind: 'stroke',
      color: '#ffffff',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    state.revision,
    200,
  );
  state = applyActivityOperation(
    state,
    'bob',
    {
      kind: 'stroke',
      color: '#000000',
      points: [
        [0, 1],
        [1, 0],
      ],
    },
    state.revision,
    200,
  );
  state = applyActivityOperation(state, 'alice', { kind: 'stroke.undo' }, state.revision, 200);
  assert.deepEqual(
    state.strokes.map((stroke) => stroke.authorId),
    ['bob'],
  );
  assert.throws(
    () => applyActivityOperation(state, 'bob', { kind: 'mode', mode: 'map' }, state.revision, 200),
    /host/,
  );
});
test('Quiz state hides answers, scores once and reveals completed answers only after its deadline', () => {
  let state = room();
  assert.equal('answer' in publicActivityRoom(state, 'bob', 200).quiz, false);
  assert.equal('answers' in publicActivityRoom(state, 'bob', 200).quiz, false);
  state = applyActivityOperation(state, 'bob', { kind: 'quiz.answer', answer: 1 }, 0, 200);
  assert.equal(state.scores.bob, 1);
  assert.throws(
    () => applyActivityOperation(state, 'bob', { kind: 'quiz.answer', answer: 1 }, 1, 200),
    /already/,
  );
  assert.equal(publicActivityRoom(state, 'bob', 100000).quiz.answer, 1);
});
test('Puzzles preserve all tiles and permit only adjacent moves; productivity, maps and simulations change real shared state', () => {
  let state = room();
  assert.deepEqual(
    [...state.puzzle].sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, index) => index),
  );
  const empty = state.puzzle.indexOf(0),
    cell = empty >= 4 ? empty - 4 : empty + 4;
  state = applyActivityOperation(state, 'alice', { kind: 'puzzle.move', cell }, 0, 200);
  assert.equal(state.puzzle[cell], 0);
  state = applyActivityOperation(
    state,
    'bob',
    { kind: 'task.add', title: 'Prepare agenda' },
    state.revision,
    200,
  );
  state = applyActivityOperation(
    state,
    'alice',
    { kind: 'task.move', id: state.tasks[0]!.id, column: 'done' },
    state.revision,
    200,
  );
  assert.equal(state.tasks[0]!.column, 'done');
  state = applyActivityOperation(
    state,
    'bob',
    { kind: 'marker', label: 'Meeting point', x: 0.2, y: 0.5 },
    state.revision,
    200,
  );
  assert.equal(state.markers[0]!.label, 'Meeting point');
  state = applyActivityOperation(
    state,
    'alice',
    { kind: 'simulation', gravity: 1, restitution: 0.5, count: 12 },
    state.revision,
    200,
  );
  assert.equal(state.simulation.count, 12);
});
test('Scoring retention stays bounded while preserving current participants', () => {
  const state = room();
  state.scores.alice = 5;
  state.scores.bob = 3;
  for (let i = 0; i < 260; i++) state.scores[`former-${i}`] = i;
  const updated = applyActivityOperation(state, 'alice', { kind: 'mode', mode: 'stats' }, 0, 200);
  assert.equal(Object.keys(updated.scores).length, 250);
  assert.equal(updated.scores.alice, 5);
  assert.equal(updated.scores.bob, 3);
});
