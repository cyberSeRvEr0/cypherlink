/**
 * Cypherlink — P2P mesh via js-libp2p (WebRTC + GossipSub).
 * This is the "extension" that enables browser-to-browser P2P.
 */
import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';   
import { yamux } from '@chainsafe/libp2p-yamux';

export async function createMeshNode(relayUrl = 'ws://localhost:9001') {
  const node = await createLibp2p({
    addresses: {
      listen: ['/p2p-circuit', '/webrtc'],
    },
    transports: [
      webSockets(),
      webRTC(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false, // Allow private IPs for LAN
    },
    services: {
      pubsub: gossipsub({
        allowPublishToOwnTopic: true,
      }),
    },
  });

  return node;
}

export async function joinGroup(node, groupName, onMessage) {
  const topic = `cypherlink/${groupName}`;
  await node.services.pubsub.join(topic);

  node.services.pubsub.subscribe(topic, (msg) => {
    const data = JSON.parse(new TextDecoder().decode(msg.data));
    onMessage(data);
  });

  return topic;
}

export function sendToGroup(node, topic, payload) {
  return node.services.pubsub.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
}   