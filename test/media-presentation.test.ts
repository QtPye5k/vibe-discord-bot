import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomePayload } from '../src/discord/presentation.js';

test('provider search previews preserve eight KLIPY results in ordered buttons within Discord row limits', () => {
  const payload = outcomePayload({
    status: 'completed',
    action: 'gif.search',
    result: {
      provider: 'KLIPY',
      searchId: 'abcdefghijklmnop',
      results: Array.from({ length: 8 }, (_, i) => ({
        index: i + 1,
        title: `Hello ${i + 1}`,
        license: 'Provider terms apply',
        source: `https://klipy.com/gifs/hello-${i + 1}`,
      })),
    },
  });
  assert.match(String(payload.content), /KLIPY · 8 results/);
  const rows = payload.components as unknown as readonly {
    toJSON: () => { components: { custom_id?: string }[] };
  }[];
  assert(rows.length <= 5);
  assert(rows.every((row) => row.toJSON().components.length <= 5));
  assert.deepEqual(
    rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id)),
    Array.from({ length: 8 }, (_, i) => `media:pick:abcdefghijklmnop:${i + 1}`),
  );
});
test('Pinterest search previews allow original Pin links and reject hostile lookalikes or private account pages', () => {
  const payload = outcomePayload({
    status: 'completed',
    action: 'image.search',
    result: {
      provider: 'Pinterest public partner search',
      searchId: 'abcdefghijklmnop',
      results: [
        {
          index: 1,
          title: 'Public flower',
          license: 'Creator rights apply',
          source: 'https://www.pinterest.com/pin/123456/',
        },
        {
          index: 2,
          title: 'Hostile',
          license: 'x',
          source: 'https://www.pinterest.com.evil.test/pin/123456/',
        },
        { index: 3, title: 'Account page', license: 'x', source: 'https://www.pinterest.com/private-board/' },
      ],
    },
  });
  assert.match(String(payload.content), /Pinterest · 1 results/);
  assert.doesNotMatch(String(payload.content), /Hostile|Account page/);
});
