// ==UserScript==
// @name         Torn Weapon UID Finder (HW queue helper)
// @namespace    hw-queue-bot
// @version      1.0.0
// @description  Shows the unique ID (UID) of bonus weapons (e.g. ranked war weapons) on the faction armoury and Items pages you are viewing, with copy buttons. Read-only: makes no requests and sends nothing anywhere.
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/item.php*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS (and why it's within Torn's scripting rules)
 *  - It only uses data from the page you have opened yourself.
 *  - Source 1: when the page loads its own item data, the script reads a COPY of
 *    that response. It never sends, repeats or changes any request.
 *  - Source 2: it reads item IDs that Torn puts on the page's item rows.
 *  - Its buttons only copy text to your clipboard or show/hide the box.
 *  - It makes no requests to Torn, the Torn API, or any other website.
 *
 * Terms of Service
 * | Data Storage          | No                                                        |
 * | Data Sharing          | Nobody                                                    |
 * | Purpose of Use        | Other: find weapon UIDs to register in a faction queue bot |
 * | Key Storage & Sharing | Not stored / Not shared (no API key is used)              |
 * | Key Access Level      | None required                                             |
 */

(function () {
  'use strict';

  const found = new Map(); // uid -> { uid, name, type, bonuses:Set, rarity, from:Set }
  const debug = { responses: 0, jsonResponses: 0, paths: new Set(), keySamples: [], domHits: 0 };

  // ---------- recognising items in data ----------
  const UID_KEY = /^(armou?ry_?id|armou?ry_?uid|item_?uid|uid)$/i;
  const NAME_KEY = /^(name|item_?name)$/i;
  const TYPE_KEY = /^(type|item_?type|category|sub_?type)$/i;
  const RARITY_KEY = /^(rarity|quality|glow|colou?r)$/i;
  const looksLikeUid = (v) => /^\d{5,}$/.test(String(v ?? '').trim());
  const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  function bonusText(v) {
    if (v == null) return [];
    if (typeof v === 'string' || typeof v === 'number') return [clean(v)].filter(Boolean);
    if (Array.isArray(v)) return v.flatMap(bonusText);
    if (typeof v === 'object') {
      // Common shapes: { bonus: 'Revitalize', value: 25 } or { title, description } or keyed objects
      const title = v.bonus ?? v.name ?? v.title ?? v.Bonus ?? v.Name;
      const val = v.value ?? v.val ?? v.percent ?? v.Value;
      if (title != null) return [clean(`${title}${val != null ? ` ${val}%` : ''}`)];
      return Object.values(v).flatMap(bonusText);
    }
    return [];
  }

  function record(uid, info, from) {
    uid = String(uid).trim();
    const cur = found.get(uid) || { uid, name: '', type: '', bonuses: new Set(), rarity: '', from: new Set() };
    if (info.name && !cur.name) cur.name = info.name;
    if (info.type && !cur.type) cur.type = info.type;
    if (info.rarity && !cur.rarity) cur.rarity = info.rarity;
    for (const b of info.bonuses || []) if (b && b.length < 120) cur.bonuses.add(b);
    cur.from.add(from);
    found.set(uid, cur);
  }

  function walk(node, depth, budget) {
    if (!node || typeof node !== 'object' || depth > 10 || budget.n-- <= 0) return;
    if (!Array.isArray(node)) {
      const keys = Object.keys(node);
      const uidKey = keys.find((k) => UID_KEY.test(k) && looksLikeUid(node[k]));
      const nameKey = keys.find((k) => NAME_KEY.test(k) && typeof node[k] === 'string');
      if (uidKey && nameKey) {
        const bonuses = keys.filter((k) => /bonus/i.test(k)).flatMap((k) => bonusText(node[k]));
        const typeKey = keys.find((k) => TYPE_KEY.test(k) && typeof node[k] === 'string');
        const rarKey = keys.find((k) => RARITY_KEY.test(k) && typeof node[k] === 'string');
        record(node[uidKey], {
          name: clean(node[nameKey]),
          type: typeKey ? clean(node[typeKey]) : '',
          rarity: rarKey ? clean(node[rarKey]) : '',
          bonuses,
        }, 'page data');
        if (debug.keySamples.length < 3) debug.keySamples.push(keys.slice(0, 25).join(', '));
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1, budget);
  }

  function scanText(text, url) {
    debug.responses++;
    try {
      const u = new URL(url, location.href);
      debug.paths.add(u.pathname + (u.searchParams.get('step') ? `?step=${u.searchParams.get('step')}` : ''));
    } catch { /* ignore */ }
    if (typeof text !== 'string') return;
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return;
    let json;
    try { json = JSON.parse(t); } catch { return; }
    debug.jsonResponses++;
    const before = found.size;
    walk(json, 0, { n: 50000 });
    if (found.size !== before) schedule();
  }

  // ---------- Source 1: read copies of the page's own responses (no new requests) ----------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          res.clone().text().then((txt) => scanText(txt, url)).catch(() => {});
        } catch { /* never interfere with the page */ }
        return res;
      });
    };
  }
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__uidFinderUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') scanText(this.responseText, this.__uidFinderUrl);
      } catch { /* never interfere with the page */ }
    });
    return origSend.apply(this, args);
  };

  // ---------- Source 2: read IDs from the item rows on the page ----------
  const ATTRS = ['data-armoryid', 'data-armouryid', 'data-armory-id', 'data-armoury-id', 'data-uid', 'data-item-uid'];
  function scanDom() {
    const sel = ATTRS.map((a) => `[${a}]`).join(',') + ',a[href*="armoryID="],a[href*="armouryID="],a[href*="armoryId="]';
    let hits = 0;
    for (const el of document.querySelectorAll(sel)) {
      let uid = null;
      for (const a of ATTRS) if (looksLikeUid(el.getAttribute(a))) { uid = el.getAttribute(a); break; }
      if (!uid && el.href) {
        const m = el.href.match(/armou?ryI[dD]=(\d{5,})/);
        if (m) uid = m[1];
      }
      if (!uid) continue;
      hits++;
      const row = el.closest('li, tr, [class*="item"], [class*="row"]') || el;
      const nameEl = row.querySelector('[class*="name"], [class*="title"]');
      const name = clean(nameEl?.textContent || row.getAttribute('data-name') || (row.innerText || '').split('\n')[0]).slice(0, 60);
      const bonuses = [...row.querySelectorAll('[title], [aria-label], [data-title]')]
        .map((e) => clean(e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('data-title')))
        .filter((s) => /%/.test(s))
        .map((s) => s.slice(0, 100));
      record(uid, { name, bonuses }, 'page');
    }
    debug.domHits = hits;
  }

  // ---------- the little box ----------
  let box, list, countEl, showAll = false, collapsed = false, timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scanDom(); render(); }, 400);
  }

  function copy(text, btn) {
    const done = () => { if (btn) { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = t), 1200); } };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { /* ignore */ }
      ta.remove();
    }
  }

  const line = (it) => `${it.name || 'Unknown item'}${it.bonuses.size ? ` (${[...it.bonuses].join('; ')})` : ''} UID ${it.uid}`;

  function build() {
    if (box || !document.body) return;
    const css = document.createElement('style');
    css.textContent = `
      #uidf{position:fixed;left:12px;bottom:12px;z-index:2147483647;width:340px;max-width:calc(100vw - 24px);
        background:#1f1f1f;color:#eee;border:1px solid #ff7518;border-radius:8px;font:13px/1.4 Arial,sans-serif;
        box-shadow:0 4px 18px rgba(0,0,0,.5)}
      #uidf header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#2b1a0a;border-radius:8px 8px 0 0;cursor:pointer}
      #uidf header b{flex:1}
      #uidf .bar{display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid #333}
      #uidf button{background:#444;color:#fff;border:0;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer}
      #uidf button.go{background:#ff7518;color:#111;font-weight:bold}
      #uidf ul{list-style:none;margin:0;padding:0;max-height:260px;overflow:auto}
      #uidf li{padding:7px 10px;border-bottom:1px solid #2c2c2c}
      #uidf .n{font-weight:bold}
      #uidf .bn{color:#ffb070;font-size:12px}
      #uidf .u{font-family:monospace;color:#9fd3ff}
      #uidf .row{display:flex;align-items:center;gap:8px;margin-top:3px}
      #uidf .row .u{flex:1}
      #uidf .empty{padding:10px;color:#aaa}
      #uidf.min ul,#uidf.min .bar{display:none}`;
    document.head.appendChild(css);

    box = document.createElement('div');
    box.id = 'uidf';
    const header = document.createElement('header');
    header.innerHTML = '<span>🎃</span><b>Weapon UID finder</b>';
    countEl = document.createElement('span');
    header.appendChild(countEl);
    header.addEventListener('click', () => { collapsed = !collapsed; box.classList.toggle('min', collapsed); });

    const bar = document.createElement('div');
    bar.className = 'bar';
    const mk = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); }); bar.appendChild(b); return b; };
    mk('Copy all', (b) => copy(visible().map(line).join('\n') || 'Nothing found', b), 'go');
    const toggle = mk('Show all items', (b) => { showAll = !showAll; b.textContent = showAll ? 'Bonus weapons only' : 'Show all items'; render(); });
    mk('Copy debug info', (b) => copy(debugText(), b));
    toggle.title = 'By default only items with bonuses (e.g. ranked war weapons) are listed';

    list = document.createElement('ul');
    box.append(header, bar, list);
    document.body.appendChild(box);
    render();
  }

  const visible = () => {
    const all = [...found.values()];
    const bonus = all.filter((i) => i.bonuses.size || i.rarity);
    return showAll ? all : bonus;
  };

  function render() {
    build();
    if (!list) return;
    const items = visible().sort((a, b) => (b.bonuses.size - a.bonuses.size) || a.name.localeCompare(b.name));
    countEl.textContent = `${items.length}${showAll ? '' : ' with bonuses'}`;
    list.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = found.size
        ? `${found.size} item(s) found, none with bonuses. Press "Show all items".`
        : 'Nothing yet. Open the armoury Weapons tab, or your Items page, and scroll through it. If nothing appears, press "Copy debug info" and send it to whoever set this up.';
      list.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = it.name || 'Unknown item';
      li.appendChild(n);
      if (it.bonuses.size || it.rarity) {
        const bn = document.createElement('div');
        bn.className = 'bn';
        bn.textContent = [...it.bonuses].join(' · ') + (it.rarity ? `${it.bonuses.size ? ' · ' : ''}${it.rarity}` : '');
        li.appendChild(bn);
      }
      const row = document.createElement('div');
      row.className = 'row';
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = `UID ${it.uid}`;
      const b = document.createElement('button');
      b.textContent = 'Copy';
      b.addEventListener('click', () => copy(it.uid, b));
      row.append(u, b);
      li.appendChild(row);
      list.appendChild(li);
    }
  }

  function debugText() {
    return [
      'Weapon UID finder debug',
      `Page: ${location.pathname}${location.hash.split('?')[0]}`,
      `Responses seen: ${debug.responses} (JSON: ${debug.jsonResponses})`,
      `Response paths: ${[...debug.paths].slice(0, 15).join(' | ') || 'none'}`,
      `Matched key samples: ${debug.keySamples.join(' || ') || 'none'}`,
      `IDs on page rows: ${debug.domHits}`,
      `Items found: ${found.size} (with bonuses: ${[...found.values()].filter((i) => i.bonuses.size).length})`,
    ].join('\n');
  }

  // Start once the page exists; re-scan the page as Torn swaps tabs/content in.
  const start = () => {
    build();
    scanDom();
    render();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
