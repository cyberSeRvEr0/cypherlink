/**
 * Cypherlink mesh — P2P via libp2p WebRTC + GossipSub.
 * Discovery: bootstrap nodes + pubsub peer discovery + circuit relay.
 * Works on same network AND different networks. No host. No DHT.
 */
import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';

// Public bootstrap nodes (like DNS — help peers find each other,
// they never see your messages or group names)
const BOOTSTRAP_LIST = [
  '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWuQJyr1wtgzE931WmXSgRnHhy',
  '/dns4/node.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
];

// Shared topic for peer discovery (all cypherlink users broadcast here)
const DISCOVERY_TOPIC = 'cypherlink/discovery';

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
      pubsubPeerDiscovery({
        interval: 10000,
        topics: [DISCOVERY_TOPIC],
      }),
    ],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        allowPublishToOwnTopic: true,
      }),
    },
  });

  // Subscribe to the discovery topic (so others can find us)
  await node.services.pubsub.join(DISCOVERY_TOPIC);

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

  // Dial newly discovered peers
  node.addEventListener('peer:discovery', async (evt) => {
    try {
      const peerInfo = evt.detail;
      if (peerInfo.id && peerInfo.id !== node.peerId.id) {
        const id = peerInfo.id.toString ? peerInfo.id.toString() : peerInfo.id;
        if (!node._peers[id] && !node.isDialing(id)) {
          await node.dial(peerInfo.id);
        }
      }
    } catch (e) {}
  });

  // Announce ourselves
  try {
    const hello = {
      type: 'hello',
      from: node.peerId.id,
      nickname: '',
      ts: Date.now()
    };
    await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(hello)));
  } catch (e) {}

  return { node, topic };
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

export async function updateNickname(node, topic, nickname) {
  const msg = {
    type: 'hello',
    from: node.peerId.id,
    nickname,
    ts: Date.now()
  };
  try {
    return await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(msg)));
  } catch (e) {}
}

export function stopNode(node) {
  node.stop();
}   