'use strict';
const { cmd } = require('../command');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
let ffmpegStaticPath = null;
try { ffmpegStaticPath = require('ffmpeg-static'); } catch { ffmpegStaticPath = null; }
const MAX_BYTES = Math.max(10 * 1024 * 1024, Math.min(Number(process.env.MAX_DOWNLOAD_BYTES || 1900000000), 1900000000));
const URL_RE = /^https?:\/\//i;
const FFMPEG = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';
// Videos are sent as real video messages up to this size (default = the 1.9 GB download limit); only anything bigger is shrunk.
const WA_VIDEO_LIMIT = Number(process.env.WA_VIDEO_LIMIT_BYTES || MAX_BYTES);
const FFMPEG_TIMEOUT = Number(process.env.FFMPEG_TIMEOUT_MS || 1800000);
const QUALITIES = new Set([144, 240, 360, 480, 720]);
const LIMIT_LABEL = `${(MAX_BYTES / (1024 ** 3)).toFixed(2)} GiB`;
// Extensions yt-dlp can produce with no video track at all. If a non-audio
// command ends up with one of these, the source only offered audio (or the
// video+audio merge silently failed) — report it instead of sending an
// audio file labeled as a video.
const AUDIO_ONLY_EXT = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'wma', 'weba']);
// Recent YouTube needs a JavaScript runtime for yt-dlp (node is in the Docker image). Old yt-dlp builds don't know
// the flag, so retry once without it instead of failing.
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME === undefined ? 'node' : process.env.YTDLP_JS_RUNTIME;
// YouTube often blocks cloud/datacenter IPs ("Sign in to confirm you're not a bot"). Two mitigations:
//  1) optional cookies: set YTDLP_COOKIES_B64 (base64 of a Netscape cookies.txt) on Railway
//  2) on a block/format error, retry with other YouTube player clients (override with YTDLP_CLIENTS=a,b,c)
function cookieArgs() {
  const raw = process.env.YTDLP_COOKIES_B64 ? Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8') : (process.env.YTDLP_COOKIES || '');
  if (!raw.trim()) return [];
  const file = path.join(os.tmpdir(), 'ytdlp-cookies.txt');
  try { if (!fs.existsSync(file)) fs.writeFileSync(file, raw.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n'), { mode: 0o600 }); } catch (e) { console.error('[cookies]', e.message); return []; }
  return ['--cookies', file];
}
console.log(`[ytdlp] cookies: ${cookieArgs().length ? 'LOADED' : 'not set'} | proxy: ${process.env.YTDLP_PROXY ? 'set' : 'not set'}`);
const BLOCKED_RE = /Sign in to confirm|not a bot|Requested format is not available|HTTP Error 403|Precondition check failed|nsig|n challenge/i;
const FALLBACK_CLIENTS = (process.env.YTDLP_CLIENTS || 'android_vr,tv,web_safari').split(',').map(x => x.trim()).filter(Boolean);
async function runYtDlp(args, timeoutMs = 240000) {
  const proxy = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];
  const withCookies = [...proxy, ...cookieArgs(), ...args];
  try { return await runYtDlpJs(withCookies, timeoutMs); }
  catch (first) {
    if (!BLOCKED_RE.test(first.message) || !args.some(a => /youtu|ytsearch/i.test(String(a)))) throw first;
    for (const client of FALLBACK_CLIENTS) {
      try { return await runYtDlpJs(['--extractor-args', `youtube:player_client=${client}`, ...withCookies], timeoutMs); }
      catch (err) { console.error(`[yt-dlp client ${client}]`, String(err.message).split('\n').pop().slice(0, 200)); if (!BLOCKED_RE.test(err.message)) throw err; }
    }
    throw first;   // the first error is the most informative one
  }
}
async function runYtDlpJs(args, timeoutMs = 240000) {
  if (!JS_RUNTIME) return runYtDlpRaw(args, timeoutMs);
  try { return await runYtDlpRaw(['--js-runtimes', JS_RUNTIME, ...args], timeoutMs); }
  catch (e) {
    if (/js-runtimes|no such option|unrecognized arguments/i.test(e.message)) return runYtDlpRaw(args, timeoutMs);
    throw e;
  }
}
function runYtDlpRaw(args, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YTDLP_BIN || 'yt-dlp', args, { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false;
    const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    child.stdout.on('data', x => { stdout += x.toString(); if (stdout.length > 300000) stdout = stdout.slice(-300000); });
    child.stderr.on('data', x => { stderr += x.toString(); if (stderr.length > 300000) stderr = stderr.slice(-300000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('Download timed out')); }, timeoutMs);
    child.on('error', err => done(new Error(`Could not start yt-dlp: ${err.message}`)));
    child.on('close', code => code === 0 ? done(null, { stdout, stderr }) : done(new Error(stderr.slice(-1800) || `yt-dlp exited ${code}`)));
  });
}
function runFfmpeg(args, timeoutMs = FFMPEG_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', settled = false;
    const done = (err, v) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(v); };
    child.stderr.on('data', x => { stderr += x.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('ffmpeg timed out')); }, timeoutMs);
    child.on('error', err => done(new Error(`Could not start ffmpeg: ${err.message}`)));
    child.on('close', code => code === 0 ? done(null, stderr) : done(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`)));
  });
}
// `ffmpeg -i file` always "fails" (no output file) but prints the stream codecs on stderr.
async function probeCodecs(file) {
  const info = await new Promise(resolve => {
    const child = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', x => { err += x.toString(); });
    child.on('error', () => resolve('')); child.on('close', () => resolve(err));
  });
  return { video: (info.match(/Video: ([a-z0-9_]+)/i) || [])[1] || '', audio: (info.match(/Audio: ([a-z0-9_]+)/i) || [])[1] || '' };
}
// WhatsApp only plays H.264 + AAC in an MP4 container (with the index at the front). yt-dlp can hand back
// VP9/AV1 + Opus (webm/mkv) which WhatsApp shows as a file that will not play, so make sure it is the right thing.
async function makePlayableMp4(src, dir, codecs) {
  const out = path.join(dir, 'playable.mp4');
  const isMp4 = path.extname(src).toLowerCase() === '.mp4';
  if (isMp4 && codecs.video === 'h264' && (!codecs.audio || codecs.audio === 'aac')) {
    await runFfmpeg(['-i', src, '-c', 'copy', '-movflags', '+faststart', out]);   // fast: no re-encode
  } else {
    const big = fs.statSync(src).size > 150 * 1024 * 1024;   // long video: favour speed over file size
    await runFfmpeg(['-i', src, '-c:v', 'libx264', '-preset', big ? 'ultrafast' : 'veryfast', '-crf', big ? '28' : '26', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
  }
  return out;
}
async function shrinkToFit(src, dir) {
  const out = path.join(dir, 'small.mp4');
  await runFfmpeg(['-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-vf', "scale=-2:'min(360,ih)'", '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  return out;
}
async function makeThumb(src, dir) {
  try {
    const out = path.join(dir, 'thumb.jpg');
    await runFfmpeg(['-ss', '1', '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', out], 30000)
      .catch(() => runFfmpeg(['-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', out], 30000));
    return fs.readFileSync(out);
  } catch { return undefined; }
}
function safeName(name, fallback) { return String(name || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160) || fallback; }
function inputTarget(q, searchPrefix = 'ytsearch1:') {
  const raw = String(q || '').trim();
  if (!raw) throw new Error('Give a video/song name or URL.');
  if (URL_RE.test(raw)) {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are allowed.');
    return u.toString();
  }
  return searchPrefix + raw;
}
async function sendAsDocument(sock, c, file, title, ext, mime, note = '') {
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) throw new Error(`File is larger than configured limit ${LIMIT_LABEL}`);
  // Baileys accepts a file path as media URL; avoid loading multi-GB files into RAM.
  await sock.sendMessage(c.from, {
    document: { url: file }, mimetype: mime, fileName: safeName(`${title}.${ext}`, `download.${ext}`),
    caption: `✅ *Download complete*\n📏 ${(stat.size / (1024 * 1024)).toFixed(1)} MB${note ? `\n${note}` : ''}`
  }, { quoted: c.quoted });
}
// Send as a normal, playable WhatsApp video (not a document). Tries file URL, then stream, then buffer.
async function sendAsVideo(sock, c, file, title, thumb, qualityLabel) {
  const size = fs.statSync(file).size;
  const caption = `🎬 *${title}*\n📏 ${(size / (1024 * 1024)).toFixed(1)} MB${qualityLabel ? ` • ${qualityLabel}` : ''}`;
  const base = { mimetype: 'video/mp4', fileName: safeName(`${title}.mp4`, 'video.mp4'), caption, gifPlayback: false, ...(thumb ? { jpegThumbnail: thumb } : {}) };
  const attempts = [() => ({ video: { url: file } }), () => ({ video: { stream: fs.createReadStream(file) } }), () => ({ video: fs.readFileSync(file) })];
  let lastErr;
  for (const make of attempts) {
    try { return await sock.sendMessage(c.from, { ...make(), ...base }, { quoted: c.quoted }); }
    catch (e) { lastErr = e; console.error('[video send attempt failed]', e.message); }
  }
  throw lastErr || new Error('Could not send video');
}
async function sendAsAudio(sock, c, file, title) {
  const size = fs.statSync(file).size;
  await sock.sendMessage(c.from, { audio: { url: file }, mimetype: 'audio/mpeg', fileName: safeName(`${title}.mp3`, 'song.mp3') }, { quoted: c.quoted });
  await sock.sendMessage(c.from, { text: `🎵 *${title}*\n📏 ${(size / (1024 * 1024)).toFixed(1)} MB` }, { quoted: c.quoted }).catch(() => {});
}
async function downloadCommand(sock, mek, _msg, c, mode) {
  let target;
  // Optional quality: ".ytvideo 360 song name" (144/240/360/480/720). Default per command.
  let height = mode.height;
  const qMatch = String(c.q || '').trim().match(/^(\d{3})p?\s+(.+)$/s);
  if (!mode.audio && qMatch && QUALITIES.has(Number(qMatch[1]))) { height = Number(qMatch[1]); c = { ...c, q: qMatch[2] }; }
  try {
    if (mode.urlOnly && !URL_RE.test(String(c.q || '').trim())) throw new Error('This platform command requires a direct video URL.');
    target = inputTarget(c.q, 'ytsearch1:');
  }
  catch (e) { return c.reply(`📥 *භාවිතය*\n${c.prefix}${mode.command} video/song name OR URL\n\nඋදා: ${c.prefix}${mode.command} Shape of You\nඋදා: ${c.prefix}${mode.command} https://...`); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'danuwa-dl-'));
  try {
    await c.reply(`⏳ *${mode.label}* සූදානම් කරනවා…\n🔎 Name එකක් හෝ URL එකක් දෙන්න පුළුවන්.\n🎬 ${mode.audio ? 'Audio' : 'Video (play කරන්න පුළුවන් mp4)'} එකක් විදිහට යවනවා.`);
    const out = path.join(dir, '%(title).150B.%(ext)s');
    const common = ['--no-playlist','--no-warnings','--newline','--socket-timeout','30','--retries','3','--fragment-retries','3','--no-part','--max-filesize',String(MAX_BYTES),'-o',out,'--print','after_move:filepath'];
    // Without a working ffmpeg, yt-dlp can't merge a separate video+audio
    // pair and silently drops to whatever single-file format is available —
    // which for some sources (e.g. Facebook) can end up audio-only. Pointing
    // explicitly at ffmpeg-static makes the merge reliable regardless of
    // what's on PATH.
    if (ffmpegStaticPath) common.push('--ffmpeg-location', ffmpegStaticPath);
    let args;
    if (mode.audio) {
      args = [...common, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', target];
    } else {
      // 480p YouTube; 720p for other supported services. bv*/ba (rather than
      // the bestvideo/bestaudio aliases) are the more reliable yt-dlp
      // selectors across sources that don't tag every format with a height.
      // Prefer H.264 + AAC (plays in WhatsApp as-is); anything else is converted below.
      const format = `bv*[vcodec^=avc1][height<=${height}]+ba[ext=m4a]/b[ext=mp4][height<=${height}]/bv*[height<=${height}]+ba/b[height<=${height}]/b`;
      args = [...common, '-f', format, '--merge-output-format', 'mp4', target];
    }
    const { stdout, stderr } = await runYtDlp(args, Number(process.env.DOWNLOAD_TIMEOUT_MS || 1800000));
    const printed = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    let file = printed && fs.existsSync(printed) ? printed : null;
    if (!file) {
      const candidates = fs.readdirSync(dir).map(n => path.join(dir,n)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
      file = candidates.sort((a,b) => fs.statSync(b).size - fs.statSync(a).size)[0] || null;
    }
    if (!file) throw new Error(`No file created. ${stderr.slice(-500)}`);
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) throw new Error(`File too large: ${(stat.size / (1024 ** 3)).toFixed(2)} GiB; limit ${LIMIT_LABEL}`);
    const ext = path.extname(file).slice(1).toLowerCase() || (mode.audio ? 'mp3' : 'mp4');
    if (!mode.audio && AUDIO_ONLY_EXT.has(ext)) {
      throw new Error(`AUDIO_ONLY_RESULT: this link only yielded an audio track (ext=${ext}), no video.`);
    }
    const title = path.basename(file, path.extname(file));
    if (mode.audio) {
      if (stat.size > 100 * 1024 * 1024) await sendAsDocument(sock, c, file, title, ext, 'audio/mpeg', '📦 Too large for an audio message, sent as file');
      else await sendAsAudio(sock, c, file, title);
      return;
    }
    const codecs = await probeCodecs(file);
    if (!codecs.video) throw new Error(`AUDIO_ONLY_RESULT: no video stream found (audio=${codecs.audio || 'none'}).`);
    let playable = await makePlayableMp4(file, dir, codecs);
    let note = '';
    if (fs.statSync(playable).size > WA_VIDEO_LIMIT) {
      await c.reply('🗜️ Video එක ලොකුයි — WhatsApp video එකක් විදිහට යවන්න පුංචි කරනවා (360p)…').catch(() => {});
      playable = await shrinkToFit(playable, dir);
      note = '360p';
    }
    const finalSize = fs.statSync(playable).size;
    if (finalSize <= WA_VIDEO_LIMIT) {
      const thumb = await makeThumb(playable, dir);
      await sendAsVideo(sock, c, playable, title, thumb, note || (height ? `${height}p` : ''));
    } else {
      await sendAsDocument(sock, c, playable, title, 'mp4', 'video/mp4', '📦 මේක ඉතා දිගයි — WhatsApp video limit ඉක්මවූ නිසා file එකක් විදිහට යැව්වා.');
    }
  } catch (e) {
    console.error(`[${mode.command}]`, e.message);
    let message = '❌ Download එක අසාර්ථකයි.';
    if (/AUDIO_ONLY_RESULT/i.test(e.message)) message = '⚠️ මේ link එකට *video stream එකක් නැහැ* — audio track එකක් විතරයි හම්බුණේ, ඒ නිසා video file එක යැව්වේ නැහැ.\n🔁 වෙනත් post/link එකක් try කරන්න, හෝ video එක login/age/geo restricted වෙලා තියෙනවද බලන්න.';
    else if (/max-filesize|file is larger|too large/i.test(e.message)) message += `\n📏 File size limit: ${LIMIT_LABEL}. Railway memory/storage limits නිසා ඉතා විශාල files fail වෙන්න පුළුවන්.`;
    else if (/Could not start yt-dlp|ENOENT/i.test(e.message)) message += '\n🧰 yt-dlp install වෙලා නැහැ (Railway: Dockerfile එකෙන් rebuild කරන්න).';
    else if (/Sign in to confirm|not a bot/i.test(e.message)) message += cookieArgs().length
      ? '\n🍪 Cookies දාලා තියෙනවා, ඒත් YouTube තාම block කරනවා — cookies expire වෙලා හෝ වැරදියි. Incognito window එකකින් අලුතින් export කරලා *YTDLP_COOKIES_B64* update කරන්න.'
      : '\n🤖 YouTube මේ server එකේ IP එක block කරලා ("not a bot" check). Fix: Railway Variables වල *YTDLP_COOKIES_B64* දාන්න.';
    else if (/Requested format is not available|nsig|n challenge/i.test(e.message)) message += '\n🧩 YouTube format/challenge error එකක් — yt-dlp update කරන්න (Railway redeploy), නැත්නම් cookies දාන්න.';
    else if (/Video unavailable|Private video|members-only|has been removed|age/i.test(e.message)) message += '\n🚫 Video එක unavailable / private / age-restricted වෙන්න පුළුවන්.';
    else if (/timed out/i.test(e.message)) message += '\n⏱️ Download timeout වුණා; පොඩි video එකක් හෝ පසුව නැවත try කරන්න.';
    else message += '\n🌐 Link availability, login/age/geo restrictions සහ source platform changes පරීක්ෂා කරන්න.';
    message += '\n⚠️ ඔබට download කිරීමට අයිතිය ඇති content පමණක් භාවිත කරන්න.';
    await c.reply(message);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
cmd({ pattern: 'ytsearch', alias: ['musicsearch','videosearch'], desc: 'Search YouTube results (metadata only)', category: 'download' }, async (_s,_m,_msg,c) => {
  if (!c.q) return c.reply(`🔎 භාවිතය: ${c.prefix}ytsearch song/video name`);
  try {
    const { stdout } = await runYtDlp(['--dump-single-json','--flat-playlist','--no-warnings',`ytsearch5:${c.q}`], 60000);
    const data = JSON.parse(stdout);
    const entries = (data.entries || []).slice(0,5);
    if (!entries.length) return c.reply('😕 ප්‍රතිඵල හමු වුණේ නැහැ.');
    return c.reply('╭─〔 🔎 *YOUTUBE SEARCH* 〕\n' + entries.map((v,i)=>`│ ${i+1}. *${v.title || 'Untitled'}*\n│ 🔗 https://www.youtube.com/watch?v=${v.id}`).join('\n│\n') + '\n╰────────────────\n\n⬇️ Video: .ytvideo song name\n🎵 MP3: .song song name');
  } catch (e) { console.error('[ytsearch]',e.message); return c.reply('❌ Search අසාර්ථකයි. yt-dlp update/network එක පරීක්ෂා කරන්න.'); }
});
cmd({ pattern: 'ytvideo', alias: ['ytmp4'], desc: 'Download YouTube video up to 480p by name or URL', category: 'download' }, async (s,m,msg,c) => downloadCommand(s,m,msg,c,{command:'ytvideo',label:'YouTube video (480p)',height:480}));
cmd({ pattern: 'song', alias: ['ytmp3','mp3'], desc: 'Download permitted audio as MP3 by name or URL', category: 'download' }, async (s,m,msg,c) => downloadCommand(s,m,msg,c,{command:'song',label:'Song MP3',audio:true}));
cmd({ pattern: 'fbvideo', alias: ['facebook'], desc: 'Download supported Facebook video up to 720p', category: 'download' }, async (s,m,msg,c) => downloadCommand(s,m,msg,c,{command:'fbvideo',label:'Facebook video (up to 720p)',height:720,urlOnly:true}));
cmd({ pattern: 'ttvideo', alias: ['tiktok'], desc: 'Download supported TikTok video up to 720p', category: 'download' }, async (s,m,msg,c) => downloadCommand(s,m,msg,c,{command:'ttvideo',label:'TikTok video (up to 720p)',height:720,urlOnly:true}));
cmd({ pattern: 'download', alias: ['media'], desc: 'Download supported public video by name or URL (up to 720p)', category: 'download' }, async (s,m,msg,c) => downloadCommand(s,m,msg,c,{command:'download',label:'Video download (up to 720p)',height:720}));
