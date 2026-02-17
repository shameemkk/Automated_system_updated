"""Pipelines for scrapy_worker."""
from typing import Any, Dict


# Shared state for worker aggregation (populated by CollectPipeline, read by worker)
collect_state: Dict[str, Any] = {}


class CollectPipeline:
    """Aggregates scrape results for the worker to read."""

    def open_spider(self, spider):
        collect_state.clear()
        collect_state.update({"emails": set(), "fb": set(), "urls": [], "errors": []})

    def process_item(self, item, spider):
        collect_state.setdefault("emails", set()).update(item.get("emails", []) or [])
        collect_state.setdefault("fb", set()).update(item.get("facebook_urls", []) or [])
        if item.get("url"):
            collect_state.setdefault("urls", []).append(item["url"])
        if item.get("error"):
            collect_state.setdefault("errors", []).append(
                {"url": item.get("url"), "error": item["error"]}
            )
        return item
