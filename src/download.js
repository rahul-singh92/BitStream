'use strict';

const fs = require('graceful-fs');
const path = require('path');
const net = require('net');
const Buffer = require('buffer').Buffer;
const tracker = require('./tracker');
const message = require('./message');
const Pieces = require('./Pieces');
const Queue = require('./Queue');
const tp = require('./torrent-parser');
const bencode = require('bencode');
const crypto = require('crypto');
const DHT = require('bittorrent-dht');

const MAX_CONCURRENT_PEERS = 30;
const MAX_IN_FLIGHT_REQUESTS = 75;
const SOCKET_TIMEOUT_MS = 120000;
const PROGRESS_INTERVAL_MS = 500;

// download(torrent, destPath, { onProgress, onStatus, onComplete })
//   onProgress({ percent, active, pending })  - called every 500ms while downloading
//   onStatus(text)                            - coarse phase changes ("Checking files...")
//   onComplete()                              - called once when every piece is saved
//   selected                                  - array of file indices to download (null = everything).
//                                               Only pieces overlapping those files are requested.
//   onFiles(indices, reset)                   - indices of files that just became fully downloaded
//                                               (every piece they touch is hash-verified). `reset` is true
//                                               on the first call, which lists everything already on disk.
//   onPeers(list) / onTrackers(list)          - snapshots of the connected peers and of every tracker
//                                               (plus DHT and PeX), about once a second
//   onProgress also carries transfer statistics: speed, downloaded, wasted, connections, seeds...
// Returns stop(), which cancels everything (sockets, tracker, DHT, open files).
// It never calls process.exit - the caller decides what happens when we finish.
module.exports = (torrent, destPath, { onProgress = () => {}, onStatus = () => {}, onComplete = () => {}, onFiles = () => {}, onPeers = () => {}, onTrackers = () => {}, selected = null } = {}) => {
    const selectedSet = selected ? new Set(selected) : null;
    const pieces = new Pieces(torrent);
    const files = openFiles(torrent, destPath, selectedSet);

    // A file spans pieces first..last. A file is complete when all of them are verified,
    // and a piece is wanted when it overlaps at least one selected file.
    const pieceLength = torrent.info['piece length'];
    const fileRanges = files.map(f => ({
        first: Math.floor(f.offset / pieceLength),
        last: f.length ? Math.floor((f.offset + f.length - 1) / pieceLength) : -1
    }));
    pieces.setWanted(computeWanted(fileRanges, selectedSet, torrent.info.pieces.length / 20));
    pieces.boundary = computeBoundary(files, fileRanges);

    onStatus('Checking existing files...');
    verifyExistingPieces(torrent, pieces, files, pct => onStatus(`Checking existing files... ${pct}%`));

    const reportedFiles = new Set();

    function reportFiles(reset = false)
    {
        const fresh = [];
        fileRanges.forEach((r, i) => {
            if(reportedFiles.has(i)) return;
            if(pieces.rangeVerified(r.first, r.last))
            {
                reportedFiles.add(i);
                fresh.push(i);
            }
        });
        if(fresh.length || reset) onFiles(fresh, reset);
    }

    reportFiles(true); // everything recovered from disk

    if (pieces.isDone())
    {
        console.log('Torrent is already 100% complete! Skipping network download.');
        closeFiles(files);
        onProgress({
            percent: 100, active: 0, connected: 0, pending: 0, maxConnections: MAX_CONCURRENT_PEERS,
            downloaded: 0, wasted: 0, speed: 0, piecesHave: pieces.haveCount(), piecesTotal: pieces.wantedCount(),
            seedsConnected: 0, peersConnected: 0, seeders: null, leechers: null
        });
        onComplete();
        return () => {};
    }

    onStatus('Finding peers...');

    const nPieces = torrent.info.pieces.length / 20;
    const session = { peers: new Map(), nPieces }; // "ip:port" -> live connection (shown in the Peers tab)
    const seenPeers = new Set();
    const pendingPeers = [];
    const sockets = new Set();
    let activeConnections = 0;
    let done = false;

    // ---- one row per tracker (plus DHT and PeX) for the Trackers tab ----
    const makeRow = (url, status, message = '') => ({
        url, status, seeds: null, peers: null, returned: 0, lastAnnounce: null, nextAnnounce: null, message
    });
    const trackerRows = new Map();
    tracker.listTrackers(torrent).forEach(url => {
        trackerRows.set(url, tracker.isSupported(url)
            ? makeRow(url, 'Not contacted')
            : makeRow(url, 'Not supported', tracker.unsupportedReason(url)));
    });
    const dhtRow = makeRow('** [DHT] **', 'Updating');
    const pexRow = makeRow('** [PeX] **', 'Not contacted');

    function onTrackerStatus(url, patch)
    {
        const row = trackerRows.get(url);
        if(row) Object.assign(row, patch);
    }

    const dht = startDHT(tp.infoHash(torrent));

    function maybeStartNext()
    {
        while(!done && activeConnections < MAX_CONCURRENT_PEERS && pendingPeers.length)
        {
            const peer = pendingPeers.shift();
            activeConnections++;
            download(peer, torrent, pieces, files, sockets, session, onDone, onPeerConnectionEnded,
                found => handleNewPeers(found, 'PeX'));
        }
    }

    function onPeerConnectionEnded()
    {
        activeConnections--;
        maybeStartNext();
    }

    const stopAnnouncing = tracker.getPeers(torrent, peers => handleNewPeers(peers, 'Tracker'), onTrackerStatus);

    function handleNewPeers(peers, source = 'Unknown')
    {
        if(done) return;
        let addedCount = 0;
        peers.forEach(peer => {
            const key = `${peer.ip}:${peer.port}`;
            if(seenPeers.has(key)) return;
            seenPeers.add(key);
            pendingPeers.push({ ip: peer.ip, port: peer.port, source });
            addedCount++;
        });
        if(source === 'DHT') dhtRow.returned += addedCount;
        if(source === 'PeX')
        {
            pexRow.returned += addedCount;
            if(addedCount > 0) pexRow.status = 'Working';
        }
        if(addedCount > 0) maybeStartNext();
    }

    function startDHT(infoHash)
    {
        console.log('Starting DHT node to find decentralized peers...');
        const dht = new DHT();

        dht.on('error', err => {
            dhtRow.status = 'Not working';
            dhtRow.message = err.message;
            console.log('DHT error:', err.message);
        });

        dht.listen(0, () => {
            console.log('DHT listening, searching for peers... ');
            dhtRow.status = 'Working';
            dht.lookup(infoHash);
        });

        dht.on('peer', peer => {
            handleNewPeers([{ ip: peer.host, port: peer.port }], 'DHT');
        });
        return dht;
    }

    // ---- statistics ----
    const speedSamples = [{ t: Date.now(), b: 0 }];
    let speed = 0;
    let lastTick = Date.now();
    let tick = 0;

    function currentStats(overrides = {})
    {
        const list = [...session.peers.values()];
        const connected = list.filter(p => p.state === 'connected');
        const seedsConnected = connected.filter(p => p.have === nPieces).length;

        let seeders = null, leechers = null; // swarm size according to the trackers
        trackerRows.forEach(r => {
            if(r.status !== 'Working') return;
            if(r.seeds != null) seeders = Math.max(seeders === null ? 0 : seeders, r.seeds);
            if(r.peers != null) leechers = Math.max(leechers === null ? 0 : leechers, r.peers);
        });

        return {
            percent: pieces.getPercent(),
            active: activeConnections,
            connected: connected.length,
            pending: pendingPeers.length,
            maxConnections: MAX_CONCURRENT_PEERS,
            downloaded: pieces.stats.downloaded,
            wasted: pieces.stats.wasted,
            speed,
            piecesHave: pieces.haveCount(),
            piecesTotal: pieces.wantedCount(),
            seedsConnected,
            peersConnected: connected.length - seedsConnected,
            seeders, leechers,
            ...overrides
        };
    }

    function snapshotPeers()
    {
        return [...session.peers.values()].map(p => ({
            ip: p.ip, port: p.port, client: p.client, source: p.source,
            status: peerStatus(p), progress: nPieces ? p.have / nPieces : 0,
            speed: p.speed, downloaded: p.downloaded
        }));
    }

    const snapshotTrackers = () => [...trackerRows.values(), dhtRow, pexRow].map(r => ({ ...r }));

    const progressInterval = setInterval(() => {
        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        lastTick = now;
        tick++;

        reportFiles();

        // overall speed = bytes received over the last ~5 seconds
        speedSamples.push({ t: now, b: pieces.stats.downloaded });
        while(speedSamples.length > 2 && now - speedSamples[0].t > 5000) speedSamples.shift();
        const first = speedSamples[0];
        const span = (now - first.t) / 1000;
        speed = span > 0 ? (pieces.stats.downloaded - first.b) / span : 0;

        // per-peer speed, lightly smoothed
        session.peers.forEach(p => {
            const instant = dt > 0 ? (p.downloaded - p.lastDl) / dt : 0;
            p.lastDl = p.downloaded;
            p.speed = p.speed * 0.5 + instant * 0.5;
        });

        onProgress(currentStats());
        if(tick % 2 === 0)
        {
            onPeers(snapshotPeers());
            onTrackers(snapshotTrackers());
        }
    }, PROGRESS_INTERVAL_MS);

    function stop()
    {
        if(done) return;
        done = true;
        clearInterval(progressInterval);
        stopAnnouncing();
        try { dht.destroy(); } catch(e) {}
        sockets.forEach(s => s.destroy());
        closeFiles(files);
    }

    function onDone()
    {
        if(done) return;
        reportFiles(); // the last file(s) finish with the last piece
        stop();
        onProgress(currentStats({ percent: 100, active: 0, connected: 0, pending: 0, speed: 0 }));
        onPeers([]);
        onTrackers(snapshotTrackers());
        onComplete();
    }

    return stop;
};

