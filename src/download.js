'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const Buffer = require('buffer').Buffer;
const tracker = require('./tracker');
const message = require('./message');
const Pieces = require('./Pieces');
const Queue = require('./Queue');

module.exports = (torrent, destPath) => {
    tracker.getPeers(torrent, peers => {
        // The torrent.info.pieces is a buffer that contains 20-byte SHA-1 hash of each piece,
        // and the length gives you the total number of bytes in the buffer. That's why we divide
        // by 20 to get the total number of pieces.
        const pieces = new Pieces(torrent);
        const files = openFiles(torrent, destPath);
        peers.forEach(peer => download(peer, torrent, pieces, files));
    });
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
        // This file isn't touched by the block at all — skip it.
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

function download(peer, torrent, pieces, files)
{
    const socket = new net.Socket();
    socket.on('error', err => console.log('socket error:', err.message));
    socket.connect(peer.port, peer.ip, () => {
        socket.write(message.buildHandShake(torrent));
    });
    const queue = new Queue(torrent);
    // the socket might recieve part of message or multiple message at once. so every message start with its length to help find out the start and end of the message
    onWholeMsg(socket, msg => msgHandler(msg, socket, pieces, queue, torrent, files));
}

function msgHandler(msg, socket, pieces, queue, torrent, files)
{
    if(isHandShake(msg)) socket.write(message.buildInterested());
    else
    {
        const m = message.parse(msg);

        if(m.id === 0) chokeHandler(socket);
        if(m.id === 1) unchokeHandler(socket, pieces, queue);
        if(m.id === 4) haveHandler(socket, pieces, queue, m.payload);
        if(m.id === 5) bitfieldHandler(socket, pieces, queue, m.payload);
        if(m.id === 7) pieceHandler(socket, pieces, queue, torrent, files, m.payload);
    }
}

function isHandShake(msg)
{
    return msg.length === msg.readUInt8(0) + 49 &&
           msg.toString('utf8', 1, 20) === 'BitTorrent protocol';
}

function chokeHandler(socket)
{
    socket.end();
}

function unchokeHandler(socket, pieces, queue)
{
    queue.choked = false;
    requestPiece(socket, pieces, queue);
}

function haveHandler(socket, pieces, queue, payload)
{
    const pieceIndex = payload.readUInt32BE(0);
    const queueEmpty = queue.length === 0;
    queue.queue(pieceIndex);
    if(queueEmpty) requestPiece(socket, pieces, queue);
}

function bitfieldHandler(socket, pieces, queue, payload)
{
    const queueEmpty = queue.length === 0;
    payload.forEach((byte, i) => {
        for(let j = 0; j < 8; j++)
        {
            if(byte % 2) queue.queue(i * 8 + 7 - j);
            byte = Math.floor(byte/2);
        }
    });
    if(queueEmpty) requestPiece(socket, pieces, queue);
}

function pieceHandler(socket, pieces, queue, torrent, files, pieceResp)
{
    pieces.printPercentDone();

    pieces.addReceived(pieceResp);

    const offset = pieceResp.index * torrent.info['piece length'] + pieceResp.begin;
    writeBlock(files, offset, pieceResp.block);

    if(pieces.isDone())
    {
        console.log('Done!');
        socket.end();
        try { files.forEach(f => fs.closeSync(f.fd)); } catch(e) {}
    }
    else
    {
        requestPiece(socket, pieces, queue);
    }
}

function requestPiece(socket, pieces, queue)
{
    if(queue.choked) return null;

    while(queue.length())
    {
        const pieceBlock = queue.dequeue();
        if(pieces.needed(pieceBlock))
        {
            socket.write(message.buildRequest(pieceBlock));
            pieces.addRequested(pieceBlock);
            break;
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