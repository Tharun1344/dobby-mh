'use strict';
// General commands ported from KnightBot-Mini and adapted to Dobby-Md:
// .uptime .owner .qr .getpp .tts .translate .ssweb .take .github .viewonce
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { cmd } = require('../command');
const config = require('../config');
const gemini = require('../lib/gemini');
const { runtime } = require('../lib/functions');
let ffmpegStaticPath = null;
try { ffmpegStaticPath = require('ffmpeg-static'); } catch { /* optional */ }
const FFMPEG = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ───────────────────────── .uptime
cmd({ pattern: 'uptime', alias: ['runtime'], desc: 'Show how long the bot has been running', category: 'main' }, async (_s, _m, _msg, c) => {
  await c.reply(`╭━━『 *Bot Uptime* 』━━╮\n\n🤖 *Bot:* ${config.BOT_NAME}\n⏱️ *Uptime:* ${runtime(process.uptime()) || '0 seconds'}\n\n╰━━━━━━━━━━━━━━━╯`);
});

// ───────────────────────── .owner
cmd({ pattern: 'owner', alias: ['creator', 'dev'], desc: 'Send the bot owner contact card', category: 'main' }, async (sock, mek, _m, c) => {
  const num = String(config.BOT_OWNER || (config.OWNER_WHATSAPP.match(/wa\.me\/(\d+)/) || [])[1] || '').replace(/\D/g, '');
  if (!num) return c.reply(`👑 Owner: ${config.OWNER_NAME}`);
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${config.OWNER_NAME}\nTEL;type=CELL;waid=${num}:+${num}\nEND:VCARD`;
  await sock.sendMessage(c.from, { contacts: { displayName: config.OWNER_NAME, contacts: [{ vcard }] } }, { quoted: mek });
  await c.reply('👑 මෙන්න *Owner* ගේ contact එක.');
});

// ───────────────────────── .qr
cmd({ pattern: 'qr', alias: ['qrcode'], desc: 'Make a QR code: .qr text or link', category: 'media' }, async (sock, mek, _m, c) => {
  if (!c.q) return c.reply(`📷 භාවිතය: ${c.prefix}qr https://google.com`);
  const qrcode = require('qrcode');
  const buf = await qrcode.toBuffer(c.q.slice(0, 1000), { type: 'png', width: 500, margin: 2 });
  await sock.sendMessage(c.from, { image: buf, caption: `✅ QR code එක හැදුවා\n📝 ${c.q.slice(0, 200)}` }, { quoted: mek });
});

// ───────────────────────── .getpp
cmd({ pattern: 'getpp', alias: ['gp', 'getpic'], desc: 'Get a profile picture: reply to / mention someone (or yourself)', category: 'media' }, async (sock, mek, _m, c) => {
  const target = (c.getTargetJid && c.getTargetJid()) || c.sender;
  try {
    const url = await sock.profilePictureUrl(target, 'image');
    if (!url) throw new Error('none');
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    await sock.sendMessage(c.from, { image: Buffer.from(res.data), caption: `👤 @${String(target).split('@')[0]} ගේ profile picture එක`, mentions: [target] }, { quoted: mek });
  } catch { await c.reply('❌ Profile picture එක හොයාගන්න බැහැ (private වෙන්න පුළුවන්).'); }
});

