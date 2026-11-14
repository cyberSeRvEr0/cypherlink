/**
 * Cypherlink — P2P encrypted chat + video via libp2p GossipSub + WebRTC.
 * Existing UI; leave-and-delete button is added by this file.
 */

import {
  createNode,
  setMessageHandler,
  setPeerFoundHandler,
  sendMessage,
  updateNickname,
  stopNode
} from './mesh.js';

// ============ STATE ============
let nickname = '';
let groupName = '';
let groupCrypto = null;
let meshNode = null;
let meshTopic = null;
let localStream = null;
let lastNick = null;
let lastTs = 0;
let activeVideoPeer = null;
let videoPcs = Object.create(null);
let deletingData = false;

// ============ MATRIX RAIN ============
const canvas = document.getElementById('matrix');
const ctx = canvas?.getContext('2d');
let cols = 0;
let drops = [];

function initMatrix() {
  if (!canvas || !ctx) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  cols = Math.floor(canvas.width / 14);
  drops = Array(cols).fill(1);
}

initMatrix();
window.addEventListener('resize', initMatrix);

(function drawMatrix() {
  if (ctx && canvas) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px monospace';

    for (let i = 0; i < drops.length; i++) {
      ctx.fillStyle = `rgba(0, ${120 + Math.random() * 80}, 0, 0.8)`;
      ctx.fillText(
        String.fromCharCode(33 + Math.floor(Math.random() * 93)),
        i * 14,
        drops[i] * 14
      );
      if (drops[i] * 14 > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }
  requestAnimationFrame(drawMatrix);
})();

// ============ CRYPTO (AES-256-GCM) ============
class CypherlinkCrypto {
  constructor(inviteKey) {
    // Keep the promise so encrypt/decrypt can wait until derivation finishes.
    this.ready = this._derive(inviteKey);
    this._key = null;
  }

  async _derive(key) {
    const ikm = new TextEncoder().encode(key);
    const base = await crypto.subtle.importKey(
      'raw',
      ikm,
      'HKDF',
      false,
      ['deriveKey']
    );

    this._key = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('cypherlink-v1')
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encrypt(plaintext) {
    await this.ready;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this._key,
      new TextEncoder().encode(plaintext)
    );

    return {
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  async decrypt(ivB64, ctB64) {
    await this.ready;
    const iv = base64ToBytes(ivB64);
    const ciphertext = base64ToBytes(ctB64);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this._key,
      ciphertext
    );
    return new TextDecoder().decode(plaintext);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

// ============ MESSAGE HANDLER ============
async function handleIncoming(data, senderId) {
  if (!data || !meshNode) return;

  if (data.type === 'msg') {
    try {
      const text = await groupCrypto.decrypt(data.iv, data.ct);
      if (data.sender !== nickname) appendMessage(data.sender || 'unknown', text, false);
    } catch (error) {
      console.error('[Cypherlink] Decrypt failed:', error);
    }
    return;
  }

  if (data.type === 'hello') {
    if (senderId && meshNode._peers?.[senderId]) {
      meshNode._peers[senderId].nickname = data.nickname || 'unknown';
      updatePeerCount();
      updateCamList();
    }
    return;
  }

  if (data.type === 'leave') {
    if (senderId) {
      const pc = videoPcs[senderId];
      if (pc) {
        pc.close();
        delete videoPcs[senderId];
      }
      if (meshNode._peers?.[senderId]) delete meshNode._peers[senderId];
      if (activeVideoPeer === senderId) {
        activeVideoPeer = null;
        clearCircle();
      }
      updatePeerCount();
      updateCamList();
      appendMessage(null, null, false, `${data.nickname || 'A member'} left the group`);
    }
    return;
  }

  if (data.type === 'cam_on') {
    if (senderId && meshNode._peers?.[senderId]) {
      meshNode._peers[senderId].hasCam = true;
      updateCamList();
      await sendVideoOffer(senderId);
    }
    return;
  }

  if (data.type === 'cam_off') {
    if (senderId && meshNode._peers?.[senderId]) {
      meshNode._peers[senderId].hasCam = false;
      meshNode._peers[senderId].stream = null;

      const pc = videoPcs[senderId];
      if (pc) {
        pc.close();
        delete videoPcs[senderId];
      }

      if (activeVideoPeer === senderId) {
        activeVideoPeer = null;
        clearCircle();
      }
      updateCamList();
    }
    return;
  }

  if (data.type === 'vid_sdp') {
    if (data.to && data.to !== meshNode.peerId.toString()) return;
    await handleVideoSignal(data, senderId);
    return;
  }

  if (data.type === 'vid_ice') {
    if (data.to && data.to !== meshNode.peerId.toString()) return;
    const pc = videoPcs[senderId];
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (error) {
        console.warn('[Cypherlink] ICE candidate failed:', error);
      }
    }
  }
}

// ============ VIDEO ============
function showVideoInCircle(stream) {
  const video = document.getElementById('circle-video');
  const circle = document.getElementById('video-circle');
  if (video && circle) {
    video.srcObject = stream;
    circle.style.display = 'block';
  }
}

function clearCircle() {
  const video = document.getElementById('circle-video');
  const circle = document.getElementById('video-circle');
  if (video) video.srcObject = null;
  if (circle) circle.style.display = 'none';
}

function updateCamList() {
  const list = document.getElementById('cam-list');
  if (!list || !meshNode) return;
  list.replaceChildren();

  if (localStream) {
    const button = document.createElement('span');
    button.className = 'cam-name self';
    button.textContent = nickname;
    button.onclick = () => {
      activeVideoPeer = 'self';
      showVideoInCircle(localStream);
    };
    list.appendChild(button);
  }

  for (const [peerId, peer] of Object.entries(meshNode._peers || {})) {
    if (peer.hasCam && peer.stream) {
      const button = document.createElement('span');
      button.className = 'cam-name';
      button.textContent = peer.nickname || '???';
      button.onclick = () => {
        activeVideoPeer = peerId;
        showVideoInCircle(peer.stream);
      };
      list.appendChild(button);
    }
  }

  const circle = document.getElementById('video-circle');
  if (circle) {
    const hasCamera =
      Boolean(localStream) ||
      Object.values(meshNode._peers || {}).some(peer => peer.hasCam);
    circle.style.display = hasCamera ? 'flex' : 'none';
  }
}

async function createVideoConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Replace localhost with a publicly reachable TURN server for remote users.
      { urls: 'turn:localhost:3478', username: 'cypherlink', credential: 'cypherlink123' }
    ]
  });

  videoPcs[peerId] = pc;

  pc.onicecandidate = event => {
    if (event.candidate && meshNode && meshTopic) {
      sendMessage(meshNode, meshTopic, {
        type: 'vid_ice',
        to: peerId,
        from: meshNode.peerId.toString(),
        candidate: event.candidate
      });
    }
  };

  pc.ontrack = event => {
    const stream = event.streams[0];
    if (stream && meshNode?._peers?.[peerId]) {
      meshNode._peers[peerId].stream = stream;
      meshNode._peers[peerId].hasCam = true;
      updateCamList();
      if (activeVideoPeer === peerId) showVideoInCircle(stream);
    }
  };

  return pc;
}

