import 'dotenv/config';
import * as cheerio from 'cheerio';
import axios, { AxiosProxyConfig } from 'axios';

// Types
export interface ScrapeResult {
  success: boolean;
  emails: string[];
  facebook_urls: string[];
  crawled_urls?: string[];
  pages_crawled?: number;
  js_rendered?: boolean;
}

interface Identity {
  userAgent: string;
  acceptLanguage: string;
  referer: string;
}

interface ScrapeUrlResult {
  emails: string[];
  facebookUrls: string[];
  newUrls: string[];
  httpFailed: boolean;
  needsBrowserRendering: boolean;
}

// Configuration
const DEBUG = process.env.DEBUG || false;
const MAX_DEPTH = Math.max(1, parseInt(process.env.MAX_DEPTH || '', 10) || 2);
const parsedSubpageConcurrency = parseInt(process.env.SUBPAGE_CONCURRENCY || '', 10);
const SUBPAGE_CONCURRENCY = Math.max(1, Number.isFinite(parsedSubpageConcurrency) ? parsedSubpageConcurrency : 4);
const rawScrapeDelayMin = parseInt(process.env.SCRAPE_DELAY_MIN_MS || '', 10);
const rawScrapeDelayMax = parseInt(process.env.SCRAPE_DELAY_MAX_MS || '', 10);
const SCRAPE_DELAY_MIN_MS = Math.max(0, Number.isFinite(rawScrapeDelayMin) ? rawScrapeDelayMin : 0);
const SCRAPE_DELAY_MAX_MS = Math.max(SCRAPE_DELAY_MIN_MS, Number.isFinite(rawScrapeDelayMax) ? rawScrapeDelayMax : Math.max(SCRAPE_DELAY_MIN_MS, 100));
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '', 10) || 10000;
const HTTP_MAX_RETRIES = Math.max(0, parseInt(process.env.HTTP_MAX_RETRIES || '', 10) || 2);
const RETRY_BACKOFF_BASE_MS = Math.max(100, parseInt(process.env.RETRY_BACKOFF_BASE_MS || '', 10) || 500);
const MAX_LINKS_PER_PAGE = Math.max(1, parseInt(process.env.MAX_LINKS_PER_PAGE || '', 10) || 50);
const MAX_STORED_VISITED_URLS = Math.max(1, parseInt(process.env.MAX_STORED_VISITED_URLS || '', 10) || 200);
const MAX_SUBPAGE_CRAWLS = Math.max(1, parseInt(process.env.MAX_SUBPAGE_CRAWLS || '', 10) || 20);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0'
];

const ACCEPT_LANGUAGES = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-US,en;q=0.8,fr;q=0.6', 'en-US,en;q=0.8,es;q=0.6'];
const REFERERS = ['https://www.google.com/', 'https://www.bing.com/', 'https://duckduckgo.com/', 'https://search.yahoo.com/'];

const proxyPool = (process.env.PROXY_URLS || '').split(',').map((v) => v.trim()).filter(Boolean);

let identityCursor = 0;
let proxyCursor = 0;

const COMMON_PAGE_PATHS = ['/about/', '/contact/', '/about-us/', '/contact-us/', '/privacy/', '/terms'];


// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================

function getNextIdentity(): Identity {
  const index = identityCursor++;
  return {
    userAgent: USER_AGENTS[index % USER_AGENTS.length],
    acceptLanguage: ACCEPT_LANGUAGES[index % ACCEPT_LANGUAGES.length],
    referer: REFERERS[index % REFERERS.length]
  };
}

function getNextProxyUrl(): string | null {
  if (!proxyPool.length) return null;
  const proxyUrl = proxyPool[proxyCursor % proxyPool.length];
  proxyCursor = (proxyCursor + 1) % proxyPool.length;
  return proxyUrl;
}

function buildAxiosProxyConfig(proxyUrl: string | null): AxiosProxyConfig | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const auth = parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password || '') } : undefined;
    const protocol = parsed.protocol.replace(':', '');
    const port = parsed.port ? parseInt(parsed.port, 10) : protocol === 'https' ? 443 : 80;
    return { protocol, host: parsed.hostname, port, auth };
  } catch (error: any) {
    if (DEBUG){
    console.warn(`[Proxy] Failed to parse proxy URL "${proxyUrl}":`, error?.message || error);
    }
    return undefined;
  }
}

function cleanUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.hash = '';
    return urlObj.href;
  } catch { return url.split('#')[0]; }
}

function generateCommonPageVariants(pagePath: string): Set<string> {
  if (typeof pagePath !== 'string' || !pagePath.trim()) return new Set();
  const trimmed = pagePath.trim();
  const withoutSlash = trimmed.replace(/^\/+|\/+$/g, '');
  return new Set([`/${withoutSlash}`, `/${withoutSlash}/`]);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// EMAIL & URL EXTRACTION FUNCTIONS
// =========================================================================

// Blocked domain patterns (tracking, platforms, CDNs, etc.)
const BLOCKED_DOMAINS = new Set([
  // Error tracking & monitoring
  'sentry.io', 'sentry.wixpress.com', 'sentry-next.wixpress.com', 'ingest.sentry.io',
  'newrelic.com', 'rollbar.com', 'datadoghq.com', 'bugsnag.com',
  // Platforms & hosting
  'wordpress.com', 'wordpress.org', 'wpengine.com', 'wix.com', 'squarespace.com',
  'shopify.com', 'shopifyemail.com', 'bigcommerce.com', 'weebly.com', 'webflow.io',
  'ghost.org', 'godaddy.com', 'cloudflare.com', 'cloudfront.net', 'amazonaws.com',
  'azure.com', 'digitalocean.com', 'linode.com', 'heroku.com', 'netlify.app',
  'vercel.app', 'render.com', 'cloudwaysapps.com',
  // Social media
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com',
  // Fonts & assets
  'fonts.googleapis.com', 'use.typekit.net', 'latofonts.com', 'fontsquirrel.com',
  'myfonts.com', 'antsoup.com',
  // Placeholder domains
  'example.com', 'domain.com', 'email.com', 'mysite.com', 'sample.com', 'test.com',
  'yoursite.com', 'companyname.com', 'business.com', 'website.com', 'businessname.com',
  'company.com', 'info.com', 'domain.co', 'domain.net'
]);

// Blocked local parts (generic/placeholder usernames)
const BLOCKED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'firstname', 'lastname', 'yourname', 'fullname', 'username', 'user.name',
  'johnsmith', 'john.doe', 'alex.smith', 'user', 'filler', 'placeholder',
  'your', 'name', 'email'
]);

// Patterns that indicate junk emails
const BLOCKED_PATTERNS = [
  /^[%\s\?&]/,                    // Starts with %, whitespace, ? or &
  /^@/,                           // Starts with @
  /@.*@/,                         // Multiple @ symbols
  /\.(css|js|json|xml|map|min\.js|min\.css|woff|woff2|ttf|eot|pdf)$/i,  // File extensions
  /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i,  // Image extensions
  /@\d+x\.(png|jpg|jpeg|gif|svg|webp)$/i, // Retina images (@1x.png, @2x.png)
  /^(sprite|icon|logo|banner|image|font)/i,  // Asset-related
  /%[0-9A-Fa-f]{2}/,              // URL encoded characters
  /\?/,                           // Any query string (email@domain.com?subject=)
  /subject=/i,                    // mailto params
  /body=/i,
  /&/,                            // URL params
  /@o\d+\.ingest\.sentry\.io/i,   // Sentry org-specific
  /wixpress\.com$/i,
  /sentry/i,
  /shoplocal/i,                   // ShopLocal platform junk
  /news\.cfm/i,                   // ColdFusion URLs captured as emails
];

function isJunkEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return true;
  
  const normalized = email.toLowerCase().trim();
  
  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  
  // Parse email parts
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === normalized.length - 1) return true;
  
  const localPart = normalized.substring(0, atIndex);
  const domain = normalized.substring(atIndex + 1);
  
  // Check blocked local parts
  if (BLOCKED_LOCAL_PARTS.has(localPart)) return true;
  
  // Check blocked domains (exact match or subdomain)
  if (BLOCKED_DOMAINS.has(domain)) return true;
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  
  // Additional validation
  if (localPart.length < 2 || domain.length < 4) return true;
  if (!domain.includes('.')) return true;
  
  // Check for image/asset patterns in local part
  if (/^(sprite|icon|logo|banner|image|font|@\d+x)/i.test(localPart)) return true;
  
  return false;
}

function extractEmails(html: string): string[] {
  const emails: string[] = [];
  const mailtoRegex = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["']/gi;
  for (const match of html.matchAll(mailtoRegex)) emails.push(match[1]);
  
  const htmlEmailRegex = /<[^>]*>([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})<\/[^>]*>/gi;
  for (const match of html.matchAll(htmlEmailRegex)) emails.push(match[1]);
  
  const textContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const textEmails = textContent.match(emailRegex) || [];
  emails.push(...textEmails);
  
  // Filter out junk emails and dedupe
  return [...new Set(emails)].filter(email => !isJunkEmail(email));
}

function extractFacebookUrls(text: string): string[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];

  const candidates = new Set<string>();
  const allowedShortSegments = new Set(['p', 'sharer.php', 'share.php']);

  const patterns = [
    /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com)[^\s"'<>\\)]+/gi,
    /https?:\\\/\\\/(?:www\.)?(?:facebook\.com|fb\.com)[^"'<>\\)]+/gi,
    /https?%3A%2F%2F(?:www\.)?(?:facebook\.com|fb\.com)[^"'<>\\)]+/gi
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) candidates.add(match[0]);
  });

  const barePattern = /(?:facebook\.com|fb\.com)\/[^\s"'<>\\)]+/gi;
  let bareMatch;
  while ((bareMatch = barePattern.exec(text)) !== null) candidates.add(`https://${bareMatch[0]}`);

  const results = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeFacebookCandidate(candidate, 0, allowedShortSegments);
    if (normalized) results.add(normalized);
  }
  return Array.from(results);
}

