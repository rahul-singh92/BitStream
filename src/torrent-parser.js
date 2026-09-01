'use strict';

// const fs = require('fs');
const fs = require('graceful-fs');
const bencode = require('bencode');
const crypto = require('crypto');
const bignum = require('bignum');

module.exports.open = (filepath) => {
    return bencode.decode(fs.readFileSync(filepath));
};

module.exports.size = torrent => {
    const size = torrent.info.files ? 
        torrent.info.files.map(file => file.length).reduce((a, b) => a + b) : // if it has multiple file
        torrent.info.length; // this is for one file 
    return bignum.toBuffer(size, {size: 8}); // to write in buffer size of 8 byte as rquired by announce request
};

module.exports.infoHash = torrent => {
    const info = bencode.encode(torrent.info);
    // use hash beacuse it is the compact way to uniquely identify the torrent
    // Also because it is very unlikely for two input to output same hash value, and because the input contains information about every piece of the torrent file, it is good to uniquely identify a torrent.
    return crypto.createHash('sha1').update(info).digest(); // SHA1 is used by bittorent. It return a fix length buffer
}

// piece length can be found in torrent file and block length is 2^14 bytes by convention

module.exports.BLOCK_LEN = Math.pow(2, 14);

module.exports.pieceLen = (torrent, pieceIndex) => {
    const totalLength = bignum.fromBuffer(this.size(torrent)).toNumber();
    const pieceLength = torrent.info['piece length'];

    const lastPieceLength = totalLength % pieceLength;
    const lastPieceIndex = Math.floor(totalLength/pieceLength);

    return lastPieceIndex === pieceIndex ? lastPieceLength : pieceLength;
};

module.exports.blocksPerPiece = (torrent, pieceIndex) => {
    const pieceLength = this.pieceLen(torrent, pieceIndex);
    return Math.ceil(pieceLength/this.BLOCK_LEN);
};

module.exports.blockLen = (torrent, pieceIndex, blockIndex) => {
    const pieceLength = this.pieceLen(torrent, pieceIndex);

    const lastPieceLength = pieceLength % this.BLOCK_LEN;
    const lastPieceIndex = Math.floor(pieceLength/this.BLOCK_LEN);

    return blockIndex === lastPieceIndex ? lastPieceLength : this.BLOCK_LEN;
};