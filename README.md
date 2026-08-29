# BitStream

BitStream is a lightweight, efficient BitTorrent client designed for downloading torrent files.

## BitTorrent Protocol Overview

To understand how BitStream operates, the core BitTorrent mechanics can be broken down into two main phases:

1. **Tracker Discovery & Swarm Registration**  
   To begin a download, the client sends a request to a central server called a **tracker**, specifying the exact files it intends to download. The tracker responds with a curated list of active **peers** (IP addresses of other users hosting the file). By making this request, the client is automatically added to the tracker's list, allowing other network participants to discover and download pieces from it.

2. **Direct Peer-to-Peer Communication**  
   Once the client receives the peer list, it bypasses the tracker and connects directly to those users. The client and peers exchange structured network messages to declare which file pieces they currently hold. Based on this mutual availability data, the client requests missing pieces and begins the downloading process.

---

## Bencoding (Data Format)

BitTorrent uses a terse data serialization format called **Bencoding** to structure `.torrent` files and tracker network messages. It supports four data types:

* **Byte Strings** (`<length>:<data>`): 
  * Example: `4:spam` &rarr; `"spam"`
* **Integers** (`i<number>e`): Signed 64-bit integers with no leading zeros.
  * Example: `i3e` &rarr; `3` (or `i-3e` &rarr; `-3`)
  * **⚠️ Invalid Encodings Note:** Negative zero (`i-0e`) and numbers with leading zeros (like `i03e`) are strictly invalid. The only valid representation of zero is `i0e`.
* **Lists** (`l<values>e`): Can contain any bencoded types.
  * Example: `li3e4:spame` &rarr; `[3, "spam"]`
* **Dictionaries** (`d<key><value>e`): Keys must be bencoded strings and appear in sorted binary order.
  * Example: `d3:cow3:mooe` &rarr; `{"cow": "moo"}`

---

## Metainfo File (`.torrent`) Structure

All data in a `.torrent` file is a bencoded dictionary. It contains the core metadata required to connect to the swarm, locate files, and verify data integrity.

### Root Dictionary Keys

| Key | Type | Description |
|---|---|---|
| **`info`** | Dictionary | Core file metadata (see below). |
| **`announce`** | String | The tracker's main URL. |
| **`announce-list`** | List | (Optional) Backup or alternate tracker URLs. |
| **`creation date`** | Integer | (Optional) UNIX epoch timestamp of creation. |
| **`comment` / `created by`** | String | (Optional) Free-form author text and program name. |

### The `info` Dictionary

The `info` dictionary describes the actual files being shared. It supports two structural modes depending on whether the torrent is for a single file or a folder. 

**Common Fields:**
*   **`piece length`:** Size of each chunk in bytes (typically a power of 2, like 256 KB or 512 KB).
*   **`pieces`:** A single, continuous byte string containing the concatenated 20-byte SHA1 hashes for every piece. 
*   **`private`:** (Optional) If set to `1`, the client must restrict peer discovery strictly to the tracker (disabling DHT/PEX).

**Mode-Specific Fields:**

| Mode | Required Fields |
|---|---|
| **Single File** | `name` (the filename) and `length` (file size in bytes). |
| **Multiple File** | `name` (the root directory name) and `files` (a list of dictionaries containing the `length` and `path` for each individual file). |

> **Note on Pieces:** For multi-file torrents, files are treated as one continuous data stream when generating piece boundaries. The final piece is always irregular in size, and pieces can overlap file boundaries.

---

## Features
* Core BitTorrent protocol integration (In Development)
* Tracker communication and peer discovery
* Direct peer-to-peer piece exchange