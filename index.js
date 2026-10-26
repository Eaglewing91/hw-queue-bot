// 💀 The Necromancer: HW Revitalize weapon queue bot for Torn factions (discord.js v14)
// Author: Eaglewing [571041]
//
// Every channel gets its own independent queue: its own weapon pool, waiting
// line and clickable panel. Members can't pick a weapon; whoever is next in
// line gets the next weapon that frees up in that channel.
//
// Flow per turn:
//   1. Member presses Join queue on the channel's panel.
//   2. When a weapon is free, the bot assigns it to the next person and @'s them.
//   3. They press Claim on that @ message within the claim window, or they lose
//      their place. (Claim only lives on the @ message, not on the panel.)
//   4. Claiming starts their slot; they take that weapon from the
//      faction armoury themselves, manually, in Torn.
//   5. When the slot ends they're told to return it and the next person is @'d.
//
// Anti-spam: each turn is ONE message edited in place. Only the "time almost
// up" and "time's up" pings are extra, and all of a turn's messages are deleted
// the channel's clean-up delay after the turn ends. Timings are per channel
// (/qadmin settings), defaulting to the values in .env.
//
// Optional Torn API checks (only if TORN_API_KEY is set): the bot reads the
// faction armoury log on api.torn.com to confirm loans, notice returns (a
// return ends the slot early) and remind people who haven't returned a weapon.
// It never requests torn.com pages and never loans or retrieves anything.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const torn = require('./torn');
const keys = require('./keys');

// ---------- config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
// Who counts as a queue admin (any one of these is enough):
//   • Manage Server permission
//   • a role whose name CONTAINS a keyword from ADMIN_ROLE_KEYWORDS (case, spaces, emoji and
//     punctuation ignored), e.g. "Leader" matches "Faction Leader" and "Leadership Team"
//   • the role ADMIN_ROLE_ID
//   • a Discord user ID listed in ADMIN_USER_IDS
const roleKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const listEnv = (v, d) => String(v ?? d).split(',').map((x) => x.trim()).filter(Boolean);
const ADMIN_ROLE_KEYWORDS = listEnv(process.env.ADMIN_ROLE_KEYWORDS ?? process.env.ADMIN_ROLE_NAMES, 'Leader,Council')
  .map(roleKey).filter(Boolean);
// Roles that would match a keyword but must NOT get admin (e.g. allied groups' leaders).
const ADMIN_ROLE_EXCLUDE = listEnv(process.env.ADMIN_ROLE_EXCLUDE, 'White Rabbits,NPO,External').map(roleKey).filter(Boolean);
const isAdminRoleName = (name) => {
  const k = roleKey(name);
  return !!k && ADMIN_ROLE_KEYWORDS.some((kw) => k.includes(kw)) && !ADMIN_ROLE_EXCLUDE.some((x) => k.includes(x));
};
// Names of the roles in this server that count as admin (for the admin panel and startup log).
function adminRolesHere(guild) {
  const roles = [...(guild?.roles?.cache?.values?.() || [])];
  return roles.filter((r) => (ADMIN_ROLE_ID && r.id === ADMIN_ROLE_ID) || isAdminRoleName(r.name)).map((r) => r.name);
}
const ADMIN_USER_IDS = new Set(listEnv(process.env.ADMIN_USER_IDS, ''));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
// Defaults for new channels. Each channel can override these with /qadmin settings.
const DEFAULTS = {
  slot: num(process.env.SLOT_MINUTES, 15),       // slot length, minutes
  claim: num(process.env.CLAIM_MINUTES, 2),      // time to press Claim, minutes
  warn: num(process.env.WARN_MINUTES, 2),        // "time almost up" ping, minutes before the end (0 = off)
  cleanup: num(process.env.CLEANUP_SECONDS, 120), // delete finished turn messages after N seconds (0 = keep)
  remind: num(process.env.RETURN_REMIND_MINUTES, 5), // API only: remind if not returned N minutes after the slot
  book: num(process.env.BOOK_MINUTES, 15),       // length of a booked slot, minutes
  bookcool: num(process.env.BOOK_COOLDOWN_MINUTES, 60), // after a booked slot, wait this long before the next booked start (0 = off)
  bookkeep: num(process.env.BOOK_KEEP_WEAPONS, 1), // weapons never bookable at the same time, so the queue keeps moving (0 = all bookable)
  bookmin: num(process.env.BOOK_MIN_AHEAD_MINUTES, 60), // earliest booking: this many minutes from now
  bookmax: num(process.env.BOOK_MAX_AHEAD_HOURS, 12),   // latest booking: this many hours from now
};
const LIMITS = { slot: [1, 240], claim: [0.5, 30], warn: [0, 60], cleanup: [0, 3600], remind: [1, 240], book: [5, 240], bookcool: [0, 1440], bookkeep: [0, 25], bookmin: [0, 1440], bookmax: [1, 48] };
const API_POLL_MS = Math.max(15, num(process.env.API_POLL_SECONDS, 30)) * 1000; // armoury log check interval
const MIN = 60_000;
// Members loan weapons to themselves here (the bot only links to it; it never loans anything).
const ARMOURY_URL = process.env.ARMOURY_URL || 'https://www.torn.com/factions.php?step=your&type=1#/tab=armoury&start=0&sub=weapons';
const armouryLink = (label = 'faction armoury') => `[${label}](${ARMOURY_URL})`;
// Where the queue is saved. On Railway, point DATA_DIR at the volume (e.g. /data) so it survives redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
const DATA_FILE = path.join(DATA_DIR, 'queue-data.json');
const QUEUE_SHOWN = 15; // queue entries listed on a panel

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// ---------- 🎃 spooky copy ----------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const SPOOK = {
  up: [
    'The crypt creaks open...',
    'Your number is up! (The good kind, for once.)',
    'The ghouls have chosen you.',
    'Something wicked this way comes... and it’s you.',
    'Rise and shine, it’s grave time.',
    'The candles flicker. It’s your turn.',
    'The Necromancer summons you from the grave.',
  ],
  claimed: [
    'Go forth and revitalise.',
    'Don’t let it rot.',
    'Bring it back in one piece. Or at least in pieces we can find.',
    'Happy haunting!',
    'May your hits be crits and your fights be frights.',
    'Go, and raise the fallen.',
  ],
  warn: [
    'The clock strikes... nearly.',
    'Tick-tock, the crypt wants it back.',
    'Your carriage turns back into a pumpkin soon.',
    'The sun is creeping over the horizon, vampire.',
  ],
  timeUp: [
    'The sun has risen, vampire. Back in the coffin it goes.',
    'Curfew! Return it to the crypt.',
    'The séance is over. Release the weapon.',
    'Midnight has struck.',
    'The Necromancer wants its weapon back.',
  ],
  noclaim: [
    'Ghosted. 👻',
    'Taken by the headless horseman, presumably.',
    'The candle burned out.',
    'Spooked away, it seems.',
    'Lost in the fog.',
    'Even the Necromancer couldn’t raise them.',
  ],
  early: [
    'Left the party early. Suspicious. 🦇',
    'Done already? The zombies thank you.',
    'A generous ghost. Rare.',
  ],
  passed: ['Chickened out. 🐔 Fair enough.', 'Not today, Satan.', 'Returned to the shadows.'],
  left: ['Vanished into the mist.', 'Poof. 💨'],
  removed: ['Banished by the coven.', 'Exorcised from the queue.'],
  skipped: ['Skipped by the crypt keepers.'],
  // {who} = the out-of-turn loaner, {item} = weapon, {holder} = whose turn it is
  shame: [
    '🚨 **Grave robbery!** {who} just loaned **{item}**, but it\'s {holder}\'s turn. The Necromancer saw everything. 👁️',
    '🧟 {who} tried to sneak **{item}** out of the crypt while it was {holder}\'s turn. Truly ghoulish behaviour.',
    '🦇 **Queue jumper spotted!** {who} loaned **{item}**, but {holder} was first in line. The bats are judging you.',
    '⚰️ {who} raided the armoury for **{item}** out of turn. It belongs to {holder} right now. The spirits will remember this.',
    '🔔 *Shame… shame… shame…* {who} loaned **{item}** while it was {holder}\'s turn. Put it back before the curse spreads.',
    '🕯️ The candles flicker in disgust. {who} took **{item}** out of turn. {holder} is still waiting for it.',
  ],
  returned: ['Returned to the crypt. 🪦', 'An honest ghoul!', 'The armoury spirits are pleased.'],
  overdue: ['The armoury spirits grow restless. 👀', 'Something is haunting the armoury… it’s the empty slot.', 'Return it, or the curse begins.'],
  joined: [
    'The Necromancer has written your name in the book.',
    'You’ve joined the line of the damned.',
    'Welcome to the queue. Mind the cobwebs.',
    'Your soul has been added to the ledger.',
  ],
  empty: ['Nobody here but us ghosts. 👻', 'The queue is as empty as a vampire’s reflection.', 'Tumbleweeds and bats.'],
  footer: [
    'No refunds on souls',
    'Please do not feed the zombies',
    'Return weapons or face the curse',
    'Mind the cobwebs',
    'The armoury is haunted. Allegedly.',
    'The Necromancer sees all',
  ],
};

// ---------- state (saved to disk so restarts keep everything) ----------
// {
//   boards: { [channelId]: {
//     weapons: { [key]: { name, bonus, percent, uid?,
//       holder: { userId, claimBy, startedAt, endsAt, msgId, extra: [msgId] } | null } },
//     queue: [{ userId, joinedAt }],
//     awaiting: [{ userId, tornName, weapon, label, loanAt, endedAt, remindMsg }],  // API: not returned yet
//     panelId: messageId | null, settings: {} } },
//   names: { [discordUserId]: tornName },
//   links: { [discordUserId]: { id, name, at } },   // API: verified via Discord ID
//   api: { lastOkAt, lastError },
//   trash: [{ channelId, msgId, at }]     // turn messages waiting to be deleted
// }
let state = {};
function loadState() {
  try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
  fillState();
}
function fillState() {
state.boards ??= {};
state.names ??= {};
state.trash ??= [];
state.links ??= {};
state.api ??= {};
state.tranches ??= {}; // { [factionId]: { name, enc, addedBy, addedAt, status, err, checkedAt } }
state.shamed ??= []; // armoury log entries already called out, so each loan is shamed once
}
loadState();

// Write to disk; if a channel is given, refresh its panel too.
function save(cid) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  if (cid) queuePanelUpdate(cid);
}

const board = (cid) => state.boards[cid];
const ensureBoard = (cid) => (state.boards[cid] ??= { weapons: {}, queue: [], awaiting: [], panelId: null, settings: {} });
// This channel's settings: its own overrides on top of the .env defaults.
const cfg = (b) => ({ ...DEFAULTS, ...(b?.settings || {}) });

// ---------- helpers ----------
let shuttingDown = false; // set when Railway stops this copy (deploys)
let booted = !!process.env.HWQ_TEST; // set once startup has settled (see ClientReady); offline tests start ready
const keyOf = (s) => String(s || '').trim().toLowerCase();
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const isActive = (h) => !!h?.endsAt; // false = assigned, waiting for Claim
const wl = (w) => (w.bonus ? `${w.name} (${w.bonus} ${w.percent}%)` : w.name);
const who = (userId) => {
  const tn = state.names[userId];
  return `<@${userId}>${tn ? ` (${tn})` : ''}`;
};
const entries = (b) => Object.entries(b.weapons);
// Highest bonus % first (ties keep the order they were added).
const byBonus = (list) => [...list].sort((a, b) => (Number(b[1].percent) || 0) - (Number(a[1].percent) || 0));
// Shown on turn messages so the member takes the exact weapon (only if a UID was registered).
// ---- weapon groups: copies with the same name AND bonus in one channel are interchangeable.
// The armoury log only names the weapon type, so any copy counts for whoever's turn it is.
const groupKey = (w) => `${keyOf(w.name)}|${keyOf(w.bonus)}`;
const groupOf = (b, w) => byBonus(entries(b).filter(([, x]) => groupKey(x) === groupKey(w)));
const isGroup = (b, w) => groupOf(b, w).length > 1;
function groupLabel(list) {
  const ws = list.map(([, w]) => w);
  if (ws.length === 1) return wl(ws[0]);
  const ps = ws.map((w) => Number(w.percent) || 0);
  const lo = Math.min(...ps); const hi = Math.max(...ps);
  return ws[0].bonus ? `${ws[0].name} (${ws[0].bonus} ${lo === hi ? lo : `${lo}–${hi}`}%)` : ws[0].name;
}
// Label for a weapon as members should see it: "MP5 Navy (Revitalize 12–14%)" when grouped.
const gl = (b, w) => (b ? groupLabel(groupOf(b, w)) : wl(w));
// Short UID note for the one-line tag message: " · UID 123" or " · UIDs 123 (14%), 456 (12%)".
function uidInline(b, w) {
  if (b && isGroup(b, w)) {
    const ids = groupOf(b, w).filter(([, x]) => x.uid).map(([, x]) => `${x.uid} (${x.percent}%)`);
    return ids.length ? ` · UIDs ${ids.join(', ')}` : '';
  }
  return w.uid ? ` · UID ${w.uid}` : '';
}
// Which exact weapon(s) to take: one UID, or every copy's UID with its % when grouped.
function uidNoteFor(b, w) {
  if (b && isGroup(b, w)) {
    const ids = groupOf(b, w).filter(([, x]) => x.uid).map(([, x]) => `${x.uid} (${x.percent}%)`);
    return ids.length ? `\n-# 🔎 UIDs ${ids.join(' · ')}` : '';
  }
  return w.uid ? `\n-# 🔎 UID ${w.uid}: take this exact one from the armoury.` : '';
}
const heldBy = (b, userId) => entries(b).find(([, w]) => w.holder?.userId === userId); // [key, w] | undefined
const queuePos = (b, userId) => b.queue.findIndex((e) => e.userId === userId);

function setName(userId, name) {
  const n = name?.trim();
  if (n) state.names[userId] = n.slice(0, 32);
}

// ---------- tranches: one faction (and one armoury key) per queue channel ----------
const TRANCHES = (process.env.TRANCHE_FACTIONS || '19,16312,7049,22680,31764').split(',').map((x) => Number(x.trim())).filter(Boolean);
const tranche = (fid) => (state.tranches[fid] ??= {});
const trancheName = (fid) => state.tranches[fid]?.name || `Faction ${fid}`;
const hasKey = (fid) => !!state.tranches[fid]?.enc;
// A queue stays locked until an admin picks its tranche (REQUIRE_TRANCHE=false turns this off).
const REQUIRE_TRANCHE = process.env.REQUIRE_TRANCHE !== 'false';
const isOpen = (b) => !REQUIRE_TRANCHE || !!b?.faction;
const LOCKED = "👻 This queue isn't open yet. An admin needs to pick this channel's tranche first (🛠️ Admin → 🔑 API keys → 🏷️ Set this channel's tranche).";
const keyOf_ = (fid) => (hasKey(fid) ? keys.decrypt(state.tranches[fid].enc) : null);
const KEY_LINK = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Necromancer&faction=armorynews';
// Is this channel's armoury log being watched? Linked to a tranche → that tranche's key;
// not linked → the owner's key (the original single-faction setup).
const boardWatched = (b) => (b?.faction ? hasKey(b.faction) && state.tranches[b.faction].status !== 'bad' : !REQUIRE_TRANCHE && torn.enabled());
// Which Torn key reads a board's armoury log: 'owner', a faction ID, or null (none).
const sourceOf = (b) => (b.faction ? (hasKey(b.faction) ? b.faction : null) : (!REQUIRE_TRANCHE && torn.enabled() ? 'owner' : null));

