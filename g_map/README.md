# Google Maps Worker - Complete Process Documentation

## Overview
This worker processes location-based queries from the `client_queries` table, fetches business data from an external Google Maps API, filters results by client-specific ZIP codes, and stores them in `client_query_results`.

---

## Architecture Components

### 1. Database Tables

#### `client_details`
Stores ZIP code filters for each client.
```sql
- client_tag: text (unique identifier for client)
- zip_codes: text[] (array of allowed ZIP codes)
```

#### `client_queries`
Queue of location queries to process.
```sql
- id: bigint (primary key)
- client_tag: text (client identifier)
- query: text (search query, e.g., "restaurants")
- status: text (auto_queued, auto_processing, auto_completed, auto_error)
- api_status: text (API response status or error message)
- region: text (country/region)
- latitude: numeric
- longitude: numeric
- length: int (number of results found)
```

#### `client_query_results`
Filtered business results.
```sql
- id: bigint (primary key)
- client_query_id: bigint (references client_queries)
- client_tag: text
- name: text (business name)
- website: text (unique)
- types: text[] (business categories)
- zip_code: text (extracted from address)
- phone_number: text
- full_address: text
- city: text
- place_link: text
- timezone: text
- review_count: int
- rating: numeric
```

---

## Process Flow

### Phase 1: Startup & Initialization

1. **Load Environment Variables**
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `EXTERNAL_API_URL`, `SCRAPER_API_KEY`
   - `MAX_CONCURRENCY` (default: 100)
   - `DEBUG` mode

2. **Initialize Supabase Client**
   - Creates connection to database
   - Disables auto-refresh and session persistence

3. **Load ZIP Code Cache**
   - Fetches all records from `client_details` table
   - Builds in-memory cache: `Map<client_tag, Set<zip_codes>>`
   - Logs number of client tags loaded

4. **Startup Health Check**
   - Counts queued jobs in `client_queries`
   - Logs initial queue status

---

### Phase 2: Main Processing Loop

#### Step 1: Check Available Slots
```
Current Pending Jobs = queue.pending
Available Slots = MAX_CONCURRENCY - Current Pending Jobs
```

#### Step 2: Fetch Jobs from Database
- Calls `fetch_auto_queries(batch_size)` RPC function
- Fetches jobs with status: `auto_queued` or `auto_error`
- Prioritizes `auto_queued` over `auto_error`
- Updates status to `auto_processing`
- Uses `FOR UPDATE SKIP LOCKED` to prevent race conditions

#### Step 3: Queue Jobs for Processing
- Each job is added to the p-queue
- p-queue manages concurrency automatically
- Jobs process in parallel up to MAX_CONCURRENCY limit

---

### Phase 3: Individual Job Processing

#### Step 1: Call External API
```javascript
GET EXTERNAL_API_URL
Params:
  - query: "restaurants"
  - lat: 40.7128
  - lng: -74.0060
  - country: "US"
  - lang: "en"
  - limit: 0
  - offset: 0
  - zoom: 12
Headers:
  - scraper-key: SCRAPER_API_KEY
Timeout: 120000ms (2 minutes)
```

#### Step 2: Parse API Response
- Checks if `response.data.status === 'ok'`
- Extracts businesses array from `response.data.data`

#### Step 3: Extract & Map Business Data
For each business:
```javascript
{
  client_query_id: row.id,
  client_tag: row.client_tag,
  name: biz.name,
  website: biz.website,
  types: biz.types,
  zip_code: extractZipCode(biz.full_address_array),
  phone_number: biz.phone_number,
  full_address: biz.full_address,
  city: biz.city,
  place_link: biz.place_link,
  timezone: biz.timezone,
  review_count: biz.review_count,
  rating: biz.rating
}
```

#### Step 4: ZIP Code Extraction
Uses regex patterns to extract ZIP codes from address:
- **US Format:** `12345` or `12345-6789`
- **UK Format:** `SW1A 1AA`, `E1 6AN`
- **Canada Format:** `A1A 1A1`

#### Step 5: Filter by ZIP Code (Thread-Safe)
```javascript
For each result:
  1. Check if zip_code is not null
  2. Check if website is not null
  3. Call isZipCodeAllowed(client_tag, zip_code)
     - If client_tag not in cache:
       a. Acquire mutex lock (prevents concurrent refreshes)
       b. Refresh entire cache from client_details table
       c. Release lock and notify waiting threads
       d. Check cache again
     - Return true if zip_code in allowed set
  4. Keep result only if all checks pass
```

