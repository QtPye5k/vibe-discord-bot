import {
  conversationalAttentionAnswer,
  isMessageContentQuestion,
  messageContentAnswer,
  type VoiceTurnMeta,
} from './conversation.js';

const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .trim()
    .slice(0, 4000);

// These are capability boundaries, not a second conversational model. Requests
// involving Discord state, external information or media need the guarded tools.
const toolRequest = [
  /\b(?:what can you do|how can you help|your (?:abilities|features|capabilities))\b/,
  /\b(?:servers?|guilds?|channels?|threads?|roles?|permissions?|members?|invites?|webhooks?|messages?|moderation|automod|timeouts?|slowmode|audit logs?|emojis?|stickers?|avatars?|banners?|boosts?|stage|transcripts?|recordings?|slash commands?)\b/,
  /\b(?:events?|calendars?|reminders?|timers?|polls?|giveaways?|tickets?|birthdays?|leaderboards?|subscriptions?|integrations?)\b/,
  /\b(?:ban|unban|kick|mute|unmute|deafen|undeafen|purge|prune|lock|unlock|pin|unpin|react|join|disconnect|leave|rename|schedule|remind|announce|send|post|upload|download|export|import|configure|enable|disable|reset|restore|back ?up)\b/,
  /\b(?:search|look\s*up|find|browse|website|web ?page|url|links?|https?|spotify|youtube|twitch|weather|forecast|news|stocks?|exchange rates?|prices?|scores?|standings|fixtures)\b/,
  /\b(?:latest|up[- ]to[- ]date|real[- ]time)\b|\b(?:current|today'?s|tonight'?s)\s+(?:time|date|weather|news|score|price|events?|games?|schedule)\b/,
  /\b(?:play|pause|resume|skip|stop|queue|shuffle|loop|volume|music|songs?|tracks?|playlists?|podcasts?|videos?|images?|pictures?|photos?|memes?|screenshots?|files?|documents?|pdfs?)\b/,
  /\b(?:voice chat|voice channel|vc|my (?:settings|preferences|history|tasks|balance|account)|your (?:commands|capabilities))\b/,
  /\b(?:type|write|say)\b[^.?!]{0,120}\b(?:in|into|to)\b/,
  /\b(?:change|set|make|turn|colour|color)\b[^.?!]{0,100}\b(?:rules?|purple|red|blue|green|pink|yellow|orange|violet|teal|cyan|gold|silver)\b/,
];
const conversational =
  /^(?:(?:can|could|would|will) you\s+)?(?:hello\b|hi\b|hey\b|good (?:morning|afternoon|evening)\b|how are you\b|what(?:'s| is) up\b|thank(?:s| you)\b|you(?:'re| are) welcome\b|your voice\b|(?:talk|chat) (?:to|with) me\b|(?:tell me|explain|describe|teach me|help me (?:think|understand|decide))\b|(?:what|why|how|who|where|when)\b|i (?:feel|am|had|like|love|hope)\b)/;
const creative = /\b(?:poem|poetry|story|joke|riddle|haiku|limerick|fairy tale)\b/;
const conversationalAnswer =
  /^(?:i(?:'m|'ve|'d|'ll)|it(?:'s| is)|that(?:'s| is)|there(?:'s| is)|we(?:'re| are)|not (?:bad|really|much)|pretty (?:good|well)|good|great|fine|awesome|okay|ok|yeah|yes|no|nope|sure|sounds|absolutely|nice|me too|same here|so far|doing|nothing)\b/;
const mutationRequest =
  /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:delete|remove|add|change|set|rename|move|turn|switch|toggle|update|edit|give|grant|revoke|allow|deny)\b/;
function requestNeedsTools(text: string): boolean {
  if (!text) return false;
  if (mutationRequest.test(text) || toolRequest.some((rule) => rule.test(text))) return true;
  // Only clearly conversational requests use the tool-free renderer. An unfamiliar action still
  // belongs to the planner, which can resolve actual targets or ask one meaningful clarification.
  return !conversational.test(text) && !conversationalAnswer.test(text) && !creative.test(text);
}

