"""
Email spider - extracts emails and Facebook URLs from JS-rendered pages.
Optimized for more emails and speed.
"""
import json
import os
import re
from urllib.parse import urljoin, urlparse

import scrapy
from scrapy_playwright.page import PageMethod

from scrapy_worker.email_filter import filter_emails
from scrapy_worker.items import ScrapeResultItem

# Config (from env / reference)
MAX_DEPTH = max(1, int(os.environ.get("MAX_DEPTH", "2")))
MAX_LINKS_PER_PAGE = max(1, int(os.environ.get("MAX_LINKS_PER_PAGE", "50")))
MAX_SUBPAGE_CRAWLS = max(1, int(os.environ.get("MAX_SUBPAGE_CRAWLS", "20")))
EARLY_EXIT_EMAIL_COUNT = int(os.environ.get("EARLY_EXIT_EMAIL_COUNT", "3"))
COMMON_PAGE_PATHS = ["/contact", "/about", "/contact-us", "/about-us"]

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36",
]

EMAIL_REGEX = re.compile(
    r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
)
# Obfuscated patterns: name [at] domain [dot] com, name(at)domain(dot)com
EMAIL_OBFUSCATED = re.compile(
    r"[a-zA-Z0-9._%+-]+\s*[\[\(]?\s*at\s*[\]\)]?\s*[a-zA-Z0-9.-]+\s*[\[\(]?\s*dot\s*[\]\)]?\s*[a-zA-Z]{2,}",
    re.I,
)
FB_REGEX = re.compile(
    r"https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com)[^\s\"'<>]+",
    re.I,
)


def _deobfuscate_email(s: str) -> str:
    """Convert 'x [at] y [dot] com' -> 'x@y.com'."""
    s = re.sub(r"\s*[\[\(]?\s*at\s*[\]\)]?\s*", "@", s, flags=re.I)
    s = re.sub(r"\s*[\[\(]?\s*dot\s*[\]\)]?\s*", ".", s, flags=re.I)
    return s.strip()


def _extract_emails_from_json(obj) -> list:
    """Recursively extract email strings from JSON."""
    out = []
    if isinstance(obj, str) and "@" in obj and "." in obj:
        for m in EMAIL_REGEX.finditer(obj):
            out.append(m.group(0))
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and "email" in k.lower() and isinstance(v, str):
                for m in EMAIL_REGEX.finditer(v):
                    out.append(m.group(0))
            out.extend(_extract_emails_from_json(v))
    elif isinstance(obj, list):
        for x in obj:
            out.extend(_extract_emails_from_json(x))
    return out


def clean_url(url: str) -> str:
    try:
        from urllib.parse import urlparse, urlunparse

        p = urlparse(url)
        return urlunparse((p.scheme, p.netloc, p.path or "/", "", p.query, ""))
    except Exception:
        return url.split("#")[0]


