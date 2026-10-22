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
const isAdminRoleName = (name) => { const k = roleKey(name); return !!k && ADMIN_ROLE_KEYWORDS.some((kw) => k.includes(kw)); };
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
};
const LIMITS = { slot: [1, 240], claim: [0.5, 30], warn: [0, 60], cleanup: [0, 3600], remind: [1, 240] };
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
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
state.boards ??= {};
state.names ??= {};
state.trash ??= [];
state.links ??= {};
state.api ??= {};
state.shamed ??= []; // armoury log entries already called out, so each loan is shamed once

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
  } catch { /* not linked in Torn, or API hiccup: they can use Set Torn name */ }
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

async function send(cid, content, components = []) {
  const ch = await chan(cid);
  try {
    // SuppressEmbeds: no big link-preview card under the armoury link.
    return await ch.send({ content, components, allowedMentions: { parse: ['users'] }, flags: MessageFlags.SuppressEmbeds });
  } catch (err) { console.error(`Failed to post in ${cid}:`, err.message); }
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
async function advance(cid) {
  const b = board(cid);
  if (!b || advancing.has(cid)) return;
  advancing.add(cid);
  try {
    for (const [key, w] of byBonus(entries(b))) {
      if (w.holder || !b.weapons[key]) continue;
      const next = b.queue.shift();
      if (!next) break;
      const claimBy = Date.now() + cfg(b).claim * MIN;
      w.holder = { userId: next.userId, calledAt: Date.now(), claimBy, startedAt: null, endsAt: null, msgId: null, extra: [] };
      save(cid);
      schedule(cid, key);
      const msg = await send(cid,
        `🎃 ${who(next.userId)}, ${pick(SPOOK.up)} You've been given **${gl(b, w)}**.` +
        (isGroup(b, w) ? ' **Take either one**; both count.\n' : '\n') +
        `👉 Loan it to yourself in the ${armouryLink()}, then ` +
        (torn.enabled() ? `the bot claims your turn automatically (or press **Claim**)` : `press **Claim**`) +
        `. Do it ${ts(claimBy)} or you'll lose your place in the queue.${uidNoteFor(b, w)}`,
        claimRow(key, next.userId));
      if (msg && w.holder?.userId === next.userId) { w.holder.msgId = msg.id; save(); }
    }
  } finally {
    advancing.delete(cid);
  }
  if (b.queue.length && entries(b).some(([, w]) => !w.holder)) await advance(cid);
}

async function startSlot(cid, key) {
  clearTimers(cid, key);
  const w = board(cid).weapons[key];
  const h = w.holder;
  h.startedAt = Date.now();
  const c = cfg(board(cid));
  h.endsAt = h.startedAt + c.slot * MIN;
  h.warnMin = c.warn; // settings changed mid-turn don't affect a running slot
  h.quip = pick(SPOOK.claimed);
  save(cid);
  schedule(cid, key);
  await editMsg(cid, h.msgId, slotText(w, h, board(cid)), slotRow(key, h.userId));
  autoLink(h.userId);
}

// Text of a running turn's message (re-used when the armoury log confirms the loan).
function slotText(w, h, b) {
  let t = `🔫 ${who(h.userId)} has **${gl(b, w)}**. Slot ends ${ts(h.endsAt)}.\n` +
    (h.autoClaimed ? `${h.quip || ''}` : `If you haven't yet, loan it to yourself in the ${armouryLink()}. ${h.quip || ''}${uidNoteFor(b, w)}`);
  if (torn.enabled()) {
    t += h.autoClaimed ? '\n✅ Auto-claimed: loan seen in the armoury log.'
      : h.loanAt ? '\n✅ Loan confirmed in the armoury log.'
      : tornName(h.userId) ? '\n-# Watching the armoury log for the loan…'
        : "\n-# I don't know their Torn name, so I can't confirm the loan. Use **Set Torn name** on the panel.";
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
      : `${lead} Position ${n + 1}, turn roughly ${ts(etas(b, n + 1)[n])}.`,
    after: () => advance(cid),
  };
}

// Button presses that worked are acknowledged silently: the panel or the tag message
// already shows the result. Slash commands still get a private reply (Discord needs one).
// Anything the member can't see otherwise (errors, "not your turn") stays a private message.
const ack = (i, text) => (i.isButton?.() ? i.deferUpdate() : i.reply(eph(text)));

async function joinQueue(i, cid, userId) {
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
  const unknown = torn.enabled() && !tornName(i.user.id)
    ? "\n⚠️ I don't know your Torn name yet, so I can't confirm your loan. Press **Set Torn name** on the panel." : '';
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
      ? `🔫 You have **${wl(held[1])}**. Your slot ends ${ts(h.endsAt)}.`
      : `🙋 You're up for **${wl(held[1])}**! Press **Claim** on the message that tags you. Time runs out ${ts(h.claimBy)}.`);
  } else if (pos !== -1) {
    lines.push(`🕒 You're #${pos + 1} in this queue. Your turn is roughly ${ts(etas(b, pos + 1)[pos])}.`);
  } else {
    lines.push("You're not in this queue.");
  }
  const aw = (b.awaiting || []).find((a) => a.userId === userId);
  if (aw) lines.push(`👻 The armoury log hasn't seen **${aw.label}** come back yet. Please return it.`);
  const link = state.links[userId];
  const tn = state.names[userId];
  lines.push(link ? `-# Torn: ${link.name} [${link.id}] (linked automatically)`
    : tn ? `-# Torn name: ${tn}` : '-# No Torn name set. Use **Set Torn name** on the panel.');
  return lines.join('\n');
}

