// Torn API helper for the HW queue bot.
//
// Only ever calls api.torn.com (the official API). Never touches torn.com pages.
// Used for two read-only things:
//   1. Faction armoury news: to confirm a member really loaned their weapon,
//      and to notice when it's been returned.
//   2. User basic info by Discord ID: to link a Discord member to their Torn
//      name automatically (works for members who linked Discord in Torn).
//
// The key comes from TORN_API_KEY in .env and is never shown in Discord or logs.

const API = 'https://api.torn.com/v2';
const KEY = (process.env.TORN_API_KEY || '').trim();
const NEWS_CATEGORY = (process.env.TORN_NEWS_CATEGORY || 'armoryAction').trim();

const enabled = () => KEY.length > 0;

class TornError extends Error {
  constructor(code, message) {
    super(`Torn API error ${code}: ${message}`);
    this.code = code;
  }
}

// One GET request to the Torn API. Times out after 10 s.
async function call(path, params = {}, key = KEY) {
  if (!key) throw new TornError(0, 'No TORN_API_KEY set');
  const url = new URL((path.startsWith('http') ? '' : API) + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('comment', 'HWQueueBot');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `ApiKey ${key}`, 'User-Agent': 'HWQueueBot/1.0' },
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json?.error) throw new TornError(json.error.code, json.error.error);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Latest armoury news, oldest first: [{ id, text, timestamp }]
async function armouryNews(fromUnix) {
  const json = await call('/faction/news', {
    cat: NEWS_CATEGORY,
    striptags: 'true',
    limit: 100,
    sort: 'desc',
    from: fromUnix ? Math.floor(fromUnix) : undefined,
  });
  const raw = Array.isArray(json.news) ? json.news : Object.values(json.news || {});
  return raw
    .map((n) => ({ id: String(n.id ?? `${n.timestamp}:${n.text}`), text: String(n.text ?? n.news ?? ''), timestamp: Number(n.timestamp) }))
    .filter((n) => n.text && n.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- tranche keys (one faction key per tranche, armoury-only) ----------
const V1 = 'https://api.torn.com';

// Armoury log for a tranche key, oldest first: [{ id, text, timestamp }].
// Prefers the armoury-only selection (faction > armorynews); falls back to
// faction > news (armoury category) if the key was made with that instead.
async function armouryNewsFor(key, fromUnix) {
  try {
    const json = await call(`${V1}/faction/`, { selections: 'armorynews', from: fromUnix ? Math.floor(fromUnix) : undefined, key }, key);
    const raw = json.armorynews || {};
    return Object.entries(raw)
      .map(([id, n]) => ({ id: String(id), text: String(n?.news ?? n?.text ?? ''), timestamp: Number(n?.timestamp) }))
      .filter((n) => n.text && n.timestamp)
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    if (err.code !== 16) throw err; // 16 = this key doesn't have armorynews: try the news selection
    const json = await call('/faction/news', { cat: NEWS_CATEGORY, striptags: 'true', limit: 100, sort: 'desc',
      from: fromUnix ? Math.floor(fromUnix) : undefined }, key);
    const raw = Array.isArray(json.news) ? json.news : Object.values(json.news || {});
    return raw.map((n) => ({ id: String(n.id ?? `${n.timestamp}:${n.text}`), text: String(n.text ?? n.news ?? ''), timestamp: Number(n.timestamp) }))
      .filter((n) => n.text && n.timestamp).sort((a, b) => a.timestamp - b.timestamp);
  }
}

// Which faction a key belongs to (from the key's own info, which every key can read). Null if unknown.
async function keyFaction(key) {
  for (const [path, params] of [['/key/info', {}], [`${V1}/key/`, { selections: 'info', key }]]) {
    try {
      const id = findField(await call(path, params, key), ['faction_id', 'factionId', 'factionID']);
      if (id) return Number(id);
    } catch { /* try the next form */ }
  }
  return null;
}

// A faction's public name, using the owner's key. Null if unknown.
async function factionName(id) {
  if (!enabled()) return null;
  try {
    const json = await call(`/faction/${encodeURIComponent(id)}/basic`);
    return (json?.basic?.name || findIdName(json)?.name || null);
  } catch { return null; }
}

// A player's faction ID (0 = not in a faction), by Torn ID or Discord ID, using the owner's key.
// Null if it couldn't be found out.
async function userFaction(id) {
  if (!enabled()) return null;
  try {
    const json = await call(`/user/${encodeURIComponent(id)}/faction`);
    if (json && 'faction' in json) return Number(json.faction?.id ?? json.faction?.faction_id ?? 0);
  } catch { /* fall through */ }
  try {
    const json = await call(`/user/${encodeURIComponent(id)}/profile`);
    const p = json?.profile || json;
    const f = p?.faction_id ?? p?.faction?.id ?? p?.faction?.faction_id;
    if (f !== undefined) return Number(f || 0);
  } catch { /* unknown */ }
  return null;
}

function findField(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null && obj[n] !== 0) return obj[n];
  for (const v of Object.values(obj)) { const r = findField(v, names, depth + 1); if (r) return r; }
  return null;
}

// Look up a Torn user by Discord ID (or Torn ID). Returns { id, name } or null.
async function lookupUser(discordOrTornId) {
  const json = await call(`/user/${encodeURIComponent(discordOrTornId)}/basic`, { striptags: 'true' });
  const found = findIdName(json);
  return found ? { id: Number(found.id), name: String(found.name) } : null;
}

// The response shape can nest the profile, so search for the first {id, name} object.
function findIdName(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  if (obj.id !== undefined && typeof obj.name === 'string') return obj;
  for (const v of Object.values(obj)) {
    const r = findIdName(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// Look up one specific item by its unique ID (UID). Returns
// { uid, name, bonus, percent, rarity } or null. Tries the v2 path forms in turn,
// since the exact one couldn't be confirmed offline.
async function itemByUid(uid) {
  const attempts = [[`/torn/${encodeURIComponent(uid)}/itemdetails`, {}], ['/torn/itemdetails', { id: uid }]];
  let lastErr = null;
  for (const [path, params] of attempts) {
    try {
      const json = await call(path, params);
      const d = parseItemDetails(json, uid);
      if (d) return d;
    } catch (err) {
      lastErr = err;
      if ([0, 2, 5, 8, 10, 13, 18].includes(err.code)) throw err; // key problems: no point trying the other form
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function parseItemDetails(json, uid) {
  const obj = json?.itemdetails || json?.item_details || json?.item || json;
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.name || obj.item_name || obj.base?.name || obj.item?.name;
  if (!name) return null;
  let list = obj.bonuses ?? obj.bonus ?? [];
  if (!Array.isArray(list)) list = Object.values(list);
  const first = list.find((b) => b && typeof b === 'object') || null;
  const bonus = first ? String(first.title ?? first.name ?? first.bonus ?? '').trim() : '';
  const value = first ? Number(first.value ?? first.percent ?? first.val) : NaN;
  return {
    uid: String(uid),
    name: String(name),
    bonus,
    percent: Number.isFinite(value) ? value : null,
    rarity: String(obj.rarity ?? obj.quality ?? '').trim() || null,
  };
}

// Turn an armoury log line into { type: 'loan' | 'return', person, item, qty } or null.
// Handles lines like:
//   "Ghoulie loaned 1x Scythe to themselves from the faction armory"
//   "Officer loaned 1x Scythe to Ghoulie from the faction armory"
//   "Ghoulie returned 1x Scythe to the faction armory"
//   "Officer retrieved 1x Scythe from Ghoulie"
// If Torn words it differently, /qadmin api-test shows the raw lines so the
// patterns below can be adjusted.
function parseArmoury(text) {
  const t = String(text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  let m = t.match(/^(.+?) loaned (\d+)x (.+?) to (.+?)(?: from the faction['’]?s? armou?ry)?\.?$/i);
  if (m) {
    const self = /^(themsel(f|ves)|himself|herself)$/i.test(m[4]);
    return { type: 'loan', person: self ? m[1] : m[4], item: m[3], qty: Number(m[2]) };
  }
  m = t.match(/^(.+?) returned (\d+)x (.+?)(?: to the faction['’]?s? armou?ry)?\.?$/i);
  if (m) return { type: 'return', person: m[1], item: m[3], qty: Number(m[2]) };
  m = t.match(/^(.+?) retrieved (\d+)x (.+?) from (.+?)\.?$/i);
  if (m) return { type: 'return', person: m[4], item: m[3], qty: Number(m[2]) };
  return null;
}

const norm = (s) => String(s || '').trim().toLowerCase();
const sameName = (a, b) => !!a && !!b && norm(a) === norm(b);
// The log names the item (e.g. "Scythe"); bonuses aren't in the log text.
const sameItem = (logItem, weaponName) => {
  const a = norm(logItem);
  const b = norm(weaponName);
  return !!a && !!b && (a === b || a.startsWith(b + ' ') || b.startsWith(a + ' '));
};

// Human-readable explanation for common error codes (shown to admins only).
function explain(err) {
  const hints = {
    0: 'No API key is set. Add TORN_API_KEY to .env and restart.',
    2: 'The API key is wrong. Check TORN_API_KEY.',
    5: 'Too many requests. The bot will back off and retry.',
    7: "The key's owner can't see faction news. They need faction API access from faction leadership.",
    8: 'Your IP is temporarily banned by the Torn API.',
    10: 'The key owner is in federal jail.',
    13: 'The key is disabled because its owner has been inactive.',
    16: "The key's access level is too low for faction news.",
    18: 'The key has been paused by its owner.',
  };
  return hints[err?.code] || err?.message || String(err);
}

module.exports = { enabled, armouryNews, armouryNewsFor, keyFaction, factionName, userFaction, lookupUser, itemByUid, parseArmoury, sameName, sameItem, explain, TornError };
