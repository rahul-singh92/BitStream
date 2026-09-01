'use strict';

const tp = require('./torrent-parser');

module.exports = class {
    constructor(torrent)
    {
        this._torrent = torrent;
        this._peerPieces = []; // Stores just the piece indexes the peer has
        this._blockQueue = []; // Stores the 16KB blocks for the current piece
        this.choked = true;
    }

    queue(pieceIndex)
    {
        // Don't generate blocks yet. Just remember the peer has this piece.
        this._peerPieces.push(pieceIndex);
    }

    dequeue() 
    { 
        // If we have blocks ready to request, return one
        if (this._blockQueue.length > 0) {
            return this._blockQueue.shift();
        }

        // If block queue is empty, grab the next piece the peer has
        if (this._peerPieces.length === 0) {
            return null;
        }

        const pieceIndex = this._peerPieces.shift();
        const nBlocks = tp.blocksPerPiece(this._torrent, pieceIndex);
        
        // Generate the blocks ONLY for this specific piece
        for(let i = 0; i < nBlocks; i++)
        {
            const pieceBlock = {
                index: pieceIndex,
                begin: i * tp.BLOCK_LEN,
                length: tp.blockLen(this._torrent, pieceIndex, i)
            };
            this._blockQueue.push(pieceBlock);
        }

        return this._blockQueue.shift();
    }

    peek() { 
        return this._blockQueue.length > 0 ? this._blockQueue[0] : null; 
    }

    length() { 
        // We have work to do if there are blocks queued OR pieces left to process
        return this._blockQueue.length + this._peerPieces.length; 
    }
};