'use strict';
// Run: node web/check.cjs. All snapshots/events below are UNIT fixtures, never runtime C substitutes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { trimSongText, textProblem, pointer, validateState, projectTrace, eventLabel, shouldAutoPlay, routeView, addedTrackId, createGuidedController, TRACE_LIMIT } = require('./app.js');

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
assert.notEqual(textProblem('bad\ud800'), '');
assert.notEqual(textProblem('\udfff'), '');
assert.equal(textProblem('<img src=x onerror=alert(1)> & "record"'), '');
assert.equal(trimSongText('  A record  '), 'A record');
for (const whitespace of ['\u00a0', '\u2003', '\ufeff', '\u2028', '\u2029']) {
  assert.equal(trimSongText(` ${whitespace} `), whitespace, 'Only ASCII spaces are trimmed');
  assert.equal(textProblem(whitespace), '', 'Match metadata accepted by C');
}
for (let cp = 0x7f; cp <= 0x9f; cp++) assert.notEqual(textProblem(`A${String.fromCodePoint(cp)}B`), '', 'Reject C1 controls like C');
assert.equal(pointer(null), 'NULL');
assert.equal(pointer(9), '#9');

function list(id, ids, current = ids[0] ?? null) {
  return { id, name: id === 'main' ? 'My playlist' : 'Side B', head: ids[0] ?? null, tail: ids.at(-1) ?? null, current, size: ids.length,
    nodes: ids.map((nodeId, i) => ({ id: nodeId, title: `Track ${nodeId}`, artist: 'Sample metadata', prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null })) };
}
const base = [list('main', [1, 2, 3]), list('secondary', [4, 5])];
const write = (id, field, from, to, playlist = 'main') => ({ kind: 'pointer', playlist, id, field, from, to });
const visit = id => ({ kind: 'visit', playlist: 'main', id });
function fixture(action, before = base, after = base, events = [], truncated = false) {
  return { ok: true, playlists: structuredClone(after), operation: { action, message: 'Unit fixture only', complexity: 'O(n)', steps: ['Recorded explanation'], changed: [], trace: { before: structuredClone(before), events: structuredClone(events), truncated } } };
}
const snapshot = fixture('reset');
const original = JSON.stringify(snapshot);
assert.equal(validateState(snapshot), snapshot);
assert.equal(JSON.stringify(snapshot), original, 'Validation never mutates source snapshots');
for (const text of ['\u00a0', '\u2003', '\ufeff', '\u2028', '\u2029', 'A\u00a0B', '<img src=x onerror=alert(1)>']) {
  const unicode = structuredClone(snapshot);
  unicode.playlists[0].nodes[0].title = text;
  unicode.operation.trace.before[0].nodes[0].title = text;
  assert.equal(validateState(unicode), unicode);
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
  s => { s.playlists[0].nodes[0].title = 'é'.repeat(64); },
  s => { s.playlists[0].nodes[0].id = 0x100000000; },
  s => { delete s.operation.trace; },
  s => { s.operation.trace.truncated = 'false'; },
  s => { s.operation.trace.before[0].nodes[0].next = null; },
  s => { s.operation.trace.before.pop(); },
  s => { s.operation.trace.events = Array(TRACE_LIMIT + 1).fill(visit(1)); },
  s => { s.operation.message = 'x'.repeat(512 * 1024); }
]) {
  const broken = JSON.parse(original);
  damage(broken);
  assert.throws(() => validateState(broken), /invalid state/);
}
assert.throws(() => validateState(null), /invalid state/);
assert.throws(() => validateState({ ok: false, error: 'Not a snapshot' }), /invalid state/);
const empty = fixture('reset', [list('main', []), list('secondary', [])], [list('main', []), list('secondary', [])]);
assert.equal(validateState(empty), empty);

const addEvents = [
  { kind: 'allocate', playlist: 'main', id: 6, title: 'Track 6', artist: 'Sample metadata', prev: null, next: null },
  write(6, 'prev', null, 3), write(3, 'next', null, 6), write(null, 'tail', 3, 6)
];
const add = fixture('add', base, [list('main', [1, 2, 3, 6]), base[1]], addEvents);
assert.equal(validateState(add), add);
assert(!projectTrace(add, 0).nodes.has(6), 'Frame zero uses C before, never browser last state');
assert.equal(projectTrace(add, 1).nodes.get(6).prev, null, 'Allocation appears before linking');
assert.equal(projectTrace(add, 2).nodes.get(6).prev, 3);
assert.equal(projectTrace(add, 2).nodes.get(3).next, null, 'Intermediate assignments are not coerced into a valid list');
assert.equal(projectTrace(add, 3).nodes.get(3).next, 6);
assert.equal(projectTrace(add, 3).lists.get('main').tail, 3, 'Tail not moved before its actual write');
assert.equal(projectTrace(add, 4).lists.get('main').tail, 6);
assert.equal(projectTrace(add, 5).final, true);
assert.equal(projectTrace(add, 5).lists.get('main').size, 4);
assert.equal(projectTrace(add, 5).writes, 3);
assert.throws(() => projectTrace(add, -1), RangeError);
assert.throws(() => projectTrace(add, 6), RangeError);

