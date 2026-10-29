'use strict';

const { app, BrowserWindow, ipcMain, dialog, utilityProcess, nativeTheme, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tp = require('./src/torrent-parser');

app.setName('BitStream');
if (process.platform === 'win32') app.setAppUserModelId('com.bitstream.app');

let win = null;

// Only one copy of the app at a time, otherwise two instances would overwrite each
// other's saved download list.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}
app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
});

// ---------------------------------------------------------------------------
// Persistent data: settings + the list of downloads (survives restarts)
// ---------------------------------------------------------------------------

const dbFile = () => path.join(app.getPath('userData'), 'bitstream-data.json');
const torrentsDir = () => path.join(app.getPath('userData'), 'torrents');

let db = { settings: { theme: 'system', lastFolder: null }, downloads: [] };
let saveTimer = null;

function loadDb() {
    try {
        const raw = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
        db.settings = { ...db.settings, ...(raw.settings || {}) };
        db.downloads = Array.isArray(raw.downloads) ? raw.downloads : [];
    } catch (e) { /* first run */ }

    // Nothing is running right after launch, so anything that was mid-download is paused.
    db.downloads.forEach(d => {
        if (d.state === 'downloading') d.state = 'paused';
        d.peers = 0;
        d.activeSince = null;
    });
}

function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 3000);
}

function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
        db.downloads.forEach(d => { const set = doneSets.get(d.id); if (set) d.doneFiles = [...set]; });
        const tmp = dbFile() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(db, (k, v) => (k === 'stats' || k.startsWith('_') ? undefined : v)));
        fs.renameSync(tmp, dbFile());
    } catch (e) {
        console.log('could not save data:', e.message);
    }
}

// What the UI gets to see (no internal file paths for the stored .torrent).
// Live numbers for a download (sent a few times a second while it runs).
const progressView = d => {
    const st = d.stats || {};
    return {
        id: d.id, state: d.state, status: d.status || '', percent: d.percent,
        peers: d.peers || 0, error: d.error || null,
        speed: st.speed || 0,
        connected: st.connected || 0, maxConnections: st.maxConnections || 0,
        sessionDownloaded: st.downloaded || 0,
        downloaded: d.downloaded || 0, wasted: d.wasted || 0,
        piecesHave: st.piecesHave || 0, piecesTotal: st.piecesTotal || 0,
        seedsConnected: st.seedsConnected || 0, peersConnected: st.peersConnected || 0,
        seeders: st.seeders == null ? null : st.seeders,
        leechers: st.leechers == null ? null : st.leechers,
        activeSeconds: d.activeSeconds || 0, activeSince: d.activeSince || null,
        completedAt: d.completedAt || null
    };
};

// What the UI gets to see (no internal file paths for the stored .torrent).
const view = d => ({
    name: d.name, isMulti: d.isMulti, totalBytes: d.totalBytes, folder: d.folder,
    fileCount: d.fileCount || 0, selectedCount: d.selectedCount || 0,
    addedAt: d.addedAt, infoHash: d.infoHash,
    ...progressView(d)
});

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Torrent helpers
// ---------------------------------------------------------------------------

function parseTorrent(filePath) {
    const t = tp.open(filePath);
    const info = t.info;
    const name = info.name.toString('utf8');
    const isMulti = !!info.files;
    const files = isMulti
        ? info.files.map((f, index) => ({ index, segments: f.path.map(s => s.toString('utf8')), length: f.length }))
        : [{ index: 0, segments: [name], length: info.length }];
    return {
        name, isMulti, files,
        totalBytes: files.reduce((sum, f) => sum + f.length, 0),
        infoHash: tp.infoHash(t).toString('hex')
    };
}

