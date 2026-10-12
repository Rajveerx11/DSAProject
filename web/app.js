'use strict';

const utf8 = new TextEncoder();
const LIST_IDS = ['main', 'secondary'];
const SONG_LIMIT = 200;
// The C contract requires capacity >= 632. Accept larger bounded captures too.
const TRACE_LIMIT = 4096;
const AUTO_LIMIT = 80;
const positiveId = id => Number.isInteger(id) && id > 0 && id <= 0xffffffff;
const link = id => id === null || positiveId(id);
const invalid = () => { throw new Error('The C API returned an invalid state or recorded trace. Refresh after checking the server.'); };

// C trims ASCII spaces only, rejects C0/C1 controls and invalid UTF-8.
function trimSongText(value) { return value.replace(/^ +| +$/g, ''); }
function textProblem(value) {
  const text = trimSongText(value);
  if (!text) return 'Enter a non-empty value.';
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) return 'Control characters are not allowed.';
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) return 'Use valid Unicode text (no unpaired surrogates).';
  }
  if (utf8.encode(text).length > 127) return 'Use at most 127 UTF-8 bytes (some characters use more than one byte).';
  return '';
}
function pointer(value) { return value === null ? 'NULL' : `#${value}`; }
function metadata(node) { return ['title', 'artist'].every(key => typeof node[key] === 'string' && !textProblem(node[key])); }

function validatePlaylists(lists) {
  if (!Array.isArray(lists) || lists.length !== 2) invalid();
  const ids = new Set();
  for (const id of LIST_IDS) {
    const list = lists.find(item => item?.id === id);
    if (!list || typeof list.name !== 'string' || !Array.isArray(list.nodes) ||
        !Number.isInteger(list.size) || list.size !== list.nodes.length || list.size < 0 ||
        list.size > SONG_LIMIT || ![list.head, list.tail, list.current].every(link)) invalid();
    for (const [index, node] of list.nodes.entries()) {
      if (!node || !positiveId(node.id) || ids.has(node.id) || !metadata(node) ||
          node.prev !== (list.nodes[index - 1]?.id ?? null) || node.next !== (list.nodes[index + 1]?.id ?? null)) invalid();
      ids.add(node.id);
    }
    if (list.head !== (list.nodes[0]?.id ?? null) || list.tail !== (list.nodes.at(-1)?.id ?? null) ||
        (list.size === 0 ? list.current !== null : !list.nodes.some(node => node.id === list.current))) invalid();
  }
  if (ids.size > SONG_LIMIT) invalid();
}

// Display records in snapshot order, never traverse links (intermediate links may cycle).
function createProjection(lists) {
  return {
    lists: new Map(lists.map(list => [list.id, { ...list, order: list.nodes.map(node => node.id), nodes: undefined }])),
    nodes: new Map(lists.flatMap(list => list.nodes.map(node => [node.id, { ...node, playlist: list.id }]))),
    ghost: null, visits: 0, writes: 0, event: null, final: false
  };
}
function applyEvent(projection, event) {
  projection.ghost = null;
  projection.event = event;
  if (event.kind === 'allocate') {
    projection.nodes.set(event.id, { ...event });
    projection.lists.get(event.playlist).order.push(event.id);
  } else if (event.kind === 'pointer') {
    const record = event.id === null ? projection.lists.get(event.playlist) : projection.nodes.get(event.id);
    record[event.field] = event.to;
    projection.writes++;
  } else if (event.kind === 'visit') {
    projection.visits++;
  } else if (event.kind === 'free') {
    projection.ghost = { ...projection.nodes.get(event.id) };
    projection.nodes.delete(event.id);
  }
  return projection;
}

