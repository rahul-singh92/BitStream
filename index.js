'use strict';
// Terminal entry point (npm run cli). The Electron app starts from main.js instead.
const torrentParser = require('./src/torrent-parser');
const download = require('./src/download');

const torrent = torrentParser.open('big-buck-bunny.torrent');

download(torrent, undefined, {
    onProgress: p => process.stdout.write(`progress: ${p.percent.toFixed(2)}%\r`),
    onComplete: () => { console.log('\nDone!'); process.exit(0); }
});