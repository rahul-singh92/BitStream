'use strict';

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const Buffer = require('buffer').Buffer;
const crypto = require('crypto');
const bencode = require('bencode');
const torrentParser = require('./torrent-parser');
const util = require('./util');

const RESPONSE_TIMEOUT_MS = 15000;    // how long we wait for a tracker to answer
const RETRY_BASE_MS = 60000;          // first retry after a failure; doubles each time...
const RETRY_MAX_MS = 30 * 60000;      // ...up to this
const MIN_ANNOUNCE_INTERVAL_S = 30;
const MAX_ANNOUNCE_INTERVAL_S = 3600; // some trackers ask for absurdly long waits
const MAX_TRACKERS = 30;              // only talk to this many at once
const MAX_HTTP_RESPONSE = 2 * 1024 * 1024;
const ANNOUNCE_PORT = 6881;

// ---------------------------------------------------------------------------
// Which trackers can we talk to?
//   udp://   BEP 15 - binary UDP protocol
//   http://  https://   BEP 3 - HTTP GET with a bencoded reply (compact peers, IPv4 + IPv6)
//   ws://    wss://     WebTorrent trackers. Their peers connect over WebRTC, which a TCP
//                       client cannot use, so for these we only read the swarm size
//                       (seeders / leechers). Peers come from the other trackers, DHT and PeX.
// ---------------------------------------------------------------------------
const SUPPORTED = new Set(['udp', 'http', 'https', 'ws', 'wss']);
const schemeOf = url => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(url); return m ? m[1].toLowerCase() : ''; };

module.exports.isSupported = url => SUPPORTED.has(schemeOf(url));
module.exports.unsupportedReason = url => `Unsupported protocol (${schemeOf(url) || 'unknown'}://)`;

// Every tracker URL in the torrent (the primary `announce` plus `announce-list`), de-duplicated,
// whatever the protocol. Used by the Trackers tab so unsupported ones are still listed.
function allTrackerUrls(torrent)
{
    const urls = [];
    if(torrent.announce) urls.push(torrent.announce.toString('utf8').trim());
    if(torrent['announce-list'])
    {
        torrent['announce-list'].forEach(tier => {
            tier.forEach(u => urls.push(u.toString('utf8').trim()));
        });
    }
    return [...new Set(urls.filter(Boolean))];
}
module.exports.listTrackers = allTrackerUrls;

