export type VoiceFollowUp = 'confirmation' | 'clarification' | 'message-content' | 'none';
export interface VoiceTurnMeta {
  kind: 'wake' | 'follow-up';
  addressing?: 'name' | 'vocative' | 'phonetic';
  previousRequest?: string;
  previousResponse?: string;
  /** One admitted answer to a posting-content clarification; its text is data, not a new command. */
  contentMode?: 'message';
  /** Same-speaker attention admitted by the consented session's bounded conversation gate. */
  attention?: 'conversation';
  quoted?: boolean;
}
export interface VoiceReply {
  text: string;
  followUp?: VoiceFollowUp;
  /** Verified action receipts, so speech failure cannot imply the remote change failed. */
  completedActions?: readonly string[];
}
interface Turn {
  request: string;
  response: string;
  expectation: VoiceFollowUp | 'request';
  expiresAt: number;
  hardExpiresAt: number;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalized = (value: string) => value.normalize('NFKC').trim();
const directRequest =
  /^(?:(?:hey|hi|hello|okay|ok|yo)[,!.?]?\s+){0,2}(?:(?:can|could|would|will|do|did|are|have)\s+you\b|(?:what|how|why|when|where|who)\b|(?:please\s+)?(?:help|tell|show|explain|repeat|say|type|write|send|post|create|make|change|rename|delete|remove|add|set|move|join|leave|play|pause|stop|skip|search|find|look up|confirm|cancel|remind|schedule)\b)/i;
const thirdPerson =
  /^(?:(?:is|was|has|does|can|will|would|should)(?!\s+(?:you|it|this|that)\b)|isn't|wasn't|doesn't|seems|looks|sounds|keeps)\b/i;
const directAction =
  /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:help|tell|show|explain|say|type|write|send|post|create|make|change|rename|delete|remove|add|set|move|join|leave|play|pause|stop|skip|search|find|look up|confirm|cancel|remind|schedule)\b/i;
const quotedText = /^(?:"[^]*"|'[^]*'|“[^]*”|‘[^]*’|`[^]*`)$/;
const closing =
  /^(?:bye|goodbye|good bye|that'?s all|that is all|talk to you later|stop listening|go quiet)[.!?]*$/i;
// The session's original ten-minute consent remains the outer authority; attention adds no earlier cut-off.
const MAX_ATTENTION_MS = 600000;

/** Attention is conversational, but explicitly other-directed speech and noise do not renew it. */
export function conversationalAttentionAnswer(raw: string): boolean {
  const text = normalized(raw);
  if (!text || text.length > 600 || /^(?:\[[^\]]*\]|\([^)]*\)|[.?!,\s]+)$/.test(text)) return false;
  if (
    /\b(?:not talking to you|talking to someone else|wasn'?t (?:for|talking to) you|was not (?:for|talking to) you)\b/i.test(
      text,
    )
  )
    return false;
  if (
    /^(?:(?:hey|hi|yo)\s+)?(?!(?:vibe|you|what|how|why|where|when|who|can|could|would|will|are|do|did|have|it|that|this|please|okay|ok)\b)[\p{L}][\p{L}'-]{1,30}[, ]+\s*(?:can|could|would|will|are|do|did|have)\s+you\b/iu.test(
      text,
    )
  )
    return false;
  return true;
}

export function isMessageContentQuestion(response: string, request = ''): boolean {
  return (
    /\?/.test(response) &&
    /\b(?:what|which)\b[^?]{0,100}\b(?:say|send|post|write|type|message|text|content)\b/i.test(response) &&
    (/\b(?:message|text|content|channel)\b|#[\p{L}\p{N}_-]+/iu.test(response) ||
      /\b(?:send|post)\b|\b(?:type|write|say)\b[^.?!]{0,120}\b(?:in|into|to)\b/i.test(request))
  );
}
/** Unquoted new requests/ambient clauses require a name; quoted or explicitly dictated text stays data. */
export function messageContentAnswer(raw: string): string | undefined {
  let text = normalized(raw);
  if (!text || text.length > 300 || text.split(/\s+/).length > 50) return;
  const quoted = quotedText.test(text);
  const dictated = /^(?:the message (?:is|should say)|it should say|say)[:,]?\s+/i;
  const explicit = quoted || dictated.test(text);
  if (quoted) text = text.slice(1, -1).trim();
  else if (dictated.test(text)) text = text.replace(dictated, '').trim();
  if (!text) return;
  if (
    !explicit &&
    (/^(?:(?:can|could|would|will) you\b|please\b|(?:actually[, ]+)?(?:create|delete|remove|add|ban|kick|mute|send|post|type|write|change|set|rename|search|find|play|stop|join|leave|schedule|remind)\b)/i.test(
      text,
    ) ||
      /^(?:what|why|who|where|when|how|we|they|he|she|my|our|let'?s|i (?:think|went|was|am|have|had))\b|\?/i.test(
        text,
      ))
  )
    return;
  return text;
}

