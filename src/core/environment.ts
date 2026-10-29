import { config } from 'dotenv';
import { resolve } from 'node:path';
import { projectPath } from './paths.js';

/** Explicit test/operator overrides win; a different launch directory never selects another .env. */
export const ENVIRONMENT_PATH = process.env.DOTENV_CONFIG_PATH
  ? resolve(process.env.DOTENV_CONFIG_PATH)
  : projectPath('.env');
config({ path: ENVIRONMENT_PATH, quiet: true });
