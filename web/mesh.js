/**
 * Cypherlink mesh — P2P transport and live group discovery.
 *
 * GossipSub discovers peers who are currently subscribed to the same group
 * topic. The DHT record is best-effort metadata, not a group directory.
 * Reliable discovery of offline or unreachable group members requires a
 * reachable rendezvous or signaling mechanism.
 */
import { createLibp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { kadDHT } from "@libp2p/kad-dht";
import { bootstrap } from "@libp2p/bootstrap";

const BOOTSTRAP_LIST = [
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt"
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function peerIdString(peerId) {
  return peerId?.toString?.() ?? String(peerId);
}

function dhtRecordKey(groupName, peerId) {
  return encoder.encode(`cypherlink:group:${groupName}:${peerId}`);
}

function addPeer(node, peerId, nickname = "unknown") {
  if (!peerId || peerId === peerIdString(node.peerId)) return;

  const id = peerIdString(peerId);
  const existing = node._peers[id];

  if (existing) {
    if (nickname && nickname !== "unknown") existing.nickname = nickname;
    return;
  }

  node._peers[id] = { id, nickname, hasCam: false };
  node._onPeerFound?.(node._peers[id]);
}

function handlePubsubMessage(node, topic, event) {
  if (event.detail.topic !== topic) return;

  const senderId = peerIdString(event.detail.from);
  if (!senderId || senderId === peerIdString(node.peerId)) return;

  let data;
  try {
    data = JSON.parse(decoder.decode(event.detail.data));
  } catch {
    return; // Ignore malformed or unrelated topic data.
  }

  if (data?.from && peerIdString(data.from) !== senderId) return;

  addPeer(node, senderId, data?.nickname || "unknown");
  node._onMessage?.(data, senderId);
}

export async function createNode(groupName) {
  if (!groupName || typeof groupName !== "string") {
    throw new TypeError("A non-empty group name is required.");
  }

  const node = await createLibp2p({
    addresses: {
      listen: ["/webrtc", "/p2p-circuit"]
    },
    transports: [
      webRTC(),
      webSockets(),
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: BOOTSTRAP_LIST,
        interval: 30_000
      })
    ],
    services: {
      identify: identify(),
      ping: ping(),
      pubsub: gossipsub({
        allowPublishToOwnTopic: true
      }),
      dht: kadDHT({
        clientMode: false
      })
    }
  });

  const topic = `cypherlink/${groupName}`;
  node._peers = Object.create(null);
  node._groupName = groupName;

  const onPubsubMessage = event => handlePubsubMessage(node, topic, event);
  node.services.pubsub.addEventListener("message", onPubsubMessage);
  node._removePubsubListener = () =>
    node.services.pubsub.removeEventListener("message", onPubsubMessage);

  node.services.pubsub.subscribe(topic);

  // Store this peer's record under a unique key. This avoids overwriting
  // another member's record, but does not make records enumerable by group.
  try {
    const peerInfo = {
      id: peerIdString(node.peerId),
      addresses: node.getMultiaddrs().map(address => address.toString()),
      nickname: ""
    };

    await node.services.dht.put(
      dhtRecordKey(groupName, peerInfo.id),
      encoder.encode(JSON.stringify(peerInfo))
    );
  } catch (error) {
    console.warn("[Cypherlink] DHT publish failed:", error);
  }

  // Announce presence to peers currently subscribed to this topic.
  try {
    await node.services.pubsub.publish(
      topic,
      encoder.encode(JSON.stringify({
        type: "hello",
        from: peerIdString(node.peerId),
        nickname: "",
        ts: Date.now()
      }))
    );
  } catch (error) {
    console.warn("[Cypherlink] Presence announcement failed:", error);
  }

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
    return await node.services.pubsub.publish(
      topic,
      encoder.encode(JSON.stringify(payload))
    );
  } catch (error) {
    console.warn("[Cypherlink] Message publish failed:", error);
    throw error;
  }
}

export function getPeers(node) {
  return node._peers || {};
}

export async function updateNickname(node, groupName, nickname) {
  const id = peerIdString(node.peerId);

  try {
    const peerInfo = {
      id,
      addresses: node.getMultiaddrs().map(address => address.toString()),
      nickname
    };

    await node.services.dht.put(
      dhtRecordKey(groupName, id),
      encoder.encode(JSON.stringify(peerInfo))
    );
  } catch (error) {
    console.warn("[Cypherlink] DHT nickname update failed:", error);
  }

  try {
    await node.services.pubsub.publish(
      `cypherlink/${groupName}`,
      encoder.encode(JSON.stringify({
        type: "hello",
        from: id,
        nickname,
        ts: Date.now()
      }))
    );
  } catch (error) {
    console.warn("[Cypherlink] Nickname announcement failed:", error);
  }
}

export async function stopNode(node) {
  if (!node) return;

  node._removePubsubListener?.();

  try {
    if (node._groupName) {
      node.services.pubsub.unsubscribe(`cypherlink/${node._groupName}`);
    }
  } catch {
    // Continue stopping even if unsubscribing fails.
  }

  await node.stop();
}
