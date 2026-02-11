import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import PQueue from 'p-queue';

// Configuration
const MAX_DEPTH = Math.max(1, parseInt(process.env.MAX_DEPTH, 10) || 2);
const PLAYWRIGHT_MAX_CONTEXTS = Math.max(1, parseInt(process.env.PLAYWRIGHT_MAX_CONTEXTS, 10) || 10);
const MAX_LINKS_PER_PAGE = Math.max(1, parseInt(process.env.MAX_LINKS_PER_PAGE, 10) || 50);
const MAX_STORED_VISITED_URLS = Math.max(1, parseInt(process.env.MAX_STORED_VISITED_URLS, 10) || 200);
const MAX_SUBPAGE_CRAWLS = Math.max(1, parseInt(process.env.MAX_SUBPAGE_CRAWLS, 10) || 20);
const PAGE_TIMEOUT = Math.max(5000, parseInt(process.env.PAGE_TIMEOUT_MS, 10) || 10000);
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '50', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const PLAYWRIGHT_BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet', 'other']);
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36',
];
const COMMON_PAGE_PATHS = ['/contact', '/about', '/contact-us', '/about-us'];

// =========================================================================
// EMAIL FILTERING
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
  /^[%\s?&]/,                     // Starts with %, whitespace, ? or &
  /^@/,                           // Starts with @
  /@.*@/,                         // Multiple @ symbols
  /\.(css|js|json|xml|map|min\.js|min\.css|woff|woff2|ttf|eot|pdf)$/i,
  /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i,
  /@\d+x\.(png|jpg|jpeg|gif|svg|webp)$/i,
  /^(sprite|icon|logo|banner|image|font)/i,
  /%[0-9A-Fa-f]{2}/,              // URL encoded characters
  /\?/,                           // Any query string
  /subject=/i,
  /body=/i,
  /&/,                            // URL params
  /@o\d+\.ingest\.sentry\.io/i,
  /wixpress\.com$/i,
  /sentry/i,
  /shoplocal/i,
  /news\.cfm/i,
];

function isJunkEmail(email) {
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

function filterEmails(emails) {
  return emails.filter(email => !isJunkEmail(email));
}
const PLAYWRIGHT_LAUNCH_ARGS = [
  '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--no-sandbox',
  '--disable-background-networking', '--disable-default-apps', '--disable-extensions',
  '--disable-sync', '--disable-translate', '--mute-audio', '--no-first-run',
];

let identityCursor = 0;
let sharedBrowserInstance = null;
let sharedBrowserPromise = null;
const contextPool = [];

function getNextIdentity() {
  return { userAgent: USER_AGENTS[identityCursor++ % USER_AGENTS.length] };
}

async function getSharedBrowser() {
  if (sharedBrowserInstance) return sharedBrowserInstance;
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({ headless: true, args: PLAYWRIGHT_LAUNCH_ARGS });
  }
  try {
    sharedBrowserInstance = await sharedBrowserPromise;
    sharedBrowserInstance.once('disconnected', () => {
      sharedBrowserInstance = null;
      sharedBrowserPromise = null;
      contextPool.length = 0;
    });
    return sharedBrowserInstance;
  } catch (error) {
    sharedBrowserPromise = null;
    throw error;
  }
}

async function getContext(browser) {
  if (contextPool.length > 0) return { context: contextPool.pop(), pooled: true };
  const identity = getNextIdentity();
  const context = await browser.newContext({
    userAgent: identity.userAgent,
    viewport: { width: 1366, height: 768 }
  });
  await context.route('**/*', async (route) => {
    const type = route.request().resourceType();
    if (PLAYWRIGHT_BLOCKED_RESOURCE_TYPES.has(type)) await route.abort().catch(() => {});
    else await route.continue().catch(() => {});
  });
  return { context, pooled: false };
}

function returnContext(context) {
  if (contextPool.length < PLAYWRIGHT_MAX_CONTEXTS) contextPool.push(context);
  else context.close().catch(() => {});
}

async function resetSharedBrowser() {
  for (const ctx of contextPool) { try { await ctx.close(); } catch {} }
  contextPool.length = 0;
  if (sharedBrowserInstance) { try { await sharedBrowserInstance.close(); } catch {} }
  sharedBrowserInstance = null;
  sharedBrowserPromise = null;
}

async function closeSharedBrowser() {
  if (sharedBrowserPromise || sharedBrowserInstance) await resetSharedBrowser();
}

function cleanUrl(url) {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return url.split('#')[0]; }
}

