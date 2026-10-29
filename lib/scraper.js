'use strict';
/**
 * Generic two-step scraping helper (axios + cheerio).
 *
 *   Step 1  getListing(url)  -> list of items { title, image, url } + next page URL
 *   Step 2  getDetail(url)   -> { title, description, links: [{ label, url, host }] }
 *
 * Nothing here throws: every function resolves to { ok: true, ... } or { ok: false, error: { code, message } },
 * so a chat bot can always reply with something sensible.
 *
 * Install:  npm i axios cheerio
 *
 * Only point this at sites whose terms and robots.txt allow automated access, and at content you have the right
 * to share. robots.txt is honoured by default (options.respectRobots).
 */
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 *  1) CONFIGURATION — EDIT THIS BLOCK FOR YOUR TARGET SITE
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *  How to find the right selectors (takes 2 minutes):
 *   1. Open the page in Chrome, right-click an item (a movie card, a post …) -> "Inspect".
 *   2. Find the element that wraps ONE whole item; that is `listing.item` (e.g. '.item-card', 'article.post').
 *   3. Inside it, right-click the title -> Inspect -> note the tag/class -> `listing.title` / `listing.link`.
 *      (Selectors are relative to the item, so write 'h2 a', not 'article.post h2 a'.)
 *   4. Do the same for the thumbnail -> `listing.image`.
 *   5. To test a selector, open DevTools Console and run:   document.querySelectorAll('YOUR_SELECTOR').length
 *      It should equal the number of things you see on screen.
 *   6. The "next page" link usually has rel="next" or a class like .next / .nextpostslink.
 *   7. Detail page: `detail.linkContainer` is the box that holds all the download/media buttons;
 *      `detail.linkItem` is the <a> inside it. If the page has no wrapper, set linkContainer to 'body'.
 *
 *  Tips when something returns nothing:
 *   • "View page source" (Ctrl+U): if the content is NOT in the raw HTML, the site builds it with JavaScript and
 *     axios+cheerio cannot see it — look for a JSON/API endpoint in the Network tab instead, or use a headless browser.
 *   • You can list several selectors separated by commas as fallbacks: 'h2.title a, h3.entry-title a'.
 *   • Lazy-loaded images keep the real URL in data-src / data-lazy-src; this module already checks those.
 */
const SELECTORS = {
  listing: {
    item: '.item-card',                 // wrapper of ONE item on the listing page
    title: '.post-title a',             // title text (relative to item)
    link: '.post-title a',              // <a> whose href is the detail page (relative to item)
    image: '.post-thumbnail img',       // thumbnail <img> (relative to item)
    nextPage: 'a.next, a[rel="next"]',  // "next page" link on the listing page
  },
  detail: {
    title: 'h1.entry-title, h1',        // main title
    description: '.entry-content p, .description, .overview', // paragraphs joined into the description
    linkContainer: '.download-section', // box(es) that contain the download / media buttons
    linkItem: 'a.download-btn',         // each download <a> inside the container
    linkLabelAttr: null,                // optional: read the label from an attribute (e.g. 'title') instead of text
  },
};