// Pieces overlapping a selected file. With no selection every piece is wanted.
function computeWanted(fileRanges, selectedSet, nPieces)
{
    const wanted = new Array(nPieces).fill(!selectedSet);
    if(selectedSet)
    {
        selectedSet.forEach(i => {
            const r = fileRanges[i];
            if(!r) return;
            for(let p = r.first; p <= r.last; p++) wanted[p] = true;
        });
    }
    return wanted;
}

// Pieces that touch both a skipped file and something we want. A piece that overlaps a
// skipped, non-empty file must contain that file's first or last byte, so only the first and
// last piece of each skipped file can be border pieces.
function computeBoundary(files, fileRanges)
{
    const boundary = new Set();
    files.forEach((f, i) => {
        if(f.selected || f.length === 0) return;
        boundary.add(fileRanges[i].first);
        boundary.add(fileRanges[i].last);
    });
    return boundary;
}

function closeFiles(files)
{
    files.forEach(f => {
        if(f.fd === null) return;
        try { fs.closeSync(f.fd); } catch(e) {}
        f.fd = null;
    });
}

// Files are opened lazily. Selected files are created straight away; a skipped file is only
// created if a piece we really need happens to straddle into it (a piece can contain the end
// of one file and the start of the next), so skipped files normally leave nothing on disk.
function ensureOpen(file, create)
{
    if(file.fd !== null) return file.fd;
    try {
        file.fd = fs.openSync(file.path, 'r+');
    } catch(err) {
        if(!create) return null;
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        file.fd = fs.openSync(file.path, 'w+');
    }
    return file.fd;
}

