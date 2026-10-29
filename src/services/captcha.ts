import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry } from '../core/registry.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { publicOrigin, readBody, HttpError, jsonResponse } from '../core/http.js';
import { providerHttp, providerJson, type ProviderTransport } from '../integrations/http.js';
interface CaptchaFlow {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  version: string;
  epoch: number;
  expiresAt: number;
  cookieHash?: string;
  state: 'created' | 'presented' | 'checking' | 'passed';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function createCaptchaService(options: {
  env: NodeJS.ProcessEnv;
  store: Store;
  registry: ActionRegistry;
  transport?: ProviderTransport;
  now?: () => number;
}) {
  const { env, store, registry } = options,
    now = options.now ?? Date.now;
  let base: URL | undefined,
    closed = false,
    active = 0;
  try {
    if (env.APP_PUBLIC_URL) base = publicOrigin(env.APP_PUBLIC_URL);
  } catch {
    /* Optional invalid origin disables this capability. */
  }
  const available = () => !closed && !!base && !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY;
  const proofKey = (ctx: ActionContext) => `${ctx.guild.id}:${ctx.member.id}:${ctx.channelId}`;
  const policy = (guildId: string) =>
    store.get<{ version?: string; captchaRequired?: boolean }>('ui.verification', guildId);
  const valid = (flow: CaptchaFlow, state: CaptchaFlow['state']) =>
    !closed &&
    flow.expiresAt > now() &&
    store.get<CaptchaFlow>('captcha.flows', flow.id)?.state === state &&
    policy(flow.guildId)?.version === flow.version &&
    (store.get<number>('core.featureEpochs', `${flow.guildId}:interfaces`) ?? 0) === flow.epoch &&
    !(store.get<string[]>('core.disabled', flow.guildId) ?? []).includes('interfaces');
  function prune() {
    for (const row of store.list<CaptchaFlow>('captcha.flows'))
      if (row.value.expiresAt <= now()) store.delete('captcha.flows', row.key);
    for (const row of store.list<{ expiresAt: number }>('captcha.proofs'))
      if (row.value.expiresAt <= now()) store.delete('captcha.proofs', row.key);
  }
  function registerActions() {
    registry.register({
      id: 'verification.captcha.start',
      category: 'interfaces',
      risk: 'write',
      available,
      description:
        'Create a private one-use Cloudflare Turnstile challenge bound to your member, channel and current verification policy. Completion still requires your explicit Discord rules acknowledgement.',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: async (ctx) => {
        if (!available())
          throw new UserError('Configure TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY and APP_PUBLIC_URL.');
        ctx = await freshContext(ctx);
        await resolveChannel(ctx, ctx.channelId);
        const configured = policy(ctx.guild.id);
        if (!configured?.version || !configured.captchaRequired)
          throw new UserError('A manager must enable CAPTCHA on this server’s verification policy first.');
        prune();
        const rows = store.list<CaptchaFlow>('captcha.flows');
        if (rows.length >= 1000 || rows.filter((row) => row.value.userId === ctx.member.id).length >= 5)
          throw new UserError('Earlier CAPTCHA requests must finish or expire first.');
        const token = randomBytes(32).toString('base64url'),
          flow: CaptchaFlow = {
            id: hash(token),
            guildId: ctx.guild.id,
            userId: ctx.member.id,
            channelId: ctx.channelId,
            version: configured.version,
            epoch: store.get<number>('core.featureEpochs', `${ctx.guild.id}:interfaces`) ?? 0,
            expiresAt: now() + 300000,
            state: 'created',
          };
        store.set('captcha.flows', flow.id, flow);
        return {
          url: new URL(`/verify/captcha/${token}`, base).href,
          expiresAt: flow.expiresAt,
          notice:
            'Complete this private challenge, then return to Discord and acknowledge the verification rules.',
        };
      },
    });
  }
  function assertCaptcha(ctx: ActionContext, version: string): void {
    prune();
    const key = proofKey(ctx),
      proof = store.get<{ version: string; epoch: number; expiresAt: number }>('captcha.proofs', key);
    if (
      !available() ||
      !proof ||
      proof.version !== version ||
      proof.expiresAt <= now() ||
      proof.epoch !== (store.get<number>('core.featureEpochs', `${ctx.guild.id}:interfaces`) ?? 0)
    )
      throw new UserError('Complete a fresh verification.captcha.start challenge first.');
    store.delete('captcha.proofs', key);
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url || '/', base?.origin || 'http://127.0.0.1');
    if (!url.pathname.startsWith('/verify/captcha/')) return false;
    if (!available()) {
      jsonResponse(response, 503, { error: 'CAPTCHA verification is not configured.' });
      return true;
    }
    if (request.headers.host !== base!.host || active >= 16) {
      jsonResponse(response, 403, { error: 'Verification request is unavailable.' });
      return true;
    }
    active++;
    try {
      prune();
      const token = z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .parse(url.pathname.slice('/verify/captcha/'.length)),
        flow = store.get<CaptchaFlow>('captcha.flows', hash(token));
      if (!flow || flow.expiresAt <= now()) throw new HttpError(410, 'Verification link expired.');
      if (request.method === 'GET') {
        if (!valid(flow, 'created'))
          throw new HttpError(409, 'Verification link was already opened or its policy changed.');
        const nonce = randomBytes(32).toString('base64url'),
          scriptNonce = randomBytes(16).toString('base64');
        flow.cookieHash = hash(nonce);
        flow.state = 'presented';
        store.set('captcha.flows', flow.id, flow);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Set-Cookie': `captcha_session=${nonce}; Path=/verify/captcha; HttpOnly; SameSite=Strict; Max-Age=300${base!.protocol === 'https:' ? '; Secure' : ''}`,
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
        response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Member verification</title><main><h1>Member verification</h1><p>Complete this challenge, then return to Discord to acknowledge the server rules.</p><form method="post"><div class="cf-turnstile" data-sitekey="${escape(env.TURNSTILE_SITE_KEY!)}" data-action="verify-member" data-cdata="${flow.id}"></div><button type="submit">Verify challenge</button></form></main><script nonce="${scriptNonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></html>`,
        );
        return true;
      }
      if (
        request.method !== 'POST' ||
        request.headers.origin !== base!.origin ||
        request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded'
      )
        throw new HttpError(403, 'Use the form in the original verification browser.');
      const cookies = (request.headers.cookie || '')
        .split(';')
        .map((value) => value.trim())
        .filter((value) => value.startsWith('captcha_session='));
      if (
        cookies.length !== 1 ||
        !flow.cookieHash ||
        hash(cookies[0]!.slice('captcha_session='.length)) !== flow.cookieHash ||
        !valid(flow, 'presented')
      )
        throw new HttpError(401, 'Verification browser binding is invalid.');
      const form = new URLSearchParams((await readBody(request, 16384)).toString('utf8')),
        answer = z.string().min(1).max(2048).parse(form.get('cf-turnstile-response'));
      if (!valid(flow, 'presented')) throw new HttpError(409, 'Verification state changed.');
      flow.state = 'checking';
      store.set('captcha.flows', flow.id, flow);
      const result = providerJson(
        await providerHttp(
          'turnstile',
          'https://challenges.cloudflare.com',
          options.transport,
        )('/turnstile/v0/siteverify', {
          method: 'POST',
          form: { secret: env.TURNSTILE_SECRET_KEY!, response: answer, idempotency_key: randomUUID() },
        }),
        'turnstile',
      ) as Record<string, unknown>;
      if (
        result.success !== true ||
        result.action !== 'verify-member' ||
        result.cdata !== flow.id ||
        result.hostname !== base!.hostname
      )
        throw new HttpError(
          403,
          'Challenge was not accepted for this exact verification origin and request.',
        );
      if (!valid(flow, 'checking')) throw new HttpError(409, 'Verification policy or request changed.');
      flow.state = 'passed';
      store.set('captcha.flows', flow.id, flow);
      store.set('captcha.proofs', `${flow.guildId}:${flow.userId}:${flow.channelId}`, {
        version: flow.version,
        epoch: flow.epoch,
        expiresAt: now() + 300000,
      });
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      });
      response.end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Challenge complete</title><h1>Challenge complete</h1><p>Return to your original Discord channel and complete verification, acknowledging the rules. This proof expires in five minutes.</p></html>',
      );
    } catch (error) {
      jsonResponse(response, error instanceof HttpError ? error.status : 400, {
        error:
          error instanceof HttpError
            ? error.message
            : 'Verification could not be completed. Start a new challenge in Discord.',
      });
    } finally {
      active--;
    }
    return true;
  }
  return {
    registerActions,
    assertCaptcha,
    handle,
    prune,
    available,
    close() {
      closed = true;
    },
  };
}