const DEFAULTS = {
  timeoutMs: 15000,
  retries: 2,                  // extra attempts on network errors / 429 / 5xx
  retryDelayMs: 800,           // doubled each retry
  maxBytes: 5 * 1024 * 1024,   // refuse pages bigger than this
  maxItems: 100,
  respectRobots: true,
  allowPrivateHosts: false,    // keep false in production (SSRF protection); true only for local testing
  userAgent: null,             // null = rotate through USER_AGENTS
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 *  2) SMALL HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
class ScrapeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = err => ({ ok: false, error: { code: err.code || 'ERROR', message: err.message || String(err) } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const pick = (arr, i) => arr[i % arr.length];
let uaCounter = Math.floor(Math.random() * USER_AGENTS.length);

function parseHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new ScrapeError('BAD_URL', `Not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ScrapeError('BAD_URL', 'Only http/https URLs are allowed.');
  return u;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  return true;
}

// The bot may receive URLs from users, so never let it be pointed at localhost / internal networks.
async function assertPublicHost(u, allowPrivate) {
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new ScrapeError('DNS', `Could not resolve ${host}`);
  });
  if (addrs.some(a => isPrivateIp(a.address))) throw new ScrapeError('BLOCKED_HOST', 'Refusing to fetch a private/internal address.');
}

/* ── robots.txt (simple, cached per origin) ─────────────────────────────────────────────────── */
const robotsCache = new Map();
async function robotsAllows(u, opts) {
  const origin = u.origin;
  let rules = robotsCache.get(origin);
  if (!rules || Date.now() - rules.at > 3600000) {
    rules = { at: Date.now(), disallow: [], allow: [] };
    try {
      const res = await axios.get(`${origin}/robots.txt`, {
        timeout: 8000, maxContentLength: 512 * 1024, responseType: 'text', validateStatus: s => s < 500,
        headers: { 'User-Agent': opts.userAgent || USER_AGENTS[0] },
      });
      if (res.status === 200 && typeof res.data === 'string') {
        let applies = false, seenAgent = false;
        for (const rawLine of res.data.split(/\r?\n/)) {
          const line = rawLine.split('#')[0].trim();
          const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
          if (!m) continue;
          const key = m[1].toLowerCase(), val = m[2].trim();
          if (key === 'user-agent') { if (seenAgent === false || !applies) applies = val === '*'; else applies = applies || val === '*'; seenAgent = true; continue; }
          seenAgent = false;
          if (!applies) continue;
          if (key === 'disallow' && val) rules.disallow.push(val);
          if (key === 'allow' && val) rules.allow.push(val);
        }
      }
    } catch { /* robots.txt unreachable -> treat as allowed */ }
    robotsCache.set(origin, rules);
  }
  const target = u.pathname + u.search;
  const longest = list => list.filter(p => target.startsWith(p.replace(/\*.*$/, ''))).reduce((n, p) => Math.max(n, p.length), -1);
  return longest(rules.allow) >= longest(rules.disallow);
}

/* ── HTTP ───────────────────────────────────────────────────────────────────────────────────── */
async function fetchHtml(rawUrl, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const u = parseHttpUrl(rawUrl);
  await assertPublicHost(u, opts.allowPrivateHosts);
  if (opts.respectRobots && !(await robotsAllows(u, opts))) throw new ScrapeError('ROBOTS', 'Blocked by the site\'s robots.txt.');

  let lastErr;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await axios.get(u.toString(), {
        timeout: opts.timeoutMs,
        maxContentLength: opts.maxBytes,
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: () => true,
        headers: {
          'User-Agent': opts.userAgent || pick(USER_AGENTS, uaCounter++),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });
      if (res.status === 429 || res.status >= 500) throw new ScrapeError('HTTP_' + res.status, `Server answered ${res.status}`);
      if (res.status === 403 || res.status === 401) throw Object.assign(new ScrapeError('FORBIDDEN', `Access denied (${res.status}); the site may block bots.`), { noRetry: true });
      if (res.status === 404) throw Object.assign(new ScrapeError('NOT_FOUND', 'Page not found (404).'), { noRetry: true });
      if (res.status >= 400) throw Object.assign(new ScrapeError('HTTP_' + res.status, `Server answered ${res.status}`), { noRetry: true });
      const type = String(res.headers['content-type'] || '');
      if (type && !/html|xml|text/i.test(type)) throw Object.assign(new ScrapeError('NOT_HTML', `Unexpected content type: ${type}`), { noRetry: true });
      return { html: String(res.data), finalUrl: res.request?.res?.responseUrl || u.toString() };
    } catch (err) {
      lastErr = err.code && err instanceof ScrapeError ? err
        : new ScrapeError(err.code === 'ECONNABORTED' ? 'TIMEOUT' : (err.code || 'NETWORK'), err.message);
      if (err.noRetry || attempt === opts.retries) break;
      await sleep(opts.retryDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

const abs = (href, base) => { try { return new URL(href, base).toString(); } catch { return ''; } };
const imgSrc = ($img, base) => {
  if (!$img || !$img.length) return '';
  const set = $img.attr('data-srcset') || $img.attr('srcset');
  const raw = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('data-original') || $img.attr('src') ||
    (set ? set.split(',')[0].trim().split(' ')[0] : '');
  return raw && !raw.startsWith('data:') ? abs(raw, base) : '';
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 *  3) STEP 1 — LISTING PAGE
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
async function getListing(url, options = {}) {
  const sel = { ...SELECTORS.listing, ...(options.selectors || {}) };
  try {
    const { html, finalUrl } = await fetchHtml(url, options);
    const $ = cheerio.load(html);
    const seen = new Set();
    const items = [];

    $(sel.item).each((_, el) => {
      if (items.length >= (options.maxItems || DEFAULTS.maxItems)) return false;
      const $el = $(el);
      const $a = $el.find(sel.link).first();
      const link = abs($a.attr('href') || '', finalUrl);
      const title = clean($el.find(sel.title).first().text() || $a.attr('title') || $el.find(sel.image).first().attr('alt'));
      if (!link || !title || seen.has(link)) return;
      seen.add(link);
      items.push({ title, image: imgSrc($el.find(sel.image).first(), finalUrl), url: link });
    });

    if (!items.length) throw new ScrapeError('NO_ITEMS', 'No items matched. Check SELECTORS.listing (see the comment block at the top).');
    const next = abs($(sel.nextPage).first().attr('href') || '', finalUrl);
    return { ok: true, source: finalUrl, count: items.length, items, nextPage: next || null };
  } catch (err) { return fail(err); }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 *  4) STEP 2 — DETAIL PAGE
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
async function getDetail(url, options = {}) {
  const sel = { ...SELECTORS.detail, ...(options.selectors || {}) };
  try {
    const { html, finalUrl } = await fetchHtml(url, options);
    const $ = cheerio.load(html);

    const title = clean($(sel.title).first().text()) || clean($('title').first().text());
    const description = $(sel.description).map((_, p) => clean($(p).text())).get().filter(Boolean).join('\n\n').slice(0, 1500);

    const links = [];
    const seen = new Set();
    $(sel.linkContainer).find(sel.linkItem).each((_, a) => {
      const $a = $(a);
      const href = abs($a.attr('href') || '', finalUrl);
      if (!/^https?:/i.test(href) || seen.has(href)) return;
      seen.add(href);
      const label = clean((sel.linkLabelAttr && $a.attr(sel.linkLabelAttr)) || $a.text() || $a.attr('title')) || 'Link';
      let host = ''; try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      links.push({ label, url: href, host });
    });

    if (!title && !links.length) throw new ScrapeError('NO_DATA', 'Nothing matched. Check SELECTORS.detail (see the comment block at the top).');
    return { ok: true, source: finalUrl, title, description, links };
  } catch (err) { return fail(err); }
}

/** Convenience: step 1 + step 2 for the n-th listing item (0-based). */
async function scrapeItem(listUrl, index = 0, options = {}) {
  const list = await getListing(listUrl, options);
  if (!list.ok) return list;
  const item = list.items[index];
  if (!item) return fail(new ScrapeError('NO_SUCH_ITEM', `The list has only ${list.items.length} items.`));
  const detail = await getDetail(item.url, options);
  return detail.ok ? { ...detail, listing: item } : detail;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 *  5) FORMATTING FOR CHAT MESSAGES (WhatsApp markdown: *bold*, _italic_)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
function formatListing(result, { page = 1 } = {}) {
  if (!result.ok) return `❌ ${result.error.message}`;
  const lines = [`📚 *Results* (page ${page})`, ''];
  result.items.forEach((it, i) => lines.push(`*${i + 1}.* ${it.title}`));
  lines.push('', 'Reply with a number to open it.');
  if (result.nextPage) lines.push('➡️ Type *next* for more.');
  return lines.join('\n');
}

function formatDetail(result) {
  if (!result.ok) return `❌ ${result.error.message}`;
  const lines = [`🎬 *${result.title}*`];
  if (result.description) lines.push('', result.description.slice(0, 700));
  if (result.links.length) {
    lines.push('', '🔗 *Links*');
    result.links.forEach((l, i) => lines.push(`${i + 1}. ${l.label}${l.host ? ` _(${l.host})_` : ''}\n${l.url}`));
  } else lines.push('', '_No links found on this page._');
  return lines.join('\n');
}

module.exports = { SELECTORS, DEFAULTS, getListing, getDetail, scrapeItem, formatListing, formatDetail, fetchHtml };

/* ── Example ──────────────────────────────────────────────────────────────────────────────────
 * const { getListing, getDetail, formatListing, formatDetail } = require('./scraper');
 * const list = await getListing('https://example.com/category/page/1/');
 * await sock.sendMessage(jid, { text: formatListing(list) });
 * const detail = await getDetail(list.items[0].url);
 * await sock.sendMessage(jid, { text: formatDetail(detail) });
 *
 * Per-call selector overrides (no need to edit the config block):
 * getListing(url, { selectors: { item: 'article.post', title: 'h2 a', link: 'h2 a', image: 'img' } });
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
