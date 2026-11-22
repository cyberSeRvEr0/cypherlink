/**
 * Cypherlink — P2P encrypted chat + video via libp2p GossipSub + WebRTC.
 * No host. No database. Deterministic group+key mesh routing.
 */

// ============ IMPORTS ============
import {
  createNode,
  setMessageHandler,
  setPeerFoundHandler,
  setPeerLeftHandler,
  sendMessage,
  updateNickname,
  stopNode,
} from './mesh.js';

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
    this._ready = this._derive(inviteKey);
  }
  async _derive(key) {
    const ikm = new TextEncoder().encode(key);
    const password = await self.crypto.subtle.importKey(
      'raw',
      ikm,
      'PBKDF2',
      false,
      ['deriveKey']
    );
    this._key = await self.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode('cypherlink-v1'),
        iterations: 250000,
        hash: 'SHA-256',
      },
      password,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async encrypt(plaintext) {
    await this._ready;
    const iv = self.crypto.getRandomValues(new Uint8Array(12));
    const ct = await self.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, new TextEncoder().encode(plaintext));
    return {
      iv: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...new Uint8Array(ct)))
    };
  }
  async decrypt(ivB64, ctB64) {
    await this._ready;
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
    const pt = await self.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._key, ct);
    return new TextDecoder().decode(pt);
  }
}

// ============ MESSAGE HANDLER ============
async function handleIncoming(data, senderId) {
  const selfId = meshNode ? meshNode.peerId.toString() : null;

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
      updateCamList();
    }
  } else if (data.type === 'cam_on') {
    if (senderId && meshNode._peers[senderId]) {
      meshNode._peers[senderId].hasCam = true;
      updateCamList();
      if (localStream) {
        sendVideoOffer(senderId);
      }
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
    if (!data.to || data.to === selfId) {
      handleVideoSignal(data, senderId);
    }
  } else if (data.type === 'vid_ice') {
    if (!data.to || data.to === selfId) {
      const pc = videoPcs[senderId] || await createVideoConnection(senderId);
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
      } else {
        const candidates = pendingVideoIce.get(senderId) || [];
        candidates.push(data.candidate);
        pendingVideoIce.set(senderId, candidates);
      }
    }
  }
}

// ============ VIDEO (Circle UI) ============
let activeVideoPeer = null;
let videoPcs = {};
const pendingVideoIce = new Map();
const pendingVideoOffers = new Set();
const videoOfferLocks = new Set();
const videoSignalQueues = new Map();

function showVideoInCircle(stream) {
  const video = document.getElementById('circle-video');
  if (video) {
    video.srcObject = stream;
    video.muted = stream === localStream;
    document.getElementById('video-circle').style.display = 'block';
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
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
  if (!list || !meshNode) return;
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
    const hasCam = localStream || Object.values(meshNode._peers).some(p => p.hasCam && p.stream);
    circle.style.display = hasCam ? 'flex' : 'none';
  }
}

async function createVideoConnection(peerId) {
  let networkConfig = {};
  try {
    const response = await fetch('/relay-config.json', { cache: 'no-store' });
    if (response.ok) networkConfig = await response.json();
  } catch {}

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (networkConfig.turnUrl) {
    iceServers.push({
      urls: networkConfig.turnUrl,
      username: networkConfig.turnUsername || 'cypherlink',
      credential: networkConfig.turnCredential || 'cypherlink',
    });
  }

  const pc = new RTCPeerConnection({ iceServers });
  videoPcs[peerId] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendMessage(meshNode, meshTopic, {
        type: 'vid_ice', to: peerId, from: meshNode.peerId.toString(), candidate: e.candidate
      });
    }
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (stream && meshNode._peers[peerId]) {
      meshNode._peers[peerId].stream = stream;
      meshNode._peers[peerId].hasCam = true;
      updateCamList();
      if (!activeVideoPeer || activeVideoPeer === peerId) {
        activeVideoPeer = peerId;
        showVideoInCircle(stream);
      }
    }
  };

  return pc;
}