async function sendVideoOffer(peerId) {
  if (!meshNode || !meshTopic) return;

  let pc = videoPcs[peerId];
  if (!pc) pc = await createVideoConnection(peerId);

  if (localStream && pc.getSenders().length === 0) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await sendMessage(meshNode, meshTopic, {
    type: 'vid_sdp',
    to: peerId,
    from: meshNode.peerId.toString(),
    sdp: pc.localDescription
  });
}

async function handleVideoSignal(data, senderId) {
  if (!senderId || !meshNode) return;

  let pc = videoPcs[senderId];
  if (!pc) pc = await createVideoConnection(senderId);

  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

  if (data.sdp.type === 'offer') {
    if (localStream && pc.getSenders().length === 0) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await sendMessage(meshNode, meshTopic, {
      type: 'vid_sdp',
      to: senderId,
      from: meshNode.peerId.toString(),
      sdp: pc.localDescription
    });
  }
}

async function toggleVideo() {
  const button = document.getElementById('video-btn');
  if (!button || !meshNode) return;

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    button.classList.remove('active');
    button.textContent = 'CAM';

    await sendMessage(meshNode, meshTopic, {
      type: 'cam_off',
      from: meshNode.peerId.toString()
    });

    if (activeVideoPeer === 'self') {
      activeVideoPeer = null;
      clearCircle();
    }
    updateCamList();
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    button.classList.add('active');
    button.textContent = 'STOP';
    activeVideoPeer = 'self';
    showVideoInCircle(localStream);

    await sendMessage(meshNode, meshTopic, {
      type: 'cam_on',
      from: meshNode.peerId.toString(),
      nickname
    });

    for (const peerId of Object.keys(meshNode._peers || {})) {
      await sendVideoOffer(peerId);
    }
    updateCamList();
  } catch (error) {
    console.error('[Cypherlink] Camera error:', error);
    alert('Camera access denied or unavailable.');
  }
}

// ============ MESSAGING ============
async function sendMessageHandler() {
  if (!meshNode || !groupCrypto) return;

  const input = document.getElementById('msg-input');
  const text = input?.value.trim();
  if (!text) return;
  input.value = '';

  try {
    const { iv, ct } = await groupCrypto.encrypt(text);
    await sendMessage(meshNode, meshTopic, {
      type: 'msg',
      sender: nickname,
      iv,
      ct,
      ts: Date.now()
    });
    appendMessage(nickname, text, true);
  } catch (error) {
    console.error('[Cypherlink] Send failed:', error);
  }
}

