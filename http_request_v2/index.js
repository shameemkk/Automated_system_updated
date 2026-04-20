import 'dotenv/config';
import * as cheerio from 'cheerio';

// Configuration
const MAX_DEPTH = Math.max(1, parseInt(process.env.MAX_DEPTH, 10) || 2);
const parsedSubpageConcurrency = parseInt(process.env.SUBPAGE_CONCURRENCY, 10);
const SUBPAGE_CONCURRENCY = Math.max(
  1,
  Number.isFinite(parsedSubpageConcurrency) ? parsedSubpageConcurrency : 10
);
const parsedPerHostConcurrency = parseInt(process.env.PER_HOST_CONCURRENCY, 10);
const PER_HOST_CONCURRENCY = Math.max(
  1,
  Number.isFinite(parsedPerHostConcurrency) ? parsedPerHostConcurrency : 3
);
const rawScrapeDelayMin = parseInt(process.env.SCRAPE_DELAY_MIN_MS, 10);
const rawScrapeDelayMax = parseInt(process.env.SCRAPE_DELAY_MAX_MS, 10);
const SCRAPE_DELAY_MIN_MS = Math.max(0, Number.isFinite(rawScrapeDelayMin) ? rawScrapeDelayMin : 0);
const SCRAPE_DELAY_MAX_MS = Math.max(
  SCRAPE_DELAY_MIN_MS,
  Number.isFinite(rawScrapeDelayMax) ? rawScrapeDelayMax : SCRAPE_DELAY_MIN_MS
);
const MAX_LINKS_PER_PAGE = Math.max(1, parseInt(process.env.MAX_LINKS_PER_PAGE, 10) || 50);
const PAGE_NAVIGATION_TIMEOUT_MS = Math.max(5000, parseInt(process.env.PAGE_NAVIGATION_TIMEOUT_MS, 10) || 15000);
const MAX_STORED_VISITED_URLS = Math.max(1, parseInt(process.env.MAX_STORED_VISITED_URLS, 10) || 200);
const MAX_SUBPAGE_CRAWLS = Math.max(1, parseInt(process.env.MAX_SUBPAGE_CRAWLS, 10) || 20);
const OVERALL_TIMEOUT_MS = Math.max(10000, parseInt(process.env.OVERALL_TIMEOUT_MS, 10) || 120000);

// =========================================================================
// EMAIL FILTERING
// =========================================================================

const BLOCKED_DOMAINS = new Set([
  'sentry.io', 'sentry.wixpress.com', 'sentry-next.wixpress.com', 'ingest.sentry.io',
  'newrelic.com', 'rollbar.com', 'datadoghq.com', 'bugsnag.com',
  'wordpress.com', 'wordpress.org', 'wpengine.com', 'wix.com', 'squarespace.com',
  'shopify.com', 'shopifyemail.com', 'bigcommerce.com', 'weebly.com', 'webflow.io',
  'ghost.org', 'godaddy.com', 'cloudflare.com', 'cloudfront.net', 'amazonaws.com',
  'azure.com', 'digitalocean.com', 'linode.com', 'heroku.com', 'netlify.app',
  'vercel.app', 'render.com', 'cloudwaysapps.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com',
  'fonts.googleapis.com', 'use.typekit.net', 'latofonts.com', 'fontsquirrel.com',
  'myfonts.com', 'antsoup.com', 'latinotype.com', 'fontfabric.com', 'fontspring.com',
  'typenetwork.com', 'fonts.net', 'monotype.com', 'linotype.com', 'myfonts.net',
  'typekit.com', 'fontdeck.com', 'webtype.com', 'typography.com', 'paratype.com',
  'exljbris.com', 'daltonmaag.com', 'marksimonson.com', 'processtypefoundry.com',
  'hvdfonts.com', 'boldmonday.com', 'typotheque.com', 'typefront.com',
  'example.com', 'domain.com', 'email.com', 'mysite.com', 'sample.com', 'test.com',
  'yoursite.com', 'companyname.com', 'business.com', 'website.com', 'businessname.com',
  'company.com', 'info.com', 'domain.co', 'domain.net', 'yourdomain.com',
  'yourcompany.com', 'youremail.com', 'sitename.com', 'placeholder.com',
  'mailinator.com', 'tempmail.com', 'throwaway.email', 'guerrillamail.com', 'mailbox.com',
  'developer.wordpress.org', 'developer.woocommerce.com', 'developer.joomla.org',
  'developer.drupal.org', 'developer.magento.com', 'developer.prestashop.com',
  'developer.opencart.com', 'developer.shopware.com', 'developer.bigcartel.com',
  'developer.webflow.com', 'developer.squarespace.com', 'developer.ghost.org',
  'developer.weebly.com', 'developer.wix.com'
]);

