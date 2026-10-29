import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { assertOperator } from '../core/operator.js';
import { assertPermissions, freshContext } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import {
  providerHttp,
  providerJson,
  safeProviderValue,
  type ProviderTransport,
} from '../integrations/http.js';

const metric = z.enum([
  'visitors',
  'visits',
  'pageviews',
  'views_per_visit',
  'bounce_rate',
  'visit_duration',
  'events',
  'conversion_rate',
]);
const query = z
  .strictObject({
    dateRange: z
      .enum(['day', '24h', '7d', '28d', '30d', '91d', 'month', '6mo', '12mo', 'year'])
      .default('7d'),
    metrics: z.array(metric).min(1).max(8).default(['visitors', 'visits', 'pageviews']),
    dimension: z
      .enum([
        'time:day',
        'time:week',
        'time:month',
        'visit:source',
        'visit:country',
        'visit:device',
        'event:page',
        'event:goal',
      ])
      .optional(),
    goal: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .superRefine((value, ctx) => {
    if (value.metrics.includes('conversion_rate') && !value.goal && value.dimension !== 'event:goal')
      ctx.addIssue({
        code: 'custom',
        message: 'Conversion rate requires a configured goal or goal dimension.',
      });
    if (
      value.dimension === 'event:goal' &&
      value.metrics.some((name) => ['bounce_rate', 'views_per_visit', 'visit_duration'].includes(name))
    )
      ctx.addIssue({ code: 'custom', message: 'Session metrics cannot be grouped by event goals.' });
  });
/** Only the installation's selected site is queryable; callers cannot redirect its API key. */
export function registerWebsiteAnalyticsActions(
  registry: ActionRegistry,
  options: { env: NodeJS.ProcessEnv; operatorIds: readonly string[]; transport?: ProviderTransport },
) {
  const key = options.env.PLAUSIBLE_API_KEY?.trim() || '',
    site = options.env.PLAUSIBLE_SITE_ID?.trim() || '';
  const available = () => !!key && !!site && site.length <= 255 && !/[\r\n]/.test(site);
  registry.register({
    id: 'website.analytics',
    category: 'integrations',
    risk: 'read',
    available,
    unavailableReason:
      'Set PLAUSIBLE_API_KEY and PLAUSIBLE_SITE_ID for the selected website. The Stats API requires an eligible Plausible plan.',
    description:
      'Query authenticated website traffic, acquisition, pages and goal conversion aggregates from the installation’s selected Plausible site.',
    schema: query,
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: async (ctx, input) => {
      const epoch = ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:integrations`) ?? 0;
      async function check() {
        const fresh = await freshContext(ctx);
        assertOperator(fresh, options.operatorIds);
        await assertPermissions(fresh, [P.ManageGuild], [], {});
        registry.assertPolicy(fresh, 'website.analytics');
        if (
          (fresh.store.get<string[]>('core.disabled', fresh.guild.id) ?? []).includes('integrations') ||
          (fresh.store.get<number>('core.featureEpochs', `${fresh.guild.id}:integrations`) ?? 0) !== epoch
        )
          throw new UserError('Website analytics was disabled or changed during this request.');
        ctx = fresh;
      }
      if (!available()) throw new UserError('Website analytics is not configured.');
      await check();
      const response = await providerHttp('plausible', 'https://plausible.io', options.transport)(
        '/api/v2/query',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          json: {
            site_id: site,
            metrics: [...new Set(input.metrics)],
            date_range: input.dateRange,
            dimensions: input.dimension ? [input.dimension] : [],
            filters: input.goal ? [['is', 'event:goal', [input.goal]]] : [],
            pagination: { limit: input.limit, offset: 0 },
          },
          maxBytes: 524288,
        },
        check,
      );
      const value = providerJson(response, 'plausible');
      await check();
      return safeProviderValue(value, [key]);
    },
  });
}
