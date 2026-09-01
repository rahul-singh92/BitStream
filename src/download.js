'use strict';

// const fs = require('fs');
const fs = require('graceful-fs');
const path = require('path');
const net = require('net');
const Buffer = require('buffer').Buffer;
const tracker = require('./tracker');
const message = require('./message');
const Pieces = require('./Pieces');
const Queue = require('./Queue');

// Only this many peer connections are attempted at once. Dialing hundreds of peers
// simultaneously can overwhelm a home router's connection table and produce failures
// that have nothing to do with the actual remote peers. As connections finish (success
// or failure), the next queued peer is started automatically.
const MAX_CONCURRENT_PEERS = 30;

// How many outstanding block requests we keep in flight per peer at once. Requesting
// one block, waiting for it, then requesting the next wastes almost all of the
// connection's throughput on round-trip latency instead of actual transfer.
const MAX_IN_FLIGHT_REQUESTS = 5;

// Kill a connection if we don't hear anything from it (including the initial TCP
// connect) within this long, so we can move on to the next peer quickly instead of
// waiting on the OS's default (much longer) timeout.
const SOCKET_TIMEOUT_MS = 120000;

module.exports = (torrent, destPath) => {
    // pieces/files are created ONCE, outside the tracker callback - the tracker re-announces
    // periodically to fetch fresh peers, and we don't want to reset progress or reopen file
    // descriptors every time that happens.
    const pieces = new Pieces(torrent);
    const files = openFiles(torrent, destPath);
    const seenPeers = new Set(); // "ip:port" of peers we've already queued, so re-announces don't requeue the same peer
    const pendingPeers = [];
    let activeConnections = 0;
    let done = false;

    function maybeStartNext()
    {
        while(!done && activeConnections < MAX_CONCURRENT_PEERS && pendingPeers.length)
        {
            const peer = pendingPeers.shift();
            activeConnections++;
            download(peer, torrent, pieces, files, onDone, onPeerConnectionEnded);
        }
    }

    function onPeerConnectionEnded()
    {
        activeConnections--;
        maybeStartNext();
    }

    const stopAnnouncing = tracker.getPeers(torrent, peers => {
        if(done) return;
        peers.forEach(peer => {
            const key = `${peer.ip}:${peer.port}`;
            if(seenPeers.has(key)) return;
            seenPeers.add(key);
            pendingPeers.push(peer);
        });
        maybeStartNext();
    });

    const statusInterval = setInterval(() => {
        console.log(`status: ${activeConnections} active connections, ${pendingPeers.length} peers waiting`);
    }, 15000);

    function onDone()
    {
        if(done) return;
        done = true;
        clearInterval(statusInterval);
        stopAnnouncing();
    }
};

// Opens (and creates, if necessary) every file described by the torrent, and returns an
// array of { fd, offset, length } entries, where `offset` is that file's starting byte
// position within the whole concatenated torrent data stream. This lets us translate a
// piece/block's absolute offset into the right file(s) and in-file position.
function openFiles(torrent, destPath)
{
    const isMultiFile = !!torrent.info.files;

    if (!isMultiFile)
    {
        const filePath = destPath || torrent.info.name.toString('utf8');
        const fd = fs.openSync(filePath, 'w');
        return [{
            fd,
            offset: 0,
            length: torrent.info.length
        }];
    }

    // Multi-file torrent: everything lives inside a top-level directory named after
    // torrent.info.name (or the destPath the caller supplied).
    const rootDir = destPath || torrent.info.name.toString('utf8');
    fs.mkdirSync(rootDir, { recursive: true });

    let offset = 0;
    return torrent.info.files.map(file => {
        const segments = file.path.map(segment => segment.toString('utf8'));
        const fullPath = path.join(rootDir, ...segments);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });

        const fd = fs.openSync(fullPath, 'w');
        const entry = { fd, offset, length: file.length };
        offset += file.length;
        return entry;
    });
}

// Writes `block` to whichever file(s) it overlaps, given its absolute offset within the
// concatenated torrent data stream. A block can straddle a file boundary (e.g. the last
// block of file A and the first block of file B may land in the same 16KB request), so it
// may need to be split across more than one file descriptor.
function writeBlock(files, absOffset, block)
{
    const blockEnd = absOffset + block.length;

    files.forEach(file => {
        const fileEnd = file.offset + file.length;
        // This file isn't touched by the block at all - skip it.
        if (blockEnd <= file.offset || absOffset >= fileEnd) return;

        const sliceStart = Math.max(absOffset, file.offset);
        const sliceEnd = Math.min(blockEnd, fileEnd);

        const blockSlice = block.slice(sliceStart - absOffset, sliceEnd - absOffset);
        const filePosition = sliceStart - file.offset;

        fs.write(file.fd, blockSlice, 0, blockSlice.length, filePosition, err => {
            if (err) console.log('write error:', err.message);
        });
    });
}