const BLOCKED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'firstname', 'lastname', 'yourname', 'fullname', 'username', 'user.name',
  'johnsmith', 'john.doe', 'alex.smith', 'jane.doe', 'user', 'filler', 'placeholder',
  'your', 'name', 'email', 'test', 'testing', 'demo', 'sample', 'example',
  'admin', 'webmaster', 'postmaster', 'hostmaster', 'root', 'mailer-daemon',
  'null', 'devnull', 'abuse', 'no.reply', 'do.not.reply',
  'your.email', 'your.name', 'first.last', 'yourmail', 'youremail', 'changeme',
  'someone', 'somebody', 'anyone', 'person', 'customer'
]);

const JUNK_EMAIL_REGEX = /^[%\s?&]|^@|@.*@|\.(?:css|js|json|xml|map|min\.js|min\.css|woff|woff2|ttf|eot|pdf)$|\.(?:png|jpg|jpeg|gif|svg|webp|ico)$|@\d+x\.(?:png|jpg|jpeg|gif|svg|webp)$|^(?:sprite|icon|logo|banner|image|font)|%[0-9a-f]{2}|\?|subject=|body=|&|@o\d+\.ingest\.sentry\.io|wixpress\.com$|sentry|shoplocal|news\.cfm/;

function hasBlockedDomainSuffix(domain) {
  if (BLOCKED_DOMAINS.has(domain)) return true;
  let i = domain.indexOf('.');
  while (i !== -1) {
    if (BLOCKED_DOMAINS.has(domain.slice(i + 1))) return true;
    i = domain.indexOf('.', i + 1);
  }
  return false;
}

function isJunkEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const normalized = email.toLowerCase().trim();
  if (JUNK_EMAIL_REGEX.test(normalized)) return true;
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex < 1 || atIndex === normalized.length - 1) return true;
  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (localPart.length < 2 || domain.length < 4 || !domain.includes('.')) return true;
  if (BLOCKED_LOCAL_PARTS.has(localPart)) return true;
  if (hasBlockedDomainSuffix(domain)) return true;
  return false;
}

function filterEmails(emails) {
  if (!emails || emails.length === 0) return [];
  const out = [];
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    if (isValidEmail(e) && !isJunkEmail(e)) out.push(e);
  }
  return out;
}

const EARLY_EXIT_EMAIL_THRESHOLD = 10;

// =========================================================================
// HTTP IDENTITY / PROXY ROTATION
// =========================================================================

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0'
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.8,fr;q=0.6',
  'en-US,en;q=0.8,es;q=0.6'
];

const REFERERS = [
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://duckduckgo.com/',
  'https://search.yahoo.com/'
];

let identityCursor = 0;

function getNextIdentity() {
  const index = identityCursor++;
  return {
    userAgent: USER_AGENTS[index % USER_AGENTS.length],
    acceptLanguage: ACCEPT_LANGUAGES[index % ACCEPT_LANGUAGES.length],
    referer: REFERERS[index % REFERERS.length],
  };
}

// =========================================================================
// EMAIL & URL EXTRACTION
// =========================================================================

const INVALID_EMAIL_TLDS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp',
  'css', 'js', 'map', 'json', 'xml', 'woff', 'woff2', 'ttf', 'eot',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'pdf', 'zip', 'gz',
]);

