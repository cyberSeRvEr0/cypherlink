if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
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
const PUBLIC_HOST = process.env.RELAY_PUBLIC_HOST || '127.0.0.1';
const CONFIG_PATH = process.env.RELAY_CONFIG_PATH || './web/relay-config.json';
const { writeFile } = await import('node:fs/promises');

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
      floodPublish: true,
    }),
    relay: circuitRelayServer({
      reservations: {
        maxReservations: 1000,
      },
    }),
  },
});

console.log('\nCypherlink Relay Ready:');
relay.getMultiaddrs().forEach((ma) => console.log(' ', ma.toString()));

const peerId = relay.peerId.toString();
await writeFile(CONFIG_PATH, JSON.stringify({
  relayAddress: `/ip4/${PUBLIC_HOST}/tcp/${PORT}/ws/p2p/${peerId}`,
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
}, null, 2));
console.log(`\nBrowser relay address:\n /ip4/${PUBLIC_HOST}/tcp/${PORT}/ws/p2p/${peerId}`);
