'use strict';

const utf8 = new TextEncoder();

// Match C's metadata policy exactly: trim ASCII spaces, not Unicode whitespace.
function trimSongText(value) {
  return value.replace(/^ +| +$/g, '');
}

function textProblem(value) {
  const text = trimSongText(value);
  if (!text) return 'Enter a non-empty value.';
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) return 'Control characters are not allowed.';
  if (utf8.encode(text).length > 127) return 'Use at most 127 UTF-8 bytes (some characters use more than one byte).';
  return '';
}

function pointer(value) {
  return value === null ? 'NULL' : `#${value}`;
}

// Read and validate C's snapshot; never create, reorder, or unlink playlist nodes here.
function validateState(value) {
  const positiveId = id => Number.isSafeInteger(id) && id > 0;
  const link = id => id === null || positiveId(id);
  const fail = () => { throw new Error('The C API returned an invalid state. Refresh after checking the server.'); };
  if (!value || value.ok !== true || !Array.isArray(value.playlists) || value.playlists.length !== 2) fail();
  const allIds = new Set();
  for (const listId of ['main', 'secondary']) {
    const list = value.playlists.find(item => item && item.id === listId);
    if (!list || typeof list.name !== 'string' || !Array.isArray(list.nodes) ||
        !Number.isInteger(list.size) || list.size !== list.nodes.length || list.size < 0 ||
        ![list.head, list.tail, list.current].every(link)) fail();
    for (const [index, node] of list.nodes.entries()) {
      if (!node || !positiveId(node.id) || allIds.has(node.id) ||
          typeof node.title !== 'string' || typeof node.artist !== 'string' ||
          textProblem(node.title) || textProblem(node.artist) ||
          node.prev !== (list.nodes[index - 1]?.id ?? null) ||
          node.next !== (list.nodes[index + 1]?.id ?? null)) fail();
      allIds.add(node.id);
    }
    if (list.head !== (list.nodes[0]?.id ?? null) || list.tail !== (list.nodes.at(-1)?.id ?? null) ||
        (list.size === 0 ? list.current !== null : !list.nodes.some(node => node.id === list.current))) fail();
  }
  const op = value.operation;
  if (allIds.size > 200 || !op || !['action', 'message', 'complexity'].every(key => typeof op[key] === 'string') ||
      !Array.isArray(op.steps) || !op.steps.every(step => typeof step === 'string') ||
      !Array.isArray(op.changed) || !op.changed.every(positiveId)) fail();
  return value;
}

// Twelve seconds of quiet, invented audio. PCM WAV lives in a Blob, never on the server.
function makeDemoWav(id) {
  const rate = 22050;
  const seconds = 12;
  const samples = rate * seconds;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const write = (offset, text) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, samples * 2, true);
  const melody = [0, 4, 7, 12, 7, 4, 2, 7];
  const root = 130.8128 * Math.pow(2, (id % 5) / 12);
  for (let i = 0; i < samples; i++) {
    const time = i / rate;
    const beatTime = time % 0.5;
    const frequency = root * Math.pow(2, melody[Math.floor(time * 2) % melody.length] / 12);
    const envelope = Math.min(1, beatTime / 0.025) * Math.exp(-beatTime * 5) * Math.min(1, (seconds - time) / 0.2);
    const tone = Math.sin(2 * Math.PI * frequency * beatTime) + 0.18 * Math.sin(4 * Math.PI * frequency * beatTime);
    view.setInt16(44 + i * 2, Math.round(tone * envelope * 0.17 * 32767), true);
  }
  return bytes;
}