// ───────────────────────── .tts  (Google TTS, supports Sinhala "si")
const TTS_LANGS = new Set(['si', 'en', 'ta', 'hi', 'id', 'es', 'fr', 'de', 'pt', 'ar', 'ja', 'ko']);
function detectLang(t) {
  if (/[\u0D80-\u0DFF]/.test(t)) return 'si';
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(t)) return 'ja';
  return 'en';
}
function toOpus(mp3) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(err.slice(-300) || `ffmpeg ${code}`)));
    child.stdin.on('error', () => {}); child.stdin.end(mp3);
  });
}
cmd({ pattern: 'tts', alias: ['speak', 'say'], desc: 'Text to speech: .tts [si/en/ta…] text', category: 'media' }, async (sock, mek, _m, c) => {
  let args = c.args.slice(); let lang;
  if (args.length > 1 && TTS_LANGS.has(args[0].toLowerCase())) lang = args.shift().toLowerCase();
  const text = args.join(' ').trim();
  if (!text) return c.reply(`🎙️ භාවිතය: ${c.prefix}tts ආයුබෝවන්\n${c.prefix}tts en hello how are you\nLangs: ${[...TTS_LANGS].join(', ')}`);
  lang = lang || detectLang(text);
  const res = await axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text.slice(0, 200))}`, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': UA } });
  const mp3 = Buffer.from(res.data);
  if (!mp3.length) throw new Error('Empty audio');
  try { await sock.sendMessage(c.from, { audio: await toOpus(mp3), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: mek }); }
  catch (e) { console.error('[tts opus]', e.message); await sock.sendMessage(c.from, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: mek }); }
});

// ───────────────────────── .translate  (uses your Gemini key)
cmd({ pattern: 'translate', alias: ['trans', 'tr'], desc: 'Translate: .translate si Hello  (or reply to a message: .translate en)', category: 'ai' }, async (_s, _m, m, c) => {
  const lang = c.args[0];
  const quotedText = m.quoted?.msg?.conversation || m.quoted?.msg?.text || m.quoted?.msg?.caption || (typeof m.quoted?.msg === 'string' ? m.quoted.msg : '');
  const text = c.args.slice(1).join(' ').trim() || quotedText;
  if (!lang || !text) return c.reply(`🌐 භාවිතය: ${c.prefix}translate si Hello world\nහෝ message එකකට reply කරලා ${c.prefix}translate en`);
  if (!gemini.config().key) return c.reply(gemini.explainError({ code: 'NO_KEY' }));
  try {
    const out = await gemini.generate({
      model: gemini.config().model, maxOutputTokens: 800,
      system: 'You are a translation engine. Translate the user text into the requested language. Output ONLY the translation, no quotes or notes.',
      contents: [{ role: 'user', parts: [{ text: `Target language: ${lang}\n\nText:\n${text.slice(0, 3000)}` }] }],
    });
    await c.reply(`🌐 *Translation* (${lang})\n\n${out}`);
  } catch (e) { await c.reply(gemini.explainError(e)); }
});

// ───────────────────────── .ssweb  (website screenshot via thum.io, no key)
cmd({ pattern: 'ssweb', alias: ['screenshot', 'ss'], desc: 'Screenshot a website: .ssweb https://example.com', category: 'media' }, async (sock, mek, _m, c) => {
  const url = c.q.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return c.reply(`🖥️ භාවිතය: ${c.prefix}ssweb https://github.com`);
  try {
    const res = await axios.get(`https://image.thum.io/get/width/1280/crop/800/noanimate/${url}`, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': UA } });
    const buf = Buffer.from(res.data);
    if (buf.length < 2000) throw new Error('empty screenshot');
    await sock.sendMessage(c.from, { image: buf, caption: `🖥️ ${url}` }, { quoted: mek });
  } catch (e) { console.error('[ssweb]', e.message); await c.reply('❌ Screenshot එක ගන්න බැරි වුණා. URL එක පරීක්ෂා කරලා ආයෙ try කරන්න.'); }
});

// ───────────────────────── .take  (re-pack a sticker with your own pack name)
cmd({ pattern: 'take', alias: ['steal'], desc: 'Re-pack a sticker: reply to a sticker with .take [pack name]', category: 'media' }, async (sock, mek, m, c) => {
  const src = m.quoted;
  if (!src || src.type !== 'stickerMessage') return c.reply(`🎭 Sticker එකකට reply කරලා ${c.prefix}take [pack name] යවන්න.`);
  const webp = require('node-webpmux');
  const buffer = await src.download();
  if (!buffer?.length) return c.reply('❌ Sticker එක download කරන්න බැරි වුණා.');
  const pack = c.q || c.pushname;
  const img = new webp.Image();
  await img.load(buffer);
  const json = { 'sticker-pack-id': crypto.randomBytes(16).toString('hex'), 'sticker-pack-name': pack, 'sticker-pack-publisher': config.BOT_NAME, emojis: ['🤖'] };
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([head, body]); exif.writeUIntLE(body.length, 14, 4);
  img.exif = exif;
  await sock.sendMessage(c.from, { sticker: await img.save(null) }, { quoted: mek });
});

