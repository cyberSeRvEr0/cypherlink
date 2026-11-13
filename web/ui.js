/**
 * Cypherlink — Main UI: matrix rain, chat rendering, input handling.
 */
import { CypherlinkCrypto } from './crypto.js';
import { createMeshNode, joinGroup, sendToGroup } from './mesh.js';

// --- Matrix Rain ---
const canvas = document.getElementById('matrix');
const ctx = canvas.getContext('2d');
let columns, drops;

function initMatrix() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  columns = Math.floor(canvas.width / 14);
  drops = Array(columns).fill(1);
}
initMatrix();
window.addEventListener('resize', initMatrix);

function drawMatrix() {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f0';
  ctx.font = '14px monospace';
  for (let i = 0; i < drops.length; i++) {
    const char = Math.random() > 0.97 ? String.fromCharCode(0x30 + Math.random()*10) : String.fromCharCode(0x41 + Math.random()*26);
    ctx.fillText(char, i * 14, drops[i] * 14);
    if (drops[i] * 14 > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
  requestAnimationFrame(drawMatrix);
}
drawMatrix();

// --- State ---
let crypto, meshNode, topic, nickname, groupName;
const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('msg-input');
const seenMessages = new Set(); // For ephemeral ACK tracking

// --- Join ---
document.querySelectorAll('#join-screen input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('join-btn').click();
  });
});   
document.getElementById('join-btn').addEventListener('click', async () => {
  groupName = document.getElementById('join-group').value.trim();
  const inviteKey = document.getElementById('join-key').value.trim();
  nickname = document.getElementById('join-nick').value.trim();

  if (!groupName || !inviteKey || !nickname) {
    document.getElementById('join-error').textContent = 'All fields required.';
    return;
  }

  try {
    crypto = new CypherlinkCrypto(inviteKey);
    meshNode = await createMeshNode();
    topic = await joinGroup(meshNode, groupName, handleIncoming);

    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('group-name').textContent = `#${groupName}`;
    document.getElementById('user-name').textContent = nickname;
    inputEl.focus();
  } catch (e) {
    document.getElementById('join-error').textContent = e.message;
  }
});

// --- Send ---
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';

  // Show locally FIRST
  appendMessage(nickname, text, true);

  // Then try to send to network
  try {
    const { iv, ciphertext } = await crypto.encrypt(text);
    await sendToGroup(meshNode, topic, {
      type: 'message',
      sender: nickname,
      iv,
      ciphertext,
      ts: Date.now(),
    });
  } catch (e) {
    console.error('[Cypherlink] Send failed:', e);
  }
}   

document.getElementById('send-btn').addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

// --- Receive ---
async function handleIncoming(data) {
  if (data.type !== 'message') return;
  if (seenMessages.has(data.sender + data.ts)) return;
  seenMessages.add(data.sender + data.ts);

  const text = await crypto.decrypt(data.iv, data.ciphertext);
  appendMessage(data.sender, text, false);

  // Send ephemeral ACK (in production: track and purge)
  // await sendToGroup(meshNode, topic, { type: 'ack', sender: nickname, ref: data.ts });
}

// --- Render ---
let lastNick = null, lastTs = 0;

function appendMessage(nick, text, isSelf) {
  const now = Date.now();
  const time = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Separator if >30s gap
  if (now - lastTs > 30000) {
    const sep = document.createElement('div');
    sep.className = 'separator';
    chatEl.appendChild(sep);
  }

  const div = document.createElement('div');
  div.className = `msg${isSelf ? ' self' : ''}`;

  // Group consecutive messages from same user within 5s
  if (nick === lastNick && now - lastTs < 5000) {
    div.innerHTML = `<span class="time">${time}</span> ${escapeHtml(text)}`;
  } else {
    div.innerHTML = `<span class="time">${time}</span> <span class="nick">&lt;${escapeHtml(nick)}&gt;</span> ${escapeHtml(text)}`;
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  lastNick = nick;
  lastTs = now;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}   