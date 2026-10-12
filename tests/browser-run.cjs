'use strict';
// Own one temporary server and its browser test; never touch an existing listener.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = spawn(path.join(root, 'build/musiclab'), ['--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let startupTimer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error(`C server startup failed: ${errors}`)), 5000);
        const ready = () => { if (output.includes('Music lab listening')) resolve(); };
        server.stdout.on('data', ready); ready();
      }),
      exit.then(result => { throw new Error(`C server exited early: ${JSON.stringify(result)} ${errors}`); })
    ]);
    clearTimeout(startupTimer);
    const test = spawn(process.execPath, [path.join(__dirname, 'browser.cjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, MUSICLAB_ROOT: root, MUSICLAB_URL: `http://127.0.0.1:${port}` } });
    const [code, signal] = await once(test, 'exit');
    assert.equal(code, 0, `Browser test exit ${code}, signal ${signal}`);
  } finally {
    clearTimeout(startupTimer);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
    const result = await exit;
    assert.equal(result.code, 0, `C server exit: ${JSON.stringify(result)} ${errors}`);
    assert.equal(errors, '', 'No C server errors');
    console.log('browser: owned C server stopped cleanly (exit 0)');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
