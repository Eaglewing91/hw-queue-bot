// Encrypted storage for tranche API keys.
//
// Keys are encrypted with AES-256-GCM before they're saved. The secret comes from
// KEY_SECRET (a Railway variable), so the saved file alone is just scrambled text.
// Nothing here ever logs, displays or returns a key to Discord.
const crypto = require('crypto');

const SECRET = (process.env.KEY_SECRET || '').trim();
const ready = () => SECRET.length >= 16;
const derived = () => crypto.scryptSync(SECRET, 'necromancer-tranche-keys', 32);

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derived(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((x) => x.toString('base64')).join('.');
}

function decrypt(blob) {
  try {
    const [iv, tag, data] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', derived(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch { return null; } // wrong/changed KEY_SECRET or damaged data
}

module.exports = { ready, encrypt, decrypt };
