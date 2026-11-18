if (!Promise.withResolvers) {
  Promise.withResolvers = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const { createLibp2p } = await import('libp2p');
const { webSockets } = await import('@libp2p/websockets');
const { circuitRelayServer } = await import('@libp2p/circuit-relay-v2');
const { noise } = await import('@chainsafe/libp2p-noise');
const { yamux } = await import('@chainsafe/libp2p-yamux');
const { identify } = await import('@libp2p/identify');
const { gossipsub } = await import('@chainsafe/libp2p-gossipsub');

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

console.log('Cypherlink Relay listening on:');
relay.getMultiaddrs().forEach((ma) => console.log(' ', ma.toString()));
