import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import sharp from 'sharp';
import type { Message } from 'discord.js';
import { createExplicitClassifier, explicitImageUrl } from '../src/moderation/explicit-classifier.js';

const URL_IMAGE = 'https://cdn.discordapp.com/attachments/111/222/image.png?ex=123&hm=signed';
const picture = sharp({ create: { width: 32, height: 16, channels: 3, background: '#2277aa' } })
  .png()
  .toBuffer();
function message(
  content = '',
  files: Record<string, unknown>[] = [],
  embeds: Record<string, unknown>[] = [],
): Message {
  return {
    content,
    attachments: new Map(files.map((file, i) => [String(i), file])),
    embeds,
  } as unknown as Message;
}
function attachment(url = URL_IMAGE, changes: Record<string, unknown> = {}) {
  return { url, name: 'image.png', contentType: 'image/png', size: 1000, ...changes };
}
function moderation(categories: Record<string, boolean>) {
  return {
    id: 'mod_test',
    model: 'omni-moderation-latest',
    results: [
      {
        flagged: Object.values(categories).includes(true),
        categories: { sexual: false, 'sexual/minors': false, ...categories },
        category_scores: {},
        category_applied_input_types: {},
      },
    ],
  };
}
function provider(
  handler: (
    body: Record<string, unknown>,
    url: string,
    options?: RequestInit,
  ) => Response | Promise<Response>,
) {
  return new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (input, options) =>
      handler(JSON.parse(String(options?.body ?? '{}')), String(input), options),
  });
}
function client(categories: Record<string, boolean>, bodies: Record<string, unknown>[] = []) {
  return provider((body, url) => {
    bodies.push(body);
    assert(url.endsWith('/moderations'));
    return Response.json(moderation(categories));
  });
}

test('Real SDK moderation requests classify only explicit policy categories, not unrelated flags', async () => {
  for (const [categories, expected] of [
    [{ sexual: true }, ['sexual']],
    [{ 'sexual/minors': true }, ['sexual/minors']],
    [{ hate: true }, ['hate']],
    [{ 'hate/threatening': true }, ['hate/threatening']],
    [{ 'harassment/threatening': true }, ['harassment/threatening']],
    [{ violence: true, harassment: true }, []],
    [{ sexual: false }, []],
  ] as const) {
    const bodies: Record<string, unknown>[] = [];
    const classifier = createExplicitClassifier({ apiKey: '', client: client(categories, bodies) });
    assert.deepEqual(await classifier.classify(message('Text to classify')), {
      remove: expected.length > 0,
      categories: expected,
      scannedImages: 0,
    });
    assert.deepEqual(bodies[0], {
      model: 'omni-moderation-latest',
      input: [{ type: 'text', text: 'Text to classify' }],
    });
    classifier.close();
  }
});

test('Attachment and external embed images use normalized actual pixels through multimodal image_url data', async () => {
  const bytes = await sharp({ create: { width: 2048, height: 1025, channels: 3, background: '#2277aa' } })
      .png()
      .toBuffer(),
    bodies: Record<string, unknown>[] = [],
    fetched: string[] = [];
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: provider((body) => {
      bodies.push(body);
      const images = (body.input as { type: string }[]).filter((item) => item.type === 'image_url');
      if (images.length > 1)
        return Response.json(
          { error: { code: 'too_many_images', message: 'Maximum one image per request' } },
          { status: 400 },
        );
      return Response.json(moderation({ sexual: bodies.length === 2 }));
    }),
    fetcher: async (url, options) => {
      fetched.push(String(url));
      assert.equal(options?.redirect, 'error');
      assert(options?.signal instanceof AbortSignal);
      return new Response(Buffer.from(bytes));
    },
  });
  try {
    const result = await classifier.classify(
      message(
        'A caption',
        [attachment()],
        [
          {
            image: {
              url: 'https://sender-controlled.example/image.png',
              proxyURL: 'https://images-ext-1.discordapp.net/external/opaque/https/example.org/image.png',
            },
          },
          {
            thumbnail: {
              url: 'https://cdn.discordapp.com/attachments/111/222/image.png',
              proxyURL: 'https://media.discordapp.net/attachments/111/222/image.png?width=64',
            },
          },
        ],
      ),
    );
    assert.deepEqual(result, { remove: true, categories: ['sexual'], scannedImages: 2 });
    assert.equal(fetched.length, 2);
    assert(fetched.every((url) => !new URL(url).hostname.includes('sender-controlled')));
    assert.equal(bodies.length, 2);
    assert.equal((bodies[0]?.input as unknown[]).length, 2);
    assert.equal((bodies[1]?.input as unknown[]).length, 1);
    const input = bodies.flatMap((body) =>
      (body.input as { type: string; image_url?: { url: string } }[]).filter(
        (item) => item.type === 'image_url',
      ),
    );
    for (const item of input) {
      assert.equal(item.type, 'image_url');
      assert(item.image_url?.url.startsWith('data:image/jpeg;base64,'));
      const metadata = await sharp(Buffer.from(item.image_url!.url.split(',')[1]!, 'base64')).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert(metadata.width! <= 1024 && metadata.height! <= 1024);
      assert.equal(metadata.width, 1024);
    }
  } finally {
    classifier.close();
  }
});

