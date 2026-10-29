import '../core/environment.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../core/store.js';
import { projectPath } from '../core/paths.js';
import { createHostAgent } from './service.js';
await mkdir(projectPath('data'), { recursive: true });
const keyPath = projectPath('data/host-agent.key');
let key = process.env.HOST_AGENT_KEY?.trim();
if (!key) {
  try {
    key = (await readFile(keyPath, 'utf8')).trim();
  } catch {
    key = randomBytes(32).toString('hex');
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
}
const port = Number(process.env.HOST_AGENT_PORT || 3010);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HOST_AGENT_PORT.');
const store = new Store(projectPath(process.env.HOST_AGENT_DATABASE || 'data/host-agent.sqlite'));
const agent = createHostAgent({
  store,
  key,
  manifest: process.env.HOST_AGENT_MANIFEST ? projectPath(process.env.HOST_AGENT_MANIFEST) : '',
});
const server = createServer((req, res) => {
  void agent
    .handle(req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    })
    .catch(() => {
      res.writeHead(500);
      res.end();
    });
});
server.maxConnections = 32;
server.headersTimeout = 10000;
server.requestTimeout = 10000;
server.listen(port, process.env.HOST_AGENT_BIND || '127.0.0.1', () =>
  console.log(
    `Host agent listening on configured port ${port}. Local authorization file: ${keyPath}. Keep it private; remote access requires HTTPS.`,
  ),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void agent.close().then(() => store.close());
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
