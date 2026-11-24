// Pharmacy stock alerts for The Necromancer.
//
// Watches a few pharmacy items through the official Torn API (torn > cityshops, public access;
// one call covers every item) and DMs the members who asked for an item the moment it comes
// back in stock. It never loads torn.com pages and never buys anything: buying stays manual.
//
// The checks run on API keys that members choose to lend (a Public key is all it needs; keys with
// more access are accepted, but only Public data is ever read with them). Lent keys
// are encrypted before they're saved, never shown to anyone, and used only for what the lender is
// told before entering one: any bot feature that only needs Public access (today: these stock checks
// and the job-seekers forum feed). They are taken in turn so the calls are shared out between them.

// Matched by item name in the API's shop list.
const ITEMS = [
  { key: 'bag', name: 'Empty Blood Bag', emoji: '🩸' },
  { key: 'epi', name: 'Epinephrine', emoji: '💉' },
  { key: 'mel', name: 'Melatonin', emoji: '💉' },
  { key: 'ser', name: 'Serotonin', emoji: '💉' },
  { key: 'tyr', name: 'Tyrosine', emoji: '💉' },
];
const SHOP_URL = 'https://www.torn.com/shops.php?step=pharmacy';
const MENU_ID = 'stock_pick';
const IDS = { menu: MENU_ID, lend: 'stock_key', add: 'stock_key_add', modal: 'stock_key_modal', remove: 'stock_key_remove' };
const DEAD_KEY = [2, 10, 13, 16, 18]; // wrong/deleted, owner in federal, inactive, access too low, paused
const fmt = (n) => Number(n).toLocaleString('en-GB');
const norm = (s) => String(s || '').trim().toLowerCase();
const CANT_DM = 50007; // Discord: this member doesn't accept DMs from the bot