// Returns [{ path, fd, offset, length, selected }] where `offset` is the file's starting byte
// position within the whole concatenated torrent data.
function openFiles(torrent, destPath, selectedSet)
{
    const entries = [];

    if (!torrent.info.files)
    {
        entries.push({
            path: destPath || torrent.info.name.toString('utf8'),
            fd: null, offset: 0, length: torrent.info.length, selected: true
        });
    }
    else
    {
        const rootDir = destPath || torrent.info.name.toString('utf8');
        let offset = 0;
        torrent.info.files.forEach((file, i) => {
            const segments = file.path.map(segment => segment.toString('utf8'));
            const fullPath = path.join(rootDir, ...segments);
            if (!path.resolve(fullPath).startsWith(path.resolve(rootDir) + path.sep)) {
                throw new Error('Unsafe file path in torrent: ' + segments.join('/'));
            }
            entries.push({
                path: fullPath, fd: null, offset, length: file.length,
                selected: !selectedSet || selectedSet.has(i)
            });
            offset += file.length;
        });
    }

    entries.forEach(e => { if(e.selected) ensureOpen(e, true); });
    return entries;
}

// Synchronous write: the file descriptors get closed the moment the last block arrives
// (or on cancel), and an async fs.write still in flight at that point would fail with
// EBADF. 16KB writes are cheap, and this runs in the worker process, not the UI.
function writeBlock(files, absOffset, block, onlySelected = false)
{
    const blockEnd = absOffset + block.length;

    files.forEach(file => {
        if (onlySelected && !file.selected) return;
        const fileEnd = file.offset + file.length;
        if (blockEnd <= file.offset || absOffset >= fileEnd) return;

        const sliceStart = Math.max(absOffset, file.offset);
        const sliceEnd = Math.min(blockEnd, fileEnd);
        if (sliceEnd <= sliceStart) return; // zero-byte file: nothing to write

        const blockSlice = block.slice(sliceStart - absOffset, sliceEnd - absOffset);
        const filePosition = sliceStart - file.offset;

        try {
            const fd = ensureOpen(file, true);
            fs.writeSync(fd, blockSlice, 0, blockSlice.length, filePosition);
        } catch(err) {
            console.log('write error:', err.message);
        }
    });
}

