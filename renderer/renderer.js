'use strict';

const api = window.bitstream;
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Builds DOM with textContent only, so file names from a torrent can never inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'tip') { el.dataset.tip = v; el.setAttribute('aria-label', v); }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => { if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
  return el;
}

const ICONS = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
  pauseSm: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3zM3 10h18l-1.6 7.2a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><path d="M5 4h6v5H5zM13 15h6v5h-6zM13 9h6v5h-6zM8 9v9.5h5M8 11.5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.7 6.7 0 0 0 9.7 9.7z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>'
};
const icon = (name, cls = '') => { const s = h('span', { class: ('ico ' + cls).trim() }); s.innerHTML = ICONS[name]; return s; };

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}
function formatEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return Math.ceil(sec) + 's';
  if (sec < 3600) return Math.ceil(sec / 60) + ' min';
  const hrs = Math.floor(sec / 3600), min = Math.round((sec % 3600) / 60);
  return hrs + ' h ' + min + ' min';
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------------------------------------------------------------------------
// File tree (used in the add dialog and inside each download)
// ---------------------------------------------------------------------------

const EXT = {
  video: 'mp4 mkv mov avi wmv flv webm m4v mpg mpeg ts',
  audio: 'mp3 flac wav aac ogg m4a opus wma',
  image: 'jpg jpeg png gif webp bmp svg tif tiff heic ico',
  archive: 'zip rar 7z tar gz bz2 xz iso dmg',
  code: 'c cpp h hpp cs java js ts py rb go rs php html css json xml sh bat swift kt',
  doc: 'pdf doc docx txt md rtf odt xls xlsx ppt pptx csv epub srt nfo'
};
const KIND_BY_EXT = {};
for (const [kind, list] of Object.entries(EXT)) list.split(' ').forEach(e => { KIND_BY_EXT[e] = kind; });
const kindOf = name => KIND_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || 'other';

function buildTree(files, isMulti, rootName) {
  const root = { name: rootName, dir: true, children: new Map(), size: 0, count: 0, idx: [] };
  for (const f of files) {
    const segs = isMulti ? f.segments : [f.segments[f.segments.length - 1]];
    const trail = [root];
    let node = root;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) {
        node.children.set(seg + '\0f', { name: seg, dir: false, size: f.length, index: f.index });
      } else {
        let c = node.children.get(seg + '\0d');
        if (!c) { c = { name: seg, dir: true, children: new Map(), size: 0, count: 0, idx: [] }; node.children.set(seg + '\0d', c); }
        node = c;
        trail.push(c);
      }
    });
    trail.forEach(n => { n.size += f.length; n.count += 1; n.idx.push(f.index); });
  }
  return root;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// The tree works in three modes, driven by `ctx`:
//   no ctx             plain preview
//   ctx.selectable     add dialog: checkboxes on files and folders (folders are tri-state)
//   otherwise          a running/finished download: green tick on finished files, and files the
//                      user skipped are dimmed
// ctx = { sizes, sel: Set of selected indices (null = all), done: Set, completed, selectable,
//         onSelect, rows: Map(index -> update fn), dirs: [update fns] }
function newTreeCtx({ files, done = [], completed = false, selected = null, selectable = false, onSelect = null }) {
  const ctx = {
    sizes: new Map(files.map(f => [f.index, f.length])),
    sel: selected ? new Set(selected) : null,
    done: new Set(done),
    completed, selectable, onSelect,
    rows: new Map(), dirs: []
  };
  ctx.isSel = i => !ctx.sel || ctx.sel.has(i);
  ctx.isDone = i => ctx.isSel(i) && (ctx.completed || ctx.done.has(i));
  return ctx;
}

function refreshTree(ctx) {
  ctx.rows.forEach(update => update());
  ctx.dirs.forEach(update => update());
}

function selectionChanged(ctx) {
  refreshTree(ctx);
  if (ctx.onSelect) ctx.onSelect();
}

function fileRow(node, ctx) {
  const kind = kindOf(node.name);
  const ic = icon('file', 'kind k-' + kind);
  const box = ctx && ctx.selectable
    ? h('input', { type: 'checkbox', class: 'sel', 'aria-label': 'Download ' + node.name })
    : null;
  const row = h('div', { class: 'row' },
    h('span', { class: 'chev-spacer' }),
    box,
    ic,
    h('span', { class: 'fname', text: node.name, title: node.name }),
    h('span', { class: 'fsize', text: formatBytes(node.size) }));

  if (ctx) {
    const update = () => {
      const selected = ctx.isSel(node.index);
      if (box) { box.checked = selected; return; }
      const done = ctx.isDone(node.index);
      ic.innerHTML = ICONS[done ? 'check' : 'file'];
      ic.className = 'ico kind ' + (done ? 'k-done' : 'k-' + kind);
      row.classList.toggle('skipped', !selected);
      if (done) ic.dataset.tip = 'Downloaded';
      else if (!selected) ic.dataset.tip = 'Skipped - not being downloaded';
      else delete ic.dataset.tip;
    };
    ctx.rows.set(node.index, update);
    update();
    if (box) box.addEventListener('change', () => {
      if (box.checked) ctx.sel.add(node.index); else ctx.sel.delete(node.index);
      selectionChanged(ctx);
    });
  }
  return row;
}

