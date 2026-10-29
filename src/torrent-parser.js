'use strict';

const fs = require('graceful-fs');
const bencode = require('bencode');
const crypto = require('crypto');

module.exports.open = (filepath) => {
    return bencode.decode(fs.readFileSync(filepath));
};

// Total size in bytes, as the 8-byte big-endian buffer the announce request needs.
// Uses native BigInt, so the old `bignum` native module (which has to be recompiled for
// Electron) is no longer needed.
module.exports.size = torrent => {
    const size = torrent.info.files
        ? torrent.info.files.map(file => file.length).reduce((a, b) => a + b) // multiple files
        : torrent.info.length; // single file
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(size), 0);
    return buf;
};

module.exports.infoHash = torrent => {
    const info = bencode.encode(torrent.info);
    return crypto.createHash('sha1').update(info).digest();
};

// block length is 2^14 bytes by convention
module.exports.BLOCK_LEN = Math.pow(2, 14);

module.exports.pieceLen = (torrent, pieceIndex) => {
    const totalLength = Number(this.size(torrent).readBigUInt64BE(0));
    const pieceLength = torrent.info['piece length'];

    const lastPieceLength = totalLength % pieceLength;
    const lastPieceIndex = Math.floor(totalLength / pieceLength);

    return lastPieceIndex === pieceIndex ? lastPieceLength : pieceLength;
};

module.exports.blocksPerPiece = (torrent, pieceIndex) => {
    const pieceLength = this.pieceLen(torrent, pieceIndex);
    return Math.ceil(pieceLength / this.BLOCK_LEN);
};

module.exports.blockLen = (torrent, pieceIndex, blockIndex) => {
    const pieceLength = this.pieceLen(torrent, pieceIndex);

    const lastPieceLength = pieceLength % this.BLOCK_LEN;
    const lastPieceIndex = Math.floor(pieceLength / this.BLOCK_LEN);

    return blockIndex === lastPieceIndex ? lastPieceLength : this.BLOCK_LEN;
};

module.exports.pieceHash = (torrent, pieceIndex) => {
    const start = pieceIndex * 20;
    const end = start + 20;
    return torrent.info.pieces.slice(start, end);
};