// ---------- panel ----------
function panelEmbed(b) {
  const list = entries(b);
  const c = cfg(b);
  const parts = [
    `**1.** Press **Join queue**. You'll be @'d when it's your turn.\n` +
    (torn.enabled()
      ? `**2.** [Loan the weapon](${ARMOURY_URL}) to yourself within **${c.claim} min**. The bot auto-claims your turn.\n`
      : `**2.** [Loan the weapon](${ARMOURY_URL}) to yourself, then press **Claim** within **${c.claim} min**.\n`) +
    `**3.** Return it after **${c.slot} min**.`,
    `\n**🗡️ Weapons (${list.length})**`,
  ];
  if (!list.length) parts.push('None yet. The armoury is bare. 🕸️ Admins: `/qadmin add-weapon`.');
  const holderLine = (h) => {
    const loan = torn.enabled() && isActive(h) ? (h.loanAt ? ' · ✅ loaned' : ' · ⏳ loan not seen yet') : '';
    return isActive(h) ? `🔫 ${who(h.userId)}, ends ${ts(h.endsAt)}${loan}` : `🙋 ${who(h.userId)}, must claim ${ts(h.claimBy)}`;
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

  parts.push(`\n**⚰️ Queue (${b.queue.length})**`);
  if (!b.queue.length) parts.push(SPOOK.empty[Math.floor(Date.now() / 3_600_000) % SPOOK.empty.length]);
  const times = etas(b, Math.min(b.queue.length, QUEUE_SHOWN));
  b.queue.slice(0, QUEUE_SHOWN).forEach((e, n) => parts.push(`${n + 1}. ${who(e.userId)}, ~${ts(times[n])}`));
  if (b.queue.length > QUEUE_SHOWN) parts.push(`…and ${b.queue.length - QUEUE_SHOWN} more lost souls`);

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

function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      btn('p_join', 'Join queue', ButtonStyle.Success, '🎃'),
      btn('p_leave', 'Leave queue', ButtonStyle.Danger, '👋'),
    ),
    new ActionRowBuilder().addComponents(
      btn('p_done', 'Finished', ButtonStyle.Primary, '🏁'),
      btn('p_me', 'My status', ButtonStyle.Secondary, '📋'),
      btn('p_name', 'Set Torn name', ButtonStyle.Secondary, '✏️'),
      btn('p_admin', 'Admin', ButtonStyle.Secondary, '🛠️'),
    ),
  ];
}

const panelPayload = (b) => ({ content: '', embeds: [panelEmbed(b)], components: panelComponents() });

// Panel edits are batched per channel, so a burst of changes becomes one edit.
// The panel is only ever edited, never re-posted, unless an admin runs /qadmin panel.
const panelTimers = {};
function queuePanelUpdate(cid) {
  if (panelTimers[cid] || !board(cid)?.panelId) return;
  panelTimers[cid] = setTimeout(() => { delete panelTimers[cid]; renderPanel(cid); }, 1500);
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
  ].join('\n');
}

const SETTING_LABELS = {
  slot: 'Slot length (minutes)', claim: 'Time to claim (minutes)', warn: 'Warning (minutes)',
  cleanup: 'Clean-up delay (seconds)', remind: 'Return reminder (minutes)',
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
    next[k] = k === 'cleanup' ? Math.round(v) : Math.round(v * 100) / 100;
  }
  const c = { ...DEFAULTS, ...next };
  if (c.warn >= c.slot) return { text: `The warning (${c.warn} min) has to be shorter than the slot (${c.slot} min).` };
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
    case 'p_me': return i.reply(eph(myStatus(cid, i.user.id)));
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

