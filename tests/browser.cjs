'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = process.env.MUSICLAB_ROOT || path.resolve(__dirname, '..');
const { projectTrace } = require(path.join(root, 'web/app.js'));

(async () => {
  const url = process.env.MUSICLAB_URL || 'http://127.0.0.1:18080';
  const output = process.env.MUSICLAB_EVIDENCE || '/tmp/musiclab-simulator-evidence';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  let checks = 0;
  const ready = () => page.waitForFunction(() => document.getElementById('connection').textContent === 'C state connected');
  const final = () => page.waitForFunction(() => document.getElementById('replay-status').textContent.startsWith('Committed C state'));
  const state = async () => { const response = await fetch(`${url}/api/state`); assert.equal(response.status, 200); return response.json(); };
  const external = async fields => { const response = await fetch(`${url}/api/action`, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams(fields).toString() }); assert.equal(response.status, 200); return response.json(); };
  async function operation(control, action, keyboard = false) {
    const response = page.waitForResponse(response => response.url() === `${url}/api/action` && new URLSearchParams(response.request().postData()).get('action') === action);
    if (keyboard) { await control.focus(); await control.press('Enter'); } else await control.click();
    const result = await response;
    assert.equal(result.status(), 200);
    const snapshot = await result.json();
    await ready();
    assert.equal(await page.locator('#operation-message').textContent(), snapshot.operation.message);
    for (const list of snapshot.playlists) {
      const order = await page.locator(`#${list.id}-tracks .track-select`).evaluateAll(buttons => buttons.map(button => Number(button.dataset.id)));
      assert.deepEqual(order, list.nodes.map(node => node.id), 'Left collection is always committed C state');
    }
    return snapshot;
  }
  async function frameCheck(snapshot, frame) {
    const p = projectTrace(snapshot, frame);
    const expected = ['main', 'secondary'].map(id => ({
      cards: p.lists.get(id).order.filter(nodeId => p.nodes.has(nodeId) || p.ghost?.id === nodeId).map(nodeId => {
        const node = p.nodes.get(nodeId) || p.ghost;
        return { id: nodeId, prev: `prev ${node.prev === null ? 'NULL' : '#' + node.prev}`, next: `next ${node.next === null ? 'NULL' : '#' + node.next}`, freed: p.ghost?.id === nodeId };
      }),
      marker: p.lists.get(id).current !== null && p.nodes.has(p.lists.get(id).current) ? p.lists.get(id).current : null
    }));
    const actual = await page.evaluate(() => ['main', 'secondary'].map(id => ({
      cards: [...document.querySelectorAll(`.diagram[data-playlist="${id}"] .node-card`)].map(card => ({id:Number(card.dataset.id), prev:card.querySelector('[data-field="prev"]').textContent,next:card.querySelector('[data-field="next"]').textContent,freed:card.classList.contains('is-freed')})),
      marker: (() => {const marker=[...document.querySelectorAll('.current-marker')].find(node => node.textContent.startsWith(id==='main'?'A':'B')); return marker ? Number(marker.parentElement.dataset.id) : null;})()
    })));
    assert.deepEqual(actual, expected, `Actual C-recorded frame ${frame}`);
    assert.equal(await page.locator('#replay-meter').evaluate(meter => meter.value), frame);
    checks++;
  }
  async function stepAll(snapshot) {
    for (let frame = 1; frame <= snapshot.operation.trace.events.length + 1; frame++) {
      await page.locator('#replay-next').click();
      await frameCheck(snapshot, frame);
    }
    await final();
  }
  async function settledEdges() {
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const mismatches = await page.evaluate(() => {
      const canvas = document.querySelector('.pointer-canvas').getBoundingClientRect();
      return [...document.querySelectorAll('.pointer-edge:not(.edge-old)[data-target]:not([data-target="null"])')].filter(edge => {
        const target = document.querySelector(`.node-card[data-id="${edge.dataset.target}"]`);
        if (!target) return true;
        const box = target.getBoundingClientRect();
        const point = edge.getPointAtLength(edge.getTotalLength());
        const backward = edge.dataset.field === 'prev';
        const endpoint = !/^\d+$/.test(edge.dataset.source);
        const x = box.left-canvas.left+box.width*(backward?.7:.3);
        const y = box.top-canvas.top+(endpoint||backward?0:box.height);
        return Math.abs(point.x-x)>2 || Math.abs(point.y-y)>2;
      }).map(edge=>({source:edge.dataset.source,target:edge.dataset.target,field:edge.dataset.field}));
    });
    assert.deepEqual(mismatches, [], 'Settled arrows must end at settled cards after FLIP');
    checks++;
  }
  try {
    await page.goto(url); await ready();
    assert.equal(await page.locator('#pointer-lab').isVisible(), true);
    assert.equal(await page.locator('audio, input[type="file"]').count(), 0, 'Silent simulation, no music files required');
    const desk = await page.locator('.operation-desk').boundingBox();
    const lab = await page.locator('#pointer-lab').boundingBox();
    assert(desk.x + desk.width < lab.x && Math.abs(desk.y-lab.y)<2, 'Controls left, pointer canvas right in same viewport');
    await page.locator('#replay-auto').uncheck();
    let data = await operation(page.locator('#reset'), 'reset'); await final();
    await frameCheck(data, 1);
    const original = data.playlists[0].nodes.map(node=>node.id);
    data = await operation(page.locator('#next'), 'next', true);
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'next');
    await frameCheck(data, 0);
    assert.equal(data.operation.trace.events.length, 1);
    await stepAll(data);
    data = await operation(page.locator('#previous'), 'previous', true);
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'previous');
    await stepAll(data);
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'replay-replay', 'Finishing manual steps keeps keyboard focus usable');

    await page.getByLabel('Track title').fill('Record "D" <img src=x>');
    await page.getByRole('textbox', {name:/^Artist/}).fill('Sample artist');
    data = await operation(page.locator('#add-submit'), 'add'); await frameCheck(data, 0);
    const added = data.playlists[0].nodes.at(-1);
    assert.equal(await page.locator('#main-tracks img').count(), 0);
    assert.equal(await page.locator(`.node-card[data-id="${added.id}"]`).count(), 0, 'Allocation is not displayed before its recorded event');
    await stepAll(data);
    data = await operation(page.locator(`#main-tracks .track-select[data-id="${added.id}"]`), 'select', true);
    assert.deepEqual(data.operation.trace.events.filter(e=>e.kind==='visit').map(e=>e.id), [...original, added.id]);
    await stepAll(data);
    assert.match(await page.locator('#replay-counts').textContent(), /Visits \/ comparisons: 4/);
    data = await operation(page.locator(`#main-tracks .delete-track[data-id="${added.id}"]`), 'delete', true);
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.focusKey), `select-${original.at(-1)}`);
    await stepAll(data);
    assert.equal(data.playlists[0].current, original.at(-1));

    data = await operation(page.locator('#reverse-main'), 'reverse', true); await stepAll(data);
    assert.deepEqual(data.playlists[0].nodes.map(node=>node.id), [...original].reverse());
    await settledEdges();
    data = await operation(page.locator('#reverse-main'), 'reverse'); await stepAll(data); await settledEdges();
    const beforeMerge = data.playlists.flatMap(list=>list.nodes.map(node=>node.id));
    data = await operation(page.locator('#merge'), 'merge', true); await stepAll(data);
    assert.deepEqual(data.playlists[0].nodes.map(node=>node.id), beforeMerge);
    assert.notEqual(await page.evaluate(()=>document.activeElement.tagName), 'BODY');
    await settledEdges();
    data = await operation(page.locator('#reset'), 'reset');

    // Play/pause, repeat, speed, finish, and a new operation interrupting historical playback.
    await page.locator('#replay-auto').check();
    await page.locator('#replay-speed').selectOption('0.5');
    data = await operation(page.locator('#reverse-main'), 'reverse');
    await page.locator('#replay-pause').click();
    const stopped = await page.locator('#replay-meter').evaluate(meter=>meter.value);
    await page.waitForTimeout(250); // Intentional sample: a paused educational timeline must not advance.
    assert.equal(await page.locator('#replay-meter').evaluate(meter=>meter.value), stopped);
    await page.locator('#replay-replay').click();
    await page.locator('#replay-speed').selectOption('4');
    await final(); await frameCheck(data, data.operation.trace.events.length+1); await settledEdges();
    await page.locator('#replay-replay').click();
    data = await operation(page.locator('#next'), 'next');
    await final(); await frameCheck(data, data.operation.trace.events.length+1);
    await page.locator('#replay-auto').uncheck();
    data = await operation(page.locator('#reverse-main'), 'reverse');
    await page.locator('#replay-finish').click(); await final();
    await frameCheck(data, data.operation.trace.events.length+1); await settledEdges();
    await page.locator('#replay-previous').click(); await frameCheck(data, data.operation.trace.events.length);
    await page.locator('#replay-finish').click();

    // Cross-layer Unicode policy and a stale browser snapshot replaced with C's before snapshot.
    await page.getByLabel('Track title').fill(' \u00a0 '); await page.getByRole('textbox', {name:/^Artist/}).fill('Artist');
    data = await operation(page.locator('#add-submit'), 'add'); assert.equal(data.playlists[0].nodes.at(-1).title, '\u00a0');
    await page.getByLabel('Track title').fill('A\u0085B'); assert.equal(await page.locator('#title').evaluate(input=>input.checkValidity()), false);
    await external({action:'add',playlist:'secondary',title:'Other tab',artist:'Sample'});
    data = await operation(page.locator('#next'), 'next'); await frameCheck(data, 0);
    assert(data.operation.trace.before[1].nodes.some(node=>node.title==='Other tab'));
    await page.locator('#replay-finish').click();

    await page.route('**/api/action', async route=>{const response=await route.fetch(); await new Promise(resolve=>setTimeout(resolve,150)); await route.fulfill({response});});
    const pending = operation(page.locator('#previous'), 'previous', true);
    await page.waitForFunction(()=>document.getElementById('previous').disabled); await page.locator('#replay-auto').focus(); await pending;
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'replay-auto');
    await page.getByLabel('Track title').fill('Pending focus'); await page.getByRole('textbox', {name:/^Artist/}).fill('Student');
    const pendingAdd = operation(page.locator('#add-submit'), 'add', true);
    await page.waitForFunction(()=>document.getElementById('add-submit').disabled); await page.locator('#replay-auto').focus(); data=await pendingAdd;
    assert.equal(await page.evaluate(()=>document.activeElement.id), 'replay-auto'); await page.unroute('**/api/action');
    for (const id of data.playlists[0].nodes.map(node=>node.id)) { data=await operation(page.locator(`#main-tracks .delete-track[data-id="${id}"]`),'delete'); await page.locator('#replay-finish').click(); }
    assert.equal(data.playlists[0].current,null); assert.equal(await page.locator('#next').isDisabled(),true);
    data=await operation(page.locator('#merge'),'merge'); await stepAll(data);
    data=await operation(page.locator('#reset'),'reset'); await final();
    for (const [width,height,name] of [[1440,1000,'desktop'],[768,1024,'tablet'],[390,844,'mobile'],[320,812,'small-mobile']]) {
      await page.setViewportSize({width,height});
      await page.evaluate(()=>window.scrollTo(0,0));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${name}: page overflow`);
      await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true}); checks++;
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.emulateMedia({reducedMotion:'reduce'});
    data=await operation(page.locator('#reverse-main'),'reverse'); await final(); await frameCheck(data,data.operation.trace.events.length+1);
    assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
    await page.locator('#replay-previous').click(); await frameCheck(data,data.operation.trace.events.length);
    await page.locator('#replay-finish').click();
    await page.reload(); await ready(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Skip to the operation desk');
    assert.deepEqual(errors,[],`No console/page errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: ${checks} C-backed replay/layout checks; real intermediate assignments, visits, allocation/free ghosts, navigation/reverse/merge; side-by-side geometry; settled SVG edges; playback/pause/step/replay/finish/speed/interruption; stale before snapshot; Unicode, focus, empty states, responsive and reduced motion. URL ${url}`);
    console.log(`Screenshots: ${output}`);
  } catch (error) {
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