function normalizeFacebookCandidate(rawValue: string, depth: number, allowedShortSegments: Set<string>): string | null {
  if (!rawValue || typeof rawValue !== 'string' || depth > 3) return null;

  let value = rawValue.trim();
  if (!value) return null;

  value = value
    .replace(/\\u0026/gi, '&').replace(/\\u002F/gi, '/').replace(/\\u003A/gi, ':')
    .replace(/\\x2F/gi, '/').replace(/\\x3A/gi, ':').replace(/\\\//g, '/').replace(/\\\\/g, '\\')
    .replace(/&amp;/gi, '&').replace(/^['"`]+|['"`]+$/g, '');

  if (/^https?%3A%2F%2F/i.test(value) || value.includes('%2F') || value.includes('%3A')) {
    try { value = decodeURIComponent(value); } catch {}
  }

  if (!/^https?:\/\//i.test(value)) {
    if (value.startsWith('//')) value = `https:${value}`;
    else if (/^(?:www\.)?(facebook\.com|fb\.com)/i.test(value)) value = `https://${value.replace(/^https?:\\\/\\\//i, '')}`;
  }

  value = value.replace(/\/+$/, '');

  let urlObj: URL;
  try { urlObj = new URL(value); } catch { return null; }

  const hostname = urlObj.hostname.toLowerCase();
  const allowedDomains = ['facebook.com', 'fb.com'];
  if (!allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return null;

  if (hostname.endsWith('facebook.com') && urlObj.pathname === '/l.php') {
    const forwarded = urlObj.searchParams.get('u') || urlObj.searchParams.get('href');
    if (forwarded) return normalizeFacebookCandidate(forwarded, depth + 1, allowedShortSegments);
  }

  ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'mibextid', 'ref', 'refid']
    .forEach(param => urlObj.searchParams.delete(param));
  urlObj.hash = '';
  const searchString = urlObj.searchParams.toString();
  urlObj.search = searchString ? `?${searchString}` : '';

  const firstPathSegment = urlObj.pathname.split('/').filter(Boolean)[0] || '';
  if (firstPathSegment.length > 0 && firstPathSegment.length < 2 && !allowedShortSegments.has(firstPathSegment.toLowerCase())) return null;

  return urlObj.toString();
}


// =========================================================================
// LINK COLLECTION UTILITIES
// =========================================================================

interface LinkCollector {
  addCandidateLink: (candidate: string) => void;
  addCommonPages: () => void;
  getLinks: () => string[];
}

function createSameDomainLinkCollector(baseUrlHref: string): LinkCollector {
  const baseUrl = new URL(baseUrlHref);
  const normalizedCurrentUrl = cleanUrl(baseUrl.href);
  const prioritizedLinks: string[] = [];
  const seenLinks = new Set<string>();
  const canAddMore = () => prioritizedLinks.length < MAX_LINKS_PER_PAGE;

  const addCandidateLink = (candidate: string): void => {
    if (!candidate || !canAddMore()) return;
    try {
      const linkUrl = new URL(candidate, baseUrl.href);
      if (linkUrl.origin !== baseUrl.origin) return;
      const finalUrl = cleanUrl(linkUrl.href);
      if (finalUrl === normalizedCurrentUrl || seenLinks.has(finalUrl)) return;
      seenLinks.add(finalUrl);
      prioritizedLinks.push(finalUrl);
    } catch {}
  };

  const addCommonPages = (): void => {
    if (!canAddMore()) return;
    for (const pagePath of COMMON_PAGE_PATHS) {
      if (!canAddMore()) break;
      for (const variant of generateCommonPageVariants(pagePath)) {
        if (!canAddMore()) break;
        addCandidateLink(variant);
      }
    }
  };

  return { addCandidateLink, addCommonPages, getLinks: () => prioritizedLinks };
}

async function runWithConcurrency<T>(items: T[], limit: number, iteratee: (item: T, index: number) => Promise<void>): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  const normalizedLimit = Math.max(1, Number.isFinite(limit) ? limit : 1);
  let currentIndex = 0;
  const worker = async (): Promise<void> => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      await iteratee(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(normalizedLimit, items.length) }, () => worker()));
}

// =========================================================================
// CHEERIO-ONLY SCRAPING
// =========================================================================

async function scrapeUrl(url: string, visitedUrls: Set<string>): Promise<ScrapeUrlResult> {
  const result: ScrapeUrlResult = { emails: [], facebookUrls: [], newUrls: [], httpFailed: false, needsBrowserRendering: false };

  if (visitedUrls.has(url)) return result;
  visitedUrls.add(url);

  if (SCRAPE_DELAY_MAX_MS > 0) {
    const scrapeDelay = SCRAPE_DELAY_MIN_MS + Math.random() * (SCRAPE_DELAY_MAX_MS - SCRAPE_DELAY_MIN_MS);
    if (scrapeDelay > 0) await delay(scrapeDelay);
  }

  let htmlContent = '';
  // HTTP request with retries
  for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
    const attemptIdentity = getNextIdentity();
    const attemptProxy = getNextProxyUrl();
    const axiosProxyConfig = buildAxiosProxyConfig(attemptProxy);

    try {
      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent': attemptIdentity.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': attemptIdentity.acceptLanguage,
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          ...(attemptIdentity.referer ? { Referer: attemptIdentity.referer } : {})
        },
        maxRedirects: 5,
        decompress: true,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        responseType: 'text',
        transformResponse: [(data) => data],
        ...(axiosProxyConfig ? { proxy: axiosProxyConfig } : {})
      });

      htmlContent = typeof response.data === 'string' ? response.data : '';
      break;
    } catch (error: any) {
      const status = error?.response?.status;
      const shouldRetry = status === 403 || status === 429 || error?.code === 'ECONNABORTED';
      if (!shouldRetry || attempt === HTTP_MAX_RETRIES || status === 404) {
        if(DEBUG){
          console.log(`[Cheerio] Failed to fetch ${url}: ${error?.message || error}`);
        }
        result.httpFailed = true;
        // Only mark as needing browser rendering for bot-detection related failures (not 404)
        if (status === 403 || status === 429 || error?.code === 'ECONNABORTED') {
          result.needsBrowserRendering = true;
        }
        return result;
      }
      await delay(RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt));
    }
  }

  if (!htmlContent) {
    result.httpFailed = true;
    return result;
  }

  // Extract data with Cheerio
  const emails = extractEmails(htmlContent);
  const facebookLinks = extractFacebookUrls(htmlContent);

  result.emails.push(...emails);
  result.facebookUrls.push(...facebookLinks);

  if (emails.length > 0) {
    console.log(`[Cheerio] Found ${emails.length} emails on ${url}`);
  }

  // Collect links for further crawling
  const $ = cheerio.load(htmlContent);
  const linkCollector = createSameDomainLinkCollector(url);
  linkCollector.addCommonPages();

  $('nav a, header a, .navbar a, .nav a, .navigation a, .menu a, .main-menu a, .primary-menu a, .top-menu a, [role="navigation"] a, .site-nav a, .main-nav a, a')
    .each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      try {
        linkCollector.addCandidateLink(new URL(href, url).href);
      } catch {}
    });

  result.newUrls.push(...linkCollector.getLinks());
  return result;
}