const EMAIL_STRUCTURAL_REGEX = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.toLowerCase().trim();
  const len = e.length;
  if (len < 6 || len > 254) return false;
  if (!EMAIL_STRUCTURAL_REGEX.test(e)) return false;
  const atIdx = e.indexOf('@');
  const local = e.slice(0, atIdx);
  if (local.length > 64) return false;
  const domain = e.slice(atIdx + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (INVALID_EMAIL_TLDS.has(tld)) return false;
  if (local.indexOf('..') !== -1 || domain.indexOf('..') !== -1) return false;
  const first = local.charCodeAt(0);
  if (first === 46 || first === 45 || first === 95 || first === 43) return false;
  const last = local.charCodeAt(local.length - 1);
  if (last === 46 || last === 45 || last === 95 || last === 43) return false;
  return true;
}

const FB_FULL_URL_REGEX = /https?(?::\/\/|:\\\/\\\/|%3A%2F%2F)(?:www\.)?(?:facebook\.com|fb\.com)[^\s"'<>\\)]+/gi;
const FB_BARE_REGEX = /(?:facebook\.com|fb\.com)\/[^\s"'<>\\)]+/gi;
const FB_TRUNCATE_DELIMS = /%22|%27|%2C/i;
const FB_TRACKING_PARAMS = new Set([
  'fbclid', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'mibextid', 'ref', 'refid',
  'sk', 'pnref', 'hc_ref', '__tn__', '__tn', '_rdc', '_rdr',
  'notif_id', 'notif_t', 'ref_src', 'rf', 'source', '_ft_',
  'hc_location', 'eid', 'tsid', 'locale', 'hl',
]);
const FB_ALLOWED_SHORT_SEGMENTS = new Set(['p', 'sharer.php', 'share.php']);

function truncateFbCandidate(u) {
  let clean = u.split(FB_TRUNCATE_DELIMS)[0];
  const secondHttp = clean.indexOf('http', 10);
  if (secondHttp > 0) clean = clean.slice(0, secondHttp);
  return clean;
}

function extractFacebookUrls(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (text.indexOf('facebook.com') === -1 && text.indexOf('fb.com') === -1) return [];

  const candidates = new Set();

  FB_FULL_URL_REGEX.lastIndex = 0;
  let match;
  while ((match = FB_FULL_URL_REGEX.exec(text)) !== null) {
    candidates.add(truncateFbCandidate(match[0]));
  }

  FB_BARE_REGEX.lastIndex = 0;
  while ((match = FB_BARE_REGEX.exec(text)) !== null) {
    candidates.add(truncateFbCandidate(`https://${match[0]}`));
  }

  const results = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeFacebookCandidate(candidate);
    if (normalized) results.add(normalized);
  }

  return Array.from(results);

  function normalizeFacebookCandidate(rawValue, depth = 0) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    if (depth > 3) return null;

    let value = rawValue.trim();
    if (!value) return null;

    value = value
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002F/gi, '/')
      .replace(/\\u003A/gi, ':')
      .replace(/\\x2F/gi, '/')
      .replace(/\\x3A/gi, ':')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
      .replace(/&amp;/gi, '&')
      .replace(/^['"`]+|['"`]+$/g, '');

    if (/^https?%3A%2F%2F/i.test(value) || value.includes('%2F') || value.includes('%3A')) {
      try { value = decodeURIComponent(value); } catch {}
    }

    if (!/^https?:\/\//i.test(value)) {
      if (value.startsWith('//')) {
        value = `https:${value}`;
      } else if (/^(?:www\.)?(facebook\.com|fb\.com)/i.test(value)) {
        value = `https://${value.replace(/^https?:\\\/\\\//i, '')}`;
      }
    }

    value = value.replace(/\/+$/, '');

    let urlObj;
    try { urlObj = new URL(value); } catch { return null; }

    let hostname = urlObj.hostname.toLowerCase();
    if (
      hostname !== 'facebook.com' && !hostname.endsWith('.facebook.com') &&
      hostname !== 'fb.com' && !hostname.endsWith('.fb.com')
    ) {
      return null;
    }
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
      urlObj.hostname = hostname;
    }

    if (hostname.endsWith('facebook.com') && urlObj.pathname === '/l.php') {
      const forwarded = urlObj.searchParams.get('u') || urlObj.searchParams.get('href');
      if (forwarded) return normalizeFacebookCandidate(forwarded, depth + 1);
    }

    if (hostname === 'facebook.com' && urlObj.pathname.toLowerCase() === '/profile.php') {
      const id = urlObj.searchParams.get('id');
      if (!id) return null;
      urlObj.pathname = '/profile.php';
      urlObj.search = `?id=${encodeURIComponent(id)}`;
      urlObj.hash = '';
      return urlObj.toString();
    }

    for (const param of FB_TRACKING_PARAMS) urlObj.searchParams.delete(param);
    urlObj.hash = '';
    const searchString = urlObj.searchParams.toString();
    urlObj.search = searchString ? `?${searchString}` : '';
    urlObj.pathname = urlObj.pathname.toLowerCase().replace(/\/+$/, '') || '/';

    const path = urlObj.pathname;
    let segStart = 0;
    while (segStart < path.length && path.charCodeAt(segStart) === 47) segStart++;
    let segEnd = path.indexOf('/', segStart);
    if (segEnd === -1) segEnd = path.length;
    const firstPathSegment = path.slice(segStart, segEnd);
    if (
      firstPathSegment.length > 0 &&
      firstPathSegment.length < 2 &&
      !FB_ALLOWED_SHORT_SEGMENTS.has(firstPathSegment.toLowerCase())
    ) {
      return null;
    }

    return urlObj.toString();
  }
}