function validateState(value) {
  if (!value || value.ok !== true) invalid();
  // The server's agreed response budget; also bounds text/steps/unknown fields.
  if (utf8.encode(JSON.stringify(value)).length > 512 * 1024) invalid();
  validatePlaylists(value.playlists);
  const op = value.operation;
  if (!op || !['action', 'message', 'complexity'].every(key => typeof op[key] === 'string') ||
      !Array.isArray(op.steps) || !op.steps.every(step => typeof step === 'string') ||
      !Array.isArray(op.changed) || op.changed.length > SONG_LIMIT + 1 || !op.changed.every(positiveId)) invalid();
  const trace = op.trace;
  if (!trace || typeof trace.truncated !== 'boolean' || !Array.isArray(trace.events) || trace.events.length > TRACE_LIMIT) invalid();
  validatePlaylists(trace.before);
  const p = createProjection(trace.before);
  const everAllocated = new Set(p.nodes.keys());
  for (const e of trace.events) {
    if (!e || !LIST_IDS.includes(e.playlist) || !['allocate', 'visit', 'pointer', 'free'].includes(e.kind)) invalid();
    if (e.kind === 'allocate') {
      if (!positiveId(e.id) || everAllocated.has(e.id) || p.nodes.size >= SONG_LIMIT || !metadata(e) ||
          ![e.prev, e.next].every(link) || ![e.prev, e.next].every(id => id === null || p.nodes.has(id))) invalid();
      everAllocated.add(e.id);
    } else if (e.kind === 'pointer') {
      if (!link(e.id) || ![e.from, e.to].every(link) ||
          !(e.id === null ? ['head', 'tail', 'current'] : ['prev', 'next']).includes(e.field) ||
          (e.id !== null && !p.nodes.has(e.id)) || (e.to !== null && !p.nodes.has(e.to))) invalid();
      const record = e.id === null ? p.lists.get(e.playlist) : p.nodes.get(e.id);
      // A pointer write must describe the actual previous field, not an invented transition.
      if (record[e.field] !== e.from) invalid();
    } else if (!positiveId(e.id) || !p.nodes.has(e.id)) invalid();
    applyEvent(p, e);
  }
  if (!trace.truncated) {
    const after = createProjection(value.playlists);
    if (after.nodes.size !== p.nodes.size) invalid();
    for (const [id, node] of after.nodes) {
      const recorded = p.nodes.get(id);
      if (!recorded || !['title', 'artist', 'prev', 'next'].every(key => recorded[key] === node[key])) invalid();
    }
    for (const id of LIST_IDS) {
      if (!['head', 'tail', 'current'].every(key => p.lists.get(id)[key] === after.lists.get(id)[key])) invalid();
    }
    // Membership and size are canonical only at the final frame, not inferred from pointers.
    if (!trace.events.length && !LIST_IDS.every(id => {
      const before = trace.before.find(list => list.id === id);
      const final = value.playlists.find(list => list.id === id);
      return before.size === final.size && before.nodes.every((node, i) => node.id === final.nodes[i]?.id);
    })) invalid();
  }
  return value;
}

// Frame 0 = C before, 1..N = actual events, N+1 = authoritative committed after.
function projectTrace(state, frame) {
  const events = state.operation.trace.events;
  if (!Number.isInteger(frame) || frame < 0 || frame > events.length + 1) throw new RangeError('Invalid replay frame');
  const p = createProjection(frame === events.length + 1 ? state.playlists : state.operation.trace.before);
  for (let i = 0; i < Math.min(frame, events.length); i++) {
    if (frame !== events.length + 1) applyEvent(p, events[i]);
    else {
      if (events[i].kind === 'visit') p.visits++;
      if (events[i].kind === 'pointer') p.writes++;
    }
  }
  p.final = frame === events.length + 1;
  return p;
}
function eventLabel(event) {
  if (!event) return 'C before snapshot · no recorded event applied';
  const side = event.playlist === 'main' ? 'A' : 'B';
  if (event.kind === 'pointer') return `${event.id === null ? `Side ${side}` : pointer(event.id)}.${event.field}: ${pointer(event.from)} → ${pointer(event.to)}`;
  if (event.kind === 'visit') return `Visit ${pointer(event.id)} · actual C ID comparison (Side ${side})`;
  if (event.kind === 'allocate') return `Allocate ${pointer(event.id)} · initialized, not yet linked (Side ${side})`;
  return `Free ${pointer(event.id)} · unlinked record shown as a ghost (Side ${side})`;
}
function shouldAutoPlay(count, reducedMotion, enabled) { return enabled && !reducedMotion && count > 0 && count <= AUTO_LIMIT; }

