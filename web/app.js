/**
 * Cypherlink — P2P encrypted chat + video via libp2p GossipSub + WebRTC.
 * No host. No meeting point. Each user is independent.
 */

// ============ IMPORTS ============
import { createNode, setMessageHandler, setPeerFoundHandler, sendMessage, updateNickname, stopNode } from './mesh.js';

// ============ CONFIG ============
const MAX_MEMBERS = 100;

// ============ STATE ============
let nickname = '';
let groupName = '';
let groupCrypto = null;
let meshNode = null;
let meshTopic = null;
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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '14px monospace';
  for (let i = 0; i < drops.length; i++) {
    ctx.fillStyle = `rgba(0, ${120 + Math.random() * 80}, 0, 0.8)`;
    ctx.fillText(
      String.fromCharCode(33 + Math.floor(Math.random() * 93)),
      i * 14, drops[i] * 14
    );
    if (drops[i] * 14 > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
  requestAnimationFrame(drawMatrix);
})();

// ============ CRYPTO (AES-256-GCM) ============
class CypherlinkCrypto {
  constructor(inviteKey) {
    this._derive(inviteKey);
  }
  async _derive(key) {
    const ikm = new TextEncoder().encode(key);
    const base = await self.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    this._key = await self.crypto.subtle.deriveKey(
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

// ============ MESSAGE HANDLER ============
async function handleIncoming(data, senderId) {
  if (data.type === 'msg') {
    try {
      const text = await groupCrypto.decrypt(data.iv, data.ct);
      if (data.sender !== nickname) {
        appendMessage(data.sender, text, false);
      }
    } catch (e) {
      console.error('[Cypherlink] Decrypt failed:', e);
    }
  } else if (data.type === 'hello') {
    if (senderId && meshNode._peers[senderId]) {
      meshNode._peers[senderId].nickname = data.nickname || 'unknown';
      updatePeerCount();
    }
  } else if (data.type === 'cam_on') {
    if (senderId && meshNode._peers[senderId]) {
      meshNode._peers[senderId].hasCam = true;
      updateCamList();
      sendVideoOffer(senderId);
    }
  } else if (data.type === 'cam_off') {
    if (senderId && meshNode._peers[senderId]) {
      meshNode._peers[senderId].hasCam = false;
      meshNode._peers[senderId].stream = null;
      const pc = videoPcs[senderId];
      if (pc) { pc.close(); delete videoPcs[senderId]; }
      if (activeVideoPeer === senderId) { activeVideoPeer = null; clearCircle(); }
      updateCamList();
    }
  } else if (data.type === 'vid_sdp') {
    handleVideoSignal(data, senderId);
  } else if (data.type === 'vid_ice') {
    const pc = videoPcs[senderId];
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  }
}

// ============ VIDEO (Circle UI) ============
let activeVideoPeer = null;
let videoPcs = {};

function showVideoInCircle(stream) {
  const video = document.getElementById('circle-video');
  if (video) {
    video.srcObject = stream;
    document.getElementById('video-circle').style.display = 'block';
  }
}

function clearCircle() {
  const video = document.getElementById('circle-video');
  if (video) {
    video.srcObject = null;
    document.getElementById('video-circle').style.display = 'none';
  }
}

function updateCamList() {
  const list = document.getElementById('cam-list');
  if (!list) return;
  list.innerHTML = '';

  if (localStream) {
    const btn = document.createElement('span');
    btn.className = 'cam-name self';
    btn.textContent = nickname;
    btn.onclick = () => { activeVideoPeer = 'self'; showVideoInCircle(localStream); };
    list.appendChild(btn);
  }

  for (const [pid, peer] of Object.entries(meshNode._peers)) {
    if (peer.hasCam && peer.stream) {
      const btn = document.createElement('span');
      btn.className = 'cam-name';
      btn.textContent = peer.nickname || '???';
      btn.onclick = () => { activeVideoPeer = pid; showVideoInCircle(peer.stream); };
      list.appendChild(btn);
    }
  }

  const circle = document.getElementById('video-circle');
  if (circle) {
    const hasCam = localStream || Object.values(meshNode._peers).some(p => p.hasCam);
    circle.style.display = hasCam ? 'flex' : 'none';
  }
}

async function createVideoConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:localhost:3478', username: 'cypherlink', credential: 'cypherlink123' }
    ]
  });
  videoPcs[peerId] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendMessage(meshNode, meshTopic, {
        type: 'vid_ice', to: peerId, from: meshNode.peerId.id, candidate: e.candidate
      });
    }
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (stream && meshNode._peers[peerId]) {
      meshNode._peers[peerId].stream = stream;
      meshNode._peers[peerId].hasCam = true;
      updateCamList();
      if (activeVideoPeer === peerId) showVideoInCircle(stream);
    }
  };

  return pc;
}

