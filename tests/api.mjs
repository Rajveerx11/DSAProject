import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The test owns its child, ephemeral port, and temporary static fixtures, not repository web/.
const binary = resolve(process.argv[2] || './build/musiclab');
const fixture = await mkdtemp(join(tmpdir(), 'musiclab-api-'));
await mkdir(join(fixture, 'web'));
const assets = { 'index.html': '<!doctype html><title>API fixture</title>\n',
  'styles.css': 'body { color: black; }\n', 'app.js': '"use strict";\n' };
for (const [name, content] of Object.entries(assets)) await writeFile(join(fixture, 'web', name), content);
await writeFile(join(fixture, 'web', 'secret.txt'), 'not public');
const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
assert.notEqual(port, 8080);
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const host = `127.0.0.1:${port}`;
const server = spawn(binary, ['--port', String(port)], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '';
server.stdout.on('data', data => { output += data; });
server.stderr.on('data', data => { errors += data; });
const exited = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('exit', (code, signal) => resolve({ code, signal }));
});
let checks = 0;

function responseCheck(response) {
  assert.equal(Number(response.headers['content-length']), response.body.length, 'exact byte Content-Length');
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /media-src 'self' blob:/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  checks++;
  return response;
}

function request(method = 'GET', path = '/api/state', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false,
      headers: { Host: host, ...(method === 'POST' ? {
        'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
        Origin: `http://${host}` } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(responseCheck({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(6000, () => req.destroy(new Error('HTTP request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function parseRaw(bytes) {
  const split = bytes.indexOf('\r\n\r\n');
  assert.ok(split >= 0, 'response has complete headers');
  const lines = bytes.subarray(0, split).toString().split('\r\n');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    assert.ok(colon > 0);
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return responseCheck({ status: Number(lines[0].split(' ')[1]), headers, body: bytes.subarray(split + 4) });
}

function raw(bytes, { halfClose = true, fragmented = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(6000, () => socket.destroy(new Error('Raw request timeout')));
    socket.on('error', reject);
    socket.on('data', data => chunks.push(data));
    socket.on('end', () => {
      try { resolve(parseRaw(Buffer.concat(chunks))); } catch (error) { reject(error); }
    });
    socket.on('connect', () => {
      if (fragmented) {
        const split = bytes.length - 5;
        socket.write(bytes.slice(0, split));
        setTimeout(() => halfClose ? socket.end(bytes.slice(split)) : socket.write(bytes.slice(split)), 30);
      } else if (halfClose) socket.end(bytes);
      else socket.write(bytes);
    });
  });
}

function wire(body, extra = '', method = 'POST', path = '/api/action') {
  return `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;
}

function invariant(state) {
  assert.equal(state.ok, true);
  assert.equal(state.playlists.length, 2);
  const all = new Set();
  for (const list of state.playlists) {
    assert.equal(list.size, list.nodes.length);
    assert.equal(list.head, list.nodes[0]?.id ?? null);
    assert.equal(list.tail, list.nodes.at(-1)?.id ?? null);
    assert.ok(list.size ? list.nodes.some(n => n.id === list.current) : list.current === null);
    list.nodes.forEach((node, index) => {
      assert.ok(Number.isSafeInteger(node.id) && node.id > 0 && !all.has(node.id));
      all.add(node.id);
      assert.equal(node.prev, list.nodes[index - 1]?.id ?? null);
      assert.equal(node.next, list.nodes[index + 1]?.id ?? null);
      assert.ok(Buffer.byteLength(node.title) <= 127 && Buffer.byteLength(node.artist) <= 127);
    });
  }
  assert.ok(all.size <= 200);
  assert.ok(state.operation.action && state.operation.message && state.operation.complexity);
  assert.ok(Array.isArray(state.operation.steps) && Array.isArray(state.operation.changed));
  assert.equal(new Set(state.operation.changed).size, state.operation.changed.length);
  return state;
}

async function state() {
  const res = await request();
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  return invariant(JSON.parse(res.body));
}

async function action(fields) {
  const res = await request('POST', '/api/action', new URLSearchParams(fields).toString());
  assert.equal(res.status, 200, res.body.toString());
  const data = invariant(JSON.parse(res.body));
  assert.equal(data.operation.action, fields.action);
  return data;
}

async function rejectUnchanged(send, expected) {
  const before = await state();
  const res = await send();
  assert.equal(res.status, expected, res.body.toString());
  if (expected === 405) assert.ok(['GET', 'POST'].includes(res.headers.allow));
  const error = JSON.parse(res.body);
  assert.equal(error.ok, false);
  assert.ok(error.error);
  assert.deepEqual(await state(), before, 'rejection must not mutate any state or operation');
}

try {
  await Promise.race([
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup failed: ${errors}`)), 5000);
      const ready = () => {
        if (output.includes('Music lab listening')) { clearTimeout(timer); server.stdout.off('data', ready); resolve(); }
      };
      server.stdout.on('data', ready); ready();
    }),
    exited.then(result => { throw new Error(`Server exited at startup: ${JSON.stringify(result)} ${errors}`); })
  ]);
  let data = await state();
  assert.deepEqual(data.playlists.map(p => p.size), [3, 2]);
  const initial = structuredClone(data.playlists);
  const ids = initial[0].nodes.map(n => n.id);
  const sideIds = initial[1].nodes.map(n => n.id);
  data = await action({ action: 'reverse', playlist: 'main' });
  assert.deepEqual(data.playlists[0].nodes.map(n => n.id), [...ids].reverse());
  assert.equal(data.playlists[0].current, ids[0]);
  data = await action({ action: 'reverse', playlist: 'main' });
  assert.deepEqual(data.playlists, initial);
  data = await action({ action: 'previous', playlist: 'main' });
  assert.equal(data.playlists[0].current, ids[0]); assert.deepEqual(data.operation.changed, []);
  data = await action({ action: 'next', playlist: 'main' });
  assert.equal(data.playlists[0].current, ids[1]);
  data = await action({ action: 'delete', playlist: 'main', id: ids[1] });
  assert.equal(data.playlists[0].current, ids[2]);
  assert.deepEqual(data.operation.changed, [ids[1], ids[0], ids[2]]);
  assert.match(data.operation.steps.join(' '), /Free node/);
  data = await action({ action: 'next', playlist: 'main' });
  assert.equal(data.playlists[0].current, ids[2]); assert.deepEqual(data.operation.changed, []);
  data = await action({ action: 'delete', playlist: 'main', id: ids[2] });
  assert.equal(data.playlists[0].current, ids[0]);
  data = await action({ action: 'delete', playlist: 'main', id: ids[0] });
  assert.equal(data.playlists[0].size, 0);
  data = await action({ action: 'next', playlist: 'main' });
  assert.equal(data.playlists[0].current, null); assert.match(data.operation.message, /empty/);
  data = await action({ action: 'reverse', playlist: 'main' });
  assert.equal(data.playlists[0].head, null);
  await action({ action: 'select', playlist: 'secondary', id: sideIds[1] });
  data = await action({ action: 'merge', playlist: 'main', source: 'secondary' });
  assert.equal(data.playlists[0].current, sideIds[1]);
  assert.equal(data.playlists[1].size, 0);
  assert.deepEqual(data.playlists[0].nodes.map(n => n.id), sideIds);
  const moved = structuredClone(data.playlists);
  data = await action({ action: 'merge', playlist: 'main', source: 'secondary' });
  assert.deepEqual(data.playlists, moved); assert.deepEqual(data.operation.changed, []);
  data = await action({ action: 'add', playlist: 'secondary', title: '  Caf\u00e9 \u{1f3b5} " \\ <script>  ', artist: '  Demo tones  ' });
  assert.equal(data.playlists[1].nodes[0].artist, 'Demo tones');
  const maxId = Math.max(...data.playlists.flatMap(p => p.nodes.map(n => n.id)));
  data = await action({ action: 'reset' });
  assert.deepEqual(data.playlists.map(p => p.size), [3, 2]);
  assert.ok(data.playlists.flatMap(p => p.nodes).every(n => n.id > maxId));
  const oldCurrent = data.playlists[0].current;
  const mergedIds = data.playlists.flatMap(p => p.nodes.map(n => n.id));
  data = await action({ action: 'merge', playlist: 'main', source: 'secondary' });
  assert.equal(data.playlists[0].current, oldCurrent);
  assert.deepEqual(data.playlists[0].nodes.map(n => n.id), mergedIds);
  assert.equal(data.playlists[1].current, null); assert.equal(data.operation.complexity, 'O(1)');
  data = await action({ action: 'merge', playlist: 'secondary', source: 'main' });
  assert.equal(data.playlists[1].current, oldCurrent);
  await action({ action: 'reset' });

  // Metadata byte bounds, trimming, escaping, and malformed forms.
  const safeTitle = 'Caf\u00e9 \u{1f3b5} " \\ <script>';
  data = await action({ action: 'add', playlist: 'main', title: `  ${safeTitle}  `, artist: ' Demo tones ' });
  assert.equal(data.playlists[0].nodes.at(-1).title, safeTitle);
  data = await action({ action: 'add', playlist: 'secondary', title: '\u00e9'.repeat(63) + 'x', artist: 'x'.repeat(127) });
  assert.equal(Buffer.byteLength(data.playlists[1].nodes.at(-1).title), 127);
  const invalidForms = [
    '', 'action=reset&action=reset', 'action=reset&extra=x', 'action=reset&playlist=main',
    'action=%GG', 'action=reset&', 'action=reset&=x', 'action',
    'action=add&playlist=main&title=x&artist=y&extra=z',
    'action=add&playlist=main&title=x&%61rtist=y&artist=z',
    'action=add&playlist=main&title=%&artist=x', 'action=add&playlist=main&title=%0&artist=x',
    'action=add&playlist=main&title=%00&artist=x', 'action=add&playlist=main&title=%0A&artist=x',
    'action=add&playlist=main&title=%09&artist=x', 'action=add&playlist=main&title=%7F&artist=x',
    'action=add&playlist=main&title=%C2%85&artist=x', 'action=add&playlist=main&title=%C0%AF&artist=x',
    'action=add&playlist=main&title=%ED%A0%80&artist=x', 'action=add&playlist=main&title=%F4%90%80%80&artist=x',
    'action=add&playlist=main&title=%F0%9F&artist=x', 'action=add&playlist=main&title=+++&artist=x',
    new URLSearchParams({ action: 'add', playlist: 'main', title: 'x'.repeat(128), artist: 'x' }).toString(),
    new URLSearchParams({ action: 'add', playlist: 'main', title: '\u00e9'.repeat(64), artist: 'x' }).toString(),
    'action=next&playlist=main&extra=x', 'action=reverse&playlist=main&id=1',
    'action=merge&playlist=main&source=main', 'action=merge&playlist=main&source=foreign',
    'action=delete&playlist=main&id=0', 'action=select&playlist=main&id=-1',
    'action=select&playlist=main&id=4294967296', 'action=delete&playlist=main&id=1x',
    'action=delete&playlist=main&id=1.0', 'action=select&playlist=main',
    'action=nope&playlist=main', 'action=next&playlist=foreign'
  ];
  for (const body of invalidForms) await rejectUnchanged(() => request('POST', '/api/action', body), 400);
  await rejectUnchanged(() => request('POST', '/api/action', 'action=select&playlist=main&id=4294967295'), 404);
  await rejectUnchanged(() => request('POST', '/api/action', `action=delete&playlist=secondary&id=${oldCurrent}`), 404);
  await rejectUnchanged(() => request('POST', '/api/action', 'action=reset', { 'Content-Type': 'application/json' }), 415);
  await rejectUnchanged(() => request('POST', '/api/action', 'x'.repeat(4097)), 413);
  await rejectUnchanged(() => request('GET', '/api/state', '', { Host: 'evil.example' }), 403);
  for (const origin of ['https://evil.example', 'null', `http://localhost:${port}`, `http://${host}.evil.example`, `https://${host}`, `http://${host}/`])
    await rejectUnchanged(() => request('POST', '/api/action', 'action=reset', { Origin: origin }), 403);
  await rejectUnchanged(() => request('POST', '/api/action', 'action=reset', { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await rejectUnchanged(() => request('POST', '/api/action', 'action=reset', { 'Sec-Fetch-Site': 'same-site' }), 403);
  await rejectUnchanged(() => request('GET', '/api/action'), 405);
  await rejectUnchanged(() => request('POST', '/api/state', 'action=reset'), 405);
  await rejectUnchanged(() => request('PUT', '/api/state'), 405);
  await rejectUnchanged(() => request('GET', '/api/nope'), 404);

  const malformedWire = [
    ['GET /api/state HTTP/1.1\r\n\r\n', 400],
    [`GET /api/state HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\n\r\n`, 400],
    [wire('action=reset', 'Transfer-Encoding: chunked\r\n'), 400],
    [wire('action=reset', 'Content-Length: 12\r\n'), 400],
    [wire('action=reset', 'Content-Length : 12\r\n'), 400],
    [wire('action=reset', 'Expect: 100-continue\r\n'), 400],
    [wire('action=reset', ' folded: bad\r\n'), 400],
    [wire('action=reset', 'X-Bad: bad\x01\r\n'), 400],
    [wire('action=reset', `Origin: http://${host}\r\nOrigin: http://${host}\r\n`), 400],
    [`GET /api/state HTTP/1.0\r\nHost: ${host}\r\n\r\n`, 400],
    [`GET /api/state HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 1\r\n\r\nx`, 400],
    [`POST /api/action HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\naction=reset`, 400],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: -1'), 400],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: +12'), 400],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: 1x'), 400],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: 4097'), 413],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: 11'), 400],
    [wire('action=reset').replace('Content-Length: 12', 'Content-Length: 13'), 400],
    [wire('action=re\0set'), 400],
    [`GET /api/state HTTP/1.1\r\nHost: ${host}\r\nX-Large: ${'x'.repeat(8192)}\r\n\r\n`, 413],
    [`GET /api/state HTTP/1.1\r\nHost: ${host}\r\n${Array.from({ length: 64 }, (_, i) => `X-${i}: x\r\n`).join('')}\r\n`, 413],
    [wire('action=reset') + `GET /api/state HTTP/1.1\r\nHost: ${host}\r\n\r\n`, 400]
  ];
  for (const [bytes, status] of malformedWire) await rejectUnchanged(() => raw(bytes), status);
  await rejectUnchanged(() => raw(`GET /api/state HTTP/1.1\r\nHost: ${host}\r\n`, { halfClose: false }), 408);
  await rejectUnchanged(() => raw(wire('action=reset').slice(0, -1), { halfClose: false }), 408);
  const fragmented = await raw(wire('action=reset', `Origin: http://${host}\r\n`), { fragmented: true });
  assert.equal(fragmented.status, 200); invariant(JSON.parse(fragmented.body));
  const nonBrowser = await raw(wire('action=reset'));
  assert.equal(nonBrowser.status, 200); invariant(JSON.parse(nonBrowser.body));
  const charset = await request('POST', '/api/action', 'action=reset', { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' });
  assert.equal(charset.status, 200);
  const localhost = await request('POST', '/api/action', 'action=reset', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
  assert.equal(localhost.status, 200);

  // Only the three fixed assets (plus / alias) are public. No dynamic path decoding.
  for (const [name, content] of Object.entries(assets)) {
    const res = await request('GET', `/${name}`);
    assert.equal(res.status, 200); assert.equal(res.body.toString(), content);
  }
  const root = await request('GET', '/');
  assert.equal(root.status, 200); assert.equal(root.body.toString(), assets['index.html']);
  for (const path of ['/secret.txt', '/web/index.html', '/src/server.c', '/../API.md', '/%2e%2e/API.md', '/app.js?x=1', '/index.html/'])
    await rejectUnchanged(() => request('GET', path), 404);
  await rejectUnchanged(() => request('POST', '/app.js', 'action=reset'), 405);

  // Abrupt client disconnect must not terminate the process (SIGPIPE ignored).
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`GET /api/state HTTP/1.1\r\nHost: ${host}\r\n\r\n`, () => socket.destroy());
    });
    socket.on('error', reject); socket.on('close', resolve);
  });
  await state();

  // At maximum occupancy, large escaped metadata still serializes actual reciprocal links.
  data = await action({ action: 'reset' });
  let maximum = Math.max(...data.playlists.flatMap(p => p.nodes.map(n => n.id)));
  for (let i = 0; i < 195; i++) {
    data = await action({ action: 'add', playlist: i % 2 ? 'main' : 'secondary',
      title: '"\\'.repeat(63) + 'x', artist: '"\\'.repeat(63) + 'x' });
    const node = data.playlists[i % 2 ? 0 : 1].nodes.at(-1);
    assert.ok(node.id > maximum); maximum = node.id;
  }
  assert.equal(data.playlists.reduce((n, p) => n + p.size, 0), 200);
  await rejectUnchanged(() => request('POST', '/api/action', 'action=add&playlist=main&title=x&artist=y'), 400);
  data = await action({ action: 'merge', playlist: 'main', source: 'secondary' });
  assert.equal(data.playlists[0].size, 200);
  await action({ action: 'reverse', playlist: 'main' });
  await action({ action: 'reverse', playlist: 'main' });
  await action({ action: 'delete', playlist: 'main', id: data.playlists[0].head });
  data = await action({ action: 'add', playlist: 'main', title: 'new', artist: 'demo' });
  assert.ok(data.playlists[0].tail > maximum);
  data = await action({ action: 'reset' });
  assert.ok(data.playlists.flatMap(p => p.nodes).every(n => n.id > maximum));
  console.log(`api: PASS (${checks} responses; actions, invariants, limits, framing, origins, static allowlist, deadlines, disconnect)`);
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  const result = await exited;
  await rm(fixture, { recursive: true, force: true });
  assert.equal(result.code, 0, `server exit ${JSON.stringify(result)}: ${errors}`);
  assert.equal(errors, '', `server/sanitizer stderr: ${errors}`);
  console.log('api: owned server stopped cleanly (exit 0)');
}
