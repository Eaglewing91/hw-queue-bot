// Job-seekers forum feed for The Necromancer.
//
// Reads ONE Torn forum thread through the official Torn API (forum > posts, public access),
// pulls the working stats people write in their posts, and posts qualifying ones in a
// Discord channel. It never loads torn.com pages. Stats are self-reported in the post text.

// ---------- reading working stats out of a post ----------
// "82,500" "82.5k" "82k" "1.2m" "82 500" → number
function num(raw) {
  if (!raw) return null;
  const m = String(raw).trim().toLowerCase().match(/^([\d][\d.,\s]*)\s*([km]?)/);
  if (!m) return null;
  let digits = m[1].replace(/\s/g, '');
  const suffix = m[2];
  if (suffix) {
    digits = digits.replace(/,/g, '.'); // "82,5k" → 82.5
    const v = parseFloat(digits);
    return Number.isFinite(v) ? Math.round(v * (suffix === 'k' ? 1e3 : 1e6)) : null;
  }
  // "82.500" or "82,500" thousands separators
  if (/^\d{1,3}([.,]\d{3})+$/.test(digits)) return Number(digits.replace(/[.,]/g, ''));
  const v = parseFloat(digits.replace(/,/g, ''));
  return Number.isFinite(v) ? Math.round(v) : null;
}

const NUM = '(\\d[\\d.,\\s]*\\s*[kKmM]?)\\b';
const STAT = {
  man: new RegExp(`\\b(?:man(?:ual)?(?:\\s*lab(?:ou?r)?)?|ml)\\b\\s*[:=\\-–]?\\s*${NUM}`, 'i'),
  int: new RegExp(`\\b(?:int(?:el+igence|el+)?|intel)\\b\\s*[:=\\-–]?\\s*${NUM}`, 'i'),
  end: new RegExp(`\\b(?:end(?:urance)?)\\b\\s*[:=\\-–]?\\s*${NUM}`, 'i'),
};
const TOTAL = [
  new RegExp(`\\btotal\\s*(?:work(?:ing)?\\s*stats?|ws|stats?)?\\s*[:=\\-–]?\\s*${NUM}`, 'i'),
  new RegExp(`\\b(?:work(?:ing)?\\s*stats?|tws|ws)\\s*(?:total)?\\s*(?:of|are|is|at)?\\s*[:=\\-–]?\\s*${NUM}`, 'i'),
  new RegExp(`${NUM}\\s*(?:total\\s*)?(?:work(?:ing)?\\s*stats?|tws|ws)\\b`, 'i'),
];
const SANE = (v) => Number.isFinite(v) && v >= 100 && v <= 50_000_000;

// Returns { total, man, int, end, how } or null if no stats could be read.
function parseWorkStats(text) {
  const t = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const parts = {};
  for (const [k, re] of Object.entries(STAT)) {
    const m = t.match(re);
    const v = m && num(m[1]);
    if (SANE(v)) parts[k] = v;
  }
  let total = null;
  for (const re of TOTAL) {
    const m = t.match(re);
    const v = m && num(m[1]);
    if (SANE(v) && v >= 1000) { total = v; break; }
  }
  const sum = parts.man && parts.int && parts.end ? parts.man + parts.int + parts.end : null;
  if (total) return { total, ...parts, how: 'total' };
  if (sum) return { total: sum, ...parts, how: 'sum' };
  return null;
}

// ---------- the feed ----------
const DEFAULTS = { threadId: 15907925, forumId: 46, min: 50_000, ping: 150_000, unreadable: false };
const fmt = (n) => Number(n).toLocaleString('en-GB');
const ago = (unix) => (unix ? `<t:${Math.floor(unix)}:R>` : 'unknown');

