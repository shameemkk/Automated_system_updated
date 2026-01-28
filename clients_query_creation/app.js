import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-api-key';

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware
app.use(express.json());

// API Key validation middleware
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key is required in x-api-key header' });
  }
  
  if (apiKey !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  next();
};

// Load business categories from CSV
function loadBusinessCategories() {
  const csvPath = path.join(__dirname, 'Businesses Categories - Google 2025 - Businesses Categories - Google 2025.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = csvContent.split('\n');
  
  // Skip header and filter empty lines
  const categories = lines
    .slice(1)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  return categories;
}

// API endpoint to generate queries
app.get('/api/generate-queries', validateApiKey, async (req, res) => {
  try {
    const { client_tag, region } = req.query;
    
    if (!client_tag) {
      return res.status(400).json({ error: 'client_tag query parameter is required' });
    }
    
    if (!region) {
      return res.status(400).json({ error: 'region query parameter is required' });
    }
    
    console.log('Client Tag:', client_tag);
    console.log('Region:', region);
    
    // Fetch locations from client_details
    const { data, error } = await supabase
      .from('client_details')
      .select('locations')
      .eq('client_tag', client_tag)
      .single();
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(404).json({ error: 'Client tag not found', details: error.message });
    }
    
    if (!data || !data.locations || data.locations.length === 0) {
      return res.status(404).json({ error: 'No locations found for this client tag' });
    }
    
    const locations = data.locations;
    console.log('Locations found:', locations.length);
    
    // Load business categories
    const businessCategories = loadBusinessCategories();
    console.log('Business categories loaded:', businessCategories.length);
    
    // Generate queries: Business Category + Location with coordinates
    const queries = [];
    
    for (const category of businessCategories) {
      for (const location of locations) {
        // location format: ["70506, Lafayette, LA, US", "30.2002897", "-92.0763253"]
        const locationStr = Array.isArray(location) ? location[0] : location;
        const latitude = Array.isArray(location) && location[1] ? location[1] : null;
        const longitude = Array.isArray(location) && location[2] ? location[2] : null;
        
        const query = `${category}, ${locationStr}`;
        queries.push({
          query: query,
          latitude: latitude,
          longitude: longitude
        });
      }
    }
    
    console.log('Total queries generated:', queries.length);
    console.log('Inserting queries using RPC function...');
    
    // Extract query strings, latitudes, and longitudes for RPC function
    const queryStrings = queries.map(q => q.query);
    const latitudes = queries.map(q => q.latitude);
    const longitudes = queries.map(q => q.longitude);
    
    // Use RPC function for bulk insert (much faster)
    const { data: rpcData, error: rpcError } = await supabase
      .rpc('bulk_insert_client_queries', {
        p_client_tag: client_tag,
        p_region: region,
        p_queries: queryStrings,
        p_latitudes: latitudes,
        p_longitudes: longitudes
      });
    
    if (rpcError) {
      console.error('Error inserting queries:', rpcError);
      return res.status(500).json({ 
        error: 'Failed to insert queries into database', 
        details: rpcError.message 
      });
    }
    
    if (!rpcData.success) {
      console.error('RPC function error:', rpcData.error);
      return res.status(500).json({ 
        error: 'Failed to insert queries', 
        details: rpcData.error 
      });
    }
    
    console.log('✅ Successfully inserted all queries into client_queries table');
    
    res.json({
      success: true,
      client_tag,
      region,
      locations_count: locations.length,
      categories_count: businessCategories.length,
      total_queries: queries.length,
      inserted_count: rpcData.inserted_count,
      message: 'All queries have been inserted into client_queries table using RPC'
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 API endpoint: http://localhost:${PORT}/api/generate-queries?client_tag=[your-tag]`);
  console.log(`🔑 Remember to include x-api-key header in your requests`);
});
