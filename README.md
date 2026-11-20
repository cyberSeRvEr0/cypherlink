# Cypherlink

Cypherlink is a browser-based group chat prototype with optional video and audio. It has no accounts and does not provide a message-history service or application database. Chat text is encrypted in the browser, but some room, sender, and connection metadata remains visible.

The current networking model is **hosted by one group member**: the host runs a libp2p relay process behind a Cloudflare tunnel, and other members connect to that host's relay address. It is not a serverless or anonymous network. The host must keep the relay process running while the group uses it.

Cypherlink has not had an independent security audit. It does not promise that network activity is invisible or that all traces outside the app can be erased.

## Features

- Temporary, live group chat; no server-side chat archive is implemented.
- AES-256-GCM encryption of chat text in the browser.
- libp2p Noise transport encryption and GossipSub group messaging/discovery.
- Optional WebRTC camera and microphone, using WebRTC's DTLS-SRTP media protection.
- In-memory member presence and a close-room control.
- Cloudflare Quick Tunnel for host connectivity: no public IP, no port forwarding, no CGNAT issues.
- Unique relay URL and peer ID per session (changes every time the host starts a new group).
- Idle watchdog: relay auto-shuts-down 30 seconds after the last peer disconnects.

## Requirements

- Node.js 22 or newer and npm.
- A modern browser with Web Crypto and ES module support.
- For camera/microphone use, browser permission and a secure context. `localhost` is a secure context.
- No public IP, no port forwarding, no router configuration. Cloudflare tunnel handles connectivity.

## Start the application

On each computer, get the project files, then run the setup script.

Linux:

    chmod +x setup.sh
    ./setup.sh

Windows:

    setup.bat

The scripts install Node.js (if missing), install cloudflared (if missing) to `~/.local/bin` on Linux, build the browser bundle, and ask whether you are creating a new group or joining an existing one. The Linux setup does not require `sudo` to install cloudflared.

## Host a group

1. Run `./setup.sh` or `setup.bat` and choose **1) Create a new group**.
2. The script starts a Cloudflare Quick Tunnel (no account needed) and then starts `relay.js`.
3. The terminal prints your relay address (a `/dns4/...trycloudflare.com/tcp/443/tls/ws/p2p/Qm...` string).
4. Copy that address and send it to your members along with the group name and invite key.
5. Keep the terminal open. Closing it ends the group for everyone.

No port forwarding. No public IP. No router configuration. The Cloudflare tunnel makes an outbound connection, so it works behind CGNAT, double NAT, and restrictive firewalls.

The relay URL is unique to this session. When you close the terminal, the URL stops working and the peer ID is gone. Starting a new group generates a new URL and peer ID.

## Join a group

1. Get the project files and run the setup script. Choose **2) Join an existing group**.
2. The script starts a local web server and opens `http://localhost:3000`.
3. Enter the same group name and invite key as the host, choose a nickname, and paste the host's relay address into the **Custom Relay** field.
4. Click **ENTER**.

The group name and invite key are combined and SHA-256 hashed in the browser to derive a GossipSub topic. The invite key is also used to derive the AES key locally with PBKDF2-HMAC-SHA-256 (250,000 iterations and a fixed application salt). The topic is deterministic: the same inputs produce the same topic. Use a long, random invite key and share it through a separate trusted channel.

## Chat, media, and privacy

### Chat text

The browser encrypts each chat message's text using AES-256-GCM and a fresh random 12-byte IV. Members with the same invite key can decrypt it. The message sender nickname, type, and timestamp are outside the ciphertext and are not hidden by this app-level encryption. Nicknames are also sent in plaintext in presence (`hello`) messages and camera-on notifications.

All members share the same group key. This does not verify which person sent a message: a member who knows the key can decrypt messages and can claim any nickname.

### Video and audio

WebRTC protects media with SRTP, with keys negotiated using DTLS-SRTP. SDP offers/answers and ICE candidates are separate WebRTC setup messages; this app sends them through the group messaging topic without encrypting them with the chat AES key. They can expose connection details and candidate addresses. STUN is configured for connectivity.

Video may fail on restrictive NATs or firewalls.

### Metadata and limits

Encryption protects message text and WebRTC media in transit; it does not make the connection invisible. Depending on the route and observer, metadata may include:

- IP addresses, connection times, and connection duration (visible to Cloudflare's edge).
- Peer IDs and peer connection/topology information.
- The derived topic hash, message types, sizes, timestamps, timing, and frequency.
- Plaintext nicknames in presence, camera-on, and message sender fields.
- WebRTC SDP/ICE signaling and candidate addresses.

The host relay handles libp2p connections and GossipSub traffic. Libp2p Noise protects transport connections, but it does not hide all connection metadata from the host or network operators. Peers can save, copy, or share anything they receive. The app cannot control browser, operating-system, ISP, router, or relay logs.

## Leaving and data lifetime

Displayed chat and peer presence are held in page memory. Refreshing or closing a tab clears that page's displayed history and requires the user to join again. Closing the room stops local media, asks the node to announce departure, stops the node, and clears the displayed chat.

Peers that stop announcing are removed from each client's in-memory peer list after approximately 15 seconds. There is no authoritative room registry, and a group using the same name and key can be used again later. This does not erase copies already made by users or records kept outside Cypherlink.

When the host closes their terminal, the Cloudflare tunnel and relay process terminate. The relay URL becomes unreachable. `relay-config.json` is deleted on clean shutdown; a crash or forced termination may leave it behind.

## Project files

- `web/app.js` — UI, local chat encryption, message handling, and WebRTC
- `web/mesh.js` — libp2p node, GossipSub, discovery, relay connection, and presence
- `web/index.html` and `web/style.css` — browser interface
- `web/bundle.js` — generated browser bundle loaded by the page
- `relay.js` — host-run Circuit Relay v2, GossipSub node, and static web server
- `setup.sh` — Linux: install deps, build, cloudflared tunnel, host/member launch
- `setup.bat` — Windows: install deps, build, cloudflared tunnel, host/member launch
- `package.json` — npm scripts and dependencies

## Security notes

- Do not describe Cypherlink as untraceable, invisible, or capable of erasing all external records.
- Protect the invite key. Anyone who obtains it can derive the group encryption key.
- Use only a trusted copy of the app; compromised app code or endpoints can access plaintext before encryption or after decryption.
- The host exposes a relay service via Cloudflare. The relay URL is unique per session and dies when the host's terminal closes.
- Cloudflare's edge can observe connection metadata (IPs, timing, byte counts). This is a tradeoff of using their free tunnel service.
- This prototype has not been independently audited. Do not rely on it as the sole protection for high-risk communication.   