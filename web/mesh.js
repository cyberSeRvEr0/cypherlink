/**
 * Cypherlink mesh — P2P via libp2p.
 * Discovery: DHT (group member list stored as JSON array).
 * Messaging: GossipSub (encrypted, peer-to-peer).
 * Transport: WebRTC + circuit relay (works across all networks).
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
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';

const BOOTSTRAP_LIST = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
];

const DHT_PREFIX = 'cypherlink';

function groupKey(groupName) {
  return new TextEncoder().encode(`${DHT_PREFIX}:group:${groupName}`);
}

export async function createNode(groupName) {
  const node = await createLibp2p({
    addresses: {
      listen: ['/webrtc', '/p2p-circuit'],
    },
    transports: [
      webRTC(),
      webSockets(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      bootstrap({
        list: BOOTSTRAP_LIST,
        interval: 30000,
      }),
    ],
    services: {
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub({
        allowPublishToOwnTopic: true,
      }),
      dht: kadDHT({
        clientMode: false,
        validators: {
          [DHT_PREFIX]: async () => true,
        },
        selectors: {
          [DHT_PREFIX]: () => true,
        },
      }),
    },
  });

  // Subscribe to group topic
  const topic = `cypherlink/${groupName}`;
  await node.services.pubsub.join(topic);

  // Track group peers
  node._peers = {};
  node._groupName = groupName;

  // Listen for group messages
  node.services.pubsub.subscribe(topic, (msg) => {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    const senderId = msg.from ? (msg.from.toString ? msg.from.toString() : msg.from) : null;
    if (senderId && senderId !== node.peerId.id) {
      if (!node._peers[senderId]) {
        node._peers[senderId] = { id: senderId, nickname: 'unknown', hasCam: false };
        if (node._onPeerFound) node._onPeerFound(node._peers[senderId]);
      }
    }
    if (node._onMessage) node._onMessage(data, senderId);
  });

  // --- DHT: Find existing group members ---
  const existingMembers = await dhtGetGroupMembers(node, groupName);

  // Dial them
  for (const member of existingMembers) {
    if (member.id === node.peerId.id) continue;
    try {
      await node.dial(member.id);
      if (!node._peers[member.id]) {
        node._peers[member.id] = { id: member.id, nickname: member.nickname || 'unknown', hasCam: false };
        if (node._onPeerFound) node._onPeerFound(node._peers[member.id]);
      }
    } catch (e) {
      console.warn(`[Cypherlink] Could not dial ${member.id.slice(0,8)}...`);
    }
  }

  // --- DHT: Add ourselves to the group ---
  await dhtAddToGroup(node, groupName, '');

  // Announce on topic
  try {
    const hello = { type: 'hello', from: node.peerId.id, nickname: '', ts: Date.now() };
    await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(hello)));
  } catch (e) {}

  // Periodic re-announce (keeps our DHT entry alive, catches late joiners)
  node._announceInterval = setInterval(async () => {
    try {
      await dhtAddToGroup(node, groupName, node._nickname || '');
      const hello = { type: 'hello', from: node.peerId.id, nickname: node._nickname || '', ts: Date.now() };
      await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(hello)));
    } catch (e) {}
  }, 20000);

  return { node, topic };
}

// --- DHT helpers ---

async function dhtGetGroupMembers(node, groupName) {
  const key = groupKey(groupName);
  try {
    for await (const event of node.services.dht.get(key)) {
      if (event.type === 'Value' && event.value) {
        const data = JSON.parse(new TextDecoder().decode(event.value));
        if (Array.isArray(data)) return data;
      }
    }
  } catch (e) {
    // No group exists yet
  }
  return [];
}

async function dhtAddToGroup(node, groupName, nickname) {
  const key = groupKey(groupName);
  let members = await dhtGetGroupMembers(node, groupName);

  // Remove our old entry if exists
  members = members.filter(m => m.id !== node.peerId.id);

  // Add ourselves
  members.push({
    id: node.peerId.id,
    addresses: node.getMultiaddrs().map(a => a.toString()),
    nickname,
    ts: Date.now(),
  });

  // Cap at 100
  if (members.length > 100) members = members.slice(-100);

  // Write back
  try {
    for await (const _ of node.services.dht.put(key, new TextEncoder().encode(JSON.stringify(members)))) {
      // done
    }
  } catch (e) {
    console.warn('[Cypherlink] DHT put failed:', e.message);
  }
}

async function dhtRemoveFromGroup(node, groupName) {
  const key = groupKey(groupName);
  let members = await dhtGetGroupMembers(node, groupName);
  members = members.filter(m => m.id !== node.peerId.id);

  if (members.length === 0) {
    try {
      for await (const _ of node.services.dht.remove(key)) {}
    } catch (e) {}
  } else {
    try {
      for await (const _ of node.services.dht.put(key, new TextEncoder().encode(JSON.stringify(members)))) {}
    } catch (e) {}
  }
}

// --- Public API ---

export function setMessageHandler(node, handler) {
  node._onMessage = handler;
}

export function setPeerFoundHandler(node, handler) {
  node._onPeerFound = handler;
}

export async function sendMessage(node, topic, payload) {
  try {
    await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
  } catch (e) {}
}

export function getPeers(node) {
  return node._peers || {};
}

export async function updateNickname(node, groupName, nickname) {
  node._nickname = nickname;
  await dhtAddToGroup(node, groupName, nickname);
  const msg = { type: 'hello', from: node.peerId.id, nickname, ts: Date.now() };
  try {
    await node.services.pubsub.publish(`cypherlink/${groupName}`, new TextEncoder().encode(JSON.stringify(msg)));
  } catch (e) {}
}

export function stopNode(node) {
  if (node._announceInterval) clearInterval(node._announceInterval);
  // Remove ourselves from the group
  if (node._groupName) {
    dhtRemoveFromGroup(node, node._groupName);
  }
  node.stop();
}   