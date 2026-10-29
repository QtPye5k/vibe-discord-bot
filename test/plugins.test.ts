import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { loadPlugins } from '../src/core/plugins.js';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'discord plugin # test-'));
  await mkdir(join(root, 'plugins'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  t.after(async () => {
    const part = relative(tmpdir(), root);
    if (part.startsWith('discord plugin # test-') && !part.includes('..'))
      await rm(root, { recursive: true, force: true });
  });
  const registry = new ActionRegistry();
  registry.register({
    id: 'built.in',
    category: 'system',
    description: 'existing',
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({}),
    execute: () => 'existing',
  });
  const put = async (id: string, source: string) => {
    const directory = join(root, 'plugins', id);
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'index.js');
    await writeFile(entry, source);
    return entry;
  };
  return { root, registry, put };
}
function source(id: string, actionId = `${id}.echo`, extras = '') {
  return `import {writeFileSync} from 'node:fs'; export const name=${JSON.stringify(id)}; export const version='1.2.3'; export function register(registry,{z,permissions}) { registry.register({id:${JSON.stringify(actionId)},description:'Plugin echo',category:'plugins',schema:z.strictObject({text:z.string()}),userPermissions:[permissions.ViewChannel],botPermissions:[],risk:'read',execute:(_ctx,input)=>input.text}); ${extras} } export function cleanup(){writeFileSync(new URL('./cleaned.txt',import.meta.url),'cleaned');}`;
}
test('empty configured list has no filesystem requirement or implicit discovery', async () => {
  const result = await loadPlugins(new ActionRegistry(), join(tmpdir(), 'does-not-exist'), []);
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(await result.cleanup(), { failures: [] });
});
test('real ESM plugin in a path with spaces/hash loads unchanged, receives API and cleans up once', async (t) => {
  const setup = await fixture(t),
    payload = source('demo'),
    entry = await setup.put('demo', payload);
  await setup.put('unconfigured', 'throw new Error("must never execute");');
  const result = await loadPlugins(setup.registry, setup.root, ['demo']);
  assert.deepEqual(result.plugins, [{ id: 'demo', name: 'demo', version: '1.2.3', actions: 1 }]);
  assert.equal(await readFile(entry, 'utf8'), payload);
  const action = setup.registry.get('demo.echo');
  assert.equal(
    await action.execute({} as ActionContext, action.schema.parse({ text: 'real call' })),
    'real call',
  );
  assert.deepEqual(await result.cleanup(), { failures: [] });
  assert.equal(await readFile(join(setup.root, 'plugins', 'demo', 'cleaned.txt'), 'utf8'), 'cleaned');
  assert.deepEqual(await result.cleanup(), { failures: [] });
  assert.equal(setup.registry.list().length, 2);
});
test('default-export contract and returned async cleanup are supported', async (t) => {
  const setup = await fixture(t);
  await setup.put(
    'default-plugin',
    `import{writeFileSync}from'node:fs'; export default {name:'default-plugin',version:'2.0.0-beta.1',register(registry,{z}){registry.register({id:'default.echo',description:'Echo',category:'plugins',schema:z.string(),userPermissions:[],botPermissions:[],risk:'read',execute:(_,input)=>input});return async()=>writeFileSync(new URL('./returned.txt',import.meta.url),'done');}};`,
  );
  const result = await loadPlugins(setup.registry, setup.root, ['default-plugin']);
  assert.equal(result.plugins[0]?.actions, 1);
  await result.cleanup();
  assert.equal(await readFile(join(setup.root, 'plugins', 'default-plugin', 'returned.txt'), 'utf8'), 'done');
});
test('invalid IDs, duplicate config and missing modules cannot import arbitrary paths', async (t) => {
  const setup = await fixture(t);
  for (const ids of [['../outside'], ['C:\\secret'], ['demo.js'], ['demo/demo'], ['con'], ['demo', 'demo']])
    await assert.rejects(loadPlugins(setup.registry, setup.root, ids));
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['missing']), /No staged/);
  assert.equal(setup.registry.list().length, 1);
});
test('a junction escaping the plugins root is rejected before the referenced module executes', async (t) => {
  const setup = await fixture(t);
  const outside = join(setup.root, 'outside');
  await mkdir(outside);
  const payload = `import{writeFileSync}from'node:fs';writeFileSync(new URL('./executed.txt',import.meta.url),'executed');export const name='escape';export const version='1.0.0';export function register(){}`;
  await writeFile(join(outside, 'index.js'), payload);
  await symlink(
    outside,
    join(setup.root, 'plugins', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['escape']), /No staged/);
  await assert.rejects(access(join(outside, 'executed.txt')));
  assert.equal(await readFile(join(outside, 'index.js'), 'utf8'), payload);
});
test('a registration failure rolls back the entire staged catalog and invokes previously registered cleanup', async (t) => {
  const setup = await fixture(t);
  await setup.put('first', source('first'));
  await setup.put(
    'second',
    source('second', 'second.echo', 'throw new Error("sensitive provider value must not appear");'),
  );
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['first', 'second']), (error) => {
    assert.match(String(error), /No staged plugin actions/);
    assert.doesNotMatch(String(error), /sensitive provider value/);
    return true;
  });
  assert.deepEqual(
    setup.registry.list().map((action) => action.id),
    ['built.in'],
  );
  for (const id of ['first', 'second'])
    assert.equal(await readFile(join(setup.root, 'plugins', id, 'cleaned.txt'), 'utf8'), 'cleaned');
});
test('builtin collisions and duplicate plugin actions are rejected without partial installation', async (t) => {
  const setup = await fixture(t);
  await setup.put('collision', source('collision', 'built.in'));
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['collision']), /No staged/);
  assert.equal(setup.registry.list().length, 1);
  await setup.put('one', source('one', 'shared.echo'));
  await setup.put('two', source('two', 'shared.echo'));
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['one', 'two']), /No staged/);
  assert.equal(setup.registry.list().length, 1);
});
test('invalid metadata and malformed JavaScript action contracts never reach the main registry', async (t) => {
  const setup = await fixture(t);
  await setup.put(
    'bad-meta',
    `export const name='wrong-name';export const version='latest';export function register(){}`,
  );
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['bad-meta']), /No staged/);
  await setup.put(
    'bad-action',
    `export const name='bad-action';export const version='1.0.0';export function register(registry){registry.register({id:'bad.action',category:'plugins',description:'invalid',schema:{parse:x=>x},userPermissions:[],botPermissions:[],risk:'read',execute:()=>1});}`,
  );
  await assert.rejects(loadPlugins(setup.registry, setup.root, ['bad-action']), /No staged/);
  assert.equal(setup.registry.list().length, 1);
});
test('cleanup executes in reverse registration order, reports failures and is idempotent', async (t) => {
  const setup = await fixture(t);
  for (const id of ['alpha', 'beta'])
    await setup.put(
      id,
      `import{appendFileSync}from'node:fs';export const name='${id}';export const version='1.0.0';export function register(){}export function cleanup(){appendFileSync(new URL('../order.txt',import.meta.url),'${id}'+String.fromCharCode(10));${id === 'beta' ? 'throw new TypeError("private failure");' : ''}}`,
    );
  const loaded = await loadPlugins(setup.registry, setup.root, ['alpha', 'beta']);
  assert.deepEqual(await loaded.cleanup(), { failures: [{ id: 'beta', error: 'TypeError' }] });
  assert.equal(await readFile(join(setup.root, 'plugins', 'order.txt'), 'utf8'), 'beta\nalpha\n');
  await loaded.cleanup();
  assert.equal(await readFile(join(setup.root, 'plugins', 'order.txt'), 'utf8'), 'beta\nalpha\n');
});