// =========================================================================
// MAIN SCRAPING FUNCTION
// =========================================================================

/**
 * Scrapes a website for emails and Facebook URLs
 * @param url - The URL to scrape
 * @returns The scraping result
 */
export async function scrapeWebsite(url: string): Promise<ScrapeResult> {
  console.log(`Starting scrape for URL: ${url}`);

  const uniqueEmails = new Set<string>();
  const uniqueFacebookUrls = new Set<string>();
  const visitedUrls = new Set<string>();

  try {
    const primaryResult = await scrapeUrl(url, visitedUrls);
    primaryResult.emails.forEach(e => uniqueEmails.add(e));
    primaryResult.facebookUrls.forEach(f => uniqueFacebookUrls.add(f));

    // Track if site needs browser rendering (403, 429, timeouts - not 404)
    let anyNeedsBrowserRendering = primaryResult.needsBrowserRendering;

    // Crawl subpages if no emails found
    if (MAX_DEPTH > 1 && uniqueEmails.size === 0) {
      const baseOrigin = new URL(url).origin;
      const subpageLimit = Math.min(MAX_SUBPAGE_CRAWLS, MAX_LINKS_PER_PAGE);
      const candidateLinks = (primaryResult.newUrls || [])
        .filter(link => {
          try {
            return new URL(link).origin === baseOrigin && !visitedUrls.has(link);
          } catch { return false; }
        })
        .slice(0, subpageLimit);

      await runWithConcurrency(candidateLinks, SUBPAGE_CONCURRENCY, async (link) => {
        if (uniqueEmails.size > 0) return; // Early exit if emails found
        try {
          const subResult = await scrapeUrl(link, visitedUrls);
          subResult.emails.forEach(e => uniqueEmails.add(e));
          subResult.facebookUrls.forEach(f => uniqueFacebookUrls.add(f));
          if (subResult.needsBrowserRendering) anyNeedsBrowserRendering = true;
        } catch (e: any) {
          console.error(`Error scraping ${link}: ${e?.message || e}`);
        }
      });
    }

    const finalEmails = Array.from(uniqueEmails);
    const finalFacebookUrls = Array.from(uniqueFacebookUrls);

    console.log(`Completed scrape: Found ${finalEmails.length} emails and ${finalFacebookUrls.length} Facebook URLs`);

    const response: ScrapeResult = {
      success: true,
      emails: finalEmails,
      facebook_urls: finalFacebookUrls,
      crawled_urls: Array.from(visitedUrls).slice(0, MAX_STORED_VISITED_URLS),
      pages_crawled: visitedUrls.size
    };

    // Only add js_rendered: false if site needs browser rendering (403, 429, timeouts)
    if (anyNeedsBrowserRendering) {
      response.js_rendered = false;
    }

    return response;
  } catch (error) {
    console.error(`Scrape failed for ${url}:`, error);
    throw error;
  }
}

export default scrapeWebsite;
