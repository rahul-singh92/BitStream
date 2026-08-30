'use strict';

const dgram = require('dgram');
const Buffer = require('Buffer').Buffer;
const urlParse = require('url').parse;
const crypto = require('crypto');

module.exports.getPeers = (torrent, callback) => {
    const socket = dgram.createSocket('udp4');
    const url = torrent.announce.toString('utf8');

    udpSend(socket, buildConnReq(), url); // send the connection reques

    socket.on('message', response => {
        if(respType(response) == 'connect')
        {
            const connResp = parseConnReq(response); // recieve and parse connection response
            const announceReq = buildAnnounceReq(connResp.connectionId); // send announce request
            udpSend(socket, announceReq, url);
        }
        else if(respType(response) == 'announce')
        {
            const announceResp = parseAnnounceReq(response); // parse announce request
            callback(announceResp.peers); // pass peers to callback
        }
    });
};

function udpSend(socket, message, rawURL, callback = () => {})
{
    const url = urlParse(rawURL);
    socket.send(message, 0, message.length, url.port, url.host, callback);
}

function respType(resp)
{

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
    crypto.randomByte(4).copy(buf, 12);

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

function buildAnnounceReq(connId)
{

}

function parseAnnounceReq(resp)
{

}