function initializeApp() {
  const $ = id => document.getElementById(id);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = null;
  let pending = false;
  let connected = false;
  let frame = 0;
  let running = false;
  let replayTimer = null;
  let requestController = null;
  let requestTimer = null;
  let hidden = false;
  let projection = null;
  const animations = new Set();
  const cards = new Map();
  const markers = new Map();
  let canvas = null;
  let scroll = null;
  let svg = null;
  const lanes = new Map();
  const headers = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function playlist(id) { return state?.playlists.find(list => list.id === id); }
  function currentTrack() { return playlist('main')?.nodes.find(node => node.id === playlist('main').current); }
  function feedback(message, error = false) {
    $('feedback').textContent = message;
    $('feedback').parentElement.classList.toggle('is-error', error);
  }
  function animate(node, keyframes, options = {}) {
    if (motion.matches || hidden || !node.animate) return;
    const animation = node.animate(keyframes, { duration: Math.min(350, 350 / Number($('replay-speed').value)), easing: 'ease-out', ...options });
    animations.add(animation);
    const release = () => animations.delete(animation);
    animation.onfinish = release;
    animation.oncancel = release;
  }
  function cancelAnimations() {
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function pause() { clearTimeout(replayTimer); replayTimer = null; running = false; }
  function lastFrame() { return state.operation.trace.events.length + 1; }

  function updateControls() {
    const locked = pending || !connected || !state;
    // Keep editable fields focused while pending. Submission alone is locked.
    $('add-fields').disabled = !connected || !state;
    $('add-submit').disabled = locked || state.playlists.reduce((sum, list) => sum + list.size, 0) >= SONG_LIMIT;
    $('reset').disabled = locked;
    $('refresh').disabled = pending;
    for (const id of ['previous', 'next']) $(id).disabled = locked || !currentTrack();
    $('merge').disabled = locked || !playlist('secondary')?.size;
    document.querySelectorAll('.reverse-button').forEach(button => { button.disabled = locked || !playlist(button.dataset.playlist)?.size; });
    document.querySelectorAll('.track-select, .delete-track').forEach(button => { button.disabled = locked; });
    $('collection').setAttribute('aria-busy', String(pending));
    $('add-form').setAttribute('aria-busy', String(pending));
    $('connection').textContent = pending ? 'C request pending…' : connected ? 'C state connected' : 'C API unavailable';
    $('connection').classList.toggle('connected', connected && !pending);
    $('connection').classList.toggle('disconnected', !connected && !pending);
    const unavailable = !state || pending;
    $('replay-pause').textContent = running ? 'Pause' : 'Continue';
    $('replay-pause').disabled = unavailable || frame === lastFrame() || motion.matches;
    $('replay-previous').disabled = unavailable || frame === 0;
    $('replay-next').disabled = unavailable || frame === lastFrame();
    $('replay-replay').disabled = unavailable || !state.operation.trace.events.length;
    $('replay-finish').disabled = unavailable || frame === lastFrame();
  }

  function renderTracks() {
    for (const list of state.playlists) {
      $(`${list.id}-heading`).textContent = list.name;
      $(`${list.id}-count`).textContent = `${list.size} ${list.size === 1 ? 'track' : 'tracks'}`;
      $(`${list.id}-endpoints`).textContent = `head → ${pointer(list.head)} / tail → ${pointer(list.tail)}`;
      const rows = list.nodes.map((node, index) => {
        const isCurrent = node.id === list.current;
        const row = element('li', `track-row${isCurrent ? ' is-current' : ''}`);
        const number = element('span', 'track-number', String(index + 1).padStart(2, '0'));
        number.setAttribute('aria-hidden', 'true');
        const select = element('button', 'track-select');
        select.type = 'button';
        select.dataset.action = 'select';
        select.dataset.playlist = list.id;
        select.dataset.id = String(node.id);
        select.dataset.focusKey = `select-${node.id}`;
        select.setAttribute('aria-label', `Select ${node.title}, ${node.artist}, node ${node.id} in ${list.name}`);
        select.setAttribute('aria-pressed', String(isCurrent));
        select.append(element('span', 'track-title', node.title), element('span', 'track-artist', node.artist), element('span', 'track-meta', `${pointer(node.id)} · SAMPLE LABEL${isCurrent ? ' · CURRENT' : ''}`));
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
      if (!rows.length) rows.push(element('li', 'empty-state', 'Empty sleeve. Add a record or merge Side B.'));
      $(`${list.id}-tracks`).replaceChildren(...rows);
    }
    const current = currentTrack();
    $('current-title').textContent = current?.title ?? 'The needle is waiting.';
    $('current-artist').textContent = current?.artist ?? 'Add a track to A, or merge Side B.';
    $('current-id').textContent = `current → ${pointer(current?.id ?? null)}`;
    const op = state.operation;
    $('operation-heading').textContent = op.action ? op.action.charAt(0).toUpperCase() + op.action.slice(1) : 'State received';
    $('operation-message').textContent = op.message;
    $('complexity').textContent = op.complexity;
    $('operation-steps').replaceChildren(...op.steps.map(step => element('li', '', step)));
  }

  function svgElement(tag, attributes = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }
  function setupCanvas() {
    if (canvas) return;
    scroll = element('div', 'node-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Side A and Side B pointer canvas; scroll horizontally for long lists');
    scroll.setAttribute('aria-describedby', 'canvas-note');
    canvas = element('div', 'pointer-canvas');
    for (const id of LIST_IDS) {
      const diagram = element('section', 'diagram');
      diagram.dataset.playlist = id;
      const header = element('div', 'diagram-header');
      const lane = element('div', 'node-lane');
      lanes.set(id, lane);
      headers.set(id, header);
      diagram.append(header, lane);
      canvas.append(diagram);
      markers.set(id, element('span', 'current-marker', `${id === 'main' ? 'A' : 'B'} current ↓`));
    }
    svg = svgElement('svg', { class: 'pointer-edges', 'aria-hidden': 'true' });
    canvas.append(svg);
    scroll.append(canvas);
    const note = element('p', 'diagram-note', 'Solid arrows = recorded fields · dashed vermilion = previous link · dashed card = allocation / freed ghost. Scroll inside the canvas.');
    note.id = 'canvas-note';
    $('diagrams').replaceChildren(scroll, note);
  }

  function rect(node) {
    const box = node.getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
  }
  function drawEdges(withMotion = false) {
    if (!canvas || !projection || hidden) return;
    const width = canvas.scrollWidth;
    const height = canvas.scrollHeight;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const defs = svgElement('defs');
    for (const [id, color] of [['ink', '#6b7162'], ['prev', '#8d7762'], ['active', '#d83a1f']]) {
      const marker = svgElement('marker', { id: `arrow-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
      marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
      defs.append(marker);
    }
    svg.replaceChildren(defs);
    const e = projection.event;
    function edge(sourceId, targetId, field, active = false, old = false, listId = null) {
      const source = sourceId === null ? headers.get(listId) : cards.get(sourceId);
      if (!source?.isConnected) return;
      const s = rect(source);
      const target = targetId === null ? null : cards.get(targetId);
      if (targetId !== null && !target?.isConnected) return;
      const backwards = field === 'prev';
      const endpoint = sourceId === null;
      const x1 = endpoint ? s.x + 18 : s.x + s.width * (backwards ? .3 : .7);
      const y1 = endpoint ? s.y + s.height : backwards ? s.y : s.y + s.height;
      let x2, y2;
      if (target) {
        const t = rect(target);
        x2 = t.x + t.width * (backwards ? .7 : .3);
        y2 = endpoint || backwards ? t.y : t.y + t.height;
      } else {
        x2 = x1 + (backwards ? -25 : 25);
        y2 = y1 + (backwards ? -20 : 20);
      }
      const bend = backwards ? -24 : 24;
      const d = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 + bend}, ${x2} ${y2}`;
      const path = svgElement('path', { d, class: `pointer-edge edge-${backwards ? 'prev' : 'next'}${active ? ' edge-active' : ''}${old ? ' edge-old' : ''}`, 'marker-end': `url(#arrow-${active || old ? 'active' : backwards ? 'prev' : 'ink'})`, 'data-source': sourceId === null ? listId : sourceId, 'data-target': targetId ?? 'null', 'data-field': field });
      svg.append(path);
      if (targetId === null) {
        const label = svgElement('text', { x: x2 + (backwards ? -22 : 4), y: y2 + 3, class: 'edge-null' });
        label.textContent = 'NULL';
        svg.append(label);
      }
      if (active && withMotion) {
        const length = path.getTotalLength();
        animate(path, [{ strokeDasharray: `${length} ${length}`, strokeDashoffset: length }, { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 }]);
      }
    }
    for (const node of projection.nodes.values()) {
      for (const field of ['prev', 'next']) {
        const active = e?.kind === 'pointer' && e.id === node.id && e.field === field;
        if (active && e.from !== e.to) edge(node.id, e.from, field, false, true);
        edge(node.id, node[field], field, active);
      }
    }
    if (e?.kind === 'pointer' && e.id === null) {
      if (e.from !== e.to) edge(null, e.from, e.field, false, true, e.playlist);
      edge(null, e.to, e.field, true, false, e.playlist);
    }
  }

  function renderGraph(withMotion) {
    setupCanvas();
    const oldRects = new Map([...cards].filter(([, card]) => card.isConnected).map(([id, card]) => [id, card.getBoundingClientRect()]));
    const oldMarkers = new Map([...markers].filter(([, marker]) => marker.isConnected).map(([id, marker]) => [id, { box: marker.getBoundingClientRect(), nodeId: marker.parentElement.dataset.id }]));
    cancelAnimations();
    projection = projectTrace(state, frame);
    const e = projection.event;
    const visible = new Map(projection.nodes);
    if (projection.ghost) visible.set(projection.ghost.id, projection.ghost);
    for (const marker of markers.values()) marker.remove();
    for (const [id, card] of cards) {
      if (!visible.has(id)) { card.remove(); cards.delete(id); }
    }
    for (const id of LIST_IDS) {
      const list = projection.lists.get(id);
      const heading = element('h3', '', `${id === 'main' ? 'SIDE A' : 'SIDE B'} / ${list.name}`);
      headers.get(id).replaceChildren(heading, element('p', '', `head → ${pointer(list.head)} · tail → ${pointer(list.tail)} · current → ${pointer(list.current)}`));
      const lane = lanes.get(id);
      // Keep independent allocation records in their original lanes until C's final order.
      for (const nodeId of list.order) {
        const node = visible.get(nodeId);
        if (!node) continue;
        let card = cards.get(nodeId);
        if (!card) { card = element('div', 'node-card'); cards.set(nodeId, card); }
        card.dataset.id = String(nodeId);
        card.dataset.playlist = id;
        card.className = 'node-card';
        const source = e?.kind === 'pointer' && (e.id === nodeId || (e.id === null && e.from === nodeId));
        const target = e?.kind === 'pointer' && e.to === nodeId;
        card.classList.toggle('is-source', source);
        card.classList.toggle('is-target', target);
        card.classList.toggle('is-visited', e?.kind === 'visit' && e.id === nodeId);
        card.classList.toggle('is-allocated', e?.kind === 'allocate' && e.id === nodeId);
        card.classList.toggle('is-freed', projection.ghost?.id === nodeId);
        const roles = LIST_IDS.flatMap(listId => {
          const owner = projection.lists.get(listId);
          return ['head', 'tail'].filter(field => owner[field] === nodeId).map(field => `${listId === 'main' ? 'A' : 'B'} ${field.toUpperCase()}`);
        }).join(' / ');
        const top = element('div', 'node-topline');
        top.append(element('span', '', pointer(nodeId)), element('span', 'node-role', projection.ghost?.id === nodeId ? 'FREED' : roles));
        const links = element('div', 'node-links');
        for (const field of ['prev', 'next']) {
          const label = element('span', e?.kind === 'pointer' && e.id === nodeId && e.field === field ? 'active-field' : '', `${field} ${pointer(node[field])}`);
          label.dataset.field = field;
          links.append(label);
        }
        card.replaceChildren(top, element('p', 'node-title', node.title), element('p', 'node-artist', node.artist), links);
        card.title = `${node.title} — ${node.artist}`;
        card.setAttribute('aria-label', `Node ${nodeId}, ${node.title}, ${node.artist}. Previous ${pointer(node.prev)}, next ${pointer(node.next)}. ${roles}${projection.ghost?.id === nodeId ? '. Freed ghost, not a live allocation.' : ''}`);
        lane.append(card);
      }
      // Remove empty placeholders without removing the persistent cards used by FLIP.
      lane.querySelectorAll('.empty-state').forEach(node => node.remove());
      if (!list.order.some(nodeId => visible.has(nodeId))) lane.append(element('p', 'empty-state', 'NULL · No allocated records in this lane.'));
    }
    for (const id of LIST_IDS) {
      const current = projection.lists.get(id).current;
      const marker = markers.get(id);
      const card = cards.get(current);
      if (card?.isConnected && projection.nodes.has(current)) {
        card.classList.add('is-current');
        card.append(marker);
      }
    }
    if (withMotion) {
      for (const [id, card] of cards) {
        const old = oldRects.get(id);
        const now = card.getBoundingClientRect();
        if (old && (old.x !== now.x || old.y !== now.y)) {
          animate(card, [{ transform: `translate(${old.x - now.x}px, ${old.y - now.y}px)` }, { transform: 'translate(0, 0)' }]);
        } else if (!old && projection.event?.kind === 'allocate') {
          animate(card, [{ transform: 'translateY(16px) scale(.92)', opacity: 0 }, { transform: 'translateY(0) scale(1)', opacity: 1 }]);
        }
        if (projection.ghost?.id === id) animate(card, [{ opacity: 1 }, { opacity: .3 }], { fill: 'forwards' });
      }
      for (const [id, marker] of markers) {
        const previous = oldMarkers.get(id);
        // A marker on the same record already inherits that record's FLIP movement.
        if (!previous || !marker.isConnected || previous.nodeId === marker.parentElement.dataset.id) continue;
        const old = previous.box;
        const now = marker.getBoundingClientRect();
        if (old.x !== now.x || old.y !== now.y) animate(marker, [{ transform: `translate(${old.x - now.x}px, ${old.y - now.y}px)` }, { transform: 'translate(0, 0)' }]);
      }
    }
    drawEdges(withMotion);
    // Scroll only the canvas, never the page or keyboard focus.
    const activeId = e?.kind === 'pointer' ? e.id ?? e.to ?? e.from : e?.id;
    const active = cards.get(activeId);
    if (active?.isConnected) {
      const box = active.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      if (box.left < viewport.left + 16 || box.right > viewport.right - 16) {
        scroll.scrollLeft += box.left - viewport.left - (viewport.width - box.width) / 2;
      }
      if (box.top < viewport.top || box.bottom > viewport.bottom) scroll.scrollTop += box.top - viewport.top - (viewport.height - box.height) / 2;
    }
  }

  function renderReplay(withMotion = false) {
    if (!state) return;
    renderGraph(withMotion && !motion.matches);
    const count = state.operation.trace.events.length;
    const committed = frame === count + 1;
    $('replay-status').textContent = !connected ? 'Last received snapshot · disconnected' : committed ? 'Committed C state · final snapshot' : `Historical replay · ${running ? 'playing' : 'paused'} · C already committed`;
    $('replay-progress').textContent = committed ? `${count} events · final` : `Frame ${frame} / ${count} events`;
    $('replay-meter').max = count + 1;
    $('replay-meter').value = frame;
    $('active-assignment').textContent = committed ? 'Authoritative after snapshot · canonical membership, order and size from C' : eventLabel(projection.event);
    $('replay-counts').textContent = `Visits / comparisons: ${projection.visits} · Pointer writes: ${projection.writes}${!committed ? ' · intermediate fields, not a full-state invariant' : ''}`;
    let note = 'Recorded history, not C CPU single-stepping. C commits before replay begins; the collection at left always shows that committed snapshot.';
    if (state.operation.trace.truncated) note += ' C reported a truncated trace: missing events are not invented; Finish uses the authoritative after snapshot.';
    if (count > AUTO_LIMIT) note += ' Large trace (>80 events): starts paused. Use manual steps or Continue (automatic playback is capped to 12 seconds).';
    if (motion.matches) note += ' Reduced motion: new operations show the final snapshot instantly. Manual steps remain available without animation.';
    $('replay-note').textContent = note;
    updateControls();
  }
  function setFrame(next, withMotion = true) { frame = Math.max(0, Math.min(lastFrame(), next)); renderReplay(withMotion); }
  function finish(withMotion = false) { pause(); if (state) setFrame(lastFrame(), withMotion); else cancelAnimations(); }
  function schedule() {
    clearTimeout(replayTimer);
    if (!running || hidden) return;
    // Even explicit Continue on a huge capture cannot run for minutes.
    const interval = Math.min(600, 12000 / lastFrame()) / Number($('replay-speed').value);
    replayTimer = setTimeout(() => {
      if (!running || hidden) return;
      if (frame + 1 >= lastFrame()) { pause(); setFrame(lastFrame()); }
      else { setFrame(frame + 1); schedule(); }
    }, interval);
  }
  function startReplay() {
    pause();
    cancelAnimations();
    const count = state.operation.trace.events.length;
    frame = motion.matches || !count ? lastFrame() : 0;
    running = shouldAutoPlay(count, motion.matches, $('replay-auto').checked);
    renderReplay(false);
    schedule();
  }

  async function requestState(fields = null) {
    if (pending || hidden) return false;
    finish(); // No queued operations: complete old historical playback before asking C again.
    const focusTarget = document.activeElement;
    const focusKey = focusTarget?.dataset.focusKey;
    const focusList = focusTarget?.dataset.playlist ?? 'main';
    let focusMoved = false;
    const watchFocus = event => { if (event.target !== focusTarget && event.target !== document.body) focusMoved = true; };
    document.addEventListener('focusin', watchFocus);
    pending = true;
    feedback(fields ? `C is applying ${fields.action}…` : 'Reading the C playlist state…');
    updateControls();
    const controller = new AbortController();
    requestController = controller;
    requestTimer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(fields ? '/api/action' : '/api/state', {
        method: fields ? 'POST' : 'GET',
        headers: fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        body: fields ? new URLSearchParams(fields).toString() : undefined,
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal
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
      if (hidden) return false;
      state = result;
      connected = true;
      renderTracks();
      if (fields) startReplay();
      else { frame = lastFrame(); renderReplay(); }
      feedback(state.operation.message);
      return true;
    } catch (error) {
      if (!error.statePreserved) connected = false;
      if (!hidden) {
        const detail = error.name === 'AbortError' ? 'C did not respond within 10 seconds. The operation may have completed; refresh state before retrying.' : error.message || 'Cannot reach the local C server. Refresh state to reconnect.';
        feedback(`${detail}${state && !error.statePreserved ? ' Displaying the last received snapshot, not live state.' : ''}`, true);
        renderReplay();
      }
      return false;
    } finally {
      clearTimeout(requestTimer);
      requestTimer = null;
      requestController = null;
      pending = false;
      updateControls();
      document.removeEventListener('focusin', watchFocus);
      if (!hidden && !focusMoved && (document.activeElement === document.body || document.activeElement === focusTarget)) {
        let target = focusKey ? [...document.querySelectorAll('[data-focus-key]')].find(button => button.dataset.focusKey === focusKey) : focusTarget;
        if (!target?.isConnected || target.disabled || target.closest('fieldset:disabled')) {
          target = [...document.querySelectorAll('.track-select')].find(button => !button.disabled && button.dataset.focusKey === `select-${playlist(focusList)?.current}`) || $(`${focusList}-heading`);
        }
        if (target !== document.body) target?.focus({ preventScroll: true });
      }
    }
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
    const raw = { title: $('title').value, artist: $('artist').value };
    const success = await requestState({ action: 'add', playlist: $('destination').value, title: trimSongText(raw.title), artist: trimSongText(raw.artist) });
    if (success) {
      // Preserve edits made during the request; never force focus back into the form.
      for (const id of ['title', 'artist']) {
        if ($(id).value === raw[id]) { $(id).value = ''; $(id).setCustomValidity(''); $(`${id}-bytes`).textContent = '0 / 127 bytes'; $(`${id}-bytes`).classList.remove('over-limit'); }
      }
    }
  });
  for (const id of ['title', 'artist']) $(id).addEventListener('input', () => validateField(id));
  for (const id of LIST_IDS) {
    $(`${id}-tracks`).addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled || pending || !connected) return;
      void requestState({ action: button.dataset.action, playlist: button.dataset.playlist, id: button.dataset.id });
    });
  }
  document.querySelectorAll('.reverse-button').forEach(button => button.addEventListener('click', () => void requestState({ action: 'reverse', playlist: button.dataset.playlist })));
  for (const action of ['next', 'previous']) $(action).addEventListener('click', () => void requestState({ action, playlist: 'main' }));
  $('merge').addEventListener('click', () => void requestState({ action: 'merge', playlist: 'main', source: 'secondary' }));
  $('reset').addEventListener('click', () => void requestState({ action: 'reset' }));
  $('refresh').addEventListener('click', () => void requestState());
  $('replay-pause').addEventListener('click', () => {
    if (running) pause();
    else { running = true; schedule(); }
    renderReplay();
  });
  $('replay-previous').addEventListener('click', () => { pause(); setFrame(frame - 1); });
  $('replay-next').addEventListener('click', () => { pause(); setFrame(frame + 1); });
  $('replay-replay').addEventListener('click', startReplay);
  $('replay-finish').addEventListener('click', () => finish(true));
  $('replay-auto').addEventListener('change', () => {
    if (!$('replay-auto').checked) { pause(); renderReplay(); }
    else if (state && frame < lastFrame() && shouldAutoPlay(state.operation.trace.events.length, motion.matches, true)) { running = true; renderReplay(); schedule(); }
  });
  $('replay-speed').addEventListener('change', () => { cancelAnimations(); if (running) schedule(); });
  motion.addEventListener('change', () => { if (motion.matches) finish(); });
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawEdges()) : null;
  observer?.observe($('diagrams'));
  window.addEventListener('pagehide', () => {
    hidden = true;
    pause();
    cancelAnimations();
    clearTimeout(requestTimer);
    requestController?.abort();
    connected = false;
    observer?.disconnect();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { hidden = false; observer?.observe($('diagrams')); void requestState(); }
  });
  updateControls();
  void requestState();
}

if (typeof document !== 'undefined') initializeApp();
if (typeof module !== 'undefined') module.exports = { trimSongText, textProblem, pointer, validateState, createProjection, applyEvent, projectTrace, eventLabel, shouldAutoPlay, TRACE_LIMIT, AUTO_LIMIT };
