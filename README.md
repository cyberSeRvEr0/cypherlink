# Cypherlink

Cypherlink is a browser-based peer-to-peer chat and video chat prototype. It uses libp2p for peer networking, GossipSub for live group messages, WebRTC for media connections, and Kademlia DHT for best-effort peer metadata.

> **Status:** Cross-network group discovery and video connectivity are not yet reliable. Public bootstrap peers help nodes find the libp2p network; they are not a Cypherlink group directory or a TURN service.

## Features

- Group chat using GossipSub topics in the form `cypherlink/<groupName>`.
- Peer discovery from messages published by users currently subscribed to the same group topic.
- WebRTC-based video signaling and media connections.
- AES-GCM encryption support in the application layer and encrypted local-history support, when enabled in `app.js`.
- A “Leave and delete my data” control intended to stop the node and delete local IndexedDB records.

## Requirements

- Node.js 20 or newer and npm.
- Python 3 for the local development web server.
- A modern browser that supports the Web APIs used by the app.
- An internet connection for installing dependencies and peer networking.

The setup script installs Node.js/npm, Python, and coturn on supported systems with `apt` or Homebrew, installs project dependencies, builds the app, and serves it locally.

## Setup

From the project directory, run:

    chmod +x setup.sh
    ./setup.sh

Open http://localhost:3000. Stop the server with **Ctrl+C**.

To build without starting the server, run:

    npm install
    npm run build

The build command bundles `web/app.js` into `web/bundle.js`. Keep `index.html` and `style.css` in `web/` so their relative asset paths work.

## Joining a group

Enter the same group name and invite key as other participants, then choose a nickname. The group name selects the GossipSub topic. The invite key is intended for application-level encryption; it is not a peer-discovery mechanism.

Use a strong, unique invite key and share it only with intended participants. The group name is not a secret or an access-control mechanism.

## Architecture

- **libp2p** creates the peer node and manages transports and connections.
- **WebRTC** provides browser peer-to-peer transport, with circuit relay support configured in the node.
- **GossipSub** carries live group messages on `cypherlink/<groupName>`.
- **Kademlia DHT** stores best-effort per-peer metadata under keys shaped like `cypherlink:group:<groupName>:<peerId>`.
- **IndexedDB** stores browser-local records. The “Leave and delete my data” action is intended to remove the app’s local databases.

DHT keys are unique per peer to avoid overwriting a shared group record. However, Kademlia `get()` does not enumerate all keys under a group prefix. These records therefore do not provide a complete group directory. The current practical discovery path is a peer’s live presence announcement on the group’s GossipSub topic.

## Security and networking notes

Treat Cypherlink as a prototype, not as a production-ready secure communications system.

- **Transport encryption and end-to-end encryption are different.** libp2p Noise protects connections between peers. It does not by itself ensure that application messages are encrypted for only the intended group members. Confirm that `app.js` encrypts and authenticates message payloads before publishing them.
- **AES-GCM requires careful key handling.** Use a strong invite key, unique nonces, and authenticated decryption. Do not store the encryption key alongside ciphertext.
- **Local deletion has limits.** Deleting IndexedDB removes the app’s browser database, but cannot guarantee deletion of copies, exports, browser backups, or data held by other participants.
- **Bootstrap peers are not a group directory.** They help nodes connect to the libp2p network but do not list Cypherlink group members.
- **TURN is not configured by the setup script.** Installing coturn alone does not make it reachable. Remote TURN requires a publicly reachable server, suitable network configuration, and secure credentials. A TURN URL using `localhost` refers only to the device running the browser.
- **WebRTC may fail across restrictive networks.** Reliable cross-network joining and video require a working rendezvous/signaling approach and, in some network conditions, a reachable TURN relay.
- Avoid claims such as “no trace” or “no server sees your data” unless the encryption, signaling, relay, browser-storage, and deployment behavior has been reviewed and verified.

## Current limitations

- New peers may not find existing group members across networks because there is no reliable group rendezvous directory.
- DHT records are best-effort and cannot be discovered by querying a group prefix.
- TURN is installed but not configured or started by `setup.sh`.
- Video and signaling depend on the application’s WebRTC signaling implementation and network reachability.
- Bootstrap availability and browser or network restrictions can affect connections.

## Project files

    .
    ├── mesh.js
    ├── package.json
    ├── setup.sh
    └── web/
        ├── app.js
        ├── bundle.js       # generated by npm run build
        ├── index.html
        └── style.css

Adjust the file paths in this section if your project uses a different layout.
