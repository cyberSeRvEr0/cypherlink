/**
 * Cypherlink Stateless Relay — No database, no logs, RAM-only signaling.
 * Allows browser nodes to discover each other and upgrade to direct WebRTC.
 */
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';

const PORT = process.env.RELAY_PORT || 9090;

const relay = await createLibp2p({
  addresses: {
    listen: [`/ip4/0.0.0.0/tcp/${PORT}/ws`],
  },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    pubsub: gossipsub({
      allowPublishToOwnTopic: true,
      emitSelf: false,
    }),
    relay: circuitRelayServer({
      reservations: {
        maxReservations: 1000,
      },
    }),
  },
});

console.log('Cypherlink Stateless Relay running.');
console.log('Copy one of these Multiaddrs into RELAY_MULTIADDRS in web/mesh.js:\n');
relay.getMultiaddrs().forEach((ma) => {
  console.log(`  ${ma.toString()}`);
});