function download(peer, torrent, pieces, files, sockets, session, onDone, onPeerConnectionEnded, onNewPeers)
{
    const peerLabel = `${peer.ip}:${peer.port}`;
    const socket = new net.Socket();

    // Everything we know about this connection. The Peers tab displays this same object.
    const connState = {
        inFlight: 0,
        ip: peer.ip, port: peer.port, source: peer.source || 'Unknown',
        state: 'connecting',            // connecting -> handshaking -> connected
        client: '',
        choked: true,                   // are they choking us?
        bits: new Uint8Array(session.nPieces), have: 0, // which pieces the peer has
        downloaded: 0, lastDl: 0, speed: 0
    };
    session.peers.set(peerLabel, connState);
    sockets.add(socket);

    // Fires exactly once no matter how the connection ends (error, choke-destroy, natural
    // close, timeout) - this is our single point for returning the connection slot to the pool.
    let ended = false;
    socket.once('close', () => {
        sockets.delete(socket);
        session.peers.delete(peerLabel);
        if(ended) return;
        ended = true;
        onPeerConnectionEnded();
    });

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        console.log(`timeout: ${peerLabel}`);
        socket.destroy();
    });

    socket.on('error', err => console.log(`socket error [${peerLabel}]:`, err.message));
    socket.connect(peer.port, peer.ip, () => {
        console.log(`connected to peer ${peerLabel} (via ${connState.source})`);
        connState.state = 'handshaking';
        socket.write(message.buildHandShake(torrent));
    });
    const queue = new Queue(torrent, pieces);
    // the socket might receive part of a message or several at once, so every message starts
    // with its length, which tells us where it begins and ends
    onWholeMsg(socket, msg => msgHandler(msg, socket, pieces, queue, torrent, files, peerLabel, onDone, connState, onNewPeers));
}

