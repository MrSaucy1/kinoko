// Time-based one-time passwords (RFC 6238, the kind every authenticator app
// speaks): HMAC-SHA1, 6 digits, 30-second steps. Small enough to own.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const stepOf = (ms = Date.now()) => Math.floor(ms / 30000);

export function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}

/**
 * Returns the time step the code belongs to, or null. One step of clock drift
 * either way is accepted; a step at or before `after` is refused so a code
 * cannot be used twice.
 */
export function verifyCode(secret, code, { after = 0, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const cur = stepOf(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step <= after) continue;
    const want = Buffer.from(codeAt(secret, step));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) return step;
  }
  return null;
}

export const otpauthUrl = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Ten one-time recovery codes, shown once; only their hashes are kept. */
export function newRecoveryCodes(n = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const one = () => Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join('').replace(/^(.{4})/, '$1-');
  return Array.from({ length: n }, one);
}
export const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
