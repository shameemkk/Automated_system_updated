import scrapy


class ScrapeResultItem(scrapy.Item):
    """Result from scraping a single page."""

    url = scrapy.Field()
    emails = scrapy.Field()  # list of str
    facebook_urls = scrapy.Field()  # list of str
    links = scrapy.Field()  # list of str (same-domain links for subpage crawl)
    error = scrapy.Field()  # str or None
