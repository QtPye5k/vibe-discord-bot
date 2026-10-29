import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REST } from 'discord.js';
import { reconcileApplicationCommands } from '../src/discord/command-sync.js';
import { credentialPresent, loadConfig, type Config } from '../src/config.js';
import { Logger } from '../src/core/logger.js';
import { Store } from '../src/core/store.js';

type DeploymentRest = Pick<REST, 'get' | 'put' | 'clearHashSweeper' | 'clearHandlerSweeper'>;
interface DeploymentOptions {
  rest?: DeploymentRest;
  store?: Store;
  logger?: Logger;
}

/** REST-only publication reconciles the same authoritative definitions as Gateway startup. */
export async function runCommandDeployment(config: Config, options: DeploymentOptions = {}): Promise<void> {
  let store = options.store,
    rest = options.rest;
  try {
    if (!credentialPresent(config.discordToken)) throw new Error('Add your Discord bot token to .env first.');
    store ??= new Store(config.databasePath);
    rest ??= new REST({ version: '10', timeout: 20000, retries: 2 }).setToken(config.discordToken);
    const logger = options.logger ?? new Logger([config.discordToken, config.openaiKey]);
    const application = (await rest.get('/oauth2/applications/@me')) as { id: string };
    await reconcileApplicationCommands({ applicationId: application.id, config, store, logger, rest });
  } finally {
    try {
      rest?.clearHashSweeper();
    } finally {
      try {
        rest?.clearHandlerSweeper();
      } finally {
        store?.close();
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await import('../src/core/environment.js');
  const config = loadConfig(),
    logger = new Logger([config.discordToken, config.openaiKey]);
  try {
    await runCommandDeployment(config, { logger });
  } catch (error) {
    logger.error('commands.failed', error);
    process.exitCode = 1;
  }
}
