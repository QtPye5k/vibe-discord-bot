import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import sharp from 'sharp';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import { registerMediaPostingActions, publicMediaPage } from '../src/features/media-posting.js';
const G = '940000000000000001',
  U = '940000000000000002',
  B = '940000000000000003',
  C = '940000000000000004',
  D = '940000000000000005';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let access = true,
    fail = false;
  const sent: { channelId: string; payload: Record<string, unknown> }[] = [];
  const member = { id: U, permissions: new PermissionsBitField(P.Administrator) },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const channel = (id: string) => ({
    id,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => new PermissionsBitField(access ? P.Administrator : 0n),
    send: async (payload: Record<string, unknown>) => {
      sent.push({ channelId: id, payload });
      if (fail) throw new Error('uncertain send');
      return { id: 'generated-message' };
    },
  });
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async (id: string) => channel(id) },
  };
  const ctx = { store, guild, member, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx, { confirmationMode: 'smart' });
  return {
    ctx,
    registry,
    sent,
    deny: () => {
      access = false;
    },
    fail: () => {
      fail = true;
    },
  };
}
test('image generation posts verified actual bytes to the requested channel, returns only a receipt, and retries are one-use', async (t) => {
  const f = fixture(t),
    png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#125566' } })
      .png()
      .toBuffer();
  let calls = 0;
  registerMediaPostingActions(f.registry, {
    ai: {
      image: async (_ctx, prompt, url, transparent) => {
        calls++;
        assert.equal(prompt, 'A teal cat');
        assert.equal(url, undefined);
        assert.equal(transparent, true);
        return { attachment: png, name: 'ignored.png' };
      },
    },
  });
  const ctx = userRequestContext(f.ctx, 'chat'),
    input = { prompt: 'A teal cat', transparent: true, channelId: D, requestId: 'image-request-01' };
  const first = await f.registry.request(ctx, 'media.generate-send', input),
    second = await f.registry.request(ctx, 'media.generate-send', input);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.channelId, D);
  assert.deepEqual((f.sent[0]!.payload.files as { attachment: Buffer }[])[0]!.attachment, png);
  assert(!('attachment' in (first.status === 'completed' ? (first.result as object) : {})));
  assert.equal(
    (second.status === 'completed' ? (second.result as { alreadySent: boolean }) : undefined)?.alreadySent,
    true,
  );
  await assert.rejects(
    f.registry.request(ctx, 'media.generate-send', { ...input, prompt: 'different' }),
    /different request/,
  );
});
test('generation permission loss or voice revocation during provider work prevents a late attachment', async (t) => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  for (const revoke of ['permissions', 'voice'] as const) {
    const f = fixture(t);
    let valid = true;
    registerMediaPostingActions(f.registry, {
      ai: {
        image: async () => {
          if (revoke === 'permissions') f.deny();
          else valid = false;
          return { attachment: png, name: 'image.png' };
        },
      },
    });
    const ctx = userRequestContext(f.ctx, 'voice', { valid: () => valid });
    await assert.rejects(
      f.registry.request(ctx, 'media.generate-send', { prompt: 'An example', channelId: D }),
      /view|permission|expired|cancelled/i,
    );
    assert.equal(f.sent.length, 0);
  }
});
test('denied destination prevents paid generation; invalid output never posts', async (t) => {
  const f = fixture(t);
  let calls = 0;
  registerMediaPostingActions(f.registry, {
    ai: {
      image: async () => {
        calls++;
        return { attachment: Buffer.from('<svg>unsafe</svg>'), name: 'x.png' };
      },
    },
  });
  const ctx = userRequestContext(f.ctx, 'chat');
  await assert.rejects(f.registry.request(ctx, 'media.generate-send', { prompt: 'test' }), /PNG|JPEG|format/);
  assert.equal(f.sent.length, 0);
  assert.equal(calls, 1);
  f.deny();
  await assert.rejects(
    f.registry.request(ctx, 'media.generate-send', { prompt: 'other' }),
    /view|permission/i,
  );
  assert.equal(calls, 1);
});
test('original Pinterest GIF Pins can be shared without a provider token; arbitrary URLs and ambiguous retries cannot post', async (t) => {
  const f = fixture(t);
  registerMediaPostingActions(f.registry);
  const ctx = userRequestContext(f.ctx, 'chat');
  const input = { url: 'https://www.pinterest.com/pin/123456789/', channelId: D };
  await f.registry.request(ctx, 'media.link-send', input);
  await f.registry.request(ctx, 'media.link-send', input);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.channelId, D);
  assert.equal(f.sent[0]!.payload.content, input.url);
  assert.deepEqual(f.sent[0]!.payload.allowedMentions, { parse: [] });
  for (const url of [
    'https://pin.it/short',
    'https://www.pinterest.com/pin/123/?url=http://127.0.0.1',
    'https://pinterest.com.evil.test/pin/1/',
    'https://user:pass@www.pinterest.com/pin/1/',
    'https://www.pinterest.com/secret-board/',
    'http://www.pinterest.com/pin/1/',
  ])
    assert.throws(() => publicMediaPage(url));
  f.fail();
  const uncertain = { url: 'https://klipy.com/gifs/hello-1', channelId: D, requestId: 'uncertain-01' };
  await assert.rejects(f.registry.request(ctx, 'media.link-send', uncertain), /uncertain send/);
  await assert.rejects(f.registry.request(ctx, 'media.link-send', uncertain), /uncertain delivery/);
  assert.equal(f.sent.length, 2);
});