const remove = fixture('delete', base, [list('main', [1, 3]), base[1]], [visit(1), visit(2), write(1, 'next', 2, 3), write(3, 'prev', 2, 1), { kind: 'free', playlist: 'main', id: 2 }]);
validateState(remove);
assert.equal(projectTrace(remove, 1).event.id, 1);
assert.equal(projectTrace(remove, 2).event.id, 2);
assert.equal(projectTrace(remove, 2).visits, 2);
assert.equal(projectTrace(remove, 3).nodes.get(3).prev, 2);
assert.equal(projectTrace(remove, 5).ghost.id, 2);
assert(!projectTrace(remove, 5).nodes.has(2));
assert.equal(projectTrace(remove, 6).ghost, null);
const navigation = fixture('next', base, [list('main', [1, 2, 3], 2), base[1]], [write(null, 'current', 1, 2)]);
validateState(navigation);
assert.equal(projectTrace(navigation, 0).lists.get('main').current, 1);
assert.equal(projectTrace(navigation, 1).lists.get('main').current, 2);
const emptyLists = [list('main', []), list('secondary', [])];
const firstAdd = fixture('add', emptyLists, [list('main', [6]), emptyLists[1]], [addEvents[0], write(6, 'prev', null, null), write(null, 'head', null, 6), write(null, 'tail', null, 6), write(null, 'current', null, 6)]);
validateState(firstAdd);
assert.equal(projectTrace(firstAdd, 4).lists.get('main').current, null, 'No-op assignments and delayed current are faithfully recorded');
assert.equal(projectTrace(firstAdd, 5).lists.get('main').current, 6);
const singleton = [list('main', [1]), emptyLists[1]];
const lastDelete = fixture('delete', singleton, emptyLists, [visit(1), write(null, 'current', 1, null), write(null, 'head', 1, null), write(null, 'tail', 1, null), { kind: 'free', playlist: 'main', id: 1 }]);
validateState(lastDelete);
assert.equal(projectTrace(lastDelete, 2).lists.get('main').head, 1);
assert.equal(projectTrace(lastDelete, 6).nodes.size, 0);