// Extra facts stored in the .torrent file itself (shown in the General tab).
function readTorrentMeta(file) {
    const t = tp.open(file);
    const info = t.info;
    const str = b => (b == null ? '' : Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
    return {
        infoHash: tp.infoHash(t).toString('hex'),
        pieceLength: info['piece length'],
        pieceCount: info.pieces.length / 20,
        comment: str(t.comment),
        createdBy: str(t['created by']),
        creationDate: typeof t['creation date'] === 'number' ? t['creation date'] * 1000 : null,
        isPrivate: info.private === 1,
        fileCount: info.files ? info.files.length : 1,
        totalBytes: Number(tp.size(t).readBigUInt64BE(0))
    };
}

// ---------------------------------------------------------------------------
// One utility process per active download
// ---------------------------------------------------------------------------

const workers = new Map(); // download id -> UtilityProcess

// Which files of each download are fully downloaded (indices in torrent order). Kept as Sets
// while running, and written back to the saved list as arrays.
const doneSets = new Map();
function doneSetFor(d) {
    if (!doneSets.has(d.id)) doneSets.set(d.id, new Set(d.doneFiles || []));
    return doneSets.get(d.id);
}
const find = id => db.downloads.find(d => d.id === id);

// Not saved to disk - this is what the Peers / Trackers / Log tabs show.
const live = new Map(); // id -> { peers: [...], trackers: [...] }
const logs = new Map(); // id -> [{ t, level, text }]  (newest last)
const MAX_LOG_LINES = 3000;

const logSeq = new Map(); // id -> last sequence number (lets the UI skip lines it already has)

function addLog(id, lines) {
    let arr = logs.get(id);
    if (!arr) { arr = []; logs.set(id, arr); }
    let seq = logSeq.get(id) || 0;
    lines.forEach(l => { l.seq = ++seq; });
    logSeq.set(id, seq);
    arr.push(...lines);
    if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
    send('download:log', { id, lines });
}

// Adds the time the engine just spent running to the download's total "time active".
function settleActive(d) {
    if (!d.activeSince) return;
    d.activeSeconds = (d.activeSeconds || 0) + (Date.now() - d.activeSince) / 1000;
    d.activeSince = null;
}

// Nobody is connected any more; keep the last tracker info so it can still be read.
function clearLive(d) {
    const prev = live.get(d.id) || {};
    live.set(d.id, { peers: [], trackers: prev.trackers || [] });
    send('download:detail', { id: d.id, peers: [] });
    d.stats = null;
}

function startDownload(d) {
    if (workers.has(d.id)) return;

    d.state = 'downloading';
    d.status = 'Starting...';
    d.error = null;
    d.peers = 0;
    d.activeSince = Date.now();
    d._sessDl = 0;
    d._sessWasted = 0;
    d.stats = null;
    addLog(d.id, [{ t: Date.now(), level: 'sys', text: '--- Download started ---' }]);

    const w = utilityProcess.fork(path.join(__dirname, 'src', 'worker.js'));
    workers.set(d.id, w);

    w.on('message', msg => onWorkerMessage(d, msg));
    w.on('exit', () => {
        if (workers.get(d.id) === w) workers.delete(d.id);
        settleActive(d);
        clearLive(d);
        if (d.state === 'downloading') {
            d.state = 'error';
            d.error = 'The download process stopped unexpectedly.';
            d.status = d.error;
            send('download:update', progressView(d));
            saveNow();
        }
    });

    w.postMessage({ type: 'start', torrentPath: d.torrentFile, folder: d.folder, selected: d.selected || null });
    send('download:update', progressView(d));
    saveNow();
}

// Resolves base + segments, but only if the result is strictly inside base. A hostile
// torrent can contain names like ".." - this makes sure we never touch anything outside
// the download folder.
function insideFolder(base, ...segments) {
    const root = path.resolve(base);
    const target = path.resolve(root, ...segments);
    return target !== root && target.startsWith(root + path.sep) ? target : null;
}

// Deletes exactly the files the torrent describes (not whatever else happens to sit in the
// folder), then removes any directories that are left empty.
async function deleteContent(d) {
    let meta;
    try { meta = parseTorrent(d.torrentFile); } catch (e) { return { failed: 1 }; }

    const root = insideFolder(d.folder, meta.name);
    if (!root) return { failed: 1 };

    let failed = 0;
    if (!meta.isMulti) {
        try { await fs.promises.rm(root, { force: true }); } catch (e) { failed++; }
        return { failed };
    }

    const dirs = new Set([root]);
    for (const f of meta.files) {
        const target = insideFolder(root, ...f.segments);
        if (!target) { failed++; continue; }
        try { await fs.promises.rm(target, { force: true }); } catch (e) { failed++; }
        let dir = path.dirname(target);
        while (dir !== root && dir.startsWith(root + path.sep)) { dirs.add(dir); dir = path.dirname(dir); }
    }
    // deepest folders first; rmdir only succeeds on empty ones, which is what we want
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
        try { await fs.promises.rmdir(dir); } catch (e) { /* not empty - leave it */ }
    }
    return { failed };
}

