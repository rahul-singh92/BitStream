'use strict';

const dgram = require('dgram');
const Buffer = require('buffer').Buffer;
const urlParse = require('url').parse;
const crypto = require('crypto');
const torrentParser = require('./torrent-parser');
const util = require('./util');

const CONNECT_RETRY_MS = 15000;
const MAX_CONNECT_RETRIES = 3; // retries per tracker before moving on to the next one
const MIN_ANNOUNCE_INTERVAL_S = 30;

// Collects every UDP tracker URL from the torrent (the primary `announce` field plus any
// backups in `announce-list`), de-duplicated. This client only speaks the UDP tracker
// protocol, so any http(s):// trackers in the list are skipped.
function collectTrackerUrls(torrent)
{
    const urls = [];

    if(torrent.announce) urls.push(torrent.announce.toString('utf8'));

    if(torrent['announce-list'])
    {
        torrent['announce-list'].forEach(tier => {
            tier.forEach(u => urls.push(u.toString('utf8')));
        });
    }

    const seen = new Set();
    return urls.filter(u => {
        if(!u.startsWith('udp://')) return false;
        if(seen.has(u)) return false;
        seen.add(u);
        return true;
    });
}

// Repeatedly announces to a tracker and hands each fresh batch of peers to `callback`.
// Tries every UDP tracker the torrent lists, in order, until one actually responds, then
// keeps using that one. Returns a `stop()` function the caller can invoke to cancel future
// re-announces and close the socket (e.g. once the download is complete).
module.exports.getPeers = (torrent, callback) => {
    const urls = collectTrackerUrls(torrent);

    if(urls.length === 0)
    {
        console.log('tracker: no UDP tracker URLs found in this torrent (only HTTP trackers listed?) - cannot fetch peers');
        return () => {};
    }

    console.log(`tracker: found ${urls.length} UDP tracker(s), trying ${urls[0]} first`);

    const socket = dgram.createSocket('udp4');

    let stopped = false;
    let trackerIndex = 0;
    let reannounceTimer = null;
    let connectRetryTimer = null;
    let connectRetries = 0;

    function currentUrl() { return urls[trackerIndex]; }

    function sendConnectReq()
    {
        if(stopped) return;
        const url = currentUrl();
        udpSend(socket, buildConnReq(), url);

        // UDP is unreliable - if we don't hear back, retry a few times before giving up
        // on this tracker and moving on to the next one in the list.
        clearTimeout(connectRetryTimer);
        connectRetryTimer = setTimeout(() => {
            if(stopped) return;
            connectRetries++;
            if(connectRetries > MAX_CONNECT_RETRIES)
            {
                connectRetries = 0;
                trackerIndex = (trackerIndex + 1) % urls.length;
                console.log(`tracker: no response from ${url}, trying next tracker: ${currentUrl()}`);
                sendConnectReq();
                return;
            }
            console.log(`tracker: no response yet from ${url}, retrying (attempt ${connectRetries + 1})`);
            sendConnectReq();
        }, CONNECT_RETRY_MS);
    }

    socket.on('error', err => console.log('tracker socket error:', err.message));

    socket.on('message', response => {
        if(stopped) return;

        if(respType(response) == 'connect')
        {
            clearTimeout(connectRetryTimer);
            connectRetries = 0;
            const connResp = parseConnReq(response); // recieve and parse connection response
            const announceReq = buildAnnounceReq(connResp.connectionId, torrent); // send announce request
            udpSend(socket, announceReq, currentUrl());
        }
        else if(respType(response) == 'announce')
        {
            const announceResp = parseAnnounceReq(response); // parse announce request
            console.log(`tracker (${currentUrl()}): ${announceResp.seeders} seeders, ${announceResp.leechers} leechers, ${announceResp.peers.length} peers returned, next announce in ${announceResp.interval}s`);
            callback(announceResp.peers); // pass peers to callback

            if(stopped) return;
            const nextAnnounceMs = Math.max(announceResp.interval, MIN_ANNOUNCE_INTERVAL_S) * 1000;
            clearTimeout(reannounceTimer);
            reannounceTimer = setTimeout(sendConnectReq, nextAnnounceMs);
        }
    });

    sendConnectReq();

    return function stop()
    {
        if(stopped) return;
        stopped = true;
        clearTimeout(reannounceTimer);
        clearTimeout(connectRetryTimer);
        try { socket.close(); } catch(e) {}
    };
};

