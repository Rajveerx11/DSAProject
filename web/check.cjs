'use strict';
// Run: node web/check.cjs. Fixtures test validation only; the UI never substitutes C state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { trimSongText, textProblem, pointer, validateState, makeDemoWav } = require('./app.js');

assert.equal(textProblem('  A record  '), '');
assert.equal(textProblem('a'.repeat(127)), '');
assert.notEqual(textProblem('a'.repeat(128)), '');
assert.equal(textProblem('é'.repeat(63)), '');
assert.notEqual(textProblem('é'.repeat(64)), '');
assert.equal(textProblem('🎵'.repeat(31)), '');
assert.notEqual(textProblem('🎵'.repeat(32)), '');
assert.notEqual(textProblem(' \n '), '');
assert.notEqual(textProblem('side\u0000b'), '');
assert.notEqual(textProblem('side\tb'), '');
assert.equal(textProblem('<img src=x onerror=alert(1)> & "record"'), '');
assert.equal(trimSongText('  A record  '), 'A record');
for (const whitespace of ['\u00a0', '\u2003', '\ufeff', '\u2028', '\u2029']) {
  assert.equal(trimSongText(` ${whitespace} `), whitespace, 'Only ASCII spaces are trimmed');
  assert.equal(textProblem(whitespace), '', 'Match metadata accepted by C');
}
for (let cp = 0x7f; cp <= 0x9f; cp++) {
  assert.notEqual(textProblem(`A${String.fromCodePoint(cp)}B`), '', 'Reject all C1 controls like C');
}
assert.equal(pointer(null), 'NULL');
assert.equal(pointer(9), '#9');

const snapshot = {
  ok: true,
  playlists: [
    { id: 'main', name: 'My playlist', head: 1, tail: 2, current: 1, size: 2,
      nodes: [{ id: 1, title: 'Paper Moon', artist: 'Demo tones', prev: null, next: 2 },
        { id: 2, title: 'Slow Orbit', artist: 'Demo tones', prev: 1, next: null }] },
    { id: 'secondary', name: 'Side B', head: null, tail: null, current: null, size: 0, nodes: [] }
  ],
  operation: { action: 'add', message: 'Appended a node.', complexity: 'O(1)', steps: ['tail = newNode'], changed: [1, 2] }
};
const original = JSON.stringify(snapshot);
assert.equal(validateState(snapshot), snapshot);
assert.equal(JSON.stringify(snapshot), original, 'Reading state must not mutate it');
for (const title of ['\u00a0', '\u2003', '\ufeff', '\u2028', '\u2029', 'A\u00a0B']) {
  const unicodeSnapshot = structuredClone(snapshot);
  unicodeSnapshot.playlists[0].nodes[0].title = title;
  assert.equal(validateState(unicodeSnapshot), unicodeSnapshot, 'Accepted C metadata must remain renderable');
}
for (const damage of [
  s => { s.playlists[0].nodes[0].next = null; },
  s => { s.playlists[0].nodes[1].prev = null; },
  s => { s.playlists[0].head = 2; },
  s => { s.playlists[0].tail = 1; },
  s => { s.playlists[0].current = 99; },
  s => { s.playlists[0].size = 1; },
  s => { s.playlists[0].nodes[1].id = 1; },
  s => { s.playlists[1].current = 1; },
  s => { s.playlists[1].id = 'main'; },
  s => { s.operation.changed = [null]; },
  s => { s.playlists[0].nodes[0].title = 'é'.repeat(64); }
]) {
  const broken = JSON.parse(original);
  damage(broken);
  assert.throws(() => validateState(broken), /invalid state/);
}
assert.throws(() => validateState(null), /invalid state/);
assert.throws(() => validateState({ ok: false, error: 'Not a snapshot' }), /invalid state/);
const empty = JSON.parse(original);
empty.playlists[0] = { id: 'main', name: 'My playlist', head: null, tail: null, current: null, size: 0, nodes: [] };
assert.equal(validateState(empty), empty);
const reversed = JSON.parse(original);
reversed.playlists[0].nodes = [
  { ...snapshot.playlists[0].nodes[1], prev: null, next: 1 },
  { ...snapshot.playlists[0].nodes[0], prev: 2, next: null }
];
reversed.playlists[0].head = 2;
reversed.playlists[0].tail = 1;
assert.equal(validateState(reversed).playlists[0].current, 1);

const wav = makeDemoWav(1);
const view = new DataView(wav);
const word = offset => String.fromCharCode(...new Uint8Array(wav, offset, 4));
assert.equal(word(0), 'RIFF');
assert.equal(word(8), 'WAVE');
assert.equal(word(36), 'data');
assert.equal(view.getUint16(20, true), 1, 'Uncompressed PCM');
assert.equal(view.getUint16(22, true), 1, 'Mono');
assert.equal(view.getUint16(34, true), 16, '16 bit');
assert.equal(view.getUint32(24, true), 22050);
assert.equal(view.getUint32(40, true), 12 * 22050 * 2);
assert.equal(view.getUint32(4, true) + 8, wav.byteLength);
let peak = 0;
for (let i = 44; i < wav.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
assert(peak > 0 && peak < 10000, 'Audible but quiet tone');
assert.notDeepEqual(new Uint8Array(makeDemoWav(2)), new Uint8Array(wav), 'Different node IDs produce different demos');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const js = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
assert(!/\son\w+=/i.test(html), 'No inline event handlers');
assert(!/<script(?![^>]*\bsrc=)/i.test(html), 'No inline scripts');
assert(!/\sstyle=/i.test(html), 'No inline styles');
assert(!/innerHTML|insertAdjacentHTML/.test(js), 'User strings use textContent');
assert(!/https?:\/\/|data:/i.test(html), 'No internet or data assets');
assert(js.includes("'Content-Type': 'application/x-www-form-urlencoded'"));
assert(js.includes('new URLSearchParams(fields)'));
console.log('PASS: UTF-8 limits, snapshot invariants/empty/reverse, quiet 12s PCM WAV, safe rendering and form encoding.');
