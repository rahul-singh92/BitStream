The **`udp://`** protocol is used instead of **`http://`** in BitTorrent trackers because it drastically **reduces server load, saves network bandwidth, and speeds up peer connections**. 

---

### Why UDP is Used Instead of HTTP?

* **Lower Overhead:** HTTP requires a multi-step "handshake" to establish a connection. UDP skips this, sending data immediately.
* **Smaller Packet Size:** UDP tracker requests use tiny, raw binary packets instead of bulky text-based HTTP headers.
* **Server Survival:** Popular trackers handle millions of users simultaneously. UDP prevents tracker servers from crashing under heavy traffic.
* **No Connection Tracking:** Trackers do not need to maintain an open state for every single user, freeing up massive amounts of server memory.

---

### Primary Uses of a UDP Tracker

* **Peer Discovery:** It shares a list of IP addresses downloaded by other users tracking the exact same file.
* **Swarm Coordination:** It connects you to uploaders (seeders) and downloaders (leechers) to maximize your download speeds.
* **Real-Time Statistics:** It counts and updates the active number of seeds and peers for torrent clients.

---

> **Note:** While UDP is perfect for lightweight tracker communication, the actual file transfer between peers typically uses **TCP** (or reliable protocols like uTP). Because torrent files are large and split into thousands of pieces, TCP is necessary during the actual peer-to-peer transfer to ensure every single piece of data arrives perfectly intact, verified, and in the correct order.