async function refreshTrancheNames() {
  for (const fid of TRANCHES) {
    if (state.tranches[fid]?.name) continue;
    const n = await torn.factionName(fid);
    if (n) { tranche(fid).name = n; save(); }
  }
}

// Join check: is this member in the channel's tranche? true / false / null (couldn't tell).
const factionCache = new Map(); // userId -> { fid, at }
async function memberFaction(userId) {
  const c = factionCache.get(userId);
  if (c && Date.now() - c.at < 6 * 60 * MIN) return c.fid;
  const fid = await torn.userFaction(state.links[userId]?.id || userId);
  if (fid !== null) factionCache.set(userId, { fid, at: Date.now() });
  return fid;
}
async function inTranche(b, userId) {
  if (!b.faction || !torn.enabled()) return null;
  const timeout = new Promise((r) => setTimeout(() => r(null), 2200)); // Discord needs an answer within 3 s
  const fid = await Promise.race([memberFaction(userId), timeout]);
  return fid === null || fid === undefined ? null : fid === b.faction;
}

// The Torn name used to match armoury log lines: API-verified link first, then a manually set name.
const tornName = (userId) => state.links[userId]?.name || state.names[userId] || null;

// API: try to link a member to their Torn account via their Discord ID (works if
// they've linked Discord in Torn). Runs in the background; failures are quiet.
const linkTried = new Map();
async function autoLink(userId) {
  if (!torn.enabled() || state.links[userId]) return;
  if (Date.now() - (linkTried.get(userId) || 0) < 60 * MIN) return;
  linkTried.set(userId, Date.now());
  try {
    const u = await torn.lookupUser(userId);
    if (!u) return;
    state.links[userId] = { id: u.id, name: u.name, at: Date.now() };
    state.names[userId] = u.name;
    save();
    for (const cid of Object.keys(state.boards)) queuePanelUpdate(cid);
  } catch { /* not linked in Torn, or API hiccup: they can still press Claim */ }
}

// Estimated start times for the first `count` people in a board's queue.
function etas(b, count) {
  const now = Date.now();
  const slotMs = cfg(b).slot * MIN;
  const free = entries(b).map(([, w]) =>
    !w.holder ? now : isActive(w.holder) ? w.holder.endsAt : now + slotMs);
  if (!free.length) return [];
  const out = [];
  for (let n = 0; n < count; n++) {
    let mi = 0;
    for (let j = 1; j < free.length; j++) if (free[j] < free[mi]) mi = j;
    out.push(free[mi]);
    free[mi] += slotMs;
  }
  return out;
}

const timers = {}; // `${channelId}|${weaponKey}` -> { claim, warn, end }
const tkey = (cid, key) => `${cid}|${key}`;

// ---------- discord plumbing ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function chan(cid) {
  try { return await client.channels.fetch(cid); } catch { return null; }
}

// Messages still being posted, so a shutdown can wait for them (and save their IDs) first.
const inFlight = new Set();
async function send(cid, content, components = []) {
  const ch = await chan(cid);
  const p = (async () => {
    try {
      // SuppressEmbeds: no big link-preview card under the armoury link.
      return await ch.send({ content, components, allowedMentions: { parse: ['users'] }, flags: MessageFlags.SuppressEmbeds });
    } catch (err) { console.error(`Failed to post in ${cid}:`, err.message); }
  })();
  inFlight.add(p);
  try { return await p; } finally { inFlight.delete(p); }
}

