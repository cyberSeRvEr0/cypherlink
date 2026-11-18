/**
 * Cypherlink mesh — Browser P2P via libp2p GossipSub + WebRTC + Circuit Relay.
 * Zero personal IPs. Deterministic rendezvous selection from Group + Invite Key.
 */
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

// Public decentralized libp2p / IPFS bootstrap & relay nodes (No personal IPs)
const PUBLIC_RELAYS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dns4/node0.preload.ipfs.io/tcp/443/wss/p2p/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
  '/dns4/node1.preload.ipfs.io/tcp/443/wss/p2p/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6',
  '/dns4/node2.preload.ipfs.io/tcp/443/wss/p2p/QmV7gnbW5VTcJ3oyM2Xk1rdFBJ3kTkvxc87UFGsun29STS',
  '/dns4/node3.preload.ipfs.io/tcp/443/wss/p2p/QmY7JB6MQXhxHvq7dBDh4HpbH29v4yE9JRadAVpndvzySN',
];

// Derive both the private topic AND the deterministic primary relay index
async function deriveRendezvous(groupName, groupKey) {
  const raw = new TextEncoder().encode(`cypherlink-v1:${groupName}:${groupKey}`);
  const hashBuffer = await self.crypto.subtle.digest('SHA-256', raw);
  const hashBytes = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Use first 4 bytes of the group hash to deterministically pick the meeting point
  const view = new DataView(hashBuffer);
  const relayIndex = view.getUint32(0, false) % PUBLIC_RELAYS.length;

  return {
    topic: `cypherlink/${hashHex}`,
    relayIndex,
  };
}

export async function createNode(groupName, groupKey, customRelay = '') {
  const { topic, relayIndex } = await deriveRendezvous(groupName, groupKey);
  const discoveryTopic = `${topic}/_peer-discovery`;

  // Order relays so both users dial the exact same primary meeting point first,
  // with remaining nodes as automatic fallbacks
  let orderedRelays = [];
  if (customRelay && customRelay.trim().length > 0) {
    orderedRelays = [customRelay.trim()];
  } else {
    orderedRelays = [
      ...PUBLIC_RELAYS.slice(relayIndex),
      ...PUBLIC_RELAYS.slice(0, relayIndex),
    ];
  }

  const node = await createLibp2p({
    addresses: {
      listen: ['/webrtc', '/p2p-circuit'],
    },
    transports: [
      webRTC(),
      webSockets(),
      circuitRelayTransport({
        discoverRelays: 2,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      pubsubPeerDiscovery({
        interval: 3000,
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

  // Connect to the deterministically chosen primary relay (plus fallbacks)
  let connectedRelays = 0;
  for (const addr of orderedRelays) {
    try {
      await node.dial(multiaddr(addr));
      connectedRelays++;
      // Once connected to the primary meeting point + 1 backup, stop dialing extra relays
      if (connectedRelays >= 2) break;
    } catch (e) {
      // Silently try next fallback relay if one is offline or rate-limited
    }
  }

  if (connectedRelays === 0) {
    throw new Error('Could not reach any mesh relay. Check internet or provide a Custom Relay.');
  }

  // Subscribe to the deterministic group topic
  node.services.pubsub.subscribe(topic);

  // Listen for incoming pubsub messages
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

  // Automatically dial any peer discovered on our group's discovery topic
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
  }, 10000);

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