// Folder contents are created the first time the folder is opened, so a torrent with
// thousands of files doesn't create thousands of DOM nodes up front.
function dirRow(node, open, ctx) {
  const body = h('div', { class: 'children' });
  const meta = h('span', { class: 'fsize' });
  const box = ctx && ctx.selectable
    ? h('input', { type: 'checkbox', class: 'sel', 'aria-label': 'Download everything in ' + node.name })
    : null;
  const noun = n => (n === 1 ? 'file' : 'files');

  const setMeta = () => {
    if (!ctx) { meta.textContent = `${node.count} ${noun(node.count)} - ${formatBytes(node.size)}`; return; }
    let selCount = 0, selSize = 0, done = 0;
    for (const i of node.idx) {
      if (!ctx.isSel(i)) continue;
      selCount++;
      selSize += ctx.sizes.get(i) || 0;
      if (ctx.isDone(i)) done++;
    }
    if (box) {
      box.checked = selCount === node.count;
      box.indeterminate = selCount > 0 && selCount < node.count;
      meta.textContent = `${selCount} of ${node.count} selected - ${formatBytes(selSize)}`;
    } else if (selCount === 0) {
      meta.textContent = 'Skipped';
    } else {
      meta.textContent = `${done} of ${selCount} ${noun(selCount)} - ${formatBytes(selSize)}`;
      meta.classList.toggle('all-done', done === selCount);
    }
  };
  setMeta();
  if (ctx) ctx.dirs.push(setMeta);

  if (box) box.addEventListener('change', () => {
    const allSelected = node.idx.every(i => ctx.sel.has(i));
    node.idx.forEach(i => (allSelected ? ctx.sel.delete(i) : ctx.sel.add(i)));
    selectionChanged(ctx);
  });

  const d = h('details', {},
    h('summary', { class: 'row' },
      icon('chev', 'chev'),
      box,
      icon('folder', 'kind k-folder'),
      h('span', { class: 'fname', text: node.name, title: node.name }),
      meta),
    body);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const kids = [...node.children.values()];
    kids.filter(k => k.dir).sort(byName).forEach(k => body.append(dirRow(k, false, ctx)));
    kids.filter(k => !k.dir).sort(byName).forEach(k => body.append(fileRow(k, ctx)));
    if (ctx) refreshTree(ctx); // rows created lazily must reflect the current state
  };
  d.addEventListener('toggle', () => { if (d.open) fill(); });
  if (open) { d.open = true; fill(); }
  return d;
}

function renderTree(info, ctx = null) {
  const root = buildTree(info.files, info.isMulti, info.name);
  const wrap = h('div', { class: 'tree' });
  if (!info.isMulti) wrap.append(fileRow([...root.children.values()][0], ctx));
  else wrap.append(dirRow(root, true, ctx));
  return wrap;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const FILTERS = [
  { key: 'all',         label: 'All',         title: 'All downloads', icon: 'list',  test: () => true },
  { key: 'downloading', label: 'Downloading', title: 'Downloading',   icon: 'down',  test: d => d.state === 'downloading' },
  { key: 'completed',   label: 'Completed',   title: 'Completed',     icon: 'check', test: d => d.state === 'completed' },
  { key: 'paused',      label: 'Paused',      title: 'Paused',        icon: 'pause', test: d => d.state === 'paused' }
];
const EMPTY = {
  all:         ['No downloads yet', 'Add a torrent file to start downloading.'],
  downloading: ['Nothing downloading', 'Downloads in progress will show up here.'],
  completed:   ['No completed downloads', 'Finished downloads will show up here.'],
  paused:      ['Nothing paused', 'Downloads you pause will show up here.']
};

const state = { downloads: new Map(), selectedId: null, dockTab: null, filter: 'all', settings: { theme: 'system', lastFolder: null }, defaultFolder: '' };
const cards = new Map();   // id -> { el, refs }
const speeds = new Map();  // id -> { samples, speed }

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const navCounts = {};
const NAV_TIPS = {
  all: 'Show all downloads',
  downloading: 'Show downloads in progress',
  completed: 'Show finished downloads',
  paused: 'Show paused downloads'
};

function buildNav() {
  const nav = $('nav');
  FILTERS.forEach(f => {
    const count = h('span', { class: 'count' });
    navCounts[f.key] = count;
    nav.append(h('button', {
      class: 'nav-item', 'data-key': f.key, tip: NAV_TIPS[f.key], onclick: () => setFilter(f.key)
    }, icon(f.icon), h('span', { class: 'label', text: f.label }), count));
  });
}

function updateNav() {
  const all = [...state.downloads.values()];
  FILTERS.forEach(f => { navCounts[f.key].textContent = `(${all.filter(f.test).length})`; });
  document.querySelectorAll('.nav-item').forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.key === state.filter)));
}

function buildTheme() {
  const modes = [['system', 'monitor', 'Match system theme'], ['light', 'sun', 'Light theme'], ['dark', 'moon', 'Dark theme']];
  const box = $('theme');
  modes.forEach(([mode, ic, label]) => {
    box.append(h('button', {
      'data-mode': mode, tip: label,
      onclick: () => { state.settings.theme = mode; api.setTheme(mode); markTheme(); }
    }, icon(ic)));
  });
  markTheme();
}
function markTheme() {
  document.querySelectorAll('#theme button').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.settings.theme)));
}

// ---------------------------------------------------------------------------
// Download cards
// ---------------------------------------------------------------------------

const STATE_LABEL = { downloading: 'Downloading', paused: 'Paused', completed: 'Completed', error: 'Error' };

