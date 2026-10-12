import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-bulk-test-'));
const dbPath = path.join(root, 'db.json');
const read = () => JSON.parse(fs.readFileSync(dbPath, 'utf8'));
let server, base;
function fixture() {
  const items = ['a', 'b', 'c'].map((id, i) => ({
    id, title: id, createdAt: `2026-10-0${3-i}T10:00:00Z`,
    collection: i === 2 ? 'Другая' : 'интерфейс', tags: i === 0 ? ['UI', 'дашборд'] : ['стекло'], note: 'заметка',
    coverUrl: `/media/${id}.jpg`, media: [{ id: `m-${id}`, type: 'image', localUrl: `/media/${id}.jpg` }]
  }));
  items[0].media.push({ id: 'v-a', type: 'video', localUrl: '/media/a.mp4', posterUrl: '/media/poster.jpg' });
  items[1].media.push({ id: 'shared-b', type: 'image', localUrl: '/media/shared.jpg' });
  items[2].media.push({ id: 'shared-c', type: 'image', localUrl: '/media/shared.jpg' });
  fs.writeFileSync(dbPath, JSON.stringify({ items }));
  for (const filename of ['a.jpg','b.jpg','c.jpg','a.mp4','poster.jpg','shared.jpg']) fs.writeFileSync(path.join(root, 'media', filename), 'fixture');
  return items;
}
async function request(method, body) {
  const response = await fetch(base + '/api/items/bulk', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  fs.mkdirSync(path.join(root, 'media'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], { cwd: project, env: { ...process.env, PORT: String(port), REF_VAULT_STORAGE_DIR: root, REF_VAULT_INBOX_DIR: path.join(root, 'inbox') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Test server startup timeout')), 10000);
    server.stdout.on('data', output => { if (output.toString().includes('http://localhost:')) { clearTimeout(timer); resolve(); } });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Test server exited: ${code}`)); });
  });
});
after(async () => {
  if (server && server.exitCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
  fs.rmSync(root, { recursive: true, force: true });
});

test('bulk update keeps original tags, notes, media, dates and order; matches existing tag/collection spelling', async () => {
  const original = fixture();
  const result = await request('PATCH', { ids: ['a','b','b'], addTags: [' ui ', 'форма', 'ФОРМА', ' стекло '], collection: ' другая ' });
  assert.deepEqual(result, { status: 200, body: { ok: true, updated: 2 } });
  const items = read().items;
  assert.deepEqual(items[0].tags, ['UI','дашборд','форма','стекло']);
  assert.deepEqual(items[1].tags, ['стекло','UI','форма']);
  assert.equal(items[0].collection, 'Другая');
  assert.equal(items[1].collection, 'Другая');
  assert.deepEqual(items[2], original[2]);
  for (let i=0;i<2;i++) assert.deepEqual({ ...items[i], tags: original[i].tags, collection: original[i].collection }, original[i]);
  assert.equal((await request('PATCH', { ids: ['a','b'], addTags: ['форма'] })).status, 200);
  assert.equal(read().items[0].collection, 'Другая');
  assert.deepEqual(read().items[0].tags, items[0].tags);
  assert.equal((await request('PATCH', { ids: ['a'], collection: 'Новая' })).status, 200);
  assert.deepEqual(read().items[0].tags, items[0].tags);
});

test('invalid or stale batch cannot partially update or delete references', async () => {
  fixture();
  const before = fs.readFileSync(dbPath, 'utf8');
  for (const method of ['PATCH','DELETE']) {
    for (const ids of [[], null, ['a',null], ['a',1]]) assert.equal((await request(method, { ids, addTags: ['tag'] })).status, 400);
    assert.equal((await request(method, { ids: ['a','missing'], addTags: ['tag'] })).status, 409);
  }
  for (const fields of [{ addTags: null }, { addTags: [1] }, { collection: [] }, { collection: ' ' }, {}, { addTags: [' '] }]) {
    assert.equal((await request('PATCH', { ids: ['a'], ...fields })).status, 400);
  }
  assert.equal(fs.readFileSync(dbPath, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(root, 'media/a.jpg')));
});

test('batch deletion removes unique media and posters while retaining files shared with unselected refs', async () => {
  const original = fixture();
  assert.deepEqual(await request('DELETE', { ids: ['a','b','b'] }), { status: 200, body: { ok: true, deleted: 2 } });
  assert.deepEqual(read().items, [original[2]]);
  for (const filename of ['a.jpg','b.jpg','a.mp4','poster.jpg']) assert.equal(fs.existsSync(path.join(root, 'media', filename)), false);
  for (const filename of ['c.jpg','shared.jpg']) assert.equal(fs.existsSync(path.join(root, 'media', filename)), true);
});