**Race Condition Protection:**
- Multiple concurrent jobs may encounter new client_tag
- Mutex ensures only ONE cache refresh happens
- Other jobs wait for refresh to complete
- All jobs use the refreshed cache

#### Step 6: Check for Duplicate Websites
```javascript
1. Extract all websites from filtered results
2. Query "google map scraped data v1" table
3. Get existing websites
4. Filter out results with existing websites
```

#### Step 7: Insert Results
```javascript
For each new result:
  1. Insert into client_query_results
  2. Ignore unique constraint violations (code 23505)
  3. Throw other errors
```

**Trigger Activated:**
After insert, `trg_add_website_to_email_scraper_auto` trigger:
- Checks if parent query status is `auto_completed`
- Inserts website into `email_scraper_node` with status `auto_queued`
- Uses `ON CONFLICT DO NOTHING` to avoid duplicates

#### Step 8: Update Query Status
```sql
UPDATE client_queries
SET 
  status = 'auto_completed',
  api_status = 'auto_ok',
  length = <number_of_businesses>
WHERE id = <query_id>
```

---

### Phase 4: Error Handling

If any error occurs during processing:

1. **Increment Error Counter**
   ```javascript
   stats.errors++
   ```

2. **Parse Error Message**
   - Axios timeout: "Timeout"
   - API error: "API Error 500: <message>"
   - Other: Error message string

3. **Update Query Status**
   ```sql
   UPDATE client_queries
   SET 
     status = 'auto_error',
     api_status = '<error_message>'
   WHERE id = <query_id>
   ```

4. **Job Will Be Retried**
   - Next loop iteration will fetch `auto_error` jobs
   - Retries automatically

---

## Concurrency & Performance

### Queue Management
- **p-queue** library handles concurrency
- Max concurrent jobs: `MAX_CONCURRENCY` (default: 100)
- Jobs process in parallel
- Automatic backpressure management

### Backoff Strategy
```javascript
If no jobs available:
  - Start with 1000ms wait
  - Double wait time on each empty check
  - Max wait: 60000ms (1 minute)
  - Reset to 1000ms when jobs found
```

### Cache Strategy
- **Startup:** Load all client ZIP codes once
- **Runtime:** Refresh all when new client_tag detected
- **Thread-Safe:** Mutex prevents concurrent refreshes
- **Memory Efficient:** Uses Set for O(1) ZIP code lookups

---

## Statistics Tracking

Real-time stats logged for each job:
```javascript
stats = {
  processed: 0,    // Successfully completed jobs
  errors: 0,       // Failed jobs
  active: 0,       // Currently processing
  queuedInDb: 0    // Waiting in database
}
```

Log format:
```
[Worker] ClientQuery 12345 finished in 2500ms (Active: 45)
```

---

## Graceful Shutdown

### Signals Handled
- `SIGINT` (Ctrl+C)
- `SIGTERM` (Docker stop)

### Shutdown Process
1. Set `shuttingDown = true`
2. Stop fetching new jobs
3. Wait for all active jobs to complete (`queue.onIdle()`)
4. Log "Goodbye."
5. Exit with code 0

---

## Configuration

### Required Environment Variables
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
EXTERNAL_API_URL=https://api.example.com/maps
SCRAPER_API_KEY=your-api-key
```

### Optional Environment Variables
```env
MAX_CONCURRENCY=100        # Max parallel jobs
API_CALL_DELAY=250         # Delay between API calls (currently unused)
DEBUG=false                # Enable debug logging
```

---

## Database Functions

### `fetch_auto_queries(p_batch_size int)`
```sql
- Selects jobs with status: auto_queued or auto_error
- Prioritizes auto_queued over auto_error
- Updates status to auto_processing
- Uses FOR UPDATE SKIP LOCKED (prevents race conditions)
- Returns selected rows
```

---

## Data Flow Diagram

```
┌─────────────────┐
│ client_details  │
│ (ZIP filters)   │
└────────┬────────┘
         │ Load at startup
         ↓
┌─────────────────┐
│  ZIP Code Cache │ ←─── Refresh when new client_tag found
│   (In Memory)   │
└────────┬────────┘
         │
         │
┌────────▼────────┐
│ client_queries  │
│ (auto_queued)   │
└────────┬────────┘
         │ Fetch batch
         ↓
┌─────────────────┐
│  Worker Queue   │
│  (p-queue)      │
└────────┬────────┘
         │ Process concurrently
         ↓