function msgHandler(msg, socket, pieces, queue, torrent, files, peerLabel, onDone, connState, onNewPeers)
{
    if(socket.destroyed) return;

    if(isHandShake(msg))
    {
        connState.state = 'connected';
        const idStart = msg.readUInt8(0) + 29; // 1 + pstrlen + 8 reserved + 20 info hash
        connState.client = decodePeerId(msg.slice(idStart, idStart + 20));
        console.log(`handshake ok with ${peerLabel} (${connState.client})`);
        socket.write(message.buildInterested());
        socket.write(message.buildExtendedHandshake());
    }
    else
    {
        const m = message.parse(msg);

        if(m.id === 0) chokeHandler(socket, peerLabel, queue, connState);
        if(m.id === 1) unchokeHandler(socket, pieces, queue, peerLabel, connState);
        if(m.id === 4) haveHandler(socket, pieces, queue, m.payload, connState);
        if(m.id === 5) bitfieldHandler(socket, pieces, queue, m.payload, connState);
        if(m.id === 7) pieceHandler(socket, pieces, queue, torrent, files, m.payload, onDone, connState);
        if(m.id === 20) extendedHandler(m.payload, onNewPeers, peerLabel, connState);
    }
}

function isHandShake(msg)
{
    return msg.length === msg.readUInt8(0) + 49 &&
           msg.toString('utf8', 1, 20) === 'BitTorrent protocol';
}

function chokeHandler(socket, peerLabel, queue, connState)
{
    console.log(`choked by ${peerLabel}, waiting in line...`);
    queue.choked = true;
    connState.choked = true;
    connState.inFlight = 0;
}

function unchokeHandler(socket, pieces, queue, peerLabel, connState)
{
    console.log(`unchoked by ${peerLabel}, starting requests`);
    queue.choked = false;
    connState.choked = false;
    requestPiece(socket, pieces, queue, connState);
}

function haveHandler(socket, pieces, queue, payload, connState)
{
    const pieceIndex = payload.readUInt32BE(0);
    const queueEmpty = queue.length === 0;
    markHave(connState, pieceIndex);
    queue.queue(pieceIndex);
    if(queueEmpty) requestPiece(socket, pieces, queue, connState);
}

function bitfieldHandler(socket, pieces, queue, payload, connState)
{
    const queueEmpty = queue.length === 0;
    payload.forEach((byte, i) => {
        for(let j = 0; j < 8; j++)
        {
            if(byte % 2)
            {
                markHave(connState, i * 8 + 7 - j);
                queue.queue(i * 8 + 7 - j);
            }
            byte = Math.floor(byte/2);
        }
    });
    if(queueEmpty) requestPiece(socket, pieces, queue, connState);
}

function pieceHandler(socket, pieces, queue, torrent, files, pieceResp, onDone, connState)
{
    connState.inFlight = Math.max(0, connState.inFlight - 1);
    connState.downloaded += pieceResp.block.length;

    acceptBlock(pieces, torrent, files, pieceResp);

    if(pieces.isDone())
    {
        console.log('Done! All pieces verified.');
        onDone(); // stops everything, closes files, notifies the caller
    }
    else
    {
        requestPiece(socket, pieces, queue, connState);
    }
}

// Validates, stores and (when its piece is complete) hash-checks one incoming block.
function acceptBlock(pieces, torrent, files, pieceResp)
{
    const { index, begin, block } = pieceResp;

    // Ignore anything that doesn't line up with the torrent's layout (bad index/offset/size).
    if(!pieces.hasPiece(index) || !pieces.isWanted(index)) return;
    const blockIndex = begin / tp.BLOCK_LEN;
    if(!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= tp.blocksPerPiece(torrent, index)) return;
    if(block.length !== tp.blockLen(torrent, index, blockIndex)) return;

    pieces.stats.downloaded += block.length;

    // Duplicate block (endgame racing, or a re-request after a timeout): it's wasted traffic.
    if(pieces.isVerified(index) || pieces._received[index][blockIndex])
    {
        pieces.stats.wasted += block.length;
        return;
    }

    if(pieces.boundary.has(index))
    {
        // Border piece: keep it in memory. Writing it straight to disk would create (part of)
        // a file the user chose to skip.
        let buf = pieces.buffers.get(index);
        if(!buf)
        {
            buf = Buffer.alloc(tp.pieceLen(torrent, index));
            pieces.buffers.set(index, buf);
        }
        block.copy(buf, begin);
        pieces.addReceived(pieceResp);

        if(pieces.isPieceDone(index)) verifyBufferedPiece(torrent, pieces, files, index);
        return;
    }

    writeBlock(files, index * torrent.info['piece length'] + begin, block);
    pieces.addReceived(pieceResp);

    if(pieces.isPieceDone(index)) verifyPiece(torrent, pieces, files, index);
}