const confirmation =
  /^(?:(?:yes|yeah|yep|correct|right|no|nope|okay|ok|that's right|that is right|go ahead|do it|please do|never mind|nevermind)|(?:confirm|approve|cancel)(?:\s+[^?!]{1,100})?)[.!?]*$/;
const confirmationPrompt =
  /\b(?:confirm|confirmation|approve|approval|proceed|go ahead|are you sure|should i|shall i|do you want|is that (?:right|correct))\b/;
const anaphoric = [
  /^(?:please )?(?:explain|repeat|clarify)(?: (?:that|it|this|the last(?: part| answer| response)))?[.!?]*$/,
  /^(?:(?:can|could|would) you )?(?:please )?(?:explain|repeat|clarify) (?:that|it|this|the last(?: part| answer| response))[.!?]*$/,
  /^(?:tell me more|go on|keep going|continue|say (?:that|it) again|repeat what you said|why|why not)[.!?]*$/,
  /^(?:(?:and|but) )?(?:how (?:does|did|would|will|can) (?:it|that|this|they|those) (?:work|happen|help)|why (?:is|was|does|did|would) (?:it|that|this|he|she|they)\b[^?!]{0,50}|who (?:is|was|are|were) (?:that|this|he|she|they)|what (?:is|was|are|were|does|did) (?:it|that|this|those|they)(?: (?:mean|do|for|about))?|where (?:is|was|are|were) (?:it|that|this|they|those))[.!?]*$/,
];
const directRevision =
  /^(?:please )?(?:make it|change (?:it|that|this) to|use (?:that|this|the (?:first|second|third|last)(?: one)?)(?: instead)?|not (?:that|this)(?: one)?|i (?:mean|meant))\b/;
const contextualQuestion =
  /^(?:(?:and|but) )?(?:(?:what|how) about|tell me more about|(?:please )?(?:explain|clarify)|(?:can|could|would) you (?:explain|clarify))\b/;
const timeValue =
  /\b(?:today|tomorrow|tonight|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekends?|noon|midnight|am|pm|est|edt|cst|cdt|mst|mdt|pst|pdt|utc|gmt|minutes?|hours?|days?|weeks?)\b|\b\d{1,4}(?::\d{2})?(?:\s*[ap]m)?\b/;
const temporalContext = /\b(?:events?|schedule|when|time|date|day|duration|long|timezone|reminder|timer)\b/;
const ambientClause = /\b(?:we|they|he|she|my|our|their)\b|\bi (?!want\b|mean\b|meant\b|prefer\b)/;
const unrelatedOpening =
  /^(?:what|why|who|where|when|how|let's|lets|we|they|he|she|my|our|i (?:think|went|was|am|have|had|like))\b/;
const newInstruction =
  /^(?:(?:can|could|would) you |please )?(?:create|delete|remove|add|ban|unban|kick|mute|unmute|send|post|search|find|look\s*up|play|pause|skip|join|leave|rename|schedule|remind|download|upload)\b/;
const stopWords = new Set(
  'a an the and but or of to for from in on at by with without about is are was were be been being it its that this those these they them you your yours i me my we our us he him his she her their does did do can could will would should shall may might have has had please just now then really also more some any all as if what which how who where when why tell say explain know mean work first second third last one two three yes no okay ok done change create make set use rename want called name title time date option choice confirm approve cancel response request previous new last'.split(
    ' ',
  ),
);
const topicWords = (text: string) =>
  new Set(
    (text.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
      .filter((word) => word.length > 2 && !stopWords.has(word)),
  );

function sharesTopic(text: string, previous: string): boolean {
  const known = topicWords(previous);
  return [...topicWords(text)].some((word) => known.has(word));
}

function clarificationAnswer(text: string, response: string): boolean {
  if (!response.includes('?') || text.length > 180 || text.split(/\s+/).length > 25) return false;
  // A short value may answer a requested field. A new conversational sentence
  // does not become a field value merely because it is short.
  const value = text.replace(/^(?:actually[, ]+|(?:i want|i prefer|make it|use|at|on)\s+)/, '');
  if (
    unrelatedOpening.test(value) ||
    newInstruction.test(value) ||
    ambientClause.test(value) ||
    /[?]/.test(value)
  )
    return false;
  if (/\b(?:when|time|date|day|duration|long|timezone)\b/.test(response) && timeValue.test(value))
    return true;
  if (/\b(?:name|title|role|colou?r|call it|call the|spelling)\b/.test(response))
    return value.split(/\s+/).length <= 5;
  if (/\b(?:channel|voice|vc|location)\b/.test(response))
    return value.split(/\s+/).length <= 5 && /^[\p{L}\p{N}_# -]+[.!]?$/u.test(value);
  if (/\b(?:visibility|public|private|audience|invite|everyone|members|attend)\b/.test(response))
    return /^(?:public|private|everyone|members(?: only)?|friends(?: only)?|only me|(?:the )?(?:whole |entire )?server)[.!]*$/.test(
      value,
    );
  if (/\b(?:which|choose|option|number|one)\b/.test(response))
    return (
      /^(?:the )?(?:first|second|third|last|\d{1,3})(?: one| option)?[.!]*$/.test(value) ||
      (value.split(/\s+/).length <= 3 && sharesTopic(value, response))
    );
  return false;
}

/** Reject ambient topic changes after the name gate has selected a candidate. */
export function isRelatedVoiceFollowUp(meta: VoiceTurnMeta, raw: string): boolean {
  if (meta.kind === 'wake') return true;
  const text = normalize(raw),
    request = normalize(meta.previousRequest ?? ''),
    response = normalize(meta.previousResponse ?? ''),
    previous = `${request} ${response}`;
  if (!text || !request) return false;
  if (meta.quoted) return text.length <= 600;
  if (meta.contentMode === 'message') return isMessageContentQuestion(response, request);
  if (meta.attention === 'conversation') return conversationalAttentionAnswer(raw);
  if (text.length > 300) return false;
  if (isMessageContentQuestion(response, request)) return messageContentAnswer(raw) !== undefined;
  if (request === 'called your name') return true;
  if (confirmation.test(text))
    return (
      confirmationPrompt.test(response) ||
      response.includes('?') ||
      toolRequest.some((rule) => rule.test(request))
    );
  if (anaphoric.some((rule) => rule.test(text))) return true;
  if (directRevision.test(text)) return !ambientClause.test(text);
  if (contextualQuestion.test(text)) {
    if (sharesTopic(text, previous)) return true;
    return temporalContext.test(previous) && timeValue.test(text) && !ambientClause.test(text);
  }
  if (clarificationAnswer(text, response)) return true;
  // "Actually, the announcements channel" can revise the named object; a
  // different ambient statement with no shared object is ignored.
  return (
    /^(?:actually|instead|not that)[, ]/.test(text) &&
    !ambientClause.test(text) &&
    sharesTopic(text, previous)
  );
}

/** Keep ordinary conversation on Realtime; stateful work uses guarded AI tools. */
export function voiceRequestNeedsTools(raw: string, meta?: VoiceTurnMeta): boolean {
  const text = normalize(raw);
  if (meta?.quoted) return false;
  if (meta?.kind === 'follow-up') {
    if (!isRelatedVoiceFollowUp(meta, text)) return false;
    if (meta.attention === 'conversation' && meta.contentMode !== 'message') {
      if (
        confirmation.test(text) ||
        anaphoric.some((rule) => rule.test(text)) ||
        directRevision.test(text) ||
        clarificationAnswer(text, normalize(meta.previousResponse ?? ''))
      )
        return requestNeedsTools(normalize(meta.previousRequest ?? ''));
      return requestNeedsTools(text);
    }
    return meta.contentMode === 'message' || requestNeedsTools(normalize(meta.previousRequest ?? ''));
  }
  return requestNeedsTools(text);
}
