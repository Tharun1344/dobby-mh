'use strict';
// View-once helper.
// WhatsApp deletes a view-once file from its servers once it has been opened, and a reply (quote) to it does not
// carry the media any more, so ".viewonce" can only work if the file was fetched when the message ARRIVED.
// This keeps those files in MEMORY ONLY (never on disk), for a limited time, capped in size, and the only way
// to get one back out is the owner-only ".viewonce" command, which sends it to the owner's own self-chat.
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const TTL_MS = Number(process.env.VIEWONCE_CACHE_MIN || 120) * 60000;
const MAX_TOTAL = Number(process.env.VIEWONCE_CACHE_MB || 40) * 1024 * 1024;
const LIMITS = { imageMessage: 15 * 1024 * 1024, videoMessage: 40 * 1024 * 1024, audioMessage: 10 * 1024 * 1024 };
const cache = new Map();   // message id -> entry
let total = 0;

function findViewOnce(message) {
  const m = message?.message; if (!m) return null;
  const wrapped = m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.viewOnceMessage?.message;
  const inner = wrapped || m;
  for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
    if (inner[type] && (wrapped || inner[type].viewOnce)) return { type, node: inner[type] };
  }
  return null;
}

async function downloadNode(type, node) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of await downloadContentFromMessage(node, type.replace('Message', ''))) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

function evict() {
  const now = Date.now();
  for (const [id, e] of cache) if (now - e.at > TTL_MS) { total -= e.buffer.length; cache.delete(id); }
  while (total > MAX_TOTAL && cache.size) { const [id, e] = cache.entries().next().value; total -= e.buffer.length; cache.delete(id); }
}
setInterval(evict, 10 * 60000).unref?.();

// Called for every incoming message; does nothing unless it is a (not own) view-once photo/video/voice note.
async function capture(message) {
  try {
    if (!message?.key?.id || message.key.fromMe) return;
    const found = findViewOnce(message);
    if (!found) return;
    const size = Number(found.node.fileLength) || 0;
    if (size > LIMITS[found.type]) return;
    const buffer = await downloadNode(found.type, found.node);
    if (!buffer.length || buffer.length > LIMITS[found.type]) return;
    cache.set(message.key.id, {
      kind: found.type.replace('Message', ''), buffer, caption: found.node.caption || '', mimetype: found.node.mimetype || '',
      ptt: !!found.node.ptt, sender: message.key.participant || message.key.remoteJid, chat: message.key.remoteJid,
      pushName: message.pushName || '', at: Date.now(),
    });
    total += buffer.length; evict();
  } catch (e) { /* media may already be gone; nothing to do */ }
}
function get(id) { evict(); return id ? cache.get(id) || null : null; }

module.exports = { capture, get, findViewOnce, downloadNode };
