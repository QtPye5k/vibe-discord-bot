import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from 'dotenv';
const installation = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Only locally configured, immutable, verified releases can replace the default entrypoint. */
export async function resolveLaunchEntry(env = process.env, root = installation) {
  const active = env.DEPLOYMENT_ACTIVE_FILE,
    releases = env.DEPLOYMENT_RELEASES_DIRECTORY;
  if (!active && !releases) return resolve(root, 'dist/main.js');
  if (!active || !releases)
    throw new Error('Both deployment release directory and active pointer must be configured.');
  const { readDeploymentPointer, verifyRelease } = await import(
    pathToFileURL(resolve(root, 'dist/features/deployment.js')).href
  );
  const pointer = await readDeploymentPointer(resolve(root, active));
  if (!pointer) return resolve(root, 'dist/main.js');
  const release = await verifyRelease(
    resolve(root, releases),
    pointer.current.id,
    pointer.current.manifestHash,
  );
  return release.entry;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  config({ path: process.env.DOTENV_CONFIG_PATH || resolve(installation, '.env'), quiet: true });
  process.env.BOT_WORKSPACE_ROOT = process.env.BOT_WORKSPACE_ROOT || installation;
  process.env.DOTENV_CONFIG_PATH = process.env.DOTENV_CONFIG_PATH || resolve(installation, '.env');
  try {
    const entry = await resolveLaunchEntry();
    await import(pathToFileURL(entry).href);
  } catch {
    console.error(
      'Startup release verification failed. Inspect the configured release manifest, active pointer and deployment logs; no unverified code was started.',
    );
    process.exitCode = 1;
  }
}