function createCard(d) {
  const r = {};
  r.toggle = h('button', { class: 'icon-btn', onclick: () => {
    const cur = state.downloads.get(d.id);
    if (cur.state === 'downloading') api.pause(d.id); else resumeDownload(d.id);
  } });
  r.folderBtn = h('button', { class: 'icon-btn', tip: 'Show in folder', onclick: () => api.openFolder(d.id) }, icon('folderOpen'));
  r.filesBtn = h('button', { class: 'icon-btn', tip: 'Show files', onclick: () => toggleFiles(d.id) }, icon('tree'));
  r.removeBtn = h('button', { class: 'icon-btn danger', tip: 'Remove from list', onclick: () => confirmRemove(d.id) }, icon('trash'));

  r.glyph = h('span', { class: 'glyph' });
  r.name = h('div', { class: 'name' });
  r.sub = h('div', { class: 'sub' });
  r.badge = h('span', { class: 'badge' });
  r.fill = h('div', { class: 'fill' });
  r.pct = h('span', { class: 'pct' });
  r.detail = h('span', { class: 'detail' });
  r.files = h('div', { class: 'files', hidden: true });

  const el = h('article', { class: 'card' },
    h('div', { class: 'card-top' },
      r.glyph,
      h('div', { class: 'card-title' }, r.name, r.sub),
      r.badge,
      h('div', { class: 'actions' }, r.toggle, r.folderBtn, r.filesBtn, r.removeBtn)),
    h('div', { class: 'bar' }, r.fill),
    h('div', { class: 'stats' }, r.pct, r.detail),
    r.files);

  el.addEventListener('click', e => { if (!e.target.closest('button')) selectDownload(d.id); });
  const c = { el, r, glyphKind: null, toggleIcon: null };
  cards.set(d.id, c);
  return c;
}

async function toggleFiles(id) {
  const c = cards.get(id);
  const box = c.r.files;
  const setTip = text => { c.r.filesBtn.dataset.tip = text; c.r.filesBtn.setAttribute('aria-label', text); };
  if (!box.hidden) { box.hidden = true; setTip('Show files'); return; }
  if (!box.firstChild) {
    const info = await api.getFiles(id);
    if (!info) { toast('Could not read the file list.'); return; }
    c.ctx = newTreeCtx({ files: info.files, done: info.done || [], selected: info.selected,
      completed: state.downloads.get(id).state === 'completed' });
    box.append(renderTree(info, c.ctx));
  }
  box.hidden = false;
  setTip('Hide files');
}

function updateCard(d) {
  const c = cards.get(d.id) || createCard(d);
  const r = c.r;
  const done = d.totalBytes * d.percent / 100;

  c.el.className = 'card is-' + d.state + (state.selectedId === d.id ? ' selected' : '');
  r.name.textContent = d.name;
  r.name.title = d.name;
  const part = d.fileCount && d.selectedCount && d.selectedCount < d.fileCount
    ? ` (${d.selectedCount} of ${d.fileCount} files)` : '';
  r.sub.textContent = `${formatBytes(d.totalBytes)}${part}  -  ${d.folder}`;
  r.badge.textContent = STATE_LABEL[d.state] || d.state;
  r.badge.className = 'badge ' + d.state;
  r.fill.style.width = d.percent.toFixed(2) + '%';
  r.pct.textContent = d.percent.toFixed(1) + '%';

  const kind = d.isMulti ? 'folder' : kindOf(d.name);
  if (c.glyphKind !== kind) {
    c.glyphKind = kind;
    r.glyph.replaceChildren(icon(d.isMulti ? 'folder' : 'file'));
  }

  // Pause / resume / retry button
  const want = d.state === 'downloading' ? 'pauseSm' : 'play';
  const label = d.state === 'downloading' ? 'Pause download' : (d.state === 'error' ? 'Retry download' : 'Resume download');
  r.toggle.hidden = d.state === 'completed';
  if (c.toggleIcon !== want) {
    c.toggleIcon = want;
    r.toggle.replaceChildren(icon(want));
  }
  r.toggle.dataset.tip = label;
  r.toggle.setAttribute('aria-label', label);

  // Detail line
  const sp = speeds.get(d.id);
  let text = '';
  if (d.state === 'downloading') {
    if (d.status && d.status !== 'Downloading') {
      text = d.status;
    } else {
      const parts = [`${formatBytes(done)} of ${formatBytes(d.totalBytes)}`];
      if (sp && sp.speed > 0) {
        parts.push(formatBytes(sp.speed) + '/s');
        const eta = formatEta((d.totalBytes - done) / sp.speed);
        if (eta) parts.push(eta + ' left');
      }
      parts.push(`${d.peers} ${d.peers === 1 ? 'peer' : 'peers'}`);
      text = parts.join('  -  ');
    }
  } else if (d.state === 'paused') {
    text = d.percent > 0 ? `${formatBytes(done)} of ${formatBytes(d.totalBytes)}` : 'Not started';
  } else if (d.state === 'completed') {
    text = formatBytes(d.totalBytes);
  } else {
    text = d.error || 'Something went wrong.';
  }
  r.detail.textContent = text;
}

function updateTotalSpeed() {
  let total = 0;
  state.downloads.forEach(d => { if (d.state === 'downloading') total += (speeds.get(d.id) || {}).speed || 0; });
  $('totalSpeed').textContent = total > 0 ? formatBytes(total) + '/s' : '';
}

// ---------------------------------------------------------------------------
// List + filter
// ---------------------------------------------------------------------------

function setFilter(key) {
  state.filter = key;
  renderList();
}

function renderList() {
  hideTip();
  const f = FILTERS.find(x => x.key === state.filter);
  $('title').textContent = f.title;

  const items = [...state.downloads.values()].filter(f.test).sort((a, b) => b.addedAt - a.addedAt);
  items.forEach(updateCard);
  $('list').replaceChildren(...items.map(d => cards.get(d.id).el));

  const empty = $('empty');
  $('list').hidden = items.length === 0;
  empty.hidden = items.length !== 0;
  if (items.length === 0) {
    const [title, text] = EMPTY[state.filter];
    empty.replaceChildren(
      h('div', { class: 'big' }, icon('down')),
      h('h2', { text: title }),
      h('p', { text }),
      state.filter === 'all' ? h('button', { class: 'btn', onclick: () => startAdd() }, icon('plus'), 'Add torrent') : null);
  }
  updateNav();
  updateTotalSpeed();
}

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

