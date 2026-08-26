# BitStream

BitStream is a lightweight, efficient BitTorrent client designed for downloading torrent files.

## BitTorrent Protocol Overview

To understand how BitStream operates, the core BitTorrent mechanics can be broken down into two main phases:

1. **Tracker Discovery & Swarm Registration**  
   To begin a download, the client sends a request to a central server called a **tracker**, specifying the exact files it intends to download. The tracker responds with a curated list of active **peers** (IP addresses of other users hosting the file). By making this request, the client is automatically added to the tracker's list, allowing other network participants to discover and download pieces from it.

2. **Direct Peer-to-Peer Communication**  
   Once the client receives the peer list, it bypasses the tracker and connects directly to those users. The client and peers exchange structured network messages to declare which file pieces they currently hold. Based on this mutual availability data, the client requests missing pieces and begins the downloading process.

## Features
- Core BitTorrent protocol integration (In Development)
- Tracker communication and peer discovery
- Direct peer-to-peer piece exchange