async function editMsg(cid, msgId, content, components = []) {
  if (!msgId) return;
  try {
    const m = await (await chan(cid)).messages.fetch(msgId);
    await m.edit({ content, components, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
  } catch { /* deleted or not found */ }
}

async function deleteMsg(cid, msgId) {
  try { await (await (await chan(cid)).messages.fetch(msgId)).delete(); } catch { /* already gone */ }
}

// Queue messages for deletion after the channel's clean-up delay (kept on disk across restarts).
function trashLater(cid, ids) {
  const secs = cfg(board(cid)).cleanup;
  if (secs <= 0) return;
  const at = Date.now() + secs * 1000;
  for (const msgId of ids.filter(Boolean)) {
    state.trash.push({ channelId: cid, msgId, at });
    setTimeout(() => emptyTrash(), secs * 1000 + 50);
  }
  save();
}

async function emptyTrash() {
  const now = Date.now();
  const due = state.trash.filter((t) => t.at <= now);
  if (!due.length) return;
  state.trash = state.trash.filter((t) => t.at > now);
  save();
  for (const t of due) await deleteMsg(t.channelId, t.msgId);
}

function isAdmin(i) {
  if (ADMIN_USER_IDS.has(i.user?.id)) return true;
  if (i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  // The member's roles arrive either as Role objects (cached) or as plain role IDs.
  const raw = i.member?.roles;
  const roles = Array.isArray(raw)
    ? raw.map((id) => i.guild?.roles?.cache?.get(id) || { id, name: '' })
    : [...(raw?.cache?.values?.() || [])];
  return roles.some((r) => (ADMIN_ROLE_ID && r.id === ADMIN_ROLE_ID) || isAdminRoleName(r.name));
}

// ---------- timers ----------
function clearTimers(cid, key) {
  const t = timers[tkey(cid, key)];
  if (!t) return;
  clearTimeout(t.claim);
  clearTimeout(t.warn);
  clearTimeout(t.end);
  delete timers[tkey(cid, key)];
}

// (Re)arm the right timer for a weapon's holder. Overdue timers fire immediately.
function schedule(cid, key) {
  clearTimers(cid, key);
  const w = board(cid)?.weapons[key];
  const h = w?.holder;
  if (!h) return;
  const t = {};
  const now = Date.now();

  if (!isActive(h)) {
    if (!h.claimBy) { h.claimBy = now + cfg(board(cid)).claim * MIN; save(); }
    t.claim = setTimeout(() => endTurn(cid, key, 'noclaim'), Math.max(0, h.claimBy - now));
  } else {
    const left = h.endsAt - now;
    const warnMin = h.warnMin ?? cfg(board(cid)).warn;
    const warnMs = warnMin * MIN;
    if (warnMs > 0 && left > warnMs) {
      t.warn = setTimeout(async () => {
        const m = await send(cid, `⏳ ${who(h.userId)}, ${warnMin} min left with **${gl(board(cid), w)}**. ${pick(SPOOK.warn)}`);
        if (m && w.holder === h) { h.extra.push(m.id); save(); }
      }, left - warnMs);
    }
    t.end = setTimeout(() => endTurn(cid, key, 'time'), Math.max(0, left));
  }
  timers[tkey(cid, key)] = t;
}

// ---------- turn message (one per turn, edited in place) ----------
const btn = (id, label, style, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
};

const claimRow = (key, userId) => [new ActionRowBuilder().addComponents(
  btn(`claim|${key}|${userId}`, 'Claim', ButtonStyle.Success, '🙋'),
  btn(`pass|${key}|${userId}`, 'Pass', ButtonStyle.Secondary),
)];

const slotRow = (key, userId) => [new ActionRowBuilder().addComponents(
  btn(`done|${key}|${userId}`, 'Finished early', ButtonStyle.Primary, '🏁'),
)];

// ---------- turn logic ----------
// Give every free weapon in a channel to the next person in that channel's line,
// handing out the highest bonus % first when several are free.
const advancing = new Set();
// ---------- 📅 bookings: reserve a start time (any weapon, or a specific one) ----------
// A booking gets the next matching free weapon at its time, ahead of the queue. Queue turns that
// would run into a booking are shortened to end at the booking time (or the weapon is held if
// that would leave less than a few minutes). At least the channel's "weapons kept for the queue" (bookkeep) are never bookable at once,
// so the walk-up queue always keeps moving.
// How far ahead people can book (per channel settings bookmin / bookmax).
// The 'earliest booking' buffer protects people waiting in the queue, so bookings-only channels skip it.
const aheadMin = (b) => (queueOn(b) ? cfg(b).bookmin : 0);
const aheadMax = (b) => cfg(b).bookmax * 60;
const BOOK_STEP_MIN = 15; // start times are offered every 15 minutes, whatever the booking length
const hrs = (m) => (m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min` : `${m / 60} h`);
const BOOK_MIN_SHORT = 5;       // don't start a queue turn shorter than this (minutes); hold the weapon
const BOOK_EXPIRE_MIN = 60;     // a booking still unserved this long after its time is dropped
const bookingsOn = (b) => !b?.bookingOff;
// A channel can run bookings only: no walk-up queue, every weapon bookable.
const queueOn = (b) => !b?.queueOff;
const bookingsOf = (b) => (b.bookings ??= []);
const tct = (ms) => new Date(ms).toISOString().slice(11, 16) + ' TCT';
const tctIn = (ms) => `${tct(ms)} (${ts(ms)})`; // "18:00 TCT (in 42 minutes)"
// Which weapons a booking may use: 'any', or one weapon group ('g:<name|bonus>').
const bookingKeys = (b, bk) => entries(b).filter(([, w]) => bk.weapon === 'any' || `g:${groupKey(w)}` === bk.weapon).map(([k]) => k);
function bookingLabel(b, bk) {
  if (bk.weapon === 'any') return 'Any weapon';
  const grp = entries(b).filter(([, w]) => `g:${groupKey(w)}` === bk.weapon);
  return grp.length ? groupLabel(byBonus(grp)) : 'a removed weapon';
}
const maxBookable = (b) => Math.max(0, entries(b).length - (queueOn(b) ? Math.round(cfg(b).bookkeep) : 0));

// Is a start time T free for a new booking of `weapon` ('any' or 'g:…')?
function slotFree(b, T, weapon, ignoreId) {
  const len = cfg(b).book * MIN;
  const overlap = bookingsOf(b).filter((x) => x.id !== ignoreId && Math.abs(x.at - T) < len);
  if (overlap.length >= maxBookable(b)) return false;
  if (weapon !== 'any') {
    const size = entries(b).filter(([, w]) => `g:${groupKey(w)}` === weapon).length;
    if (!size || overlap.filter((x) => x.weapon === weapon).length >= size) return false;
  }
  return true;
}

// Start times someone can book now: every 15 min (TCT), between the channel's earliest and latest limits.
// Earliest start a member may book, after the cooldown from their last booked slot.
const coolUntil = (b, userId) => (cfg(b).bookcool ? (b.lastBooked?.[userId] || 0) + cfg(b).bookcool * MIN : 0);

function bookableTimes(b, weapon, userId, ignoreId) {
  const step = BOOK_STEP_MIN * MIN;
  const now = Date.now();
  const earliest = Math.max(now + Math.max(aheadMin(b), 5) * MIN, coolUntil(b, userId));
  const out = [];
  for (let T = Math.ceil(earliest / step) * step; T <= now + aheadMax(b) * MIN && out.length < 100; T += step) {
    if (slotFree(b, T, weapon, ignoreId)) out.push(T);
  }
  return out;
}

// Plan which weapon each upcoming booking will use, preferring weapons that will be
// free by then anyway, so free weapons aren't held unless they have to be.
function planBookings(b, horizon) {
  const plan = new Map(); // weaponKey -> booking
  const now = Date.now();
  const due = bookingsOf(b).filter((x) => x.at > now && x.at < horizon)
    .sort((x, y) => x.at - y.at || (x.weapon === 'any') - (y.weapon === 'any'));
  for (const bk of due) {
    const cands = bookingKeys(b, bk).filter((k) => !plan.has(k));
    const freeBy = (k) => { const h = b.weapons[k].holder; return !h ? 1 : (isActive(h) && h.endsAt <= bk.at ? 0 : 2); };
    cands.sort((x, y) => freeBy(x) - freeBy(y));
    if (cands.length && freeBy(cands[0]) <= 1) plan.set(cands[0], bk);
  }
  return plan;
}

// Hand weapon `key` to `userId` (a queue turn or a booking).
async function callUp(cid, b, key, userId, extra = {}) {
  const w = b.weapons[key];
  const claimBy = Date.now() + cfg(b).claim * MIN;
  w.holder = { userId, calledAt: Date.now(), claimBy, startedAt: null, endsAt: null, msgId: null, extra: [], ...extra };
  save(cid);
  schedule(cid, key);
  const short = extra.capEnd ? ` · short turn, ends ${tctIn(extra.capEnd)} for a booking` : '';
  const msg = await send(cid,
    `${extra.booked ? '📅' : '🎃'} <@${userId}> → **${gl(b, w)}**${isGroup(b, w) ? ' (either one)' : ''} · ` +
    `[loan it](${ARMOURY_URL}) ${ts(claimBy)}${boardWatched(b) ? '' : ', then press **Claim**'}${uidInline(b, w)}${short}`,
    claimRow(key, userId));
  if (msg && w.holder?.userId === userId) { w.holder.msgId = msg.id; save(); }
}

// Serve bookings whose time has come, then drop ones that went unserved for too long.
async function serveBookings(cid, b) {
  const now = Date.now();
  const list = bookingsOf(b);
  for (const bk of [...list].filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
    if (heldBy(b, bk.userId)) { b.bookings = list.filter((x) => x !== bk); save(cid); continue; } // already has a weapon
    const key = byBonus(entries(b).filter(([k, w]) => !w.holder && bookingKeys(b, bk).includes(k)))[0]?.[0];
    if (!key) continue; // nothing free yet: first in line when one frees up
    b.bookings = bookingsOf(b).filter((x) => x !== bk);
    const qp = queuePos(b, bk.userId);
    if (qp !== -1) b.queue.splice(qp, 1); // served by the booking
    (b.lastBooked ??= {})[bk.userId] = Math.max(Date.now(), bk.at) + cfg(b).book * MIN; // cooldown runs from the end of this slot
    await callUp(cid, b, key, bk.userId, { booked: true, slotMin: cfg(b).book });
  }
  const stale = bookingsOf(b).filter((x) => now - x.at > BOOK_EXPIRE_MIN * MIN);
  if (stale.length) { b.bookings = bookingsOf(b).filter((x) => !stale.includes(x)); save(cid); }
}

async function advance(cid) {
  const b = board(cid);
  if (!b || advancing.has(cid) || !isOpen(b) || shuttingDown || !booted) return;
  advancing.add(cid);
  try {
    await serveBookings(cid, b);
    const slotMs = cfg(b).slot * MIN;
    for (const [key, w] of byBonus(entries(b))) {
      if (w.holder || !b.weapons[key] || !b.queue.length || !queueOn(b)) continue;
      // Is this weapon needed for a booking before a full turn would end?
      const bk = planBookings(b, Date.now() + slotMs + cfg(b).claim * MIN).get(key);
      let capEnd;
      if (bk) {
        if (bk.at - Date.now() < (BOOK_MIN_SHORT + cfg(b).claim) * MIN) continue; // hold it for the booking
        capEnd = bk.at;
      }
      const next = b.queue.shift();
      await callUp(cid, b, key, next.userId, capEnd ? { capEnd } : {});
    }
  } finally {
    advancing.delete(cid);
  }
  // Loop again only if a queue turn could still start (held weapons don't count).
  if (b.queue.length && entries(b).some(([k, w]) => !w.holder && !planBookings(b, Date.now() + cfg(b).slot * MIN + cfg(b).claim * MIN).has(k))
    && !advance.again) {
    advance.again = true;
    try { await advance(cid); } finally { advance.again = false; }
  }
}

async function startSlot(cid, key) {
  clearTimers(cid, key);
  const w = board(cid).weapons[key];
  const h = w.holder;
  h.startedAt = Date.now();
  const c = cfg(board(cid));
  h.endsAt = Math.min(h.startedAt + (h.slotMin || c.slot) * MIN, h.capEnd || Infinity); // booked turns use the booking length; a booking may cut a queue turn short
  h.warnMin = c.warn; // settings changed mid-turn don't affect a running slot
  h.quip = pick(SPOOK.claimed);
  save(cid);
  schedule(cid, key);
  await editMsg(cid, h.msgId, slotText(w, h, board(cid)), slotRow(key, h.userId));
  autoLink(h.userId);
}

// Text of a running turn's message (re-used when the armoury log confirms the loan).
function slotText(w, h, b) {
  let t = `🔫 ${who(h.userId)} has **${gl(b, w)}**. Slot ends ${tctIn(h.endsAt)}.\n` +
    (h.autoClaimed ? `${h.quip || ''}` : `If you haven't yet, loan it to yourself in the ${armouryLink()}. ${h.quip || ''}${uidNoteFor(b, w)}`);
  if (boardWatched(b)) {
    t += h.autoClaimed ? '\n✅ Auto-claimed: loan seen in the armoury log.'
      : h.loanAt ? '\n✅ Loan confirmed in the armoury log.'
      : tornName(h.userId) ? '\n-# Watching the armoury log for the loan…'
        : "\n-# Their Discord isn't linked in Torn, so I can't spot the loan. They'll need to press **Claim**.";
  }
  return t;
}

async function endTurn(cid, key, reason) {
  clearTimers(cid, key);
  const b = board(cid);
  const w = b?.weapons[key];
  if (!w?.holder) return;
  const h = w.holder;
  const hadWeapon = isActive(h);
  w.holder = null;
  save(cid);

  // API: we saw them loan it, so keep an eye out for the return.
  if (hadWeapon && h.loanAt && reason !== 'returned') {
    b.awaiting ??= [];
    b.awaiting.push({ userId: h.userId, tornName: tornName(h.userId), weapon: w.name, label: gl(b, w),
      loanAt: h.loanAt, endedAt: Date.now(), remindMsg: null });
    save(cid);
  }

  const u = who(h.userId);
  const ret = hadWeapon && reason !== 'returned' ? ' Please return it to the faction armoury.' : '';
  const outcome = {
    time: `⏰ ${u}'s time with **${gl(b, w)}** is up. ${pick(SPOOK.timeUp)}${ret}`,
    early: `🏁 ${u} finished early with **${gl(b, w)}**. ${pick(SPOOK.early)}${ret}`,
    left: `👋 ${u} left the queue. ${pick(SPOOK.left)}${ret}`,
    skipped: `⏭️ ${u} was skipped. ${pick(SPOOK.skipped)}${ret}`,
    removed: `🚫 ${u} was removed. ${pick(SPOOK.removed)}${ret}`,
    passed: `↩️ ${u} passed on **${gl(b, w)}**. ${pick(SPOOK.passed)}`,
    noclaim: `💤 ${u} didn't claim **${gl(b, w)}** in time and lost their place. ${pick(SPOOK.noclaim)}`,
    returned: `📦 ${u} returned **${gl(b, w)}** to the armoury, so their turn is over. ${pick(SPOOK.returned)}`,
  }[reason];

  await editMsg(cid, h.msgId, outcome); // the turn message becomes its own "ended" note
  const extra = [...h.extra];
  // Slot ran out: they may be away from Discord, so ping them to return it.
  if (reason === 'time') {
    const m = await send(cid, `⏰ ${who(h.userId)}, time's up! Return **${gl(b, w)}** to the faction armoury. ${pick(SPOOK.timeUp)}`);
    if (m) extra.push(m.id);
  }
  trashLater(cid, [h.msgId, ...extra]);
  await advance(cid);
}

// ---------- member actions (shared by panel, turn buttons and slash commands) ----------
const NO_BOARD = "There's no weapon queue in this channel. An admin can set one up with `/qadmin panel`.";

// Add someone to the back of a channel's queue. Returns { text, after } (see "queue operations").
function enqueue(cid, userId, byAdmin = false) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  if (!isOpen(b)) return { text: LOCKED };
  if (!queueOn(b)) return { text: '📅 This channel is **bookings only**. Press **Book a slot** to reserve a time.' };
  const you = byAdmin ? `<@${userId}> is` : "You're";
  const held = heldBy(b, userId);
  if (held) return { text: `${you} already ${isActive(held[1].holder) ? 'using' : 'up for'} **${wl(held[1])}**.` };
  const pos = queuePos(b, userId);
  if (pos !== -1) return { text: `${you} already in the queue at position ${pos + 1}.${byAdmin ? '' : ' Patience, mortal.'}` };
  if (!entries(b).length) return { text: 'There are no weapons in this queue yet. The armoury is bare. 🕸️' };

  b.queue.push({ userId, joinedAt: Date.now() });
  save(cid);
  autoLink(userId);
  const n = b.queue.length - 1;
  const freeNow = entries(b).filter(([, w]) => !w.holder).length;
  const lead = byAdmin ? `👤 Added <@${userId}>.` : pick(SPOOK.joined);
  const they = byAdmin ? "they're" : "you're";
  return {
    text: n < freeNow
      ? `${lead} A weapon is free, so ${they} up now! Press **Claim** on the message that tags ${byAdmin ? 'them' : 'you'}, within ${cfg(b).claim} min.`
      : `${lead} Position ${n + 1}, turn roughly ${tctIn(etas(b, n + 1)[n])}.`,
    after: () => advance(cid),
  };
}

// Button presses that worked are acknowledged silently: the panel or the tag message
// already shows the result. Slash commands still get a private reply (Discord needs one).
// Anything the member can't see otherwise (errors, "not your turn") stays a private message.
const ack = (i, text) => (i.isButton?.() ? i.deferUpdate() : i.reply(eph(text)));

async function joinQueue(i, cid, userId) {
  const b = board(cid);
  if (b?.faction && (await inTranche(b, userId)) === false) {
    return i.reply(eph(`👻 This queue is for **${trancheName(b.faction)}** members only. The spirits turn you away.`));
  }
  const r = enqueue(cid, userId);
  if (r.after) await ack(i, r.text); // joined
  else await i.reply(eph(r.text));  // couldn't join: say why
  if (r.after) await r.after();
}

async function leaveQueue(i, cid) {
  const b = board(cid);
  if (!b) return i.reply(eph(NO_BOARD));
  const held = heldBy(b, i.user.id);
  if (held) {
    await ack(i, isActive(held[1].holder)
      ? `You've ended your slot. Please return **${wl(held[1])}** to the faction armoury.`
      : "You've given up your turn.");
    return endTurn(cid, held[0], 'left');
  }
  const pos = queuePos(b, i.user.id);
  if (pos === -1) return i.reply(eph("You're not in this queue."));
  b.queue.splice(pos, 1);
  save(cid);
  return ack(i, `You left the queue. ${pick(SPOOK.left)}`);
}

async function claim(i, cid) {
  const b = board(cid);
  if (!b) return i.reply(eph(NO_BOARD));
  const held = heldBy(b, i.user.id);
  if (!held || isActive(held[1].holder)) {
    return i.reply(eph(held
      ? `You've already claimed **${wl(held[1])}**.`
      : queuePos(b, i.user.id) === -1
        ? "You're not in this queue. Press **Join queue** first."
        : "It's not your turn yet. You'll be @'d when a weapon is free. 🕯️"));
  }
  const unknown = boardWatched(b) && !tornName(i.user.id)
    ? "\n⚠️ Your Discord isn't linked to your Torn account, so I can't spot your loans. Link it in Torn (Preferences → Discord) for auto-claim." : '';
  // Silent unless there's something they need to know (no Torn name → loan can't be confirmed).
  if (unknown) await i.reply(eph(`✅ Claimed **${wl(held[1])}**.${unknown}`));
  else await ack(i, `✅ Claimed **${wl(held[1])}**. Take it from the faction armoury now. ${pick(SPOOK.claimed)}`);
  await startSlot(cid, held[0]);
}

async function finish(i, cid) {
  const b = board(cid);
  if (!b) return i.reply(eph(NO_BOARD));
  const held = heldBy(b, i.user.id);
  if (!held || !isActive(held[1].holder)) return i.reply(eph("You don't have a weapon slot running."));
  await ack(i, `🏁 Finished. Please return **${wl(held[1])}** to the faction armoury.`);
  await endTurn(cid, held[0], 'early');
}

function myStatus(cid, userId) {
  const b = board(cid);
  if (!b) return NO_BOARD;
  const lines = [];
  const held = heldBy(b, userId);
  const pos = queuePos(b, userId);
  if (held) {
    const h = held[1].holder;
    lines.push(isActive(h)
      ? `🔫 You have **${wl(held[1])}**. Your slot ends ${tctIn(h.endsAt)}.`
      : `🙋 You're up for **${wl(held[1])}**! Press **Claim** on the message that tags you. Time runs out ${ts(h.claimBy)}.`);
  } else if (pos !== -1) {
    lines.push(`🕒 You're #${pos + 1} in this queue. Your turn is roughly ${tctIn(etas(b, pos + 1)[pos])}.`);
  } else {
    lines.push("You're not in this queue.");
  }
  const mine = bookingsOf(b).find((x) => x.userId === userId);
  if (mine) lines.push(`📅 Booked: **${bookingLabel(b, mine)}** at **${tct(mine.at)}** (${ts(mine.at)}).`);
  const aw = (b.awaiting || []).find((a) => a.userId === userId);
  if (aw) lines.push(`👻 The armoury log hasn't seen **${aw.label}** come back yet. Please return it.`);
  const link = state.links[userId];
  const tn = state.names[userId];
  lines.push(link ? `-# Torn: ${link.name} [${link.id}] (linked automatically)`
    : tn ? `-# Torn name: ${tn}` : "-# Your Discord isn't linked in Torn, so loans can't be auto-claimed. Link it in Torn (Preferences → Discord).");
  return lines.join('\n');
}

// ---------- panel ----------
function panelEmbed(b) {
  const list = entries(b);
  const c = cfg(b);
  if (!isOpen(b)) {
    return new EmbedBuilder().setTitle('💀 The Necromancer: Revitalize Queue').setColor(0xff7518)
      .setDescription("⚠️ **This queue isn't set up yet.**\nAn admin needs to pick this channel's tranche: " +
        "🛠️ **Admin** → 🔑 **API keys** → 🏷️ **Set this channel's tranche**.\n\n-# The spirits are waiting. Joining opens once it's set.");
  }
  const bookOnly = !queueOn(b);
  const parts = bookOnly ? [
    `📅 **Bookings only.** There's no walk-up queue in this channel.\n` +
    `**1.** Press **Book a slot** and pick a weapon and a start time (TCT).\n` +
    `**2.** At your time you'll be @'d. [Loan the weapon](${ARMOURY_URL}) to yourself within **${c.claim} min**` +
    `${boardWatched(b) ? '. The bot auto-claims your turn.' : ', then press **Claim**.'}\n` +
    `**3.** Return it after **${c.book} min**.`,
    `\n**🗡️ Weapons (${list.length})**`,
  ] : [
    `**1.** Press **Join queue**. You'll be @'d when it's your turn.\n` +
    (boardWatched(b)
      ? `**2.** [Loan the weapon](${ARMOURY_URL}) to yourself within **${c.claim} min**. The bot auto-claims your turn.\n`
      : `**2.** [Loan the weapon](${ARMOURY_URL}) to yourself, then press **Claim** within **${c.claim} min**.\n`) +
    `**3.** Return it after **${c.slot} min**.`,
    // Only in channels where booking is on (and the Book button shows).
    ...(bookingsOn(b) && maxBookable(b) > 0
      ? ['\n📢 **Notice:** booked slots take priority over the queue. Queue times are estimates and can move back if someone has booked, so keep an eye on the 📅 Booked list below.']
      : []),
    `\n**🗡️ Weapons (${list.length})**`,
  ];
  if (!list.length) parts.push('None yet. The armoury is bare. 🕸️ Admins: `/qadmin add-weapon`.');
  const holderLine = (h) => {
    const loan = boardWatched(b) && isActive(h) ? (h.loanAt ? ' · ✅ loaned' : ' · ⏳ loan not seen yet') : '';
    return isActive(h) ? `🔫 ${who(h.userId)}, ends ${tctIn(h.endsAt)}${loan}` : `🙋 ${who(h.userId)}, must claim ${ts(h.claimBy)}`;
  };
  const shown = new Set();
  for (const [, w] of byBonus(list)) {
    const gk = groupKey(w);
    if (shown.has(gk)) continue;
    shown.add(gk);
    const grp = groupOf(b, w);
    if (grp.length === 1) {
      const h = w.holder;
      parts.push(h ? `${holderLine(h).slice(0, 2)} **${wl(w)}**: ${holderLine(h).slice(3)}` : `🕯️ **${wl(w)}**: free`);
      continue;
    }
    parts.push(`**${groupLabel(grp)} ×${grp.length}**, either one`);
    for (const [, x] of grp) if (x.holder) parts.push(`└ ${holderLine(x.holder)}`);
    const free = grp.filter(([, x]) => !x.holder).length;
    if (free) parts.push(`└ 🕯️ ${free} free`);
  }

  const upcoming = [...bookingsOf(b)].sort((x, y) => x.at - y.at);
  if (bookOnly && !upcoming.length) parts.push('\n**📅 Booked (0)**\nNo bookings yet. Every slot is free. 🕯️');
  if (upcoming.length) {
    parts.push(`\n**📅 Booked (${upcoming.length})**`);
    for (const bk of upcoming.slice(0, 5)) parts.push(`${tct(bk.at)} · ${who(bk.userId)} · ${bookingLabel(b, bk)} · ${ts(bk.at)}`);
    if (upcoming.length > 5) parts.push(`-# …and ${upcoming.length - 5} more. Press **Book a slot** to see free times.`);
  }
  if (!bookOnly) {
    parts.push(`\n**⚰️ Queue (${b.queue.length})**`);
    if (!b.queue.length) parts.push(SPOOK.empty[Math.floor(Date.now() / 3_600_000) % SPOOK.empty.length]);
    const times = etas(b, Math.min(b.queue.length, QUEUE_SHOWN));
    b.queue.slice(0, QUEUE_SHOWN).forEach((e, n) => parts.push(`${n + 1}. ${who(e.userId)}, ~${tctIn(times[n])}`));
    if (b.queue.length > QUEUE_SHOWN) parts.push(`…and ${b.queue.length - QUEUE_SHOWN} more lost souls`);
  }

  if (b.awaiting?.length) {
    parts.push(`\n**👻 Not returned yet (${b.awaiting.length})**`);
    for (const a of b.awaiting.slice(0, 10)) parts.push(`${who(a.userId)}: ${a.label}, slot ended ${ts(a.endedAt)}`);
  }

  let text = parts.join('\n');
  if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
  // Footer joke changes hourly rather than on every edit, so the panel doesn't flicker.
  const joke = SPOOK.footer[Math.floor(Date.now() / 3_600_000) % SPOOK.footer.length];
  return new EmbedBuilder()
    .setTitle('💀 The Necromancer: Revitalize Queue')
    .setColor(0xff7518)
    .setDescription(text)
    .setFooter({ text: `${c.slot}-min slots · ${c.claim} min to claim · times are estimates · ${joke}` });
}

function panelComponents(b) {
  const locked = !isOpen(b);
  return [
    new ActionRowBuilder().addComponents(
      ...(queueOn(b) ? [btn('p_join', 'Join queue', ButtonStyle.Success, '🎃').setDisabled(locked),
        btn('p_leave', 'Leave queue', ButtonStyle.Danger, '👋')] : []),
      ...(bookingsOn(b) && maxBookable(b) > 0 ? [btn('p_book', 'Book a slot', ButtonStyle.Primary, '📅').setDisabled(locked),
        btn('p_allbook', 'View all bookings', ButtonStyle.Secondary, '🗓️')] : []),
    ),
    new ActionRowBuilder().addComponents(
      btn('p_done', 'Finished', ButtonStyle.Primary, '🏁'),
      btn('p_me', 'My status', ButtonStyle.Secondary, '📋'),
      btn('p_admin', 'Admin', ButtonStyle.Secondary, '🛠️'),
    ),
  ];
}

const panelPayload = (b) => ({ content: '', embeds: [panelEmbed(b)], components: panelComponents(b) });

// Panel edits are batched per channel, so a burst of changes becomes one edit.
// The panel is only ever edited, never re-posted, unless an admin runs /qadmin panel.
// When queue positions change (someone called up, someone leaves, is moved or removed), the panel
// moves to the bottom of the channel so it stays in view. Joining at the back, claims, loans and
// chat never move it; they just edit it in place.
const panelTimers = {};
const lastQueue = {}; // cid -> user IDs in queue order at the last panel update
const lastBookings = {}; // cid -> bookings signature at the last panel update
function queuePanelUpdate(cid) {
  if (panelTimers[cid] || !board(cid)?.panelId) return;
  panelTimers[cid] = setTimeout(() => { delete panelTimers[cid]; flushPanel(cid); }, 1500);
}

async function flushPanel(cid) {
  const b = board(cid);
  if (!b?.panelId) return;
  const now = b.queue.map((q) => q.userId);
  const before = lastQueue[cid] ?? now;
  lastQueue[cid] = now;
  // Positions changed unless the old queue is still the front of the new one (only joins at the back).
  const queueMoved = before.length > 0 && before.some((u, n) => now[n] !== u);
  // Bookings made, moved, cancelled or served also bring the panel down to the bottom.
  const bookSig = bookingsOf(b).map((x) => `${x.id}@${x.at}:${x.weapon}`).sort().join(',');
  const bookChanged = lastBookings[cid] !== undefined && lastBookings[cid] !== bookSig;
  lastBookings[cid] = bookSig;
  const moved = queueMoved || bookChanged;
  if (moved) {
    try {
      const channel = await chan(cid);
      // Ask Discord for the newest message (the bot doesn't receive chat, so a cached ID could be stale).
      const latest = await channel.messages.fetch({ limit: 1 });
      const lastId = latest?.first?.()?.id ?? channel?.lastMessageId;
      if (lastId && lastId !== b.panelId) return await repostPanel(cid, channel);
    } catch (err) {
      console.error(`Panel move failed in ${cid}:`, err.message);
    }
  }
  return renderPanel(cid);
}

async function renderPanel(cid) {
  const b = board(cid);
  if (!b?.panelId || !client.isReady?.()) return;
  try {
    const m = await (await chan(cid)).messages.fetch(b.panelId);
    await m.edit(panelPayload(b));
  } catch (err) {
    console.error(`Panel update failed in ${cid} (run /qadmin panel to re-post it):`, err.message);
  }
}

async function repostPanel(cid, channel) {
  const b = ensureBoard(cid);
  const old = b.panelId;
  const msg = await channel.send(panelPayload(b));
  b.panelId = msg.id;
  save();
  if (old) await deleteMsg(cid, old);
}

async function postPanel(i, cid) {
  await repostPanel(cid, i.channel);
  return i.reply(eph('💀 The Necromancer has risen. Panel posted. It updates itself. Pin it if you like. This channel now has its own queue.\n' +
    '-# Admins can press **🛠️ Admin** on the panel for buttons instead of commands.'));
}

// ---------- slash commands ----------
const weaponOpt = (o) => o.setName('weapon').setDescription('Weapon').setRequired(true).setAutocomplete(true);
const tornOpt = (o) => o.setName('torn_name').setDescription('Torn name (optional)').setMaxLength(32);
const userOpt = (o) => o.setName('user').setDescription('Member').setRequired(true);

const commands = [
  new SlashCommandBuilder().setName('queue').setDescription("This channel's Revitalize weapon queue")
    .addSubcommand((s) => s.setName('join').setDescription('Join the queue').addStringOption(tornOpt))
    .addSubcommand((s) => s.setName('leave').setDescription('Leave the queue, or end your slot early'))
    .addSubcommand((s) => s.setName('status').setDescription('Your place in the queue')),
  new SlashCommandBuilder().setName('qadmin').setDescription("Admin tools for this channel's queue")
    .addSubcommand((s) => s.setName('panel').setDescription('Post the queue panel here (creates this channel’s queue)'))
    .addSubcommand((s) => s.setName('add-weapon').setDescription("Add a weapon to this channel's pool")
      .addStringOption((o) => o.setName('name').setDescription('Weapon name, e.g. Scythe').setMaxLength(40))
      .addStringOption((o) => o.setName('bonus').setDescription('Bonus, e.g. Revitalize').setMaxLength(30))
      .addNumberOption((o) => o.setName('percent').setDescription('Bonus percent, e.g. 25').setMinValue(0).setMaxValue(1000))
      .addStringOption((o) => o.setName('uid').setDescription('Weapon UID (optional; with an API key, fills in the rest)').setMaxLength(15)))
    .addSubcommand((s) => s.setName('remove-weapon').setDescription("Remove a weapon from this channel's pool")
      .addStringOption(weaponOpt))
    .addSubcommand((s) => s.setName('add-user').setDescription('Add a member to the back of the queue')
      .addUserOption(userOpt).addStringOption(tornOpt))
    .addSubcommand((s) => s.setName('remove-user').setDescription('Remove a member from the queue or their weapon')
      .addUserOption(userOpt))
    .addSubcommand((s) => s.setName('skip').setDescription("End whoever is on a weapon's turn")
      .addStringOption(weaponOpt))
    .addSubcommand((s) => s.setName('move').setDescription('Move a member to a new place in the queue')
      .addUserOption(userOpt)
      .addIntegerOption((o) => o.setName('position').setDescription('New position (1 = front)').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('api-test').setDescription('Check the Torn API key and show the latest armoury log lines'))
    .addSubcommand((s) => s.setName('clear').setDescription('Empty the waiting queue (current holders keep their slots)'))
    .addSubcommand((s) => s.setName('delete-queue').setDescription("Delete this channel's queue, weapons and panel"))
    .addSubcommand((s) => s.setName('settings').setDescription("View or change this channel's timings (leave blank to view)")
      .addNumberOption((o) => o.setName('slot_minutes').setDescription('Slot length in minutes (default 10)')
        .setMinValue(LIMITS.slot[0]).setMaxValue(LIMITS.slot[1]))
      .addNumberOption((o) => o.setName('claim_minutes').setDescription('Time to press Claim, in minutes (default 2)')
        .setMinValue(LIMITS.claim[0]).setMaxValue(LIMITS.claim[1]))
      .addNumberOption((o) => o.setName('warn_minutes').setDescription('"Time almost up" ping, minutes before the end (0 = off)')
        .setMinValue(LIMITS.warn[0]).setMaxValue(LIMITS.warn[1]))
      .addIntegerOption((o) => o.setName('cleanup_seconds').setDescription('Delete finished turn messages after N seconds (0 = keep)')
        .setMinValue(LIMITS.cleanup[0]).setMaxValue(LIMITS.cleanup[1]))
      .addNumberOption((o) => o.setName('return_remind_minutes').setDescription('API only: remind if not returned this long after the slot (default 5)')
        .setMinValue(LIMITS.remind[0]).setMaxValue(LIMITS.remind[1]))
      .addBooleanOption((o) => o.setName('reset').setDescription('Reset this channel back to the defaults'))),
].map((c) => c.toJSON());

async function autocomplete(i) {
  const b = board(i.channelId);
  const q = keyOf(i.options.getFocused());
  await i.respond(b ? entries(b)
    .filter(([k]) => k.includes(q))
    .slice(0, 25)
    .map(([k, w]) => ({ name: wl(w).slice(0, 100), value: k })) : []);
}

async function command(i) {
  const cid = i.channelId;
  const sub = i.options.getSubcommand();

  if (i.commandName === 'queue') {
    if (sub === 'status') return i.reply(eph(myStatus(cid, i.user.id)));
    if (sub === 'join') { setName(i.user.id, i.options.getString('torn_name')); return joinQueue(i, cid, i.user.id); }
    if (sub === 'leave') return leaveQueue(i, cid);
  }

  if (i.commandName !== 'qadmin') return;
  if (!isAdmin(i)) return i.reply(eph(ADMIN_ONLY));
  const run = async (r) => {
    r = await r;
    await i.reply(eph(r.text));
    if (r.after) await r.after();
  };
  switch (sub) {
    case 'panel': return postPanel(i, cid);
    case 'api-test': return apiTest(i);
    case 'add-weapon': {
      const uid = i.options.getString('uid');
      if (uid && torn.enabled()) { // a lookup may take a moment
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await opAddWeapon(cid, i.options.getString('name'), i.options.getString('bonus'), i.options.getNumber('percent'), uid);
        await i.editReply(r.text);
        return r.after?.();
      }
      return run(opAddWeapon(cid, i.options.getString('name'), i.options.getString('bonus'), i.options.getNumber('percent'), uid));
    }
    case 'remove-weapon': return run(opRemoveWeapon(cid, keyOf(i.options.getString('weapon'))));
    case 'add-user': {
      const u = i.options.getUser('user');
      setName(u.id, i.options.getString('torn_name'));
      return run(enqueue(cid, u.id, true));
    }
    case 'remove-user': return run(opRemoveUser(cid, i.options.getUser('user').id));
    case 'skip': return run(opSkip(cid, keyOf(i.options.getString('weapon'))));
    case 'move': return run(opMove(cid, i.options.getUser('user').id, i.options.getInteger('position')));
    case 'clear': return run(opClear(cid));
    case 'delete-queue': return run(opDeleteQueue(cid));
    case 'settings': return settingsCmd(i, cid);
  }
}

// ---------- queue operations (shared by the admin panel and /qadmin) ----------
// Each returns { text, after? }: text is the private reply, after() is follow-up work run after replying.
// (Not called "then": an object with a then() method gets mistaken for a promise by `await`.)
const ADMIN_ONLY = 'Admins only. The crypt keepers have spoken.';

// Add a weapon. With a UID and an API key, missing name/bonus/% are filled in from Torn.
async function opAddWeapon(cid, name, bonus, percent, uid) {
  name = String(name || '').trim().slice(0, 40);
  bonus = String(bonus || '').trim().slice(0, 30);
  uid = String(uid || '').trim();
  let pctRaw = String(percent ?? '').replace('%', '').trim();
  if (uid && !/^\d{5,15}$/.test(uid)) return { text: 'A UID is a number, e.g. 9171132718.' };

  // Same weapon can only be in one queue at a time (checked before any API lookup).
  if (uid) {
    for (const [cidX, bx] of Object.entries(state.boards)) {
      const dup = Object.values(bx.weapons).find((w) => w.uid === uid);
      if (dup) return { text: `UID ${uid} is already registered as **${wl(dup)}**${cidX === cid ? ' in this channel' : ` in <#${cidX}>`}.` };
    }
  }
  let looked = '';
  if (uid && (!name || !bonus || pctRaw === '') && torn.enabled()) {
    try {
      const d = await torn.itemByUid(uid);
      if (!d) return { text: `Couldn't find UID ${uid} via the Torn API. Enter the name, bonus and % yourself.` };
      name ||= d.name.slice(0, 40);
      bonus ||= (d.bonus || '').slice(0, 30);
      if (pctRaw === '' && d.percent !== null) pctRaw = String(d.percent);
      looked = ` (details from the Torn API${d.rarity ? `, ${d.rarity}` : ''})`;
    } catch (err) {
      return { text: `Couldn't look up UID ${uid}: ${torn.explain(err).replace(/\.?$/, '.')} Enter the name, bonus and % yourself.` };
    }
  }
  const pct = Number(pctRaw);
  if (!name || !bonus || pctRaw === '') {
    return { text: uid && !torn.enabled()
      ? 'Without a Torn API key I can’t look UIDs up, so please also enter the name, bonus and %.'
      : 'Give the weapon a name, a bonus and a bonus %.' };
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 1000) return { text: 'The bonus % must be a number, e.g. 25.' };

  const b = ensureBoard(cid);
  const nw = { name, bonus, percent: Math.round(pct * 100) / 100, holder: null, ...(uid ? { uid } : {}) };
  const key = uid ? `uid:${uid}` : keyOf(wl(nw));
  if (b.weapons[key]) return { text: `**${wl(nw)}** is already in this channel's pool.` };
  b.weapons[key] = nw;
  save(cid);
  return {
    text: `➕ Added **${wl(nw)}**${uid ? ` · UID ${uid}` : ''} to this channel's pool${looked}.` +
      (b.panelId ? '' : ' Run `/qadmin panel` to post the panel here.'),
    after: () => advance(cid), // someone waiting gets it straight away
  };
}

function opRemoveWeapon(cid, key) {
  const b = board(cid);
  const w = b?.weapons[key];
  if (!w) return { text: 'Unknown weapon in this channel.' };
  clearTimers(cid, key);
  const h = w.holder;
  delete b.weapons[key];
  if (h && !isActive(h)) b.queue.unshift({ userId: h.userId, joinedAt: Date.now() }); // keep their place
  save(cid);
  return {
    text: `➖ Removed **${wl(w)}**.` +
      (isActive(h) ? ` ${who(h.userId)} may still have it on loan.` : h ? ` ${who(h.userId)} is back at the front of the queue.` : ''),
    after: async () => {
      if (h) {
        await editMsg(cid, h.msgId, `🚫 **${wl(w)}** was removed from the pool.`);
        trashLater(cid, [h.msgId, ...h.extra]);
      }
      await advance(cid);
    },
  };
}

function opRemoveUser(cid, userId) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  const hadBooking = bookingsOf(b).some((x) => x.userId === userId);
  b.bookings = bookingsOf(b).filter((x) => x.userId !== userId);
  if (hadBooking) save(cid);
  const held = heldBy(b, userId);
  if (held) return { text: `🚫 Removed <@${userId}> and ended their turn.`, after: () => endTurn(cid, held[0], 'removed') };
  const pos = queuePos(b, userId);
  if (pos === -1) return { text: `<@${userId}> isn't in this queue.` };
  b.queue.splice(pos, 1);
  save(cid);
  return { text: `🚫 Removed <@${userId}> from the queue.` };
}

function opSkip(cid, key) {
  const w = board(cid)?.weapons[key];
  if (!w) return { text: 'Unknown weapon in this channel.' };
  if (!w.holder) return { text: 'Nobody has that weapon right now.' };
  return { text: `⏭️ Skipped ${who(w.holder.userId)} on **${wl(w)}**.`, after: () => endTurn(cid, key, 'skipped') };
}

function opMove(cid, userId, position) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  const pos = queuePos(b, userId);
  if (pos === -1) {
    return { text: heldBy(b, userId) ? `<@${userId}> already has a weapon, so they're not in the waiting queue.`
      : `<@${userId}> isn't in this queue.` };
  }
  if (!Number.isFinite(position) || position < 1) return { text: 'The position must be a number, 1 or higher.' };
  const to = Math.min(Math.floor(position), b.queue.length);
  const [entry] = b.queue.splice(pos, 1);
  b.queue.splice(to - 1, 0, entry);
  save(cid);
  return { text: `↕️ Moved <@${userId}> from #${pos + 1} to #${to}.` };
}

function opClear(cid) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  const n = b.queue.length;
  b.queue = [];
  save(cid);
  return { text: `🧹 Swept ${n} soul(s) out of the queue.` };
}

function opDeleteQueue(cid) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  const msgs = [b.panelId];
  for (const [key, w] of entries(b)) {
    clearTimers(cid, key);
    if (w.holder) msgs.push(w.holder.msgId, ...w.holder.extra);
  }
  for (const a of b.awaiting || []) msgs.push(a.remindMsg);
  delete state.boards[cid];
  save();
  return {
    text: '🪦 This channel’s queue has been laid to rest.',
    after: async () => { for (const id of msgs.filter(Boolean)) await deleteMsg(cid, id); },
  };
}