async function sendVideoOffer(peerId) {
  let pc = videoPcs[peerId];
  if (!pc) pc = await createVideoConnection(peerId);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendMessage(meshNode, meshTopic, {
    type: 'vid_sdp', to: peerId, from: meshNode.peerId.id, sdp: pc.localDescription
  });
}

async function handleVideoSignal(data, senderId) {
  let pc = videoPcs[senderId];
  if (!pc) pc = await createVideoConnection(senderId);

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  if (data.sdp.type === 'offer') {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMessage(meshNode, meshTopic, {
      type: 'vid_sdp', to: senderId, from: meshNode.peerId.id, sdp: pc.localDescription
    });
  }
}

function toggleVideo() {
  const btn = document.getElementById('video-btn');
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    btn.classList.remove('active');
    btn.textContent = 'CAM';
    sendMessage(meshNode, meshTopic, { type: 'cam_off', from: meshNode.peerId.id });
    if (activeVideoPeer === 'self') { activeVideoPeer = null; clearCircle(); }
    updateCamList();
  } else {
    navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    }).then(stream => {   
      localStream = stream;
      btn.classList.add('active');
      btn.textContent = 'STOP';
      activeVideoPeer = 'self';
      showVideoInCircle(stream);
      sendMessage(meshNode, meshTopic, { type: 'cam_on', from: meshNode.peerId.id, nickname });
      for (const pid of Object.keys(meshNode._peers)) {
        sendVideoOffer(pid);
      }
      updateCamList();
    }).catch(e => {
      console.error('[Cypherlink] Camera error:', e);
      alert('Camera access denied.');
    });
  }
}

// ============ MESSAGING ============
async function sendMessageHandler() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  appendMessage(nickname, text, true);

  try {
    const { iv, ct } = await groupCrypto.encrypt(text);
    sendMessage(meshNode, meshTopic, {
      type: 'msg',
      sender: nickname,
      iv,
      ct,
      ts: Date.now()
    });
  } catch (e) {
    console.error('[Cypherlink] Send failed:', e);
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

function updatePeerCount() {
  const count = Object.keys(meshNode._peers).length + 1;
  document.getElementById('peer-count').textContent = `${count} online`;
}

// ============ JOIN ============
document.querySelectorAll('#join-screen input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn').click();
  });
});

document.getElementById('join-btn').addEventListener('click', async () => {
  groupName = document.getElementById('join-group').value.trim();
  const groupKey = document.getElementById('join-key').value.trim();
  nickname = document.getElementById('join-nick').value.trim();

  if (!groupName || !groupKey || !nickname) {
    document.getElementById('join-error').textContent = 'All fields required.';
    return;
  }

  try {
    document.getElementById('join-error').textContent = 'Connecting to network...';

    groupCrypto = new CypherlinkCrypto(groupKey);

    const result = await createNode(groupName);
    meshNode = result.node;
    meshTopic = result.topic;

    setMessageHandler(meshNode, handleIncoming);
    setPeerFoundHandler(meshNode, (peer) => {
      updatePeerCount();
      appendMessage(null, null, false, 'A member is in the group');
    });

    // Announce our nickname to the group
    await updateNickname(meshNode, meshTopic, nickname);

    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
    document.getElementById('group-name').textContent = `#${groupName}`;
    document.getElementById('user-name').textContent = nickname;
    document.getElementById('join-error').textContent = '';

    updatePeerCount();
    appendMessage(null, null, false, `You joined #${groupName} as ${nickname}`);
    document.getElementById('msg-input').focus();

  } catch (e) {
    console.error('[Cypherlink] Join failed:', e);
    document.getElementById('join-screen').style.display = 'flex';
    document.getElementById('join-error').textContent = e.message || 'Connection failed';
  }
});

// ============ INPUT ============
document.getElementById('send-btn').addEventListener('click', sendMessageHandler);
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessageHandler();
});
document.getElementById('video-btn').addEventListener('click', toggleVideo);

// ============ CLEANUP ============
window.addEventListener('beforeunload', () => {
  if (meshNode) stopNode(meshNode);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});   