// Kills the download process and waits until it is really gone, so Windows has released
// its file handles before we try to delete anything.
function stopWorkerAndWait(id) {
    const w = workers.get(id);
    if (!w) return Promise.resolve();
    workers.delete(id);
    return new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        w.once('exit', () => { clearTimeout(timer); resolve(); });
        w.kill();
    });
}

function stopWorker(id) {
    const w = workers.get(id);
    if (w) { workers.delete(id); w.kill(); }
}

function onWorkerMessage(d, msg) {
    switch (msg.type) {
        case 'status':
            d.status = msg.text;
            send('download:update', progressView(d));
            break;
        case 'progress': {
            d.percent = msg.percent;
            d.peers = msg.connected;
            d.status = msg.connected > 0 ? 'Downloading' : 'Connecting to peers...';

            // the engine counts per session; keep running totals across pauses and restarts
            const dl = msg.downloaded - (d._sessDl || 0);
            if (dl > 0) d.downloaded = (d.downloaded || 0) + dl;
            d._sessDl = msg.downloaded;
            const wasted = msg.wasted - (d._sessWasted || 0);
            if (wasted > 0) d.wasted = (d.wasted || 0) + wasted;
            d._sessWasted = msg.wasted;

            d.stats = msg;
            send('download:update', progressView(d));
            saveSoon();
            break;
        }
        case 'detail': {
            const cur = live.get(d.id) || { peers: [], trackers: [] };
            if (msg.peers) cur.peers = msg.peers;
            if (msg.trackers) cur.trackers = msg.trackers;
            live.set(d.id, cur);
            send('download:detail', { id: d.id, ...msg });
            break;
        }
        case 'log':
            addLog(d.id, msg.lines);
            break;
        case 'files': {
            // reset=true: the engine re-checked the disk and listed every finished file
            const set = msg.reset ? new Set() : doneSetFor(d);
            msg.done.forEach(i => set.add(i));
            doneSets.set(d.id, set);
            send('download:files', { id: d.id, done: msg.done, reset: !!msg.reset });
            saveSoon();
            break;
        }
        case 'complete':
            d.state = 'completed';
            d.percent = 100;
            d.peers = 0;
            d.status = 'Completed';
            d.completedAt = Date.now();
            settleActive(d);
            send('download:update', progressView(d));
            saveNow();
            break;
        case 'error':
            d.state = 'error';
            d.error = msg.message;
            d.status = msg.message;
            settleActive(d);
            send('download:update', progressView(d));
            saveNow();
            break;
    }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('state:get', () => ({
    settings: db.settings,
    downloads: db.downloads.map(view),
    defaultFolder: app.getPath('downloads')
}));

ipcMain.handle('pick-torrent', async () => {
    const r = await dialog.showOpenDialog(win, {
        title: 'Select a torrent file',
        properties: ['openFile'],
        filters: [{ name: 'Torrent files', extensions: ['torrent'] }]
    });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-folder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
        title: 'Choose where to save',
        defaultPath: current || undefined,
        properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('parse-torrent', (_e, filePath) => {
    try {
        const meta = parseTorrent(filePath);
        const duplicate = db.downloads.some(d => d.infoHash === meta.infoHash);
        return { meta, duplicate };
    } catch (e) {
        return { error: 'That file could not be read as a torrent.' };
    }
});

ipcMain.handle('add', (_e, { torrentPath, folder, selected }) => {
    try {
        const meta = parseTorrent(torrentPath);

        // `selected` = indices of the files to download, or null for everything.
        let chosen = null;
        if (Array.isArray(selected) && selected.length < meta.files.length) {
            chosen = [...new Set(selected)].filter(i => Number.isInteger(i) && i >= 0 && i < meta.files.length)
                .sort((a, b) => a - b);
            if (chosen.length === 0) return { error: 'Select at least one file to download.' };
        }
        const chosenFiles = chosen ? chosen.map(i => meta.files[i]) : meta.files;
        if (db.downloads.some(d => d.infoHash === meta.infoHash)) {
            return { error: 'This torrent is already in your list.' };
        }

        // Keep our own copy so resuming still works if the original file is moved.
        fs.mkdirSync(torrentsDir(), { recursive: true });
        const stored = path.join(torrentsDir(), meta.infoHash + '.torrent');
        fs.copyFileSync(torrentPath, stored);

        const d = {
            id: crypto.randomUUID(),
            infoHash: meta.infoHash,
            name: meta.name,
            isMulti: meta.isMulti,
            totalBytes: chosenFiles.reduce((sum, f) => sum + f.length, 0), // size of what we will download
            fileCount: meta.files.length,
            selectedCount: chosenFiles.length,
            selected: chosen,
            folder,
            torrentFile: stored,
            percent: 0,
            state: 'paused',
            status: '',
            peers: 0,
            error: null,
            addedAt: Date.now()
        };
        db.downloads.push(d);
        db.settings.lastFolder = folder;

        send('download:added', view(d));
        startDownload(d);
        saveNow();
        return { ok: true, id: d.id };
    } catch (e) {
        return { error: 'Could not add torrent: ' + e.message };
    }
});

ipcMain.handle('download-files', (_e, id) => {
    const d = find(id);
    if (!d) return null;
    try {
        const meta = parseTorrent(d.torrentFile);
        return { name: meta.name, isMulti: meta.isMulti, files: meta.files, done: [...doneSetFor(d)], selected: d.selected || null };
    } catch (e) { return null; }
});

ipcMain.on('pause', (_e, id) => {
    const d = find(id);
    if (!d || d.state !== 'downloading') return;
    d.state = 'paused';
    d.status = 'Paused';
    d.peers = 0;
    stopWorker(id);
    settleActive(d);
    clearLive(d);
    addLog(id, [{ t: Date.now(), level: 'sys', text: '--- Download paused ---' }]);
    send('download:update', progressView(d));
    saveNow();
});

ipcMain.on('resume', (_e, id) => {
    const d = find(id);
    if (!d || d.state === 'downloading' || d.state === 'completed') return;
    startDownload(d);
});

ipcMain.handle('remove', async (_e, { id, deleteFiles }) => {
    const d = find(id);
    if (!d) return { ok: true, failed: 0 };

    d.state = 'paused'; // so the process-exit handler doesn't report an error
    await stopWorkerAndWait(id);

    let failed = 0;
    if (deleteFiles) failed = (await deleteContent(d)).failed;

    db.downloads = db.downloads.filter(x => x.id !== id);
    doneSets.delete(id);
    live.delete(id);
    logs.delete(id);
    try { fs.unlinkSync(d.torrentFile); } catch (e) {}
    send('download:removed', id);
    saveNow();
    return { ok: true, failed };
});

// Free space on the drive that holds `folder`. If the folder doesn't exist yet we ask about
// the closest parent that does, since that is the same drive.
ipcMain.handle('disk-space', async (_e, folder) => {
    let dir = path.resolve(folder || app.getPath('downloads'));
    for (let i = 0; i < 64; i++) {
        try {
            const st = await fs.promises.statfs(dir);
            return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
        } catch (e) {
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null; // unknown - the UI then simply skips the check
});

ipcMain.handle('download-meta', (_e, id) => {
    const d = find(id);
    if (!d) return null;
    try { return readTorrentMeta(d.torrentFile); } catch (e) { return null; }
});

ipcMain.handle('download-detail', (_e, id) => live.get(id) || { peers: [], trackers: [] });
ipcMain.handle('download-log', (_e, id) => logs.get(id) || []);
ipcMain.on('clear-log', (_e, id) => { logs.set(id, []); });

ipcMain.on('open-folder', (_e, id) => {
    const d = find(id);
    if (!d) return;
    const target = insideFolder(d.folder, d.name);
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    else shell.openPath(d.folder);
});

ipcMain.on('set-theme', (_e, mode) => {
    if (!['system', 'light', 'dark'].includes(mode)) return;
    db.settings.theme = mode;
    nativeTheme.themeSource = mode; // the page's prefers-color-scheme follows this
    saveNow();
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0e131b' : '#ffffff');

function createWindow() {
    win = new BrowserWindow({
        width: 1120,
        height: 720,
        minWidth: 860,
        minHeight: 560,
        title: 'BitStream',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        backgroundColor: windowBg(),
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.removeMenu();
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });

    // A dropped file must never navigate the window away from the app.
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(windowBg()); });

app.whenReady().then(() => {
    loadDb();
    nativeTheme.themeSource = db.settings.theme;

    if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
        ]));
    }
    createWindow();
});

app.on('before-quit', () => {
    db.downloads.forEach(settleActive);
    workers.forEach(w => w.kill());
    workers.clear();
    saveNow();
});

app.on('window-all-closed', () => app.quit());