// Same check as verifyPiece, but on the in-memory copy. Only after it passes do we write
// the piece - and only the parts that belong to selected files.
function verifyBufferedPiece(torrent, pieces, files, index)
{
    const buf = pieces.buffers.get(index);
    const ok = buf && crypto.createHash('sha1').update(buf).digest().equals(tp.pieceHash(torrent, index));
    if(ok)
    {
        writeBlock(files, index * torrent.info['piece length'], buf, true);
        pieces.markVerified(index); // also frees the buffer
    }
    else
    {
        console.log(`hash mismatch on piece ${index} - discarding and re-downloading it`);
        pieces.stats.wasted += tp.pieceLen(torrent, index);
        pieces.resetPiece(index);
    }
}

// Reads the finished piece back from disk and compares its SHA-1 with the torrent's.
// On a mismatch the piece is wiped from our bookkeeping and will be downloaded again.
function verifyPiece(torrent, pieces, files, index)
{
    const buf = Buffer.alloc(tp.pieceLen(torrent, index));
    readBlock(files, index * torrent.info['piece length'], buf);

    const ok = crypto.createHash('sha1').update(buf).digest().equals(tp.pieceHash(torrent, index));
    if(ok)
    {
        pieces.markVerified(index);
    }
    else
    {
        console.log(`hash mismatch on piece ${index} - discarding and re-downloading it`);
        pieces.stats.wasted += tp.pieceLen(torrent, index);
        pieces.resetPiece(index);
    }
}

function extendedHandler(payload, onNewPeers, peerLabel, connState)
{
    const extendedId = payload.readUInt8(0);
    const dictBuf = payload.slice(1);

    try {
        const dict = bencode.decode(dictBuf);

        if(extendedId === 0)
        {
            // many clients announce their name and version here (the "v" key)
            if(Buffer.isBuffer(dict.v) && dict.v.length) connState.client = dict.v.toString('utf8').trim();
            if(dict.m && dict.m.ut_pex)
            {
                connState.pexId = dict.m.ut_pex;
            }
        }
        else if(connState.pexId && extendedId === connState.pexId)
        {
            if(dict.added)
            {
                const peers = [];
                for(let i = 0; i < dict.added.length; i+= 6)
                {
                    peers.push({
                        ip: dict.added.slice(i, i + 4).join('.'),
                        port: dict.added.readUInt16BE(i + 4)
                    });
                }
                if(peers.length > 0)
                {
                    console.log(`[PEX] ${peerLabel} gossiped ${peers.length} new peers to us!`);
                    onNewPeers(peers);
                }
            }
        }
    }
    catch(e)
    {
        // ignore bencode parse errors
    }
}

function requestPiece(socket, pieces, queue, connState)
{
    if(queue.choked) return;

    while(connState.inFlight < MAX_IN_FLIGHT_REQUESTS && queue.length())
    {
        const pieceBlock = queue.dequeue();
        if(!pieceBlock) break;

        if(pieces.needed(pieceBlock))
        {
            socket.write(message.buildRequest(pieceBlock));
            pieces.addRequested(pieceBlock);
            connState.inFlight++;
        }
    }
}

