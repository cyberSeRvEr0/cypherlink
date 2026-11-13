/**
 * Cypherlink — P2P encrypted chat + video via WebRTC.
 * No npm. No bundling. Pure browser API + Python signaling.
 */

// ============ CONFIG ============
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
const SIGNALING_URL = 'ws://' + location.hostname + ':9001';
const MAX_MEMBERS = 100;

// ============ STATE ============
let peerId = self.crypto.randomUUID();   
let nickname = '';
let groupName = '';
let groupKey = '';
let groupCrypto = null;   
let signalingWs = null;
let peers = {};       // peer_id -> { pc, dc, nickname, videoEl }
let localStream = null;
let lastNick = null, lastTs = 0;

// ============ MATRIX RAIN ============
const canvas = document.getElementById('matrix');
const ctx = canvas.getContext('2d');
let cols, drops;

function initMatrix() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  cols = Math.floor(canvas.width / 14);
  drops = Array(cols).fill(1);
}
initMatrix();
window.addEventListener('resize', initMatrix);

(function drawMatrix() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '14px monospace';
  for (let i = 0; i < drops.length; i++) {
    ctx.fillStyle = `rgba(0, ${60 + Math.random() * 50}, 0, 0.5)`;
    ctx.fillText(
      String.fromCharCode(33 + Math.floor(Math.random() * 93)),
      i * 14, drops[i] * 14
    );
    if (drops[i] * 14 > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
  requestAnimationFrame(drawMatrix);
})();

// ============ CRYPTO (AES-256-GCM via WebCrypto) ============
class CypherlinkCrypto {
  constructor(inviteKey) {
    this._key = null;
    this._derive(inviteKey);
  }
  async _derive(key) {
    const ikm = new TextEncoder().encode(key);
    const base = await self.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    this._key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('cypherlink-v1') },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async encrypt(plaintext) {
    const iv = self.crypto.getRandomValues(new Uint8Array(12));
    const ct = await self.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, new TextEncoder().encode(plaintext));
    return {
      iv: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...new Uint8Array(ct)))
    };
  }
  async decrypt(ivB64, ctB64) {
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
    const pt = await self.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._key, ct);
    return new TextDecoder().decode(pt);
  }
}

// ============ SIGNALING ============
function connectSignaling(group, nick, existingPeers, onSignal) {
  return new Promise((resolve, reject) => {
    signalingWs = new WebSocket(SIGNALING_URL);

    signalingWs.onopen = () => {
      signalingWs.send(JSON.stringify({
        type: 'join', group, peer_id: peerId, nickname: nick
      }));
    };

    signalingWs.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') {
        resolve(msg.existing_peers);
      } else if (msg.type === 'error') {
        reject(new Error(msg.msg));
      } else {
        onSignal(msg);
      }
    };

    signalingWs.onerror = () => reject(new Error('Cannot reach signaling server'));
  });
}

function sendSignal(msg) {
  if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
    signalingWs.send(JSON.stringify(msg));
  }
}

// ============ WEBRTC MESH ============
function createPeerConnection(remotePeerId) {
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  const dc = pc.createDataChannel('cypherlink', { ordered: true });

  dc.onopen = () => {
    console.log(`[Cypherlink] Channel open with ${remotePeerId}`);
  };

  dc.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'msg') {
        const text = await groupCrypto.decrypt(data.iv, data.ct);
        appendMessage(data.sender, text, false);
      } else if (data.type === 'video_request') {
        handleVideoRequest(remotePeerId);
      } else if (data.type === 'video_stop') {
        stopVideoFor(remotePeerId);
      }
    } catch (e) {
      console.error('[Cypherlink] Message error:', e);
    }
  };

  dc.onclose = () => {
    console.log(`[Cypherlink] Channel closed with ${remotePeerId}`);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice', to: remotePeerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(remotePeerId);
    }
  };

  return { pc, dc };
}

async function createOffer(remotePeerId, remoteNickname) {
  const { pc, dc } = createPeerConnection(remotePeerId);
  peers[remotePeerId] = { pc, dc, nickname: remoteNickname || 'unknown' };
  updatePeerCount();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'sdp', to: remotePeerId, sdp: pc.localDescription });
}

async function handleIncomingSignal(msg) {
  if (msg.type === 'peer_joined') {
    // New peer joined — they will offer to us, we just wait
    console.log(`[Cypherlink] ${msg.nickname} (${msg.peer_id}) joined`);
    appendMessage(null, null, false, `${msg.nickname} joined the group`);

  } else if (msg.type === 'peer_left') {
    appendMessage(null, null, false, 'A peer left the group');
    removePeer(msg.peer_id);

  } else if (msg.type === 'sdp') {
    const peer = peers[msg.from];
    if (!peer) return;
    const { pc } = peer;
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    if (msg.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'sdp', to: msg.from, sdp: pc.localDescription });
    }

  } else if (msg.type === 'ice') {
    const peer = peers[msg.from];
    if (peer) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (e) {
        // Ignore duplicate/late candidates
      }
    }
  }
}

function removePeer(peerId) {
  if (peers[peerId]) {
    peers[peerId].pc.close();
    if (peers[peerId].videoEl) peers[peerId].videoEl.remove();
    delete peers[peerId];
    updatePeerCount();
  }
}

function updatePeerCount() {
  document.getElementById('peer-count').textContent =
    `${Object.keys(peers).length + 1} online`;
}