// ---------- per-channel settings ----------
function describeSettings(b) {
  const c = cfg(b);
  const mark = (k) => (b.settings?.[k] !== undefined ? '' : ' *(default)*');
  return [
    `⏱️ Slot length: **${c.slot} min**${mark('slot')}`,
    `🙋 Time to claim: **${c.claim} min**${mark('claim')}`,
    `⏳ "Time almost up" ping: **${c.warn ? `${c.warn} min before the end` : 'off'}**${mark('warn')}`,
    `🧹 Clean up finished turns: **${c.cleanup ? `after ${c.cleanup} sec` : 'never'}**${mark('cleanup')}`,
    `👻 Return reminder: **${c.remind} min after the slot**${mark('remind')}` +
      (torn.enabled() ? '' : ' *(needs a Torn API key)*'),
    `📅 Booked slot length: **${c.book} min**${mark('book')}`,
    `🧊 Booking cooldown: **${c.bookcool ? `${c.bookcool} min after a booked slot` : 'off'}**${mark('bookcool')}`,
    `🎃 Weapons kept for the queue: **${c.bookkeep}**${mark('bookkeep')}`,
    `🗓️ Bookable from **${queueOn(b) ? `${c.bookmin} min` : 'the next 15-min start (bookings only)'}** to **${c.bookmax} h** ahead${mark('bookmin')}`,
  ].join('\n');
}