// Repeatedly announces to every supported tracker and hands each fresh batch of peers to
// `callback`. `onStatus(url, patch)` reports what is happening with each tracker (status, seeds,
// peers, next announce time, error message...). A tracker that fails is retried with an
// increasing delay instead of being given up on. Returns stop().
module.exports.getPeers = (torrent, callback, onStatus = () => {}) => {
    const usable = allTrackerUrls(torrent).filter(u => SUPPORTED.has(schemeOf(u)));

    if(usable.length === 0)
    {
        console.log('tracker: no supported tracker URLs in this torrent - peers can only come from DHT and PeX');
        return () => {};
    }

    const active = usable.slice(0, MAX_TRACKERS);
    usable.slice(MAX_TRACKERS).forEach(u =>
        onStatus(u, { status: 'Not used', message: `Only the first ${MAX_TRACKERS} trackers are used` }));

    const byScheme = {};
    active.forEach(u => { byScheme[schemeOf(u)] = (byScheme[schemeOf(u)] || 0) + 1; });
    console.log(`tracker: announcing to ${active.length} trackers (${Object.entries(byScheme).map(([k, n]) => `${n} ${k}`).join(', ')})`);

    const ctx = {
        torrent,
        infoHash: torrentParser.infoHash(torrent),
        peerId: util.genId(),
        left: Number(torrentParser.size(torrent).readBigUInt64BE(0)),
        port: ANNOUNCE_PORT
    };

    let stopped = false;
    const timers = new Set();
    const failures = new Map();   // url -> consecutive failures (drives the retry delay)
    const started = new Set();    // trackers that have already seen our "started" event
    const openWs = new Set();     // WebSocket connections currently open

    // ---------------- UDP: one shared socket, replies matched by transaction id ----------------
    let udp = null;
    const pending = new Map();    // transaction id -> { resolve, reject, timer }

    function udpSocket()
    {
        if(udp) return udp;
        udp = dgram.createSocket('udp4');
        udp.on('error', err => console.log('tracker socket error:', err.message));
        udp.on('message', response => {
            if(response.length < 8) return;
            const key = response.readUInt32BE(4);
            const p = pending.get(key);
            if(!p) return; // unknown or stale transaction
            pending.delete(key);
            clearTimeout(p.timer);
            if(response.readUInt32BE(0) === 3) p.reject(new Error(response.slice(8).toString('utf8') || 'Tracker returned an error'));
            else p.resolve(response);
        });
        return udp;
    }

    function udpExchange(url, buf, txId, noReplyMessage)
    {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const port = Number(u.port);
            if(!port) return reject(new Error('Tracker URL has no port'));

            const key = txId.readUInt32BE(0);
            const timer = setTimeout(() => { pending.delete(key); reject(new Error(noReplyMessage)); }, RESPONSE_TIMEOUT_MS);
            pending.set(key, { resolve, reject, timer });
            udpSocket().send(buf, 0, buf.length, port, u.hostname, err => {
                if(!err) return;
                clearTimeout(timer);
                pending.delete(key);
                reject(new Error(err.code || err.message));
            });
        });
    }

    async function announceUdp(url)
    {
        const t1 = crypto.randomBytes(4);
        const conn = await udpExchange(url, buildConnReq(t1), t1, 'No response from tracker');
        if(conn.length < 16 || conn.readUInt32BE(0) !== 0) throw new Error('Malformed connect response');

        const t2 = crypto.randomBytes(4);
        const reply = await udpExchange(url, buildAnnounceReq(parseConnReq(conn).connectionId, torrent, t2, ctx.port), t2, 'No response to announce');
        if(reply.length < 20 || reply.readUInt32BE(0) !== 1) throw new Error('Malformed announce response');

        const a = parseAnnounceReq(reply);
        return { interval: a.interval, seeders: a.seeders, leechers: a.leechers, peers: a.peers };
    }

    // ---------------- HTTP / HTTPS ----------------
    async function announceHttp(url)
    {
        const first = !started.has(url);
        const query = `info_hash=${percentEncode(ctx.infoHash)}&peer_id=${percentEncode(ctx.peerId)}` +
            `&port=${ctx.port}&uploaded=0&downloaded=0&left=${ctx.left}&compact=1&numwant=200` +
            (first ? '&event=started' : '');
        const body = await httpGet(url + (url.includes('?') ? '&' : '?') + query);
        const result = parseHttpAnnounce(body);
        started.add(url);
        return result;
    }

    // ---------------- WebSocket (WebTorrent trackers): swarm size only ----------------
    function announceWs(url)
    {
        return new Promise((resolve, reject) => {
            const WS = globalThis.WebSocket;
            if(!WS) return reject(new Error('WebSocket is not available in this runtime'));

            let ws;
            try { ws = new WS(url); } catch(e) { return reject(new Error('Invalid WebSocket URL')); }
            openWs.add(ws);

            let settled = false;
            let timer = null;
            const finish = (fn, value) => {
                if(settled) return;
                settled = true;
                clearTimeout(timer);
                openWs.delete(ws);
                try { ws.close(); } catch(e) {}
                fn(value);
            };
            timer = setTimeout(() => finish(reject, new Error('No response from tracker')), RESPONSE_TIMEOUT_MS);

            ws.onopen = () => {
                try {
                    // numwant 0 + no WebRTC offers: we only want the swarm counts back
                    ws.send(JSON.stringify({
                        action: 'announce',
                        info_hash: ctx.infoHash.toString('binary'),
                        peer_id: ctx.peerId.toString('binary'),
                        numwant: 0, uploaded: 0, downloaded: 0, left: ctx.left,
                        event: 'started', offers: []
                    }));
                } catch(e) { finish(reject, e); }
            };
            ws.onmessage = ev => {
                let data;
                try { data = JSON.parse(String(ev.data)); } catch(e) { return; }
                if(data['failure reason']) return finish(reject, new Error(String(data['failure reason'])));
                if(data.action === 'announce' && (data.complete !== undefined || data.incomplete !== undefined))
                {
                    finish(resolve, {
                        interval: Number(data.interval) || 120,
                        seeders: data.complete, leechers: data.incomplete, peers: [],
                        note: 'WebRTC tracker: only the swarm size is used (its peers need WebRTC)'
                    });
                }
            };
            ws.onerror = () => finish(reject, new Error('WebSocket connection failed'));
            ws.onclose = () => finish(reject, new Error('Tracker closed the connection'));
        });
    }

    const announcers = { udp: announceUdp, http: announceHttp, https: announceHttp, ws: announceWs, wss: announceWs };

    // ---------------- the loop every tracker goes through, whatever its protocol ----------------
    function later(url, ms)
    {
        const t = setTimeout(() => { timers.delete(t); cycle(url); }, ms);
        timers.add(t);
    }

    function fail(url, reason)
    {
        const n = (failures.get(url) || 0) + 1;
        failures.set(url, n);
        const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, n - 1));
        console.log(`tracker (${url}): ${reason} - retrying in ${Math.round(wait / 1000)}s`);
        onStatus(url, { status: 'Not working', message: reason, nextAnnounce: Date.now() + wait });
        later(url, wait);
    }

    async function cycle(url)
    {
        if(stopped) return;
        onStatus(url, { status: 'Updating', message: '' });
        try
        {
            const r = await announcers[schemeOf(url)](url);
            if(stopped) return;

            failures.delete(url);
            const seconds = Math.min(MAX_ANNOUNCE_INTERVAL_S, Math.max(Number(r.interval) || 1800, MIN_ANNOUNCE_INTERVAL_S));
            const now = Date.now();
            console.log(`tracker (${url}): ${r.seeders == null ? '?' : r.seeders} seeders, ${r.leechers == null ? '?' : r.leechers} leechers, ${r.peers.length} peers returned`);
            onStatus(url, {
                status: 'Working', message: r.note || '',
                seeds: r.seeders == null ? null : r.seeders,
                peers: r.leechers == null ? null : r.leechers,
                returned: r.peers.length,
                lastAnnounce: now, nextAnnounce: now + seconds * 1000
            });

            if(r.peers.length) callback(r.peers);
            later(url, seconds * 1000);
        }
        catch(err)
        {
            if(!stopped) fail(url, err.message || String(err));
        }
    }

    active.forEach(url => cycle(url));

    return function stop()
    {
        if(stopped) return;
        stopped = true;
        timers.forEach(t => clearTimeout(t));
        timers.clear();
        pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('stopped')); });
        pending.clear();
        openWs.forEach(ws => { try { ws.close(); } catch(e) {} });
        openWs.clear();
        if(udp) { try { udp.close(); } catch(e) {} }
    };
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// info_hash and peer_id are raw bytes, so every byte is percent-encoded by hand
// (URLSearchParams would treat them as text and corrupt them).
function percentEncode(buf)
{
    let out = '';
    for(const b of buf) out += '%' + b.toString(16).padStart(2, '0');
    return out;
}