async function sendVideoOffer(peerId) {
  // Deterministic offerer: only the smaller peer ID sends offers.
  // This eliminates glare entirely.
  if (meshNode.peerId.toString() > peerId) return;
  if (videoOfferLocks.has(peerId)) {
    pendingVideoOffers.add(peerId);
    return;
  }

  videoOfferLocks.add(peerId);
  let pc;
  try {
    pc = videoPcs[peerId];
    if (!pc) pc = await createVideoConnection(peerId);

    if (pc.signalingState !== 'stable') {
      pendingVideoOffers.add(peerId);
      return;
    }

    if (localStream) {
      const existingSenders = pc.getSenders().map(s => s.track);
      localStream.getTracks().forEach(t => {
        if (!existingSenders.includes(t)) {
          pc.addTrack(t, localStream);
        }
      });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendMessage(meshNode, meshTopic, {
      type: 'vid_sdp', to: peerId, from: meshNode.peerId.toString(), sdp: pc.localDescription
    });
  } finally {
    videoOfferLocks.delete(peerId);
    await flushPendingVideoOffer(peerId, pc);
  }
}   

async function flushPendingVideoOffer(peerId, pc = videoPcs[peerId]) {
  if (!pendingVideoOffers.has(peerId) || !pc || pc.signalingState !== 'stable' || videoOfferLocks.has(peerId)) return;
  pendingVideoOffers.delete(peerId);
  await sendVideoOffer(peerId);
}

async function handleVideoSignal(data, senderId) {
  const previous = videoSignalQueues.get(senderId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => processVideoSignal(data, senderId));
  videoSignalQueues.set(senderId, current);
  try {
    await current;
  } finally {
    if (videoSignalQueues.get(senderId) === current) {
      videoSignalQueues.delete(senderId);
    }
  }
}

async function processVideoSignal(data, senderId) {
  let pc = videoPcs[senderId];
  if (!pc) pc = await createVideoConnection(senderId);

  if (data.sdp.type === 'offer') {
    if (meshNode.peerId.toString() < senderId) return;
    if (pc.signalingState !== 'stable') return;

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await applyPendingVideoIce(senderId, pc);
    if (localStream) {
      const existingSenders = pc.getSenders().map(s => s.track);
      localStream.getTracks().forEach(t => {
        if (!existingSenders.includes(t)) {
          pc.addTrack(t, localStream);
        }
      });
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMessage(meshNode, meshTopic, {
      type: 'vid_sdp', to: senderId, from: meshNode.peerId.toString(), sdp: pc.localDescription
    });
  } else if (data.sdp.type === 'answer' && pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await applyPendingVideoIce(senderId, pc);
    await flushPendingVideoOffer(senderId, pc);
  }
}

async function applyPendingVideoIce(peerId, pc) {
  const candidates = pendingVideoIce.get(peerId) || [];
  pendingVideoIce.delete(peerId);
  for (const candidate of candidates) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  }
}

function toggleVideo() {
  const btn = document.getElementById('video-btn');
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    btn.classList.remove('active');
    btn.textContent = 'CAM';
    sendMessage(meshNode, meshTopic, { type: 'cam_off', from: meshNode.peerId.toString() });
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
      showVideoInCircle(stream);
      sendMessage(meshNode, meshTopic, { type: 'cam_on', from: meshNode.peerId.toString(), nickname });
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
  const customRelay = document.getElementById('join-relay')?.value.trim() || '';

  if (!groupName || !groupKey || !nickname) {
    document.getElementById('join-error').textContent = 'All fields required.';
    return;
  }

  try {
    document.getElementById('join-error').textContent = 'Connecting to network...';

    groupCrypto = new CypherlinkCrypto(groupKey);
    await groupCrypto._ready;

    const result = await createNode(groupName, groupKey, customRelay);
    meshNode = result.node;
    meshTopic = result.topic;

    setMessageHandler(meshNode, handleIncoming);
    setPeerFoundHandler(meshNode, (peer) => {
      updatePeerCount();
      appendMessage(null, null, false, 'A member is in the group');
      if (localStream) {
        sendVideoOffer(peer.id);
      }
    });
    setPeerLeftHandler(meshNode, (peerId) => {
      if (videoPcs[peerId]) {
        videoPcs[peerId].close();
        delete videoPcs[peerId];
      }
      if (activeVideoPeer === peerId) {
        activeVideoPeer = null;
        clearCircle();
      }
      updateCamList();
      updatePeerCount();
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

function closeRoom() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  for (const pc of Object.values(videoPcs)) pc.close();
  videoPcs = {};
  if (meshNode) stopNode(meshNode);
  meshNode = null;
  meshTopic = null;
  groupCrypto = null;

  document.getElementById('chat-screen').style.display = 'none';
  document.getElementById('join-screen').style.display = 'flex';
  document.getElementById('chat').replaceChildren();
  document.getElementById('msg-input').value = '';
  document.getElementById('join-error').textContent = 'Room closed. No room data is retained.';
}

document.getElementById('close-btn').addEventListener('click', closeRoom);

// ============ CLEANUP ============
window.addEventListener('beforeunload', () => {
  if (meshNode) stopNode(meshNode);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});