function udpSend(socket, message, rawURL, callback = () => {})
{
    const url = urlParse(rawURL);
    const port = Number(url.port);
    socket.send(message, 0, message.length, port, url.hostname, callback);
}

function respType(resp)
{
    const action = resp.readUInt32BE(0);
    if(action == 0) return 'connect';
    if(action == 1) return 'announce';
}

// connection format
// Offset  Size            Name            Value
// 0       64-bit integer  connection_id   0x41727101980
// 8       32-bit integer  action          0 // connect
// 12      32-bit integer  transaction_id  ? // random
// 16
function buildConnReq()
{
    const buf = Buffer.alloc(16); // Reason because request require 64 bit(8 byte) + 32 bit(4 byte) + 32 bit(4 byte) = 16 byte

    // connection id
    // here 0x refers to the hexadecimal form and we need to write it in 2 writes because there is no method to write a 64 bit integer.
    buf.writeUInt32BE(0x417, 0);
    buf.writeUInt32BE(0x27101980, 4);
    // action
    buf.writeUInt32BE(0, 8);
    //transaction id
    crypto.randomBytes(4).copy(buf, 12);

    return buf;
}

// response format
// Offset  Size            Name            Value
// 0       32-bit integer  action          0 // connect
// 4       32-bit integer  transaction_id
// 8       64-bit integer  connection_id
// 16
function parseConnReq(resp)
{
    return{
        action: resp.readUInt32BE(0),
        transactionId: resp.readUInt32BE(4),
        connectionId: resp.slice(8)
    }
}

// Announce request
// Offset  Size    Name    Value
// 0       64-bit integer  connection_id
// 8       32-bit integer  action          1 // announce
// 12      32-bit integer  transaction_id
// 16      20-byte string  info_hash
// 36      20-byte string  peer_id
// 56      64-bit integer  downloaded
// 64      64-bit integer  left
// 72      64-bit integer  uploaded
// 80      32-bit integer  event           0 // 0: none; 1: completed; 2: started; 3: stopped
// 84      32-bit integer  IP address      0 // default
// 88      32-bit integer  key             ? // random
// 92      32-bit integer  num_want        -1 // default
// 96      16-bit integer  port            ? // should be betwee
// 98

function buildAnnounceReq(connId, torrent, port=6881) // default 6881-6889 for torrent
{
    const buf = Buffer.allocUnsafe(98);

    // connection id
    connId.copy(buf, 0);
    // action
    buf.writeUInt32BE(1, 8);
    // transaction ID
    crypto.randomBytes(4).copy(buf, 12);
    // info hash
    torrentParser.infoHash(torrent).copy(buf, 16);
    // peer ID
    util.genId().copy(buf, 36);
    // downloaded
    Buffer.alloc(8).copy(buf, 56);
    // left
    torrentParser.size(torrent).copy(buf, 64);
    // uploaded
    Buffer.alloc(8).copy(buf, 72);
    // event
    buf.writeUInt32BE(0, 80);
    // ip address
    buf.writeUInt32BE(0, 84); // unsigned int
    // key
    crypto.randomBytes(4).copy(buf, 88);
    // num want
    buf.writeInt32BE(-1, 92); // int
    // port
    buf.writeUInt16BE(port, 96);

    return buf;
}

// Response
// Offset      Size            Name            Value
// 0           32-bit integer  action          1 // announce
// 4           32-bit integer  transaction_id
// 8           32-bit integer  interval
// 12          32-bit integer  leechers
// 16          32-bit integer  seeders
// 20 + 6 * n  32-bit integer  IP address
// 24 + 6 * n  16-bit integer  TCP port
// 20 + 6 * N

function parseAnnounceReq(resp)
{
    function group(iterable, groupSize)
    {
        let groups = [];
        for(let i = 0; i < iterable.length; i += groupSize)
        {
            groups.push(iterable.slice(i, i + groupSize));
        }
        return groups;
    }

    return {
        action: resp.readUInt32BE(0),
        transactionId: resp.readUInt32BE(4),
        interval: resp.readUInt32BE(8),
        leechers: resp.readUInt32BE(12),
        seeders: resp.readUInt32BE(16),
        peers: group(resp.slice(20), 6).map(address => {
            return {
                ip: address.slice(0, 4).join('.'),
                port: address.readUInt16BE(4)
            }
        })
    }
}