function httpGet(urlStr, redirectsLeft = 3)
{
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch(e) { return reject(new Error('Invalid tracker URL')); }
        const lib = u.protocol === 'https:' ? https : http;

        const req = lib.get(urlStr, {
            headers: { 'User-Agent': 'BitStream/1.0', 'Accept-Encoding': 'identity' },
            timeout: RESPONSE_TIMEOUT_MS
        }, res => {
            if([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location)
            {
                res.resume();
                if(redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                return resolve(httpGet(new URL(res.headers.location, urlStr).toString(), redirectsLeft - 1));
            }
            if(res.statusCode !== 200)
            {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if(size > MAX_HTTP_RESPONSE) return req.destroy(new Error('Response too large'));
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });

        req.on('timeout', () => req.destroy(new Error('No response from tracker')));
        req.on('error', err => reject(new Error(
            err.code === 'ECONNREFUSED' ? 'Connection refused'
            : err.code === 'ENOTFOUND' ? 'Host not found'
            : err.message)));
    });
}

function parseHttpAnnounce(body)
{
    let d;
    try { d = bencode.decode(body); } catch(e) { throw new Error('Invalid tracker response'); }
    if(!d || typeof d !== 'object') throw new Error('Invalid tracker response');
    if(d['failure reason']) throw new Error(d['failure reason'].toString('utf8'));

    const peers = [];
    const add = (ip, port) => { if(ip && port > 0 && port < 65536 && ip !== '0.0.0.0') peers.push({ ip, port }); };

    if(Buffer.isBuffer(d.peers))
    {
        // compact: 4 bytes IPv4 + 2 bytes port, repeated
        for(let i = 0; i + 6 <= d.peers.length; i += 6) add(d.peers.slice(i, i + 4).join('.'), d.peers.readUInt16BE(i + 4));
    }
    else if(Array.isArray(d.peers))
    {
        // the older, non-compact form: a list of { ip, port }
        d.peers.forEach(p => { if(p && p.ip) add(p.ip.toString('utf8'), p.port); });
    }

    if(Buffer.isBuffer(d.peers6))
    {
        // compact IPv6: 16 bytes address + 2 bytes port
        for(let i = 0; i + 18 <= d.peers6.length; i += 18)
        {
            const hex = d.peers6.slice(i, i + 16).toString('hex');
            add(hex.match(/.{4}/g).join(':'), d.peers6.readUInt16BE(i + 16));
        }
    }

    return {
        interval: typeof d.interval === 'number' ? d.interval : 1800,
        seeders: typeof d.complete === 'number' ? d.complete : null,
        leechers: typeof d.incomplete === 'number' ? d.incomplete : null,
        peers
    };
}

// ---------------------------------------------------------------------------
// UDP tracker packets (BEP 15)
// ---------------------------------------------------------------------------

// connection format
// Offset  Size            Name            Value
// 0       64-bit integer  connection_id   0x41727101980
// 8       32-bit integer  action          0 // connect
// 12      32-bit integer  transaction_id  ? // random
// 16
function buildConnReq(transactionId)
{
    const buf = Buffer.alloc(16);

    // there is no method to write a 64 bit integer, so it takes two 32-bit writes
    buf.writeUInt32BE(0x417, 0);
    buf.writeUInt32BE(0x27101980, 4);
    buf.writeUInt32BE(0, 8);       // action: connect
    transactionId.copy(buf, 12);

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
    return {
        action: resp.readUInt32BE(0),
        transactionId: resp.readUInt32BE(4),
        connectionId: resp.slice(8)
    };
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
// 96      16-bit integer  port            ? // should be between 6881-6889
// 98
function buildAnnounceReq(connId, torrent, transactionId, port = 6881)
{
    const buf = Buffer.allocUnsafe(98);

    connId.copy(buf, 0);
    buf.writeUInt32BE(1, 8);                         // action: announce
    transactionId.copy(buf, 12);
    torrentParser.infoHash(torrent).copy(buf, 16);
    util.genId().copy(buf, 36);
    Buffer.alloc(8).copy(buf, 56);                   // downloaded
    torrentParser.size(torrent).copy(buf, 64);       // left
    Buffer.alloc(8).copy(buf, 72);                   // uploaded
    buf.writeUInt32BE(0, 80);                        // event
    buf.writeUInt32BE(0, 84);                        // ip address
    crypto.randomBytes(4).copy(buf, 88);             // key
    buf.writeInt32BE(-1, 92);                        // num want
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
function parseAnnounceReq(resp)
{
    function group(iterable, groupSize)
    {
        const groups = [];
        for(let i = 0; i + groupSize <= iterable.length; i += groupSize)
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
        peers: group(resp.slice(20), 6).map(address => ({
            ip: address.slice(0, 4).join('.'),
            port: address.readUInt16BE(4)
        }))
    };
}