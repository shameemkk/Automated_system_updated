-- RPC function to fetch and claim records for email verification processing
-- This function atomically fetches records with status 'auto_completed' and updates them to 'e_v_processing'

CREATE OR REPLACE FUNCTION fetch_email_verification_records(batch_size integer DEFAULT 10)
RETURNS TABLE (
    record_id bigint,
    emails text[],
    url text
)
LANGUAGE plpgsql
AS $$
DECLARE
    selected_ids bigint[];
BEGIN
    -- First, select and lock the records we want to process
    SELECT ARRAY(
        SELECT esn.id
        FROM email_scraper_node esn
        WHERE esn.status = 'auto_completed'
        AND esn.emails IS NOT NULL 
        AND array_length(esn.emails, 1) > 0
        ORDER BY esn.id ASC
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
    ) INTO selected_ids;
    
    -- If no records found, return empty result
    IF array_length(selected_ids, 1) IS NULL OR array_length(selected_ids, 1) = 0 THEN
        RETURN;
    END IF;
    
    -- Update the status of selected records to 'e_v_processing'
    UPDATE email_scraper_node 
    SET 
        status = 'e_v_processing',
        updated_at = now()
    WHERE id = ANY(selected_ids);
    
    -- Return only the essential columns needed by the worker
    RETURN QUERY
    SELECT 
        esn.id,
        esn.emails,
        esn.url
    FROM email_scraper_node esn
    WHERE esn.id = ANY(selected_ids)
    ORDER BY esn.id ASC;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION fetch_email_verification_records(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION fetch_email_verification_records(integer) TO service_role;

-- Example usage:
-- SELECT * FROM fetch_email_verification_records(5);