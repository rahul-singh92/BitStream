'use strict';

const tp = require('./torrent-parser');

// How long a block request may stay unanswered before we allow it to be requested again
// (from this or another peer). 3s was too aggressive: with dozens of blocks in flight on
// a slow peer, perfectly healthy requests were being duplicated.
const REQUEST_TIMEOUT_MS = 20000;

// Per-piece, per-block bookkeeping:
//   _requested[p][b]  - a request for this block is (believed to be) in flight or done
//   _received[p][b]   - the block's data has arrived and been written to disk
//   _verified[p]      - every block arrived AND the piece's SHA-1 matched the torrent
// A piece only counts as finished (isDone / getPercent) once it is verified.
module.exports = class {
    constructor(torrent)
    {
        const nPieces = torrent.info.pieces.length / 20;
        const build = init => Array.from({ length: nPieces }, (_, i) =>
            new Array(tp.blocksPerPiece(torrent, i)).fill(init));

        this._requested = build(false);
        this._received = build(false);
        this._reqToken = build(0); // identifies the latest request of each block (see addRequested)
        this._reqSeq = 0;

        this._verified = new Array(nPieces).fill(false);
        this._verifiedCount = 0;

        this._pieceFreq = new Array(nPieces).fill(0);

        // Which pieces we actually want. By default all of them; with selective download only
        // the pieces that overlap a selected file (see setWanted).
        this._wanted = new Array(nPieces).fill(true);
        this._wantedCount = nPieces;

        // "Border" pieces: wanted pieces that also contain bytes of a skipped file. Their
        // blocks are kept in memory until the piece is verified, so nothing is ever written
        // into a file the user did not select (see download.js).
        this.stats = { downloaded: 0, wasted: 0 }; // payload bytes received / thrown away

        this.boundary = new Set();
        this.buffers = new Map(); // piece index -> Buffer holding the blocks received so far
    }

    setWanted(wanted)
    {
        this._wanted = wanted.slice();
        this._wantedCount = this._wanted.filter(Boolean).length;
    }

    isWanted(pieceIndex)
    {
        return this._wanted[pieceIndex] === true;
    }

    haveCount() { return this._verifiedCount; }
    wantedCount() { return this._wantedCount; }

    hasPiece(pieceIndex)
    {
        return Number.isInteger(pieceIndex) && pieceIndex >= 0 && pieceIndex < this._received.length;
    }

    addRequested(pieceBlock)
    {
        const index = pieceBlock.index;
        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        if(!this._requested[index]) return;

        this._requested[index][blockIndex] = true;

        // If the block still hasn't arrived after the timeout, clear its *requested* flag
        // (not the received flag) so needed() hands it out again. The token makes sure a
        // stale timer from an earlier request can't cancel a newer one.
        const token = ++this._reqSeq;
        this._reqToken[index][blockIndex] = token;

        const timer = setTimeout(() => {
            if(this._reqToken[index][blockIndex] === token && !this._received[index][blockIndex])
            {
                this._requested[index][blockIndex] = false;
            }
        }, REQUEST_TIMEOUT_MS);
        timer.unref(); // never keep the process alive just for this
    }

    addReceived(pieceBlock)
    {
        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        if(this._received[pieceBlock.index])
        {
            this._received[pieceBlock.index][blockIndex] = true;
        }
    }

    // All blocks of the piece have arrived (says nothing about whether the data is valid).
    isPieceDone(pieceIndex)
    {
        if(!this._received[pieceIndex]) return false;
        return this._received[pieceIndex].every(i => i);
    }

    isVerified(pieceIndex)
    {
        return this._verified[pieceIndex] === true;
    }

    // Piece passed its hash check (or was recovered from disk and matched).
    markVerified(pieceIndex)
    {
        if(!this._received[pieceIndex]) return;
        this._received[pieceIndex].fill(true);
        this._requested[pieceIndex].fill(true);
        this.buffers.delete(pieceIndex);
        if(!this._verified[pieceIndex])
        {
            this._verified[pieceIndex] = true;
            if(this._wanted[pieceIndex]) this._verifiedCount++;
        }
    }

    // Piece failed its hash check: forget everything about it so it gets downloaded again.
    resetPiece(pieceIndex)
    {
        if(!this._received[pieceIndex]) return;
        this._received[pieceIndex].fill(false);
        this._requested[pieceIndex].fill(false);
        this._reqToken[pieceIndex].fill(0); // invalidates any pending request timers
        this.buffers.delete(pieceIndex);
        if(this._verified[pieceIndex])
        {
            this._verified[pieceIndex] = false;
            if(this._wanted[pieceIndex]) this._verifiedCount--;
        }
    }

    needed(pieceBlock)
    {
        if(!pieceBlock) return false;
        if(!this._wanted[pieceBlock.index]) return false; // belongs only to files we skipped

        // Every wanted block has been requested at least once but not everything has arrived:
        // forget the outstanding requests so the missing blocks can be raced again.
        if(this._requested.every((blocks, p) => !this._wanted[p] || blocks.every(i => i)))
        {
            this._requested = this._received.map(blocks => blocks.slice());
        }
        if(!this._requested[pieceBlock.index]) return false;

        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        return !this._requested[pieceBlock.index][blockIndex];
    }

    // True when every piece from `first` to `last` (inclusive) is hash-verified.
    // An empty range (last < first, e.g. a zero-byte file) counts as verified.
    rangeVerified(first, last)
    {
        for(let i = first; i <= last; i++)
        {
            if(!this._verified[i]) return false;
        }
        return true;
    }

    // Done when every *wanted* piece has been hash-verified.
    isDone()
    {
        return this._verifiedCount === this._wantedCount;
    }

    getPercent()
    {
        if(this._wantedCount === 0) return 100;
        return (this._verifiedCount / this._wantedCount) * 100;
    }

    printPercentDone()
    {
        process.stdout.write('progress: ' + this.getPercent().toFixed(2) + '% (verified)\r');
    }

    addPeerPiece(pieceIndex)
    {
        if(this._pieceFreq[pieceIndex] !== undefined) this._pieceFreq[pieceIndex]++;
    }

    getPieceFreq(pieceIndex)
    {
        return this._pieceFreq[pieceIndex] || 0;
    }
};