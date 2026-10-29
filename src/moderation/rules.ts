/** Strict host policy rules; pure and independent of credentials, network or model scores. */
export interface RuleMessage {
  content?: string | null;
  embeds?: readonly {
    title?: string | null;
    description?: string | null;
    author?: { name?: string | null } | null;
    footer?: { text?: string | null } | null;
    fields?: readonly { name?: string | null; value?: string | null }[];
    url?: string | null;
    provider?: { url?: string | null } | null;
  }[];
}
export interface ContentRuleMatch {
  remove: boolean;
  categories: string[];
}
const ADULT_DOMAINS = new Set([
  'xvideos.com',
  'pornhub.com',
  'xnxx.com',
  'xhamster.com',
  'redtube.com',
  'youporn.com',
  'spankbang.com',
  'eporner.com',
  'tube8.com',
  'youporn.xxx',
  'porn.com',
]);
const REDIRECT_PARAMETERS = new Set(['q', 'url', 'u', 'target', 'redirect']);
const SLUR = /(?<![\p{L}\p{N}_])(?:nigg(?:er|a)s?|coons?|faggots?|retards?|retarded)(?![\p{L}\p{N}_])/u;
const SEXUAL_ABUSE =
  /(?<![\p{L}\p{N}_])(?:rap(?:e|es|ed|ing|ists?)|incest|bestiality|molest(?:s|ed|ing|ers?|ation)?|child\s+(?:porn(?:ography)?|sex)|sexual(?:ly)?\s+(?:assault(?:s|ed|ing)?|abus(?:e|ed|ing)))(?![\p{L}\p{N}_])/u;
const ADULT_PROMOTION =
  /(?<![\p{L}\p{N}_])(?:(?:free|watch|stream|hd|xxx)\s+(?:[a-z]+\s+){0,2}(?:porn(?:ography|ographic)?|sex|nudes?)|(?:porn(?:ographic)?|xxx|sex)\s+(?:videos?|movies?|clips?|cams?|webcams?|chat|streams?))(?![\p{L}\p{N}_])/u;
function visible(value: string): string {
  return value.normalize('NFKC').replace(/\p{Cf}/gu, '');
}
/** Normalize compatibility glyphs, invisible formatting, accents and common in-word substitutions. */
function normalized(value: string): string {
  const digits: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '2': 'z',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '6': 'g',
    '7': 't',
    '8': 'b',
    '9': 'g',
  };
  return visible(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0-9]/g, (value) => digits[value]!)
    .replace(/(?<=\p{L})[@$!|](?=\p{L})/gu, (value) => (value === '@' ? 'a' : value === '$' ? 's' : 'i'));
}
function fields(message: RuleMessage): string[] {
  const values: string[] = [];
  const add = (value: string | null | undefined, limit: number) => {
    if (typeof value === 'string' && value.trim()) values.push(value.slice(0, limit));
  };
  add(message.content, 4000);
  for (const embed of message.embeds?.slice(0, 10) ?? []) {
    add(embed.title, 256);
    add(embed.description, 4096);
    add(embed.author?.name, 256);
    add(embed.footer?.text, 2048);
    for (const field of embed.fields?.slice(0, 25) ?? []) {
      add(field.name, 256);
      add(field.value, 1024);
    }
    add(embed.url, 4096);
    add(embed.provider?.url, 4096);
  }
  return values;
}
/** Text includes link-preview metadata, which can explain an otherwise opaque redirect URL. */
export function moderationContentText(message: RuleMessage): { text: string; truncated: boolean } {
  const full = fields(message).join('\n');
  return {
    text: full.slice(0, 12000),
    truncated: full.length > 12000 || (message.content?.length ?? 0) > 4000,
  };
}
function urls(value: string): string[] {
  return [
    ...visible(value).matchAll(
      /https?:\/\/[^\s<>"'()]+|(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:[/?#][^\s<>"'()]*)?/gi,
    ),
  ]
    .slice(0, 30)
    .map((match) => match[0].replace(/[.,!?;:]+$/, ''));
}
function decodeClear(value: string): string {
  let decoded = value.slice(0, 8192);
  for (let pass = 0; pass < 2 && /%[0-9a-f]{2}/i.test(decoded); pass++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}
function adultHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return [...ADULT_DOMAINS].some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}
export function matchContentRules(message: RuleMessage): ContentRuleMatch {
  const categories = new Set<string>();
  const inspect = (value: string) => {
    const text = normalized(value);
    if (SLUR.test(text)) categories.add('policy/slur');
    if (SEXUAL_ABUSE.test(text)) categories.add('policy/sexual-abuse');
    if (ADULT_PROMOTION.test(text)) categories.add('policy/adult-promotion');
  };
  for (const field of fields(message)) {
    inspect(field);
    const pending = urls(field).map((value) => ({ value, depth: 0 }));
    for (let index = 0; index < pending.length && index < 30; index++) {
      const item = pending[index]!;
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(item.value) ? item.value : `https://${item.value}`);
      } catch {
        continue;
      }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (adultHost(url.hostname)) categories.add('policy/adult-domain');
      if (item.depth >= 3) continue;
      for (const [key, value] of url.searchParams) {
        if (!REDIRECT_PARAMETERS.has(key.toLowerCase())) continue;
        // URLSearchParams already removes one percent-encoding layer. Never decode opaque base64 blobs.
        const clear = decodeClear(value);
        inspect(clear);
        pending.push(...urls(clear).map((value) => ({ value, depth: item.depth + 1 })));
      }
    }
  }
  return { remove: categories.size > 0, categories: [...categories] };
}
