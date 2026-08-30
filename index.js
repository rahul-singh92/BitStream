'use strict';
const fs = require('fs');
const bencode = require('bencode');
const tracker = require('./tracker');

// const torrent = fs.readFileSync('puppy.torrent'); // It returns a buffer, not a string
const torrent = bencode.decode(fs.readFileSync('puppy.torrent'));
// console.log(torrent.announce.toString('utf8')); // This is the announce URL of the tracker i.e. Tracker's URL

tracker.getPeers(torrent, peers => {
    console.log('list of peers: ', peers);
});