const SETTING_LABELS = {
  slot: 'Slot length (minutes)', claim: 'Time to claim (minutes)', warn: 'Warning (minutes)',
  cleanup: 'Clean-up delay (seconds)', remind: 'Return reminder (minutes)', book: 'Booking length (minutes)', bookcool: 'Booking cooldown (minutes)', bookkeep: 'Weapons kept for the queue',
  bookmin: 'Earliest booking (minutes ahead)', bookmax: 'Latest booking (hours ahead)',
};

// changes: { key: number } to set, { key: null } to go back to the default, undefined = leave alone.
function opSettings(cid, changes = {}, reset = false) {
  const b = board(cid);
  if (!b) return { text: NO_BOARD };
  b.settings ??= {};
  if (reset) {
    b.settings = {};
    save(cid);
    return { text: `🔄 This channel is back to the default timings.\n${describeSettings(b)}` };
  }
  const next = { ...b.settings };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) continue;
    if (v === null) { delete next[k]; continue; }
    if (!Number.isFinite(v)) return { text: `${SETTING_LABELS[k]} must be a number.` };
    const [lo, hi] = LIMITS[k];
    if (v < lo || v > hi) return { text: `${SETTING_LABELS[k]} must be between ${lo} and ${hi}.` };
    next[k] = k === 'cleanup' || k === 'bookkeep' ? Math.round(v) : Math.round(v * 100) / 100;
  }
  const c = { ...DEFAULTS, ...next };
  if (c.bookmin >= c.bookmax * 60) return { text: `The earliest booking (${c.bookmin} min) has to be sooner than the latest (${c.bookmax} h).` };
  if (c.warn >= c.slot || c.warn >= c.book) return { text: `The warning (${c.warn} min) has to be shorter than the slot and booking lengths.` };
  b.settings = next;
  save(cid);
  return { text: `⚙️ **Updated.** New turns use these timings. Anyone mid-turn keeps the time they were given.\n${describeSettings(b)}` };
}

async function settingsCmd(i, cid) {
  const b = board(cid);
  if (!b) return i.reply(eph(NO_BOARD));
  if (i.options.getBoolean('reset')) return i.reply(eph(opSettings(cid, {}, true).text));
  const opt = (v) => (v === null ? undefined : v);
  const changes = {
    slot: opt(i.options.getNumber('slot_minutes')),
    claim: opt(i.options.getNumber('claim_minutes')),
    warn: opt(i.options.getNumber('warn_minutes')),
    cleanup: opt(i.options.getInteger('cleanup_seconds')),
    remind: opt(i.options.getNumber('return_remind_minutes')),
  };
  if (Object.values(changes).every((v) => v === undefined)) {
    return i.reply(eph(`⚙️ **Settings for this channel**\n${describeSettings(b)}`));
  }
  return i.reply(eph(opSettings(cid, changes).text));
}

// ---------- buttons ----------
async function panelButton(i) {
  const cid = i.channelId;
  switch (i.customId) {
    case 'p_join': return joinQueue(i, cid, i.user.id);
    case 'p_leave': return leaveQueue(i, cid);
    case 'p_done': return finish(i, cid);
    case 'p_me': {
      const mine = board(cid) && bookingsOf(board(cid)).find((x) => x.userId === i.user.id);
      return i.reply({ ...eph(myStatus(cid, i.user.id)), ...(mine ? { components: [row(btn('b_move', 'Move booking', ButtonStyle.Primary, '🔁'), btn(`b_cancel|${mine.id}`, 'Cancel booking', ButtonStyle.Danger, '🗑️'))] } : {}) });
    }
    case 'p_book': return bookInteraction(i);
    case 'p_allbook': return i.reply({ ...allBookingsView(board(cid), 0), flags: MessageFlags.Ephemeral });
    case 'p_name': {
      const input = new TextInputBuilder()
        .setCustomId('torn_name')
        .setLabel('Your Torn name (leave blank to clear)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(32);
      if (state.names[i.user.id]) input.setValue(state.names[i.user.id]);
      return i.showModal(new ModalBuilder()
        .setCustomId('m_name')
        .setTitle('Set Torn name')
        .addComponents(new ActionRowBuilder().addComponents(input)));
    }
  }
}

// Buttons on turn messages: claim|key|userId, pass|key|userId, done|key|userId
// Every booking in the channel, grouped by weapon, split into pages that fit a Discord message.
function allBookingsView(b, page = 0) {
  if (!b) return { content: NO_BOARD, components: [] };
  const list = [...bookingsOf(b)].sort((x, y) => x.at - y.at);
  if (!list.length) return { content: '🗓️ **All bookings in this channel (0)**\nNo bookings yet. Every slot is free. 🕯️', components: [] };
  const groups = new Map();
  for (const bk of list) {
    const label = bookingLabel(b, bk);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(bk);
  }
  // Fill pages up to ~1700 characters; a weapon that runs onto the next page repeats its heading.
  const pages = [];
  let cur = '';
  let curGroup = null;
  for (const [label, bks] of groups) {
    for (const [k, bk] of bks.entries()) {
      const line = `${tct(bk.at)} · ${who(bk.userId)} · ${ts(bk.at)}`;
      const heading = k === 0 ? `**${label}** (${bks.length})` : `**${label}** (cont.)`;
      const add = (curGroup === label ? '' : `${cur ? '\n\n' : ''}${heading}\n`) + (curGroup === label ? `\n${line}` : line);
      if (cur && (cur + add).length > 1700) {
        pages.push(cur);
        cur = `**${label}** (${k === 0 ? bks.length : 'cont.'})\n${line}`;
      } else cur += add;
      curGroup = label;
    }
  }
  if (cur) pages.push(cur);
  const n = Math.min(Math.max(0, page), pages.length - 1);
  const head = `🗓️ **All bookings in this channel (${list.length})**${pages.length > 1 ? ` · page ${n + 1} of ${pages.length}` : ''}\n-# Times are TCT · only you can see this`;
  return {
    content: `${head}\n${pages[n]}`,
    components: pages.length > 1 ? [row(
      btn(`b_all|${n - 1}`, 'Previous', ButtonStyle.Secondary, '◀️').setDisabled(n === 0),
      btn(`b_all|${n + 1}`, 'Next', ButtonStyle.Secondary, '▶️').setDisabled(n >= pages.length - 1))] : [],
  };
}

async function bookInteraction(i) {
  const cid = i.channelId;
  const b = board(cid);
  const id = i.customId;
  const reply = (p) => (id === 'p_book' ? i.reply({ ...p, flags: MessageFlags.Ephemeral }) : i.update(p));
  if (!b) return reply({ content: NO_BOARD, components: [] });
  if (id.startsWith('b_all|')) return i.update(allBookingsView(b, Number(id.split('|')[1]) || 0));
  if (id.startsWith('b_cancel|')) {
    const bk = bookingsOf(b).find((x) => x.id === id.split('|')[1]);
    if (!bk) return reply({ content: 'That booking is already gone.', components: [] });
    if (bk.userId !== i.user.id && !isAdmin(i)) return i.reply(eph('That isn\'t your booking.'));
    b.bookings = bookingsOf(b).filter((x) => x !== bk);
    save(cid);
    await reply({ content: `🗑️ Booking for **${tct(bk.at)}** cancelled.`, components: [] });
    return advance(cid);
  }
  if (!isOpen(b)) return reply({ content: LOCKED, components: [] });
  if (!bookingsOn(b) || maxBookable(b) < 1) return reply({ content: 'Booking is switched off in this channel.', components: [] });
  if (b.faction && (await inTranche(b, i.user.id)) === false) {
    return reply({ content: `👻 This queue is for **${trancheName(b.faction)}** members only.`, components: [] });
  }
  const mine = bookingsOf(b).find((x) => x.userId === i.user.id);
  const moving = id === 'b_move' || id === 'b_wm' || id.startsWith('b_tm');
  const mineRow = (bk) => row(btn('b_move', 'Move booking', ButtonStyle.Primary, '🔁'), btn(`b_cancel|${bk.id}`, 'Cancel booking', ButtonStyle.Danger, '🗑️'));
  if (mine && !moving) {
    return reply({ content: `📅 Your booking: **${bookingLabel(b, mine)}** at **${tct(mine.at)}** (${ts(mine.at)}).\n-# One at a time. You can move it to another time or weapon, or cancel it.`,
      components: [mineRow(mine)] });
  }
  if (moving && !mine) return reply({ content: "You don't have a booking to move.", components: [] });
  const cool = coolUntil(b, i.user.id);
  const coolNote = cool > Date.now() ? `\n-# 🧊 Booking cooldown: your next booked slot can start from ${ts(cool)}.` : '';
  const head = `📅 **${moving ? 'Move your booking' : `Book a ${cfg(b).book}-min slot`}.** At your time you'll be tagged for the weapon, ahead of the queue.\n` +
    `-# ${hrs(aheadMin(b))} to ${hrs(aheadMax(b))} ahead · 1 booking at a time · times are Torn City Time (TCT) · ` +
    `loan it within ${cfg(b).claim} min or the booking is released` + coolNote;
  const wId = moving ? 'b_wm' : 'b_w';
  const tId = moving ? 'b_tm' : 'b_t';

  if (id === 'p_book' || id === 'b_move') {
    const groups = new Map();
    for (const [, w] of byBonus(entries(b))) if (!groups.has(groupKey(w))) groups.set(groupKey(w), groupOf(b, w));
    // Members must pick a specific weapon (no "any weapon" bookings).
    const opts = [
      ...[...groups].slice(0, 25).map(([gk, grp]) => ({
        label: `${groupLabel(grp)}${grp.length > 1 ? ` ×${grp.length}` : ''}`.slice(0, 100), value: `g:${gk}`.slice(0, 100),
        description: grp.length > 1 ? 'Either copy' : undefined,
      }))];
    const menu = new StringSelectMenuBuilder().setCustomId(wId).setPlaceholder('Pick a weapon')
      .addOptions(opts.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))));
    return reply({ content: `${head}\n\n**Which weapon?**`, components: [row(menu)] });
  }
  if (id === 'b_w' || id === 'b_wm') {
    const weapon = i.values[0];
    if (weapon === 'any') return reply({ content: 'Please pick a specific weapon. Press **Book a slot** again.', components: [] });
    const times = bookableTimes(b, weapon, i.user.id, mine?.id);
    if (!times.length) return reply({ content: `${head}\n\nNo free times for **${weapon === 'any' ? 'any weapon' : bookingLabel(b, { weapon })}** in the next ${hrs(aheadMax(b))}.`, components: [] });
    const left = (T) => maxBookable(b) - bookingsOf(b).filter((x) => x.id !== mine?.id && Math.abs(x.at - T) < cfg(b).book * MIN).length;
    const opt = (T) => {
      const mins = Math.round((T - Date.now()) / MIN);
      const inTxt = mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
      return { label: tct(T) + (mine && T === mine.at ? ' (current)' : ''), value: String(T), description: `${inTxt} · ${left(T)} bookable` };
    };
    // Discord allows 25 options per menu, so longer ranges are split into an earlier and a later menu.
    const chunks = [0, 25, 50, 75].map((n) => times.slice(n, n + 25)).filter((c) => c.length);
    const menus = chunks.map((c, n) => row(new StringSelectMenuBuilder().setCustomId(`${tId}${n ? n + 1 : ''}|${weapon}`.slice(0, 100))
      .setPlaceholder(chunks.length > 1 ? `Times ${tct(c[0])} – ${tct(c[c.length - 1])}` : 'Pick a start time')
      .addOptions(c.map(opt))));
    return reply({ content: `${head}\n\n**${weapon === 'any' ? 'Any weapon' : bookingLabel(b, { weapon })}**: pick a start time.`, components: menus });
  }
  if (/^b_tm?[2-4]?\|/.test(id)) {
    const weapon = id.slice(id.indexOf('|') + 1);
    const T = Number(i.values[0]);
    const okTime = T >= Date.now() + aheadMin(b) * MIN - 2 * MIN && T <= Date.now() + aheadMax(b) * MIN + MIN
      && T >= coolUntil(b, i.user.id) - 1000 && slotFree(b, T, weapon, mine?.id);
    if (!okTime) return reply({ content: '⌛ That time was just taken. Press **Book a slot** again.', components: [] });
    let bk;
    if (moving) {
      Object.assign(mine, { at: T, weapon, movedAt: Date.now() });
      bk = mine;
    } else {
      bk = { id: Math.random().toString(36).slice(2, 10), userId: i.user.id, at: T, weapon, createdAt: Date.now() };
      bookingsOf(b).push(bk);
    }
    save(cid);
    autoLink(i.user.id);
    await reply({ content: `✅ ${moving ? 'Moved to' : 'Booked'} **${bookingLabel(b, bk)}** at **${tct(T)}** (${ts(T)}). I'll tag you then. ` +
      `Loan it within ${cfg(b).claim} min or the booking is released.`,
      components: [mineRow(bk)] });
    return advance(cid); // a moved booking may free up a held weapon
  }
}

