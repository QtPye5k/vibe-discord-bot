import test from 'node:test';
import assert from 'node:assert/strict';
import { matchContentRules, moderationContentText } from '../src/moderation/rules.js';

test('Strict slur and sexual-abuse policy applies immediately to the first standalone term', () => {
  for (const term of ['nigger', 'coon', 'faggot', 'retard', 'rape', 'raped', 'rapist']) {
    const result = matchContentRules({ content: term });
    assert.equal(result.remove, true, term);
    assert(result.categories.includes(term.startsWith('rap') ? 'policy/sexual-abuse' : 'policy/slur'));
    assert(!JSON.stringify(result).includes(term));
  }
});

test('NFKC, zero-width and common leetspeak variants preserve strict lexical matching', () => {
  for (const term of ['ＮＩＧＧＥＲ', 'n\u200bigg3r', 'n!gger', 'c00n', 'f@gg0t', 'r3t4rd', 'n1gg3r']) {
    assert.equal(matchContentRules({ content: `(${term}!)` }).remove, true, term);
  }
});

test('Word boundaries preserve unrelated words and ordinary profanity is not a local deletion rule', () => {
  for (const content of [
    'raccoon',
    'raccoons',
    'coonhound',
    'retardant',
    'retardation',
    'grape',
    'drape',
    'scrape',
    'therapist',
    'fuck',
    'shit',
    'damn',
    'ass',
  ])
    assert.deepEqual(matchContentRules({ content }), { remove: false, categories: [] }, content);
});

test('Opaque Google redirects are covered by embedded titles and descriptions without decoding or fetching the destination', () => {
  const result = matchContentRules({
    content: 'https://www.google.com/goto?url=CAESopaquevalue',
    embeds: [
      {
        title: 'Free Porn Videos - XVIDEOS.COM',
        description: 'XVIDEOS Free Porn Videos',
        url: 'https://www.google.com/goto?url=CAESopaquevalue',
      },
    ],
  });
  assert.equal(result.remove, true);
  assert(result.categories.includes('policy/adult-promotion'));
  assert(result.categories.includes('policy/adult-domain'));
  assert.deepEqual(matchContentRules({ content: 'https://www.google.com/goto?url=CAESopaquevalue' }), {
    remove: false,
    categories: [],
  });
});

test('All requested embed metadata fields participate in local rules and semantic text', () => {
  for (const embed of [
    { title: 'Free Porn Videos' },
    { description: 'Free Porn Videos' },
    { author: { name: 'Free Porn Videos' } },
    { footer: { text: 'Free Porn Videos' } },
    { fields: [{ name: 'Free Porn Videos', value: 'Description' }] },
    { fields: [{ name: 'Description', value: 'Free Porn Videos' }] },
    { fields: [{ name: 'Message', value: 'faggot' }] },
    { fields: [{ name: 'Link', value: 'https://xvideos.com' }] },
    { url: 'https://www.xvideos.com/video' },
    { provider: { url: 'https://xvideos.com' } },
  ]) {
    assert.equal(matchContentRules({ embeds: [embed] }).remove, true);
    assert(moderationContentText({ embeds: [embed] }).text.length > 0);
  }
});

test('Adult host rules match exact/subdomain boundaries rather than usernames and lookalike hosts', () => {
  for (const content of [
    'https://xvideos.com/video',
    'https://www.xvideos.com/video',
    'XVIDEOS.COM',
    'https://pornhub.com',
  ])
    assert(matchContentRules({ content }).categories.includes('policy/adult-domain'), content);
  for (const content of [
    'https://notxvideos.com/video',
    'https://xvideos.com.evil.example/video',
    'https://xvideos.com@ordinary.example/path',
    'https://ordinary.example/path?name=xvideos.com',
  ])
    assert.deepEqual(matchContentRules({ content }), { remove: false, categories: [] }, content);
});

test('Clear nested URL parameters are decoded locally with bounded recursion; arbitrary parameters are not followed', () => {
  for (const key of ['q', 'url', 'u', 'target', 'redirect']) {
    const content = `https://www.google.com/url?${key}=${encodeURIComponent(encodeURIComponent('https://www.xvideos.com/video'))}`;
    assert(matchContentRules({ content }).categories.includes('policy/adult-domain'), key);
  }
  assert(
    matchContentRules({
      content:
        'https://example.com/?url=https%3A%2F%2Fother.example%2F%3Ftarget%3Dhttps%253A%252F%252Fxvideos.com',
    }).remove,
  );
  assert.deepEqual(matchContentRules({ content: 'https://example.com/?q=%E0%A4%A' }), {
    remove: false,
    categories: [],
  });
});

test('Semantic text combines content and metadata under a bounded aggregate', () => {
  assert.deepEqual(
    moderationContentText({
      content: 'Caption',
      embeds: [
        {
          title: 'Title',
          description: 'Description',
          author: { name: 'Author' },
          footer: { text: 'Footer' },
          url: 'https://example.com',
          provider: { url: 'https://provider.example' },
        },
      ],
    }),
    {
      text: 'Caption\nTitle\nDescription\nAuthor\nFooter\nhttps://example.com\nhttps://provider.example',
      truncated: false,
    },
  );
  const large = moderationContentText({
    content: 'a'.repeat(4001),
    embeds: Array.from({ length: 10 }, () => ({ description: 'b'.repeat(4096) })),
  });
  assert.equal(large.text.length, 12000);
  assert.equal(large.truncated, true);
});
