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

  // The ping role: the one chosen in settings, else any role with "director" in its name.
  function pingRole(c) {
    if (c.roleId) return c.roleId;
    const g = guildOf(c.channelId);
    const r = g?.roles?.cache?.find?.((x) => /director/i.test(x.name));
    return r?.id || null;
  }

  async function describe(c, post, stats) {
    const lines = [];
    const high = stats && stats.total >= c.ping;
    const head = stats
      ? `${high ? '🚨' : '💼'} **${high ? 'High-stat job seeker' : 'New job seeker'}:** [${post.authorName} [${post.authorId}]](${profileUrl(post.authorId)}) · **${fmt(stats.total)}** working stats`
      : `💼 **New job seeker:** [${post.authorName} [${post.authorId}]](${profileUrl(post.authorId)}) · ⚠️ couldn't read their stats`;
    lines.push(head);
    if (stats && (stats.man || stats.int || stats.end)) {
      lines.push(['man', 'int', 'end'].filter((k) => stats[k]).map((k) => `${k.toUpperCase()} ${fmt(stats[k])}`).join(' · '));
    }
    // Activity streak and last action (public, one extra API call).
    try {
      const a = await torn.playerActivity(post.authorId);
      if (a) {
        const streak = a.streak != null ? `🔥 Activity streak: **${fmt(a.streak)} day${a.streak === 1 ? '' : 's'}**${a.bestStreak != null ? ` (best ${fmt(a.bestStreak)})` : ''}` : null;
        const last = a.lastAction ? `${a.status === 'Online' ? '🟢' : a.status === 'Idle' ? '🟡' : '⚫'} last active ${ago(a.lastAction)}` : null;
        if (streak || last) lines.push([streak, last].filter(Boolean).join(' · '));
      }
    } catch { /* streak is a bonus; never block the post */ }
    const body = String(post.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (body) lines.push(`> ${body.length > 350 ? `${body.slice(0, 350)}…` : body}`);
    lines.push(`[View post](${postUrl(c, post.id)}) · [Profile](${profileUrl(post.authorId)}) · posted ${ago(post.time)}`);
    return { text: lines.join('\n'), high };
  }

  // Which posts qualify: min ≤ total; ping when total ≥ ping threshold.
  const qualifies = (c, stats) => (stats ? stats.total >= c.min : !!c.unreadable);

  async function poll() {
    const c = cfg();
    if (!c.enabled || !c.channelId || !torn.enabled() || busy) return;
    busy = true;
    try {
      const posts = await torn.forumPosts(c.threadId, c.lastTime ? c.lastTime - 60 : undefined);
      c.seen ??= [];
      let changed = false;
      for (const p of posts.sort((a, b) => a.time - b.time)) {
        if (c.seen.includes(p.id) || (c.startedAt && p.time < c.startedAt)) continue;
        c.seen.push(p.id);
        c.lastTime = Math.max(c.lastTime || 0, p.time);
        changed = true;
        const stats = parseWorkStats(p.content);
        if (!qualifies(c, stats)) continue;
        const { text, high } = await describe(c, p, stats);
        const role = high ? pingRole(c) : null;
        await send(c.channelId, role ? `<@&${role}> ${text}` : text, { roles: role ? [role] : [] });
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
    const posts = (await torn.forumPosts(c.threadId)).sort((a, b) => b.time - a.time).slice(0, n);
    return posts.map((p) => {
      const s = parseWorkStats(p.content);
      const verdict = !s ? (c.unreadable ? '⚠️ unreadable → would post' : '⚪ unreadable → skipped')
        : s.total >= c.ping ? `🚨 ${fmt(s.total)} → post + ping` : s.total >= c.min ? `💼 ${fmt(s.total)} → post` : `⚪ ${fmt(s.total)} → below ${fmt(c.min)}, skipped`;
      return `• ${p.authorName} [${p.authorId}] · ${verdict}`;
    });
  }

  return { cfg, poll, preview, parseWorkStats, threadUrl };
}

module.exports = { createJobFeed, parseWorkStats, DEFAULTS };