async function pollArmoury() {
  if (!torn.enabled() || polling || Date.now() < backoffUntil) return;
  const starts = [];
  for (const b of Object.values(state.boards)) {
    // Active slots (loan/return checks) and turns waiting to be claimed (auto-claim on loan).
    for (const [, w] of entries(b)) if (w.holder) starts.push(w.holder.calledAt || w.holder.startedAt || Date.now());
    for (const a of b.awaiting || []) starts.push(a.loanAt);
  }
  if (!starts.length) return;
  polling = true;
  try {
    const news = await torn.armouryNews((Math.min(...starts) - 5 * MIN) / 1000);
    state.api.lastOkAt = Date.now();
    state.api.lastError = null;
    const changed = new Set();
    for (const n of news) {
      const ev = torn.parseArmoury(n.text);
      if (ev) await applyArmouryEvent(ev, n.timestamp * 1000, changed, n.id);
    }
    save();
    for (const cid of changed) queuePanelUpdate(cid);
  } catch (err) {
    state.api.lastError = { msg: torn.explain(err), at: Date.now() };
    console.error('Armoury log check failed:', torn.explain(err));
    if ([0, 2, 7, 8, 10, 13, 16, 18].includes(err.code)) backoffUntil = Date.now() + 10 * MIN;
    else if (err.code === 5) backoffUntil = Date.now() + 2 * MIN;
    save();
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
async function shameOutOfTurn(ev, at, newsId) {
  if (ev.type !== 'loan') return;
  for (const [cid, b] of Object.entries(state.boards)) {
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

async function applyArmouryEvent(ev, at, changed, newsId) {
  await shameOutOfTurn(ev, at, newsId);
  for (const [cid, b] of Object.entries(state.boards)) {
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
    `Queue: ${b.queue.length} · ${c.slot}-min slots · ${c.claim} min to claim${torn.enabled() ? ' · 🔑 API checks on' : ''}` +
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
      btn('a_rmu', 'Remove member', ButtonStyle.Secondary, '🚫'),
      btn('a_move', 'Move member', ButtonStyle.Secondary, '↕️').setDisabled(emptyQueue)),
    row(btn('a_settings', 'Settings', ButtonStyle.Primary, '⚙️'),
      btn('a_api', 'API test', ButtonStyle.Secondary, '🔑'),
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
    case 'a_addu_pick': return adminDone(i, cid, enqueue(cid, i.values[0], true));

    case 'a_rmu': return i.update(pickView('🚫 Who should be removed? (If they have a weapon, their turn ends.)', userSelect('a_rmu_pick')));
    case 'a_rmu_pick': return adminDone(i, cid, opRemoveUser(cid, i.values[0]));

    case 'a_move': return i.update(pickView('↕️ Who should be moved?', userSelect('a_move_pick')));
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

    case 'a_api': {
      await i.deferUpdate();
      return i.editReply({ content: await apiTestText(), components: [backRow()] });
    }

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
  if (id.startsWith('m_move|')) return adminDone(i, cid, opMove(cid, id.split('|')[1], Number(f('position').trim())));
}

// ---------- wiring ----------
client.once(Events.ClientReady, async (c) => {
  // Slash commands go to every server the bot is in (and to new ones as it's added, below).
  const ids = new Set([...(c.guilds?.cache?.keys?.() || [])]);
  if (GUILD_ID) ids.add(GUILD_ID);
  for (const gid of ids) await registerCommands(c, gid);
  for (const cid of Object.keys(state.boards)) {
    for (const key of Object.keys(state.boards[cid].weapons)) {
      if (state.boards[cid].weapons[key].holder) schedule(cid, key);
    }
    await renderPanel(cid);
    await advance(cid);
  }
  await emptyTrash();
  for (const t of state.trash) setTimeout(() => emptyTrash(), Math.max(0, t.at - Date.now()) + 50);
  if (torn.enabled()) {
    setInterval(() => pollArmoury().catch((e) => console.error(e)), API_POLL_MS);
    console.log(`🔑 Torn API checks on (armoury log every ${API_POLL_MS / 1000}s while weapons are out)`);
  }
  const found = [];
  for (const gid of ids) {
    try { const g = await c.guilds.fetch(gid); await g.roles.fetch(); const r = adminRolesHere(g); if (r.length) found.push(`${g.name}: ${r.join(', ')}`); } catch { /* ignore */ }
  }
  console.log(`🛡️ Admins: Manage Server, roles containing [${ADMIN_ROLE_KEYWORDS.join(', ')}]` +
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
    if (i.isAutocomplete()) return await autocomplete(i);
    if (i.isChatInputCommand()) return await command(i);
    const id = i.customId || '';
    const isAdminUi = id === 'p_admin' || id.startsWith('a_') || id === 'm_addw' || id === 'm_settings' || id.startsWith('m_move|');
    if (isAdminUi) return await adminInteraction(i);
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
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`💤 The Necromancer rests (${sig}): saving and logging out`);
    try { save(); } catch { /* ignore */ }
    try { await client.destroy(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// Test hook (only when HWQ_TEST is set): lets the offline test run an armoury check on demand.
if (process.env.HWQ_TEST) global.__hwq = { pollArmoury, state: () => state };

client.login(TOKEN);