function initializeApp() {
  const $ = id => document.getElementById(id);
  const audio = $('audio');
  const localAudio = new Map(); // Only browser media, keyed by stable C ID. Not playlist state.
  let state = null;
  let pending = false;
  let connected = false;
  let wantPlayback = false;
  let demoAudio = null;
  let sourceIdentity = '';
  let audioBroken = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function playlist(id) { return state?.playlists.find(list => list.id === id); }
  function currentTrack() {
    const list = playlist('main');
    return list?.nodes.find(node => node.id === list.current);
  }
  function feedback(message, error = false) {
    $('feedback').textContent = message;
    $('feedback').parentElement.classList.toggle('is-error', error);
  }
  function localSource(node) {
    const media = localAudio.get(node.id);
    return media && media.title === node.title && media.artist === node.artist ? media : null;
  }
  function sourceLabel(node) { return localSource(node) ? 'LOCAL AUDIO' : 'DEMO TONE'; }

  function updateControls() {
    const locked = pending || !connected || !state;
    const main = playlist('main');
    const current = currentTrack();
    $('add-fields').disabled = locked;
    $('add-submit').disabled = locked || state.playlists.reduce((sum, list) => sum + list.size, 0) >= 200;
    $('reset').disabled = locked;
    $('refresh').disabled = pending;
    $('previous').disabled = locked || !current;
    $('next').disabled = locked || !current;
    $('play').disabled = locked || !current || audioBroken;
    $('volume').disabled = locked || !current;
    $('seek').disabled = locked || !current || !Number.isFinite(audio.duration) || audio.duration <= 0 || audioBroken;
    $('merge').disabled = locked || !playlist('secondary')?.size;
    document.querySelectorAll('.reverse-button').forEach(button => {
      button.disabled = locked || !playlist(button.dataset.playlist)?.size;
    });
    document.querySelectorAll('.track-select, .delete-track').forEach(button => { button.disabled = locked; });
    $('collection').setAttribute('aria-busy', String(pending));
    $('add-form').setAttribute('aria-busy', String(pending));
    let connectionMessage = 'C API unavailable';
    if (pending) connectionMessage = 'C request pending…';
    else if (connected) connectionMessage = 'C state connected';
    $('connection').textContent = connectionMessage;
    $('connection').classList.toggle('connected', connected && !pending);
    $('connection').classList.toggle('disconnected', !connected && !pending);
    $('play-label').textContent = audio.paused ? 'Play' : 'Pause';
    $('play-symbol').textContent = audio.paused ? '▶' : 'Ⅱ';
    $('play').setAttribute('aria-label', `${audio.paused ? 'Play' : 'Pause'} current main track`);
    $('vinyl').classList.toggle('playing', !audio.paused && !!main?.current);
  }

  function renderTracks() {
    const changed = new Set(state.operation.changed);
    for (const list of state.playlists) {
      $(`${list.id}-heading`).textContent = list.name;
      $(`${list.id}-count`).textContent = `${list.size} ${list.size === 1 ? 'track' : 'tracks'}`;
      $(`${list.id}-endpoints`).textContent = `head → ${pointer(list.head)} / tail → ${pointer(list.tail)}`;
      const rows = list.nodes.map((node, index) => {
        const isCurrent = node.id === list.current;
        const row = element('li', `track-row${isCurrent ? ' is-current' : ''}${changed.has(node.id) ? ' is-changed' : ''}`);
        const number = element('span', 'track-number', String(index + 1).padStart(2, '0'));
        number.setAttribute('aria-hidden', 'true');
        const select = element('button', 'track-select');
        select.type = 'button';
        select.dataset.action = 'select';
        select.dataset.playlist = list.id;
        select.dataset.id = String(node.id);
        select.dataset.focusKey = `select-${node.id}`;
        select.setAttribute('aria-label', `${list.id === 'main' ? 'Select' : 'Set Side B current to'} ${node.title}, ${node.artist}, node ${node.id}`);
        select.setAttribute('aria-pressed', String(isCurrent));
        select.append(element('span', 'track-title', node.title), element('span', 'track-artist', node.artist),
          element('span', 'track-meta', `${pointer(node.id)} · ${sourceLabel(node)}${isCurrent ? ' · CURRENT' : ''}`));
        const remove = element('button', 'button delete-track', 'Delete');
        remove.type = 'button';
        remove.dataset.action = 'delete';
        remove.dataset.playlist = list.id;
        remove.dataset.id = String(node.id);
        remove.dataset.focusKey = `delete-${node.id}`;
        remove.setAttribute('aria-label', `Delete ${node.title} from ${list.name}, node ${node.id}`);
        row.append(number, select, remove);
        return row;
      });
      if (!rows.length) rows.push(element('li', 'empty-state', list.id === 'main'
        ? 'An empty sleeve. Add a record or merge Side B to get started.'
        : 'This side is empty. Add a record here to try a splice.'));
      $(`${list.id}-tracks`).replaceChildren(...rows);
    }
  }

  function renderLab() {
    const changed = new Set(state.operation.changed);
    const diagrams = state.playlists.map(list => {
      const diagram = element('section', 'diagram');
      const heading = element('div', 'diagram-header');
      const title = element('h3', '', `${list.name} / ${list.size} nodes`);
      title.id = `diagram-${list.id}-heading`;
      heading.append(title, element('p', '', `head → ${pointer(list.head)} · tail → ${pointer(list.tail)} · current → ${pointer(list.current)}`));
      const scroll = element('div', 'node-scroll');
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-labelledby', title.id);
      scroll.setAttribute('aria-describedby', `diagram-${list.id}-note`);
      scroll.append(element('span', 'null-label', 'NULL'));
      for (const node of list.nodes) {
        scroll.append(element('span', 'node-connector', node.prev === null ? '←' : '⇄'));
        const card = element('div', `node-card${node.id === list.current ? ' is-current' : ''}${changed.has(node.id) ? ' is-changed' : ''}`);
        const top = element('div', 'node-topline');
        const roles = [node.id === list.head ? 'HEAD' : '', node.id === list.tail ? 'TAIL' : ''].filter(Boolean).join(' / ');
        top.append(element('span', '', pointer(node.id)), element('span', 'node-role', roles));
        const links = element('div', 'node-links');
        links.append(element('span', '', `← prev ${pointer(node.prev)}`), element('span', '', `next ${pointer(node.next)} →`));
        card.append(top, element('p', 'node-title', node.title), links);
        card.setAttribute('aria-label', `Node ${node.id}, ${node.title}. Previous ${pointer(node.prev)}, next ${pointer(node.next)}${roles ? `, ${roles}` : ''}${node.id === list.current ? ', CURRENT' : ''}${changed.has(node.id) ? ', changed' : ''}`);
        scroll.append(card);
      }
      if (list.size) scroll.append(element('span', 'node-connector', '→'), element('span', 'null-label', 'NULL'));
      else scroll.append(element('span', 'empty-state', 'No nodes. head, tail, and current are NULL.'));
      const note = element('p', 'diagram-note', 'Scroll horizontally to follow every link. Focus this region and use arrow keys.');
      note.id = `diagram-${list.id}-note`;
      diagram.append(heading, scroll, note);
      return diagram;
    });
    $('diagrams').replaceChildren(...diagrams);
    const op = state.operation;
    $('operation-heading').textContent = op.action ? `${op.action.charAt(0).toUpperCase()}${op.action.slice(1)}` : 'State received';
    $('operation-message').textContent = op.message;
    $('complexity').textContent = op.complexity;
    $('operation-steps').replaceChildren(...op.steps.map(step => element('li', '', step)));
  }

  function revokeDemo() {
    if (demoAudio) URL.revokeObjectURL(demoAudio.url);
    demoAudio = null;
  }

  async function startAudio() {
    const identity = sourceIdentity;
    try {
      await audio.play();
      if (identity === sourceIdentity) $('audio-feedback').textContent = '';
    } catch (error) {
      if (identity !== sourceIdentity) return;
      wantPlayback = false;
      $('audio-feedback').textContent = error.name === 'NotAllowedError'
        ? 'Your browser needs a fresh gesture. Press Play to listen.'
        : 'Audio could not start. Press Play to retry, or add a supported local audio file.';
    }
    updateControls();
  }

  function synchronizeAudio() {
    const node = currentTrack();
    $('current-id').textContent = `current → ${pointer(node?.id ?? null)}`;
    $('current-title').textContent = node?.title ?? 'The needle is waiting.';
    $('current-artist').textContent = node?.artist ?? 'Add a track to A, or merge Side B.';
    if (!node) {
      wantPlayback = false;
      sourceIdentity = '';
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      revokeDemo();
      $('audio-source').textContent = 'No current node. No audio to play.';
      $('audio-feedback').textContent = '';
      updateTime();
      return;
    }
    const local = localSource(node);
    const identity = `${node.id}|${node.title}|${node.artist}|${local?.url ?? 'demo'}`;
    $('audio-source').textContent = local
      ? `Browser-local file · ${local.filename} · never uploaded`
      : 'Generated demo tone · 12 seconds · not the original track audio';
    if (sourceIdentity === identity) return; // Reverse/merge must not restart the current recording.
    sourceIdentity = identity;
    audio.pause();
    revokeDemo();
    audioBroken = false;
    if (!local) demoAudio = { url: URL.createObjectURL(new Blob([makeDemoWav(node.id)], { type: 'audio/wav' })) };
    audio.src = local?.url ?? demoAudio.url;
    audio.load();
    $('audio-feedback').textContent = '';
    updateTime();
    if (wantPlayback) void startAudio(); // Only a previously playing, user-started session may continue.
  }

  function pruneLocalAudio(nextState) {
    for (const [id, media] of localAudio) {
      const match = nextState.playlists.some(list => list.nodes.some(node => node.id === id && node.title === media.title && node.artist === media.artist));
      if (!match) {
        URL.revokeObjectURL(media.url);
        localAudio.delete(id);
      }
    }
  }

  function restoreFocus(key, listId, original) {
    // Do not steal focus if the user moved to another control while waiting.
    if (document.activeElement !== document.body && document.activeElement !== original) return;
    if (!key && !original?.matches('button, input, select')) return;
    const buttons = [...document.querySelectorAll('[data-focus-key]')];
    let target = key ? buttons.find(button => button.dataset.focusKey === key) : original;
    if (!target?.isConnected || target.disabled || target.closest('fieldset:disabled')) {
      target = buttons.find(button => !button.disabled && button.dataset.focusKey === `select-${playlist(listId)?.current}`) ||
        $(`${listId}-heading`);
    }
    target?.focus({ preventScroll: true });
  }

  async function requestState(fields = null, file = null) {
    if (pending) return false; // One in-flight operation; no optimistic state and no queue of stale clicks.
    const focusTarget = document.activeElement;
    const focusKey = focusTarget?.dataset.focusKey;
    const focusList = focusTarget?.dataset.playlist ?? 'main';
    const oldIds = new Set(state?.playlists.flatMap(list => list.nodes.map(node => node.id)) ?? []);
    pending = true;
    feedback(fields ? `C is applying ${fields.action}…` : 'Reading the C playlist state…');
    updateControls();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(fields ? '/api/action' : '/api/state', {
        method: fields ? 'POST' : 'GET',
        headers: fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        body: fields ? new URLSearchParams(fields).toString() : undefined,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      let result;
      try { result = await response.json(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('No valid JSON from the C API. Start the local musiclab server, then refresh state.');
      }
      if (!response.ok || result?.ok !== true) {
        const error = new Error(typeof result?.error === 'string' ? result.error : `C API request failed (HTTP ${response.status}).`);
        error.statePreserved = result?.ok === false && typeof result?.error === 'string' && response.status >= 400 && response.status < 500;
        throw error;
      }
      validateState(result);
      pruneLocalAudio(result);
      let attachmentNote = '';
      if (file && fields?.action === 'add') {
        const list = result.playlists.find(item => item.id === fields.playlist);
        const added = list.nodes.filter(node => !oldIds.has(node.id) && node.title === fields.title && node.artist === fields.artist);
        if (added.length === 1) {
          const node = added[0];
          localAudio.set(node.id, { url: URL.createObjectURL(file), filename: file.name, title: node.title, artist: node.artist });
          attachmentNote = ' Local audio attached in this browser only.';
        } else attachmentNote = ' Could not uniquely associate the local file; generated demo audio will be used.';
      }
      state = result;
      connected = true;
      renderTracks();
      renderLab();
      synchronizeAudio();
      feedback(`${state.operation.message}${attachmentNote}`);
      return true;
    } catch (error) {
      if (!error.statePreserved) {
        connected = false; // A failed transport may have mutated C; require an explicit refresh before more actions.
        wantPlayback = false;
        audio.pause();
      }
      const detail = error.name === 'AbortError'
        ? 'C did not respond within 10 seconds. The operation may have completed; refresh state before retrying.'
        : error.message || 'Cannot reach the local C server. Refresh state to reconnect.';
      feedback(`${detail}${state && !error.statePreserved ? ' Displaying the last received snapshot, not live state.' : ''}`, true);
      return false;
    } finally {
      clearTimeout(timer);
      pending = false;
      updateControls();
      restoreFocus(focusKey, focusList, focusTarget);
    }
  }

  function updateTime() {
    const format = seconds => {
      const time = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
      return `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;
    };
    $('elapsed').textContent = format(audio.currentTime);
    $('duration').textContent = format(audio.duration);
    $('seek').value = Number.isFinite(audio.duration) && audio.duration > 0 ? String(audio.currentTime / audio.duration * 100) : '0';
    $('seek').setAttribute('aria-valuetext', `${format(audio.currentTime)} of ${format(audio.duration)}`);
  }

  function validateField(id) {
    const input = $(id);
    const count = utf8.encode(trimSongText(input.value)).length;
    const problem = textProblem(input.value);
    input.setCustomValidity(problem);
    $(`${id}-bytes`).textContent = `${count} / 127 bytes`;
    $(`${id}-bytes`).classList.toggle('over-limit', count > 127);
    return !problem;
  }

  $('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !connected) return;
    const titleValid = validateField('title');
    const artistValid = validateField('artist');
    if (!titleValid || !artistValid) { $('add-form').reportValidity(); return; }
    const fields = { action: 'add', playlist: $('destination').value, title: trimSongText($('title').value), artist: trimSongText($('artist').value) };
    const success = await requestState(fields, $('local-file').files[0] ?? null);
    if (success) {
      $('title').value = '';
      $('artist').value = '';
      $('local-file').value = '';
      for (const id of ['title', 'artist']) {
        $(id).setCustomValidity('');
        $(`${id}-bytes`).textContent = '0 / 127 bytes';
        $(`${id}-bytes`).classList.remove('over-limit');
      }
      if ($('add-form').contains(document.activeElement)) $('title').focus();
    }
  });
  for (const id of ['title', 'artist']) $(id).addEventListener('input', () => validateField(id));
  for (const id of ['main', 'secondary']) {
    $(`${id}-tracks`).addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled || pending || !connected) return;
      void requestState({ action: button.dataset.action, playlist: button.dataset.playlist, id: button.dataset.id });
    });
  }
  document.querySelectorAll('.reverse-button').forEach(button => {
    button.addEventListener('click', () => void requestState({ action: 'reverse', playlist: button.dataset.playlist }));
  });
  for (const [id, action] of [['next', 'next'], ['previous', 'previous']]) {
    $(id).addEventListener('click', () => void requestState({ action, playlist: 'main' }));
  }
  $('merge').addEventListener('click', () => void requestState({ action: 'merge', playlist: 'main', source: 'secondary' }));
  $('reset').addEventListener('click', () => void requestState({ action: 'reset' }));
  $('refresh').addEventListener('click', () => void requestState());
  $('lab-toggle').addEventListener('click', () => {
    const open = $('pointer-lab').hidden;
    $('pointer-lab').hidden = !open;
    $('lab-toggle').setAttribute('aria-expanded', String(open));
    $('lab-toggle').replaceChildren(document.createTextNode(`${open ? 'Hide' : 'Show'} pointer lab `), element('span', '', '↔'));
    $('lab-toggle').lastElementChild.setAttribute('aria-hidden', 'true');
  });
  $('play').addEventListener('click', () => {
    if (pending || !connected || !currentTrack()) return;
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;
      wantPlayback = true;
      void startAudio();
    } else {
      wantPlayback = false;
      audio.pause();
    }
    updateControls();
  });
  $('seek').addEventListener('input', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number($('seek').value) / 100 * audio.duration;
    updateTime();
  });
  audio.volume = Number($('volume').value);
  $('volume').addEventListener('input', () => { audio.volume = Number($('volume').value); });
  audio.addEventListener('timeupdate', updateTime);
  for (const event of ['loadedmetadata', 'durationchange', 'emptied']) {
    audio.addEventListener(event, () => { updateTime(); updateControls(); });
  }
  for (const event of ['play', 'pause']) audio.addEventListener(event, updateControls);
  audio.addEventListener('ended', () => {
    wantPlayback = false;
    $('audio-feedback').textContent = 'Record finished. Press Play to replay, or Next to ask C for the next node.';
    updateControls();
  });
  audio.addEventListener('error', () => {
    if (!audio.hasAttribute('src') || !audio.error) return;
    wantPlayback = false;
    const node = currentTrack();
    const local = node && localSource(node);
    if (local) {
      URL.revokeObjectURL(local.url);
      localAudio.delete(node.id);
      synchronizeAudio();
      renderTracks();
      $('audio-feedback').textContent = 'This local file could not be decoded. Generated demo tone selected instead; press Play.';
    } else {
      audioBroken = true;
      $('audio-feedback').textContent = 'The browser could not decode the demo WAV. Try another browser or add a supported local audio file.';
    }
    updateControls();
  });
  window.addEventListener('pagehide', () => {
    wantPlayback = false;
    audio.pause();
    for (const media of localAudio.values()) URL.revokeObjectURL(media.url);
    localAudio.clear();
    revokeDemo();
    sourceIdentity = '';
  });
  window.addEventListener('pageshow', event => { if (event.persisted) void requestState(); });
  updateControls();
  void requestState();
}

if (typeof document !== 'undefined') initializeApp();
// No runtime dependency: the small Node check uses the same validation and WAV encoder.
if (typeof module !== 'undefined') module.exports = { trimSongText, textProblem, pointer, validateState, makeDemoWav };