// ───────────────────────── .github  (profile or repo info)
cmd({ pattern: 'github', alias: ['git', 'repo'], desc: 'GitHub info: .github user  or  .github user/repo', category: 'misc' }, async (_s, _m, _msg, c) => {
  const fallbackUser = (String(config.OWNER_GITHUB).match(/github\.com\/([^/\s]+)/) || [])[1] || '';
  const target = (c.q || fallbackUser).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(target)) return c.reply(`🐙 භාවිතය: ${c.prefix}github username  හෝ  ${c.prefix}github user/repo`);
  try {
    const { data } = await axios.get(`https://api.github.com/${target.includes('/') ? 'repos' : 'users'}/${target}`, { timeout: 20000, headers: { 'User-Agent': 'Dobby-Md', Accept: 'application/vnd.github+json' } });
    if (target.includes('/')) {
      return c.reply(`🐙 *${data.full_name}*\n📄 ${data.description || 'No description'}\n⭐ ${data.stargazers_count}  🍴 ${data.forks_count}  👁️ ${data.watchers_count}\n🧩 ${data.language || '-'}\n🔗 ${data.html_url}`);
    }
    return c.reply(`🐙 *${data.name || data.login}* (@${data.login})\n📝 ${data.bio || '-'}\n📦 Repos: ${data.public_repos}   👥 Followers: ${data.followers}\n🔗 ${data.html_url}`);
  } catch (e) { await c.reply(e.response?.status === 404 ? '❌ GitHub එකේ හොයාගන්න බැහැ.' : '❌ GitHub API request එක අසාර්ථකයි.'); }
});

// ───────────────────────── .viewonce  (owner only; SILENT in the chat, result goes ONLY to your own self-chat)
const viewonce = require('../lib/viewonce');
cmd({ pattern: 'viewonce', alias: ['vv', 'readvo', 'readviewonce'], desc: 'Owner: reply to a view-once photo/video/voice with .vv — saved to your own self-chat, nothing is sent in that chat', category: 'media', fromMe: true, silent: true }, async (sock, mek, m, c) => {
  const selfJid = jidNormalizedUser(sock.user?.id || '');
  const toSelf = text => sock.sendMessage(selfJid, { text }).catch(() => {});
  const q = m.quoted;
  if (!q) return toSelf('👁️ View-once message එකකට reply කරලා *.vv* යවන්න.');

  // 1) the copy fetched when the message arrived (the only thing that still works after WhatsApp expires it)
  let item = viewonce.get(q.id);
  // 2) fallback: try the quoted message itself
  if (!item) {
    const wrapper = q.viewOnceMessageV2?.message || q.viewOnceMessageV2Extension?.message || q.viewOnceMessage?.message;
    let inner = wrapper;
    if (!inner) for (const k of ['imageMessage', 'videoMessage', 'audioMessage']) if (q[k]?.viewOnce) { inner = { [k]: q[k] }; break; }
    const mtype = inner && ['imageMessage', 'videoMessage', 'audioMessage'].find(k => inner[k]);
    if (mtype) {
      try {
        const buffer = await viewonce.downloadNode(mtype, inner[mtype]);
        if (buffer.length) item = { kind: mtype.replace('Message', ''), buffer, caption: inner[mtype].caption || '', ptt: !!inner[mtype].ptt, sender: q.sender || c.from, pushName: '' };
      } catch { /* expired */ }
    }
  }
  if (!item) return toSelf('❌ View-once එක ගන්න බැරි වුණා.\nBot එක online ඉන්නකොට ආපු view-once විතරයි save වෙන්නේ (ඒවා විනාඩි 120ක් විතර මතකයේ තියෙනවා). Bot එක offline වෙලා හෝ expire වෙලා වෙන්න පුළුවන්.');

  const from = String(item.sender || '').split('@')[0];
  const caption = `👁️ View-once saved\n👤 From: ${item.pushName ? `${item.pushName} ` : ''}(${from})${item.caption ? `\n💬 ${item.caption}` : ''}`;
  if (item.kind === 'image') await sock.sendMessage(selfJid, { image: item.buffer, caption });
  else if (item.kind === 'video') await sock.sendMessage(selfJid, { video: item.buffer, caption, mimetype: 'video/mp4' });
  else { await sock.sendMessage(selfJid, { audio: item.buffer, mimetype: item.mimetype || 'audio/ogg; codecs=opus', ptt: item.ptt }); await toSelf(caption); }
});
