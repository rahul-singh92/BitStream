'use strict';
const tp = require('./torrent-parser');

module.exports = class {
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
        const nPieces = this._torrent.info.pieces.length / 20;
        if(pieceIndex >= nPieces) return;

        // Prevent pushing duplicates of pieces we already have or already queued from this peer
        if (!this._peerPieces.includes(pieceIndex) && !this._pieces.isPieceDone(pieceIndex)) {
            this._peerPieces.push(pieceIndex);
        }

        this._pieces.addPeerPiece(pieceIndex);
    }

    dequeue() 
    { 
        // 1. Finish the piece we are currently downloading
        if (this._currentPiece !== null) {
            const nBlocks = tp.blocksPerPiece(this._torrent, this._currentPiece);
            for(let i = 0; i < nBlocks; i++) {
                const pieceBlock = {
                    index: this._currentPiece,
                    begin: i * tp.BLOCK_LEN,
                    length: tp.blockLen(this._torrent, this._currentPiece, i)
                };
                
                if (this._pieces.needed(pieceBlock)) {
                    return pieceBlock;
                }
            }
            this._currentPiece = null;
        }

        // 2. RAREST FIRST ALGORITHM (Clean out completed pieces first)
        this._peerPieces = this._peerPieces.filter(pIndex => !this._pieces.isPieceDone(pIndex));

        let rarestPiece = null;
        let rarestFreq = Infinity;
        let rarestIndexInArray = -1;

        for (let i = 0; i < this._peerPieces.length; i++) {
            const pieceIndex = this._peerPieces[i];
            const freq = this._pieces.getPieceFreq(pieceIndex);
            if (freq < rarestFreq) {
                rarestFreq = freq;
                rarestPiece = pieceIndex;
                rarestIndexInArray = i;
            }
        }

        if (rarestPiece !== null) {
            this._peerPieces.splice(rarestIndexInArray, 1);
            this._currentPiece = rarestPiece;
            return this.dequeue();
        }

        // 3. END GAME MODE
        // If we ran out of unique pieces, scan all missing blocks across the entire torrent
        // and race them against all connected peers simultaneously.
        for (let p = 0; p < this._pieces._requested.length; p++) {
            if (!this._pieces.isPieceDone(p)) {
                const blocks = this._pieces._requested[p];
                for (let b = 0; b < blocks.length; b++) {
                    const blockIndex = b * tp.BLOCK_LEN;
                    const pieceBlock = {
                        index: p,
                        begin: blockIndex,
                        length: tp.blockLen(this._torrent, p, b)
                    };
                    if (this._pieces.needed(pieceBlock)) {
                        return pieceBlock;
                    }
                }
            }
        }

        return null;
    }

    length() { 
        return (this._currentPiece !== null || this._peerPieces.length > 0 || !this._pieces.isDone()) ? 1 : 0; 
    }
};