test('All safe images are scanned one at a time, without applying later image-only text category flags', async () => {
  const bytes = await picture,
    bodies: Record<string, unknown>[] = [];
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: provider((body) => {
      bodies.push(body);
      const input = body.input as { type: string }[];
      if (input.filter((item) => item.type === 'image_url').length > 1)
        return Response.json({ error: { code: 'too_many_images' } }, { status: 400 });
      return Response.json(
        moderation(
          bodies.length === 1 ? {} : { hate: true, 'sexual/minors': true, 'harassment/threatening': true },
        ),
      );
    }),
    fetcher: async () => new Response(Buffer.from(bytes)),
  });
  try {
    const result = await classifier.classify(
      message(
        'Ordinary caption',
        Array.from({ length: 3 }, (_, i) =>
          attachment(`https://cdn.discordapp.com/attachments/1/${i}/a.png`),
        ),
      ),
    );
    assert.deepEqual(result, { remove: false, categories: [], scannedImages: 3 });
    assert.equal(bodies.length, 3);
    assert.equal(
      (bodies[0]?.input as { type: string }[]).some((item) => item.type === 'text'),
      true,
    );
    for (const body of bodies.slice(1))
      assert.deepEqual(
        (body.input as { type: string }[]).map((item) => item.type),
        ['image_url'],
      );
  } finally {
    classifier.close();
  }
});

test('A positive first image returns its actual scan count immediately, preserving the verdict before any later failure', async () => {
  const bytes = await picture;
  let downloads = 0,
    calls = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: provider(() => {
      calls++;
      return Response.json(moderation({ sexual: true }));
    }),
    fetcher: async () => {
      if (++downloads > 1) throw new Error('Later image is unavailable');
      return new Response(Buffer.from(bytes));
    },
  });
  try {
    const result = await classifier.classify(
      message('', [attachment(), attachment('https://cdn.discordapp.com/attachments/3/4/a.png')]),
    );
    assert.deepEqual(result, { remove: true, categories: ['sexual'], scannedImages: 1 });
    assert.equal(downloads, 1);
    assert.equal(calls, 1);
  } finally {
    classifier.close();
  }
});

test('Sequential image requests share one overall deadline instead of starting a fresh timeout for each image', async (t) => {
  const bytes = await picture;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enteredFirst!: () => void, enteredSecond!: () => void, releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    }),
    secondStarted = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    }),
    firstReply = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  let calls = 0,
    active = 0,
    peak = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    timeoutMs: 100,
    client: provider(async (_body, _url, options) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (calls === 1) {
          enteredFirst();
          await firstReply;
        } else
          await new Promise<void>((_resolve, reject) => {
            enteredSecond();
            options?.signal?.addEventListener(
              'abort',
              () => {
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        return Response.json(moderation({}));
      } finally {
        active--;
      }
    }),
    fetcher: async () => new Response(Buffer.from(bytes)),
  });
  try {
    const pending = classifier.classify(
      message(
        '',
        Array.from({ length: 3 }, (_, i) =>
          attachment(`https://cdn.discordapp.com/attachments/1/${i}/a.png`),
        ),
      ),
    );
    await firstStarted;
    t.mock.timers.tick(60);
    releaseFirst();
    await secondStarted;
    t.mock.timers.tick(41);
    await assert.rejects(pending, /cancelled or timed out/);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally {
    classifier.close();
  }
});

