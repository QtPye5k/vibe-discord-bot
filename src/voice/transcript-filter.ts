/** Known ASR non-speech labels. Bare words remain speech; only complete delimited labels are discarded. */
const nonSpeech = new Set([
  'blank audio',
  'no speech',
  'no audio',
  'silence',
  'silent',
  'inaudible',
  'unintelligible',
  'unintelligible speech',
  'background noise',
  'noise',
  'static',
  'music',
  'background music',
  'instrumental music',
  'applause',
  'clapping',
  'laughter',
  'laughing',
  'laughs',
  'laugh',
  'chuckles',
  'chuckling',
  'giggles',
  'giggling',
  'cough',
  'coughs',
  'coughing',
  'sigh',
  'sighs',
  'sighing',
  'breath',
  'breathing',
  'heavy breathing',
  'sniff',
  'sniffs',
  'sniffing',
  'sniffles',
  'clears throat',
  'clearing throat',
  'throat clearing',
  'yawn',
  'yawns',
  'yawning',
  'shh',
  'shhh',
  'shhhh',
  'shushing',
  'blows kiss',
  'blows a kiss',
  'blowing a kiss',
  'kiss',
  'kissing',
  'lips smacking',
  'lip smacking',
  'smacks lips',
]);
const specialTokens = new Set(['nospeech', 'no speech', 'endoftext', 'notimestamps']);
/**
 * Discard a pure non-speech annotation sequence, not unfamiliar language or short commands.
 * Recognized labels embedded in real speech (including quoted labels) remain unchanged.
 */
export function filterTranscription(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  let markers = 0;
  const remainder = trimmed
    .normalize('NFKC')
    .replace(/\[[^\[\]\r\n]{1,100}\]|\([^()\r\n]{1,100}\)|<\|[A-Za-z_ -]{1,60}\|>/gu, (token) => {
      const special = token.startsWith('<|'),
        name = token
          .slice(special ? 2 : 1, special ? -2 : -1)
          .trim()
          .toLowerCase()
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ');
      if (!(special ? specialTokens : nonSpeech).has(name)) return token;
      markers++;
      return '';
    });
  return markers > 0 && /^[\s.,!?;:…\-–—_*]*$/u.test(remainder) ? '' : trimmed;
}
