/**
 * Cypherlink mesh — P2P via libp2p WebRTC + GossipSub.
 * Discovery: peers find each other by joining the same GossipSub topic.
 * No DHT. No host. No meeting point.
 */
import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';

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
    },
  });

  const topic = `cypherlink/${groupName}`;
  await node.services.pubsub.join(topic);

  // Track discovered peers
  node._peers = {};

  // Listen for all messages on this topic
  node.services.pubsub.subscribe(topic, (msg) => {
    const data = JSON.parse(new TextDecoder().decode(msg.data));

    // Track sender as a known peer
    const senderId = msg.from ? (msg.from.toString ? msg.from.toString() : msg.from) : null;
    if (senderId && senderId !== node.peerId.id) {
      if (!node._peers[senderId]) {
        node._peers[senderId] = { id: senderId, nickname: 'unknown', hasCam: false };
        if (node._onPeerFound) node._onPeerFound(node._peers[senderId]);
      }
    }

    if (node._onMessage) node._onMessage(data, senderId);
  });

  // Announce ourselves to the group
  const hello = {
    type: 'hello',
    from: node.peerId.id,
    nickname: '',
    ts: Date.now()
  };
  await node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(hello)));

  return { node, topic };
}

export function setMessageHandler(node, handler) {
  node._onMessage = handler;
}

export function setPeerFoundHandler(node, handler) {
  node._onPeerFound = handler;
}

export function sendMessage(node, topic, payload) {
  return node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
}

export function getPeers(node) {
  return node._peers || {};
}

export function updateNickname(node, topic, nickname) {
  const msg = {
    type: 'hello',
    from: node.peerId.id,
    nickname,
    ts: Date.now()
  };
  return node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(msg)));
}

export function stopNode(node) {
  node.stop();
}   