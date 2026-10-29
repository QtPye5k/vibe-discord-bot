import { randomInt, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../core/errors.js';
export const activityModes = [
  'game',
  'whiteboard',
  'editor',
  'quiz',
  'learning',
  'tasks',
  'map',
  'simulation',
  'stats',
] as const;
export type ActivityMode = (typeof activityModes)[number];
export interface ActivityParticipant {
  id: string;
  name: string;
  lastSeen: number;
}
export interface ActivityRoom {
  id: string;
  guildId: string;
  channelId: string;
  instanceId: string;
  hostId: string;
  mode: ActivityMode;
  revision: number;
  updatedAt: number;
  participants: ActivityParticipant[];
  board: (string | null)[];
  turn: string;
  winner?: string;
  puzzle: number[];
  text: string;
  strokes: { id: string; authorId: string; color: string; points: number[][] }[];
  tasks: { id: string; authorId: string; title: string; column: 'todo' | 'doing' | 'done' }[];
  markers: { id: string; authorId: string; label: string; x: number; y: number }[];
  quiz: { question: number; answers: Record<string, number>; deadline: number; round: number };
  scores: Record<string, number>;
  simulation: { gravity: number; restitution: number; count: number };
}
const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const activityOperation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mode'), mode: z.enum(activityModes) }),
  z.strictObject({ kind: z.literal('game.move'), cell: z.number().int().min(0).max(8) }),
  z.strictObject({ kind: z.literal('game.reset') }),
  z.strictObject({ kind: z.literal('puzzle.move'), cell: z.number().int().min(0).max(15) }),
  z.strictObject({ kind: z.literal('puzzle.reset') }),
  z.strictObject({
    kind: z.literal('stroke'),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    points: z.array(point).min(2).max(256),
  }),
  z.strictObject({ kind: z.literal('stroke.undo') }),
  z.strictObject({ kind: z.literal('editor'), text: z.string().max(12000) }),
  z.strictObject({ kind: z.literal('task.add'), title: z.string().min(1).max(200) }),
  z.strictObject({
    kind: z.literal('task.move'),
    id: z.string().regex(/^[a-f0-9]{16}$/),
    column: z.enum(['todo', 'doing', 'done']),
  }),
  z.strictObject({
    kind: z.literal('marker'),
    label: z.string().min(1).max(80),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.strictObject({ kind: z.literal('quiz.answer'), answer: z.number().int().min(0).max(3) }),
  z.strictObject({ kind: z.literal('quiz.next') }),
  z.strictObject({
    kind: z.literal('simulation'),
    gravity: z.number().min(0).max(2),
    restitution: z.number().min(0).max(1),
    count: z.number().int().min(1).max(50),
  }),
]);
export const QUESTIONS = [
  {
    question: 'What is 7 × 8?',
    choices: ['54', '56', '64', '48'],
    answer: 1,
    lesson: 'Multiplication can be broken into 7 × (4 + 4): 28 + 28 = 56.',
  },
  {
    question: 'Which planet has prominent rings?',
    choices: ['Mercury', 'Earth', 'Saturn', 'Mars'],
    answer: 2,
    lesson: 'Saturn’s visible rings are made chiefly of countless particles of ice, with rock and dust.',
  },
  {
    question: 'How many sides does a hexagon have?',
    choices: ['5', '6', '7', '8'],
    answer: 1,
    lesson: 'The prefix hexa means six. A regular hexagon has six equal sides and six equal angles.',
  },
  {
    question: 'Which unit measures electrical resistance?',
    choices: ['Volt', 'Watt', 'Ampere', 'Ohm'],
    answer: 3,
    lesson: 'Resistance is measured in ohms; voltage in volts, current in amperes and power in watts.',
  },
  {
    question: 'Which fraction equals 0.25?',
    choices: ['1/4', '1/2', '3/4', '1/5'],
    answer: 0,
    lesson: 'A decimal 25/100 reduces to 1/4 by dividing both numerator and denominator by 25.',
  },
  {
    question: 'Water freezes at what temperature at standard pressure?',
    choices: ['0°C', '10°C', '50°C', '100°C'],
    answer: 0,
    lesson:
      'Pure water freezes at 0°C at standard atmospheric pressure; dissolved substances can lower this temperature.',
  },
];
function puzzle(): number[] {
  const tiles = Array.from({ length: 16 }, (_, index) => (index + 1) % 16);
  let empty = 15;
  for (let i = 0; i < 100; i++) {
    const candidates = [
        empty - 4,
        empty + 4,
        empty % 4 ? empty - 1 : -1,
        empty % 4 !== 3 ? empty + 1 : -1,
      ].filter((index) => index >= 0 && index < 16),
      next = candidates[randomInt(candidates.length)]!;
    [tiles[empty], tiles[next]] = [tiles[next]!, tiles[empty]!];
    empty = next;
  }
  return tiles;
}
export function newActivityRoom(
  input: { id: string; guildId: string; channelId: string; instanceId: string; userId: string; name: string },
  now: number,
): ActivityRoom {
  return {
    id: input.id,
    guildId: input.guildId,
    channelId: input.channelId,
    instanceId: input.instanceId,
    hostId: input.userId,
    mode: 'game',
    revision: 0,
    updatedAt: now,
    participants: [{ id: input.userId, name: input.name, lastSeen: now }],
    board: Array(9).fill(null),
    turn: input.userId,
    puzzle: puzzle(),
    text: '',
    strokes: [],
    tasks: [],
    markers: [],
    quiz: { question: 0, answers: {}, deadline: now + 60000, round: 1 },
    scores: {},
    simulation: { gravity: 0.7, restitution: 0.8, count: 20 },
  };
}
function host(room: ActivityRoom, userId: string) {
  if (room.hostId !== userId) throw new UserError('Only this room’s host can change that shared setting.');
}
export function applyActivityOperation(
  room: ActivityRoom,
  userId: string,
  raw: unknown,
  revision: number,
  now: number,
): ActivityRoom {
  if (room.revision !== revision)
    throw new UserError('The room changed. Refresh before applying this operation.');
  if (!room.participants.some((member) => member.id === userId)) throw new UserError('Join this room first.');
  const input = activityOperation.parse(raw),
    result = structuredClone(room);
  switch (input.kind) {
    case 'mode':
      host(room, userId);
      result.mode = input.mode;
      break;
    case 'game.reset':
      host(room, userId);
      result.board = Array(9).fill(null);
      result.turn = room.participants[0]!.id;
      delete result.winner;
      break;
    case 'game.move': {
      const players = room.participants.slice(0, 2);
      if (players.length < 2) throw new UserError('A second participant must join this game.');
      if (
        room.winner ||
        room.turn !== userId ||
        !players.some((member) => member.id === userId) ||
        room.board[input.cell] !== null
      )
        throw new UserError('This move is unavailable or it is another player’s turn.');
      result.board[input.cell] = userId;
      if (
        [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
          [0, 3, 6],
          [1, 4, 7],
          [2, 5, 8],
          [0, 4, 8],
          [2, 4, 6],
        ].some((line) => line.every((index) => result.board[index] === userId))
      ) {
        result.winner = userId;
        result.scores[userId] = (result.scores[userId] ?? 0) + 1;
      } else if (result.board.every(Boolean)) result.winner = 'draw';
      else result.turn = players.find((member) => member.id !== userId)!.id;
      break;
    }
    case 'puzzle.move': {
      const empty = room.puzzle.indexOf(0),
        cell = input.cell;
      if (Math.abs(Math.floor(cell / 4) - Math.floor(empty / 4)) + Math.abs((cell % 4) - (empty % 4)) !== 1)
        throw new UserError('Choose a tile beside the empty square.');
      [result.puzzle[cell], result.puzzle[empty]] = [0, result.puzzle[cell]!];
      break;
    }
    case 'puzzle.reset':
      host(room, userId);
      result.puzzle = puzzle();
      break;
    case 'stroke':
      if (
        room.strokes.length >= 200 ||
        room.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + input.points.length > 8192
      )
        throw new UserError('Whiteboard limit reached. Undo your earlier strokes.');
      result.strokes.push({
        id: randomBytes(8).toString('hex'),
        authorId: userId,
        color: input.color,
        points: input.points.map((point) => point.map((value) => Math.round(value * 10000) / 10000)),
      });
      break;
    case 'stroke.undo': {
      const index = result.strokes.findLastIndex((stroke) => stroke.authorId === userId);
      if (index >= 0) result.strokes.splice(index, 1);
      break;
    }
    case 'editor':
      result.text = input.text;
      break;
    case 'task.add':
      if (room.tasks.length >= 100) throw new UserError('Task limit reached.');
      result.tasks.push({
        id: randomBytes(8).toString('hex'),
        authorId: userId,
        title: input.title,
        column: 'todo',
      });
      break;
    case 'task.move': {
      const task = result.tasks.find((task) => task.id === input.id);
      if (!task) throw new UserError('Task is unavailable.');
      task.column = input.column;
      break;
    }
    case 'marker':
      if (room.markers.length >= 100) throw new UserError('Map marker limit reached.');
      result.markers.push({
        id: randomBytes(8).toString('hex'),
        authorId: userId,
        label: input.label,
        x: input.x,
        y: input.y,
      });
      break;
    case 'quiz.answer': {
      if (now >= room.quiz.deadline || room.quiz.answers[userId] !== undefined)
        throw new UserError('This round ended or you already answered.');
      result.quiz.answers[userId] = input.answer;
      if (input.answer === QUESTIONS[room.quiz.question]!.answer)
        result.scores[userId] = (result.scores[userId] ?? 0) + 1;
      break;
    }
    case 'quiz.next':
      host(room, userId);
      result.quiz = {
        question: (room.quiz.question + 1) % QUESTIONS.length,
        answers: {},
        deadline: now + 60000,
        round: room.quiz.round + 1,
      };
      break;
    case 'simulation':
      host(room, userId);
      result.simulation = { gravity: input.gravity, restitution: input.restitution, count: input.count };
      break;
  }
  const scoreIds = Object.keys(result.scores);
  if (scoreIds.length > 250) {
    const active = new Set(result.participants.map((member) => member.id));
    for (const id of scoreIds.filter((id) => !active.has(id)).slice(0, scoreIds.length - 250))
      delete result.scores[id];
  }
  result.revision++;
  result.updatedAt = now;
  return result;
}
export function publicActivityRoom(room: ActivityRoom, userId: string, now: number) {
  const question = QUESTIONS[room.quiz.question]!,
    ended = room.quiz.deadline <= now;
  return {
    ...room,
    quiz: {
      question: question.question,
      choices: question.choices,
      deadline: room.quiz.deadline,
      round: room.quiz.round,
      answered: room.quiz.answers[userId] !== undefined,
      answerCount: Object.keys(room.quiz.answers).length,
      ...(ended ? { answer: question.answer } : {}),
      ...(room.mode === 'learning' ? { lesson: question.lesson } : {}),
    },
  };
}