async function turnButton(i) {
  const cid = i.channelId;
  const parts = i.customId.split('|');
  const action = parts[0];
  const userId = parts.at(-1);
  const key = parts.slice(1, -1).join('|');
  const h = board(cid)?.weapons[key]?.holder;

  const stale = !h || h.userId !== userId
    || ((action === 'claim' || action === 'pass') && isActive(h))
    || (action === 'done' && !isActive(h));
  if (stale) return i.update({ components: [] });

  const isOwner = i.user.id === h.userId;
  if (action === 'claim') {
    if (!isOwner) return i.reply(eph(`Only <@${h.userId}> can claim this. Nice try, goblin. 👺`));
    return claim(i, cid);
  }
  if (action === 'pass') {
    if (!isOwner && !isAdmin(i)) return i.reply(eph(`Only <@${h.userId}> or an admin can do that.`));
    await ack(i, 'Passed.');
    return endTurn(cid, key, 'passed');
  }
  if (action === 'done') {
    if (isOwner) return finish(i, cid);
    if (!isAdmin(i)) return i.reply(eph('Only the current holder or an admin can do that.'));
    await ack(i, 'Ended their slot.');
    return endTurn(cid, key, 'early');
  }
}

async function modal(i) {
  if (i.customId !== 'm_name') return;
  const name = i.fields.getTextInputValue('torn_name')?.trim();
  if (name) setName(i.user.id, name);
  else delete state.names[i.user.id];
  save();
  // Names show on every panel, so refresh any panel this member appears on.
  for (const cid of Object.keys(state.boards)) queuePanelUpdate(cid);
  const link = state.links[i.user.id];
  return i.reply(eph((name ? `Torn name set to **${state.names[i.user.id]}**. 🧛` : 'Torn name cleared.') +
    (link ? `\n-# You're also linked to **${link.name}** via the Torn API. That's the name used to check the armoury log.` : '')));
}

// ---------- Torn API: armoury log checks ----------
// Every API_POLL_SECONDS, while someone has a weapon or owes a return, read the
// faction armoury log and:
//   • mark a holder's loan as confirmed when "<name> loaned 1x <weapon>" appears
//   • end a holder's turn early when they return it
//   • clear "not returned yet" entries when the return appears
//   • remind people who still haven't returned it after the channel's remind time
// Re-reading old lines is harmless: every check is tied to times, so nothing is double-counted.
let polling = false;
let backoffUntil = 0;

const backoff = new Map(); // key source -> time to try again
const KEY_DEAD = [2, 10, 13, 16, 18]; // wrong key, owner jailed/inactive, too little access, paused

async function pollArmoury() {
  if (polling) return;
  // Group the channels by which key reads their armoury log.
  const groups = new Map(); // source -> { cids: Set, starts: [] }
  for (const [cid, b] of Object.entries(state.boards)) {
    const src = sourceOf(b);
    if (src === null || Date.now() < (backoff.get(src) || 0)) continue;
    const starts = [];
    // Active slots (loan/return checks) and turns waiting to be claimed (auto-claim on loan).
    for (const [, w] of entries(b)) if (w.holder) starts.push(w.holder.calledAt || w.holder.startedAt || Date.now());
    for (const a of b.awaiting || []) starts.push(a.loanAt);
    if (!starts.length) continue;
    const g = groups.get(src) || { cids: new Set(), starts: [] };
    g.cids.add(cid); g.starts.push(...starts); groups.set(src, g);
  }
  if (!groups.size) return;
  polling = true;
  try {
    for (const [src, g] of groups) {
      const from = (Math.min(...g.starts) - 5 * MIN) / 1000;
      try {
        let news;
        if (src === 'owner') {
          news = await torn.armouryNews(from);
          state.api.lastOkAt = Date.now();
          state.api.lastError = null;
        } else {
          const key = keyOf_(src);
          if (!key) { tranche(src).status = 'bad'; tranche(src).err = 'The saved key could not be unlocked (KEY_SECRET changed?). Add it again.'; continue; }
          news = await torn.armouryNewsFor(key, from);
          Object.assign(tranche(src), { status: 'ok', err: null, checkedAt: Date.now() });
        }
        const changed = new Set();
        for (const n of news) {
          const ev = torn.parseArmoury(n.text);
          if (ev) await applyArmouryEvent(ev, n.timestamp * 1000, changed, n.id, g.cids);
        }
        save();
        for (const cid of changed) queuePanelUpdate(cid);
      } catch (err) {
        const msg = src === 'owner' ? torn.explain(err) : keyErr(err);
        console.error(`Armoury log check failed (${src === 'owner' ? 'owner key' : trancheName(src)}):`, msg);
        if (src === 'owner') state.api.lastError = { msg, at: Date.now() };
        else if (KEY_DEAD.includes(err.code)) {
          Object.assign(tranche(src), { status: 'bad', err: msg, checkedAt: Date.now() });
          for (const cid of g.cids) queuePanelUpdate(cid);
        }
        if ([0, 2, 7, 8, 10, 13, 16, 18].includes(err.code)) backoff.set(src, Date.now() + 10 * MIN);
        else if (err.code === 5) backoff.set(src, Date.now() + 2 * MIN);
        save();
      }
    }
  } finally {
    polling = false;
  }
  await remindOverdue();
}

// Discord user for a Torn name, if the bot knows it (linked or set on the panel).
function discordIdForTornName(name) {
  for (const [uid, l] of Object.entries(state.links)) if (torn.sameName(l.name, name)) return uid;
  for (const [uid, n] of Object.entries(state.names)) if (torn.sameName(n, name)) return uid;
  return null;
}

// A loan of a weapon that's currently someone else's turn → a public, spooky call-out in that channel.
async function shameOutOfTurn(ev, at, newsId, cids) {
  if (ev.type !== 'loan') return;
  for (const [cid, b] of Object.entries(state.boards)) {
    if (cids && !cids.has(cid)) continue; // a different faction's armoury
    const same = entries(b).filter(([, w]) => torn.sameItem(ev.item, w.name));
    const held = same.filter(([, w]) => w.holder);
    if (!held.length) continue; // nobody's turn on that weapon here
    if (held.length < same.length) continue; // a copy of that type was free, so nobody's turn was taken
    // Fine if the loaner IS one of the people whose turn it is on a weapon with that name.
    if (held.some(([, w]) => torn.sameName(ev.person, tornName(w.holder.userId)))) continue;
    // If we can't be sure (a holder's Torn name is unknown and the loaner isn't someone we know), don't shame.
    const loanerUid = discordIdForTornName(ev.person);
    if (loanerUid && held.some(([, w]) => w.holder.userId === loanerUid)) continue;
    if (!loanerUid && held.some(([, w]) => !tornName(w.holder.userId))) continue;
    // Only loans made after that turn began (an older loan isn't jumping this queue).
    const since = Math.min(...held.map(([, w]) => w.holder.calledAt || w.holder.startedAt || Date.now()));
    if (at < since) continue;
    const key = `${cid}|${newsId || `${at}|${ev.person}|${ev.item}`}`;
    if (state.shamed.includes(key)) continue;
    state.shamed.push(key);
    state.shamed = state.shamed.slice(-500);
    save();
    const uid = discordIdForTornName(ev.person);
    const whoTxt = uid ? `<@${uid}> (${ev.person})` : `**${ev.person}**`;
    const [, w] = held[0];
    const text = pick(SPOOK.shame)
      .replaceAll('{who}', whoTxt)
      .replaceAll('{item}', gl(b, w))
      .replaceAll('{holder}', who(w.holder.userId)) +
      '\nReturn it to the armoury and join the queue like everyone else. 🎃';
    await send(cid, text);
  }
}

async function applyArmouryEvent(ev, at, changed, newsId, cids) {
  await shameOutOfTurn(ev, at, newsId, cids);
  for (const [cid, b] of Object.entries(state.boards)) {
    if (cids && !cids.has(cid)) continue; // only channels whose armoury this log belongs to
    for (const [key, w] of entries(b)) {
      const h = w.holder;
      if (!h || !torn.sameItem(ev.item, w.name) || !torn.sameName(ev.person, tornName(h.userId))) continue;
      // Up but not claimed yet, and the armoury shows they loaned it: claim for them.
      if (!isActive(h)) {
        if (ev.type === 'loan' && at >= (h.calledAt || Date.now()) - MIN) {
          h.loanAt = at;
          h.autoClaimed = true;
          changed.add(cid);
          await startSlot(cid, key); // starts the slot and edits the tag message
        }
        continue;
      }
      if (ev.type === 'loan' && !h.loanAt && at >= (h.calledAt || h.startedAt) - MIN) {
        h.loanAt = at;
        changed.add(cid);
        await editMsg(cid, h.msgId, slotText(w, h, b), slotRow(key, h.userId));
      } else if (ev.type === 'return' && h.loanAt && at > h.loanAt) {
        changed.add(cid);
        await endTurn(cid, key, 'returned');
      }
    }
    if (ev.type !== 'return' || !b.awaiting?.length) continue;
    const hit = b.awaiting.find((a) => at > a.loanAt && torn.sameItem(ev.item, a.weapon) && torn.sameName(ev.person, a.tornName));
    if (hit) {
      b.awaiting = b.awaiting.filter((a) => a !== hit);
      if (hit.remindMsg) trashLater(cid, [hit.remindMsg]);
      changed.add(cid);
    }
  }
}

async function remindOverdue() {
  const now = Date.now();
  for (const [cid, b] of Object.entries(state.boards)) {
    if (!b.awaiting?.length) continue;
    const before = b.awaiting.length;
    b.awaiting = b.awaiting.filter((a) => now - a.endedAt < 12 * 60 * MIN); // give up after 12 h
    for (const a of b.awaiting) {
      if (a.remindMsg || now - a.endedAt < cfg(b).remind * MIN) continue;
      a.remindMsg = 'pending';
      const m = await send(cid,
        `👻 ${who(a.userId)}, the armoury log still hasn't seen **${a.label}** come back. ` +
        `Please return it to the faction armoury. ${pick(SPOOK.overdue)}`);
      a.remindMsg = m?.id || null;
    }
    if (b.awaiting.length !== before) queuePanelUpdate(cid);
    save();
  }
}

// API test: key status and how the latest armoury lines were read (admin only).
async function apiTestText() {
  if (!torn.enabled()) return '🔑 No Torn API key set. Add `TORN_API_KEY` to `.env` and restart the bot.';
  try {
    const news = await torn.armouryNews((Date.now() - 7 * 24 * 60 * MIN) / 1000);
    state.api.lastOkAt = Date.now();
    state.api.lastError = null;
    save();
    const lines = news.slice(-8).map((n) => {
      const ev = torn.parseArmoury(n.text);
      const read = ev ? `→ ${ev.type} · ${ev.person} · ${ev.item}` : '→ ❓ not recognised';
      return `${ts(n.timestamp * 1000)} ${n.text.slice(0, 120)}\n-# ${read}`;
    });
    return (`✅ **Torn API key works.** Armoury log lines in the last 7 days: ${news.length}. ` +
      `Members linked automatically: ${Object.keys(state.links).length}.\n\n` +
      (lines.length ? `**Latest armoury log lines and how the bot read them:**\n${lines.join('\n')}`
        : 'No armoury log lines in the last 7 days.')).slice(0, 1900);
  } catch (err) {
    state.api.lastError = { msg: torn.explain(err), at: Date.now() };
    save();
    return `❌ ${torn.explain(err)}`;
  }
}

async function apiTest(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  return i.editReply(await apiTestText());
}

// ---------- admin panel (🛠️ Admin button → private controls) ----------
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const backRow = () => row(btn('a_back', 'Back', ButtonStyle.Secondary, '↩️'));

function adminHeader(b, guild) {
  const c = cfg(b);
  const found = adminRolesHere(guild);
  const inUse = entries(b).filter(([, w]) => w.holder).length;
  return `🛠️ **Admin controls for this channel**\n-# Only you can see this. Weapons: ${entries(b).length} (${inUse} in use) · ` +
    `Queue: ${b.queue.length} · ${c.slot}-min slots · ${c.claim} min to claim · ${queueOn(b) ? '' : '📅 bookings only · '}${b.faction ? `🏷️ ${trancheName(b.faction)} ` : ''}${boardWatched(b) ? '🔑 loans auto-checked' : '🔑 no armoury key'}` +
    `\n-# 🛡️ Admin roles here: ${found.length ? found.join(', ') : 'none (only Manage Server and whitelisted users)'}`;
}