// =========================================================================
// LINK COLLECTION
// =========================================================================

function cleanUrl(url) {
  try {
    const urlObj = new URL(url);
    urlObj.hash = '';
    return urlObj.href;
  } catch {
    return url.split('#')[0];
  }
}

function generateCommonPageVariants(pagePath) {
  const variants = new Set();
  if (typeof pagePath !== 'string') return variants;
  const trimmed = pagePath.trim();
  if (!trimmed) return variants;
  const ensureTrailingSlash = (v) => v && !v.endsWith('/') ? `${v}/` : v;
  const withoutLeadingSlash = trimmed.replace(/^\/+/, '');
  variants.add(trimmed);
  variants.add(ensureTrailingSlash(trimmed));
  if (withoutLeadingSlash) {
    variants.add(withoutLeadingSlash);
    variants.add(ensureTrailingSlash(withoutLeadingSlash));
    const withLeadingSlash = `/${withoutLeadingSlash}`;
    variants.add(withLeadingSlash);
    variants.add(ensureTrailingSlash(withLeadingSlash));
  }
  return variants;
}

const COMMON_PAGE_PATHS = ['/about/', '/contact/', '/about-us/', '/contact-us/', '/privacy/', '/terms'];

const EXCLUDED_FILE_EXTENSIONS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', 'tar', 'gz', '7z',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4a', 'ogg'
]);