/** A short, per-speaker turn reference, never an open-ended ambient conversation mode. */
export class VoiceConversation {
  private readonly turns = new Map<string, Turn>();
  private readonly attentionStarts = new Map<string, number>();
  private readonly wake: RegExp;
  private readonly trailingWake: RegExp;
  private readonly infixWake: RegExp;
  private readonly phoneticWake: RegExp | undefined;
  private readonly variantWake: RegExp | undefined;
  private readonly fusedWake: RegExp;
  readonly windowMs: number;
  constructor(options: { botName?: string; wakeWords?: readonly string[]; followUpSeconds?: number } = {}) {
    const words = [
      ...new Set(
        [options.botName ?? 'Vibe', ...(options.wakeWords ?? [])]
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 32),
      ),
    ];
    this.wake = new RegExp(
      `^(?:(?:hey|hi|hello|okay|ok|yo|um|uh)[,!.?]?\\s+){0,3}(?:${words.map(escape).join('|')})(?=$|[^\\p{L}\\p{N}_])[,!:.?]?\\s*`,
      'iu',
    );
    const names = words.map(escape).join('|');
    this.fusedWake = new RegExp(`^(?:${names})(?=[\\p{L}])`, 'iu');
    this.trailingWake = new RegExp(`(?:,|\\s)+(?:${names})[,!.?]*\\s*(?:please[.!?]*)?$`, 'iu');
    this.infixWake = new RegExp(`,\\s*(?:${names})\\s*,`, 'iu');
    this.phoneticWake = words.some((word) => word.toLowerCase() === 'vibe')
      ? /^(?:(?:hey|hi|hello|okay|ok|yo|um|uh)[,!.?]?\s+){0,3}(?:bibe|vybe|vibes|five)(?=$|[^\p{L}\p{N}_])[,!:.?]?\s*/iu
      : undefined;
    this.variantWake = words.some((word) => word.toLowerCase() === 'vibe')
      ? /^(?:(?:your|yo)\s*vibe|viber)(?=$|[^\p{L}\p{N}_])[,!:.?]?\s*/iu
      : undefined;
    const seconds = options.followUpSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 60)
      throw new Error('Voice follow-up window must be between 5 and 60 seconds.');
    this.windowMs = seconds * 1000;
  }
  private openAttention(userId: string, now: number): void {
    this.turns.delete(userId);
    if (this.attentionStarts.size >= 50 && !this.attentionStarts.has(userId))
      this.clear(this.attentionStarts.keys().next().value!);
    this.attentionStarts.set(userId, now);
  }
  private addressedRequest(
    userId: string,
    request: string,
    now: number,
    addressing: 'name' | 'vocative' | 'phonetic',
  ): { text: string } & VoiceTurnMeta {
    this.openAttention(userId, now);
    const quoted = quotedText.test(request);
    return {
      text: quoted ? request.slice(1, -1).trim() : request,
      kind: 'wake',
      addressing,
      ...(quoted ? { quoted: true } : {}),
    };
  }
  select(userId: string, raw: string, now: number): ({ text: string } & VoiceTurnMeta) | undefined {
    const text = normalized(raw).slice(0, 4000),
      addressed = text.replace(/^>{2,}\s*/, ''),
      match = this.wake.exec(addressed);
    if (match) {
      const request = addressed.slice(match[0].length).trim();
      if (thirdPerson.test(request)) return;
      return this.addressedRequest(userId, request, now, 'name');
    }
    if (directRequest.test(text)) {
      const trailing = this.trailingWake.exec(text),
        infix = this.infixWake.exec(text);
      if (trailing || infix) {
        const request = trailing
          ? text.slice(0, trailing.index).trim()
          : text.replace(this.infixWake, ' ').replace(/\s+/g, ' ').trim();
        if (trailing && /\b(?:about|called|named|to|from|with|by|for)\s*$/i.test(request)) return;
        return this.addressedRequest(userId, request, now, 'vocative');
      }
    }
    const phonetic = this.phoneticWake?.exec(addressed);
    if (phonetic) {
      const request = addressed.slice(phonetic[0].length).trim();
      if (directRequest.test(request)) {
        return this.addressedRequest(userId, request, now, 'phonetic');
      }
    }
    const variant = this.variantWake?.exec(addressed),
      fused = this.fusedWake.exec(addressed);
    if (variant || fused) {
      const match = variant ?? fused!,
        request = addressed.slice(match[0].length).trim();
      if (
        (variant && directAction.test(request)) ||
        (fused && (directRequest.test(request) || /^(?:hello|hi|hey)\b/i.test(request)))
      ) {
        return this.addressedRequest(userId, request, now, 'phonetic');
      }
    }
    const turn = this.turns.get(userId);
    if (!turn) return;
    if (turn.expiresAt <= now) {
      this.clear(userId);
      return;
    }
    if (!text || text.length > 600) return;
    if (turn.expectation === 'message-content') {
      const content = messageContentAnswer(text);
      if (content === undefined) return;
      this.turns.delete(userId);
      return {
        text: content,
        kind: 'follow-up',
        contentMode: 'message',
        attention: 'conversation',
        previousRequest: turn.request,
        previousResponse: turn.response,
      };
    }
    if (!conversationalAttentionAnswer(text)) return;
    const quoted = quotedText.test(text);
    this.turns.delete(userId);
    return {
      text: quoted ? text.slice(1, -1).trim() : text,
      kind: 'follow-up',
      attention: 'conversation',
      ...(quoted ? { quoted: true } : {}),
      previousRequest: turn.request,
      previousResponse: turn.response,
    };
  }
  complete(userId: string, request: string, reply: string | VoiceReply, now: number, playbackMs = 0): void {
    const text = typeof reply === 'string' ? reply : reply.text;
    if (!text.trim() || closing.test(request)) {
      this.clear(userId);
      return;
    }
    const supplied = typeof reply === 'string' ? undefined : reply.followUp;
    const expectation =
      ((supplied === undefined || supplied === 'clarification') && isMessageContentQuestion(text, request)
        ? 'message-content'
        : supplied) ??
      (/\b(?:please confirm|awaiting confirmation|confirm (?:this|that|the)|approve (?:this|the)|pending confirmation)\b/i.test(
        text,
      )
        ? 'confirmation'
        : /\?/.test(text)
          ? 'clarification'
          : 'none');
    const started = this.attentionStarts.get(userId) ?? now,
      hardExpiresAt = started + MAX_ATTENTION_MS;
    this.turns.delete(userId);
    this.prune(now);
    if (hardExpiresAt <= now) {
      this.clear(userId);
      return;
    }
    if (!this.attentionStarts.has(userId)) this.openAttention(userId, started);
    if (this.turns.size >= 50) this.clear(this.turns.keys().next().value!);
    this.turns.set(userId, {
      request: request.slice(0, 1000),
      response: text.slice(0, 1500),
      expectation: request === 'called your name' ? 'request' : expectation,
      expiresAt: Math.min(hardExpiresAt, now + Math.max(0, Math.min(playbackMs, 120000)) + this.windowMs),
      hardExpiresAt,
    });
  }
  playbackComplete(userId: string, now: number): void {
    const turn = this.turns.get(userId);
    if (turn) turn.expiresAt = Math.min(turn.hardExpiresAt, now + this.windowMs);
  }
  followUpActive(userId: string, now: number): boolean {
    return (this.turns.get(userId)?.expiresAt ?? -Infinity) > now;
  }
  prune(now: number): void {
    for (const [id, turn] of this.turns) if (turn.expiresAt <= now) this.clear(id);
    for (const [id, started] of this.attentionStarts) if (started + MAX_ATTENTION_MS <= now) this.clear(id);
  }
  clear(userId?: string): void {
    if (userId === undefined) {
      this.turns.clear();
      this.attentionStarts.clear();
    } else {
      this.turns.delete(userId);
      this.attentionStarts.delete(userId);
    }
  }
}