function download(peer, torrent, pieces, files, onDone, onPeerConnectionEnded)
{
    const peerLabel = `${peer.ip}:${peer.port}`;
    const socket = new net.Socket();
    const connState = { inFlight: 0 };

    // Fires exactly once no matter how the connection ends (error, choke-destroy, natural
    // close, timeout) - this is our single point for returning the connection slot to the pool.
    let ended = false;
    socket.once('close', () => {
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
        console.log(`connected to peer ${peerLabel}`);
        socket.write(message.buildHandShake(torrent));
    });
    const queue = new Queue(torrent);
    // the socket might recieve part of message or multiple message at once. so every message start with its length to help find out the start and end of the message
    onWholeMsg(socket, msg => msgHandler(msg, socket, pieces, queue, torrent, files, peerLabel, onDone, connState));
}

function msgHandler(msg, socket, pieces, queue, torrent, files, peerLabel, onDone, connState)
{
    // Multiple whole messages can arrive in the same TCP read and get processed in one
    // synchronous batch (see onWholeMsg's while loop). If an earlier message in that batch
    // already caused us to tear down this connection, don't act on anything after it -
    // otherwise we can try to write to a socket we've already destroyed/ended.
    if(socket.destroyed) return;

    if(isHandShake(msg))
    {
        console.log(`handshake ok with ${peerLabel}`);
        socket.write(message.buildInterested());
    }
    else
    {
        const m = message.parse(msg);

        if(m.id === 0) chokeHandler(socket, peerLabel, queue, connState);
        if(m.id === 1) unchokeHandler(socket, pieces, queue, peerLabel, connState);
        if(m.id === 4) haveHandler(socket, pieces, queue, m.payload, connState);
        if(m.id === 5) bitfieldHandler(socket, pieces, queue, m.payload, connState);
        if(m.id === 7) pieceHandler(socket, pieces, queue, torrent, files, m.payload, onDone, connState);
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
    queue.choked = true; // Stay connected, just stop asking for pieces

    // The peer threw away our pending request, so rest our counter
    connState.inFlight = 0;
}

function unchokeHandler(socket, pieces, queue, peerLabel, connState)
{
    console.log(`unchoked by ${peerLabel}, starting requests`);
    queue.choked = false;
    requestPiece(socket, pieces, queue, connState);
}

function haveHandler(socket, pieces, queue, payload, connState)
{
    const pieceIndex = payload.readUInt32BE(0);
    const queueEmpty = queue.length === 0;
    queue.queue(pieceIndex);
    if(queueEmpty) requestPiece(socket, pieces, queue, connState);
}

function bitfieldHandler(socket, pieces, queue, payload, connState)
{
    const queueEmpty = queue.length === 0;
    payload.forEach((byte, i) => {
        for(let j = 0; j < 8; j++)
        {
            if(byte % 2) queue.queue(i * 8 + 7 - j);
            byte = Math.floor(byte/2);
        }
    });
    if(queueEmpty) requestPiece(socket, pieces, queue, connState);
}

function pieceHandler(socket, pieces, queue, torrent, files, pieceResp, onDone, connState)
{
    connState.inFlight = Math.max(0, connState.inFlight - 1);

    console.log(`Received 16KB block from piece ${pieceResp.index}`);

    pieces.printPercentDone();

    pieces.addReceived(pieceResp);

    const offset = pieceResp.index * torrent.info['piece length'] + pieceResp.begin;
    writeBlock(files, offset, pieceResp.block);

    if(pieces.isDone())
    {
        console.log('Done!');
        socket.end();
        try { files.forEach(f => fs.closeSync(f.fd)); } catch(e) {}
        if(onDone) onDone();
    }
    else
    {
        requestPiece(socket, pieces, queue, connState);
    }
}

// Keeps up to MAX_IN_FLIGHT_REQUESTS block requests outstanding on this connection at
// once, instead of waiting for each block to arrive before asking for the next.
function requestPiece(socket, pieces, queue, connState)
{
    if(queue.choked) return;

    while(connState.inFlight < MAX_IN_FLIGHT_REQUESTS && queue.length())
    {
        const pieceBlock = queue.dequeue();
        if(pieces.needed(pieceBlock))
        {
            socket.write(message.buildRequest(pieceBlock));
            pieces.addRequested(pieceBlock);
            connState.inFlight++;
        }
    }
}

// Every time the socket recieves data, the socket.on callback is called. It concats the new data
//  with savedBuf and as long as savedBuf is long enough to contain at least one whole message,
// it will pass it to the onWholeMsg callback and then update savedBuf by slicing out those
// messages. Basically savedBuf saves the pieces of incomplete messages between rounds of
// receiving data from the socket.

// Also the handshake is the first message we will recieve. That's why we start with handshake
// set to true, and then the first time we receive a whole message we set it to false.

//the onWholeMsg function is only getting called once, so the savedBuf and handshake variables
// are only initialized once. But then the socket.on callback gets called multiple times, each
// time getting and setting the same two variables.
function onWholeMsg(socket, callback)
{
    let savedBuf = Buffer.alloc(0);
    let handshake = true;

    socket.on('data', recvBuffer => {
        // msgLen calculates the length of whole message
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