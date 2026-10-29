import { DiscordSDK } from '@discord/embedded-app-sdk';
import './activity.css';

const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent),
  app = document.getElementById('app');
let sdk,
  token = '',
  room,
  userId = '',
  busy = false,
  epoch = 0,
  lastRevision = -1,
  currentMode = '',
  animation = 0,
  draft = '',
  dirty = false;
let canvasZoom = 1,
  panX = 0,
  panY = 0,
  drawingActive = false,
  taskDraft = '',
  markerDraft = 'Meeting point';
const modes = {
  game: 'Games',
  whiteboard: 'Whiteboard',
  editor: 'Shared editor',
  quiz: 'Quiz',
  learning: 'Learn',
  tasks: 'Task board',
  map: 'Coordinate map',
  simulation: 'Simulation',
  stats: 'Room statistics',
};
function element(tag, text, classes) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (classes) node.className = classes;
  return node;
}
function button(text, action, disabled = false) {
  const node = element('button', text);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
function message(text, error = false) {
  const node = document.getElementById('notice');
  if (node) {
    node.textContent = text;
    node.className = error ? 'notice error' : 'notice';
    node.hidden = !text;
  }
}
function applyAppearance(value = {}) {
  for (const [name, key] of [
    ['--background', 'background'],
    ['--foreground', 'foreground'],
    ['--accent', 'accent'],
  ]) {
    const color = value.theme?.[key];
    if (/^#[0-9a-fA-F]{6}$/.test(color || '')) document.documentElement.style.setProperty(name, color);
    else document.documentElement.style.removeProperty(name);
  }
  document.body.classList.toggle('compact', value.interface?.compact === true);
}
function signedOut(text) {
  applyAppearance();
  epoch++;
  token = '';
  room = undefined;
  cancelAnimationFrame(animation);
  app.replaceChildren(element('h1', 'Activity session ended'), element('p', text));
}
async function api(route, input = {}) {
  const start = epoch,
    response = await fetch('/activity/api/' + route, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(input),
      cache: 'no-store',
    });
  const result = await response.json();
  if (start !== epoch) throw new Error('A former session response was discarded.');
  if (!response.ok) {
    if (response.status === 401) signedOut(result.error || 'Relaunch the Activity in Discord.');
    throw new Error(result.error || 'Request failed. Verify the room before retrying.');
  }
  return result;
}
async function send(operation) {
  if (busy || !room) return;
  busy = true;
  try {
    const result = await api('operation', { revision: room.revision, operation });
    room = result.room;
    message('');
    render();
  } catch (error) {
    message(error.message, true);
    void refresh(true);
  } finally {
    busy = false;
  }
}
const displayName = (id) =>
  room?.participants.find((member) => member.id === id)?.name || 'Former participant';
function buildShell() {
  app.replaceChildren();
  const shell = element('div', undefined, 'shell'),
    sidebar = element('aside', undefined, 'sidebar');
  sidebar.append(
    element('div', 'COMMON ROOM', 'wordmark'),
    element('p', 'A shared space inside Discord.', 'subtitle'),
  );
  const navigation = element('nav');
  navigation.setAttribute('aria-label', 'Activity tools');
  for (const [mode, title] of Object.entries(modes)) {
    const control = button(title, () => void send({ kind: 'mode', mode }));
    control.dataset.mode = mode;
    navigation.append(control);
  }
  sidebar.append(navigation);
  const connected = element('section', undefined, 'connected');
  connected.id = 'participants';
  sidebar.append(connected);
  shell.append(sidebar);
  const main = element('main'),
    header = element('header'),
    identity = element('div');
  identity.append(element('span', 'DISCORD ACTIVITY', 'eyebrow'), element('h1', 'Make something together.'));
  const controls = element('div', undefined, 'row');
  controls.append(
    button(
      'Invite friends',
      async () => {
        try {
          await sdk.commands.openInviteDialog();
        } catch (error) {
          message('Discord could not open the invite dialog: ' + error.message, true);
        }
      },
      !sdk,
    ),
    button(
      'Share presence',
      async () => {
        try {
          await sdk.commands.setActivity({
            activity: {
              type: 0,
              details: 'Common room · ' + modes[room.mode],
              state: 'Creating together',
              instance: true,
            },
          });
          message('Your Discord activity was updated.');
        } catch (error) {
          message('Discord did not accept that presence update: ' + error.message, true);
        }
      },
      !sdk,
    ),
  );
  header.append(identity, controls);
  main.append(header);
  const notice = element('p', '', 'notice');
  notice.id = 'notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  main.append(notice);
  const content = element('section');
  content.id = 'content';
  main.append(content);
  const footer = element(
    'footer',
    'Room state is shared with current channel participants. Editing uses revisions; interrupted changes are never automatically repeated.',
  );
  main.append(footer);
  shell.append(main);
  app.append(shell);
}
function card(title) {
  const node = element('article', undefined, 'card');
  node.append(element('h2', title));
  return node;
}
function games(content) {
  const grid = element('div', undefined, 'two-columns'),
    game = card('Tic-tac-toe'),
    board = element('div', undefined, 'tic-board');
  game.append(
    element(
      'p',
      room.winner
        ? room.winner === 'draw'
          ? 'The game is a draw.'
          : displayName(room.winner) + ' wins.'
        : room.participants.length < 2
          ? 'Waiting for a second player.'
          : displayName(room.turn) + '’s turn.',
    ),
  );
  const players = room.participants.slice(0, 2);
  room.board.forEach((value, index) => {
    const control = button(
      value ? (value === players[0]?.id ? '×' : '○') : '',
      () => void send({ kind: 'game.move', cell: index }),
      players.length < 2 || !!room.winner || room.turn !== userId || value !== null,
    );
    control.setAttribute(
      'aria-label',
      `Row ${Math.floor(index / 3) + 1}, column ${(index % 3) + 1}: ${value ? displayName(value) : 'empty'}`,
    );
    board.append(control);
  });
  game.append(
    board,
    button('New round', () => void send({ kind: 'game.reset' }), room.hostId !== userId),
  );
  const puzzle = card('Sliding puzzle'),
    tiles = element('div', undefined, 'puzzle-board');
  puzzle.append(element('p', 'Move a tile next to the empty square. Reach 1–15 in reading order.'));
  room.puzzle.forEach((value, index) => {
    const control = button(
      value ? String(value) : '',
      () => void send({ kind: 'puzzle.move', cell: index }),
      !value,
    );
    control.setAttribute('aria-label', value ? 'Move tile ' + value : 'Empty square');
    tiles.append(control);
  });
  puzzle.append(
    tiles,
    button('Shuffle puzzle', () => void send({ kind: 'puzzle.reset' }), room.hostId !== userId),
  );
  grid.append(game, puzzle);
  content.append(grid);
}
function drawing(content) {
  const panel = card('Shared whiteboard'),
    tools = element('div', undefined, 'row'),
    color = element('input');
  color.type = 'color';
  color.value = '#a8e39d';
  color.setAttribute('aria-label', 'Ink color');
  tools.append(
    color,
    button('Undo my last stroke', () => void send({ kind: 'stroke.undo' })),
  );
  const canvas = element('canvas', undefined, 'drawing');
  canvas.width = 1000;
  canvas.height = 600;
  canvas.setAttribute('aria-label', 'Shared drawing canvas');
  panel.append(
    tools,
    canvas,
    element('p', 'Draw with a pointer or touch. Each stroke is shared; undo removes only your own stroke.'),
  );
  content.append(panel);
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  const stroke = (points, ink) => {
    ctx.strokeStyle = ink;
    ctx.beginPath();
    points.forEach(([x, y], index) =>
      index ? ctx.lineTo(x * 1000, y * 600) : ctx.moveTo(x * 1000, y * 600),
    );
    ctx.stroke();
  };
  room.strokes.forEach((item) => stroke(item.points, item.color));
  let points = [];
  const point = (event) => {
    const box = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    ];
  };
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    drawingActive = true;
    points = [point(event)];
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!points.length || points.length >= 256) return;
    points.push(point(event));
    stroke(points.slice(-2), color.value);
  });
  canvas.addEventListener('pointercancel', () => {
    points = [];
    drawingActive = false;
    void refresh(true);
  });
  canvas.addEventListener('pointerup', () => {
    const complete = points;
    points = [];
    drawingActive = false;
    if (complete.length >= 2) void send({ kind: 'stroke', color: color.value, points: complete });
  });
}
function editor(content) {
  const panel = card('Shared editor'),
    text = element('textarea');
  text.value = dirty ? draft : room.text;
  text.maxLength = 12000;
  text.rows = 18;
  text.setAttribute('aria-label', 'Collaborative document');
  text.addEventListener('input', () => {
    draft = text.value;
    dirty = true;
  });
  panel.append(
    element(
      'p',
      'Save a revision to share it. If another participant saves first, your draft stays in this browser for review.',
    ),
    text,
    button('Save shared revision', async () => {
      draft = text.value;
      await send({ kind: 'editor', text: draft });
      if (room?.text === draft) {
        dirty = false;
        render();
      }
    }),
  );
  content.append(panel);
}
function quiz(content) {
  const panel = card(room.mode === 'learning' ? 'Learning room' : 'Multiplayer quiz');
  panel.append(
    element('p', `Round ${room.quiz.round} · ${room.quiz.answerCount} answers received`),
    element('h3', room.quiz.question),
  );
  const choices = element('div', undefined, 'choices');
  room.quiz.choices.forEach((choice, index) => {
    const answer = button(
      choice,
      () => void send({ kind: 'quiz.answer', answer: index }),
      room.quiz.answered || Date.now() >= room.quiz.deadline,
    );
    if (room.quiz.answer === index) answer.className = 'correct';
    choices.append(answer);
  });
  panel.append(choices);
  if (room.quiz.lesson) panel.append(element('p', room.quiz.lesson, 'lesson'));
  panel.append(
    element(
      'p',
      room.quiz.answered
        ? 'Your answer is recorded.'
        : `Answer before ${new Date(room.quiz.deadline).toLocaleTimeString()}.`,
    ),
    button('Next question', () => void send({ kind: 'quiz.next' }), room.hostId !== userId),
  );
  content.append(panel);
}
function tasks(content) {
  const panel = card('Shared task board'),
    form = element('form', undefined, 'row'),
    title = element('input');
  title.value = taskDraft;
  title.addEventListener('input', () => {
    taskDraft = title.value;
  });
  title.placeholder = 'A concrete next step';
  title.maxLength = 200;
  title.required = true;
  title.setAttribute('aria-label', 'New task title');
  form.append(title, element('button', 'Add task'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (title.value.trim()) {
      const saved = title.value.trim();
      void send({ kind: 'task.add', title: saved }).then(() => {
        if (room?.tasks.some((task) => task.title === saved && task.authorId === userId)) {
          taskDraft = '';
          render();
        }
      });
    }
  });
  panel.append(form);
  const board = element('div', undefined, 'kanban');
  for (const column of ['todo', 'doing', 'done']) {
    const section = element('section');
    section.append(element('h3', column === 'todo' ? 'To do' : column === 'doing' ? 'In progress' : 'Done'));
    for (const task of room.tasks.filter((task) => task.column === column)) {
      const row = element('article', undefined, 'task');
      row.append(element('p', task.title));
      const select = element('select');
      select.setAttribute('aria-label', 'Move task ' + task.title);
      for (const value of ['todo', 'doing', 'done']) {
        const option = element('option', value);
        option.value = value;
        select.append(option);
      }
      select.value = column;
      select.addEventListener(
        'change',
        () => void send({ kind: 'task.move', id: task.id, column: select.value }),
      );
      row.append(select);
      section.append(row);
    }
    board.append(section);
  }
  panel.append(board);
  content.append(panel);
}
function map(content) {
  const panel = card('Shared coordinate map'),
    tools = element('div', undefined, 'row'),
    label = element('input');
  label.value = markerDraft;
  label.addEventListener('input', () => {
    markerDraft = label.value;
  });
  label.maxLength = 80;
  label.setAttribute('aria-label', 'New map marker label');
  const canvas = element('canvas', undefined, 'drawing');
  canvas.width = 1000;
  canvas.height = 600;
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 1000, 600);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(canvasZoom, canvasZoom);
    ctx.strokeStyle = '#35584c';
    ctx.fillStyle = '#789b8c';
    ctx.lineWidth = 1 / canvasZoom;
    ctx.font = '12px sans-serif';
    for (let x = 0; x <= 1000; x += 100) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 600);
      ctx.stroke();
      ctx.fillText(String(Math.round((x / 1000) * 360 - 180)) + '°', x + 3, 15);
    }
    for (let y = 0; y <= 600; y += 100) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1000, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(90 - (y / 600) * 180)) + '°', 4, y + 15);
    }
    for (const marker of room.markers) {
      ctx.fillStyle = '#b4f39a';
      ctx.beginPath();
      ctx.arc(marker.x * 1000, marker.y * 600, 5 / canvasZoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(marker.label, marker.x * 1000 + 8, marker.y * 600);
    }
    ctx.restore();
  };
  tools.append(
    label,
    button('Zoom in', () => {
      canvasZoom = Math.min(4, canvasZoom + 0.25);
      draw();
    }),
    button('Zoom out', () => {
      canvasZoom = Math.max(0.5, canvasZoom - 0.25);
      draw();
    }),
    button('Pan left', () => {
      panX += 50;
      draw();
    }),
    button('Pan right', () => {
      panX -= 50;
      draw();
    }),
    button('Reset view', () => {
      canvasZoom = 1;
      panX = panY = 0;
      draw();
    }),
  );
  panel.append(
    tools,
    canvas,
    element(
      'p',
      'Click to place a shared marker. The grid uses normalized longitude/latitude coordinates; it does not claim street or terrain data.',
    ),
  );
  const markers = element('ul');
  markers.setAttribute('aria-label', 'Shared map markers');
  for (const marker of room.markers)
    markers.append(
      element(
        'li',
        `${marker.label} · ${(marker.x * 360 - 180).toFixed(2)}° longitude, ${(90 - marker.y * 180).toFixed(2)}° latitude`,
      ),
    );
  if (room.markers.length) panel.append(markers);
  content.append(panel);
  draw();
  canvas.addEventListener('click', (event) => {
    const box = canvas.getBoundingClientRect(),
      x = (((event.clientX - box.left) / box.width) * 1000 - panX) / canvasZoom / 1000,
      y = (((event.clientY - box.top) / box.height) * 600 - panY) / canvasZoom / 600;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1)
      void send({ kind: 'marker', label: label.value || 'Marker', x, y });
  });
}
function simulation(content) {
  const panel = card('Shared physics laboratory'),
    form = element('form', undefined, 'row'),
    fields = {};
  for (const [key, title, min, max, step] of [
    ['gravity', 'Gravity', 0, 2, 0.1],
    ['restitution', 'Bounce', 0, 1, 0.05],
    ['count', 'Particles', 1, 50, 1],
  ]) {
    const group = element('label', title),
      input = element('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = room.simulation[key];
    input.disabled = room.hostId !== userId;
    fields[key] = input;
    group.append(input);
    form.append(group);
  }
  form.append(element('button', 'Apply shared settings'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send({
      kind: 'simulation',
      gravity: Number(fields.gravity.value),
      restitution: Number(fields.restitution.value),
      count: Number(fields.count.value),
    });
  });
  const canvas = element('canvas', undefined, 'drawing');
  canvas.width = 1000;
  canvas.height = 600;
  panel.append(
    form,
    canvas,
    element(
      'p',
      'All participants share the same parameters. The simulation runs locally with a fixed initial arrangement.',
    ),
  );
  content.append(panel);
  const particles = Array.from({ length: room.simulation.count }, (_, index) => ({
      x: 30 + ((index * 137) % 940),
      y: 20 + ((index * 71) % 350),
      vx: (index % 2 ? 1 : -1) * (1 + (index % 3)),
      vy: 0,
    })),
    ctx = canvas.getContext('2d');
  let previous = 0;
  const frame = (time) => {
    const scale = Math.min(2, (time - previous) / 16.667 || 1);
    previous = time;
    ctx.clearRect(0, 0, 1000, 600);
    ctx.fillStyle = '#b4f39a';
    for (const item of particles) {
      item.vy += room.simulation.gravity * scale;
      item.x += item.vx * scale;
      item.y += item.vy * scale;
      if (item.y > 590) {
        item.y = 590;
        item.vy = -Math.abs(item.vy) * room.simulation.restitution;
      }
      if (item.x < 10 || item.x > 990) item.vx = -item.vx;
      ctx.beginPath();
      ctx.arc(item.x, item.y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    animation = requestAnimationFrame(frame);
  };
  animation = requestAnimationFrame(frame);
}
function stats(content) {
  const panel = card('Room statistics'),
    summary = element('div', undefined, 'metrics');
  for (const [title, value] of [
    ['Participants', room.participants.length],
    ['Quiz round', room.quiz.round],
    ['Tasks completed', room.tasks.filter((task) => task.column === 'done').length],
    ['Shared strokes', room.strokes.length],
  ]) {
    const item = element('article');
    item.append(element('strong', String(value)), element('span', title));
    summary.append(item);
  }
  panel.append(summary, element('h3', 'Local game and quiz scores'));
  const scores = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);
  if (!scores.length) panel.append(element('p', 'Play a game or answer a quiz to start a score.'));
  for (const [id, value] of scores) {
    const row = element('p', `${displayName(id)} · ${value}`, 'score');
    panel.append(row);
  }
  panel.append(
    element(
      'p',
      'These statistics describe this room. They are separate from external game accounts and the bot’s server analytics.',
    ),
  );
  content.append(panel);
}
function render() {
  if (!room || drawingActive) return;
  const active = document.activeElement;
  const selection =
    active?.tagName === 'TEXTAREA' ? { start: active.selectionStart, end: active.selectionEnd } : undefined;
  cancelAnimationFrame(animation);
  const content = document.getElementById('content');
  if (!content) return;
  content.replaceChildren();
  document.querySelectorAll('[data-mode]').forEach((node) => {
    node.disabled = room.hostId !== userId;
    node.classList.toggle('active', node.dataset.mode === room.mode);
  });
  const participants = document.getElementById('participants');
  participants.replaceChildren(element('h2', 'In this room'));
  for (const member of room.participants)
    participants.append(element('p', member.name + (member.id === room.hostId ? ' · host' : '')));
  ({ game: games, whiteboard: drawing, editor, quiz, learning: quiz, tasks, map, simulation, stats })[
    room.mode
  ](content);
  currentMode = room.mode;
  lastRevision = room.revision;
  if (selection && room.mode === 'editor') {
    const editor = document.querySelector('textarea');
    editor?.focus();
    editor?.setSelectionRange(selection.start, selection.end);
  }
}
async function refresh(force = false) {
  if (!token || busy || (document.hidden && !force)) return;
  try {
    const result = await api('state');
    room = result.room;
    applyAppearance(result.appearance);
    if (
      force ||
      room.revision !== lastRevision ||
      room.mode !== currentMode ||
      ['quiz', 'learning'].includes(room.mode)
    )
      render();
  } catch (error) {
    message(error.message, true);
  }
}
async function start() {
  try {
    let result;
    if (bootstrap.preview) {
      result = await api('auth', { preview: bootstrap.preview });
      history.replaceState({}, '', location.pathname);
    } else {
      sdk = new DiscordSDK(bootstrap.clientId);
      await sdk.ready();
      const authorized = await sdk.commands.authorize({
        client_id: bootstrap.clientId,
        response_type: 'code',
        state: crypto.randomUUID(),
        prompt: 'none',
        scope: ['identify', 'rpc.activities.write'],
      });
      if (!sdk.guildId || !sdk.channelId)
        throw new Error('This Activity requires a supported installed-server channel.');
      const authorization = await api('auth', {
        code: authorized.code,
        guildId: sdk.guildId,
        channelId: sdk.channelId,
        instanceId: sdk.instanceId,
      });
      await sdk.commands.authenticate({ access_token: authorization.access_token });
      delete authorization.access_token;
      result = await api('join', { pending: authorization.pending });
    }
    token = result.token;
    room = result.room;
    applyAppearance(result.appearance);
    userId = result.userId;
    buildShell();
    render();
    setInterval(() => void refresh(), 2000);
  } catch (error) {
    signedOut(error.message + ' Launch the Activity in Discord, or request a private activity.preview link.');
  }
}
void start();