const dlg = $('dlg');

async function startAdd(droppedPath) {
  const p = droppedPath || await api.pickTorrent();
  if (!p) return;
  const res = await api.parseTorrent(p);
  if (res.error) { toast(res.error); return; }
  openAddDialog(p, res.meta, res.duplicate);
}

function openAddDialog(torrentPath, meta, duplicate) {
  let folder = state.settings.lastFolder || state.defaultFolder;
  let free = null; // free bytes on the destination drive (null = unknown)
  const nFiles = meta.files.length;
  const allIdx = meta.files.map(f => f.index);
  const selectable = meta.isMulti && nFiles > 1; // nothing to choose in a single-file torrent

  const ctx = newTreeCtx({ files: meta.files, selected: allIdx, selectable, onSelect: update });
  const summary = h('div', { class: 'meta' });
  const pathEl = h('span', { class: 'path', text: folder, title: folder });
  const spaceEl = h('div', { class: 'dlg-space' });
  const start = h('button', { class: 'btn' }, 'Start download');

  const neededBytes = () => { let n = 0; ctx.sel.forEach(i => { n += ctx.sizes.get(i) || 0; }); return n; };

  function update() {
    let n = 0, bytes = 0;
    ctx.sel.forEach(i => { n++; bytes += ctx.sizes.get(i) || 0; });
    summary.textContent = selectable
      ? `${n} of ${nFiles} files selected  -  ${formatBytes(bytes)}`
      : `${formatBytes(meta.totalBytes)}  -  ${nFiles} ${nFiles === 1 ? 'file' : 'files'}`;
    start.disabled = duplicate || n === 0;
    start.textContent = selectable && n > 0 && n < nFiles ? `Download ${n} ${n === 1 ? 'file' : 'files'}` : 'Start download';

    // free space on the chosen drive, in red when this download won't fit
    if (free === null) {
      spaceEl.textContent = '';
      spaceEl.classList.remove('low');
    } else {
      const low = bytes > free;
      spaceEl.textContent = `Free space on this drive: ${formatBytes(free)}` + (low ? '  -  not enough for this download' : '');
      spaceEl.classList.toggle('low', low);
    }
  }

  async function refreshSpace() {
    const space = await api.diskSpace(folder);
    free = space ? space.free : null;
    update();
  }

  start.addEventListener('click', async () => {
    start.disabled = true;

    // look again right now - the number on screen may be out of date
    const space = await api.diskSpace(folder);
    if (space) {
      free = space.free;
      const needed = neededBytes();
      if (needed > free && !(await confirmLowSpace({ needed, free, folder }))) {
        update(); // back to the dialog, nothing started
        return;
      }
    }

    // null = everything, so a normal full download is stored exactly as before
    const selected = ctx.sel.size === nFiles ? null : [...ctx.sel].sort((a, b) => a - b);
    const res = await api.add(torrentPath, folder, selected);
    if (res.error) { toast(res.error); update(); return; }
    state.settings.lastFolder = folder;
    dlg.close();
    setFilter('downloading');
  });

  const setAll = on => {
    ctx.sel.clear();
    if (on) allIdx.forEach(i => ctx.sel.add(i));
    selectionChanged(ctx);
  };

  dlg.replaceChildren(h('div', { class: 'dlg' },
    h('div', { class: 'dlg-head' },
      h('div', { class: 'eyebrow', text: 'Add torrent' }),
      h('h2', { text: meta.name }),
      summary),
    duplicate ? h('div', { class: 'dlg-warn', text: 'This torrent is already in your list.' }) : null,
    selectable ? h('div', { class: 'dlg-bulk' },
      h('span', { class: 'hint', text: 'Choose the files to download' }),
      h('button', { class: 'link', onclick: () => setAll(true) }, 'Select all'),
      h('button', { class: 'link', onclick: () => setAll(false) }, 'Deselect all')) : null,
    h('div', { class: 'dlg-tree' }, renderTree(meta, ctx)),
    h('div', { class: 'dlg-dest' },
      h('span', { class: 'lbl', text: 'Save to' }), pathEl,
      h('button', { class: 'btn ghost', onclick: async () => {
        const f = await api.pickFolder(folder);
        if (f) { folder = f; pathEl.textContent = f; pathEl.title = f; refreshSpace(); }
      } }, 'Change')),
    spaceEl,
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
      start)));
  update();
  refreshSpace();
  dlg.showModal();
}

// Resolves true if the user wants to go ahead even though the drive is too full.
function confirmLowSpace({ needed, free, folder }) {
  return new Promise(resolve => {
    let answer = false;
    const cancel = h('button', { class: 'btn ghost', autofocus: true, onclick: () => confirmDlg.close() }, 'Cancel');
    const go = h('button', { class: 'btn danger', onclick: () => { answer = true; confirmDlg.close(); } }, 'Download anyway');

    confirmDlg.replaceChildren(h('div', { class: 'dlg' },
      h('div', { class: 'dlg-head' },
        h('h2', { text: 'Not enough disk space' }),
        h('p', { class: 'msg' }, 'Are you sure you want to download? Your current free space is lower than this download.')),
      h('div', { class: 'space-facts' },
        h('div', {}, h('span', { text: 'Needed' }), h('strong', { text: formatBytes(needed) })),
        h('div', {}, h('span', { text: 'Free' }), h('strong', { class: 'low', text: formatBytes(free) })),
        h('div', {}, h('span', { text: 'Short by' }), h('strong', { class: 'low', text: formatBytes(needed - free) })),
        h('div', { class: 'where' }, h('span', { text: 'Drive of' }), h('strong', { text: folder }))),
      h('div', { class: 'dlg-foot' }, cancel, go)));
    confirmDlg.addEventListener('close', () => resolve(answer), { once: true });
    confirmDlg.showModal();
  });
}

