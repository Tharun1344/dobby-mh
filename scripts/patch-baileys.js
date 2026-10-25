'use strict';
// Baileys 6.7.x + WhatsApp "@lid" accounts: when a message is fanned out to every device of the account, one device
// (the bot's own device, or a ghost device left behind by an old deploy) has no Signal session, and the whole send
// fails with "SessionError: No sessions". This makes Baileys SKIP such a device instead of failing the send.
// Idempotent, runs at startup before Baileys is loaded, and never throws.
const fs = require('fs');
const path = require('path');

function patch() {
  let file;
  try { file = path.join(path.dirname(require.resolve('@whiskeysockets/baileys/package.json')), 'lib', 'Socket', 'messages-send.js'); }
  catch { return 'baileys not found'; }
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return `cannot read: ${e.message}`; }
  if (src.includes('dobby-patch-v2')) return 'already patched';

  const oldEncrypt = "            const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });\n";
  const newEncrypt =
`            let encrypted; /* dobby-patch-v2 */
            try { encrypted = await signalRepository.encryptMessage({ jid, data: bytes }); }
            catch (err) {
                // Never silently skip the main phone (device 0): that would make the message "wait" forever. Only extra/ghost devices.
                const dev = (String(jid).match(/:(\\d+)@/) || [])[1];
                if (dev && Number(dev) !== 0 && /No sessions/i.test((err && err.message) || '')) { console.error('[patch] skipping device without a session:', jid); return null; }
                throw err;
            }
            const { type, ciphertext } = encrypted;
`;
  const v1Block =
`            let encrypted; /* dobby-patch */
            try { encrypted = await signalRepository.encryptMessage({ jid, data: bytes }); }
            catch (err) { if (/No sessions/i.test((err && err.message) || '')) { console.error('[patch] skipping device without a session:', jid); return null; } throw err; }
            const { type, ciphertext } = encrypted;
`;
  const oldReturn = "        }));\n        return { nodes, shouldIncludeDeviceIdentity };\n    };\n    const relayMessage";
  const newReturn = "        }));\n        return { nodes: nodes.filter(n => n && n.tag), shouldIncludeDeviceIdentity };\n    };\n    const relayMessage";
  if (src.includes('dobby-patch') && src.split(v1Block).length === 2) {          // upgrade the first version of this patch
    try { fs.writeFileSync(file, src.replace(v1Block, newEncrypt)); } catch (e) { return `cannot write: ${e.message}`; }
    return 'patch upgraded';
  }
  if (src.split(oldEncrypt).length !== 2 || src.split(oldReturn).length !== 2) return 'unexpected Baileys version, patch skipped';
  try { fs.writeFileSync(file, src.replace(oldEncrypt, newEncrypt).replace(oldReturn, newReturn)); }
  catch (e) { return `cannot write: ${e.message}`; }
  return 'patched';
}

let result = 'skipped';
try { result = patch(); } catch (e) { result = `error: ${e.message}`; }
if (result !== 'already patched') console.log(`[patch-baileys] ${result}`);
module.exports = result;