export function isNonHtmlResource(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.split('.').pop()?.split(/[?#]/)[0] || '';
    return ext && EXCLUDED_FILE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isSiblingPage(baseUrl, candidateUrl) {
  const baseParts = baseUrl.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const candParts = candidateUrl.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (baseParts.length < 3) return false;
  if (candParts.length === baseParts.length && candParts.join('/') !== baseParts.join('/')) return true;
  if (
    candParts.length >= 1 &&
    candParts.length < baseParts.length &&
    baseParts.slice(0, candParts.length).join('/') === candParts.join('/')
  ) {
    return true;
  }
  return false;
}

function createSameDomainLinkCollector(baseUrlHref) {
  const baseUrl = new URL(baseUrlHref);
  const normalizedCurrentUrl = cleanUrl(baseUrl.href);
  const prioritizedLinks = [];
  const seenLinks = new Set();
  const canAddMore = () => prioritizedLinks.length < MAX_LINKS_PER_PAGE;

  const addCandidateLink = (candidate) => {
    if (!candidate || !canAddMore()) return;
    if (isNonHtmlResource(candidate)) return;
    try {
      const linkUrl = new URL(candidate, baseUrl.href);
      if (linkUrl.origin !== baseUrl.origin) return;
      if (isSiblingPage(baseUrl, linkUrl)) return;
      const finalUrl = cleanUrl(linkUrl.href);
      if (finalUrl === normalizedCurrentUrl || seenLinks.has(finalUrl)) return;
      seenLinks.add(finalUrl);
      prioritizedLinks.push(finalUrl);
    } catch {}
  };

  const addCommonPages = () => {
    if (!canAddMore()) return;
    for (const pagePath of COMMON_PAGE_PATHS) {
      if (!canAddMore()) break;
      const variants = generateCommonPageVariants(pagePath);
      for (const variant of variants) {
        if (!canAddMore()) break;
        addCandidateLink(variant);
      }
    }
  };

  return { addCandidateLink, addCommonPages, getLinks: () => prioritizedLinks };
}

// =========================================================================
// UTILITIES
// =========================================================================

async function runWithConcurrency(items, limit, iteratee) {
  if (!Array.isArray(items) || items.length === 0) return;
  const normalizedLimit = Math.max(1, Number.isFinite(limit) ? limit : 1);
  let currentIndex = 0;
  const worker = async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      await iteratee(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, () => worker());
  await Promise.all(workers);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// HTTP FETCHING
// =========================================================================

async function fetchHtml(url, identity, signal) {
  const headers = {
    'User-Agent': identity.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': identity.acceptLanguage,
    ...(identity.referer ? { Referer: identity.referer } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_NAVIGATION_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('text/')) {
      throw new Error(`Non-HTML content: ${contentType}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

// =========================================================================
// HTML DATA EXTRACTION (cheerio)
// =========================================================================

function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const emailSet = new Set();
  const fbRaw = [];
  const candidateSet = new Set();

  const FB_SCRIPT_REGEX = /https?(?:[:\\/]{1,5}|%3A%2F%2F)(?:www\.)?(?:facebook\.com|fb\.com)[^\s"'<>\\)]{1,500}/gi;
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const CUT_DELIMS = /%22|%27|%2C/i;

  const decodeEmail = (raw) => {
    try { return decodeURIComponent(raw).toLowerCase().trim(); }
    catch { return raw.toLowerCase().trim(); }
  };

  const truncateFb = (u) => {
    let clean = u.split(CUT_DELIMS)[0];
    const secondHttp = clean.indexOf('http', 10);
    return secondHttp > 0 ? clean.slice(0, secondHttp) : clean;
  };

  const addEmailMatches = (text) => {
    if (!text || text.indexOf('@') === -1) return;
    const matches = text.match(EMAIL_REGEX);
    if (matches) matches.forEach(e => emailSet.add(decodeEmail(e)));
  };

  // Anchors: mailto + candidate links + fb URLs
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    if (!raw) return;
    const lowerRaw = raw.toLowerCase();

    if (lowerRaw.startsWith('mailto:')) {
      let payload = raw.slice(7);
      const q = payload.indexOf('?');
      if (q !== -1) payload = payload.slice(0, q);
      if (payload) {
        try { payload = decodeURIComponent(payload); } catch {}
        if (payload) emailSet.add(payload.toLowerCase().trim());
      }
      return;
    }

    if (raw.charCodeAt(0) === 35 || lowerRaw.startsWith('javascript:')) return;

    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch { return; }
    if (candidateSet.size < MAX_LINKS_PER_PAGE) candidateSet.add(abs);
    const lowerAbs = abs.toLowerCase();
    if (lowerAbs.indexOf('facebook.com') !== -1 || lowerAbs.indexOf('fb.com/') !== -1) {
      fbRaw.push(abs);
    }
  });

  // Body text
  const bodyText = $('body').text();
  if (bodyText) {
    if (bodyText.indexOf('@') !== -1) addEmailMatches(bodyText);
    if (bodyText.indexOf('facebook.com') !== -1 || bodyText.indexOf('fb.com') !== -1) {
      FB_SCRIPT_REGEX.lastIndex = 0;
      const fbMatches = bodyText.match(FB_SCRIPT_REGEX);
      if (fbMatches) fbMatches.forEach(m => fbRaw.push(truncateFb(m)));
    }
  }

  // Email-bearing attributes
  $('[content*="@"], [value*="@"], [title*="@"], [alt*="@"], [data-email], [data-mail]').each((_, el) => {
    addEmailMatches($(el).attr('content'));
    addEmailMatches($(el).attr('value'));
    addEmailMatches($(el).attr('title'));
    addEmailMatches($(el).attr('alt'));
    addEmailMatches($(el).attr('data-email'));
    addEmailMatches($(el).attr('data-mail'));
  });

  // Cloudflare email protection
  $('[data-cfemail]').each((_, el) => {
    const encoded = $(el).attr('data-cfemail');
    if (!encoded || encoded.length < 4) return;
    try {
      const key = parseInt(encoded.substring(0, 2), 16);
      let decoded = '';
      for (let j = 2; j < encoded.length; j += 2) {
        decoded += String.fromCharCode(parseInt(encoded.substring(j, j + 2), 16) ^ key);
      }
      if (decoded.indexOf('@') !== -1) emailSet.add(decodeEmail(decoded));
    } catch {}
  });

  // Scripts: ld+json emails + fb URLs
  $('script').each((_, el) => {
    const content = $(el).text();
    if (!content) return;
    const type = $(el).attr('type') || '';
    if (type === 'application/ld+json' && content.indexOf('@') !== -1) addEmailMatches(content);
    if (content.indexOf('facebook.com') !== -1 || content.indexOf('fb.com') !== -1) {
      FB_SCRIPT_REGEX.lastIndex = 0;
      const fbMatches = content.match(FB_SCRIPT_REGEX);
      if (fbMatches) fbMatches.forEach(m => fbRaw.push(truncateFb(m)));
    }
  });

  return {
    emails: Array.from(emailSet),
    fbRaw,
    candidateLinks: Array.from(candidateSet),
  };
}

// =========================================================================
// SCRAPING CORE
// =========================================================================

async function scrapeUrl(url, depth, visitedUrls, signal) {
  const result = { emails: [], facebookUrls: [], newUrls: [] };

  if (visitedUrls.has(url)) return result;
  visitedUrls.add(url);

  if (signal?.aborted) return result;

  if (SCRAPE_DELAY_MAX_MS > 0) {
    const ms = SCRAPE_DELAY_MIN_MS + Math.random() * (SCRAPE_DELAY_MAX_MS - SCRAPE_DELAY_MIN_MS);
    if (ms > 0) await delay(ms);
  }

  const identity = getNextIdentity();

  try {
    const html = await fetchHtml(url, identity, signal);
    const { emails, fbRaw, candidateLinks } = extractFromHtml(html, url);

    const pageEmails = filterEmails(emails);
    const normalizedFacebook = fbRaw.length > 0 ? extractFacebookUrls(fbRaw.join('\n')) : [];

    if (pageEmails.length > 0) result.emails.push(...pageEmails);
    if (normalizedFacebook.length > 0) result.facebookUrls.push(...normalizedFacebook);

    if (depth < MAX_DEPTH) {
      const linkCollector = createSameDomainLinkCollector(url);
      linkCollector.addCommonPages();
      for (const link of candidateLinks) linkCollector.addCandidateLink(link);
      const collected = linkCollector.getLinks();
      if (collected.length > 0) result.newUrls.push(...collected);
    }

    console.log(`[HTTP] ${url} → ${pageEmails.length} emails, ${candidateLinks.length} links`);
  } catch (error) {
    console.error(`[HTTP Error] ${url}: ${error.message}`);
    throw error;
  }

  return result;
}

export async function scrapeWebsite(url, { signal } = {}) {
  console.log(`Starting scrape for URL: ${url}`);

  const uniqueEmails = new Set();
  const uniqueFacebookUrls = new Set();
  const visitedUrls = new Set();
  const earlyExitSignal = { found: false };

  const isAborted = () => signal && signal.aborted;

  try {
    if (isAborted()) return null;

    const primaryResult = await scrapeUrl(url, 0, visitedUrls, signal);

    if (isAborted()) return null;

    primaryResult.emails.forEach((e) => uniqueEmails.add(e));
    primaryResult.facebookUrls.forEach((f) => uniqueFacebookUrls.add(f));

    if (uniqueEmails.size >= EARLY_EXIT_EMAIL_THRESHOLD) {
      earlyExitSignal.found = true;
    }

    if (MAX_DEPTH > 1 && !earlyExitSignal.found) {
      const baseOrigin = new URL(url).origin;
      const subpageLimit = Math.min(MAX_SUBPAGE_CRAWLS, MAX_LINKS_PER_PAGE);
      const candidateLinks = (primaryResult.newUrls || [])
        .filter((link) => {
          try { return new URL(link).origin === baseOrigin && !visitedUrls.has(link); }
          catch { return false; }
        })
        .slice(0, subpageLimit);

      const effectiveSubpageLimit = Math.min(SUBPAGE_CONCURRENCY, PER_HOST_CONCURRENCY);
      await runWithConcurrency(candidateLinks, effectiveSubpageLimit, async (link) => {
        if (earlyExitSignal.found || isAborted()) return;
        try {
          const sub = await scrapeUrl(link, 1, visitedUrls, signal);
          sub.emails.forEach((e) => uniqueEmails.add(e));
          sub.facebookUrls.forEach((f) => uniqueFacebookUrls.add(f));
          if (uniqueEmails.size >= EARLY_EXIT_EMAIL_THRESHOLD) {
            earlyExitSignal.found = true;
          }
        } catch (e) {
          if (isAborted()) return;
          console.error(`Error scraping ${link}: ${e?.message || e}`);
        }
      });
    }

    if (isAborted()) return null;

    const finalEmails = Array.from(uniqueEmails);
    const finalFacebookUrls = Array.from(uniqueFacebookUrls);
    console.log(`Completed scrape: ${finalEmails.length} emails, ${finalFacebookUrls.length} Facebook URLs`);

    return {
      success: true,
      emails: finalEmails,
      facebook_urls: finalFacebookUrls,
      crawled_urls: Array.from(visitedUrls).slice(0, MAX_STORED_VISITED_URLS),
      pages_crawled: visitedUrls.size,
    };
  } catch (error) {
    if (isAborted()) return null;
    throw error;
  }
}

function createErrorResult(error, message = error) {
  return {
    success: false,
    emails: [],
    facebook_urls: [],
    crawled_urls: [],
    pages_crawled: 0,
    error,
    message,
    needs_browser_rendering: false,
  };
}

export async function scrapeWebsiteDirect(url, options = {}) {
  if (!url || typeof url !== 'string') {
    return createErrorResult('URL is required', 'Please provide a valid URL string.');
  }

  try {
    new URL(url);
  } catch {
    return createErrorResult('Invalid URL format', 'Please provide a valid URL.');
  }

  if (isNonHtmlResource(url)) {
    return createErrorResult(
      'Unsupported URL type',
      'PDF, image, and document URLs are not supported. Please provide a webpage URL.'
    );
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || OVERALL_TIMEOUT_MS);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const result = await scrapeWebsite(url, { signal: ac.signal });
    if (!result) {
      return createErrorResult(
        'Scrape timed out',
        'The website took too long to scrape. Try again or use a simpler URL.'
      );
    }
    return { ...result, needs_browser_rendering: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to scrape the website';
    return createErrorResult(errorMessage, errorMessage);
  } finally {
    clearTimeout(timer);
  }
}

function getErrorMessage(data) {
  if (!data) return 'Invalid response format';
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  if (data.error && typeof data.error.message === 'string' && data.error.message.trim()) {
    return data.error.message;
  }
  return 'Invalid response format';
}

export function normalizeResponse(items) {
  return items.map((item) => {
    const data = item?.json;
    const emails = Array.isArray(data?.emails) ? data.emails : [];
    const facebookUrls = Array.isArray(data?.facebook_urls) ? data.facebook_urls : [];
    const needsBrowserRendering = Boolean(data?.needs_browser_rendering || data?.js_rendered === false);

    if (data?.success === true) {
      const hasEmails = emails.length > 0;
      const status = hasEmails
        ? 'auto_completed'
        : (needsBrowserRendering ? 'auto_need_browser_rendering' : 'auto_need_google_search');
      const fallbackMessage = hasEmails ? null : 'No emails found';
      const message = hasEmails ? null : (() => {
        const candidate = getErrorMessage(data);
        return candidate === 'Invalid response format' ? fallbackMessage : candidate;
      })();

      return {
        json: { status, emails, facebook_urls: facebookUrls, message, needs_browser_rendering: needsBrowserRendering },
      };
    }

    return {
      json: {
        status: needsBrowserRendering ? 'auto_need_browser_rendering' : 'auto_error',
        emails: [],
        facebook_urls: [],
        message: getErrorMessage(data),
        needs_browser_rendering: needsBrowserRendering,
      },
    };
  });
}

// No-op export — keeps worker.ts import compatible
export async function closeSharedBrowser() {}