// Pressing resume / retry: warn first if what is still missing won't fit on the drive.
async function resumeDownload(id) {
  const d = state.downloads.get(id);
  if (!d) return;
  const needed = Math.max(0, d.totalBytes * (1 - d.percent / 100));
  const space = await api.diskSpace(d.folder);
  if (space && needed > space.free && !(await confirmLowSpace({ needed, free: space.free, folder: d.folder }))) return;
  api.resume(id);
}

// ---------------------------------------------------------------------------
// Tooltips: any element with data-tip gets one. One shared element, positioned with
// fixed coordinates so scrolling lists can never clip it.
// ---------------------------------------------------------------------------

const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
document.body.append(tip);
let tipTimer = null;
let tipTarget = null;

function showTip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  tip.textContent = text;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));
  let y = r.bottom + 8;
  if (y + t.height > window.innerHeight - 8) y = r.top - t.height - 8; // not enough room below
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
  tipTarget = null;
}
document.addEventListener('mouseover', e => {
  const el = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (el === tipTarget) return;
  hideTip();
  if (!el) return;
  tipTarget = el;
  tipTimer = setTimeout(() => showTip(el), 350);
});
document.addEventListener('mouseout', e => { if (!e.relatedTarget) hideTip(); });
document.addEventListener('mousedown', hideTip);
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', hideTip);
document.addEventListener('focusin', e => {
  if (e.target.matches && e.target.matches('[data-tip]:focus-visible')) { hideTip(); tipTarget = e.target; showTip(e.target); }
});
document.addEventListener('focusout', hideTip);

// ---------------------------------------------------------------------------
// Remove confirmation
// ---------------------------------------------------------------------------

const confirmDlg = $('confirm');

function confirmRemove(id) {
  const d = state.downloads.get(id);
  if (!d) return;

  const check = h('input', { type: 'checkbox' }); // unchecked by default
  const warn = h('div', { class: 'dlg-warn', hidden: true,
    text: 'The downloaded files will be permanently deleted from your computer.' });
  check.addEventListener('change', () => { warn.hidden = !check.checked; });

  const cancel = h('button', { class: 'btn ghost', autofocus: true, onclick: () => confirmDlg.close() }, 'Cancel');
  const remove = h('button', { class: 'btn danger' }, 'Remove');
  remove.addEventListener('click', async () => {
    const deleteFiles = check.checked;
    remove.disabled = cancel.disabled = check.disabled = true;
    remove.textContent = 'Removing...';
    const res = await api.remove(id, deleteFiles);
    confirmDlg.close();
    if (res && res.failed) toast(`Removed, but ${res.failed} ${res.failed === 1 ? 'file' : 'files'} could not be deleted.`);
  });

  confirmDlg.replaceChildren(h('div', { class: 'dlg' },
    h('div', { class: 'dlg-head' },
      h('h2', { text: 'Remove torrent' }),
      h('p', { class: 'msg' }, 'Are you sure you want to remove \'', h('strong', { text: d.name }), '\' from the list?')),
    h('label', { class: 'check' }, check, h('span', { text: 'Also remove the content files' })),
    warn,
    h('div', { class: 'dlg-foot' }, cancel, remove)));
  confirmDlg.showModal();
}
confirmDlg.addEventListener('click', e => { if (e.target === confirmDlg) confirmDlg.close(); });

// ---------------------------------------------------------------------------
// Bottom dock: General / Trackers / Peers / Content / Log
// Click a tab to open the panel, click the same tab again to close it.
// The panel always shows the selected download (click a card to select it).
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'general',  label: 'General',  tip: 'Transfer statistics and torrent details' },
  { key: 'trackers', label: 'Trackers', tip: 'Trackers, DHT and PeX status' },
  { key: 'peers',    label: 'Peers',    tip: 'Peers you are connected to' },
  { key: 'content',  label: 'Content',  tip: 'Files in this torrent' },
  { key: 'log',      label: 'Log',      tip: 'Everything the engine prints' }
];
const BUILDERS = {};
let dockView = null;          // the tab currently on screen: { key, id, el, update?, onDetail?, onLog?, onFiles?, onState? }
const metaCache = new Map();  // id -> facts stored in the .torrent file

function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}
const formatClock = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '-');
const formatDate = ts => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const selectedDownload = () => state.downloads.get(state.selectedId) || null;

function firstVisibleId() {
  const f = FILTERS.find(x => x.key === state.filter);
  const items = [...state.downloads.values()].filter(f.test).sort((a, b) => b.addedAt - a.addedAt);
  const any = items[0] || [...state.downloads.values()][0];
  return any ? any.id : null;
}

function markSelected() {
  cards.forEach((c, id) => c.el.classList.toggle('selected', id === state.selectedId));
}

function selectDownload(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  markSelected();
  if (state.dockTab) renderDock();
}

