-- RPC Function to get outscraper_pending jobs that need status check (updated_at > 2 minutes ago)
CREATE OR REPLACE FUNCTION get_stale_pending_jobs(batch_size INT DEFAULT 10)
RETURNS SETOF public.email_scraper_node AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.email_scraper_node
  WHERE status = 'outscraper_pending'
    AND scrape_type = 'outscraper'
    AND updated_at < NOW() - INTERVAL '2 minutes'
  ORDER BY updated_at ASC
  LIMIT batch_size;
END;
$$ LANGUAGE plpgsql;