import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { projectPath } from '../src/core/paths.js';
const services = createServices(loadConfig({}), { store: new Store(':memory:') });
try {
  const actions = services.registry.list().map((action) => ({
    id: action.id,
    category: action.category,
    description: action.description,
    risk: action.risk,
    userPermissions: action.userPermissions.map(String),
    botPermissions: action.botPermissions.map(String),
    schema: z.toJSONSchema(action.schema, { io: 'input' }),
  }));
  const json = JSON.stringify(actions, null, 2) + '\n';
  if (process.argv.includes('--write')) {
    writeFileSync(projectPath('docs/actions.json'), json);
    console.log(`Wrote ${actions.length} action schemas to docs/actions.json`);
  } else console.log(json);
} finally {
  await services.close();
}