function buildDock() {
  const bar = $('dockTabs');
  TABS.forEach(t => bar.append(h('button', {
    class: 'dock-tab', role: 'tab', 'data-key': t.key, tip: t.tip, 'aria-selected': 'false',
    onclick: () => toggleTab(t.key)
  }, t.label)));
  bar.append(h('span', { id: 'dockTitle', class: 'dock-title' }));

  let saved = 0;
  try { saved = Number(localStorage.getItem('dockHeight')) || 0; } catch (e) {}
  setDockHeight(saved || 280);

  // drag the top edge to resize
  const grip = $('dockResize');
  grip.addEventListener('pointerdown', e => {
    const startY = e.clientY, startH = $('dockBody').offsetHeight;
    grip.setPointerCapture(e.pointerId);
    const move = ev => setDockHeight(startH + (startY - ev.clientY));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try { localStorage.setItem('dockHeight', String($('dockBody').offsetHeight)); } catch (e2) {}
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', () => setDockHeight($('dockBody').offsetHeight || 280));
}

function setDockHeight(px) {
  const max = Math.max(160, window.innerHeight - 76 - 40 - 140); // keep the download list visible
  $('dockBody').style.height = Math.max(140, Math.min(px, max)) + 'px';
}

function toggleTab(key) {
  if (state.dockTab === key) { // same tab again: close
    state.dockTab = null;
    dockView = null;
    $('dockBody').hidden = true;
    $('dockResize').hidden = true;
    syncTabs();
    return;
  }
  state.dockTab = key;
  if (!selectedDownload()) { state.selectedId = firstVisibleId(); markSelected(); }
  $('dockBody').hidden = false;
  $('dockResize').hidden = false;
  renderDock();
}

function syncTabs() {
  document.querySelectorAll('.dock-tab').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.key === state.dockTab)));
}

function renderDock() {
  syncTabs();
  const d = selectedDownload();
  $('dockTitle').textContent = d ? d.name : '';
  $('dockTitle').title = d ? d.name : '';
  dockView = null;
  if (!state.dockTab) return;

  const body = $('dockBody');
  body.replaceChildren();
  if (!d) {
    body.append(h('div', { class: 'dock-empty', text: state.downloads.size
      ? 'Click a download above to see its details.'
      : 'Add a torrent to see its details here.' }));
    return;
  }
  const view = BUILDERS[state.dockTab](d);
  view.key = state.dockTab;
  view.id = d.id;
  dockView = view;
  body.append(view.el);
  if (view.update) view.update(d);
}

// ----- General -----
BUILDERS.general = function (d) {
  const v = {};
  const row = (key, label) => h('div', { class: 'kv-row' },
    h('span', { class: 'k', text: label }), (v[key] = h('span', { class: 'v' })));
  const fill = h('div', { class: 'fill' });
  let meta = metaCache.get(d.id) || null;

  const el = h('div', { class: 'pane general' },
    h('div', { class: 'g-progress' },
      (v.pct = h('span', { class: 'gpct' })),
      h('div', { class: 'bar thin' }, fill),
      (v.status = h('span', { class: 'gstatus' }))),
    h('div', { class: 'cols' },
      h('section', { class: 'kv' }, h('h3', { text: 'Transfer' }),
        row('active', 'Time active'), row('eta', 'ETA'), row('conn', 'Connections'),
        row('down', 'Downloaded'), row('up', 'Uploaded'), row('speed', 'Download speed'),
        row('upspeed', 'Upload speed'), row('seeds', 'Seeds'), row('peers', 'Peers'),
        row('wasted', 'Wasted'), row('ratio', 'Share ratio'), row('remaining', 'Remaining')),
      h('section', { class: 'kv' }, h('h3', { text: 'Information' }),
        row('size', 'Total size'), row('pieces', 'Pieces'), row('files', 'Files'),
        row('path', 'Save path'), row('added', 'Added on'), row('completed', 'Completed on'),
        row('hash', 'Info hash'), row('creator', 'Created by'), row('created', 'Created on'),
        row('private', 'Private'), row('comment', 'Comment'))));

  const set = (k, text) => { if (v[k].textContent !== text) v[k].textContent = text; };

  function update(cur) {
    const downloading = cur.state === 'downloading';
    const speed = downloading ? cur.speed : 0;
    const secs = (cur.activeSeconds || 0) + (cur.activeSince ? (Date.now() - cur.activeSince) / 1000 : 0);
    const remaining = Math.max(0, cur.totalBytes * (1 - cur.percent / 100));

    fill.style.width = cur.percent.toFixed(2) + '%';
    set('pct', cur.percent.toFixed(1) + '%');
    set('status', cur.state === 'error' ? (cur.error || 'Error') : (cur.status || STATE_LABEL[cur.state] || ''));

    set('active', formatDuration(secs));
    set('eta', cur.state === 'completed' ? '-' : (speed > 0 ? formatEta(remaining / speed) : (downloading ? '\u221e' : '-')));
    set('conn', downloading ? `${cur.connected} (${cur.maxConnections || 30} max)` : '0');
    set('down', `${formatBytes(cur.downloaded)} (${formatBytes(cur.sessionDownloaded)} this session)`);
    set('up', '0 B');
    set('speed', `${formatBytes(speed)}/s` + (secs > 1 && cur.downloaded ? ` (avg. ${formatBytes(cur.downloaded / secs)}/s)` : ''));
    set('upspeed', '0 B/s');
    set('seeds', downloading ? `${cur.seedsConnected} (${cur.seeders == null ? '-' : cur.seeders} in swarm)` : '-');
    set('peers', downloading ? `${cur.peersConnected} (${cur.leechers == null ? '-' : cur.leechers} in swarm)` : '-');
    set('wasted', formatBytes(cur.wasted));
    set('ratio', '0.00');
    set('remaining', formatBytes(remaining));

    const partial = cur.fileCount && cur.selectedCount && cur.selectedCount < cur.fileCount;
    set('size', formatBytes(cur.totalBytes) + (partial ? ' (selected files only)' : ''));
    set('files', cur.fileCount ? (partial ? `${cur.selectedCount} of ${cur.fileCount} selected` : String(cur.fileCount)) : '-');
    set('path', cur.folder);
    set('added', formatDate(cur.addedAt));
    set('completed', cur.completedAt ? formatDate(cur.completedAt) : '-');
    set('hash', cur.infoHash || '-');
    if (meta) {
      const have = cur.piecesTotal ? `${cur.piecesHave} of ${cur.piecesTotal} done` : '';
      set('pieces', `${meta.pieceCount} x ${formatBytes(meta.pieceLength)}` + (have ? ` (${have})` : ''));
      set('creator', meta.createdBy || '-');
      set('created', formatDate(meta.creationDate));
      set('private', meta.isPrivate ? 'Yes' : 'No');
      set('comment', meta.comment || '-');
    } else {
      ['pieces', 'creator', 'created', 'private', 'comment'].forEach(k => set(k, '-'));
    }
  }

  const view = { el, update };
  if (!meta) {
    api.getMeta(d.id).then(m => {
      if (!m) return;
      metaCache.set(d.id, m);
      meta = m;
      const cur = state.downloads.get(d.id);
      if (dockView === view && cur) update(cur);
    });
  }
  return view;
};

