'use strict';

const download = require('./download');
const tp = require('./torrent-parser');

//Holds an array of arrays, where the inner arrays hold the status of a block at a give piece index.
module.exports = class {
    constructor(torrent)
    {
        function buildPiecesArray() {
            const nPieces = torrent.info.pieces.length / 20;
            const arr = new Array(nPieces).fill(null);
            return arr.map((_, i) => new Array(tp.blocksPerPiece(torrent, i)).fill(false));
        }
        this._requested = buildPiecesArray();
        this._received = buildPiecesArray();
    }

    addRequested(pieceBlock)
    {
        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        if(this._requested[pieceBlock.index])
        {
            this._requested[pieceBlock.index][blockIndex] = true;

            setTimeout(() => {
                if(this._received[pieceBlock.index] && !this._received[pieceBlock.index][blockIndex])
                {
                    this._received[pieceBlock.index][blockIndex] = false;
                }
            }, 3000);
        }
    }

    isPieceDone(pieceIndex)
    {
        if(!this._received[pieceIndex]) return false;
        return this._received[pieceIndex].every(i => i);
    }

    addReceived(pieceBlock)
    {
        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        if(this._received[pieceBlock.index])
        {
            this._received[pieceBlock.index][blockIndex] = true;
        }
    }

    needed(pieceBlock)
    {
        if(!pieceBlock) return false;

        if(this._requested.every(blocks => blocks.every(i => i)))
        {
            this._requested = this._received.map(blocks => blocks.slice());
        }
        if(!this._requested[pieceBlock.index]) return false;

        const blockIndex = pieceBlock.begin / tp.BLOCK_LEN;
        return !this._requested[pieceBlock.index][blockIndex];
    }

    isDone()
    {
        return this._received.every(blocks => blocks.every(i => i));
    }

    printPercentDone() 
    {
        const downloaded = this._received.reduce((totalBlocks, blocks) => {
            return blocks.filter(i => i).length + totalBlocks;
        }, 0);

        const total = this._received.reduce((totalBlocks, blocks) => {
            return blocks.length + totalBlocks;
        }, 0);

        const percent = (downloaded / total * 100).toFixed(2);

        process.stdout.write('progress: ' + percent + '%\r');
    }
};