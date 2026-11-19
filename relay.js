/**
 * Cypherlink Relay — ephemeral Circuit Relay v2 + static file server.
 * Stays alive until first peer connects, then self-terminates
 * IDLE_TIMEOUT ms after the last peer disconnects.
 * Deletes relay-config.json on clean exit.
 */

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
const { gossipsub }= await import('@libp2p/gossipsub');   
const { createServer } = await import('node:http');
const { readFile, writeFile, unlink } = await import('node:fs/promises');
const { join, resolve, extname, sep } = await import('node:path');
const { fileURLToPath } = await import('node:url');

// ─── CONFIG ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.RELAY_PORT || '9090', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const PUBLIC_HOST = process.env.RELAY_PUBLIC_HOST || '127.0.0.1';
const WEB_DIR = resolve(join(fileURLToPath(new URL('.', import.meta.url)), 'web'));
const CONFIG_PATH = join(WEB_DIR, 'relay-config.json');
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '30000', 10);

// ─── STATIC FILE SERVER ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const webServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${WEB_PORT}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    let filePath = join(WEB_DIR, pathname);
    let resolved = resolve(filePath);

    if (!resolved.startsWith(WEB_DIR + sep) && resolved !== WEB_DIR) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (url.pathname === '/' || url.pathname === '') {
      resolved = join(WEB_DIR, 'index.html');
    }

    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': MIME[extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

webServer.listen(WEB_PORT, () => {
  console.log(`  Web:   http://localhost:${WEB_PORT}`);
});

// ─── RELAY ────────────────────────────────────────────────────────────
const relay = await createLibp2p({
  addresses: { listen: [`/ip4/0.0.0.0/tcp/${PORT}/ws`] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    pubsub: gossipsub({ allowPublishToOwnTopic: true, emitSelf: false, floodPublish: true }),
    relay: circuitRelayServer({ reservations: { maxReservations: 1000 } }),
  },
});

const peerId = relay.peerId.toString();
const relayAddr = `/dns4/${PUBLIC_HOST}/tcp/443/tls/ws/p2p/${peerId}`;   

await writeFile(CONFIG_PATH, JSON.stringify({
  relayAddress: relayAddr,
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
}, null, 2));

console.log('\n  Cypherlink Relay Ready');
console.log(`  Relay: ${relayAddr}`);
console.log(`  Auto-shutdown: ${IDLE_TIMEOUT / 1000}s after last peer leaves\n`);

// ─── DYNAMIC TOPIC SUBSCRIPTION ───────────────────────────────────────
// When a connected peer subscribes to a GossipSub topic, the relay
// subscribes too so it can forward messages between peers.
relay.services.pubsub.addEventListener('subscriptionChange', (evt) => {
  const { subscriptions } = evt.detail;
  for (const sub of subscriptions) {
    if (sub.subscribe) {
      relay.services.pubsub.subscribe(sub.topic);
    }
  }
});   

// ─── IDLE WATCHDOG (starts only after first peer) ─────────────────────
let lastActivity = null;
let watchdog = null;

function startWatchdog() {
  if (watchdog) return;
  lastActivity = Date.now();
  watchdog = setInterval(async () => {
    const idle = Date.now() - lastActivity;
    const peerCount = relay.getPeers().length;
    if (idle > IDLE_TIMEOUT && peerCount === 0) {
      console.log(`\n  [watchdog] No peers for ${Math.round(idle / 1000)}s — shutting down.`);
      clearInterval(watchdog);
      watchdog = null;
      await shutdown();
    }
  }, 5000);
}

relay.addEventListener('peer:connect', () => {
  lastActivity = Date.now();
  startWatchdog();
});
relay.addEventListener('peer:disconnect', () => {
  lastActivity = Date.now();
});

// ─── CLEAN SHUTDOWN ───────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  try { await relay.stop(); } catch {}
  try { webServer.close(); } catch {}
  try { await unlink(CONFIG_PATH); } catch {}
  console.log('  [watchdog] relay-config.json removed.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);   