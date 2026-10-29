import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client, ChannelType, Events, Routes, type SendableChannels, type TextChannel } from 'discord.js';
import { sendVoiceMessage } from '../src/voice/delivery.js';
import { voiceDeadline } from '../src/voice/deadline.js';

const CHANNEL = '930000000000000001';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const mode of ['deadline', 'revocation', 'privacy-change'] as const) {
  test(`Installed Discord REST queue never dispatches a voice send after ${mode}`, async (t) => {
    const blockerArrived = deferred(),
      releaseBlocker = deferred(),
      queued = deferred(),
      received: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { content: string };
      received.push(body.content);
      if (body.content === 'blocker') {
        blockerArrived.resolve();
        await releaseBlocker.promise;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: '930000000000000002', content: body.content }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const client = new Client({
      intents: [],
      rest: { api: `http://127.0.0.1:${address.port}`, retries: 0, timeout: 2000, offset: 0 },
    });
    client.rest.setToken('test-only-not-a-real-discord-token');
    t.after(async () => {
      releaseBlocker.resolve();
      client.rest.clearHashSweeper();
      client.rest.clearHandlerSweeper();
      await client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const route = Routes.channelMessages(CHANNEL),
      blocking = client.rest.post(route, { body: { content: 'blocker' } });
    void blocking.catch(() => {});
    await blockerArrived.promise;
    const handler = client.rest.handlers.first();
    assert(handler, 'The installed REST manager must have a real route handler');
    const original = handler.queueRequest.bind(handler);
    // Observe entry without replacing the installed AsyncQueue/handler or the actual HTTP fetch.
    t.mock.method(handler, 'queueRequest', (...args: Parameters<typeof original>) => {
      const pending = original(...args);
      queued.resolve();
      return pending;
    });
    const channel = { id: CHANNEL, type: ChannelType.GuildText, client } as SendableChannels;
    const controller = new AbortController();
    let privateAccess = true;
    let pendingSend: Promise<void> | undefined;
    const delivery = voiceDeadline(
      (signal) => {
        pendingSend = sendVoiceMessage(channel, { content: 'private voice reply' }, signal, () => {
          signal.throwIfAborted();
          if (!privateAccess) throw new Error('Private channel became public.');
        });
        return pendingSend;
      },
      {
        signal: controller.signal,
        timeoutMs: mode === 'deadline' ? 25 : 2000,
        message: 'Private delivery timed out.',
      },
    );
    const rejected = assert.rejects(
      delivery,
      mode === 'deadline'
        ? /Private delivery timed out/
        : mode === 'revocation'
          ? /Speaker revoked/
          : /Private channel|abort/i,
    );
    await queued.promise;
    if (mode === 'revocation') controller.abort(new Error('Speaker revoked consent.'));
    if (mode === 'privacy-change') {
      privateAccess = false;
      client.emit(Events.ChannelUpdate, channel as TextChannel, channel as TextChannel);
    }
    await rejected;
    assert(pendingSend);
    await assert.rejects(pendingSend, /abort|timed out|revoked|Private channel/i);
    assert.deepEqual(received, ['blocker']);
    releaseBlocker.resolve();
    await blocking;
    // A successful request behind the cancelled one proves the actual bucket was drained.
    await client.rest.post(route, { body: { content: 'sentinel' } });
    assert.deepEqual(received, ['blocker', 'sentinel']);
  });
}
