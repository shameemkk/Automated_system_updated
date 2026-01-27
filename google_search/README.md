# Google Search Worker

## Overview
The Google Search Worker is a fallback mechanism that searches Google for email addresses when the HTTP Request Worker couldn't find any. It uses the RapidAPI Google Search API to find emails associated with a domain.

## How It Works

### 1. Job Processing Flow
```
auto_need_google_search → auto_gs_processing → auto_completed/auto_gs_error
```

### 2. Status Transitions

- **auto_need_google_search**: Job needs Google Search (from HTTP Request Worker)
- **auto_gs_processing**: Currently searching Google
- **auto_completed**: Successfully found emails via Google Search
- **auto_gs_error**: Search failed (with retry logic)

### 3. Search Strategy

For each URL, the worker:

1. Extracts the domain from the URL (e.g., `example.com`)
2. Constructs a Google search query: `{domain} emails (site:{domain})`
3. Calls RapidAPI Google Search API
4. Extracts emails from search results using regex
5. Updates database with found emails

### 4. Email Extraction

Emails are extracted from:
- Search result titles
- Search result descriptions
- Search result URLs
- Knowledge panel descriptions

Uses regex pattern: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`

### 5. Rate Limiting

**Important**: RapidAPI has strict rate limits

- **Max Concurrency**: 6 requests/second
- **API Call Delay**: 170ms between requests
- Configured to respect API limits automatically

### 6. Error Handling

- Failed searches are marked as `auto_gs_error`
- Automatic retry for error jobs when queue is empty
- Retries jobs with `auto_gs_error` status

## Configuration

Environment variables in `.env`:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_service_key
RAPIDAPI_KEY=your_rapidapi_key
RAPIDAPI_HOST=google-search116.p.rapidapi.com
```

## Database Schema

Uses table: `email_scraper_node`

Key columns:
- `id`: Primary key
- `url`: Website URL to search for
- `status`: Current job status
- `scrape_type`: Set to 'google_search'
- `emails`: Array of extracted emails (updated)
- `message`: Error message if failed

## API Details

### RapidAPI Google Search API

**Endpoint**: `https://google-search116.p.rapidapi.com/`

**Headers**:
```
x-rapidapi-key: YOUR_API_KEY
x-rapidapi-host: google-search116.p.rapidapi.com
```

**Query Parameters**:
- `query`: Search query string

**Timeout**: 300 seconds (5 minutes)

## Running the Worker

```bash
npm install
npm start
```

## Performance

- Rate limited to 6 requests/second
- Typical processing time: 2-10 seconds per URL
- Timeout: 5 minutes per request
- Automatic backoff when no jobs available

## Cost Considerations

- RapidAPI charges per request
- Monitor your API usage on RapidAPI dashboard
- Consider implementing daily/monthly limits

## Limitations

- Depends on Google search results quality
- May not find emails if they're not indexed by Google
- Rate limits can slow down processing
- API costs can add up with high volume

## Next Steps

After processing:
- **auto_completed**: Job finished with emails found
- **auto_gs_error**: Failed jobs can be retried
