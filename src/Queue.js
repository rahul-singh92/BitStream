'use strict';
const tp = require('./torrent-parser');

module.exports = class {
    // Notice we now pass 'pieces' into the constructor
    constructor(torrent, pieces) 
    {
        this._torrent = torrent;
        this._pieces = pieces; 
        this._peerPieces = [];
        this.choked = true;
        this._currentPiece = null;
    }

    queue(pieceIndex)
    {
        this._peerPieces.push(pieceIndex);
    }

    dequeue() 
    { 
        // 1. If we are currently downloading a piece, find its next missing block
        if (this._currentPiece !== null) {
            const nBlocks = tp.blocksPerPiece(this._torrent, this._currentPiece);
            for(let i = 0; i < nBlocks; i++) {
                const pieceBlock = {
                    index: this._currentPiece,
                    begin: i * tp.BLOCK_LEN,
                    length: tp.blockLen(this._torrent, this._currentPiece, i)
                };
                
                // Ask Pieces.js if we still need this specific block
                if (this._pieces.needed(pieceBlock)) {
                    return pieceBlock;
                }
            }
            // If we get here, the piece is fully requested. Clear it so we pick a new one.
            this._currentPiece = null;
        }

        // 2. Pick a new random piece to avoid traffic jams!
        while (this._peerPieces.length > 0) {
            const randomIndex = Math.floor(Math.random() * this._peerPieces.length);
            const pieceIndex = this._peerPieces.splice(randomIndex, 1)[0];
            
            // Make sure the piece isn't already fully downloaded by someone else
            if (!this._pieces.isPieceDone(pieceIndex)) {
                this._currentPiece = pieceIndex;
                return this.dequeue(); // Recursively grab the first block
            }
        }

        return null; // Peer has nothing else we need
    }

    length() { 
        return (this._currentPiece !== null || this._peerPieces.length > 0) ? 1 : 0; 
    }
};