function onWholeMsg(socket, callback)
{
    let savedBuf = Buffer.alloc(0);
    let handshake = true;

    socket.on('data', recvBuffer => {
        const msgLen = () => handshake ? savedBuf.readUInt8(0) + 49 : savedBuf.readUInt32BE(0) + 4;
        savedBuf = Buffer.concat([savedBuf, recvBuffer]);

        while(savedBuf.length >= 4 && savedBuf.length >= msgLen())
        {
            callback(savedBuf.slice(0, msgLen()));
            savedBuf = savedBuf.slice(msgLen());
            handshake = false;
        }
    });
}

function readBlock(files, absOffset, buf)
{
    let bufOffset = 0;
    const blockEnd = absOffset + buf.length;

    files.forEach(file => {
        const fileEnd = file.offset + file.length;
        if(blockEnd <= file.offset || absOffset >= fileEnd) return;

        const sliceStart = Math.max(absOffset, file.offset);
        const sliceEnd = Math.min(blockEnd, fileEnd);
        const sliceLen = sliceEnd - sliceStart;
        const filePosition = sliceStart - file.offset;

        const fd = sliceLen > 0 ? ensureOpen(file, false) : null; // never create a file just to read it
        if(fd !== null)
        {
            try {
                fs.readSync(fd, buf, bufOffset, sliceLen, filePosition);
            } catch (err) {
                // Ignore if file parts are missing
            }
        }
        bufOffset += sliceLen;
    });
}

function verifyExistingPieces(torrent, pieces, files, onPercent) {
    console.log('Checking existing files to recover progress...');

    const nPieces = torrent.info.pieces.length / 20;
    let piecesRestored = 0;

    let lastPct = -1;
    for (let i = 0; i < nPieces; i++) {
        const pct = Math.floor(i * 100 / nPieces);
        if (onPercent && pct !== lastPct) { lastPct = pct; onPercent(pct); }
        if (!pieces.isWanted(i)) continue; // belongs only to skipped files
        const pieceLen = tp.pieceLen(torrent, i);
        const buf = Buffer.alloc(pieceLen);
        const offset = i * torrent.info['piece length'];

        readBlock(files, offset, buf);

        const diskHash = crypto.createHash('sha1').update(buf).digest();
        const expectedHash = tp.pieceHash(torrent, i);

        if (diskHash.equals(expectedHash)) {
            pieces.markVerified(i);
            piecesRestored++;
        }
    }

    if (piecesRestored > 0) {
        console.log(`Recovered ${piecesRestored} / ${nPieces} pieces from disk.`);
    }
}

// ---------------------------------------------------------------------------
// Peer helpers
// ---------------------------------------------------------------------------

const CLIENTS = {
    qB: 'qBittorrent', TR: 'Transmission', UT: '\u00b5Torrent', UM: '\u00b5Torrent Mac', lt: 'libtorrent',
    LT: 'libtorrent', DE: 'Deluge', AZ: 'Vuze', BT: 'BitTorrent', WW: 'WebTorrent', WD: 'WebTorrent Desktop',
    FD: 'Free Download Manager', KT: 'KTorrent', BI: 'BiglyBT', RT: 'BitStream', LW: 'LimeWire', XL: 'Xunlei'
};

// Most clients put "-XXvvvv-" at the start of their 20-byte peer id (XX = client, vvvv = version).
function decodePeerId(id)
{
    const m = /^-([A-Za-z]{2})([0-9A-Za-z]{4})-/.exec(id.toString('latin1'));
    if(!m) return 'Unknown';
    const version = m[2].split('').join('.').replace(/(\.0)+$/, '');
    return `${CLIENTS[m[1]] || m[1]} ${version}`;
}

function markHave(conn, pieceIndex)
{
    if(pieceIndex < 0 || pieceIndex >= conn.bits.length || conn.bits[pieceIndex]) return;
    conn.bits[pieceIndex] = 1;
    conn.have++;
}

function peerStatus(p)
{
    if(p.state === 'connecting') return 'Connecting';
    if(p.state === 'handshaking') return 'Handshaking';
    if(p.choked) return 'Choked';
    return p.inFlight > 0 ? 'Downloading' : 'Idle';
}

module.exports.computeWanted = computeWanted; // exported for tests
module.exports.computeBoundary = computeBoundary;