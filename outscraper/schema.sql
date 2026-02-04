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


-- for no emials to completed status (automation_process)
create or replace function mark_outscraper_no_emails()
returns void
language plpgsql
as $$
begin
  -- 1. Update email_scraper_node and capture the URLs that were changed
  with updated_nodes as (
    update public.email_scraper_node
    set status = 'auto_final_completed'
    where 
      scrape_type = 'outscraper'
      and mode = 'auto'
      and status = 'auto_completed'
      and (emails is null or cardinality(emails) = 0)
    returning url -- Return the URL to pass to the next update
  )
  
  -- 2. Update client_query_results using the URLs from the first step
  update public.client_query_results as cqr
  set 
    gpt_process = 'auto_completed',
    mode = 'auto_completed_noEmails'
  from updated_nodes
  where cqr.website = updated_nodes.url;
end;
$$;


select cron.schedule(
  'mark-no-emails-job', -- Unique name for the job
  '*/5 * * * *',        -- Cron syntax (every 5 minutes)
  'select mark_outscraper_no_emails();'
);