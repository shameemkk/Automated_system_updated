-- Schema for client_queries table in Supabase
-- This table stores generated search queries with location coordinates

CREATE TABLE IF NOT EXISTS client_queries (
  id BIGSERIAL PRIMARY KEY,
  client_tag TEXT NOT NULL,
  region TEXT NOT NULL,
  query TEXT NOT NULL,
  latitude TEXT,
  longitude TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_client_queries_client_tag ON client_queries(client_tag);
CREATE INDEX IF NOT EXISTS idx_client_queries_region ON client_queries(region);
CREATE INDEX IF NOT EXISTS idx_client_queries_status ON client_queries(status);
CREATE INDEX IF NOT EXISTS idx_client_queries_created_at ON client_queries(created_at);
