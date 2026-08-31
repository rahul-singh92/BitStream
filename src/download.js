'use strict';

const net = require('net');
const Buffer = require('buffer').Buffer;
const tracker = require('./tracker');
const message = require('./message');

module.exports = torrent => {
    const requested = [];
    tracker.getPeers(torrent, peers => {
        peers.forEach(peer => download(peer, torrent, requested));
    });
};

function download(peer, torrent, requested)
{
    const socket = new net.Socket();
    const queue = [];
    socket.on('error', console.log);
    socket.connect(peer.port, peer.ip, () => {
        socket.write(message.buildHandShake(torrent));
    });
    // the socket might recieve part of message or multiple message at once. so every message start with its length to help find out the start and end of the message
    onWholeMsg(socket, msg => msgHandler(msg, socket, requested, queue));
}

function msgHandler(msg, socket, requested)
{
    if(isHandShake(msg)) socket.write(message.buildInterested());
    else
    {
        const m = message.parse(msg);

        if(m.id === 0) chokeHandler();
        if(m.id === 1) unchokeHandler();
        if(m.id === 4) haveHandler(m.payload, socket, requested, queue);
        if(m.id === 5) bitfieldHandler(m.payload);
        if(m.id === 7) pieceHandler(m.payload, socket, requested, queue);
    }
}

function isHandShake(msg)
{
    return msg.length === msg.readUInt8(0) + 49 && 
           msg.toString('utf8', 1) === 'BitTorrent protocol';
}

function chokeHandler()
{

}

function unchokeHandler()
{

}

function haveHandler(payload, socket, requested, queue)
{
    const pieceIndex = payload.readUInt32BE(0);
    queue.push(pieceIndex);
    if(queue.length === 1)
    {
        requestPiece(socket, requested, queue);
    }
    if(!requested[pieceIndex])
    {
        socket.write(message.buildRequest());
    }
    requested[pieceIndex] = true;
}

function bitfieldHandler(payload)
{

}

function pieceHandler(payload, socket, requested, queue)
{
    queue.shift();
    requestPiece(socket, requested, queue);
}

function requestPiece(socket, requested, queue)
{
    if(requested[queue[0]])
    {
        queue.shift();
    }
    else
    {
        // pseduo code as buildRequest actually takes slightly more complex argument
        socket.write(message.buildRequest(pieceIndex));
    }
}

// Every time the socket recieves data, the socket.on callback is called. It concats the new data
//  with savedBuf and as long as savedBuf is long enough to contain at least one whole message, 
// it will pass it to the onWholeMsg callback and then update savedBuf by slicing out those 
// messages. Basically savedBuf saves the pieces of incomplete messages between rounds of 
// receiving data from the socket.

// Also the handshake is the first message we will recieve.That’s why we start with handshake 
// set to true, and then the first time we receive a whole message we set it to false.

//the onWholeMsg function is only getting called once, so the savedBuf and handshake variables 
// are only initialized once. But then the socket.on callback gets called multiple times, each 
// time getting and setting the same two variables.
function onWholeMsg(socket, callback)
{
    let savedBuf = Buffer.alloc(0);
    let handshake = true;

    socket.on('data', recvBuffer => {
        // msgLen calculates the length of whole message
        const msgLen = () => handshake ? savedBuf.readUInt8(0) + 49 : savedBuf.readUInt32BE(0) + 4;
        savedBuf = Buffer.concat([savedBuf, recvBuffer]);

        while(savedBuf.length >= 4 && savedBuf.length >= msgLen())
        {
            callback(savedBuf.slice(0, msgLen()));
            savedBuf = savedBuf.slice(msgLen());
            handshake = false;
        }
    });
}