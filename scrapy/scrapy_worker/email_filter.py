"""
Email filtering logic - mirrors browser_rendering/index.js
Filters junk/placeholder/tracking emails.
"""
import re
from typing import List, Set

# Blocked domain patterns (tracking, platforms, CDNs, etc.)
BLOCKED_DOMAINS: Set[str] = {
    "sentry.io",
    "sentry.wixpress.com",
    "sentry-next.wixpress.com",
    "ingest.sentry.io",
    "newrelic.com",
    "rollbar.com",
    "datadoghq.com",
    "bugsnag.com",
    "wordpress.com",
    "wordpress.org",
    "wpengine.com",
    "wix.com",
    "squarespace.com",
    "shopify.com",
    "shopifyemail.com",
    "bigcommerce.com",
    "weebly.com",
    "webflow.io",
    "ghost.org",
    "godaddy.com",
    "cloudflare.com",
    "cloudfront.net",
    "amazonaws.com",
    "azure.com",
    "digitalocean.com",
    "linode.com",
    "heroku.com",
    "netlify.app",
    "vercel.app",
    "render.com",
    "cloudwaysapps.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "tiktok.com",
    "pinterest.com",
    "fonts.googleapis.com",
    "use.typekit.net",
    "latofonts.com",
    "fontsquirrel.com",
    "myfonts.com",
    "antsoup.com",
    "example.com",
    "domain.com",
    "email.com",
    "mysite.com",
    "sample.com",
    "test.com",
    "yoursite.com",
    "companyname.com",
    "business.com",
    "website.com",
    "businessname.com",
    "company.com",
    "info.com",
    "domain.co",
    "domain.net",
}

BLOCKED_LOCAL_PARTS: Set[str] = {
    "noreply",
    "no-reply",
    "donotreply",
    "do-not-reply",
    "firstname",
    "lastname",
    "yourname",
    "fullname",
    "username",
    "user.name",
    "johnsmith",
    "john.doe",
    "alex.smith",
    "user",
    "filler",
    "placeholder",
    "your",
    "name",
    "email",
}

# Patterns that indicate junk emails
BLOCKED_PATTERNS: List[re.Pattern] = [
    re.compile(r"^[%\s?&]"),
    re.compile(r"^@"),
    re.compile(r"@.*@"),
    re.compile(r"\.(css|js|json|xml|map|min\.js|min\.css|woff|woff2|ttf|eot|pdf)$", re.I),
    re.compile(r"\.(png|jpg|jpeg|gif|svg|webp|ico)$", re.I),
    re.compile(r"@\d+x\.(png|jpg|jpeg|gif|svg|webp)$", re.I),
    re.compile(r"^(sprite|icon|logo|banner|image|font)", re.I),
    re.compile(r"%[0-9A-Fa-f]{2}"),
    re.compile(r"\?"),
    re.compile(r"subject=", re.I),
    re.compile(r"body=", re.I),
    re.compile(r"&"),
    re.compile(r"@o\d+\.ingest\.sentry\.io", re.I),
    re.compile(r"wixpress\.com$", re.I),
    re.compile(r"sentry", re.I),
    re.compile(r"shoplocal", re.I),
    re.compile(r"news\.cfm", re.I),
]


def is_junk_email(email: str) -> bool:
    """Return True if email should be filtered out."""
    if not email or not isinstance(email, str):
        return True

    normalized = email.lower().strip()

    for pattern in BLOCKED_PATTERNS:
        if pattern.search(normalized):
            return True

    at_index = normalized.rfind("@")
    if at_index == -1 or at_index == 0 or at_index == len(normalized) - 1:
        return True

    local_part = normalized[:at_index]
    domain = normalized[at_index + 1 :]

    if local_part in BLOCKED_LOCAL_PARTS:
        return True

    if domain in BLOCKED_DOMAINS:
        return True
    for blocked in BLOCKED_DOMAINS:
        if domain.endswith(f".{blocked}"):
            return True

    if len(local_part) < 2 or len(domain) < 4:
        return True
    if "." not in domain:
        return True
    if re.search(r"^(sprite|icon|logo|banner|image|font|@\d+x)", local_part, re.I):
        return True

    return False


def filter_emails(emails: List[str]) -> List[str]:
    """Filter out junk emails."""
    return [e for e in emails if not is_junk_email(e)]