// ============ VIDEO ============
async function handleVideoRequest(remotePeerId) {
  // They want to see our camera
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      console.error('[Cypherlink] Camera denied:', e);
      return;
    }
  }
  // Add tracks to the peer connection
  const peer = peers[remotePeerId];
  if (peer) {
    localStream.getTracks().forEach(track => {
      peer.pc.addTrack(track, localStream);
    });
  }
}

function stopVideoFor(remotePeerId) {
  const peer = peers[remotePeerId];
  if (peer && peer.pc) {
    peer.pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind !== 'data') {
        peer.pc.removeTrack(sender);
      }
    });
  }
}

function toggleVideo() {
  const btn = document.getElementById('video-btn');
  if (localStream) {
    // Stop sharing
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    btn.classList.remove('active');
    btn.textContent = 'CAM';
    // Tell all peers to stop
    for (const [pid, peer] of Object.entries(peers)) {
      if (peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send(JSON.stringify({ type: 'video_stop' }));
      }
    }
    // Remove our local video
    const myVideo = document.getElementById('my-video');
    if (myVideo) myVideo.remove();
  } else {
    // Start sharing
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
      localStream = stream;
      btn.classList.add('active');
      btn.textContent = 'STOP';
      // Show local preview
      showLocalVideo(stream);
      // Ask all peers to show our video
      for (const [pid, peer] of Object.entries(peers)) {
        if (peer.dc && peer.dc.readyState === 'open') {
          peer.dc.send(JSON.stringify({ type: 'video_request' }));
        }
        // Add tracks
        stream.getTracks().forEach(track => {
          peer.pc.addTrack(track, stream);
        });
      }
    }).catch(e => console.error('[Cypherlink] Camera error:', e));
  }
}

function showLocalVideo(stream) {
  const grid = document.getElementById('video-grid');
  let tile = document.getElementById('my-video-tile');
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = 'my-video-tile';
    const video = document.createElement('video');
    video.id = 'my-video';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const name = document.createElement('span');
    name.className = 'vname';
    name.textContent = nickname + ' (you)';
    tile.appendChild(video);
    tile.appendChild(name);
    grid.prepend(tile);
  }
  const video = tile.querySelector('video');
  video.srcObject = stream;
}

function showRemoteVideo(remotePeerId, stream) {
  const grid = document.getElementById('video-grid');
  let tile = document.getElementById(`video-${remotePeerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `video-${remotePeerId}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const name = document.createElement('span');
    name.className = 'vname';
    name.textContent = peers[remotePeerId]?.nickname || '???';
    tile.appendChild(video);
    tile.appendChild(name);
    grid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

// ============ MESSAGING ============
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  appendMessage(nickname, text, true);

  // Send to all connected peers
  for (const [pid, peer] of Object.entries(peers)) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        const { iv, ct } = await groupCrypto.encrypt(text);
        peer.dc.send(JSON.stringify({
          type: 'msg', sender: nickname, iv, ct, ts: Date.now()
        }));
      } catch (e) {
        console.error(`[Cypherlink] Send to ${pid} failed:`, e);
      }
    }
  }
}

// ============ RENDER ============
function appendMessage(nick, text, isSelf, systemText) {
  const chat = document.getElementById('chat');
  const now = Date.now();
  const time = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (now - lastTs > 30000 && lastTs > 0) {
    const sep = document.createElement('div');
    sep.className = 'separator';
    chat.appendChild(sep);
  }

  const div = document.createElement('div');

  if (systemText) {
    div.className = 'msg system';
    div.textContent = `[${time}] ${systemText}`;
  } else if (nick === lastNick && now - lastTs < 5000) {
    div.className = `msg${isSelf ? ' self' : ''}`;
    div.innerHTML = `<span class="time">${time}</span><span class="text">${esc(text)}</span>`;
  } else {
    div.className = `msg${isSelf ? ' self' : ''}`;
    div.innerHTML = `<span class="time">${time}</span><span class="nick">&lt;${esc(nick)}&gt;</span> <span class="text">${esc(text)}</span>`;
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  lastNick = nick;
  lastTs = now;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ============ JOIN ============
document.querySelectorAll('#join-screen input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn').click();
  });
});

document.getElementById('join-btn').addEventListener('click', async () => {
  groupName = document.getElementById('join-group').value.trim();
  groupKey = document.getElementById('join-key').value.trim();
  nickname = document.getElementById('join-nick').value.trim();

  if (!groupName || !groupKey || !nickname) {
    document.getElementById('join-error').textContent = 'All fields required.';
    return;
  }

  try {
    groupCrypto = new CypherlinkCrypto(groupKey);

    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
    document.getElementById('group-name').textContent = `#${groupName}`;
    document.getElementById('user-name').textContent = nickname;

    // Connect to signaling
    const existingPeers = await connectSignaling(groupName, nickname, [], handleIncomingSignal);

    // Create WebRTC connection to each existing peer
    for (const p of existingPeers) {
      await createOffer(p.peer_id, p.nickname);
    }

    document.getElementById('msg-input').focus();
  } catch (e) {
    document.getElementById('join-screen').style.display = 'flex';
    document.getElementById('join-error').textContent = e.message;
  }
});

// ============ INPUT ============
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});
document.getElementById('video-btn').addEventListener('click', toggleVideo);

// ============ CLEANUP ON EXIT ============
window.addEventListener('beforeunload', () => {
  sendSignal({ type: 'leave' });
  for (const pid of Object.keys(peers)) removePeer(pid);
  if (signalingWs) signalingWs.close();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});   