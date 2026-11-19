# Cypherlink

Cypherlink is a database-free browser chat and video prototype. It creates temporary rooms from a group name and invite key. Rooms have no server-side directory or stored history and leave no browser database behind.

## Features

- Temporary text rooms
- Ephemeral in-memory member presence
- AES-GCM encrypted text payloads
- libp2p Noise transport encryption
- libp2p GossipSub messaging
- Circuit Relay v2 fallback
- WebRTC camera and microphone
- STUN support and optional TURN support
- Leave and presence cleanup
- `CLOSE ROOM` control
- Linux and Windows setup scripts

## Requirements

- Node.js 22 or newer
- npm
- Python 3
- A modern WebRTC-capable browser

## Start locally

Linux:

```bash
chmod +x setup.sh
./setup.sh
```

Windows:

```bat
setup.bat
```

Open `http://localhost:3000`. The setup process builds the browser bundle, starts `relay.js`, and starts the web server.

Stop the Linux setup with **Ctrl+C**. It stops the web and relay processes.

Build only:

```bash
npm install
npm run build
```

Run separate services:

```bash
npm run relay
python3 -m http.server 3000 --directory web
```

The relay writes `web/relay-config.json`. The browser uses that relay automatically when no custom relay is entered.

## Join a room

Enter the same group name and invite key as the intended members, and choose a nickname.

- The group name and invite key are hashed to a GossipSub topic.
- Chat text is encrypted with AES-GCM.
- The invite key is derived locally with PBKDF2.
- Nicknames are display labels, not authenticated identities.
- The peer ID is session-specific.
- No account, database, or room registry is required.

Use a strong, unique invite key and share it through a trusted channel.

## Close a room

Use **CLOSE ROOM** or close the browser tab. Cypherlink stops media tracks, sends a leave event, stops the libp2p node, clears the page chat, and removes its in-memory member list.

Members that stop responding are removed after 15 seconds. There is no room directory to update because there is no database.

The room has no server-side state: it disappears when all members leave. Cypherlink cannot erase copies made by users or browser/network infrastructure outside the application.

## Architecture

- `web/app.js`: UI, room state, chat encryption, and WebRTC
- `web/mesh.js`: libp2p node, GossipSub, relay, and presence
- `relay.js`: Circuit Relay v2 WebSocket server
- `setup.sh`: Linux dependencies, build, coturn, relay, firewall, and web server
- `setup.bat`: Windows build, relay, and web server
- `web/bundle.js`: generated browser bundle

## Public relay and TURN

A local relay address is only reachable to devices that can reach your machine. For public use, set:

```bash
RELAY_PUBLIC_HOST=your-public-ip \
TURN_URL=turn:your-public-ip:3478 \
TURN_USERNAME=cypherlink \
TURN_CREDENTIAL=cypherlink123 \
npm run relay
```

Public deployment additionally requires:

- A reachable public IP or DNS name
- TCP port 9090 open to WebSocket clients
- UDP relay ports and coturn port 3478 open
- HTTPS and a reverse proxy/WSS endpoint for browser deployment
- Strong TURN credentials or TURN REST credentials

TURN is optional. STUN helps discover direct network paths; TURN relays media only when direct paths fail.

## Privacy and security boundaries

- Transport data is protected by libp2p Noise.
- Chat text is protected by AES-GCM.
- Relays and infrastructure can observe IP addresses, connection times, topic hashes, and traffic metadata.
- WebRTC signaling metadata and TURN traffic are subject to relay visibility.
- Nicknames are not cryptographically authenticated.
- Messages exist only in browser memory.
- This is an ephemeral prototype, not a production security product.

For high-risk use, add signed peer identities, a secure key exchange, sequence and replay protection, encrypted sender identities, authenticated signaling, automated TURN credential rotation, and an independent security audit.
