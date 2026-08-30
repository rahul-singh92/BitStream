'use strict';

const fs = require('fs');
const tracker = require('./tracker');
const torrentParser = require('./torrent-parser');

const torrent = torrentParser.open("Marvel's Spider-Man 2 [FitGirl Repack].torrent")

console.log('Tracker:', torrent.announce.toString());

tracker.getPeers(torrent, peers => {
    console.log(`Found ${peers.length} peers:\n`);

    peers.forEach((peer, i) => {
        console.log(`${i + 1}. ${peer.ip}:${peer.port}`);
    });

    process.exit(0);
});
