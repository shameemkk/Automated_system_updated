-- Cron function to process auto_completed records with no emails for outscraper
create or replace function public.process_outscraper_fallback()
returns void
language plpgsql
security definer
as $$
begin
  update public.email_scraper_node
  set
    status = 'auto_need_outscraper',
    scrape_type = 'outscraper', -- Switches the type so the Outscraper worker picks it up
    retry_count = 0,            -- Optional: Reset retries for the new method
    message = 'Queued for outscraper processing - no emails found in previous attempt',
    updated_at = now()
  where
    status = 'auto_completed'
    and (emails is null or cardinality(emails) = 0) -- Checks for no emails
    and scrape_type != 'outscraper' -- Avoid reprocessing outscraper jobs
    and retry_count < 3; -- Limit retries
end;
$$;

-- Enable the extension if not already enabled
create extension if not exists pg_cron;

-- Schedule the job to run every 5 minutes
select
  cron.schedule(
    'check-outscraper-fallback',  -- Job name
    '*/5 * * * *',                -- Schedule: Every 5 minutes
    $$select public.process_outscraper_fallback()$$
  );