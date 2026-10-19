// ==UserScript==
// @name         Torn Weapon UID Finder (Necromancer helper)
// @namespace    hw-queue-bot
// @version      1.1.0
// @author       Eaglewing [571041]
// @description  Adds a small 🆔 button to each weapon on the faction armoury and Items pages you are viewing. Click it to copy that weapon's unique ID (UID). Read-only: makes no requests and sends nothing anywhere.
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/item.php*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS (and why it's within Torn's scripting rules)
 *  - It only uses data from the page you have opened yourself.
 *  - Source 1: item IDs Torn puts on the page's item rows → a 🆔 button on that row.
 *  - Source 2: when the page loads its own item data, the script reads a COPY of
 *    that response (never sends, repeats or changes a request). Weapons from that
 *    data get a 🆔 button when they can be matched to exactly one row by name;
 *    any that can't (e.g. two identical weapons) go in a small corner chip.
 *  - Clicking 🆔 only copies text to your clipboard. The click is stopped so it can
 *    never reach Torn's own buttons in that row (equip, loan, etc.).
 *  - It makes no requests to Torn, the Torn API, or any other website.
 *
 * Terms of Service
 * | Data Storage          | No                                                         |
 * | Data Sharing          | Nobody                                                     |
 * | Purpose of Use        | Other: find weapon UIDs to register in a faction queue bot |
 * | Key Storage & Sharing | Not stored / Not shared (no API key is used)               |
 * | Key Access Level      | None required                                              |
 */