// ============ RENDER ============
function appendMessage(nick, text, isSelf, systemText) {
  const chat = document.getElementById('chat');
  if (!chat) return;

  const now = Date.now();
  const time = new Date(now).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  if (now - lastTs > 30000 && lastTs > 0) {
    const separator = document.createElement('div');
    separator.className = 'separator';
    chat.appendChild(separator);
  }

  const div = document.createElement('div');

  if (systemText) {
    div.className = 'msg system';
    div.textContent = `[${time}] ${systemText}`;
  } else {
    div.className = `msg${isSelf ? ' self' : ''}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = time;

    if (nick !== lastNick || now - lastTs >= 5000) {
      const nickSpan = document.createElement('span');
      nickSpan.className = 'nick';
      nickSpan.textContent = `<${nick}> `;
      div.append(timeSpan, nickSpan);
    } else {
      div.appendChild(timeSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = text;
    div.appendChild(textSpan);
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  lastNick = nick;
  lastTs = now;
}

function updatePeerCount() {
  const count = Object.keys(meshNode?._peers || {}).length + 1;
  const element = document.getElementById('peer-count');
  if (element) element.textContent = `${count} online`;
}

// ============ LEAVE / DELETE ============
function addLeaveButton() {
  const chatScreen = document.getElementById('chat-screen');
  if (!chatScreen || document.getElementById('leave-delete-btn')) return;

  const button = document.createElement('button');
  button.id = 'leave-delete-btn';
  button.type = 'button';
  button.textContent = 'LEAVE & DELETE MY DATA';
  button.addEventListener('click', leaveAndDeleteLocalData);
  chatScreen.appendChild(button);
}

async function leaveAndDeleteLocalData() {
  if (deletingData) return;
  if (!confirm('Leave this group and delete Cypherlink data saved by this app in this browser?')) {
    return;
  }

  deletingData = true;

  if (meshNode && meshTopic) {
    try {
      await sendMessage(meshNode, meshTopic, {
        type: 'leave',
        from: meshNode.peerId.toString(),
        nickname,
        ts: Date.now()
      });
    } catch (error) {
      console.warn('[Cypherlink] Leave announcement failed:', error);
    }
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  for (const pc of Object.values(videoPcs)) pc.close();
  videoPcs = Object.create(null);
  clearCircle();

  if (meshNode) {
    try {
      await stopNode(meshNode);
    } catch (error) {
      console.warn('[Cypherlink] Node shutdown failed:', error);
    }
  }

  // No IndexedDB history is currently implemented, but remove this app's
  // database if one exists in a later version.
  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('cypherlink-chat');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other Cypherlink tabs and retry.'));
    });
  } catch (error) {
    deletingData = false;
    alert(`Could not delete local app data: ${error.message}`);
    return;
  }

  groupCrypto = null;
  meshNode = null;
  meshTopic = null;
  groupName = '';
  nickname = '';
  location.reload();
}

// ============ JOIN ============
document.querySelectorAll('#join-screen input').forEach(input => {
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      document.getElementById('join-btn')?.click();
    }
  });
});

document.getElementById('join-btn')?.addEventListener('click', async () => {
  groupName = document.getElementById('join-group')?.value.trim() || '';
  const groupKey = document.getElementById('join-key')?.value.trim() || '';
  nickname = document.getElementById('join-nick')?.value.trim() || '';

  if (!groupName || !groupKey || !nickname) {
    const error = document.getElementById('join-error');
    if (error) error.textContent = 'All fields required.';
    return;
  }

  try {
    const error = document.getElementById('join-error');
    if (error) error.textContent = 'Connecting to network...';

    groupCrypto = new CypherlinkCrypto(groupKey);
    await groupCrypto.ready;

    const result = await createNode(groupName);
    meshNode = result.node;
    meshTopic = result.topic;

    setMessageHandler(meshNode, handleIncoming);
    setPeerFoundHandler(meshNode, () => {
      updatePeerCount();
      appendMessage(null, null, false, 'A member is in the group');
    });

    // Pass the group name expected by mesh.js, not the topic string.
    await updateNickname(meshNode, groupName, nickname);

    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
    document.getElementById('group-name').textContent = `#${groupName}`;
    document.getElementById('user-name').textContent = nickname;
    if (error) error.textContent = '';

    addLeaveButton();
    updatePeerCount();
    appendMessage(null, null, false, `You joined #${groupName} as ${nickname}`);
    document.getElementById('msg-input')?.focus();
  } catch (error) {
    console.error('[Cypherlink] Join failed:', error);
    document.getElementById('join-screen').style.display = 'flex';
    const joinError = document.getElementById('join-error');
    if (joinError) joinError.textContent = error.message || 'Connection failed';
  }
});

// ============ INPUT ============
document.getElementById('send-btn')?.addEventListener('click', sendMessageHandler);
document.getElementById('msg-input')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') sendMessageHandler();
});
document.getElementById('video-btn')?.addEventListener('click', toggleVideo);

// ============ CLEANUP ============
window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  if (meshNode) {
    // Best effort only: browsers do not guarantee async cleanup on tab close.
    stopNode(meshNode);
  }
});