function createJobFeed({ getState, save, torn, send, guildOf }) {
  const cfg = () => {
    const s = getState();
    s.jobs ??= {};
    return Object.assign(s.jobs, { ...DEFAULTS, ...s.jobs });
  };
  let busy = false;

  const threadUrl = (c) => `https://www.torn.com/forums.php#/p=threads&f=${c.forumId}&t=${c.threadId}&b=0&a=0`;
  const postUrl = (c, id) => `${threadUrl(c)}&to=${id}`;
  const profileUrl = (id) => `https://www.torn.com/profiles.php?XID=${id}`;
  const mailUrl = (id) => `https://www.torn.com/messages.php#/p=compose&XID=${id}`;

  // The ping role: the one chosen in settings, else any role with "director" in its name.
  function pingRole(c) {
    if (c.roleId) return c.roleId;
    const g = guildOf(c.channelId);
    const r = g?.roles?.cache?.find?.((x) => /director/i.test(x.name));
    return r?.id || null;
  }

  // A Discord embed card: title, poster, stats / breakdown / activity in columns, the post, link buttons.
  async function describe(c, post, stats) {
    const high = !!stats && stats.total >= c.ping;
    // One "Working stats" list: MAN / INT / END (when given), then the total.
    const statLines = stats
      ? [...['man', 'int', 'end'].filter((k) => stats[k]).map((k) => `${k.toUpperCase()}: ${fmt(stats[k])}`), `**Total: ${fmt(stats.total)}**`]
      : ["⚠️ Couldn't read"];
    const fields = [{ name: 'Working stats', value: statLines.join('\n'), inline: true }];
    // Activity streak and last action (public, one or two extra API calls).
    try {
      const a = await torn.playerActivity(post.authorId);
      if (a) {
        const dot = a.status === 'Online' ? '🟢' : a.status === 'Idle' ? '🟡' : '⚫';
        const v = [
          a.streak != null ? `🔥 ${fmt(a.streak)}-day streak` : null,
          a.lastAction ? `${dot} ${ago(a.lastAction)}` : null,
        ].filter(Boolean).join('\n');
        if (v) fields.push({ name: 'Activity', value: v, inline: true });
      }
    } catch { /* activity is a bonus; never block the post */ }
    const body = String(post.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (body) fields.push({ name: 'Their post', value: `> *${(body.length > 400 ? `${body.slice(0, 400)}…` : body).replace(/\*/g, '\\*')}*`, inline: false });
    const embed = {
      color: high ? 0xda373c : 0xff7518,
      title: high ? '🚨 High-stat job seeker' : '💼 New job seeker',
      author: { name: `${post.authorName} [${post.authorId}]`, url: profileUrl(post.authorId) },
      fields,
      footer: { text: 'Job-seekers thread · posted' },
      timestamp: post.time ? new Date(post.time * 1000).toISOString() : undefined,
    };
    const components = [{ type: 1, components: [
      { type: 2, style: 5, label: 'Profile', url: profileUrl(post.authorId) },
      { type: 2, style: 5, label: 'Mail', url: mailUrl(post.authorId) },
    ] }];
    return { embed, components, high };
  }

  // Which posts qualify: min ≤ total; ping when total ≥ ping threshold.
  const qualifies = (c, stats) => (stats ? stats.total >= c.min : !!c.unreadable);

  async function poll() {
    const c = cfg();
    if (!c.enabled || !c.channelId || !torn.enabled() || busy) return;
    busy = true;
    try {
      // Page forward from the last post we saw (Torn returns up to 100 per call).
      let posts = [];
      let from = (c.lastTime || Math.floor(Date.now() / 1000)) - 60;
      for (let page = 0; page < 5; page++) {
        const batch = await torn.forumPosts(c.threadId, from);
        posts.push(...batch);
        if (batch.length < 100) break;
        const newest = Math.max(...batch.map((p) => p.time));
        if (!(newest > from)) break;
        from = newest;
      }
      posts = [...new Map(posts.map((p) => [p.id, p])).values()];
      c.seen ??= [];
      let changed = false;
      for (const p of posts.sort((a, b) => a.time - b.time)) {
        if (c.seen.includes(p.id) || (c.startedAt && p.time < c.startedAt)) continue;
        c.seen.push(p.id);
        c.lastTime = Math.max(c.lastTime || 0, p.time);
        changed = true;
        const stats = parseWorkStats(p.content);
        if (!qualifies(c, stats)) continue;
        const { embed, components, high } = await describe(c, p, stats);
        const role = high ? pingRole(c) : null;
        await send(c.channelId, {
          content: role ? `<@&${role}> High-stat job seeker` : '',
          embeds: [embed], components, allowedMentions: { parse: [], roles: role ? [role] : [] },
        });
        c.posted = (c.posted || 0) + 1;
      }
      c.seen = c.seen.slice(-500);
      c.lastOkAt = Date.now();
      c.lastError = null;
      if (changed) save();
    } catch (err) {
      c.lastError = torn.explain(err);
      console.error('Job feed check failed:', c.lastError);
    } finally {
      busy = false;
    }
  }

  // Preview what the bot would do with the latest posts (nothing is posted).
  async function preview(n = 10) {
    const c = cfg();
    // Ask for recent posts (the thread is huge; without a start time Torn returns page 1).
    let posts = [];
    for (const days of [3, 14, 60]) {
      let from = Math.floor(Date.now() / 1000) - days * 86400;
      posts = [];
      for (let page = 0; page < 20; page++) {
        const batch = await torn.forumPosts(c.threadId, from);
        posts.push(...batch);
        if (batch.length < 100) break;
        const newest = Math.max(...batch.map((p) => p.time));
        if (!(newest > from)) break;
        from = newest;
      }
      if (posts.length) break;
    }
    posts = [...new Map(posts.map((p) => [p.id, p])).values()].sort((a, b) => b.time - a.time).slice(0, n);
    return posts.map((p) => {
      const s = parseWorkStats(p.content);
      const snippet = String(p.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
      const verdict = !s ? (c.unreadable ? '⚠️ unreadable → would post' : '⚪ unreadable → skipped')
        : s.total >= c.ping ? `🚨 ${fmt(s.total)} → post + ping` : s.total >= c.min ? `💼 ${fmt(s.total)} → post` : `⚪ ${fmt(s.total)} → below ${fmt(c.min)}, skipped`;
      return `• ${p.authorName} [${p.authorId}] <t:${p.time}:R> · ${verdict}${s ? '' : `\n  -# "${snippet}${snippet.length >= 70 ? '…' : ''}"`}`;
    });
  }

  return { cfg, poll, preview, parseWorkStats, threadUrl };
}

module.exports = { createJobFeed, parseWorkStats, DEFAULTS };
