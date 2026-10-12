'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const url = process.env.MUSICLAB_URL || 'http://127.0.0.1:18080';
  const output = process.env.MUSICLAB_EVIDENCE || '/tmp/musiclab-browser-evidence';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  let checks = 0;
  const ready = () => page.waitForFunction(() => document.getElementById('connection').textContent === 'C state connected');
  const state = async () => { const response = await fetch(`${url}/api/state`); assert.equal(response.status, 200); return response.json(); };
  async function synchronized(snapshot) {
    await ready();
    const rendered = await page.evaluate(() => ['main', 'secondary'].map(id => ({
      ids: [...document.querySelectorAll(`#${id}-tracks .track-select`)].map(button => Number(button.dataset.id)),
      pointers: [...document.querySelectorAll(`#diagrams .diagram`)[id === 'main' ? 0 : 1].querySelectorAll('.node-card')].map(card => ({
        id: card.querySelector('.node-topline span').textContent,
        links: [...card.querySelectorAll('.node-links span')].map(span => span.textContent)
      }))
    })));
    snapshot.playlists.forEach((list, index) => {
      assert.deepEqual(rendered[index].ids, list.nodes.map(node => node.id));
      assert.deepEqual(rendered[index].pointers, list.nodes.map(node => ({ id: `#${node.id}`, links: [`← prev ${node.prev === null ? 'NULL' : '#' + node.prev}`, `next ${node.next === null ? 'NULL' : '#' + node.next} →`] })));
    });
    assert.equal(await page.locator('#operation-message').textContent(), snapshot.operation.message);
    checks++;
    return snapshot;
  }
  async function operation(control, action, keyboard = false) {
    const response = page.waitForResponse(response => response.url() === `${url}/api/action` && new URLSearchParams(response.request().postData()).get('action') === action);
    if (keyboard) { await control.focus(); await control.press('Enter'); } else await control.click();
    const result = await response;
    assert.equal(result.status(), 200);
    return synchronized(await result.json());
  }
  try {
    await page.goto(url);
    await ready();
    await page.getByRole('button', { name: /Show pointer lab/ }).click();
    let data = await operation(page.locator('#reset'), 'reset');
    await synchronized(await state());
    assert.deepEqual(data.playlists.map(list => list.size), [3, 2]);
    const original = data.playlists[0].nodes.map(node => node.id);
    data = await operation(page.locator('#next'), 'next', true);
    assert.equal(data.playlists[0].current, original[1]);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'next');
    data = await operation(page.locator('#previous'), 'previous', true);
    assert.equal(data.playlists[0].current, original[0]);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'previous');
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0);
    assert.equal(await page.locator('#audio').evaluate(audio => audio.duration), 12);
    const source = await page.locator('#audio').getAttribute('src');
    data = await operation(page.getByRole('button', { name: /Reverse A/ }), 'reverse', true);
    assert.deepEqual(data.playlists[0].nodes.map(node => node.id), [...original].reverse());
    assert.equal(data.playlists[0].current, original[0]);
    assert.equal(await page.locator('#audio').getAttribute('src'), source, 'Reverse must not restart audio');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.playlist), 'main');
    data = await operation(page.getByRole('button', { name: /Reverse A/ }), 'reverse', true);
    await page.locator('#play').click();
    assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true);

    // Local audio is browser-only; verify it follows the C node through selection/deletion.
    const { makeDemoWav } = require(path.join(process.env.MUSICLAB_ROOT || path.resolve(__dirname, '..'), 'web/app.js'));
    await page.getByLabel('Track title').fill('Local "record" <img src=x>');
    await page.getByLabel('Artist', { exact: false }).fill('Student & Artist');
    await page.locator('#local-file').setInputFiles({ name: 'student.wav', mimeType: 'audio/wav', buffer: Buffer.from(makeDemoWav(8)) });
    data = await operation(page.locator('#add-submit'), 'add');
    const added = data.playlists[0].nodes.at(-1);
    assert.equal(added.title, 'Local "record" <img src=x>');
    assert.equal(await page.locator('#main-tracks img').count(), 0, 'Metadata is text, not HTML');
    data = await operation(page.locator(`#main-tracks .track-select[data-id="${added.id}"]`), 'select', true);
    assert.match(await page.locator('#audio-source').textContent(), /Browser-local file/);
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0);
    data = await operation(page.locator(`#main-tracks .delete-track[data-id="${added.id}"]`), 'delete', true);
    assert.equal(data.playlists[0].current, original[2], 'Deleting current tail chooses previous');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), `select-${original[2]}`);
    assert.match(await page.locator('#audio-source').textContent(), /Generated demo tone/);

    // Regression: C accepts Unicode whitespace, and the UI must keep accepting that snapshot.
    await page.getByLabel('Track title').fill(' \u00a0 ');
    await page.getByLabel('Artist', { exact: false }).fill('Artist');
    data = await operation(page.locator('#add-submit'), 'add');
    assert.equal(data.playlists[0].nodes.at(-1).title, '\u00a0');
    await page.getByLabel('Track title').fill('A\u0085B');
    assert.equal(await page.locator('#title').evaluate(input => input.checkValidity()), false);
    await page.getByLabel('Track title').fill('');

    data = await operation(page.getByRole('button', { name: /Reverse B/ }), 'reverse', true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.playlist), 'secondary');
    const beforeMerge = data.playlists.flatMap(list => list.nodes.map(node => node.id));
    data = await operation(page.locator('#merge'), 'merge', true);
    assert.deepEqual(data.playlists[0].nodes.map(node => node.id), beforeMerge);
    assert.equal(data.playlists[1].size, 0);
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY', 'Disabled merge has a sensible focus fallback');
    const refreshResponse = page.waitForResponse(response => response.url() === `${url}/api/state`);
    await page.locator('#refresh').focus();
    await page.locator('#refresh').press('Enter');
    await refreshResponse;
    await ready();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'refresh');
    data = await operation(page.locator('#reset'), 'reset', true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'reset');

    // A user moving focus during a pending operation must not have focus stolen back.
    await page.route('**/api/action', async route => {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ response });
    });
    const pending = operation(page.locator('#next'), 'next', true);
    await page.waitForFunction(() => document.getElementById('next').disabled);
    await page.locator('#lab-toggle').focus();
    await pending;
    assert.equal(await page.evaluate(() => document.activeElement.id), 'lab-toggle');
    await page.unroute('**/api/action');

    // Empty-list cases through actual UI deletes; then transfer into an empty destination.
    for (const id of data.playlists[0].nodes.map(node => node.id)) {
      data = await operation(page.locator(`#main-tracks .delete-track[data-id="${id}"]`), 'delete');
    }
    assert.equal(data.playlists[0].current, null);
    assert.equal(await page.locator('#play').isDisabled(), true);
    assert.equal(await page.locator('#audio').getAttribute('src'), null);
    data = await operation(page.locator('#merge'), 'merge');
    assert.equal(data.playlists[0].size, 2);
    assert.equal(data.playlists[1].current, null);
    data = await operation(page.locator('#reset'), 'reset');
    for (const [width, height, name] of [[1440, 1000, 'desktop'], [768, 1024, 'tablet'], [390, 844, 'mobile'], [320, 812, 'small-mobile']]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow`);
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
      checks++;
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#vinyl').evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.reload();
    await ready();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Skip to the record deck');
    await page.locator('#title').fill('Artist '.repeat(19));
    assert.equal(await page.locator('#title').evaluate(input => input.checkValidity()), true);
    assert.deepEqual(errors, [], `No browser JavaScript/console errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: ${checks} C-backed snapshots/layout checks; add/delete/select/navigation/reverse/merge/reset; real demo/local WAV playback; Unicode validation; keyboard focus and pending-focus preservation; NULL/current links; safe metadata; 1440/768/390/320px; reduced motion. URL ${url}`);
    console.log(`Screenshots: ${output}`);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