test('Image-only input works without a text item, while sexual/minors is never represented as an image detector', async () => {
  const bodies: Record<string, unknown>[] = [],
    bytes = await picture;
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: client({ 'sexual/minors': true }, bodies),
    fetcher: async () => new Response(Buffer.from(bytes)),
  });
  const result = await classifier.classify(message('', [attachment()]));
  assert.deepEqual(result, { remove: false, categories: [], scannedImages: 1 });
  assert.equal((bodies[0]?.input as { type: string }[])[0]?.type, 'image_url');
  classifier.close();
  const explicit = createExplicitClassifier({
    apiKey: '',
    client: client({ sexual: true }),
    fetcher: async () => new Response(Buffer.from(bytes)),
  });
  assert.deepEqual(await explicit.classify(message('', [attachment()])), {
    remove: true,
    categories: ['sexual'],
    scannedImages: 1,
  });
  explicit.close();
});

test('Arbitrary/local URLs, credentials, lookalike domains, ports and redirects are never image sources', async () => {
  for (const url of [
    'http://cdn.discordapp.com/attachments/1/2/a.png',
    'https://127.0.0.1/attachments/1/2/a.png',
    'https://cdn.discordapp.com.evil.test/attachments/1/2/a.png',
    'https://media.discordapp.net:444/attachments/1/2/a.png',
    'https://secret@cdn.discordapp.com/attachments/1/2/a.png',
    'https://cdn.discordapp.com/outside/image.png',
    'https://images-ext-1.discordapp.net/attachments/a.png',
    'https://example.com/image.png',
  ])
    assert.throws(() => explicitImageUrl(url), /Untrusted/);
  let fetches = 0,
    apiCalls = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: provider(() => {
      apiCalls++;
      return Response.json(moderation({}));
    }),
    fetcher: async () => {
      fetches++;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
  });
  const untrusted = await classifier.classify(message('', [attachment('https://example.com/image.png')]));
  assert.equal(untrusted.scannedImages, 0);
  assert.match(untrusted.unscannable![0]!, /untrusted/);
  assert.equal(fetches, 0);
  const redirected = await classifier.classify(message('', [attachment()]));
  assert.equal(redirected.scannedImages, 0);
  assert.equal(apiCalls, 0);
  assert.equal(fetches, 1);
  classifier.close();
});

test('Declared and streamed byte caps reject images before moderation without treating unscanned media as benign coverage', async () => {
  let fetches = 0,
    apiCalls = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    maxAttachmentBytes: 1024,
    client: provider(() => {
      apiCalls++;
      return Response.json(moderation({}));
    }),
    fetcher: async () => {
      fetches++;
      return new Response(Buffer.alloc(1025));
    },
  });
  const result = await classifier.classify(
    message('', [
      attachment(URL_IMAGE, { size: 1025 }),
      attachment('https://cdn.discordapp.com/attachments/3/4/a.png', { size: 100 }),
    ]),
  );
  assert.equal(result.scannedImages, 0);
  assert.equal(result.unscannable?.length, 2);
  assert(result.unscannable!.every((reason) => reason.includes('byte limit')));
  assert.equal(fetches, 1);
  assert.equal(apiCalls, 0);
  classifier.close();
});

test('Invalid bytes, SVG and animation/video remain explicitly unscannable, while ordinary text can still be classified', async () => {
  const frames = Buffer.alloc(2 * 2 * 3 * 2, 100);
  frames.fill(200, frames.length / 2);
  const animation = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
    .gif({ loop: 0, delay: [100, 100] })
    .toBuffer();
  let fetches = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: client({ sexual: false }),
    fetcher: async () => {
      fetches++;
      return new Response(fetches === 1 ? animation : Buffer.from('<svg>not raster pixels</svg>'));
    },
  });
  const result = await classifier.classify(
    message('An ordinary caption', [
      attachment(),
      attachment('https://cdn.discordapp.com/attachments/3/4/a.svg', {
        name: 'a.svg',
        contentType: 'image/svg+xml',
      }),
      attachment('https://cdn.discordapp.com/attachments/5/6/a.mp4', {
        name: 'a.mp4',
        contentType: 'video/mp4',
      }),
    ]),
  );
  assert.equal(result.remove, false);
  assert.equal(result.scannedImages, 0);
  assert.equal(result.unscannable?.length, 3);
  assert(result.unscannable!.some((reason) => /animated/.test(reason)));
  assert(result.unscannable!.some((reason) => /video/.test(reason)));
  classifier.close();
});

