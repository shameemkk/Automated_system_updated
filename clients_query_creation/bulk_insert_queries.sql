-- PostgreSQL function for bulk inserting client queries with coordinates
-- Run this in your Supabase SQL Editor

CREATE OR REPLACE FUNCTION bulk_insert_client_queries(
  p_client_tag TEXT,
  p_region TEXT,
  p_queries TEXT[],
  p_latitudes TEXT[],
  p_longitudes TEXT[]
)
RETURNS JSON AS $$
DECLARE
  v_inserted_count INTEGER;
  v_array_length INTEGER;
BEGIN
  -- Validate array lengths match
  v_array_length := array_length(p_queries, 1);
  
  IF v_array_length != array_length(p_latitudes, 1) OR 
     v_array_length != array_length(p_longitudes, 1) THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Array lengths do not match',
      'inserted_count', 0
    );
  END IF;
  
  -- Insert all queries with coordinates in a single operation
  INSERT INTO client_queries (client_tag, query, latitude, longitude, mode, status, region)
  SELECT 
    p_client_tag,
    unnest(p_queries),
    unnest(p_latitudes)::numeric,
    unnest(p_longitudes)::numeric,
    'auto',
    'not_used',
    p_region;
  
  -- Get the number of inserted rows
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
  
  -- Return result as JSON
  RETURN json_build_object(
    'success', true,
    'inserted_count', v_inserted_count
  );
  
EXCEPTION WHEN OTHERS THEN
  -- Return error information
  RETURN json_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$ LANGUAGE plpgsql;