function createSameDomainLinkCollector(baseUrlHref) {
  const baseUrl = new URL(baseUrlHref);
  const normalizedCurrentUrl = cleanUrl(baseUrl.href);
  const prioritizedLinks = [];
  const seenLinks = new Set();
  const addCandidateLink = (candidate) => {
    if (!candidate || prioritizedLinks.length >= MAX_LINKS_PER_PAGE) return;
    try {
      const linkUrl = new URL(candidate, baseUrl.href);
      if (linkUrl.origin !== baseUrl.origin) return;
      const finalUrl = cleanUrl(linkUrl.href);
      if (finalUrl === normalizedCurrentUrl || seenLinks.has(finalUrl)) return;
      seenLinks.add(finalUrl);
      prioritizedLinks.push(finalUrl);
    } catch {}
  };
  const addCommonPages = () => {
    for (const path of COMMON_PAGE_PATHS) {
      if (prioritizedLinks.length >= MAX_LINKS_PER_PAGE) break;
      addCandidateLink(path);
    }
  };
  return { addCandidateLink, addCommonPages, getLinks: () => prioritizedLinks };
}

class AsyncSemaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    if (this.queue.length > 0) this.queue.shift()();
  }
}

const playwrightSemaphore = new AsyncSemaphore(PLAYWRIGHT_MAX_CONTEXTS);

async function scrapeUrl(url, depth, visitedUrls, earlyExitSignal) {
  const result = { emails: [], facebookUrls: [], newUrls: [], error: null };
  if (visitedUrls.has(url) || earlyExitSignal?.found) return result;
  visitedUrls.add(url);

  let browser, contextInfo, page;
  let semaphoreAcquired = false;

  try {
    browser = await getSharedBrowser();
    await playwrightSemaphore.acquire();
    semaphoreAcquired = true;
    if (earlyExitSignal?.found) return result;

    contextInfo = await getContext(browser);
    page = await contextInfo.context.newPage();

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: attempt === 0 ? PAGE_TIMEOUT : PAGE_TIMEOUT * 2 });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!err.message.includes('Timeout') || attempt === 1) break;
      }
    }
    if (lastError) throw lastError;

    const data = await page.evaluate((candidateLimit) => {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = new Set();
      const facebookUrls = new Set();
      const links = new Set();

      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const email = a.getAttribute('href')?.slice(7);
        if (email) emails.add(email.trim());
      });

      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const abs = new URL(href, location.href).href;
          if (links.size < candidateLimit) links.add(abs);
          if (/facebook\.com|fb\.com/i.test(abs)) facebookUrls.add(abs);
        } catch {}
      });

      const text = document.body?.innerText || '';
      (text.match(emailRegex) || []).forEach(e => emails.add(e.trim()));
      (text.match(/https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com)[^\s"'<>]+/gi) || []).forEach(u => facebookUrls.add(u));

      return { emails: [...emails], facebookUrls: [...facebookUrls], links: [...links] };
    }, MAX_LINKS_PER_PAGE);

    result.emails = filterEmails(data.emails);
    result.facebookUrls = data.facebookUrls;

    if (depth < MAX_DEPTH && result.emails.length === 0) {
      const collector = createSameDomainLinkCollector(url);
      collector.addCommonPages();
      data.links.forEach(l => collector.addCandidateLink(l));
      result.newUrls = collector.getLinks();
    }
  } catch (error) {
    console.error(`[Error] ${url}: ${error.message}`);
    result.error = error.message;
    if (!browser?.isConnected()) await resetSharedBrowser();
  } finally {
    if (page) await page.close().catch(() => {});
    if (contextInfo) returnContext(contextInfo.context);
    if (semaphoreAcquired) playwrightSemaphore.release();
  }
  return result;
}

async function scrapeWebsite(url) {
  const uniqueEmails = new Set();
  const uniqueFacebookUrls = new Set();
  const visitedUrls = new Set();
  const errors = [];
  const earlyExitSignal = { found: false };

  try {
    const primary = await scrapeUrl(url, 0, visitedUrls, earlyExitSignal);
    primary.emails.forEach(e => uniqueEmails.add(e));
    primary.facebookUrls.forEach(f => uniqueFacebookUrls.add(f));
    if (primary.error) errors.push({ url, error: primary.error });
    if (uniqueEmails.size > 3) earlyExitSignal.found = true;

    const primaryFailed = primary.error && primary.emails.length === 0 && primary.newUrls.length === 0;

    if (MAX_DEPTH > 1 && !earlyExitSignal.found && primary.newUrls.length > 0) {
      const baseOrigin = new URL(url).origin;
      const candidates = primary.newUrls
        .filter(l => { try { return new URL(l).origin === baseOrigin; } catch { return false; } })
        .slice(0, MAX_SUBPAGE_CRAWLS);

      await Promise.all(candidates.map(async (link) => {
        if (earlyExitSignal.found) return;
        try {
          const sub = await scrapeUrl(link, 1, visitedUrls, earlyExitSignal);
          sub.emails.forEach(e => uniqueEmails.add(e));
          sub.facebookUrls.forEach(f => uniqueFacebookUrls.add(f));
          if (sub.error) errors.push({ url: link, error: sub.error });
          if (uniqueEmails.size > 0) earlyExitSignal.found = true;
        } catch {}
      }));
    }

    return {
      success: !primaryFailed,
      emails: [...uniqueEmails],
      facebook_urls: [...uniqueFacebookUrls],
      crawled_urls: [...visitedUrls].slice(0, MAX_STORED_VISITED_URLS),
      pages_crawled: visitedUrls.size,
      ...(errors.length > 0 && { errors })
    };
  } catch (error) {
    console.error(`Scrape failed: ${error.message}`);
    throw error;
  }
}