function adminMenu(b) {
  const noWeapons = !entries(b).length;
  const noneHeld = !entries(b).some(([, w]) => w.holder);
  const emptyQueue = !b.queue.length;
  return [
    row(btn('a_addw', 'Add weapon', ButtonStyle.Success, '➕'),
      btn('a_rmw', 'Remove weapon', ButtonStyle.Secondary, '➖').setDisabled(noWeapons),
      btn('a_skip', 'Skip a turn', ButtonStyle.Secondary, '⏭️').setDisabled(noneHeld)),
    row(btn('a_addu', 'Add member', ButtonStyle.Secondary, '👤'),
      btn('a_rmu', 'Remove member', ButtonStyle.Secondary, '🚫').setDisabled(emptyQueue && noneHeld),
      btn('a_move', 'Move member', ButtonStyle.Secondary, '↕️').setDisabled(emptyQueue)),
    row(btn('a_settings', 'Queue settings', ButtonStyle.Primary, '⚙️'),
      btn('a_keys', 'API keys', ButtonStyle.Secondary, '🔑'),
      btn('a_book', 'Bookings & settings', ButtonStyle.Primary, '📅'),
      btn('a_repost', 'Re-post panel', ButtonStyle.Secondary, '📌')),
    row(btn('a_clear', 'Clear queue', ButtonStyle.Danger, '🧹').setDisabled(emptyQueue),
      btn('a_delete', 'Delete queue', ButtonStyle.Danger, '🪦')),
  ];
}

// The server a board's channel lives in (for listing that server's admin roles).
const guildOfBoard = (b) => {
  const cid = Object.keys(state.boards).find((k) => state.boards[k] === b);
  return (cid && client.channels?.cache?.get?.(cid)?.guild) || client.guilds?.cache?.get?.(GUILD_ID);
};
const adminView = (b, note, guild = guildOfBoard(b)) =>
  ({ content: (note ? `${note}\n\n` : '') + adminHeader(b, guild), components: adminMenu(b) });

// ---------- 🔑 tranche API keys ----------
const KEY_TERMS =
  '-# 🔒 Keys are pasted into a private pop-up, encrypted before saving, and never shown to anyone (including the bot owner). ' +
  'There is no way to view a key, only replace or remove it.\n' +
  '-# 📜 **Terms**: Data storage: only locally (linked Torn names, loan/return times) · Data sharing: faction (loan status on the panel) · ' +
  'Purpose: public community tool (confirm armoury loans/returns) · Key storage: stored encrypted, used only for automation · ' +
  'Access: Custom, faction > armorynews. [Torn API terms](https://www.torn.com/api.html)';

function keysView(b, note) {
  const lines = TRANCHES.map((fid) => {
    const t = state.tranches[fid] || {};
    if (!t.enc) return `❌ **${trancheName(fid)}**: no key`;
    if (t.status === 'bad') return `⚠️ **${trancheName(fid)}**: key stopped working (${t.err || 'rejected by Torn'})`;
    return `✅ **${trancheName(fid)}**: added by <@${t.addedBy}> ${ts(t.addedAt)}`;
  });
  const content = (note ? `${note}\n\n` : '') +
    `🔑 **Tranche API keys**\n${lines.join('\n')}\n\n` +
    `This channel uses: **${b.faction ? trancheName(b.faction) : 'not set'}**` +
    (b.faction ? '' : REQUIRE_TRANCHE ? ' (queue locked until set)' : '') + '\n' +
    "-# How to add one: press **Create key in Torn**, create it, copy it, then **Add / replace key**.\n" + KEY_TERMS;
  const anyKey = TRANCHES.some(hasKey);
  return {
    content: content.slice(0, 1990),
    components: [
      row(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(KEY_LINK).setLabel('Create key in Torn').setEmoji('🆕'),
        btn('a_kadd', 'Add / replace key', ButtonStyle.Success, '➕'),
        btn('a_krm', 'Remove key', ButtonStyle.Danger, '🗑️').setDisabled(!anyKey)),
      row(btn('a_kchan', "Set this channel's tranche", ButtonStyle.Primary, '🏷️'), btn('a_back', 'Back', ButtonStyle.Secondary, '↩️')),
    ],
  };
}

const trancheSelect = (id, list, extra = []) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a tranche')
  .addOptions([...list.map((fid) => ({
    label: trancheName(fid).slice(0, 100), value: String(fid),
    description: (hasKey(fid) ? (state.tranches[fid].status === 'bad' ? 'Key stopped working' : 'Key added') : 'No key yet') + ` · ID ${fid}`,
  })), ...extra]);

// Key problems explained for leaders (not the bot owner's .env).
const keyErr = (err) => ({
  2: 'The key is wrong, or was deleted in Torn.',
  7: "The key's owner doesn't have faction API access.",
  10: 'The key owner is in federal jail.',
  13: "The key is disabled because its owner has been inactive.",
  16: "The key doesn't include faction > armorynews.",
  18: 'The key has been paused by its owner.',
}[err?.code] || torn.explain(err));

// Test a pasted key, check it belongs to the right faction, then save it encrypted.
async function saveTrancheKey(fid, key, userId) {
  if (!/^[A-Za-z0-9]{16}$/.test(key)) return '❌ That doesn\'t look like a Torn API key (16 letters and numbers). Nothing was saved.';
  try {
    await torn.armouryNewsFor(key, Date.now() / 1000 - 24 * 3600);
  } catch (err) {
    return `❌ Torn rejected that key: ${keyErr(err)} Nothing was saved.`;
  }
  const owner = await torn.keyFaction(key);
  if (owner && owner !== fid) {
    return `❌ That key belongs to **${TRANCHES.includes(owner) ? trancheName(owner) : `faction ${owner}`}**, not **${trancheName(fid)}**. Nothing was saved.`;
  }
  Object.assign(tranche(fid), { enc: keys.encrypt(key), addedBy: userId, addedAt: Date.now(), status: 'ok', err: null, checkedAt: Date.now() });
  backoff.delete(fid);
  save();
  for (const [cid, bb] of Object.entries(state.boards)) if (bb.faction === fid) queuePanelUpdate(cid);
  return `✅ Key saved for **${trancheName(fid)}**.` + (owner ? '' : " (I couldn't confirm which faction it belongs to, so make sure it's the right one.)");
}

function bookAdminView(b, note) {
  const c = cfg(b);
  const upcoming = [...bookingsOf(b)].sort((x, y) => x.at - y.at);
  const onOff = (v) => (v ? '🟢 On' : '🔴 Off');
  const content = (note ? `${note}\n\n` : '') +
    `📅 **Bookings & settings for this channel**\n\n` +
    `**Status**\n` +
    `• Bookings: **${onOff(bookingsOn(b))}**\n` +
    `• Walk-up queue: **${queueOn(b) ? '🟢 On' : '🔴 Off (bookings only)'}**\n\n` +
    `**Booking settings** · change with ⏱️ *Edit booking settings*\n` +
    `• Booked slot length: **${c.book} min**\n` +
    `• Cooldown between a member's bookings: **${c.bookcool ? `${c.bookcool} min` : 'off'}**\n` +
    `• Earliest booking: **${queueOn(b) ? `${hrs(c.bookmin)} from now` : 'next 15-min start (bookings only)'}**\n` +
    `• Latest booking: **${hrs(aheadMax(b))} from now**\n` +
    `• Weapons kept for the queue: **${queueOn(b) ? c.bookkeep : 'n/a (bookings only)'}** · ${maxBookable(b)} of ${entries(b).length} weapon(s) bookable at once\n` +
    `• 1 booking per member · start times every 15 min (TCT)\n\n` +
    `**Upcoming bookings (${upcoming.length})**\n` +
    (upcoming.length ? upcoming.slice(0, 10).map((x) => `• ${tct(x.at)} · <@${x.userId}> · ${bookingLabel(b, x)}`).join('\n') +
      (upcoming.length > 10 ? `\n-# …and ${upcoming.length - 10} more` : '') : '-# None yet.');
  return {
    content: content.slice(0, 1990),
    components: [
      row(
        btn('a_book_toggle', bookingsOn(b) ? 'Turn bookings off' : 'Turn bookings on', bookingsOn(b) ? ButtonStyle.Danger : ButtonStyle.Success, '📅'),
        btn('a_queue_toggle', queueOn(b) ? 'Turn queue off (bookings only)' : 'Turn queue back on', queueOn(b) ? ButtonStyle.Secondary : ButtonStyle.Success, '🎃')),
      row(
        btn('a_book_len', 'Edit booking settings', ButtonStyle.Primary, '⏱️'),
        btn('p_allbook', 'View all bookings', ButtonStyle.Secondary, '🗓️'),
        btn('a_back', 'Back', ButtonStyle.Secondary, '↩️')),
    ],
  };
}

// A picker screen: one select menu plus a Back button.
const pickView = (prompt, menu) => ({ content: prompt, components: [row(menu), backRow()] });

function weaponSelect(id, list, showHolder = false) {
  return new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a weapon')
    .addOptions(list.slice(0, 25).map(([k, w]) => ({
      label: wl(w).slice(0, 100),
      value: k,
      ...(showHolder && w.holder ? { description: `Held by ${tornName(w.holder.userId) || 'a member'}`.slice(0, 100) }
        : w.uid ? { description: `UID ${w.uid}` } : {}),
    })));
}

// Display name for a member in pickers: Torn name, else their server nickname, else their ID.
async function memberLabel(guild, userId) {
  if (tornName(userId)) return tornName(userId);
  try { const m = await guild?.members?.fetch?.(userId); return m?.displayName || m?.user?.username || userId; } catch { return userId; }
}

// Picker of the people actually in this channel's queue (and, optionally, those holding a weapon).
// Names are looked up in parallel with a short time limit, since Discord needs an answer within 3 s.
async function queueSelect(id, b, guild, withHolders = false) {
  const rows = [];
  if (withHolders) {
    for (const [, w] of entries(b)) if (w.holder) rows.push({ userId: w.holder.userId, desc: `${isActive(w.holder) ? 'Using' : 'Up for'} ${wl(w)}` });
  }
  b.queue.forEach((q, n) => rows.push({ userId: q.userId, pos: n + 1, desc: 'Waiting in the queue' }));
  const list = rows.slice(0, 25);
  const quick = (uid) => Promise.race([memberLabel(guild, uid), new Promise((r) => setTimeout(() => r(tornName(uid) || `Member ${uid}`), 1500))]);
  const names = await Promise.all(list.map((r) => quick(r.userId)));
  return new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a member')
    .addOptions(list.map((r, n) => ({ label: `${r.pos ? `#${r.pos} ` : ''}${names[n]}`.slice(0, 100), value: r.userId, description: r.desc.slice(0, 100) })));
}

// Can this member see the queue's channel? true / false / null (couldn't check).
async function canSeeChannel(i, userId) {
  try {
    const m = await i.guild?.members?.fetch?.(userId);
    if (!m) return null;
    return !!i.channel?.permissionsFor?.(m)?.has?.(PermissionFlagsBits.ViewChannel);
  } catch { return null; }
}

const userSelect = (id) => new UserSelectMenuBuilder().setCustomId(id).setPlaceholder('Pick a member').setMaxValues(1);

function textInput(id, label, { placeholder, value, required = true, max = 40 } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45))
    .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  if (value !== undefined && value !== null && value !== '') t.setValue(String(value));
  return t;
}

const modalOf = (id, title, inputs) => new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45))
  .addComponents(...inputs.map((t) => row(t)));

function settingsModal(b) {
  const s = b.settings || {};
  const field = (k, label) => textInput(k, label, { required: false, max: 6, value: s[k], placeholder: `Blank = default (${DEFAULTS[k]})` });
  return modalOf('m_settings', 'Channel settings (blank = default)', [
    field('slot', 'Slot length (minutes)'),
    field('claim', 'Time to claim (minutes)'),
    field('warn', '"Time almost up" ping (minutes, 0 = off)'),
    field('cleanup', 'Delete finished turns after (seconds)'),
    field('remind', 'Return reminder (minutes, API only)'),
  ]);
}

// Show the result of an operation on the admin panel, then run any follow-up work.
async function adminDone(i, cid, r) {
  const b = board(cid);
  const payload = b ? adminView(b, r.text) : { content: r.text, components: [] };
  if (i.isModalSubmit() && !i.isFromMessage?.()) await i.reply({ ...payload, flags: MessageFlags.Ephemeral });
  else await i.update(payload);
  if (r.after) await r.after();
}