const reverseEvents = [write(1, 'next', 2, null), write(1, 'prev', null, 2), write(2, 'next', 3, 1), write(2, 'prev', 1, 3), write(3, 'next', null, 2), write(3, 'prev', 2, null), write(null, 'head', 1, 3), write(null, 'tail', 3, 1)];
const reverse = fixture('reverse', base, [list('main', [3, 2, 1], 1), base[1]], reverseEvents);
validateState(reverse);
assert.deepEqual(projectTrace(reverse, 6).lists.get('main').order, [1, 2, 3], 'Do not implement a JS reverse algorithm');
assert.equal(projectTrace(reverse, 2).nodes.get(1).prev, 2);
assert.equal(projectTrace(reverse, 2).nodes.get(2).prev, 1, 'Intermediate cycle is valid recorded history');
assert.deepEqual(projectTrace(reverse, 9).lists.get('main').order, [3, 2, 1]);
assert.equal(projectTrace(reverse, 9).lists.get('main').current, 1);
const mergeEvents = [write(3, 'next', null, 4), write(4, 'prev', null, 3, 'secondary'), write(null, 'tail', 3, 5), write(null, 'head', 4, null, 'secondary'), write(null, 'tail', 5, null, 'secondary'), write(null, 'current', 4, null, 'secondary')];
const merge = fixture('merge', base, [list('main', [1, 2, 3, 4, 5]), list('secondary', [])], mergeEvents);
validateState(merge);
assert.equal(projectTrace(merge, 1).nodes.get(3).next, 4, 'Cross-list link is displayed immediately');
assert.equal(projectTrace(merge, 1).nodes.get(4).prev, null);
assert.deepEqual(projectTrace(merge, 6).lists.get('secondary').order, [4, 5], 'Records remain independent of potentially invalid traversal');
assert.deepEqual(projectTrace(merge, 7).lists.get('main').order, [1, 2, 3, 4, 5]);
assert.deepEqual(projectTrace(merge, 7).lists.get('secondary').order, []);
for (const sample of [add, remove, navigation, reverse, merge]) {
  const saved = JSON.stringify(sample);
  for (let frame = 0; frame <= sample.operation.trace.events.length + 1; frame++) projectTrace(sample, frame);
  assert.equal(JSON.stringify(sample), saved, 'Projection does not mutate C records');
}
for (const events of [
  [{ kind: 'visit', playlist: 'wrong', id: 1 }],
  [{ kind: 'unknown', playlist: 'main', id: 1 }],
  [visit(99)],
  [{ kind: 'free', playlist: 'main', id: 99 }],
  [write(1, 'next', 99, 3)],
  [write(1, 'next', 2, 99)],
  [write(99, 'prev', null, 1)],
  [write(1, 'head', 1, 2)],
  [write(null, 'prev', null, 1)],
  [write(1, 'next', 2, 3), write(1, 'next', 2, 3)],
  [write(1, 'next', 2, 3)], // final parity is missing
  [{ ...addEvents[0], id: 1 }],
  [{ ...addEvents[0], title: '\ud800' }],
  [{ ...addEvents[0], prev: 99 }],
  [{ kind: 'free', playlist: 'main', id: 1 }, visit(1)],
  [{ kind: 'free', playlist: 'main', id: 1 }, write(2, 'prev', 1, 1)]
]) assert.throws(() => validateState(fixture('broken', base, base, events)), /invalid state/);
assert.throws(() => validateState(fixture('reset', base, [list('main', [6]), list('secondary', [])])), /invalid state/, 'Reset may replace state only with an honest before=after empty trace');
const truncated = fixture('reverse', base, reverse.playlists, reverseEvents.slice(0, 1), true);
validateState(truncated);
assert.equal(projectTrace(truncated, 1).nodes.get(1).next, null);
assert.deepEqual(projectTrace(truncated, 2).lists.get('main').order, [3, 2, 1], 'Missing events never fabricated; final C snapshot wins');
const full = [list('main', Array.from({ length: 200 }, (_, i) => i + 1)), list('secondary', [])];
validateState(fixture('reset', full, full));
const longTrace = fixture('select', full, full, Array.from({ length: 650 }, (_, i) => visit(i % 200 + 1)));
validateState(longTrace);
assert.equal(projectTrace(longTrace, 650).visits, 650, 'Long recorded traces remain manually inspectable');
assert.equal(projectTrace(longTrace, 651).visits, 650);
assert.throws(() => validateState(fixture('reset', [full[0], list('secondary', [201])], [full[0], list('secondary', [201])])), /invalid state/);
assert.equal(shouldAutoPlay(1, false, true), true);
assert.equal(shouldAutoPlay(80, false, true), true);
assert.equal(shouldAutoPlay(81, false, true), false);
assert.equal(shouldAutoPlay(650, false, true), false);
assert.equal(shouldAutoPlay(1, true, true), false);
assert.equal(shouldAutoPlay(1, false, false), false);
assert.equal(shouldAutoPlay(0, false, true), false);
assert.equal(eventLabel(write(6, 'prev', null, 3)), '#6.prev: NULL → #3');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const js = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const css = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
assert(!/\son\w+=/i.test(html), 'No inline event handlers');
assert(!/<script(?![^>]*\bsrc=)/i.test(html), 'No inline scripts');
assert(!/\sstyle=/i.test(html), 'No inline styles');
assert(!/innerHTML|insertAdjacentHTML/.test(js), 'User strings use textContent');
assert(!/https?:\/\/|data:/i.test(html), 'No remote or data assets');
assert(!/<audio|type="file"|id="volume"|id="seek"|lab-toggle/.test(html), 'No audio/file controls or mandatory lab toggle');
assert(!/makeDemoWav|localSource|localAudio|createObjectURL/.test(js), 'Audio implementation removed');
assert(js.includes("'Content-Type': 'application/x-www-form-urlencoded'"));
assert(js.includes('new URLSearchParams(fields)'));
assert(js.includes('getTotalLength()') && js.includes('strokeDashoffset'), 'Pointer assignments visibly redraw arrows');
assert(js.includes('node.animate(') && js.includes('old.x - now.x'), 'Native FLIP geometry, no runtime dependency');
assert(css.includes('grid-template-columns:330px minmax(0,1fr)') && css.includes('position:sticky'), 'Compact desktop desk and sticky canvas');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'DOM IDs unique');
for (const id of ['next', 'previous', 'reset', 'refresh', 'add-submit', 'title', 'artist', 'destination', 'main-tracks', 'secondary-tracks', 'diagrams', 'operation-message', 'replay-auto', 'replay-pause', 'replay-previous', 'replay-next', 'replay-replay', 'replay-finish', 'replay-speed']) assert(ids.includes(id), `Accessible control ${id} exists`);
const guidedIds = ['view-demo', 'view-simulation', 'guided-demo', 'guided-start', 'guided-pause', 'guided-stop', 'guided-speed', 'guided-status', 'guided-progress', 'guided-reset-note', 'guided-cursor'];
const missing = guidedIds.filter(id => !ids.includes(id));
if (missing.length === guidedIds.length) console.log(`SKIP: guided DOM integration absent in controller worktree (${missing.join(', ')}). Manager must verify integrated HTML/CSS and browser behavior.`);
else {
  assert.deepEqual(missing, [], 'Integrated frontend must provide the full guided DOM contract');
  assert(/<body[^>]*data-view="demo"/.test(html), 'Default HTML view is demo');
  for (const id of ['pointer-lab', 'guided-demo', 'guided-cursor']) {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert(tag && /\bhidden\b/.test(tag), `${id} starts hidden`);
  }
}

