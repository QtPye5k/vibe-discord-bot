import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits as P,
  SKUType,
  SKUFlags,
  EntitlementType,
  type Subscription,
  type Client,
  type Entitlement,
  type SKU,
} from 'discord.js';
import { z } from 'zod';
import type { ActionContext } from '../core/types.js';
import { actionPolicyExempt, type ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { assertPermissions, freshContext } from '../core/permissions.js';
import { assertOperator } from '../core/operator.js';
import { UserError } from '../core/errors.js';

const id = z.string().regex(/^\d{17,20}$/),
  slug = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  actionId = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  hex = z.string().regex(/^#[0-9a-fA-F]{6}$/),
  empty = z.strictObject({});
const https = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an HTTPS URL without credentials.');
const themeSchema = z.strictObject({
  id: slug,
  name: z.string().min(1).max(60),
  background: hex,
  foreground: hex,
  accent: hex,
});
const interfaceSchema = z.strictObject({
  id: slug,
  name: z.string().min(1).max(60),
  compact: z.boolean().default(false),
  showAnalytics: z.boolean().default(true),
});
const productSchema = z
  .strictObject({
    id: slug,
    skuId: id,
    name: z.string().min(1).max(80),
    description: z.string().max(1000).default(''),
    kind: z.enum(['subscription', 'durable', 'consumable']),
    scope: z.enum(['user', 'guild']).default('user'),
    actions: z.array(actionId).max(100).default([]),
    commandLimits: z.record(actionId, z.number().int().min(1).max(100000)).default({}),
    credits: z.number().int().min(1).max(100000).optional(),
    creditsPerAction: z.number().int().min(1).max(1000).default(1),
    aiUserDailyLimit: z.number().int().min(1).max(100000).optional(),
    aiGuildDailyLimit: z.number().int().min(1).max(1000000).optional(),
    themes: z.array(slug).max(20).default([]),
    interfaces: z.array(slug).max(20).default([]),
  })
  .refine(
    (product) => product.kind !== 'consumable' || (product.scope === 'user' && product.credits !== undefined),
    'Consumables require user scope and a positive credit amount.',
  );
const policySchema = z
  .strictObject({
    version: z.literal(1),
    allowTestEntitlements: z.boolean().default(false),
    products: z.array(productSchema).max(20),
    themes: z.array(themeSchema).max(20).default([]),
    interfaces: z.array(interfaceSchema).max(20).default([]),
    supportChannelId: id.optional(),
    billingSupportUrl: https.optional(),
    termsUrl: https.optional(),
    privacyUrl: https.optional(),
    storeDescription: z.string().max(2000).default(''),
  })
  .superRefine((policy, ctx) => {
    if (
      new Set(
        policy.products.filter((product) => product.kind === 'subscription').map((product) => product.scope),
      ).size > 1
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Discord offers user or guild subscription SKUs, not both simultaneously.',
      });
    for (const key of ['id', 'skuId'] as const)
      if (new Set(policy.products.map((product) => product[key])).size !== policy.products.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate product ${key}.` });
    if (
      new Set(policy.themes.map((theme) => theme.id)).size !== policy.themes.length ||
      new Set(policy.interfaces.map((view) => view.id)).size !== policy.interfaces.length
    )
      ctx.addIssue({ code: 'custom', message: 'Theme/interface IDs must be unique.' });
    for (const product of policy.products) {
      if (product.kind === 'consumable' && product.actions.includes('activity.launch'))
        ctx.addIssue({
          code: 'custom',
          message:
            'Continuous Activity access requires a subscription or durable entitlement; consumable admission credits cannot authorize later state polling.',
        });
      if (
        product.kind === 'consumable' &&
        (product.aiUserDailyLimit ||
          product.aiGuildDailyLimit ||
          product.themes.length ||
          product.interfaces.length)
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Consumables provide per-action credits; use subscription/durable products for passive quotas, themes and interfaces.',
        });
      if (
        product.actions.some(
          (action) =>
            action.startsWith('premium.') ||
            action.startsWith('system.') ||
            actionPolicyExempt(action) ||
            /^(?:ai\.memory\.forget|ai\.knowledge\.remove|community\.erase|notification\.subscribe|form\.erase-own)$/.test(
              action,
            ),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Premium/system/privacy recovery actions cannot be paywalled.',
        });
      if (Object.keys(product.commandLimits).some((action) => !product.actions.includes(action)))
        ctx.addIssue({ code: 'custom', message: 'Command limits must name an action in the same product.' });
      if (
        product.themes.some((name) => !policy.themes.some((theme) => theme.id === name)) ||
        product.interfaces.some((name) => !policy.interfaces.some((view) => view.id === name))
      )
        ctx.addIssue({ code: 'custom', message: 'Product references an undefined theme/interface.' });
    }
  });
export type PremiumPolicy = z.infer<typeof policySchema>;
type Product = z.infer<typeof productSchema>;
export interface PremiumOptions {
  policyFile: string;
  operatorIds?: readonly string[];
  now?: () => number;
}
interface CreditClaim {
  entitlementId: string;
  guildId: string;
  userId: string;
  productId: string;
  skuId: string;
  credits: number;
  spent: number;
  state: 'pending' | 'granted' | 'uncertain' | 'frozen';
  policyVersion: string;
  createdAt: number;
  updatedAt: number;
}
interface SupportCase {
  id: string;
  guildId: string;
  userId: string;
  kind: 'account' | 'billing';
  subject: string;
  state: 'open' | 'resolved';
  createdAt: number;
  messages: { userId: string; role: 'customer' | 'staff'; text: string; at: number }[];
}
interface Reservation {
  id: string;
  guildId: string;
  userId: string;
  actionId: string;
  productId: string;
  skuId: string;
  day: string;
  at: number;
  status: 'pending' | 'success' | 'failure' | 'unknown';
  credits: number;
  debits: { entitlementId: string; amount: number }[];
  restoredAt?: number;
  restoredBy?: string;
  supportCaseId?: string;
}
export interface PremiumGrant {
  guildId: string;
  userId: string;
  actionId?: string;
  at: number;
  epoch: number;
  policyVersion: string;
  products: Product[];
  entitlements: Entitlement[];
  eligibleCreditIds: string[];
  availableCredits: Record<string, number>;
  gated: boolean;
}
export interface PremiumAppearance {
  theme?: z.infer<typeof themeSchema>;
  interface?: z.infer<typeof interfaceSchema>;
}
const CLAIMS = 'premium.claims',
  USAGE = 'premium.usage',
  SUPPORT = 'premium.support',
  EVENTS = 'premium.events';
const ownKey = (ctx: ActionContext) => `${ctx.guild.id}:${ctx.member.id}`;
const safeError = (error: unknown) => (error instanceof Error ? error.name : 'Error');
const retainedCount = (store: Store, namespace: string) =>
  Number(store.db.prepare('SELECT count(*) AS count FROM kv WHERE namespace=?').get(namespace)?.count ?? 0);

export function createPremiumService(options: PremiumOptions) {
  const clock = options.now ?? Date.now;
  let policy: PremiumPolicy | undefined,
    policyError: string | undefined,
    closed = false,
    registry: ActionRegistry | undefined;
  let policyVersion = 'off';
  const inFlightClaims = new Set<string>();
  if (options.policyFile)
    try {
      if (!isAbsolute(options.policyFile) || options.policyFile.startsWith('\\\\'))
        throw new Error('Use an absolute local premium policy path.');
      const size = statSync(options.policyFile);
      if (!size.isFile() || size.size > 65536)
        throw new Error('Premium policy exceeds its 64 KiB file limit.');
      const data = readFileSync(options.policyFile);
      if (data.length > 65536) throw new Error('Premium policy exceeds its file limit.');
      policy = policySchema.parse(JSON.parse(data.toString('utf8')));
      policyVersion = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    } catch (error) {
      policyError = safeError(error);
    }
  const configured = () => !closed && !!policy && !policyError;
  const epoch = (ctx: ActionContext) =>
    ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:premium`) ?? 0;
  const current = (ctx: ActionContext, expected?: number) => {
    if (closed) throw new UserError('Premium service is shutting down.');
    if (options.policyFile && (!policy || policyError))
      throw new UserError(
        'Premium policy configuration is invalid; ask the host operator to repair PREMIUM_POLICY_FILE.',
      );
    if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('premium'))
      throw new UserError('Premium features are disabled in this server.');
    if (expected !== undefined && epoch(ctx) !== expected)
      throw new UserError('Premium policy changed during this request.');
  };
  async function authorizeMember(ctx: ActionContext, expected?: number): Promise<ActionContext> {
    current(ctx, expected);
    const fresh = await freshContext(ctx);
    await assertPermissions(fresh, [], [], {});
    current(fresh, expected);
    return fresh;
  }
  async function operator(ctx: ActionContext): Promise<ActionContext> {
    if (!(options.operatorIds ?? []).includes(ctx.member.id)) await ctx.client.application?.fetch();
    const fresh = await authorizeMember(ctx);
    assertOperator(fresh, options.operatorIds);
    return fresh;
  }
  async function liveProducts(ctx: ActionContext, expected: number): Promise<Map<string, SKU>> {
    if (!ctx.client.application) throw new UserError('Discord application identity is unavailable.');
    const application = await ctx.client.application.fetch();
    current(ctx, expected);
    const skus = await application.fetchSKUs();
    current(ctx, expected);
    if (skus.size > 1000) throw new UserError('SKU catalog exceeds its safety bound.');
    const selected = new Map<string, SKU>();
    for (const product of policy!.products) {
      const sku = skus.get(product.skuId),
        flags = Number(sku?.flags.bitfield);
      if (
        !sku ||
        sku.applicationId !== application.id ||
        sku.id !== product.skuId ||
        !Number.isSafeInteger(flags) ||
        flags < 0
      )
        throw new UserError('A configured SKU does not belong to this application.');
      const expectedType =
        product.kind === 'subscription'
          ? SKUType.Subscription
          : product.kind === 'durable'
            ? SKUType.Durable
            : SKUType.Consumable;
      const requiredFlag =
        product.kind === 'subscription'
          ? product.scope === 'guild'
            ? SKUFlags.GuildSubscription
            : SKUFlags.UserSubscription
          : 0;
      if (sku.type !== expectedType || ![requiredFlag, requiredFlag | SKUFlags.Available].includes(flags))
        throw new UserError('Configured SKU type/scope differs from Discord. Review the premium policy.');
      selected.set(product.skuId, sku);
    }
    return selected;
  }
  function validateEntitlement(
    ctx: ActionContext,
    value: Entitlement,
    product: Product,
    subjectUserId = ctx.member.id,
  ): void {
    if (
      !id.safeParse(value.id).success ||
      value.applicationId !== ctx.client.application?.id ||
      value.skuId !== product.skuId ||
      typeof value.deleted !== 'boolean' ||
      typeof value.consumed !== 'boolean' ||
      ![1, 3, 4, 5, 6, 7, 8].includes(value.type)
    )
      throw new UserError('Invalid, foreign or disallowed test entitlement.');
    if (
      product.scope === 'user'
        ? value.userId !== subjectUserId || value.guildId !== null
        : value.guildId !== ctx.guild.id
    )
      throw new UserError('Entitlement owner does not match this member/server.');
    if (
      ![value.startsTimestamp, value.endsTimestamp].every(
        (time) => time === null || (typeof time === 'number' && Number.isFinite(time)),
      ) ||
      (value.startsTimestamp !== null &&
        value.endsTimestamp !== null &&
        value.endsTimestamp < value.startsTimestamp)
    )
      throw new UserError('Invalid entitlement validity period.');
  }
  const active = (value: Entitlement, allowConsumed = false) =>
    (policy!.allowTestEntitlements || value.type !== EntitlementType.TestModePurchase) &&
    !value.deleted &&
    (allowConsumed || !value.consumed) &&
    (value.startsTimestamp === null || value.startsTimestamp <= clock()) &&
    (value.endsTimestamp === null || value.endsTimestamp > clock());
  async function fetchEntitlements(
    ctx: ActionContext,
    scope: 'user' | 'guild',
    expected: number,
    subjectUserId = ctx.member.id,
  ): Promise<Entitlement[]> {
    const products = policy!.products.filter((product) => product.scope === scope);
    if (!products.length) return [];
    const skus = products.map((product) => product.skuId);
    let after = '0';
    const out: Entitlement[] = [],
      seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      current(ctx, expected);
      const values = await ctx.client.application!.entitlements.fetch({
        ...(scope === 'user' ? { user: subjectUserId } : { guild: ctx.guild.id }),
        skus,
        limit: 100,
        after,
        excludeEnded: false,
        excludeDeleted: false,
        cache: false,
      });
      current(ctx, expected);
      if (values.size > 100) throw new UserError('Entitlement page exceeds its limit.');
      let maximum = BigInt(after);
      for (const value of values.values()) {
        const product = products.find((product) => product.skuId === value.skuId);
        if (
          !product ||
          seen.has(value.id) ||
          !id.safeParse(value.id).success ||
          BigInt(value.id) <= BigInt(after)
        )
          throw new UserError('Entitlement pagination is invalid or duplicated.');
        validateEntitlement(ctx, value, product, subjectUserId);
        seen.add(value.id);
        out.push(value);
        if (BigInt(value.id) > maximum) maximum = BigInt(value.id);
      }
      if (values.size < 100) return out;
      after = maximum.toString();
    }
    throw new UserError(
      'Entitlement inventory exceeds the complete 1,000-record bound. Access was not inferred from an incomplete page.',
    );
  }
  async function getAccess(ctx: ActionContext, action?: string): Promise<PremiumGrant> {
    const baseline: PremiumGrant = {
      guildId: ctx.guild.id,
      userId: ctx.member.id,
      actionId: action,
      at: clock(),
      epoch: epoch(ctx),
      policyVersion,
      products: [],
      entitlements: [],
      eligibleCreditIds: [],
      availableCredits: {},
      gated: false,
    };
    if (!options.policyFile) return baseline;
    if (!policy) throw new UserError('Premium policy unavailable.');
    const gated = !!action && policy.products.some((product) => product.actions.includes(action));
    if (action && !gated) return baseline;
    current(ctx);
    const fresh = await authorizeMember(ctx, baseline.epoch);
    await liveProducts(fresh, baseline.epoch);
    const entitlements = [
      ...(await fetchEntitlements(fresh, 'user', baseline.epoch)),
      ...(await fetchEntitlements(fresh, 'guild', baseline.epoch)),
    ];
    await authorizeMember(fresh, baseline.epoch);
    const claims = fresh.store.list<CreditClaim>(CLAIMS, `${fresh.member.id}:`),
      eligibleCreditIds: string[] = [],
      availableCredits: Record<string, number> = {};
    for (const { value: claim } of claims) {
      const entitlement = entitlements.find((row) => row.id === claim.entitlementId),
        product = policy.products.find((row) => row.id === claim.productId);
      if (
        claim.state === 'granted' &&
        product?.kind === 'consumable' &&
        product.skuId === claim.skuId &&
        claim.userId === fresh.member.id &&
        entitlement &&
        active(entitlement, true) &&
        entitlement.consumed
      ) {
        eligibleCreditIds.push(claim.entitlementId);
        availableCredits[product.id] =
          (availableCredits[product.id] ?? 0) + Math.max(0, claim.credits - claim.spent);
      }
    }
    const granted = policy.products.filter((product) =>
      product.kind === 'consumable'
        ? (availableCredits[product.id] ?? 0) >= product.creditsPerAction
        : entitlements.some((row) => row.skuId === product.skuId && active(row)),
    );
    const result = {
      ...baseline,
      products: granted,
      entitlements,
      eligibleCreditIds,
      availableCredits,
      gated,
      at: clock(),
    };
    if (gated && !granted.some((product) => product.actions.includes(action!)))
      throw new UserError(
        'This action requires an active premium entitlement or claimed consumable credits. Use premium.catalog and premium.status.',
      );
    return result;
  }
  const authorize = (ctx: ActionContext, action: string) => getAccess(ctx, action);
  function begin(
    ctx: ActionContext,
    action: string,
    raw: unknown,
  ): { finish(status: 'success' | 'failure'): void } | undefined {
    if (!options.policyFile) return;
    const grant = raw as PremiumGrant;
    if (
      !grant ||
      grant.guildId !== ctx.guild.id ||
      grant.userId !== ctx.member.id ||
      grant.actionId !== action ||
      grant.policyVersion !== policyVersion ||
      grant.epoch !== epoch(ctx) ||
      clock() - grant.at > 15000 ||
      grant.at > clock() + 1000
    )
      throw new UserError('Premium authorization expired. Request the action again.');
    if (!grant.gated) return;
    current(ctx);
    const choices = grant.products
      .filter(
        (product) =>
          product.actions.includes(action) &&
          grant.entitlements.some(
            (entitlement) =>
              entitlement.skuId === product.skuId && active(entitlement, product.kind === 'consumable'),
          ),
      )
      .sort(
        (a, b) =>
          Number(a.kind === 'consumable') - Number(b.kind === 'consumable') ||
          (b.commandLimits[action] ?? Number.MAX_SAFE_INTEGER) -
            (a.commandLimits[action] ?? Number.MAX_SAFE_INTEGER),
      );
    const day = new Date(clock()).toISOString().slice(0, 10),
      reservationId = randomBytes(12).toString('hex');
    let selected: Product | undefined,
      charged = 0,
      purchasedDebits: { entitlementId: string; amount: number }[] = [];
    ctx.store.transaction(() => {
      if (retainedCount(ctx.store, USAGE) >= 100000)
        throw new UserError('Premium usage retention is full. Ask the operator to run maintenance.');
      for (const product of choices) {
        const scope = `premium:${product.scope === 'guild' ? ctx.guild.id : 'user'}:${ctx.member.id}:${product.id}:${action}`,
          count = Number(
            ctx.store.db.prepare('SELECT count FROM quota WHERE scope=? AND day=?').get(scope, day)?.count ??
              0,
          );
        if (product.commandLimits[action] !== undefined && count >= product.commandLimits[action]!) continue;
        let remaining = product.kind === 'consumable' ? product.creditsPerAction : 0;
        const debits: { key: string; claim: CreditClaim; amount: number }[] = [];
        for (const row of ctx.store.list<CreditClaim>(CLAIMS, `${ctx.member.id}:`)) {
          if (!remaining) break;
          const claim = row.value;
          if (
            claim.productId !== product.id ||
            claim.state !== 'granted' ||
            !grant.eligibleCreditIds.includes(claim.entitlementId)
          )
            continue;
          const amount = Math.min(remaining, Math.max(0, claim.credits - claim.spent));
          if (amount) {
            debits.push({ key: row.key, claim, amount });
            remaining -= amount;
          }
        }
        if (remaining) continue;
        for (const debit of debits)
          ctx.store.set(CLAIMS, debit.key, {
            ...debit.claim,
            spent: debit.claim.spent + debit.amount,
            updatedAt: clock(),
          });
        ctx.store.db
          .prepare('INSERT INTO quota VALUES(?,?,1) ON CONFLICT(scope,day) DO UPDATE SET count=count+1')
          .run(scope, day);
        selected = product;
        charged = debits.reduce((sum, row) => sum + row.amount, 0);
        purchasedDebits = debits.map((row) => ({
          entitlementId: row.claim.entitlementId,
          amount: row.amount,
        }));
        break;
      }
      if (!selected)
        throw new UserError(
          'Premium command allowance or consumable credit balance was reached. It resets at 00:00 UTC where applicable.',
        );
      const record: Reservation = {
        id: reservationId,
        guildId: ctx.guild.id,
        userId: ctx.member.id,
        actionId: action,
        productId: selected.id,
        skuId: selected.skuId,
        day,
        at: clock(),
        status: 'pending',
        credits: charged,
        debits: purchasedDebits,
      };
      ctx.store.set(USAGE, `${ctx.guild.id}:${reservationId}`, record);
    });
    let finished = false;
    return {
      finish(status) {
        if (finished) return;
        finished = true;
        const key = `${ctx.guild.id}:${reservationId}`,
          record = ctx.store.get<Reservation>(USAGE, key);
        if (record?.status === 'pending') ctx.store.set(USAGE, key, { ...record, status });
      },
    };
  }
  async function aiAllowance(
    ctx: ActionContext,
  ): Promise<{ maxAiRequestsPerUserDay?: number; maxAiRequestsPerGuildDay?: number } | undefined> {
    if (!configured() || (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('premium'))
      return undefined;
    const access = await getAccess(ctx);
    const user = access.products.flatMap((product) =>
        product.aiUserDailyLimit ? [product.aiUserDailyLimit] : [],
      ),
      guild = access.products.flatMap((product) =>
        product.scope === 'guild' && product.aiGuildDailyLimit ? [product.aiGuildDailyLimit] : [],
      );
    return {
      maxAiRequestsPerUserDay: user.length ? Math.max(...user) : undefined,
      maxAiRequestsPerGuildDay: guild.length ? Math.max(...guild) : undefined,
    };
  }
  async function appearance(ctx: ActionContext): Promise<PremiumAppearance> {
    if (!configured() || (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('premium'))
      return {};
    const access = await getAccess(ctx),
      saved = ctx.store.get<{ theme?: string; interface?: string }>('premium.appearance', ownKey(ctx)) ?? {};
    const themes = new Set(access.products.flatMap((product) => product.themes)),
      interfaces = new Set(access.products.flatMap((product) => product.interfaces));
    return {
      theme: themes.has(saved.theme ?? '')
        ? policy!.themes.find((theme) => theme.id === saved.theme)
        : undefined,
      interface: interfaces.has(saved.interface ?? '')
        ? policy!.interfaces.find((view) => view.id === saved.interface)
        : undefined,
    };
  }
  function registerActions(target: ActionRegistry): void {
    if (registry) throw new Error('Premium actions already registered');
    registry = target;
    const add = <S extends z.ZodType>(
      action: string,
      description: string,
      risk: 'read' | 'write' | 'destructive',
      schema: S,
      execute: (ctx: ActionContext, input: z.infer<S>) => Promise<unknown>,
      enabled = true,
    ) =>
      registry!.register({
        id: action,
        description,
        category: enabled ? 'premium' : 'system',
        risk,
        schema,
        userPermissions: [],
        botPermissions: [],
        available: enabled ? configured : undefined,
        unavailableReason: 'Premium features are disabled until a valid PREMIUM_POLICY_FILE is configured.',
        execute: async (ctx, input) => {
          const expected = epoch(ctx);
          const fresh = enabled ? await authorizeMember(ctx, expected) : await freshContext(ctx);
          if (!enabled) await assertPermissions(fresh, [], [], {});
          registry!.assertPolicy(fresh, action);
          const result = await execute(fresh, input);
          if (enabled) await authorizeMember(fresh, expected);
          return result;
        },
      });
    add(
      'premium.configuration',
      'Inspect premium policy availability and Portal setup links without exposing host paths or changing billing.',
      'read',
      empty,
      async (ctx) => {
        if (!(options.operatorIds ?? []).includes(ctx.member.id)) await ctx.client.application?.fetch();
        assertOperator(ctx, options.operatorIds);
        return {
          configured: configured(),
          error: policyError ?? null,
          products: policy?.products.length ?? 0,
          applicationId: ctx.client.application?.id ?? null,
          portal: `https://discord.com/developers/applications/${ctx.client.application?.id ?? ''}/monetization`,
          notice:
            'Offering creation, pricing, discovery eligibility and payout setup use the Developer Portal; this bot does not impersonate unsupported billing APIs.',
        };
      },
      false,
    );
    add(
      'premium.catalog',
      'Read configured premium offerings, verified own-application SKU metadata and authoritative Discord purchase buttons.',
      'read',
      empty,
      async (ctx) => {
        const accessEpoch = epoch(ctx),
          skus = await liveProducts(ctx, accessEpoch);
        return {
          products: policy!.products.map((product) => ({
            ...pickProduct(product),
            sku: pickSku(skus.get(product.skuId)!),
          })),
          storeDescription: policy!.storeDescription,
          termsUrl: policy!.termsUrl,
          privacyUrl: policy!.privacyUrl,
          storeUrl: `https://discord.com/application-directory/${ctx.client.application!.id}/store`,
        };
      },
    );
    add(
      'premium.purchase',
      'Display a Discord premium purchase button for an exact configured own-application offering; checkout occurs in Discord.',
      'read',
      z.strictObject({ productId: slug }),
      async (ctx, input) => {
        const product = policy!.products.find((row) => row.id === input.productId);
        if (!product) throw new UserError('Unknown offering.');
        const skus = await liveProducts(ctx, epoch(ctx));
        if (!(Number(skus.get(product.skuId)!.flags.bitfield) & SKUFlags.Available))
          throw new UserError('Discord has not marked that offering available for purchase.');
        return {
          content: `${product.name}\n${product.description}`,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(product.skuId),
            ),
          ],
          premiumPurchase: true,
          notice: 'Discord checkout displays current price/terms. No purchase is performed by this action.',
        };
      },
    );
    add(
      'premium.status',
      'Inspect your current user/server premium entitlements, remaining claimed credits, allowed themes/interfaces and current policy.',
      'read',
      empty,
      async (ctx) => {
        const access = await getAccess(ctx);
        return {
          products: access.products.map(pickProduct),
          credits: access.availableCredits,
          entitlements: access.entitlements.map((row) => ({
            id: row.id,
            skuId: row.skuId,
            scope: row.guildId ? 'guild' : 'user',
            active: active(row, true),
            consumed: row.consumed,
            endsAt: row.endsTimestamp,
          })),
          themes: access.products.flatMap((product) => product.themes),
          interfaces: access.products.flatMap((product) => product.interfaces),
        };
      },
    );
    add(
      'premium.claim',
      'Claim one exact unconsumed purchase into durable in-bot credits after confirmation; ambiguous consumption is preserved for review.',
      'write',
      z.strictObject({ entitlementId: id, productId: slug }),
      async (ctx, input) => {
        const product = policy!.products.find(
          (row) => row.id === input.productId && row.kind === 'consumable',
        );
        if (!product) throw new UserError('Choose a configured consumable offering.');
        const access = await getAccess(ctx),
          entitlement = access.entitlements.find(
            (row) => row.id === input.entitlementId && row.skuId === product.skuId,
          );
        if (!entitlement || !active(entitlement) || entitlement.userId !== ctx.member.id)
          throw new UserError('That active unconsumed purchase is unavailable to this account.');
        const key = `${ctx.member.id}:${entitlement.id}`;
        if (ctx.store.get(CLAIMS, key))
          throw new UserError('This purchase already has a claim/review record.');
        if (retainedCount(ctx.store, CLAIMS) >= 20000) throw new UserError('Credit claim retention is full.');
        const record: CreditClaim = {
          entitlementId: entitlement.id,
          guildId: ctx.guild.id,
          userId: ctx.member.id,
          productId: product.id,
          skuId: product.skuId,
          credits: product.credits!,
          spent: 0,
          state: 'pending',
          policyVersion,
          createdAt: clock(),
          updatedAt: clock(),
        };
        ctx.store.transaction(() => {
          if (ctx.store.get(CLAIMS, key) || ctx.store.get('premium.claimIndex', entitlement.id))
            throw new UserError('This purchase already has a claim/review record.');
          ctx.store.set('premium.claimIndex', entitlement.id, { userId: ctx.member.id, key });
          ctx.store.set(CLAIMS, key, record);
        });
        inFlightClaims.add(entitlement.id);
        try {
          await ctx.client.application!.entitlements.consume(entitlement.id);
          await authorizeMember(ctx, access.epoch);
          ctx.store.set(CLAIMS, key, { ...record, state: 'granted', updatedAt: clock() });
          return { claimed: entitlement.id, credits: record.credits };
        } catch {
          ctx.store.set(CLAIMS, key, { ...record, state: 'uncertain', updatedAt: clock() });
          throw new UserError(
            'Purchase consumption outcome requires review. No credits were guessed or automatically retried; use premium.claim-review.',
          );
        } finally {
          inFlightClaims.delete(entitlement.id);
        }
      },
    );
    add(
      'premium.claim-review',
      'Reconcile a pending purchase from fresh Discord state, or explicitly retry a proved unconsumed purchase after review.',
      'write',
      z.strictObject({
        entitlementId: id,
        outcome: z.enum(['grant-consumed', 'retry-unconsumed']).default('grant-consumed'),
      }),
      async (ctx, input) => {
        const key = `${ctx.member.id}:${input.entitlementId}`,
          claim = ctx.store.get<CreditClaim>(CLAIMS, key);
        if (!claim || !['pending', 'uncertain'].includes(claim.state))
          throw new UserError('No unresolved claim for this account.');
        if (inFlightClaims.has(input.entitlementId))
          throw new UserError('The original consumption request is still running.');
        const access = await getAccess(ctx),
          entitlement = access.entitlements.find(
            (row) => row.id === input.entitlementId && row.skuId === claim.skuId,
          );
        if (!entitlement || !active(entitlement, true))
          throw new UserError(
            'Discord has not proved this claimed purchase consumed/current. Ask support to inspect the remote state.',
          );
        if (input.outcome === 'retry-unconsumed') {
          if (entitlement.consumed)
            throw new UserError(
              'Discord already reports consumption. Reconcile with grant-consumed instead.',
            );
          inFlightClaims.add(input.entitlementId);
          ctx.store.set(CLAIMS, key, { ...claim, state: 'pending', updatedAt: clock() });
          try {
            await ctx.client.application!.entitlements.consume(input.entitlementId);
            await authorizeMember(ctx, access.epoch);
            ctx.store.set(CLAIMS, key, { ...claim, state: 'granted', updatedAt: clock() });
            return { reconciled: claim.entitlementId, credits: claim.credits };
          } catch {
            ctx.store.set(CLAIMS, key, { ...claim, state: 'uncertain', updatedAt: clock() });
            throw new UserError('Consumption outcome remains uncertain; no credits were guessed.');
          } finally {
            inFlightClaims.delete(input.entitlementId);
          }
        }
        if (!entitlement.consumed)
          throw new UserError(
            'Purchase is still unconsumed. Explicitly review retry-unconsumed if you want another consumption attempt.',
          );
        ctx.store.set(CLAIMS, key, { ...claim, state: 'granted', updatedAt: clock() });
        return { reconciled: claim.entitlementId, credits: claim.credits };
      },
    );
    for (const mode of ['theme', 'interface'] as const)
      add(
        `premium.${mode}.set`,
        `Select an actually unlocked premium ${mode} for supported bot interfaces.`,
        'write',
        z.strictObject({ id: slug.nullable() }),
        async (ctx, input) => {
          const access = await getAccess(ctx),
            unlocked = access.products.flatMap((product) =>
              mode === 'theme' ? product.themes : product.interfaces,
            );
          if (input.id && !unlocked.includes(input.id))
            throw new UserError(`This ${mode} is not unlocked by your current entitlement.`);
          const key = ownKey(ctx),
            saved = ctx.store.get<Record<string, string | null>>('premium.appearance', key) ?? {};
          ctx.store.set('premium.appearance', key, { ...saved, [mode]: input.id });
          return { selected: input.id, appearance: await appearance(ctx) };
        },
      );
    add(
      'premium.subscriptions',
      'Read your actual subscription lifecycle/status for one configured subscription offering.',
      'read',
      z.strictObject({ productId: slug }),
      async (ctx, input) => {
        const product = policy!.products.find(
          (row) => row.id === input.productId && row.kind === 'subscription',
        );
        if (!product) throw new UserError('Unknown subscription offering.');
        const expected = epoch(ctx);
        await liveProducts(ctx, expected);
        const subscriptions: Subscription[] = [],
          seen = new Set<string>();
        let after = '0',
          complete = false;
        for (let page = 0; page < 10; page++) {
          const values = await ctx.client.application!.subscriptions.fetch({
            sku: product.skuId,
            user: ctx.member.id,
            limit: 100,
            after,
          });
          await authorizeMember(ctx, expected);
          if (values.size > 100) throw new UserError('Subscription page exceeds its limit.');
          let maximum = BigInt(after);
          for (const row of values.values()) {
            if (
              !id.safeParse(row.id).success ||
              seen.has(row.id) ||
              BigInt(row.id) <= BigInt(after) ||
              row.userId !== ctx.member.id ||
              !Array.isArray(row.skuIds) ||
              !row.skuIds.includes(product.skuId) ||
              ![0, 1, 2].includes(row.status) ||
              !Number.isFinite(row.currentPeriodStartTimestamp) ||
              !Number.isFinite(row.currentPeriodEndTimestamp) ||
              row.currentPeriodEndTimestamp < row.currentPeriodStartTimestamp ||
              (row.canceledTimestamp !== null && !Number.isFinite(row.canceledTimestamp))
            )
              throw new UserError('Subscription identity, period or pagination is invalid.');
            seen.add(row.id);
            subscriptions.push(row);
            if (BigInt(row.id) > maximum) maximum = BigInt(row.id);
          }
          if (values.size < 100) {
            complete = true;
            break;
          }
          after = maximum.toString();
        }
        if (!complete) throw new UserError('Subscription inventory exceeds the complete 1,000-record bound.');
        return subscriptions.map((row) => ({
          id: row.id,
          skuIds: row.skuIds,
          status: row.status,
          currentPeriodStart: row.currentPeriodStartTimestamp,
          currentPeriodEnd: row.currentPeriodEndTimestamp,
          canceledAt: row.canceledTimestamp,
        }));
      },
    );
    add(
      'premium.usage',
      'Read your retained premium command-attempt usage and outcomes; this is not payment revenue.',
      'read',
      z.strictObject({ days: z.number().int().min(1).max(90).default(30) }),
      async (ctx, input) =>
        ctx.store
          .list<Reservation>(USAGE, `${ctx.guild.id}:`)
          .map((row) => row.value)
          .filter((row) => row.userId === ctx.member.id && row.at >= clock() - input.days * 86400000)
          .slice(-200),
    );
    add(
      'premium.support.restore-credits',
      'Operator restores the exact debited in-bot credits for a reviewed failed/unknown attempt tied to a customer support case; no monetary refund is issued.',
      'write',
      z.strictObject({
        caseId: z.string().regex(/^[a-f0-9]{16}$/),
        usageId: z.string().regex(/^[a-f0-9]{24}$/),
        remoteStateReviewed: z.literal(true),
        reason: z.string().min(1).max(500),
      }),
      async (ctx, input) => {
        await operator(ctx);
        const usageKey = `${ctx.guild.id}:${input.usageId}`,
          usage = ctx.store.get<Reservation>(USAGE, usageKey),
          support = ctx.store.get<SupportCase>(SUPPORT, `${ctx.guild.id}:${input.caseId}`);
        if (
          !usage ||
          !support ||
          support.userId !== usage.userId ||
          !['failure', 'unknown'].includes(usage.status) ||
          usage.restoredAt ||
          !usage.credits ||
          !usage.debits?.length ||
          usage.debits.reduce((sum, row) => sum + row.amount, 0) !== usage.credits
        )
          throw new UserError(
            'Choose an unrestored failed/unknown paid attempt belonging to this support case.',
          );
        const expected = epoch(ctx);
        await liveProducts(ctx, expected);
        const entitlements = await fetchEntitlements(ctx, 'user', expected, usage.userId);
        await operator(ctx);
        ctx.store.transaction(() => {
          const fresh = ctx.store.get<Reservation>(USAGE, usageKey);
          if (!fresh || fresh.restoredAt || !['failure', 'unknown'].includes(fresh.status))
            throw new UserError('This attempt was already reviewed or changed.');
          for (const debit of fresh.debits) {
            const key = `${fresh.userId}:${debit.entitlementId}`,
              claim = ctx.store.get<CreditClaim>(CLAIMS, key),
              entitlement = entitlements.find((row) => row.id === debit.entitlementId);
            if (
              !claim ||
              claim.state !== 'granted' ||
              claim.userId !== fresh.userId ||
              claim.productId !== fresh.productId ||
              claim.skuId !== fresh.skuId ||
              claim.spent < debit.amount ||
              !entitlement ||
              entitlement.skuId !== fresh.skuId ||
              !active(entitlement, true) ||
              !entitlement.consumed
            )
              throw new UserError(
                'The original non-refunded consumed purchase and credit debit could not be proved.',
              );
            ctx.store.set(CLAIMS, key, { ...claim, spent: claim.spent - debit.amount, updatedAt: clock() });
          }
          const liveCase = ctx.store.get<SupportCase>(SUPPORT, `${ctx.guild.id}:${input.caseId}`);
          if (!liveCase || liveCase.messages.length >= 50)
            throw new UserError('Support conversation is unavailable or full.');
          liveCase.messages.push({
            userId: ctx.member.id,
            role: 'staff',
            text: `Restored ${fresh.credits} in-bot credits for attempt ${fresh.id}. ${input.reason}`,
            at: clock(),
          });
          ctx.store.set(SUPPORT, `${ctx.guild.id}:${input.caseId}`, liveCase);
          ctx.store.set(USAGE, usageKey, {
            ...fresh,
            restoredAt: clock(),
            restoredBy: ctx.member.id,
            supportCaseId: input.caseId,
          });
        });
        return { restoredCredits: usage.credits, usageId: usage.id, caseId: input.caseId };
      },
    );
    add(
      'premium.analytics',
      'Operator reads observed premium usage, credit claims, subscription/entitlement event counts and support state; no revenue is inferred.',
      'read',
      z.strictObject({ days: z.number().int().min(1).max(90).default(30) }),
      async (ctx, input) => {
        await operator(ctx);
        const since = clock() - input.days * 86400000,
          usage = ctx.store
            .list<Reservation>(USAGE, `${ctx.guild.id}:`)
            .map((row) => row.value)
            .filter((row) => row.at >= since),
          events = ctx.store
            .list<{ at: number; kind: string }>(EVENTS)
            .map((row) => row.value)
            .filter((row) => row.at >= since);
        return {
          usage: countBy(usage, (row) => `${row.productId}:${row.actionId}:${row.status}`),
          claims: countBy(
            ctx.store
              .list<CreditClaim>(CLAIMS)
              .map((row) => row.value)
              .filter((row) => row.guildId === ctx.guild.id),
            (row) => `${row.productId}:${row.state}`,
          ),
          observedEvents: countBy(events, (row) => row.kind),
          support: countBy(
            ctx.store.list<SupportCase>(SUPPORT, `${ctx.guild.id}:`).map((row) => row.value),
            (row) => row.state,
          ),
          notice:
            'Local observed events and attempts only; payment amounts, taxes, invoices and revenue are not available from these records.',
        };
      },
    );
    add(
      'premium.support.open',
      'Open a private account/billing support case; do not include passwords or payment-card details.',
      'write',
      z.strictObject({
        kind: z.enum(['account', 'billing']),
        subject: z.string().min(1).max(150),
        text: z.string().min(1).max(2000),
      }),
      async (ctx, input) => {
        if (
          ctx.store
            .list<SupportCase>(SUPPORT, `${ctx.guild.id}:`)
            .filter((row) => row.value.userId === ctx.member.id && row.value.state === 'open').length >= 5
        )
          throw new UserError('Limit:five open premium support cases.');
        if (retainedCount(ctx.store, SUPPORT) >= 5000)
          throw new UserError('Support retention limit reached.');
        const record: SupportCase = {
          id: randomBytes(8).toString('hex'),
          guildId: ctx.guild.id,
          userId: ctx.member.id,
          kind: input.kind,
          subject: input.subject,
          state: 'open',
          createdAt: clock(),
          messages: [{ userId: ctx.member.id, role: 'customer', text: input.text, at: clock() }],
        };
        ctx.store.set(SUPPORT, `${ctx.guild.id}:${record.id}`, record);
        let notified = false;
        if (policy!.supportChannelId)
          try {
            const channel = await ctx.guild.channels.fetch(policy!.supportChannelId, { force: true });
            if (
              channel?.isSendable() &&
              !channel.permissionsFor(ctx.guild.roles.everyone)?.has(P.ViewChannel)
            ) {
              await channel.send({
                content: `New premium ${record.kind} support case ${record.id}. Use premium.support.queue.`,
                allowedMentions: { parse: [] },
              });
              notified = true;
            }
          } catch {
            /* Case is durable; never resubmit automatically after uncertain notification. */
          }
        return {
          id: record.id,
          state: record.state,
          staffNotified: notified,
          billingSupportUrl: policy!.billingSupportUrl,
        };
      },
    );
    add(
      'premium.support.mine',
      'Read only your own premium account/billing support cases and conversation.',
      'read',
      empty,
      async (ctx) =>
        ctx.store
          .list<SupportCase>(SUPPORT, `${ctx.guild.id}:`)
          .map((row) => row.value)
          .filter((row) => row.userId === ctx.member.id)
          .slice(-100),
    );
    add(
      'premium.support.queue',
      'Application operator reviews this server’s premium account/billing support cases.',
      'read',
      z.strictObject({ state: z.enum(['open', 'resolved', 'all']).default('open') }),
      async (ctx, input) => {
        await operator(ctx);
        return ctx.store
          .list<SupportCase>(SUPPORT, `${ctx.guild.id}:`)
          .map((row) => row.value)
          .filter((row) => input.state === 'all' || row.state === input.state)
          .slice(-100);
      },
    );
    add(
      'premium.support.reply',
      'Reply to your own support case, or as an application operator; messages are retained in the private case.',
      'write',
      z.strictObject({
        caseId: z.string().regex(/^[a-f0-9]{16}$/),
        text: z.string().min(1).max(2000),
        resolve: z.boolean().default(false),
      }),
      async (ctx, input) => {
        const key = `${ctx.guild.id}:${input.caseId}`,
          record = ctx.store.get<SupportCase>(SUPPORT, key);
        if (!record) throw new UserError('Support case unavailable.');
        const staff = record.userId !== ctx.member.id;
        if (staff) await operator(ctx);
        if (input.resolve && !staff)
          throw new UserError('Only support staff can resolve a billing/account case.');
        if (record.messages.length >= 50) throw new UserError('Support conversation limit reached.');
        record.messages.push({
          userId: ctx.member.id,
          role: staff ? 'staff' : 'customer',
          text: input.text,
          at: clock(),
        });
        if (input.resolve) record.state = 'resolved';
        ctx.store.set(SUPPORT, key, record);
        return { id: record.id, state: record.state };
      },
    );
  }
  function recordEvent(client: Client, store: Store, kind: string, payload: unknown): void {
    if (!configured() || !client.application) return;
    if (
      ![
        'entitlementCreate',
        'entitlementUpdate',
        'entitlementDelete',
        'subscriptionCreate',
        'subscriptionUpdate',
        'subscriptionDelete',
      ].includes(kind) ||
      !payload ||
      typeof payload !== 'object'
    )
      return;
    const data = payload as {
      id?: unknown;
      applicationId?: unknown;
      skuId?: unknown;
      skuIds?: unknown;
      userId?: unknown;
      guildId?: unknown;
      status?: unknown;
      deleted?: unknown;
      consumed?: unknown;
      startsTimestamp?: unknown;
      endsTimestamp?: unknown;
      currentPeriodStartTimestamp?: unknown;
      currentPeriodEndTimestamp?: unknown;
      canceledTimestamp?: unknown;
    };
    const skus = Array.isArray(data.skuIds)
      ? data.skuIds
      : typeof data.skuId === 'string'
        ? [data.skuId]
        : [];
    if (
      (data.applicationId !== undefined && data.applicationId !== client.application.id) ||
      !skus.some((sku) => policy!.products.some((product) => product.skuId === sku))
    )
      return;
    if (typeof data.id !== 'string' || !id.safeParse(data.id).success) return;
    const selectedSkus = skus
        .filter((sku) => policy!.products.some((product) => product.skuId === sku))
        .sort(),
      lifecycle = Object.fromEntries(
        [
          'status',
          'deleted',
          'consumed',
          'startsTimestamp',
          'endsTimestamp',
          'currentPeriodStartTimestamp',
          'currentPeriodEndTimestamp',
          'canceledTimestamp',
        ].map((name) => {
          const value = data[name as keyof typeof data];
          return [
            name,
            typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
              ? value
              : null,
          ];
        }),
      ),
      at = clock(),
      key = `${kind}:${data.id}:${createHash('sha256')
        .update(JSON.stringify([selectedSkus, lifecycle]))
        .digest('hex')
        .slice(0, 24)}`;
    if (store.get(EVENTS, key)) return;
    store.set(
      'premium.entitlementEpoch',
      'current',
      (store.get<number>('premium.entitlementEpoch', 'current') ?? 0) + 1,
    );
    store.set(EVENTS, key, {
      at,
      kind,
      id: data.id,
      skuIds: selectedSkus,
      userId: typeof data.userId === 'string' ? data.userId : null,
      guildId: typeof data.guildId === 'string' ? data.guildId : null,
      status: typeof data.status === 'number' ? data.status : null,
      lifecycle,
    });
  }
  function sweep(store: Store, time = clock()): void {
    for (const namespace of [USAGE, EVENTS])
      for (const row of store.list<{ at: number; status?: string }>(namespace))
        if (row.value.at < time - 90 * 86400000) store.delete(namespace, row.key);
        else if (namespace === USAGE && row.value.status === 'pending' && row.value.at < time - 600000)
          store.set(namespace, row.key, { ...row.value, status: 'unknown' });
    for (const row of store.list<CreditClaim>(CLAIMS))
      if (row.value.state === 'pending' && row.value.updatedAt < time - 600000)
        store.set(CLAIMS, row.key, { ...row.value, state: 'uncertain', updatedAt: time });
    const events = store.list<{ at: number }>(EVENTS);
    if (events.length > 10000)
      for (const row of events.sort((a, b) => a.value.at - b.value.at).slice(0, events.length - 10000))
        store.delete(EVENTS, row.key);
  }
  return {
    registerActions,
    getAccess,
    authorize,
    begin,
    aiAllowance,
    appearance,
    recordEvent,
    sweep,
    status: () => ({
      configured: configured(),
      error: policyError ?? null,
      products: policy?.products.length ?? 0,
    }),
    close() {
      closed = true;
    },
  };
}
function pickProduct(product: Product) {
  return {
    id: product.id,
    skuId: product.skuId,
    name: product.name,
    description: product.description,
    kind: product.kind,
    scope: product.scope,
    actions: product.actions,
    commandLimits: product.commandLimits,
    credits: product.credits,
    creditsPerAction: product.kind === 'consumable' ? product.creditsPerAction : undefined,
  };
}
function pickSku(sku: SKU) {
  return {
    id: sku.id,
    name: sku.name,
    type: sku.type,
    flags: Number(sku.flags.bitfield),
    applicationId: sku.applicationId,
  };
}
function countBy<T>(items: T[], key: (value: T) => string) {
  const values: Record<string, number> = {};
  for (const item of items) {
    const id = key(item);
    values[id] = (values[id] ?? 0) + 1;
  }
  return values;
}