async function adminInteraction(i) {
  const cid = i.channelId;
  const b = board(cid);
  if (!isAdmin(i)) return i.reply(eph(ADMIN_ONLY));
  if (!b) return i.isButton() && i.customId === 'p_admin' ? i.reply(eph(NO_BOARD)) : i.update({ content: NO_BOARD, components: [] });
  const id = i.customId;
  const f = (k) => i.fields.getTextInputValue(k) ?? '';

  switch (id) {
    case 'p_admin': return i.reply({ ...adminView(b), flags: MessageFlags.Ephemeral });
    case 'a_back': return i.update(adminView(b));

    case 'a_addw':
      return i.showModal(modalOf('m_addw', 'Add a weapon', [
        textInput('uid', torn.enabled() ? 'UID (optional, fills in the rest)' : 'UID (optional)',
          { placeholder: 'e.g. 9171132718', max: 15, required: false }),
        textInput('name', 'Weapon name', { placeholder: torn.enabled() ? 'e.g. Scythe (blank = from UID)' : 'e.g. Scythe', max: 40, required: false }),
        textInput('bonus', 'Bonus', { value: torn.enabled() ? '' : 'Revitalize', placeholder: 'e.g. Revitalize', max: 30, required: false }),
        textInput('percent', 'Bonus %', { placeholder: 'e.g. 25', max: 8, required: false }),
      ]));
    case 'm_addw': {
      const needsLookup = f('uid').trim() && torn.enabled();
      if (needsLookup) await i.deferUpdate(); // the Torn lookup may take a moment
      const r = await opAddWeapon(cid, f('name'), f('bonus'), f('percent'), f('uid'));
      if (!needsLookup) return adminDone(i, cid, r);
      const bb = board(cid);
      await i.editReply(bb ? adminView(bb, r.text) : { content: r.text, components: [] });
      return r.after?.();
    }

    case 'a_rmw':
      if (!entries(b).length) return i.update(adminView(b, 'There are no weapons to remove.'));
      return i.update(pickView('➖ Which weapon should be removed from this channel?', weaponSelect('a_rmw_pick', entries(b))));
    case 'a_rmw_pick': return adminDone(i, cid, opRemoveWeapon(cid, i.values[0]));

    case 'a_skip': {
      const held = entries(b).filter(([, w]) => w.holder);
      if (!held.length) return i.update(adminView(b, 'Nobody has a weapon right now.'));
      return i.update(pickView("⏭️ Whose turn should be skipped? They'll be told to return the weapon.", weaponSelect('a_skip_pick', held, true)));
    }
    case 'a_skip_pick': return adminDone(i, cid, opSkip(cid, i.values[0]));

    case 'a_addu': return i.update(pickView('👤 Who should be added to the back of the queue?', userSelect('a_addu_pick')));
    case 'a_addu_pick': {
      if ((await canSeeChannel(i, i.values[0])) === false) {
        return i.update(adminView(b, `<@${i.values[0]}> can't see this channel, so they weren't added.`));
      }
      if (b.faction && (await inTranche(b, i.values[0])) === false) {
        return i.update(adminView(b, `<@${i.values[0]}> isn't in **${trancheName(b.faction)}**, so they weren't added.`));
      }
      return adminDone(i, cid, enqueue(cid, i.values[0], true));
    }

    case 'a_rmu':
      if (!b.queue.length && !entries(b).some(([, w]) => w.holder)) return i.update(adminView(b, 'Nobody is in this queue.'));
      return i.update(pickView('🚫 Who should be removed? (If they have a weapon, their turn ends.)', await queueSelect('a_rmu_pick', b, i.guild, true)));
    case 'a_rmu_pick': return adminDone(i, cid, opRemoveUser(cid, i.values[0]));

    case 'a_move':
      if (!b.queue.length) return i.update(adminView(b, 'Nobody is waiting in the queue.'));
      return i.update(pickView('↕️ Who should be moved?', await queueSelect('a_move_pick', b, i.guild)));
    case 'a_move_pick': {
      const uid = i.values[0];
      const pos = queuePos(b, uid);
      if (pos === -1) return adminDone(i, cid, opMove(cid, uid, 1)); // explains why they can't be moved
      return i.showModal(modalOf(`m_move|${uid}`, 'Move member', [
        textInput('position', `New position (now #${pos + 1} of ${b.queue.length})`, { placeholder: '1 = front', max: 4 }),
      ]));
    }

    case 'a_settings': return i.showModal(settingsModal(b));
    case 'm_settings': {
      const val = (k) => { const v = f(k).trim(); return v === '' ? null : Number(v); };
      return adminDone(i, cid, opSettings(cid, {
        slot: val('slot'), claim: val('claim'), warn: val('warn'), cleanup: val('cleanup'), remind: val('remind'),
      }));
    }

    case 'a_api': // old panels
    case 'a_keys': {
      await i.deferUpdate();
      await refreshTrancheNames();
      return i.editReply(keysView(b));
    }
    case 'a_kadd':
      if (!keys.ready()) return i.update(keysView(b, "⚠️ The bot owner needs to set **KEY_SECRET** in Railway before keys can be saved."));
      return i.update(pickView(`➕ Which tranche is this key for?\n${KEY_TERMS}`, trancheSelect('a_kadd_pick', TRANCHES)));
    case 'a_kadd_pick': {
      const fid = Number(i.values[0]);
      return i.showModal(modalOf(`m_key|${fid}`, `API key: ${trancheName(fid)}`, [
        textInput('key', 'Faction API key (armorynews only)', { placeholder: '16 letters and numbers', max: 16 }),
      ]));
    }
    case 'a_krm': {
      const withKey = TRANCHES.filter(hasKey);
      if (!withKey.length) return i.update(keysView(b, 'No keys to remove.'));
      return i.update(pickView('🗑️ Remove which tranche\'s key? Its channels stop auto-checking loans until a new key is added.', trancheSelect('a_krm_pick', withKey)));
    }
    case 'a_krm_pick': {
      const fid = Number(i.values[0]);
      const t = tranche(fid);
      delete t.enc; delete t.addedBy; delete t.addedAt; t.status = null; t.err = null;
      save();
      for (const [ccid, bb] of Object.entries(state.boards)) if (bb.faction === fid) queuePanelUpdate(ccid);
      return i.update(keysView(b, `🗑️ Key removed for **${trancheName(fid)}**.`));
    }
    case 'a_kchan':
      return i.update(pickView("🏷️ Which tranche is this channel's queue for? Its armoury log is checked, and only its members can join.",
        trancheSelect('a_kchan_pick', TRANCHES, [{ label: 'None (lock this queue)', value: '0', description: 'Nobody can join until a tranche is picked' }])));
    case 'a_kchan_pick': {
      const fid = Number(i.values[0]);
      if (fid) b.faction = fid; else delete b.faction;
      save(cid);
      queuePanelUpdate(cid);
      advance(cid);
      return i.update(keysView(b, fid ? `🏷️ This channel is now for **${trancheName(fid)}**.` : '🏷️ This channel is no longer linked to a tranche.'));
    }

    case 'a_book': return i.update(bookAdminView(b));
    case 'a_queue_toggle': {
      if (queueOn(b)) {
        if (!bookingsOn(b)) return i.update(bookAdminView(b, '⚠️ Turn bookings on first, or nobody could get a weapon in this channel.'));
        const n = b.queue.length;
        b.queueOff = true;
        b.queue = [];
        save(cid);
        return i.update(bookAdminView(b, `🎃 Walk-up queue switched **off**. This channel is now **bookings only**${n ? ` (${n} waiting member${n === 1 ? '' : 's'} removed from the queue)` : ''}. Anyone mid-turn keeps their turn.`));
      }
      delete b.queueOff;
      save(cid);
      await i.update(bookAdminView(b, '🎃 Walk-up queue switched back **on**.'));
      return advance(cid);
    }
    case 'a_book_toggle':
      if (bookingsOn(b) && !queueOn(b)) return i.update(bookAdminView(b, '⚠️ This channel is bookings only. Turn the walk-up queue back on before switching bookings off.'));
      b.bookingOff = bookingsOn(b);
      if (b.bookingOff) b.bookings = [];
      save(cid);
      return i.update(bookAdminView(b, b.bookingOff ? '📅 Booking switched **off** (existing bookings cancelled).' : '📅 Booking switched **on**.'));
    case 'a_book_len':
      return i.showModal(modalOf('m_booklen', 'Booking settings (blank = default)', [
        textInput('book', 'Booked slot length (minutes)', { required: false, max: 4, value: b.settings?.book, placeholder: `Blank = default (${DEFAULTS.book})` }),
        textInput('bookcool', 'Cooldown between bookings (minutes, 0 = off)', { required: false, max: 5, value: b.settings?.bookcool, placeholder: `Blank = default (${DEFAULTS.bookcool})` }),
        textInput('bookkeep', 'Weapons kept for the queue (0 = all bookable)', { required: false, max: 2, value: b.settings?.bookkeep, placeholder: `Blank = default (${DEFAULTS.bookkeep})` }),
        textInput('bookmin', 'Earliest booking (minutes from now)', { required: false, max: 4, value: b.settings?.bookmin, placeholder: `Blank = default (${DEFAULTS.bookmin})` }),
        textInput('bookmax', 'Latest booking (hours from now, max 48)', { required: false, max: 2, value: b.settings?.bookmax, placeholder: `Blank = default (${DEFAULTS.bookmax})` }),
      ]));

    case 'a_repost': {
      await repostPanel(cid, i.channel);
      return i.update(adminView(b, '📌 Panel re-posted.'));
    }

    case 'a_clear':
      if (!b.queue.length) return i.update(adminView(b, 'The waiting queue is already empty.'));
      return i.update({ content: `🧹 Clear all ${b.queue.length} people from the waiting queue? Anyone with a weapon keeps their turn.`,
        components: [row(btn('a_clear_yes', 'Yes, clear it', ButtonStyle.Danger), btn('a_back', 'Cancel', ButtonStyle.Secondary))] });
    case 'a_clear_yes': return adminDone(i, cid, opClear(cid));

    case 'a_delete':
      return i.update({ content: "🪦 Delete this channel's whole queue, its weapons and the panel? This can't be undone.",
        components: [row(btn('a_delete_yes', 'Yes, delete it', ButtonStyle.Danger), btn('a_back', 'Cancel', ButtonStyle.Secondary))] });
    case 'a_delete_yes': {
      const r = opDeleteQueue(cid);
      await i.update({ content: r.text, components: [] });
      return r.after?.();
    }
  }
  if (id === 'm_booklen') {
    const val = (k) => { const v = f(k).trim(); return v === '' ? null : Number(v); };
    const r = opSettings(cid, { book: val('book'), bookcool: val('bookcool'), bookkeep: val('bookkeep'), bookmin: val('bookmin'), bookmax: val('bookmax') });
    return i.update(bookAdminView(board(cid), r.text.startsWith('⚙️') ? '⏱️ Booking settings updated.' : r.text));
  }
  if (id.startsWith('m_move|')) return adminDone(i, cid, opMove(cid, id.split('|')[1], Number(f('position').trim())));
  if (id.startsWith('m_key|')) {
    const fid = Number(id.split('|')[1]);
    if (!TRANCHES.includes(fid)) return;
    await i.deferUpdate(); // testing the key with Torn takes a moment
    let key = f('key').trim();
    const note = await saveTrancheKey(fid, key, i.user.id);
    key = null; // don't keep the plain key around
    return i.editReply(keysView(board(cid), note));
  }
}

// ---------- wiring ----------
// Stray turn messages from a deploy hand-over: a "🎃/📅 @member → weapon" message the bot posted
// but never recorded. If that member's turn has no message recorded, adopt it; otherwise delete it.
async function sweepOrphans(cid) {
  const b = board(cid);
  if (!b) return;
  try {
    const channel = await chan(cid);
    const recent = await channel.messages.fetch({ limit: 50 });
    const tracked = new Set([b.panelId, ...state.trash.map((t) => t.msgId)]);
    for (const [, w] of entries(b)) if (w.holder) { tracked.add(w.holder.msgId); for (const x of w.holder.extra || []) tracked.add(x); }
    for (const a of b.awaiting || []) tracked.add(a.remindMsg);
    for (const m of recent.values()) {
      if (m.author?.id !== client.user?.id || tracked.has(m.id) || !/^(🎃|📅) <@\d+>/.test(m.content || '')) continue;
      const uid = m.content.match(/<@(\d+)>/)?.[1];
      const turn = entries(b).find(([, w]) => w.holder?.userId === uid && !w.holder.msgId);
      if (turn) { turn[1].holder.msgId = m.id; save(); continue; }
      await m.delete().catch(() => {});
      console.log(`🧹 Removed a stray turn message in ${cid}`);
    }
  } catch (err) { console.error(`Stray message check failed in ${cid}:`, err.message); }
}

client.once(Events.ClientReady, async (c) => {
  // During a deploy the old copy is still finishing for a few seconds. Wait, then reload what it saved.
  if (!process.env.HWQ_TEST) {
    await new Promise((r) => setTimeout(r, 8000));
    loadState();
  }
  // Slash commands go to every server the bot is in (and to new ones as it's added, below).
  const ids = new Set([...(c.guilds?.cache?.keys?.() || [])]);
  if (GUILD_ID) ids.add(GUILD_ID);
  for (const gid of ids) await registerCommands(c, gid);
  booted = true;
  for (const cid of Object.keys(state.boards)) {
    await sweepOrphans(cid);
    for (const key of Object.keys(state.boards[cid].weapons)) {
      if (state.boards[cid].weapons[key].holder) schedule(cid, key);
    }
    await renderPanel(cid);
    await advance(cid);
  }
  await emptyTrash();
  for (const t of state.trash) setTimeout(() => emptyTrash(), Math.max(0, t.at - Date.now()) + 50);
  setInterval(() => pollArmoury().catch((e) => console.error(e)), API_POLL_MS);
  // Bookings: call people up at their time, and keep the panel's booking list fresh.
  setInterval(() => {
    for (const [cid, b] of Object.entries(state.boards)) {
      if (bookingsOf(b).some((x) => x.at <= Date.now())) advance(cid).catch((e) => console.error(e));
    }
  }, 20_000);
  const keyed = TRANCHES.filter(hasKey).length;
  console.log(`🔑 Armoury checks every ${API_POLL_MS / 1000}s while weapons are out · owner key: ${torn.enabled() ? 'on' : 'off'} · ` +
    `tranche keys: ${keyed}/${TRANCHES.length}${keys.ready() ? '' : ' (KEY_SECRET not set: keys can\'t be added)'}`);
  refreshTrancheNames().catch(() => {});
  const found = [];
  for (const gid of ids) {
    try { const g = await c.guilds.fetch(gid); await g.roles.fetch(); const r = adminRolesHere(g); if (r.length) found.push(`${g.name}: ${r.join(', ')}`); } catch { /* ignore */ }
  }
  console.log(`🛡️ Admins: Manage Server, roles containing [${ADMIN_ROLE_KEYWORDS.join(', ')}] except [${ADMIN_ROLE_EXCLUDE.join(', ')}]` +
    `${ADMIN_ROLE_ID ? `, role ${ADMIN_ROLE_ID}` : ''}, ${ADMIN_USER_IDS.size} whitelisted user(s)`);
  console.log(`🛡️ Servers: ${ids.size}. Admin roles found: ${found.length ? found.join(' | ') : 'none yet'}`);
  console.log(`💀 The Necromancer has risen: logged in as ${c.user.tag}, ${Object.keys(state.boards).length} channel queue(s) loaded`);
});

async function registerCommands(c, gid) {
  try {
    await new REST().setToken(TOKEN).put(Routes.applicationGuildCommands(c.application.id, gid), { body: commands });
  } catch (err) {
    console.error(`Couldn't register slash commands in server ${gid}: ${err.message}`);
  }
}

client.on(Events.GuildCreate, async (g) => {
  await registerCommands(client, g.id);
  console.log(`🏚️ Added to a new server: ${g.name} (${g.id}). Slash commands registered.`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!booted || shuttingDown) {
      if (i.isAutocomplete()) return await i.respond([]).catch(() => {});
      return await i.reply(eph('🔄 The Necromancer is restarting for an update. Try again in a few seconds.')).catch(() => {});
    }
    if (i.isAutocomplete()) return await autocomplete(i);
    if (i.isChatInputCommand()) return await command(i);
    const id = i.customId || '';
    const isAdminUi = id === 'p_admin' || id.startsWith('a_') || id === 'm_addw' || id === 'm_settings' || id === 'm_booklen' || id.startsWith('m_move|') || id.startsWith('m_key|');
    if (isAdminUi) return await adminInteraction(i);
    if (id.startsWith('b_')) return await bookInteraction(i);
    if (i.isButton()) return await (id.startsWith('p_') ? panelButton(i) : turnButton(i));
    if (i.isModalSubmit()) return await modal(i);
  } catch (err) {
    console.error(err);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      i.reply(eph('Something went wrong. Blame the poltergeist. 👻')).catch(() => {});
    }
  }
});

// Clean shutdown: Railway sends SIGTERM when it replaces or stops the bot during a deploy.
// Save, disconnect and exit 0, so a normal redeploy isn't reported as a crash.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`💤 The Necromancer rests (${sig}): finishing messages, saving and logging out`);
    // Let messages that are mid-send finish, so their IDs get saved (max 5 s).
    await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 5000))]);
    await new Promise((r) => setTimeout(r, 300)); // let the code after each send record the message ID
    try { save(); } catch { /* ignore */ }
    try { await client.destroy(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// Test hook (only when HWQ_TEST is set): lets the offline test run an armoury check on demand.
if (process.env.HWQ_TEST) global.__hwq = { pollArmoury, advance, state: () => state };

client.login(TOKEN);