assert.equal(routeView('', 'simulation'), 'demo');
assert.equal(routeView('#simulation'), 'simulation');
assert.equal(routeView('#demo', 'simulation'), 'demo');
assert.equal(routeView('#main', 'simulation'), 'simulation', 'Skip link preserves established simulation');
assert.equal(routeView('#unknown', 'demo'), 'demo');
assert.equal(routeView('#unknown', 'simulation'), 'simulation');
assert.equal(addedTrackId(add), 6);
const freshId = fixture('add', base, [list('main', [1, 2, 3, 9001]), base[1]]);
assert.equal(addedTrackId(freshId), 9001, 'Added ID comes from C snapshots, not a constant or changed advisory');
assert.throws(() => addedTrackId(snapshot), /exactly one/);
assert.throws(() => addedTrackId(fixture('add', base, [list('main', [1, 2, 3, 6, 7]), base[1]])), /exactly one/);

// Exercise the real controller with explicit UNIT responses and controllable acceptance/replay gates.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(test) {
  for (let i = 0; i < 200; i++) { if (test()) return; await delay(2); }
  assert.fail('Controller did not reach the expected checkpoint');
}
function harness(overrides = {}) {
  const updates = [];
  const calls = [];
  const h = { updates, calls, latest: () => updates.at(-1) };
  h.controller = createGuidedController({
    canStart: () => true,
    prepare: async () => {},
    request: async fields => { calls.push(fields); return fields.action === 'add' ? add : snapshot; },
    replay: async () => {},
    update: value => updates.push(value),
    ...overrides
  });
  return h;
}
async function controllerChecks() {
  const replayGates = [];
  const h = harness({ replay: async () => { const gate = deferred(); replayGates.push(gate); await gate.promise; } });
  const done = h.controller.start();
  assert.equal(await h.controller.start(), false, 'Double Start is rejected');
  for (let i = 0; i < 8; i++) {
    await until(() => replayGates.length === i + 1);
    assert.equal(h.calls.length, i + 1);
    assert.equal(h.latest().completed, i, 'Progress requires accepted response AND completed replay');
    await delay(5);
    assert.equal(h.calls.length, i + 1, 'No next POST while replay remains incomplete');
    replayGates[i].resolve();
  }
  assert.equal(await done, true);
  assert.deepEqual(h.calls, [
    { action: 'reset' }, { action: 'add', playlist: 'main', title: 'Guided Groove', artist: 'Sample session' },
    { action: 'next', playlist: 'main' }, { action: 'previous', playlist: 'main' },
    { action: 'select', playlist: 'main', id: '6' }, { action: 'delete', playlist: 'main', id: '6' },
    { action: 'reverse', playlist: 'main' }, { action: 'merge', playlist: 'main', source: 'secondary' }
  ]);
  assert.equal(h.latest().status, 'complete');
  assert.equal(h.latest().completed, 8);

  const denied = harness({ canStart: () => false });
  assert.equal(await denied.controller.start(), false);
  assert.equal(denied.calls.length, 0, 'Pending/disconnected/hidden start policy cannot dispatch');

  const responseGate = deferred();
  let requests = 0;
  let replays = 0;
  const paused = harness({
    request: async fields => { requests++; return fields.action === 'add' ? add : responseGate.promise; },
    replay: async (result, { wait }) => { replays++; await wait(20); }
  });
  const pausedDone = paused.controller.start();
  await until(() => requests === 1);
  paused.controller.pause();
  responseGate.resolve(snapshot);
  await delay(25);
  assert.equal(replays, 0, 'Paused in-flight acceptance must hold replay');
  assert.equal(requests, 1);
  paused.controller.pause();
  await until(() => replays === 1);
  paused.controller.pause();
  await delay(35);
  assert.equal(requests, 1, 'Pause holds current replay wait as well as future requests');
  paused.controller.setSpeed(4);
  assert.equal(paused.latest().status, 'paused', 'Speed does not resume paused work');
  paused.controller.pause();
  await until(() => requests === 2);
  paused.controller.stop();
  assert.equal(await pausedDone, false);
  assert.equal(paused.latest().status, 'stopped');

  const inFlight = deferred();
  let accepted = 0;
  let replayed = 0;
  const stopped = harness({
    request: async fields => { stopped.calls.push(fields); const value = await inFlight.promise; accepted++; return value; },
    replay: async () => { replayed++; }
  });
  const stoppedDone = stopped.controller.start();
  await until(() => stopped.calls.length === 1);
  stopped.controller.stop();
  inFlight.resolve(snapshot);
  assert.equal(await stoppedDone, false);
  assert.equal(accepted, 1, 'Stop never claims to undo an already sent C request');
  assert.equal(replayed, 0);
  assert.equal(stopped.calls.length, 1);
  assert.equal(stopped.latest().status, 'stopped');
  assert.match(stopped.latest().message, /in-flight/);

  for (const request of [async () => false, async () => { throw new Error('Disconnected'); }]) {
    const failed = harness({ request: async fields => { failed.calls.push(fields); return request(); } });
    assert.equal(await failed.controller.start(), false);
    assert.equal(failed.latest().status, 'error');
    assert.equal(failed.latest().completed, 0);
    assert.equal(failed.calls.length, 1, 'Failure halts without retry or duplicate mutation');
  }
  const badAdd = harness({ request: async fields => { badAdd.calls.push(fields); return snapshot; } });
  assert.equal(await badAdd.controller.start(), false);
  assert.equal(badAdd.latest().status, 'error');
  assert.equal(badAdd.calls.length, 2, 'Ambiguous added ID halts before select/delete');

  let prepared = false;
  const held = harness({ prepare: async (fields, { wait }) => { prepared = true; await wait(40); } });
  const heldDone = held.controller.start();
  await until(() => prepared);
  held.controller.pause();
  await delay(50);
  assert.equal(held.calls.length, 0, 'Pause during field presentation cannot POST');
  held.controller.stop('Stopped on view exit.');
  assert.equal(await heldDone, false);
  assert.equal(held.calls.length, 0, 'View/lifecycle stop cancels scheduled work');
  held.controller.setSpeed(4);
  const restarted = held.controller.start();
  await until(() => held.calls.length === 1);
  assert.equal(held.calls[0].action, 'reset', 'Explicit restart always resets via C');
  held.controller.stop();
  assert.equal(await restarted, false);

  let speedWait = false;
  const sped = harness({ prepare: async (fields, { wait }) => { speedWait = true; await wait(600); } });
  const spedDone = sped.controller.start();
  await until(() => speedWait);
  sped.controller.setSpeed(4);
  const spedDispatched = await Promise.race([until(() => sped.calls.length === 1).then(() => true), delay(250).then(() => false)]);
  sped.controller.stop();
  assert.equal(await spedDone, false);
  assert.equal(spedDispatched, true, 'Changing speed reschedules the current wait, not only future work');

  let readableWait = false;
  const readable = harness({ prepare: async (fields, { wait }) => { readableWait = true; await wait(80, false); } });
  readable.controller.setSpeed(4);
  const readableDone = readable.controller.start();
  await until(() => readableWait);
  await delay(35);
  assert.equal(readable.calls.length, 0, 'Reduced-motion explanation dwell is readable even at 4x');
  readable.controller.stop();
  assert.equal(await readableDone, false);

  console.log('PASS: guided controller sequence, response/replay gates, derived IDs, duplicate-start, pause/resume/speed, cancellation with honest in-flight acceptance, explicit reset restart, failure/no-retry, readable reduced-motion dwell and hash routing. Unit fixtures only; integrated C/browser checks remain manager-owned.');
}
controllerChecks().catch(error => { console.error(error); process.exitCode = 1; });
console.log('PASS: exact UTF-8 policy, snapshot/trace bounds, chronological allocation/visit/write/free projection, cyclic intermediate reverse, cross-list merge, before/after parity, truncation, large/reduced-motion autoplay policy, safe rendering, silent controls and form encoding. Unit fixtures only.');
