'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = process.env.MUSICLAB_ROOT || path.resolve(__dirname, '..');
const { projectTrace, makeDemoWav } = require(path.join(root, 'web/app.js'));

(async () => {
  const url = process.env.MUSICLAB_URL || 'http://127.0.0.1:18080';
  const output = process.env.MUSICLAB_EVIDENCE || '/tmp/musiclab-simulator-evidence';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let expectedRejection = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(expectedRejection && message.location().url === `${url}/api/action` && message.text().includes('400'))) errors.push(`${message.text()} (${message.location().url})`);
  });
  let checks = 0;
  const ready = () => page.waitForFunction(() => document.getElementById('connection').textContent === 'C state connected');
  async function switchView(view) {
    await page.locator(`#view-${view}`).click();
    await page.waitForFunction(expected=>document.body.dataset.view===expected,view);
  }
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
    assert.equal(await page.locator('body').getAttribute('data-view'), 'demo');
    assert.equal(await page.locator('#pointer-lab').isVisible(), false);
    assert.equal(await page.locator('#guided-demo').isVisible(), false);
    assert.equal(await page.locator('.node-card').count(), 0, 'Demo does not build a hidden visualization');
    // Exercise native decoding and nonzero audio samples, not just a Play label.
    assert.equal(await page.locator('#play-pause').isVisible(), true);
    assert.equal(await page.locator('#play-pause').isDisabled(), false);
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused), true);
    await page.evaluate(()=>{
      window.revokedAudioURLs=[];
      const revoke=URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL=url=>{window.revokedAudioURLs.push(url);revoke(url);};
    });
    const playAudio = async () => {
      await page.locator('#play-pause').click();
      await page.waitForFunction(()=>{const audio=document.getElementById('audio');return !audio.paused&&audio.currentTime>.15&&audio.readyState>=2;});
      assert.equal(await page.locator('#play-pause').getAttribute('aria-pressed'),'true');
    };
    await playAudio();
    assert.match(await page.locator('#audio-status').textContent(), /Generated sample tone/);
    await page.evaluate(async()=>{
      const context=new AudioContext();
      const analyser=context.createAnalyser(); analyser.fftSize=512;
      context.createMediaElementSource(document.getElementById('audio')).connect(analyser);
      analyser.connect(context.destination); await context.resume();
      window.audioProbe={context,analyser};
    });
    const audioEnergy = () => {
      const samples=new Float32Array(window.audioProbe.analyser.fftSize);
      window.audioProbe.analyser.getFloatTimeDomainData(samples);
      return samples.reduce((sum,value)=>sum+value*value,0)/samples.length>0.000001;
    };
    await page.waitForFunction(audioEnergy);
    // Pause is media-only: an accepted C request must not trap playing audio.
    let pendingReverseResolve,releaseReverseResolve;
    const pendingReverseAccepted=new Promise(resolve=>{pendingReverseResolve=resolve;});
    const releaseReverse=new Promise(resolve=>{releaseReverseResolve=resolve;});
    await page.route('**/api/action',async route=>{const response=await route.fetch();pendingReverseResolve();await releaseReverse;await route.fulfill({response});});
    const pendingReverse=operation(page.locator('#reverse-main'),'reverse'); await pendingReverseAccepted;
    const whilePending=await page.locator('#audio').evaluate(audio=>audio.currentTime);
    await page.waitForFunction(time=>document.getElementById('audio').currentTime>time+.08,whilePending);
    assert.equal(await page.locator('#play-pause').isDisabled(),false,'Pending C response cannot disable Pause');
    await page.locator('#play-pause').click();
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true);
    const pausedAudio=await page.locator('#audio').evaluate(audio=>audio.currentTime);
    await page.waitForTimeout(150); // Native playback must remain stopped during the held response.
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.currentTime),pausedAudio);
    assert.equal(await page.locator('#play-pause').isDisabled(),true,'Starting audio stays blocked while C is pending');
    releaseReverseResolve(); await pendingReverse; await page.unroute('**/api/action');
    await playAudio();
    await page.locator('#volume').focus(); await page.locator('#volume').press('Home'); await page.locator('#volume').press('ArrowRight');
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.volume), .05);
    await page.locator('#play-pause').click();
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused), true);
    assert.equal(await page.locator('#play-pause').getAttribute('aria-pressed'),'false');
    await playAudio();
    await page.evaluate(()=>{document.getElementById('audio').currentTime=11.95;});
    await page.waitForFunction(()=>document.getElementById('audio').ended);
    assert.equal(await page.locator('#play-pause').textContent(),'Play');
    await playAudio(); await switchView('simulation');
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true,'Simulation pauses Demo sound');
    assert.equal(await page.locator('#play-pause').isVisible(),false);
    await switchView('demo');
    const localFile = name => ({name,mimeType:'audio/wav',buffer:Buffer.from(makeDemoWav(41))});
    await page.locator('#title').fill('Local A'); await page.locator('#artist').fill('Student');
    await page.locator('#audio-file').setInputFiles(localFile('local-a.wav'));
    let audioData=await operation(page.locator('#add-submit'),'add');
    const localA=audioData.playlists[0].nodes.at(-1).id;
    assert.equal(await page.locator('#audio-file').evaluate(input=>input.files.length),0);
    await operation(page.locator(`#main-tracks .track-select[data-id="${localA}"]`),'select');
    assert.match(await page.locator('#audio-status').textContent(),/Local audio: local-a.wav/);
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true,'Selection changes require explicit Play');
    await playAudio(); await page.waitForFunction(audioEnergy);
    const localAURL=await page.locator('#audio').evaluate(audio=>audio.src);
    await page.locator('#destination').selectOption('secondary');
    await page.locator('#title').fill('Local B'); await page.locator('#artist').fill('Student');
    await page.locator('#audio-file').setInputFiles(localFile('local-b.wav'));
    audioData=await operation(page.locator('#add-submit'),'add');
    const localB=audioData.playlists[1].nodes.at(-1).id;
    await operation(page.locator('#reverse-main'),'reverse');
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.src),localAURL,'Reverse preserves current audio association');
    await operation(page.locator('#merge'),'merge');
    await operation(page.locator(`#main-tracks .track-select[data-id="${localB}"]`),'select');
    assert.match(await page.locator('#audio-status').textContent(),/Local audio: local-b.wav/,'Side B file follows its C ID through merge');
    await playAudio(); await page.waitForFunction(audioEnergy);
    const localBURL=await page.locator('#audio').evaluate(audio=>audio.src);
    await operation(page.locator(`#main-tracks .delete-track[data-id="${localB}"]`),'delete');
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true,'Deleting current stops its audio');
    assert.equal(await page.evaluate(url=>window.revokedAudioURLs.includes(url),localBURL),true,'Deleted local blob released');
    await operation(page.locator('#reset'),'reset');
    assert.equal(await page.evaluate(url=>window.revokedAudioURLs.includes(url),localAURL),true,'Reset releases other local files');
    assert.match(await page.locator('#audio-status').textContent(),/Generated sample tone/);
    await page.locator('#destination').selectOption('main');
    // New edits/files during an accepted add must not be cleared or attached to the wrong C ID.
    await page.locator('#title').fill('Pending audio'); await page.locator('#artist').fill('Student');
    await page.locator('#audio-file').setInputFiles(localFile('accepted.wav'));
    let acceptedAudioResolve,releaseAudioResolve;
    const acceptedAudio=new Promise(resolve=>{acceptedAudioResolve=resolve;});
    const releaseAudio=new Promise(resolve=>{releaseAudioResolve=resolve;});
    await page.route('**/api/action',async route=>{const response=await route.fetch();acceptedAudioResolve();await releaseAudio;await route.fulfill({response});});
    const pendingAudio=operation(page.locator('#add-submit'),'add'); await acceptedAudio;
    await page.locator('#title').fill('New unsent title');
    await page.locator('#audio-file').setInputFiles(localFile('unsent.wav'));
    releaseAudioResolve(); audioData=await pendingAudio; await page.unroute('**/api/action');
    assert.equal(await page.locator('#title').inputValue(),'New unsent title');
    assert.equal(await page.locator('#audio-file').evaluate(input=>input.files[0].name),'unsent.wav');
    const pendingId=audioData.playlists[0].nodes.at(-1).id;
    await operation(page.locator(`#main-tracks .track-select[data-id="${pendingId}"]`),'select');
    assert.match(await page.locator('#audio-status').textContent(),/Local audio: accepted.wav/);
    await page.locator('#audio-file').setInputFiles({name:'unsupported.wav',mimeType:'audio/wav',buffer:Buffer.from('not a playable waveform')});
    await page.locator('#title').fill('Unsupported audio'); await page.locator('#artist').fill('Student');
    audioData=await operation(page.locator('#add-submit'),'add');
    const badId=audioData.playlists[0].nodes.at(-1).id;
    await operation(page.locator(`#main-tracks .track-select[data-id="${badId}"]`),'select');
    await page.waitForFunction(()=>document.getElementById('audio').error!==null);
    assert.match(await page.locator('#audio-status').textContent(),/Cannot decode/);
    assert.equal(await page.locator('#play-pause').isDisabled(),true);
    await operation(page.locator('#reset'),'reset');
    assert.equal(await page.locator('#play-pause').isDisabled(),false,'Reset recovers from unsupported media');
    await page.evaluate(async()=>{await window.audioProbe.context.close();document.getElementById('volume').value='.7';document.getElementById('volume').dispatchEvent(new Event('input'));});
    console.log('PASS: native browser sample/local audio decoding and nonzero output samples, Play/Pause/ended, keyboard volume, Simulation silence, C-ID association through reverse/merge/deletion/reset, blob cleanup, pending file edits and unsupported-file recovery.');
    const demoBefore = await state();
    await operation(page.locator('#next'), 'next', true);
    assert.equal(await page.locator('.node-card:visible').count(), 0, 'Manual Demo operations stay visualization-free');
    assert.equal(await page.locator('#current-title').textContent(), demoBefore.playlists[0].nodes[1].title);
    await page.screenshot({path:path.join(output,'demo-desktop.png'),fullPage:true});
    const demoAfter = await state();
    await switchView('simulation');
    assert.equal(await page.locator('body').getAttribute('data-view'), 'simulation');
    assert.deepEqual((await state()).playlists, demoAfter.playlists, 'Navigation never resets C state');
    assert.equal(await page.locator('#guided-demo').getAttribute('data-status'), 'idle');
    await page.evaluate(()=>{location.hash='#main';});
    await page.waitForFunction(()=>location.hash==='#main');
    assert.equal(await page.locator('body').getAttribute('data-view'), 'simulation', 'Skip anchor preserves simulation');
    await page.evaluate(()=>history.back());
    await page.waitForFunction(()=>location.hash==='#simulation');
    await page.reload(); await ready();
    assert.equal(await page.locator('#pointer-lab').isVisible(), true);
    assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused), true, 'Simulation is silent');
    assert.equal(await page.locator('#audio-file').isVisible(), false);
    assert.equal(await page.locator('#manual-replay-details').getAttribute('open'), null, 'Manual replay starts uncluttered');
    await page.locator('#manual-replay-details > summary').click();
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
    // A completed ghost effect must not survive a rewind onto the same live card.
    await page.locator('#replay-replay').click();
    const freeFrame = data.operation.trace.events.findIndex(event=>event.kind==='free') + 1;
    for (let index=1;index<=freeFrame;index++) await page.locator('#replay-next').click();
    await frameCheck(data, freeFrame);
    const ghostSelector = `.node-card[data-id="${added.id}"]`;
    const animationSettled = selector => [...document.querySelector(selector).getAnimations()].every(animation=>animation.playState!=='running');
    await page.waitForFunction(animationSettled, ghostSelector);
    assert.equal(await page.locator(ghostSelector).evaluate(node=>getComputedStyle(node).opacity), '0.3');
    await page.locator('#replay-previous').click();
    await page.waitForFunction(animationSettled, ghostSelector);
    await frameCheck(data, freeFrame-1);
    assert.equal(await page.locator(ghostSelector).evaluate(node=>getComputedStyle(node).opacity), '1', 'Rewound live node is not a faded ghost');
    assert.equal(await page.locator(ghostSelector).evaluate(node=>node.getAnimations().length), 0, 'No retained filled ghost effect');
    await page.locator('#replay-finish').click();

    data = await operation(page.locator('#reverse-main'), 'reverse', true); await stepAll(data);
    assert.deepEqual(data.playlists[0].nodes.map(node=>node.id), [...original].reverse());
    await settledEdges();
    data = await operation(page.locator('#reverse-main'), 'reverse'); await stepAll(data); await settledEdges();
    // Changing speed during a final reordering must settle both cards and SVG edges.
    await page.locator('#replay-speed').selectOption('1');
    await page.locator('#replay-replay').click();
    await page.locator('#replay-finish').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.node-card')].some(node=>node.getAnimations().some(animation=>animation.playState==='running')));
    await page.locator('#replay-speed').selectOption('2');
    await settledEdges(); await frameCheck(data, data.operation.trace.events.length+1);
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
    assert.equal(await page.locator('#play-pause').isDisabled(),true,'Empty Side A cannot play');
    assert.equal(await page.locator('#audio').getAttribute('src'),null,'Empty Side A detaches audio');
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
    // The entire automatic presentation must use eight actual C requests, not fake state.
    await page.emulateMedia({reducedMotion:'no-preference'});
    await operation(page.locator('#reset'), 'reset'); await final();
    await page.locator('#guided-speed').selectOption('4');
    let captured = null;
    const recordRequest = request => {
      if (captured && request.url() === `${url}/api/action` && request.method()==='POST') captured.fields.push(Object.fromEntries(new URLSearchParams(request.postData())));
    };
    const recordResponse = response => {
      if (captured && response.url() === `${url}/api/action`) captured.responses.push(response.json());
    };
    page.on('request', recordRequest); page.on('response', recordResponse);
    const installGuideProbes = () => page.evaluate(()=>{
      window.guideFrames = {};
      window.guideHighlights = [];
      window.guideGraphVisibility = [];
      new MutationObserver(records=>{
        for (const record of records) {
          const target=record.target;
          if (!target.isConnected || !target.classList.contains('guided-target')) continue;
          const box=target.getBoundingClientRect();
          const pane=target.closest('.operation-desk');
          const bounds=pane?.getBoundingClientRect();
          const list=target.closest('.track-list')?.getBoundingClientRect();
          const top=Math.max(0,bounds?.top||0,list?.top||0);
          const bottom=Math.min(innerHeight,bounds?.bottom||innerHeight,list?.bottom||innerHeight);
          window.guideHighlights.push({action:target.dataset.action||target.id,visible:box.top>=top&&box.bottom<=bottom,top:box.top,bottom:box.bottom,clipTop:top,clipBottom:bottom});
        }
      }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
      new MutationObserver(()=>{
        const step=document.getElementById('guided-progress').value;
        (window.guideFrames[step] ||= []).push(document.getElementById('replay-meter').value);
        const label=document.getElementById('active-assignment').textContent;
        const card=label.startsWith('Side ') ? document.querySelector('.node-card.is-target')||document.querySelector('.node-card.is-source') : document.querySelector('.node-card.is-visited,.node-card.is-allocated,.node-card.is-source,.node-card.is-freed');
        if (card) {
          const box=card.getBoundingClientRect();
          const lab=document.getElementById('pointer-lab').getBoundingClientRect();
          const top=Math.max(0,lab.top,document.querySelector('.replay-inspector').getBoundingClientRect().bottom);
          const bounds=card.closest('.node-scroll').getBoundingClientRect();
          const clipTop=Math.max(top,bounds.top),clipBottom=Math.min(innerHeight,lab.bottom,bounds.bottom);
          window.guideGraphVisibility.push({label,visible:box.top>=clipTop&&box.bottom<=clipBottom,top:box.top,bottom:box.bottom,clipTop,clipBottom});
        }
      }).observe(document.getElementById('replay-meter'), {attributes:true,attributeFilter:['value']});
    });
    await installGuideProbes();
    captured = {fields:[],responses:[]};
    await page.locator('#guided-start').click();
    await page.locator('#guided-start').dispatchEvent('click'); // Programmatic double Start is guarded too.
    await page.waitForFunction(()=>document.getElementById('guided-progress').value===1);
    await page.locator('#guided-pause').click();
    const countWhilePaused=captured.fields.length;
    const pausedFrame=await page.locator('#replay-meter').evaluate(meter=>meter.value);
    assert.equal(await page.locator('#guided-demo').getAttribute('data-status'), 'paused');
    assert.equal(await page.locator('#next').isDisabled(), true);
    assert.equal(await page.locator('#replay-next').isDisabled(), true);
    await page.waitForTimeout(350); // Prove paused work does not dispatch or advance.
    assert.equal(captured.fields.length,countWhilePaused);
    assert.equal(await page.locator('#replay-meter').evaluate(meter=>meter.value),pausedFrame);
    await page.locator('#guided-speed').selectOption('2');
    assert.equal(await page.locator('#guided-demo').getAttribute('data-status'), 'paused');
    await page.screenshot({path:path.join(output,'guided-paused.png'),fullPage:true});
    await page.locator('#guided-speed').selectOption('4');
    await page.locator('#guided-pause').click();
    await page.waitForFunction(()=>document.getElementById('guided-demo').dataset.status==='complete');
    assert.deepEqual(captured.fields.map(fields=>fields.action), ['reset','add','next','previous','select','delete','reverse','merge']);
    const tourStates=await Promise.all(captured.responses);
    const addedId=tourStates[1].playlists[0].nodes.at(-1).id;
    assert.equal(captured.fields[4].id,String(addedId)); assert.equal(captured.fields[5].id,String(addedId));
    const highlights=await page.evaluate(()=>window.guideHighlights);
    assert.deepEqual(highlights.filter(target=>!target.visible),[],`Every automatic control highlight remains visible beside the canvas: ${JSON.stringify(highlights.filter(target=>!target.visible))}`);
    for (const action of ['reset','add-submit','next','previous','select','delete','reverse-main','merge']) assert(highlights.some(target=>target.action===action),`Visible guided control ${action}`);
    const graphVisibility=await page.evaluate(()=>window.guideGraphVisibility);
    assert.deepEqual(graphVisibility.filter(card=>!card.visible),[],`Active C record visible below the inspector: ${JSON.stringify(graphVisibility.filter(card=>!card.visible))}`);
    assert(graphVisibility.some(card=>card.label.startsWith('Side B.')),'Side B cleanup assignments remain visible automatically');
    const frames=await page.evaluate(()=>window.guideFrames);
    for (const [index,snapshot] of tourStates.entries()) {
      require(path.join(root,'web/app.js')).validateState(snapshot);
      for (let f=snapshot.operation.trace.events.length?0:1;f<=snapshot.operation.trace.events.length+1;f++) assert(frames[index].includes(f),`Guided action ${index}: C frame ${f} presented before advancing`);
    }
    assert.equal(await page.locator('#guided-progress').evaluate(meter=>meter.value),8);
    assert.equal(tourStates[7].playlists[0].size,5); assert.equal(tourStates[7].playlists[1].size,0);
    await frameCheck(tourStates[7],tourStates[7].operation.trace.events.length+1); await settledEdges();
    assert.equal(await page.locator('#guided-cursor').isVisible(),false);
    assert.equal(await page.locator('.guided-target').count(),0);
    assert.equal(await page.locator('#next').isDisabled(),false);
    await page.screenshot({path:path.join(output,'guided-complete.png'),fullPage:true});

    // The former clipped-card cases need full real tours, not just idle screenshots.
    for (const [width,height] of [[768,768],[1024,600]]) {
      await page.setViewportSize({width,height}); await page.reload(); await ready();
      await page.locator('#guided-speed').selectOption('4'); await installGuideProbes();
      captured={fields:[],responses:[]};
      await page.locator('#guided-start').click();
      await page.waitForFunction(()=>document.getElementById('guided-demo').dataset.status==='complete');
      assert.deepEqual(captured.fields.map(fields=>fields.action),['reset','add','next','previous','select','delete','reverse','merge']);
      const visibility=await page.evaluate(()=>({cards:window.guideGraphVisibility,controls:window.guideHighlights}));
      assert(visibility.cards.length>=25,`${width}x${height}: actual pointer frames measured`);
      assert.deepEqual(visibility.cards.filter(card=>!card.visible),[],`${width}x${height}: full active C card fits: ${JSON.stringify(visibility.cards.filter(card=>!card.visible))}`);
      assert.deepEqual(visibility.controls.filter(control=>!control.visible),[],`${width}x${height}: automatic controls fit`);
      assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true);
      await page.screenshot({path:path.join(output,`guided-${width}x${height}.png`),fullPage:true});
      console.log(`PASS: guided ${width}x${height} full-card/control visibility (${visibility.cards.length} C frames).`);
    }
    await page.setViewportSize({width:1440,height:1000}); await page.reload(); await ready();
    // Stop/view-exit cannot undo a C POST that was already accepted, but must stop future work.
    let acceptedResolve; let releaseResolve;
    const accepted=new Promise(resolve=>{acceptedResolve=resolve;});
    const release=new Promise(resolve=>{releaseResolve=resolve;});
    await page.route('**/api/action',async route=>{const response=await route.fetch(); acceptedResolve(); await release; await route.fulfill({response});});
    captured={fields:[],responses:[]};
    await page.locator('#guided-start').click(); await accepted;
    await page.locator('#guided-stop').click();
    assert.equal(await page.locator('#guided-demo').getAttribute('data-status'),'stopped');
    assert.equal(await page.locator('#guided-start').isDisabled(),true,'Cannot start a replacement tour while old POST is pending');
    await switchView('demo');
    releaseResolve(); await ready(); await page.unroute('**/api/action');
    await page.waitForTimeout(350);
    assert.equal(captured.fields.length,1); assert.equal((await state()).operation.action,'reset');
    assert.equal(await page.locator('#pointer-lab').isVisible(),false);
    await switchView('simulation');
    captured={fields:[],responses:[]};
    await page.locator('#guided-start').click();
    await page.waitForFunction(()=>document.getElementById('guided-progress').value===1);
    await switchView('demo');
    const exitedCount=captured.fields.length; await page.waitForTimeout(350);
    assert.equal(captured.fields.length,exitedCount);
    assert.equal(await page.locator('#guided-demo').getAttribute('data-status'),'stopped');

    // Reduced motion retains the real sequence and readable explanations, without moving cursors.
    await switchView('simulation'); await page.emulateMedia({reducedMotion:'reduce'});
    captured={fields:[],responses:[]};
    await page.locator('#guided-start').click();
    await page.waitForFunction(()=>document.getElementById('guided-demo').dataset.status==='complete');
    assert.deepEqual(captured.fields.map(fields=>fields.action),['reset','add','next','previous','select','delete','reverse','merge']);
    assert.equal(await page.locator('#guided-cursor').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.getAnimations().length),0);

    // A failed real request stops the tour and requires explicit restart, never automatic retry.
    expectedRejection=true;
    const rejectionBefore=await state();
    await page.route('**/api/action',async route=>{await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,error:'Test rejection: no mutation'})});});
    captured={fields:[],responses:[]};
    await page.locator('#guided-start').click();
    await page.waitForFunction(()=>document.getElementById('guided-demo').dataset.status==='error');
    assert.equal(captured.fields.length,1); assert.equal(await page.locator('#guided-progress').evaluate(meter=>meter.value),0);
    assert.match(await page.locator('#guided-status').textContent(),/Test rejection/);
    await page.unroute('**/api/action'); captured=null;
    assert.deepEqual((await state()).playlists,rejectionBefore.playlists,'Rejected request never changed C state');
    expectedRejection=false;
    page.off('request',recordRequest); page.off('response',recordResponse);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await operation(page.locator('#reset'),'reset'); await final();
    for (const [width,height,name] of [[1440,1000,'desktop'],[768,1024,'tablet'],[390,844,'mobile'],[320,812,'small-mobile']]) {
      await page.setViewportSize({width,height});
      for (const view of ['demo','simulation']) {
        await page.goto(`${url}/#${view}`); await page.reload(); await ready();
        await page.waitForFunction(expected=>document.body.dataset.view===expected,view);
        await page.evaluate(()=>window.scrollTo(0,0));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${view}/${name}: no overflow`);
        await page.screenshot({path:path.join(output,`${view}-${name}.png`),fullPage:true});
      }
    }
    assert.deepEqual(errors,[],`No console/page errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: ${checks} C-backed replay/layout checks; real intermediate assignments, visits, allocation/free ghosts, navigation/reverse/merge; side-by-side geometry; settled SVG edges; playback/pause/step/replay/finish/speed/interruption; stale before snapshot; Unicode, focus, empty states, responsive and reduced motion. URL ${url}`);
    console.log('PASS: default demo/explicit simulation routing, history/deep-link/reload and preserved C state; guided 8-POST sequence and every recorded frame, derived IDs, visible automatic controls, duplicate Start, pause/resume/speed, in-flight Stop, view exit, reduced motion, rejection/no retry, both-view responsive screenshots.');
    console.log(`Screenshots: ${output}`);
  } catch (error) {
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
