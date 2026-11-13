#!/usr/bin/env python3
"""Cypherlink relay server — signaling + GossipSub topic routing only."""
import asyncio, json, uuid, websockets

GROUPS: dict[str, set[str]] = {}  # topic -> set of connected peer IDs
MAX_MEMBERS = 100

async def handler(websocket):
    peer_id = str(uuid.uuid4())
    topic = None

    try:
        # First message must be: {"type": "join", "topic": "groupname", "key": "invite_key"}
        raw = await websocket.recv()
        msg = json.loads(raw)

        if msg["type"] == "join":
            topic = msg["topic"]
            # In production: verify msg["key"] against stored group keys
            if topic not in GROUPS:
                GROUPS[topic] = set()
            if len(GROUPS[topic]) >= MAX_MEMBERS:
                await websocket.send(json.dumps({"type": "error", "msg": "Group full"}))
                return
            GROUPS[topic].add(peer_id)
            await websocket.send(json.dumps({"type": "joined", "peer_id": peer_id, "topic": topic}))

        while True:
            raw = await websocket.recv()
            msg = json.loads(raw)

            if msg["type"] == "signal":
                # Relay WebRTC SDP/ICE signals to a specific peer
                target = msg["to"]
                if target in GROUPS.get(topic, set()):
                    # Find and forward (simplified — use a dict of active connections)
                    pass

            elif msg["type"] == "gossip":
                # Relay GossipSub messages to all other members of the group
                for other in GROUPS.get(topic, set()):
                    if other != peer_id:
                        # Forward via their websocket (look up in CONNECTIONS dict)
                        pass

    except websockets.ConnectionClosed:
        pass
    finally:
        if topic and peer_id in GROUPS.get(topic, set()):
            GROUPS[topic].discard(peer_id)

async def main():
    async with websockets.serve(handler, "0.0.0.0", 9001):
        print("[Cypherlink] Relay listening on ws://0.0.0.0:9001")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())   