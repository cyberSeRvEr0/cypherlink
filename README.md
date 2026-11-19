# Cypherlink

Cypherlink is a browser-based, temporary group chat with optional video and audio. It has no accounts and does not provide a message-history service or application database. Chat content is encrypted in the browser; peers and network infrastructure can still observe some connection and message metadata.

Cypherlink is a prototype, not an anonymity system or audited security product. It does not promise that network activity is invisible or that every trace outside the application can be erased.

## What it does

- Creates a group topic from the entered group name and invite key.
- Encrypts each chat message's text using AES-256-GCM in the browser.
- Uses libp2p Noise to encrypt libp2p transport connections.
- Uses GossipSub for group messaging and peer discovery.
- Uses WebRTC for optional camera and microphone calls.
- Keeps the displayed chat and member list in page memory; it does not implement a message archive or account system.
- Provides a close-room control that stops local media, asks the node to announce departure, closes connections, and clears the displayed chat.

## Requirements

- Node.js 22 or newer and npm to build the browser bundle.
- A modern browser with Web Crypto, WebRTC, and camera/microphone support for video.
- A secure browser context for camera/microphone access. `localhost` and HTTPS are typical options; browser restrictions can vary.

## Run locally

Linux:

```sh
chmod +x setup.sh
./setup.sh
```

Windows:

```bat
setup.bat
```

The setup scripts install/build dependencies and build `web/bundle.js`. They do not start a dedicated room server. To serve the UI locally, run:

```sh
npm install
npm run build
npm start
```

Open the local URL printed by the static file server. Alternatively, the setup scripts indicate that you can open `web/index.html` directly, though serving it from `localhost` is generally more compatible with browser APIs.

The static web server only serves the app files. It is not the group messaging network. The browser code has a built-in pool of public libp2p relays; members must be able to reach at least one configured relay or provide a custom relay address in the join screen. Public relay availability and policies are outside this project's control.

## Join and use a group

Every member enters the same group name and invite key, and chooses a nickname. The group name is a display label; the name and key are combined and SHA-256 hashed in the browser to derive the GossipSub topic. The invite key is also used locally to derive the AES-GCM key with PBKDF2-HMAC-SHA-256 (250,000 iterations and a fixed application salt).

Use a long, random invite key and share it through a separate trusted channel. A short or common key can be guessed. The topic derivation is an unsalted hash, not a secure password-authenticated room directory or access-control service. The topic is deterministic: re-entering the same group name and key produces the same topic.

The application does not create a dedicated server or a persistent room record for each group. Its configured relays are shared network infrastructure, not temporary servers created for a group. When nobody is participating, there is no active chat session managed by the app; the same topic can be used again later by anyone with the same inputs.

## Message and media protection

### Chat

The browser encrypts message text with AES-256-GCM using a fresh random 12-byte IV for each message. Recipients with the same invite key decrypt the text locally. The code does not encrypt the whole message envelope: the sender nickname, message type, and timestamp are sent outside the ciphertext. Nicknames are also sent in plaintext in presence (`hello`) announcements and camera-on notifications.

AES-GCM authenticates each ciphertext, but all group members share the same key. This does not authenticate which individual member sent a message or prevent a key holder from impersonating another nickname.

### Video and audio

The browser uses WebRTC. WebRTC protects media with SRTP, with keys negotiated through DTLS (DTLS-SRTP). The media content is encrypted in transit; participating endpoints can, of course, see and hear it.

WebRTC setup messages are different from media. The app publishes SDP offers/answers and ICE candidates through the group messaging topic. These signaling values are not encrypted by the app's AES-GCM chat encryption. They can reveal connection details, and STUN can reveal network addresses. If a TURN server is used, it forwards media packets but does not receive the DTLS-SRTP media keys from this application.

## What may be observable

Encryption protects content; it does not hide that a connection or group activity exists. Depending on the path and the observer, the following may be visible:

- IP addresses, connection times, and connection duration.
- Peer IDs and which peers connect or exchange messages.
- The derived topic hash and the fact that traffic relates to that topic. The hash does not directly display the entered group name, but weak names/keys may be guessable.
- Plaintext nicknames in `hello`, `cam_on`, and chat sender fields.
- Message type, approximate size, timing, frequency, and timestamps.
- WebRTC SDP/ICE signaling and candidate addresses.
- Media connection metadata, including STUN/TURN use.

The built-in relay pool consists of third-party services. The exact metadata each relay operator can observe depends on how libp2p routes the connection and messages; do not assume that a relay sees only encrypted payloads or that every relay sees every field. Peers in the group receive application messages and may record or share them.

## Leaving and data lifetime

Chat history is held in the browser page's memory, not persisted by Cypherlink to a server-side message database. Refreshing or closing the tab clears that page's displayed history and requires the user to join again. Closing a room also clears the current chat display and stops local media.

Peers that stop announcing are removed from the local member list after approximately 15 seconds. The app has no central room-membership database and cannot prove that all participants have left at the same instant. A shared relay is not created or destroyed for each group.

This behavior does not erase copies made by participants, browser or operating-system data, or network and relay logs. Application-level deletion cannot control infrastructure outside Cypherlink.

## Optional self-hosted relay

`relay.js` can run a libp2p Circuit Relay v2 node and static web server. It is optional when a built-in public relay is reachable. If using a self-hosted relay, start it with:

```sh
node relay.js
```

Set `RELAY_PUBLIC_HOST` to a hostname or address reachable by your group; the default `127.0.0.1` is only reachable on the same device. The relay prints its multiaddress. Enter that address in the join screen's **Custom Relay** field on each member's device. Make sure the required ports and browser-compatible secure web serving are configured for your deployment.

The self-hosted relay's idle watchdog shuts down the relay process after it has had peers and then has no connected peers for the configured idle period (30 seconds by default). This is a process-wide idle timeout, not a per-group room deletion mechanism. On clean shutdown, the relay removes `web/relay-config.json`; a crash or forced termination may leave it behind. This file contains relay/TURN configuration, not chat history.

The app also supports optional TURN settings via `relay-config.json` for WebRTC connectivity. TURN is separate from the libp2p Circuit Relay used for peer connectivity. Do not use example or default credentials for a public TURN service.

## Project layout

- `web/app.js` — UI, local chat encryption, message handling, and WebRTC
- `web/mesh.js` — libp2p node, GossipSub, peer discovery, relay connections, and presence
- `web/index.html` and `web/style.css` — browser interface
- `relay.js` — optional self-hosted Circuit Relay v2 and static file server
- `setup.sh` and `setup.bat` — dependency/build setup
- `web/bundle.js` — generated browser bundle

## Security notes

- Do not describe Cypherlink as untraceable, invisible, or capable of erasing all external records.
- Protect the invite key. Anyone who obtains it can derive the group chat key and read messages they receive.
- Nicknames are labels, not verified identities.
- Use trusted app delivery: a compromised app or device can read plaintext before encryption or after decryption.
- This prototype has not had an independent security audit. Do not use it as the sole protection for high-risk communication.
