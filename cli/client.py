#!/usr/bin/env python3
"""Cypherlink CLI client — terminal with matrix rain background."""
import curses, threading, socket, json, os, time, sys, secrets
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def derive_key(invite_key: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b'\x00'*32,
                info=b'cypherlink-v1').derive(invite_key.encode())

class CypherlinkCLI:
    def __init__(self, host, port, group, key, nick):
        self.host, self.port = host, port
        self.group, self.nick = group, nick
        self.aes = AESGCM(derive_key(key))
        self.messages = []
        self.running = False

    def run(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((self.host, self.port))
        self.sock.sendall(json.dumps({
            "type": "join", "topic": self.group, "key": "pending"
        }).encode() + b'\n')

        self.running = True
        t = threading.Thread(target=self._listen, daemon=True)
        t.start()
        curses.wrapper(self._ui)

    def _listen(self):
        buf = b''
        while self.running:
            try:
                data = self.sock.recv(4096)
                if not data: break
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    msg = json.loads(line)
                    if msg.get("type") == "message":
                        iv = bytes.fromhex(msg["iv"])
                        ct = bytes.fromhex(msg["ciphertext"])
                        text = self.aes.decrypt(iv, ct).decode()
                        self.messages.append((msg["sender"], text, time.time()))
            except: break

    def _ui(self, stdscr):
        stdscr.nodelay(True)
        stdscr.keypad(True)
        curses.curs_set(1)
        input_buf = ''
        # ... (curses matrix rain + chat rendering, same logic as web)
        while self.running:
            h, w = stdscr.getmaxyx()
            stdscr.erase()
            # Header
            stdscr.addnstr(0, 0, f"  #{self.group}", w-2, curses.color_pair(1))
            stdscr.addnstr(1, 0, f"  YOU: {self.nick}", w-2, curses.color_pair(2))
            # Messages (last h-4 lines)
            visible = self.messages[-(h-5):]
            for i, (nick, text, ts) in enumerate(visible):
                y = 3 + i
                if y >= h-2: break
                t = time.strftime('%H:%M:%S', time.localtime(ts))
                line = f"[{t}] <{nick}> {text}"
                stdscr.addnstr(y, 0, line, w-2, curses.color_pair(3))
            # Input
            stdscr.addnstr(h-1, 0, f"> {input_buf}_", w-2, curses.color_pair(4))
            stdscr.refresh()

            ch = stdscr.getch()
            if ch == -1:
                time.sleep(0.05)
            elif ch in (10, 13):  # Enter
                if input_buf.strip():
                    iv = os.urandom(12)
                    ct = self.aes.encrypt(iv, input_buf.encode(), None)
                    self.sock.sendall(json.dumps({
                        "type": "message", "sender": self.nick,
                        "iv": iv.hex(), "ciphertext": ct.hex(), "ts": int(time.time()*1000)
                    }).encode() + b'\n')
                    self.messages.append((self.nick, input_buf, time.time()))
                    input_buf = ''
                stdscr.refresh()
            elif ch == 27:  # ESC
                self.running = False
            elif ch == curses.KEY_BACKSPACE or ch == 127:
                input_buf = input_buf[:-1]
            elif 32 <= ch < 127:
                input_buf += chr(ch)

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description='Cypherlink CLI')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=9001)
    p.add_argument('--group', required=True)
    p.add_argument('--key', required=True)
    p.add_argument('--nick', required=True)
    args = p.parse_args()
    CypherlinkCLI(args.host, args.port, args.group, args.key, args.nick).run()   