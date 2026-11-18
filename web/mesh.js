/**
 * Cypherlink mesh — Browser P2P via libp2p GossipSub + WebRTC + Circuit Relay.
 * Deterministic rendezvous routing from Group + Invite Key.
 */
import * as filters from '@libp2p/websockets/filters';
import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { multiaddr } from '@multiformats/multiaddr';

// Add your deployed cloud relay multiaddr(s) here (no personal home IPs).
// For local VM testing, paste the /ip4/127.0.0.1/tcp/9090/ws/p2p/... address from `node relay.js`
// OR paste it directly into the "Custom Relay" box on the join screen.
const RELAY_POOL = [
  // Example: '/dns4/://your-relay-domain.com...'
];

async function deriveRendezvous(groupName, groupKey) {
  const raw = new TextEncoder().encode(`cypherlink-v1:${groupName}:${groupKey}`);
  const hashBuffer = await self.crypto.subtle.digest('SHA-256', raw);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const view = new DataView(hashBuffer);
  const relayIndex = RELAY_POOL.length > 0
    ? view.getUint32(0, false) % RELAY_POOL.length
    : 0;

  return {
    topic: `cypherlink/${hashHex}`,
    relayIndex,
  };
}

export async function createNode(groupName, groupKey, customRelay = '') {
  const { topic, relayIndex } = await deriveRendezvous(groupName, groupKey);
  const discoveryTopic = `${topic}/_peer-discovery`;

  let orderedRelays = [];
  if (customRelay && customRelay.trim().length > 0) {
    orderedRelays = [customRelay.trim()];
  } else if (RELAY_POOL.length > 0) {
    orderedRelays = [
      ...RELAY_POOL.slice(relayIndex),
      ...RELAY_POOL.slice(0, relayIndex),
    ];
  }

  const node = await createLibp2p({
    addresses: {
      listen: ['/webrtc', '/p2p-circuit'],
    },
    transports: [
      webRTC(),
      webSockets({
        filter: filters.all,
      }),
      circuitRelayTransport({
        discoverRelays: 1,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      pubsubPeerDiscovery({
        interval: 2000,
        topics: [discoveryTopic],
        listenOnly: false,
      }),
    ],
    services: {
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub({
        allowPublishToOwnTopic: true,
        emitSelf: false,
      }),
    },
  });

  const selfId = node.peerId.toString();
  node._peers = {};
  node._groupName = groupName;
  node._topic = topic;
  node._nickname = '';

  if (orderedRelays.length === 0) {
    throw new Error('No relay configured. Start `node relay.js` and paste its address into Custom Relay.');
  }

  let connectedRelays = 0;
  let lastError = null;
  for (const addr of orderedRelays) {
    try {
      await node.dial(multiaddr(addr));
      connectedRelays++;
      if (connectedRelays >= 2) break;
    } catch (e) {
      lastError = e;
    }
  }

  if (connectedRelays === 0) {
    throw new Error(`Relay unreachable: ${lastError?.message || 'check relay address'}`);
  }

  // Subscribe to the deterministic group topic
  node.services.pubsub.subscribe(topic);

  // Receive messages over libp2p GossipSub
  node.services.pubsub.addEventListener('message', (evt) => {
    if (evt.detail.topic !== topic) return;
    try {
      const data = JSON.parse(new TextDecoder().decode(evt.detail.data));
      const senderId = evt.detail.from ? evt.detail.from.toString() : data.from;

      if (senderId && senderId !== selfId) {
        if (!node._peers[senderId]) {
          node._peers[senderId] = {
            id: senderId,
            nickname: data.nickname || 'unknown',
            hasCam: false,
          };
          if (node._onPeerFound) node._onPeerFound(node._peers[senderId]);
          sendHello(node, topic, node._nickname);
        } else if (data.nickname && node._peers[senderId].nickname === 'unknown') {
          node._peers[senderId].nickname = data.nickname;
        }
      }

      if (node._onMessage) node._onMessage(data, senderId);
    } catch (e) {
      console.error('[Cypherlink] Message parse error:', e);
    }
  });

  // Dial peers discovered on our group's discovery topic
  node.addEventListener('peer:discovery', async (evt) => {
    try {
      const peerInfo = evt.detail;
      const id = peerInfo.id.toString();
      if (id !== selfId && !node._peers[id]) {
        await node.dial(peerInfo.id);
      }
    } catch (e) {}
  });

  // Clean up disconnected peers
  node.addEventListener('peer:disconnect', (evt) => {
    const id = evt.detail.toString();
    if (node._peers[id]) {
      delete node._peers[id];
      if (node._onPeerLeft) node._onPeerLeft(id);
    }
  });

  await sendHello(node, topic, '');

  node._announceInterval = setInterval(() => {
    sendHello(node, topic, node._nickname || '');
  }, 5000);

  return { node, topic };
}

async function sendHello(node, topic, nickname) {
  try {
    const hello = {
      type: 'hello',
      from: node.peerId.toString(),
      nickname: nickname || '',
      ts: Date.now(),
    };
    await node.services.pubsub.publish(
      topic,
      new TextEncoder().encode(JSON.stringify(hello))
    );
  } catch (e) {}
}

export function setMessageHandler(node, handler) {
  node._onMessage = handler;
}

export function setPeerFoundHandler(node, handler) {
  node._onPeerFound = handler;
}

export function setPeerLeftHandler(node, handler) {
  node._onPeerLeft = handler;
}

export async function sendMessage(node, topic, payload) {
  try {
    await node.services.pubsub.publish(
      topic,
      new TextEncoder().encode(JSON.stringify(payload))
    );
  } catch (e) {}
}

export function getPeers(node) {
  return node._peers || {};
}

export async function updateNickname(node, topic, nickname) {
  node._nickname = nickname;
  await sendHello(node, topic, nickname);
}

export function stopNode(node) {
  if (node._announceInterval) clearInterval(node._announceInterval);
  node.stop();
}