┌─────────────────┐
│  External API   │
│  (Google Maps)  │
└────────┬────────┘
         │ Return businesses
         ↓
┌─────────────────┐
│ Extract & Map   │
│ Business Data   │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Filter by ZIP   │ ←─── Check against cache
│ (Thread-Safe)   │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Check Duplicates│
│ (existing data) │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│client_query_    │
│    results      │
└────────┬────────┘
         │ Corn function copy url
│ (copy url to scraper) │
         ↓
┌─────────────────┐
│email_scraper_   │
│     node        │
│ (auto_queued)   │
└─────────────────┘
```

---

## Example Workflow

### Setup
1. Insert client ZIP codes:
```sql
INSERT INTO client_details (client_tag, zip_codes)
VALUES ('client_a', ARRAY['10001', '10002', '10003']);
```

2. Insert queries:
```sql
INSERT INTO client_queries (client_tag, query, status, region, latitude, longitude)
VALUES 
  ('client_a', 'restaurants', 'auto_queued', 'US', 40.7128, -74.0060),
  ('client_a', 'hotels', 'auto_queued', 'US', 40.7128, -74.0060);
```

### Processing
1. Worker starts and loads ZIP codes for `client_a`
2. Fetches 2 queries from database
3. Calls API for each query in parallel
4. API returns 50 businesses for "restaurants"
5. Extracts ZIP codes from addresses
6. Filters: keeps only businesses in 10001, 10002, or 10003
7. Result: 12 businesses match ZIP filter
8. Checks for duplicate websites
9. Inserts 10 new businesses (2 were duplicates)
10. Updates query status to `auto_completed`
11. Trigger adds 10 websites to `email_scraper_node`

### Result
```sql
SELECT * FROM client_query_results WHERE client_query_id = 1;
-- Returns 10 businesses in allowed ZIP codes

SELECT * FROM email_scraper_node WHERE client_tag = 'client_a';
-- Returns 10 websites ready for email scraping
```

---

## Monitoring & Debugging

### Check Queue Status
```sql
SELECT status, COUNT(*) 
FROM client_queries 
GROUP BY status;
```

### Check Recent Errors
```sql
SELECT id, query, api_status, created_at
FROM client_queries
WHERE status = 'auto_error'
ORDER BY created_at DESC
LIMIT 10;
```

### Check Results Count
```sql
SELECT client_tag, COUNT(*) as total_results
FROM client_query_results
GROUP BY client_tag;
```

### Enable Debug Mode
```env
DEBUG=true
```
Logs full API responses for troubleshooting.

---

## Common Issues & Solutions

### Issue: No results inserted
**Cause:** Client ZIP codes not configured
**Solution:** 
```sql
INSERT INTO client_details (client_tag, zip_codes)
VALUES ('your_client', ARRAY['12345', '67890']);
```

### Issue: All results filtered out
**Cause:** ZIP codes in API response don't match client's allowed list
**Solution:** Verify ZIP codes in API response match client_details

### Issue: Worker stops processing
**Cause:** Database connection lost
**Solution:** Worker will retry automatically, check database connectivity

### Issue: Duplicate websites
**Cause:** Website already exists in client_query_results
**Solution:** Unique constraint prevents duplicates, error is ignored (code 23505)

---

## Performance Optimization

### Current Optimizations
1. **Batch fetching:** Fetches multiple jobs at once
2. **Parallel processing:** Up to 100 concurrent jobs
3. **In-memory cache:** O(1) ZIP code lookups
4. **Skip locked:** Prevents database lock contention
5. **Mutex protection:** Prevents redundant cache refreshes

### Tuning Parameters
- Increase `MAX_CONCURRENCY` for faster processing (requires more resources)
- Decrease for lower resource usage
- Monitor database connection pool limits

---

## Deployment

### Docker
```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "worker.ts"]
```

### Run
```bash
npm install
node worker.ts
```

### Stop Gracefully
```bash
# Sends SIGTERM, waits for jobs to complete
docker stop <container_id>
```

---

## Future Enhancements

1. **Metrics Dashboard:** Export stats to monitoring system
2. **Rate Limiting:** Add configurable API rate limits
3. **Retry Logic:** Exponential backoff for failed jobs
4. **Dead Letter Queue:** Move permanently failed jobs
5. **Health Endpoint:** HTTP endpoint for health checks
6. **Distributed Workers:** Multiple worker instances with coordination

---

## Support

For issues or questions:
1. Check logs for error messages
2. Verify database connectivity
3. Confirm API credentials are valid
4. Review client_details configuration