function createStockAlerts({ getState, save, torn, dm, editDm, vault, useOwnerKey = false, minKeys = 5, targetKeys = 20 }) {
  const cfg = () => {
    const s = getState();
    s.stock ??= {};
    s.stock.subs ??= {}; // { [discordUserId]: ['bag', 'epi', ...] }
    s.stock.last ??= {}; // { [itemKey]: stock at the last check }
    s.stock.since ??= {}; // { [itemKey]: when it came back in stock }
    s.stock.msgs ??= {}; // { [itemKey]: [{ u, m }] } alerts to mark "sold out" later
    s.stock.keys ??= {}; // { [discordUserId]: { enc, addedAt, status, err } } keys lent for stock checks
    return s.stock;
  };
  let busy = false;
  let latest = null; // { at, items: { [key]: { stock, price } } }

  const subscribers = (key) => Object.entries(cfg().subs).filter(([, keys]) => keys.includes(key)).map(([u]) => u);
  const anySubs = () => Object.values(cfg().subs).some((k) => k.length);
  const button = [{ type: 1, components: [{ type: 2, style: 5, label: 'Pharmacy', url: SHOP_URL }] }];

  // ---------- lent keys ----------
  const rest = {}; // { [id]: time } keys resting after a rate-limit error
  let turn = 0;
  // Keys that can be used right now: lent keys, plus the bot owner's key only if switched on.
  function pool() {
    const out = [];
    if (useOwnerKey && torn.enabled() && !(rest.owner > Date.now())) out.push('owner');
    for (const [u, k] of Object.entries(cfg().keys)) if (k.enc && k.status !== 'bad' && !(rest[u] > Date.now())) out.push(u);
    return out;
  }
  const keyCount = () => Object.values(cfg().keys).filter((k) => k.enc && k.status !== 'bad').length + (useOwnerKey && torn.enabled() ? 1 : 0);

  // One API call with the next key in turn. A key that has stopped working is set aside and its lender told once.
  async function withKey(fn) {
    const ids = pool();
    if (!ids.length) throw new Error('No API key to check with');
    const id = ids[turn++ % ids.length];
    const key = id === 'owner' ? undefined : vault.decrypt(cfg().keys[id].enc);
    try {
      if (id !== 'owner' && !key) throw Object.assign(new Error("Saved key can't be unlocked"), { code: 2 });
      return await fn(key);
    } catch (err) {
      if (err?.code === 5) rest[id] = Date.now() + 60_000;
      else if (id !== 'owner' && DEAD_KEY.includes(err?.code)) {
        Object.assign(cfg().keys[id], { status: 'bad', err: torn.explain(err) });
        save();
        dm(id, { content: `🔑 The API key you lent to the bot has stopped working (${torn.explain(err)}) and is no longer used. You can lend a new one with /pharmacyalerts.` }).catch(() => {});
      }
      throw err;
    }
  }

  // For the job-seekers feed: the next lent key in turn, or the owner's key when none is lent.
  const borrow = (fn) => (pool().length ? withKey(fn) : fn(undefined));

  // Check and save a key a member is lending. Returns a short note.
  async function addKey(userId, raw) {
    const key = String(raw || '').trim();
    if (!vault.ready()) return "⚠️ Keys can't be saved yet (KEY_SECRET isn't set).";
    if (!/^[A-Za-z0-9]{16}$/.test(key)) return "⚠️ That doesn't look like a Torn API key (16 letters and numbers).";
    try {
      await torn.cityShops(key); // any access level works: only Public data is ever read with it
    } catch (err) { return `⚠️ Torn didn't accept that key: ${torn.explain(err)}`; }
    cfg().keys[userId] = { enc: vault.encrypt(key), addedAt: Date.now(), status: 'ok' };
    save();
    return '🔑 Thank you. Your key is saved (encrypted) and only used for bot features that need Public access.';
  }
  function removeKey(userId) {
    delete cfg().keys[userId];
    save();
    return '🗑️ Your key has been deleted.';
  }
  const hasKey = (userId) => !!cfg().keys[userId]?.enc;

  // One API call: the stock of every watched item.
  async function fetchStock() {
    const list = await withKey((key) => torn.cityShops(key));
    const items = {};
    for (const it of ITEMS) {
      const hit = list.find((x) => norm(x.name) === norm(it.name));
      if (hit) items[it.key] = { stock: hit.stock, price: hit.price };
    }
    if (!Object.keys(items).length) throw new Error("The pharmacy items aren't in the shop list");
    latest = { at: Date.now(), items };
    return items;
  }

  // Send to many members, 10 at a time. Members who can't be DMed are unsubscribed.
  async function dmAll(users, payload) {
    const sent = [];
    for (let n = 0; n < users.length; n += 10) {
      await Promise.all(users.slice(n, n + 10).map(async (u) => {
        try {
          const msg = await dm(u, payload);
          if (msg?.id) sent.push({ u, m: msg.id });
        } catch (err) {
          if (err?.code === CANT_DM) delete cfg().subs[u];
          else console.error(`Stock alert DM failed for ${u}:`, err?.message);
        }
      }));
    }
    return sent;
  }

  async function poll() {
    const c = cfg();
    // Alerts only run while enough keys are lent to share the calls.
    if (busy || !anySubs() || keyCount() < minKeys || !pool().length) return;
    busy = true;
    try {
      const items = await fetchStock();
      c.lastOkAt = Date.now();
      c.lastError = null;
      let changed = false;
      for (const it of ITEMS) {
        const now = items[it.key];
        if (!now) continue;
        const was = c.last[it.key];
        c.last[it.key] = now.stock;
        if (was === undefined) { changed = true; continue; } // first sighting: just note it
        if (now.stock > 0 && was === 0) {
          // Back in stock.
          changed = true;
          c.since[it.key] = Date.now();
          c.alerts = (c.alerts || 0) + 1;
          c.msgs[it.key] = await dmAll(subscribers(it.key), {
            embeds: [{
              color: 0xda373c,
              title: `${it.emoji} ${it.name} in stock`,
              description: `**${fmt(now.stock)}** available${now.price ? ` · $${fmt(now.price)} each` : ''}`,
              timestamp: new Date().toISOString(),
            }],
            components: button,
          });
        } else if (now.stock === 0 && was > 0) {
          changed = true;
          const mins = c.since[it.key] ? Math.max(1, Math.round((Date.now() - c.since[it.key]) / 60000)) : null;
          const payload = {
            embeds: [{
              color: 0x4e5058,
              title: `⚫ ${it.name} sold out`,
              description: mins ? `Lasted about ${fmt(mins)} min` : undefined,
              timestamp: new Date().toISOString(),
            }],
            components: [],
          };
          const old = c.msgs[it.key] || [];
          delete c.msgs[it.key];
          delete c.since[it.key];
          for (let n = 0; n < old.length; n += 10) await Promise.all(old.slice(n, n + 10).map((x) => editDm(x.u, x.m, payload)));
        }
      }
      if (changed) save();
    } catch (err) {
      c.lastError = torn.explain(err);
      console.error('Stock check failed:', c.lastError);
    } finally {
      busy = false;
    }
  }

  // The private panel a member sees: current stock and a menu of what to be alerted about.
  async function panel(userId, note = '') {
    let items = latest && Date.now() - latest.at < 15_000 ? latest.items : null;
    let problem = '';
    if (!items && pool().length) {
      try { items = await fetchStock(); } catch (err) { problem = `⚠️ ${torn.explain(err)}`; }
    }
    const count = keyCount();
    const active = count >= minKeys;
    const mine = cfg().subs[userId] || [];
    const bad = cfg().keys[userId]?.status === 'bad';
    const lines = ITEMS.map((it) => `${it.emoji} ${it.name}: **${items?.[it.key] ? fmt(items[it.key].stock) : '?'}**`);
    return {
      content: [`**Pharmacy stock alerts**`, ...lines, `🔑 Keys: **${count} / ${targetKeys}** · alerts ${active ? '🟢 on' : `🔴 off until ${minKeys}`}${bad ? ' · yours stopped working' : ''}`, problem, note].filter(Boolean).join('\n'),
      components: [{ type: 1, components: [{
        type: 3, custom_id: MENU_ID, placeholder: 'DM me when these are back in stock', min_values: 0, max_values: ITEMS.length,
        options: ITEMS.map((it) => ({ label: it.name, value: it.key, emoji: { name: it.emoji }, default: mine.includes(it.key) })),
      }] }, { type: 1, components: [hasKey(userId) && !bad
        ? { type: 2, style: 2, custom_id: IDS.remove, label: 'Remove my key' }
        : { type: 2, style: 2, custom_id: IDS.lend, label: 'Lend a key', emoji: { name: '🔑' } }] }],
    };
  }

  // What a member is shown before they enter a key.
  function terms() {
    return {
      content: [
        '**Lend an API key** (optional)',
        `Lent keys are used for **any bot feature that only needs Public access**, taking turns. Right now: pharmacy alerts and the job-seekers feed.`,
        `Pharmacy alerts need ${minKeys} keys; the target is ${targetKeys}. A **Public** key is all it needs (Torn → Settings → API Keys). Keys with more access work too, but only Public data is ever read.`,
        '',
        '**Data Storage:** Only locally: your Discord ID and your key (encrypted), until you remove it',
        '**Data Sharing:** Faction: public forum posts and shop stock read with the key are shown in Discord. Your key is shared with nobody',
        '**Purpose of Use:** Public community tools: any bot feature that only needs Public access (now: pharmacy restock alerts, job-seekers forum feed)',
        '**Key Storage & Sharing:** Stored / Used only for automation',
        '**Key Access Level:** Public (higher levels accepted; only Public selections are used: now torn → cityshops, forum → posts/thread, user → personalstats/profile)',
        '',
        '-# [Torn API terms](<https://www.torn.com/api.html>) · remove your key any time with /pharmacyalerts',
      ].join('\n'),
      components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: IDS.add, label: 'Enter key' }] }],
    };
  }

  // Save a member's choice. Returns a short note for the panel.
  async function choose(userId, keys) {
    const c = cfg();
    const picked = ITEMS.filter((it) => keys.includes(it.key));
    if (!picked.length) { delete c.subs[userId]; save(); return '🔕 Alerts off.'; }
    // A test DM, so a member with DMs closed finds out now rather than missing a restock.
    try {
      await dm(userId, { content: `🔔 Stock alerts on: ${picked.map((it) => it.name).join(', ')}` });
    } catch (err) {
      delete c.subs[userId];
      save();
      return err?.code === CANT_DM ? "⚠️ I can't DM you. Allow DMs from this server, then pick again." : `⚠️ DM failed: ${err?.message}`;
    }
    c.subs[userId] = picked.map((it) => it.key);
    save();
    return '🔔 Saved. Alerts arrive by DM.';
  }

  return { cfg, poll, panel, choose, terms, addKey, removeKey, keyCount, borrow, minKeys, targetKeys };
}

module.exports = { createStockAlerts, ITEMS, SHOP_URL, MENU_ID, IDS };
