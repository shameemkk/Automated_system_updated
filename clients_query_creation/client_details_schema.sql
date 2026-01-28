-- Schema for client_details table in Supabase
-- This table stores client information with their service locations including coordinates

CREATE TABLE IF NOT EXISTS client_details (
  id BIGSERIAL PRIMARY KEY,
  client_tag TEXT NOT NULL UNIQUE,
  locations JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on client_tag for faster lookups
CREATE INDEX IF NOT EXISTS idx_client_details_client_tag ON client_details(client_tag);

-- Create index on locations for JSONB queries
CREATE INDEX IF NOT EXISTS idx_client_details_locations ON client_details USING GIN(locations);

-- Add comment to table
COMMENT ON TABLE client_details IS 'Stores client information with their service area locations including latitude and longitude coordinates';

-- Add comments to columns
COMMENT ON COLUMN client_details.client_tag IS 'Unique identifier for the client (e.g., [freedomext])';
COMMENT ON COLUMN client_details.locations IS 'Array of location data in format: [["zip, city, state, country", "latitude", "longitude"], ...]';

-- Example data structure:
-- locations: [
--   ["70506, Lafayette, LA, US", "30.2002897", "-92.0763253"],
--   ["70503, Lafayette, LA, US", "30.1716722", "-92.0616178"]
-- ]
