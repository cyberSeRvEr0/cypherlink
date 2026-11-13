/**
 * Cypherlink DHT mesh — peers find each other via Kademlia DHT.
 * No host. No meeting point. Group name is the discovery key.
 */
import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { KadDHT } from '@libp2p/kad-dht';
import { peerIdFromString } from '@libp2p/peer-id';

const BOOTSTRAP_NODES = [
  '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWuQJyr1wtgzE931WmXSgRnHhy',
  '/dns4/node.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
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
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToOwnTopic: true,
      }),
      dht: KadDHT({
        kBucketSize: 20,
        validators: {},
        storage: {},
      }),
    },
  });

  // Join the DHT network
  await node.services.dht.bootstrap();

  // Subscribe to this group's topic
  const topic = `cypherlink/${groupName}`;
  await node.services.pubsub.join(topic);

  // Publish our presence in the DHT
  const dhtKey = new TextEncoder().encode(`cypherlink:group:${groupName}`);
  const peerInfo = {
    id: node.peerId.id,
    addresses: node.getMultiaddrs().map(a => a.toString()),
    nickname: '',
  };
  await node.services.dht.put(dhtKey, new TextEncoder().encode(JSON.stringify(peerInfo)));

  // Listen for messages
  node.services.pubsub.subscribe(topic, (msg) => {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    if (node._onMessage) node._onMessage(data);
  });

  // Query DHT for existing peers in this group
  const existingPeers = await findGroupPeers(node, groupName);

  return { node, topic, existingPeers, myPeerId: node.peerId.id };
}

async function findGroupPeers(node, groupName) {
  const dhtKey = new TextEncoder().encode(`cypherlink:group:${groupName}`);
  const peers = [];

  try {
    const result = await node.services.dht.get(dhtKey);
    const info = JSON.parse(new TextDecoder().decode(result.value));
    if (info.id !== node.peerId.id) {
      peers.push(info);
    }
  } catch (e) {}

  try {
    const found = await node.services.dht.findPeers(dhtKey);
    for (const p of found) {
      const id = p.id.toString ? p.id.toString() : p.id;
      if (id !== node.peerId.id && !peers.find(x => x.id === id)) {
        peers.push({ id, addresses: p.addresses || [] });
      }
    }
  } catch (e) {}

  return peers;
}

export function setMessageHandler(node, handler) {
  node._onMessage = handler;
}

export function sendMessage(node, topic, payload) {
  return node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
}

export async function connectToPeer(node, peerIdStr) {
  const targetId = peerIdFromString(peerIdStr);
  await node.dial(targetId);
}

export async function updatePresence(node, groupName, nickname) {
  const dhtKey = new TextEncoder().encode(`cypherlink:group:${groupName}`);
  const peerInfo = {
    id: node.peerId.id,
    addresses: node.getMultiaddrs().map(a => a.toString()),
    nickname,
  };
  await node.services.dht.put(dhtKey, new TextEncoder().encode(JSON.stringify(peerInfo)));
}

export async function discoverPeers(node, groupName) {
  return findGroupPeers(node, groupName);
}

export function stopNode(node) {
  node.stop();
}   