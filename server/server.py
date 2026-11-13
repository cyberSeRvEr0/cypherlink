#!/usr/bin/env python3
"""Cypherlink — WebRTC signaling server. RAM only, no disk writes."""
import asyncio
import json
import uuid
import websockets

# peer_id -> websocket
CONNECTIONS = {}
# group -> set of peer_ids
GROUPS = {}
MAX_MEMBERS = 100


async def handler(websocket):
    peer_id = None
    group = None

    try:
        # First message must be join
        raw = await websocket.recv()
        msg = json.loads(raw)

        if msg["type"] != "join":
            await websocket.close()
            return

        peer_id = msg["peer_id"]
        group = msg["group"]
        nickname = msg.get("nickname", "anon")

        if group not in GROUPS:
            GROUPS[group] = {}

        if len(GROUPS[group]) >= MAX_MEMBERS:
            await websocket.send(json.dumps({"type": "error", "msg": "Group full"}))
            return

        # Tell the new peer who's already here
        existing = [
            {"peer_id": pid, "nickname": info.get("nickname", "anon")}
            for pid, info in GROUPS[group].items()
            if pid != peer_id
        ]

        GROUPS[group][peer_id] = {"nickname": nickname, "ws": websocket}
        CONNECTIONS[peer_id] = websocket

        await websocket.send(json.dumps({
            "type": "joined",
            "peer_id": peer_id,
            "group": group,
            "existing_peers": existing
        }))

        # Tell existing peers that someone new joined
        for pid, info in GROUPS[group].items():
            if pid != peer_id:
                try:
                    await info["ws"].send(json.dumps({
                        "type": "peer_joined",
                        "peer_id": peer_id,
                        "nickname": nickname
                    }))
                except Exception:
                    pass

        # Main loop: relay signaling messages
        while True:
            raw = await websocket.recv()
            msg = json.loads(raw)

            if msg["type"] == "sdp":
                # Forward SDP offer/answer to target peer
                target = msg["to"]
                if target in CONNECTIONS:
                    forward = {"type": "sdp", "from": peer_id, "sdp": msg["sdp"]}
                    await CONNECTIONS[target].send(json.dumps(forward))

            elif msg["type"] == "ice":
                # Forward ICE candidate to target peer
                target = msg["to"]
                if target in CONNECTIONS:
                    forward = {"type": "ice", "from": peer_id, "candidate": msg["candidate"]}
                    await CONNECTIONS[target].send(json.dumps(forward))

            elif msg["type"] == "leave":
                break

    except websockets.ConnectionClosed:
        pass
    finally:
        if group and peer_id:
            if group in GROUPS and peer_id in GROUPS[group]:
                del GROUPS[group][peer_id]
            # Notify remaining peers
            for pid, info in GROUPS.get(group, {}).items():
                try:
                    await info["ws"].send(json.dumps({
                        "type": "peer_left",
                        "peer_id": peer_id
                    }))
                except Exception:
                    pass
        CONNECTIONS.pop(peer_id, None)


async def main():
    async with websockets.serve(handler, "0.0.0.0", 9001):
        print("[Cypherlink] Signaling server on ws://0.0.0.0:9001")
        print("[Cypherlink] No data stored. RAM only.")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())   