'use strict';

// Runs inside an Electron utilityProcess. Talks to main.js via process.parentPort.

const path = require('path');
const util = require('util');

const port = process.parentPort;
const post = msg => port.postMessage(msg);

// ---------------------------------------------------------------------------
// Everything the engine prints (connected, unchoked, socket errors, ...) is sent to the
// app's Log tab. Lines are batched so a burst of output doesn't flood the UI.
// ---------------------------------------------------------------------------
let logBuf = [];
let logTimer = null;

function flushLog() {
    if (logTimer) { clearTimeout(logTimer); logTimer = null; }
    if (logBuf.length) { post({ type: 'log', lines: logBuf }); logBuf = []; }
}
function pushLog(args, level) {
    logBuf.push({ t: Date.now(), level, text: util.format(...args) });
    if (logBuf.length >= 200) flushLog();
    else if (!logTimer) logTimer = setTimeout(flushLog, 250);
}
console.log = (...a) => pushLog(a, 'info');
console.info = (...a) => pushLog(a, 'info');
console.warn = (...a) => pushLog(a, 'warn');
console.error = (...a) => pushLog(a, 'warn');

function fatal(err) {
    pushLog([`Unhandled error: ${(err && err.stack) || err}`], 'warn');
    flushLog();
    post({ type: 'error', message: (err && err.message) || String(err) });
    process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const tp = require('./torrent-parser');
const download = require('./download');

let stopDownload = null;

port.on('message', ({ data }) => {
    if (data.type === 'start') start(data);
    if (data.type === 'stop') {
        if (stopDownload) stopDownload();
        flushLog();
        process.exit(0);
    }
});

function start({ torrentPath, folder, selected }) {
    try {
        const torrent = tp.open(torrentPath);
        const name = torrent.info.name.toString('utf8');
        const totalBytes = Number(tp.size(torrent).readBigUInt64BE(0));

        post({ type: 'info', name, totalBytes });

        // Single-file torrent -> file at <folder>/<name>
        // Multi-file torrent  -> directory at <folder>/<name>/...
        const base = path.resolve(folder);
        const dest = path.resolve(base, name);
        if (dest === base || !dest.startsWith(base + path.sep)) throw new Error('This torrent has an unsafe name.');

        stopDownload = download(torrent, dest, {
            selected: selected || null,
            onStatus: text => post({ type: 'status', text }),
            onProgress: p => post({ type: 'progress', ...p }),
            onPeers: peers => post({ type: 'detail', peers }),
            onTrackers: trackers => post({ type: 'detail', trackers }),
            onFiles: (done, reset) => post({ type: 'files', done, reset }),
            onComplete: () => {
                flushLog();
                post({ type: 'complete', location: dest });
                process.exit(0);
            }
        });
    } catch (err) {
        fatal(err);
    }
}