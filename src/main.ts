import './core/environment.js';
import { credentialPresent, loadConfig } from './config.js';
import { createServices, startBot } from './app.js';
import { Logger } from './core/logger.js';
import { optionalSecrets } from './service-fields.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger([
    config.discordToken,
    config.openaiKey,
    ...optionalSecrets(config.optionalEnvironment),
  ]);
  if (!credentialPresent(config.discordToken)) {
    logger.info('startup.credentials_required', {
      message:
        'Add DISCORD_TOKEN (or DISCORD_BOT_TOKEN) to .env. AI also needs OPENAI_API_KEY. Then run pnpm run doctor and pnpm start.',
    });
    process.exitCode = 1;
    return;
  }
  const services = createServices(config);
  const controller = new AbortController();
  let ready = false,
    startup: ReturnType<typeof startBot>,
    shutdownPromise: Promise<void> | undefined;
  const supervised = process.env.BOT_SUPERVISED === '1';
  const removeHandlers = () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
  };
  const shutdown = (exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    services.setRestartHandler(undefined);
    if (!ready) controller.abort();
    shutdownPromise = (async () => {
      try {
        const stop = await startup;
        await stop();
        process.exitCode = exitCode;
      } catch (error) {
        await services.close();
        if (controller.signal.aborted) process.exitCode = exitCode;
        else {
          logger.error('shutdown.failed', error);
          process.exitCode = 1;
        }
      } finally {
        removeHandlers();
        if (process.connected) process.disconnect?.();
      }
    })();
    return shutdownPromise;
  };
  const onInterrupt = () => void shutdown(),
    onTerminate = () => void shutdown(),
    onDisconnect = () => void shutdown();
  const onMessage = (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'bot.shutdown')
      void shutdown();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  if (supervised) {
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  }
  startup = startBot(services, controller.signal);
  try {
    await startup;
    ready = true;
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    if (supervised) {
      services.setRestartHandler(() => {
        services.setRestartHandler(undefined);
        const timer = setTimeout(() => void shutdown(75), 1000);
        timer.unref();
      });
    }
  } catch (error) {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    await services.close();
    logger.error('startup.failed', error);
    process.exitCode = 1;
    removeHandlers();
    if (process.connected) process.disconnect?.();
  }
}
void main().catch((error) => {
  new Logger().error('configuration.failed', error);
  process.exitCode = 1;
});