test('The image count bound reports skipped media, and oversized text is explicitly truncated', async () => {
  const bytes = await picture,
    bodies: Record<string, unknown>[] = [];
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: client({}, bodies),
    fetcher: async () => new Response(Buffer.from(bytes)),
  });
  const files = Array.from({ length: 11 }, (_, i) =>
    attachment(`https://cdn.discordapp.com/attachments/1/${i}/a.png`),
  );
  const result = await classifier.classify(message('a'.repeat(4001), files));
  assert.equal(result.scannedImages, 10);
  assert.equal(result.unscannable?.length, 2);
  assert.equal((bodies[0]?.input as { text: string }[])[0]?.text.length, 4000);
  classifier.close();
});

test('Missing keys and provider outages fail clearly, never retry and never produce a deletion verdict', async () => {
  await assert.rejects(createExplicitClassifier({ apiKey: '' }).classify(message('hello')), /unavailable/);
  let calls = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: provider(() => {
      calls++;
      return Response.json({ error: { message: 'sensitive provider request fragment' } }, { status: 503 });
    }),
  });
  await assert.rejects(
    classifier.classify(message('hello')),
    (error) =>
      error instanceof Error && /unavailable/.test(error.message) && !error.message.includes('sensitive'),
  );
  assert.equal(calls, 1);
  classifier.close();
});

test('Deterministic strict policy hits need no credentials, image download or provider request', async () => {
  let calls = 0;
  const classifier = createExplicitClassifier({
    apiKey: '',
    fetcher: async () => {
      calls++;
      throw new Error('No network');
    },
  });
  for (const content of ['nigger', 'coon', 'faggot', 'retard', 'rape']) {
    const result = await classifier.classify(message(content, [attachment()]));
    assert.equal(result.remove, true);
    assert.equal(result.scannedImages, 0);
  }
  const preview = await classifier.classify(
    message(
      'https://google.com/goto?url=CAESopaque',
      [],
      [{ title: 'Free Porn Videos - XVIDEOS.COM', description: 'XVIDEOS Free Porn Videos' }],
    ),
  );
  assert.equal(preview.remove, true);
  assert(preview.categories.includes('policy/adult-promotion'));
  assert.equal(calls, 0);
  classifier.close();
});

test('Semantic moderation sees content and preview metadata while opaque redirects stay unfetched', async () => {
  const bodies: Record<string, unknown>[] = [];
  const classifier = createExplicitClassifier({
    apiKey: '',
    client: client({ hate: true }, bodies),
    fetcher: async () => {
      throw new Error('Unexpected network');
    },
  });
  const result = await classifier.classify(
    message(
      'An opaque reference',
      [],
      [
        {
          title: 'A title',
          description: 'An expanded description',
          author: { name: 'Author name' },
          footer: { text: 'Footer text' },
          url: 'https://google.com/goto?url=CAESopaque',
          provider: { url: 'https://example.com' },
        },
      ],
    ),
  );
  assert.deepEqual(result.categories, ['hate']);
  const input = (bodies[0]?.input as { text: string }[])[0]?.text;
  for (const value of [
    'A title',
    'An expanded description',
    'Author name',
    'Footer text',
    'https://example.com',
  ])
    assert(input?.includes(value));
  classifier.close();
});

test('Caller abort, bounded timeout and close cancel pending provider work without late verdicts', async () => {
  for (const mode of ['abort', 'timeout', 'close'] as const) {
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const classifier = createExplicitClassifier({
      apiKey: '',
      timeoutMs: 100,
      client: provider(
        (_body, _url, options) =>
          new Promise((_resolve, reject) => {
            entered();
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      ),
    });
    const controller = new AbortController(),
      pending = classifier.classify(message('hello'), controller.signal);
    await started;
    if (mode === 'abort') controller.abort();
    if (mode === 'close') classifier.close();
    await assert.rejects(pending, /cancelled or timed out/);
    classifier.close();
  }
});