(function () {
  'use strict';

  const fromData = new Map(); // uid -> { uid, name, bonuses: [] } read from the page's own data
  const placed = new Set();   // uids that have a 🆔 button on the page
  const MARK = 'data-uidf';   // marks rows/buttons we've handled

  const looksLikeUid = (v) => /^\d{5,}$/.test(String(v ?? '').trim());
  const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase();

  // ---------- Source 2: read copies of the page's own responses ----------
  const UID_KEY = /^(armou?ry_?id|armou?ry_?uid|item_?uid|uid)$/i;
  const NAME_KEY = /^(name|item_?name)$/i;

  function bonusText(v) {
    if (v == null) return [];
    if (typeof v === 'string' || typeof v === 'number') return [clean(v)].filter(Boolean);
    if (Array.isArray(v)) return v.flatMap(bonusText);
    if (typeof v === 'object') {
      const title = v.bonus ?? v.name ?? v.title ?? v.Bonus ?? v.Name;
      const val = v.value ?? v.val ?? v.percent ?? v.Value;
      if (title != null) return [clean(`${title}${val != null ? ` ${val}%` : ''}`)];
      return Object.values(v).flatMap(bonusText);
    }
    return [];
  }

  function walk(node, depth, budget) {
    if (!node || typeof node !== 'object' || depth > 10 || budget.n-- <= 0) return;
    if (!Array.isArray(node)) {
      const keys = Object.keys(node);
      const uidKey = keys.find((k) => UID_KEY.test(k) && looksLikeUid(node[k]));
      const nameKey = keys.find((k) => NAME_KEY.test(k) && typeof node[k] === 'string');
      if (uidKey && nameKey) {
        const uid = String(node[uidKey]).trim();
        if (!fromData.has(uid)) {
          fromData.set(uid, {
            uid,
            name: clean(node[nameKey]),
            bonuses: keys.filter((k) => /bonus/i.test(k)).flatMap((k) => bonusText(node[k])).slice(0, 3),
          });
        }
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1, budget);
  }

  function scanText(text) {
    if (typeof text !== 'string') return;
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return;
    try { walk(JSON.parse(t), 0, { n: 50000 }); schedule(); } catch { /* not JSON */ }
  }

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try { res.clone().text().then(scanText).catch(() => {}); } catch { /* never interfere */ }
        return res;
      });
    };
  }
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try { if (this.responseType === '' || this.responseType === 'text') scanText(this.responseText); } catch { /* ignore */ }
    });
    return origSend.apply(this, args);
  };

  // ---------- the 🆔 button ----------
  function copy(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
  }

  // Swallow every pointer/mouse event so nothing reaches Torn's row handlers.
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

  function makeButton(uid, info) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'uidf-btn';
    b.setAttribute(MARK, uid);
    b.textContent = '🆔';
    b.title = `UID ${uid}${info?.bonuses?.length ? `\n${info.bonuses.join(' · ')}` : ''}\nClick to copy`;
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'dblclick']) b.addEventListener(ev, stop, true);
    b.addEventListener('click', (e) => {
      stop(e);
      copy(uid);
      b.classList.add('done');
      b.textContent = `✓ ${uid}`;
      setTimeout(() => { b.classList.remove('done'); b.textContent = '🆔'; }, 1600);
    }, true);
    return b;
  }

  function attach(uid, rowOrEl, anchor) {
    if (placed.has(uid) || !rowOrEl) return;
    if (rowOrEl.querySelector?.(`.uidf-btn[${MARK}="${uid}"]`)) { placed.add(uid); return; }
    const btn = makeButton(uid, fromData.get(uid));
    // Never put the button inside a link (a click there would navigate).
    if (anchor && anchor.tagName === 'A') anchor.insertAdjacentElement('afterend', btn);
    else if (anchor) anchor.appendChild(btn);
    else rowOrEl.appendChild(btn);
    placed.add(uid);
  }

  const rowOf = (el) => el.closest('li, tr, [class*="item"], [class*="row"]') || el;
  const nameElOf = (row) => row.querySelector('[class*="name"], [class*="title"]');

  // ---------- Source 1: IDs on the item rows ----------
  const ATTRS = ['data-armoryid', 'data-armouryid', 'data-armory-id', 'data-armoury-id', 'data-uid', 'data-item-uid'];
  function placeFromDom() {
    const sel = ATTRS.map((a) => `[${a}]`).join(',') + ',a[href*="armoryID="],a[href*="armouryID="],a[href*="armoryId="]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.classList?.contains('uidf-btn')) continue;
      let uid = null;
      for (const a of ATTRS) if (looksLikeUid(el.getAttribute(a))) { uid = el.getAttribute(a).trim(); break; }
      if (!uid && el.href) uid = (el.href.match(/armou?ryI[dD]=(\d{5,})/) || [])[1] || null;
      if (!uid) continue;
      const row = rowOf(el);
      const anchor = el.tagName === 'A' ? el : nameElOf(row);
      attach(uid, row, anchor);
    }
  }

  // Data UIDs: place by name only when exactly one row and one data item share that name.
  function placeFromData() {
    const pending = [...fromData.values()].filter((it) => !placed.has(it.uid) && it.name);
    if (!pending.length) return;
    const byName = new Map();
    for (const it of pending) byName.set(norm(it.name), [...(byName.get(norm(it.name)) || []), it]);
    for (const [name, items] of byName) {
      if (items.length !== 1) continue; // identical weapons can't be told apart by name
      const rows = [...document.querySelectorAll('li, tr, [class*="item"]')]
        .filter((r) => !r.closest('#uidf-chip'))
        .filter((r) => { const n = nameElOf(r); return n && norm(n.textContent) === name; })
        .filter((r, _, all) => !all.some((o) => o !== r && r.contains(o))); // innermost match only
      if (rows.length === 1 && !rows[0].querySelector('.uidf-btn')) attach(items[0].uid, rows[0], nameElOf(rows[0]));
    }
  }

  // ---------- the small corner chip for anything that couldn't be placed ----------
  let chip, list, open = false;
  function renderChip() {
    const left = [...fromData.values()].filter((it) => !placed.has(it.uid) && (it.bonuses.length));
    if (!left.length) { if (chip) chip.style.display = 'none'; return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'uidf-chip';
      chip.innerHTML = '<button type="button" class="uidf-toggle"></button><ul></ul>';
      list = chip.querySelector('ul');
      chip.querySelector('.uidf-toggle').addEventListener('click', () => { open = !open; renderChip(); });
      document.body.appendChild(chip);
    }
    chip.style.display = '';
    chip.querySelector('.uidf-toggle').textContent = `🆔 ${left.length} not placed ${open ? '▾' : '▸'}`;
    list.style.display = open ? '' : 'none';
    list.textContent = '';
    for (const it of left) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.textContent = `${it.name}${it.bonuses.length ? ` (${it.bonuses.join(' · ')})` : ''}`;
      li.append(t, makeButton(it.uid, it));
      list.appendChild(li);
    }
  }

  function addStyles() {
    if (document.getElementById('uidf-css')) return;
    const css = document.createElement('style');
    css.id = 'uidf-css';
    css.textContent = `
      .uidf-btn{display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border:1px solid #ff7518;
        border-radius:4px;background:#2b1a0a;color:#ffb070;font:12px/1.4 Arial,sans-serif;cursor:pointer;vertical-align:middle}
      .uidf-btn:hover{background:#ff7518;color:#111}
      .uidf-btn.done{background:#1f7a3a;border-color:#1f7a3a;color:#fff}
      #uidf-chip{position:fixed;left:12px;bottom:12px;z-index:2147483647;font:12px/1.4 Arial,sans-serif;color:#eee;
        max-width:calc(100vw - 24px)}
      #uidf-chip .uidf-toggle{background:#2b1a0a;color:#ffb070;border:1px solid #ff7518;border-radius:14px;padding:4px 10px;cursor:pointer}
      #uidf-chip ul{list-style:none;margin:6px 0 0;padding:6px 8px;background:#1f1f1f;border:1px solid #ff7518;border-radius:6px;max-height:200px;overflow:auto}
      #uidf-chip li{padding:3px 0;display:flex;align-items:center;justify-content:space-between;gap:8px}`;
    document.head.appendChild(css);
  }

  // ---------- run, and re-run as Torn swaps content in ----------
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; run(); }, 400);
  }
  function run() {
    if (!document.body) return;
    addStyles();
    placeFromDom();
    placeFromData();
    renderChip();
  }
  const start = () => {
    run();
    new MutationObserver((muts) => {
      // ignore changes we made ourselves
      if (muts.every((m) => [...m.addedNodes].every((n) => n.nodeType === 1 && (n.classList?.contains('uidf-btn') || n.id === 'uidf-chip')))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
