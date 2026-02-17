-- index
CREATE INDEX IF NOT EXISTS idx_client_query_mode_auto 
ON client_query_results (id) 
WHERE mode = 'auto';

-- functions 

-- # task : copy website url from client_query_results to email_scraper_node 
-- description : add url to email_scraper_node for email scraping

CREATE OR REPLACE FUNCTION process_client_query_results_to_email_scraper_node()
RETURNS void AS $$
DECLARE
  processed_count int;
BEGIN
  -- 1. Identify, Lock, and Update 50 rows safely
  WITH locked_rows AS (
    SELECT 
      id, 
      website, 
      client_tag,
      automation_id  -- Added automation_id here
    FROM client_query_results
    WHERE mode = 'auto'
      AND website IS NOT NULL
      AND website != ''
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  ),
  updated_rows AS (
    UPDATE client_query_results
    SET mode = 'auto_taken'
    FROM locked_rows
    WHERE client_query_results.id = locked_rows.id
    -- Pass automation_id through to the next step
    RETURNING locked_rows.website, locked_rows.client_tag, locked_rows.automation_id
  ),
  -- 2. Insert exactly the rows that were updated
  inserted_rows AS (
    INSERT INTO email_scraper_node (
      url, 
      client_tag, 
      status, 
      mode, 
      automation_id -- Added column to insert list
    )
    SELECT 
      website,
      client_tag,
      'auto_queued',
      'auto',
      automation_id -- Added value to select list
    FROM updated_rows
    RETURNING 1
  )
  -- 3. Count results for logging
  SELECT count(*) INTO processed_count FROM inserted_rows;

  -- 4. Log the output
  RAISE NOTICE 'Processed % auto results with automation_id', processed_count; 
END;
$$ LANGUAGE plpgsql;

-- Schedule the new job
select cron.schedule(
  'add-url-to-email-scraper',          -- Unique name for the job
  '*/2 * * * *',                    -- Cron syntax (Every 2 minute)
  'select process_client_query_results_to_email_scraper_node()' -- The command to run
);


-- RPC Function for batch updating email_scraper_node rows (reduces individual update calls)
CREATE OR REPLACE FUNCTION auto_batch_update_email_scraper_nodes(updates JSONB)
RETURNS INT AS $$
DECLARE
  total_affected INT := 0;
  row_affected INT;
  u JSONB;
BEGIN
  FOR u IN SELECT value FROM jsonb_array_elements(updates)
  LOOP
    UPDATE public.email_scraper_node
    SET
      status = (u->>'status')::text,
      emails = ARRAY(SELECT jsonb_array_elements_text(COALESCE(u->'emails', '[]'::jsonb))),
      facebook_urls = ARRAY(SELECT jsonb_array_elements_text(COALESCE(u->'facebook_urls', '[]'::jsonb))),
      message = (u->>'message')::text,
      needs_browser_rendering = COALESCE((u->>'needs_browser_rendering')::boolean, false),
      updated_at = NOW()
    WHERE id = (u->>'id')::bigint;

    GET DIAGNOSTICS row_affected = ROW_COUNT;
    total_affected := total_affected + row_affected;
  END LOOP;

  RETURN total_affected;
END;
$$ LANGUAGE plpgsql;

