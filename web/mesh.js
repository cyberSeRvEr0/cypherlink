/**
 * Cypherlink mesh — P2P via libp2p WebRTC + GossipSub + DHT.
 * DHT = distributed phone book. Group name is the lookup key.
 * Works across all networks. No host. No central server.
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
      }),
    },
  });

  // Subscribe to the group topic
  const topic = `cypherlink/${groupName}`;
  await node.services.pubsub.join(topic);

  // Track group peers
  node._peers = {};

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

  // Publish our presence in the DHT (this is how others find us)
  const dhtKey = `cypherlink:group:${groupName}`;
  const peerInfo = {
    id: node.peerId.id,
    addresses: node.getMultiaddrs().map(a => a.toString()),
    nickname: '',
  };
  try {
    await node.services.dht.put(dhtKey, new TextEncoder().encode(JSON.stringify(peerInfo)));
  } catch (e) {
    console.warn('[Cypherlink] DHT put failed (will retry):', e.message);
  }

  // Look up existing members in this group via DHT
  const existingPeers = await findGroupMembers(node, dhtKey);

  // Dial them
  for (const peer of existingPeers) {
    try {
      await node.dial(peer.id);
      if (!node._peers[peer.id]) {
        node._peers[peer.id] = { id: peer.id, nickname: peer.nickname || 'unknown', hasCam: false };
        if (node._onPeerFound) node._onPeerFound(node._peers[peer.id]);
      }
    } catch (e) {
      console.warn(`[Cypherlink] Could not dial ${peer.id}:`, e.message);
    }
  }

  // Announce ourselves on the topic
  try {
    const hello = { type: 'hello', from: node.peerId.id, nickname: '', ts: Date.now() };
    await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(hello)));
  } catch (e) {}

  return { node, topic };
}

async function findGroupMembers(node, dhtKey) {
  const peers = [];
  try {
    const result = await node.services.dht.get(dhtKey);
    const info = JSON.parse(new TextDecoder().decode(result.value));
    if (info.id !== node.peerId.id) {
      peers.push(info);
    }
  } catch (e) {
    // No one in this group yet
  }
  return peers;
}

export function setMessageHandler(node, handler) {
  node._onMessage = handler;
}

export function setPeerFoundHandler(node, handler) {
  node._onPeerFound = handler;
}

export async function sendMessage(node, topic, payload) {
  try {
    return await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
  } catch (e) {}
}

export function getPeers(node) {
  return node._peers || {};
}

export async function updateNickname(node, groupName, nickname) {
  // Update DHT record with our nickname
  const dhtKey = `cypherlink:group:${groupName}`;
  const peerInfo = {
    id: node.peerId.id,
    addresses: node.getMultiaddrs().map(a => a.toString()),
    nickname,
  };
  try {
    await node.services.dht.put(dhtKey, new TextEncoder().encode(JSON.stringify(peerInfo)));
  } catch (e) {}

  // Also broadcast on topic
  const msg = { type: 'hello', from: node.peerId.id, nickname, ts: Date.now() };
  try {
    await node.services.pubsub.publish(`cypherlink/${groupName}`, new TextEncoder().encode(JSON.stringify(msg)));
  } catch (e) {}
}

export function stopNode(node) {
  node.stop();
}   