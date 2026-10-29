import '../core/environment.js';
import { WebhookClient } from 'discord.js';
import { Store } from '../core/store.js';
import { projectPath } from '../core/paths.js';
import { createUptimeMonitor, type MonitorState } from './service.js';
const target = process.env.MONITOR_TARGET_URL?.trim(),
  webhookUrl = process.env.MONITOR_DISCORD_WEBHOOK_URL?.trim();
if (!target || !webhookUrl)
  throw new Error('Set MONITOR_TARGET_URL and MONITOR_DISCORD_WEBHOOK_URL to run the independent monitor.');
const destination = new URL(webhookUrl);
if (
  destination.protocol !== 'https:' ||
  destination.hostname !== 'discord.com' ||
  !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(destination.pathname)
)
  throw new Error('Use a Discord webhook URL from the intended alert channel.');
const webhook = new WebhookClient({ url: webhookUrl }, { rest: { timeout: 10000, retries: 0 } }),
  store = new Store(projectPath('data/monitor.sqlite'));
const monitor = createUptimeMonitor({
  target,
  initial: store.get<MonitorState>('monitor', 'state'),
  persist: (state) => store.set('monitor', 'state', state),
  notify: async (event, at, delivery) => {
    await webhook.send({
      content: `Bot readiness ${event === 'down' ? 'is DOWN after three failed checks' : 'has RECOVERED after two successful checks'}. Observed <t:${Math.floor(at / 1000)}:F>. Alert ${delivery.id}.${delivery.coalescedTransitions > 1 ? ` ${delivery.coalescedTransitions} queued state changes were combined; this is the latest observed state.` : ''}`,
      allowedMentions: { parse: [] },
    });
  },
});
let stopping = false,
  inflight: Promise<void> = Promise.resolve();
const tick = () => {
  if (stopping) return;
  inflight = monitor.tick().catch(() => {
    console.error('Monitor request or notification failed; inspect the configured destination.');
  });
};
tick();
const interval = setInterval(tick, 30000);
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  void inflight.finally(() => {
    webhook.destroy();
    store.close();
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log('Independent readiness monitor started; configured URLs and credentials are not logged.');
