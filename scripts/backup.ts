import '../src/core/environment.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from '../src/core/paths.js';
import { backup, DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
const config = loadConfig();
if (!existsSync(config.databasePath)) throw new Error('Database does not exist. Start the bot first.');
const directory = projectPath('backups');
mkdirSync(directory, { recursive: true });
const target = join(directory, `bot-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
const source = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  await backup(source, target);
  console.log(`Consistent SQLite backup saved to ${target}`);
} finally {
  source.close();
}