// Worker Logic
const queue = new PQueue({ concurrency: MAX_CONCURRENCY });
let shuttingDown = false;
const stats = { processed: 0, errors: 0, active: 0 };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// function isRecoverableError(errorMsg) {
//   const lowerMsg = errorMsg.toLowerCase();
//   return lowerMsg.includes('timeout') ||
//     lowerMsg.includes('err_connection') ||
//     lowerMsg.includes('err_name_not_resolved') ||
//     lowerMsg.includes('err_ssl') ||
//     lowerMsg.includes('err_cert') ||
//     lowerMsg.includes('net::err_') ||
//     lowerMsg.includes('econnrefused') ||
//     lowerMsg.includes('enotfound') ||
//     lowerMsg.includes('econnreset');
// }

function normalizeResponse(result) {
  if (!result.success) {
    const errorMsg = result.errors?.[0]?.error || 'Scrape failed';
    // If error is timeout or connection issue, mark as auto_need_google_search (recoverable)
    // const isRecoverable = isRecoverableError(errorMsg);
    return { 
      // status: isRecoverable ? 'auto_need_google_search' : 'auto_error', -- need futre update or fix issue
      status: 'auto_need_google_search' , 
      emails: [], 
      facebook_urls: [], 
      message: errorMsg, 
      needs_browser_rendering: false 
    };
  }
  const hasEmails = result.emails.length > 0;
  // If completed but no emails, mark as auto_need_google_search
  return {
    status: hasEmails ? 'auto_completed' : 'auto_need_google_search',
    emails: result.emails || [],
    facebook_urls: result.facebook_urls || [],
    message: hasEmails ? null : 'No emails found',
    needs_browser_rendering: false
  };
}

async function processRow(row) {
  stats.active++;
  const start = Date.now();
  try {
    const scrapeResult = await scrapeWebsite(row.url);
    const normalized = normalizeResponse(scrapeResult);

    const { error } = await supabase
      .from('email_scraper_node')
      .update({
        status: normalized.status,
        emails: normalized.emails,
        facebook_urls: normalized.facebook_urls,
        message: normalized.message,
        needs_browser_rendering: normalized.needs_browser_rendering,
        scrape_type: 'browser_rendering',
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id);

    if (error) {
      console.error(`[Worker] DB update failed for job ${row.id}:`, error);
      stats.errors++;
    } else if (normalized.status === 'auto_error') {
      stats.errors++;
    } else {
      stats.processed++;
    }
  } catch (err) {
    stats.errors++;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    // const isRecoverable = isRecoverableError(errorMessage); // 
    await supabase
      .from('email_scraper_node')
      .update({ 
        // status: isRecoverable ? 'auto_need_google_search' : 'auto_error', 
        status: 'auto_need_google_search', 
        message: errorMessage, 
        scrape_type: 'browser_rendering', 
        updated_at: new Date().toISOString() 
      })
      .eq('id', row.id);
  } finally {
    stats.active--;
    console.log(`[Worker] Job ${row.id} finished in ${Date.now() - start}ms (Active: ${stats.active})`);
  }
}

async function fetchAndClaim(slots) {
  if (slots <= 0) return [];
  const { data, error } = await supabase.rpc('auto_get_next_email_scraper_nodes_need_browser_rendering', { batch_size: slots });
  if (error) {
    console.error('Error claiming rows via RPC:', error);
    return [];
  }
  return data || [];
}

async function mainLoop() {
  let backoffMs = 1000;
  const maxBackoff = 60000;

  console.log(`Starting worker with max concurrency: ${MAX_CONCURRENCY}`);
  await getSharedBrowser();

  const { count, error: qErr } = await supabase
    .from('email_scraper_node')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'auto_need_browser_rendering');

  if (qErr) console.error("Startup check failed:", qErr);
  else console.log(`Startup: ${count} jobs queued`);

  while (!shuttingDown) {
    try {
      const slotsAvailable = MAX_CONCURRENCY - queue.pending;
      if (slotsAvailable > 0) {
        const jobs = await fetchAndClaim(Math.min(slotsAvailable, BATCH_SIZE));
        if (jobs.length > 0) {
          backoffMs = 1000;
          console.log(`Claimed ${jobs.length} jobs.`);
          jobs.forEach(row => queue.add(() => processRow(row)));
        } else {
          if (queue.size === 0 && queue.pending === 0) {
            console.log(`Queue empty. Waiting ${backoffMs}ms...`);
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, maxBackoff);
          } else {
            await sleep(1000);
          }
        }
      } else {
        await sleep(200);
      }
    } catch (error) {
      console.error("Main loop error:", error);
      await sleep(5000);
    }
  }
}

async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down...`);
  shuttingDown = true;
  await queue.onIdle();
  await closeSharedBrowser();
  console.log('Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

mainLoop().catch(err => {
  console.error('Fatal crash:', err);
  process.exit(1);
});