class EmailSpider(scrapy.Spider):
    name = "email"
    custom_settings = {
        "PLAYWRIGHT_PAGE_GOTO_KWARGS": {
            "wait_until": "domcontentloaded",
        },
    }

    def __init__(self, url: str = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not url:
            raise ValueError("url argument required")
        self.start_url = url
        self._user_agent_idx = 0
        self._total_emails_found = 0  # Early exit when >= EARLY_EXIT_EMAIL_COUNT

    def start_requests(self):
        req = scrapy.Request(
            self.start_url,
            meta={
                "playwright": True,
                "playwright_page_methods": [
                    PageMethod("wait_for_load_state", "domcontentloaded"),
                ],
                "playwright_page_goto_kwargs": {
                    "wait_until": "domcontentloaded",
                },
                "crawl_depth": 0,
                "base_origin": urlparse(self.start_url).netloc,
            },
            errback=self.errback,
        )
        ua = USER_AGENTS[self._user_agent_idx % len(USER_AGENTS)]
        self._user_agent_idx += 1
        req.headers["User-Agent"] = ua
        yield req

    def errback(self, failure):
        self.logger.error("Request failed: %s", failure.request.url)
        yield ScrapeResultItem(
            url=failure.request.url,
            emails=[],
            facebook_urls=[],
            links=[],
            error=str(failure.value) if failure.value else "Request failed",
        )

    def parse(self, response, **kwargs):
        depth = response.meta.get("crawl_depth", 0)
        base_origin = response.meta.get("base_origin", "")
        current_url = response.url

        emails = set()
        facebook_urls = set()
        links = set()

        # mailto links
        for a in response.css('a[href^="mailto:"]'):
            href = a.attrib.get("href", "")
            if href.startswith("mailto:"):
                email = href[7:].strip().split("?")[0].split("#")[0]
                if email:
                    emails.add(email)

        # JSON-LD (schema.org ContactPoint, Organization, etc.)
        for script in response.css('script[type="application/ld+json"]::text').getall():
            try:
                data = json.loads(script)
                for e in _extract_emails_from_json(data):
                    emails.add(e)
            except (json.JSONDecodeError, TypeError):
                pass

        # meta tags (og:email, twitter:email, etc.)
        for sel in response.css('meta[property*="email"], meta[name*="email"]'):
            content = sel.attrib.get("content", "")
            for m in EMAIL_REGEX.finditer(content):
                emails.add(m.group(0))

        # data-* attributes
        for sel in response.css(
            '[data-email], [data-contact-email], [data-address], [data-e-mail]'
        ):
            for attr in ("data-email", "data-contact-email", "data-address", "data-e-mail"):
                val = sel.attrib.get(attr, "")
                for m in EMAIL_REGEX.finditer(val):
                    emails.add(m.group(0))

        # regex in body text
        body_text = " ".join(response.css("body ::text").getall())
        for m in EMAIL_REGEX.finditer(body_text):
            emails.add(m.group(0).strip())
        for m in EMAIL_OBFUSCATED.finditer(body_text):
            emails.add(_deobfuscate_email(m.group(0)))
        for m in FB_REGEX.finditer(body_text):
            facebook_urls.add(m.group(0).strip())

        # links from anchors
        for a in response.css("a[href]"):
            href = a.attrib.get("href", "").strip()
            if not href or href.startswith("#") or href.startswith("javascript:"):
                continue
            try:
                abs_url = urljoin(current_url, href)
                parsed = urlparse(abs_url)
                if parsed.netloc != base_origin:
                    continue
                final = clean_url(abs_url)
                if final != clean_url(current_url) and len(links) < MAX_LINKS_PER_PAGE:
                    links.add(final)
                if re.search(r"facebook\.com|fb\.com", abs_url, re.I):
                    facebook_urls.add(abs_url)
            except Exception:
                pass

        emails_filtered = filter_emails(list(emails))
        self._total_emails_found += len(emails_filtered)
        links_list = list(links)[:MAX_LINKS_PER_PAGE]

        yield ScrapeResultItem(
            url=current_url,
            emails=emails_filtered,
            facebook_urls=list(facebook_urls),
            links=links_list,
            error=None,
        )

        # Early exit: stop following if we have enough emails
        if self._total_emails_found >= EARLY_EXIT_EMAIL_COUNT:
            return
        # Follow same-domain links if depth < MAX_DEPTH and no emails found yet
        if depth < MAX_DEPTH and len(emails_filtered) == 0 and links_list:
            # Add common paths first
            base_scheme = urlparse(current_url).scheme
            base_netloc = urlparse(current_url).netloc
            candidates = []
            for path in COMMON_PAGE_PATHS:
                cand = f"{base_scheme}://{base_netloc}{path}"
                if cand not in links_list and cand != clean_url(current_url):
                    candidates.append(cand)
            for link in links_list:
                if link not in candidates:
                    candidates.append(link)

            for link in candidates[:MAX_SUBPAGE_CRAWLS]:
                req = scrapy.Request(
                    link,
                    meta={
                        "playwright": True,
                        "playwright_page_methods": [
                            PageMethod("wait_for_load_state", "domcontentloaded"),
                        ],
                        "playwright_page_goto_kwargs": {
                            "wait_until": "domcontentloaded",
                        },
                        "crawl_depth": depth + 1,
                        "base_origin": base_origin,
                    },
                    errback=self.errback,
                )
                ua = USER_AGENTS[self._user_agent_idx % len(USER_AGENTS)]
                self._user_agent_idx += 1
                req.headers["User-Agent"] = ua
                yield req