// ----- shared bits for the tables -----
const td = (text, cls = '') => h('td', { class: cls, text: text == null ? '-' : String(text) });
const th = text => h('th', { text });
function table(headers, tbody) {
  return h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...headers.map(th))), tbody);
}
function pill(status) {
  const kind = status === 'Working' || status === 'Downloading' ? 'ok'
    : status === 'Not working' || status === 'Choked' ? 'bad'
    : status === 'Updating' || status === 'Connecting' || status === 'Handshaking' ? 'busy' : '';
  return h('span', { class: 'pill ' + kind, text: status });
}

// ----- Trackers -----
BUILDERS.trackers = function (d) {
  const tbody = h('tbody');
  const el = h('div', { class: 'pane' },
    table(['Tracker', 'Status', 'Seeds', 'Peers', 'Returned', 'Last announce', 'Next announce', 'Message'], tbody));

  function render(list) {
    if (!list.length) {
      tbody.replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colspan: '8', text: 'No tracker information yet.' })));
      return;
    }
    const now = Date.now();
    tbody.replaceChildren(...list.map(r => h('tr', {},
      h('td', { class: 'mono ell', text: r.url, title: r.url }),
      h('td', {}, pill(r.status)),
      td(r.seeds, 'num'), td(r.peers, 'num'), td(r.returned, 'num'),
      td(r.lastAnnounce ? formatClock(r.lastAnnounce) : '-'),
      td(r.nextAnnounce ? (r.nextAnnounce > now ? 'in ' + formatDuration((r.nextAnnounce - now) / 1000) : 'now') : '-'),
      h('td', { class: 'ell', text: r.message || '', title: r.message || '' }))));
  }

  const view = { el, onDetail: p => { if (p.trackers) render(p.trackers); } };
  api.getDetail(d.id).then(det => { if (dockView === view) render(det.trackers || []); });
  return view;
};

// ----- Peers -----
BUILDERS.peers = function (d) {
  const tbody = h('tbody');
  const el = h('div', { class: 'pane' },
    table(['Address', 'Client', 'Status', 'Progress', 'Down speed', 'Downloaded', 'Source'], tbody));

  function render(list) {
    if (!list.length) {
      const cur = state.downloads.get(d.id);
      const text = cur && cur.state === 'downloading' ? 'Looking for peers...' : 'Not connected - the download is not running.';
      tbody.replaceChildren(h('tr', {}, h('td', { class: 'empty-cell', colspan: '7', text })));
      return;
    }
    const sorted = [...list].sort((a, b) => (b.speed - a.speed) || (b.downloaded - a.downloaded));
    tbody.replaceChildren(...sorted.map(p => {
      const fill = h('span', { class: 'mini-fill' });
      fill.style.width = (p.progress * 100).toFixed(0) + '%';
      return h('tr', {},
        td(`${p.ip}:${p.port}`, 'mono'),
        h('td', { class: 'ell', text: p.client || 'Unknown', title: p.client || '' }),
        h('td', {}, pill(p.status)),
        h('td', {}, h('div', { class: 'prog' }, h('span', { class: 'mini' }, fill), h('span', { class: 'num', text: (p.progress * 100).toFixed(0) + '%' }))),
        td(p.speed > 1 ? formatBytes(p.speed) + '/s' : '-', 'num'),
        td(p.downloaded ? formatBytes(p.downloaded) : '-', 'num'),
        td(p.source));
    }));
  }

  const view = { el, onDetail: p => { if (p.peers) render(p.peers); } };
  api.getDetail(d.id).then(det => { if (dockView === view) render(det.peers || []); });
  return view;
};

// ----- Content: the same file tree, with a tick on each finished file -----
BUILDERS.content = function (d) {
  const el = h('div', { class: 'pane content' }, h('div', { class: 'dock-empty', text: 'Loading...' }));
  const view = { el };

  api.getFiles(d.id).then(info => {
    if (dockView !== view) return;
    if (!info) { el.replaceChildren(h('div', { class: 'dock-empty', text: 'Could not read the file list.' })); return; }
    const cur = state.downloads.get(d.id);
    view.ctx = newTreeCtx({
      files: info.files, done: info.done || [], selected: info.selected,
      completed: !!cur && cur.state === 'completed'
    });
    el.replaceChildren(renderTree(info, view.ctx));
  });

  view.onFiles = p => { if (view.ctx) applyFilesEvent(view.ctx, p); };
  view.onState = cur => { if (view.ctx) { view.ctx.completed = cur.state === 'completed'; refreshTree(view.ctx); } };
  return view;
};

// ----- Log -----
BUILDERS.log = function (d) {
  const MAX_LINES = 2000;
  const box = h('div', { class: 'logbox', tabindex: '0' });
  const count = h('span', { class: 'logcount' });
  const el = h('div', { class: 'pane logview' },
    h('div', { class: 'logbar' },
      count, h('span', { class: 'grow' }),
      h('button', { class: 'link', onclick: copy }, 'Copy'),
      h('button', { class: 'link', onclick: clear }, 'Clear')),
    box);

  let lastSeq = 0;

  const kind = l => {
    if (l.level === 'sys') return 'sys';
    if (l.level === 'warn' || /error|timeout|mismatch|fail|not working|no response/i.test(l.text)) return 'warn';
    if (/connected to|handshake ok|unchoked|done|recovered/i.test(l.text)) return 'ok';
    return '';
  };

  function append(lines) {
    const fresh = lines.filter(l => l.seq > lastSeq);
    if (!fresh.length) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    fresh.forEach(l => {
      lastSeq = l.seq;
      const line = h('div', { class: ('logline ' + kind(l)).trim() },
        h('span', { class: 'ts', text: formatClock(l.t) }), h('span', { class: 'tx', text: l.text }));
      line.dataset.raw = `[${formatClock(l.t)}] ${l.text}`;
      box.append(line);
    });
    while (box.childElementCount > MAX_LINES) box.firstChild.remove();
    count.textContent = `${box.childElementCount} lines`;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  async function copy() {
    const text = [...box.children].map(c => c.dataset.raw).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Log copied to the clipboard.'); }
    catch (e) { toast('Could not copy the log.'); }
  }
  function clear() {
    api.clearLog(d.id);
    box.replaceChildren();
    count.textContent = '0 lines';
  }

  const view = { el, onLog: p => append(p.lines) };
  api.getLog(d.id).then(lines => {
    if (dockView !== view) return;
    append(lines.slice(-MAX_LINES));
    box.scrollTop = box.scrollHeight;
  });
  count.textContent = '0 lines';
  return view;
};

// "Time active" ticks every second while the General tab is open
setInterval(() => {
  const cur = selectedDownload();
  if (dockView && dockView.key === 'general' && cur && cur.state === 'downloading') dockView.update(cur);
}, 1000);

// ---------------------------------------------------------------------------
// Events from the main process
// ---------------------------------------------------------------------------

api.onAdded(d => {
  state.downloads.set(d.id, d);
  state.selectedId = d.id; // the details panel follows the torrent you just added
  renderList();
  if (state.dockTab) renderDock();
});

api.onUpdate(p => {
  const d = state.downloads.get(p.id);
  if (!d) return;
  const prevState = d.state;
  Object.assign(d, p);

  if (d.state === 'downloading') speeds.set(d.id, { speed: d.speed || 0 }); // measured by the engine
  else speeds.delete(d.id);

  const card = cards.get(d.id);
  if (prevState !== d.state && card && card.ctx) {
    card.ctx.completed = d.state === 'completed'; // finished: tick every file
    refreshTree(card.ctx);
  }

  if (prevState !== d.state) renderList();
  else updateCard(d);
  updateTotalSpeed();

  if (dockView && dockView.id === d.id) {
    if (prevState !== d.state && dockView.onState) dockView.onState(d);
    if (dockView.update) dockView.update(d);
  }
});

// Applies a "files finished" event to a tree
function applyFilesEvent(ctx, p) {
  if (p.reset) {
    ctx.done = new Set(p.done);
    refreshTree(ctx);
    return;
  }
  p.done.forEach(i => { ctx.done.add(i); const update = ctx.rows.get(i); if (update) update(); });
  ctx.dirs.forEach(update => update());
}

// Files finishing while the download is still running
api.onFiles(p => {
  const card = cards.get(p.id);
  if (card && card.ctx) applyFilesEvent(card.ctx, p); // else: the tree asks for the full list when opened
  if (dockView && dockView.id === p.id && dockView.onFiles) dockView.onFiles(p);
});

api.onDetail(p => { if (dockView && dockView.id === p.id && dockView.onDetail) dockView.onDetail(p); });
api.onLog(p => { if (dockView && dockView.id === p.id && dockView.onLog) dockView.onLog(p); });

api.onRemoved(id => {
  state.downloads.delete(id);
  cards.delete(id);
  speeds.delete(id);
  metaCache.delete(id);
  if (state.selectedId === id) state.selectedId = null;
  renderList();
  if (state.dockTab) {
    if (!state.selectedId) { const next = firstVisibleId(); if (next) state.selectedId = next; }
    markSelected();
    renderDock();
  }
});

// ---------------------------------------------------------------------------
// Drag & drop, shortcuts
// ---------------------------------------------------------------------------

const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragover', e => { e.preventDefault(); if (hasFiles(e)) document.body.classList.add('dropping'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.torrent')) { toast('Only .torrent files can be added.'); return; }
  startAdd(api.pathForFile(file));
});
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); startAdd(); }
});
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // click on the backdrop

$('add').append(icon('plus'));
$('add').dataset.tip = 'Add a torrent to download (Ctrl+O)';
$('add').addEventListener('click', () => startAdd());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  const s = await api.getState();
  state.settings = s.settings;
  state.defaultFolder = s.defaultFolder;
  s.downloads.forEach(d => state.downloads.set(d.id, d));
  buildNav();
  buildTheme();
  buildDock();
  renderList();
})();