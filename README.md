# EV Station Locator

AWS CDK project for ingesting and transforming EV charging station data from Hong Kong/Shenzhen region into DynamoDB for real-time station recommendation queries.

## Project Overview

This project implements an event-driven data pipeline that:
1. Validates CSV files containing EV station information and charging metrics
2. Transforms data with geospatial indexing (7-character geohash)
3. Loads data into DynamoDB tables optimized for proximity-based queries
4. Enables real-time station recommendations based on location, availability, and pricing

## Dataset

- **Region**: Hong Kong & Shenzhen
- **Period**: September 2022 - February 2023
- **Stations**: 1,682 charging stations
- **Zones**: 275 Traffic Analysis Zones (TAZIDs)
- **Files**: 16 CSV files (7 used for ingestion)

### Data Hierarchy
```
zone-information.csv (275 zones)
    ↓
station_information.csv (1,682 stations)
    ↓
charge_1hour_*.csv (6 metrics: e_price, slow_available, fast_available, queue_time, slow_avg_duration, fast_avg_duration)
```

## Architecture

### AWS Services
- **S3**: CSV file storage with versioning and encryption
- **DynamoDB**: Two tables (Station_Information, Station_Data) with PAY_PER_REQUEST billing
- **Lambda**: 4 functions (Validation, Transformation × 2, Manifest Trigger)
- **Step Functions**: Orchestrates validation and transformation workflow
- **CloudWatch**: Logging and monitoring

### DynamoDB Schema

#### Station_Information Table
```
PK: Station_Id (NUMBER)
Attributes:
  - Latitude (NUMBER)
  - Longitude (NUMBER)
  - Geohash (STRING) - 7-character precision for proximity queries
  - SlowCount (NUMBER)
  - FastCount (NUMBER)
  - TotalChargers (NUMBER)
  - TAZID (NUMBER)

GSI 1: GeohashIndex
  PK: Geohash (STRING)
  Purpose: Find stations within proximity (e.g., 5km radius)

GSI 2: TazidIndex
  PK: TAZID (NUMBER)
  Purpose: Query all stations in a traffic zone
```

#### Station_Data Table
```
PK: Station_Id (NUMBER)
SK: Time#Attribute (STRING) - Format: "2022-09-01T00:00:00#e_price"
Attributes:
  - Value (NUMBER)
  - TAZID (NUMBER)
  - Metric (STRING)
  - Timestamp (STRING)
```

## Step Functions Workflow

### Complete Flow

```
┌─────────────────────────────┐
│  ValidateCSVFiles (Lambda)  │
│  - Schema validation        │
│  - Data quality checks      │
│  - TAZID mapping            │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ IsValidationSuccessful? (Choice)    │
└──────┬──────────────────────┬───────┘
       │                      │
    ✅ YES                   ❌ NO
       │                      │
       ▼                      ▼
┌──────────────────┐   ┌──────────────────┐
│ TransformInParallel│   │ ValidationFailed │
│    (Parallel)     │   │      (Fail)      │
└────┬─────────┬───┘   └──────────────────┘
     │         │
     ▼         ▼
┌─────────────────┐ ┌──────────────────────┐
│ TransformStation│ │TransformChargeMetrics│
│ Info (Lambda)   │ │   (Map State)        │
│ - Read CSV      │ │ ┌──────────────────┐ │
│ - Calc geohash  │ │ │ Process 6 files  │ │
│ - Write DynamoDB│ │ │ in parallel:     │ │
└─────────────────┘ │ │ • e_price        │ │
                    │ │ • slow_available │ │
                    │ │ • fast_available │ │
                    │ │ • queue_time     │ │
                    │ │ • slow_avg_dur   │ │
                    │ │ • fast_avg_dur   │ │
                    │ └──────────────────┘ │
                    └──────────────────────┘
                           │
                           ▼
            ┌──────────────────────────────┐
            │ EvaluateTransformation       │
            │ Results (Pass Task)          │
            │ - Extract success flags      │
            │ - Aggregate results          │
            └────────────┬─────────────────┘
                         │
                         ▼
            ┌─────────────────────────────┐
            │ AllTransformationsSuccessful?│
            │         (Choice)             │
            └────────┬────────────┬────────┘
                     │            │
                  ✅ YES         ❌ NO
                     │            │
                     ▼            ▼
            ┌────────────┐ ┌────────────┐
            │Transformation│ │Transformation│
            │  Complete   │ │   Failed    │
            │  (Succeed)  │ │   (Fail)    │
            └────────────┘ └────────────┘
```

### State Descriptions

| State | Type | Purpose | Success → | Failure → |
|-------|------|---------|-----------|-----------|
| **ValidateCSVFiles** | Lambda | Validate 7 CSV files (station_information + 6 charge files), build TAZID→stations mapping | IsValidationSuccessful? | - |
| **IsValidationSuccessful?** | Choice | Check validation result | TransformInParallel | ValidationFailed ❌ |
| **TransformInParallel** | Parallel | Execute station info + charge metrics transformations concurrently | EvaluateTransformationResults | - |
| **TransformStationInfo** | Lambda | Read station_information.csv, calculate 7-char geohash, write to Station_Information table | - | - |
| **TransformChargeMetrics** | Map | Process 6 charge_1hour CSV files in parallel (max concurrency: 6) | - | - |
| **TransformStationData** | Lambda | Transform charge CSV, map TAZID to stations, write to Station_Data table | - | - |
| **EvaluateTransformationResults** | Pass | Extract success flags and aggregate results | AllTransformationsSuccessful? | - |
| **AllTransformationsSuccessful?** | Choice | Check if all transformations succeeded | TransformationComplete ✅ | TransformationFailed ❌ |

### Final States

#### ✅ TransformationComplete (Success)
- All CSV files validated
- Station information loaded into `Station_Information` table with geohash
- All 6 charge metrics loaded into `Station_Data` table
- Data ready for proximity queries

#### ❌ ValidationFailed (Fail)
**Triggers when:**
- CSV schema validation fails
- Invalid data detected (missing columns, wrong types)
- Missing required files
- TAZID consistency issues

**Action**: Check Step Functions execution output for validation errors

#### ❌ TransformationFailed (Fail)
**Triggers when:**
- Lambda execution errors
- DynamoDB write failures (throttling, capacity)
- Partial data load issues
- Unprocessed items exceed retry limit

**Action**: Check Lambda CloudWatch logs for detailed error messages

## File Structure

```
EvStationLocator/
├── lib/
│   ├── ev_station_locator-stack.js       # Infrastructure declarations
│   ├── workflows/
│   │   └── csv-ingest-workflow.js        # Step Functions workflow logic
│   └── iam/
│       └── permissions.js                # Centralized IAM permission grants
├── lambda/
│   ├── shared/
│   │   └── dynamodb-utils.js             # Shared DynamoDB batch write utilities
│   ├── manifest-trigger/
│   │   └── index.js                      # Triggers Step Functions on manifest upload
│   ├── validate-csv/
│   │   └── index.js                      # CSV validation logic
│   ├── transform-station-info/
│   │   └── index.js                      # Station information transformation
│   └── transform-station-data/
│       └── index.js                      # Charge metrics transformation
├── upload-to-s3.js                       # Upload script with manifest creation
├── package.json                          # Project dependencies
└── README.md                             # This file
```

## Code Organization Principles

### 1. **Separation of Concerns**
- **Stack**: Infrastructure declarations only
- **Workflows**: Step Functions logic
- **IAM**: Centralized permission management
- **Lambda**: Business logic execution
- **Shared Utilities**: DRY principle for common operations

### 2. **Least Privilege IAM**
- `ValidateCsvFn`: S3 read only
- `ManifestTriggerFn`: S3 read + Step Functions start
- `TransformStationInfoFn`: S3 read + Station_Information write only
- `TransformStationDataFn`: S3 read + Station_Data write only

### 3. **Shared Utilities** (`lambda/shared/dynamodb-utils.js`)
- `writeToDynamoDB()`: Batch write orchestration
- `writeBatchWithRetry()`: Exponential backoff retry logic (100ms → 200ms → 400ms)
- `unmarshallItem()`: DynamoDB item unmarshalling
- `chunkArray()`: Split arrays into 25-item batches (DynamoDB limit)
- `sleep()`: Promise-based delay

**Benefits**: 114 lines of duplicated code eliminated

## Data Flow

```
CSV Upload → S3 Bucket → Manifest Created (_manifest.json)
                              ↓
                     S3 Event Notification
                              ↓
                    Manifest Trigger Lambda
                              ↓
                    Step Functions Execution
                              ↓
                    ┌─────────────────────┐
                    │  Validation Phase   │
                    └──────────┬──────────┘
                               │ (if valid)
                               ▼
                    ┌─────────────────────┐
                    │ Transformation Phase│
                    │   (Parallel)        │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
           Station_Information    Station_Data
              (1,682 items)      (~36M items)
                    │                     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Query Interface    │
                    │ (Proximity-based    │
                    │  recommendations)   │
                    └─────────────────────┘
```

## Deployment

### Prerequisites
```bash
npm install
```

### Deploy Stack
```bash
npx cdk deploy --require-approval never
```

### Upload Data
```bash
node upload-to-s3.js
```

This will:
1. Upload 16 CSV files to S3 (under `urban-ev-data/` prefix)
2. Create `_manifest.json` with file metadata
3. Trigger Step Functions execution automatically

## Monitoring

### CloudWatch Logs
- `/aws/lambda/EvStationLocatorStack-ValidateCsvFn*`
- `/aws/lambda/EvStationLocatorStack-TransformStationInfoFn*`
- `/aws/lambda/EvStationLocatorStack-TransformStationDataFn*`
- `/aws/lambda/EvStationLocatorStack-ManifestTriggerFn*`

### Step Functions Console
- Execution history with visual workflow
- Input/output for each state
- Error messages and stack traces

### DynamoDB Console
- Table item counts
- GSI query patterns
- Consumed capacity metrics

## Query Patterns

This section provides comprehensive query patterns for retrieving EV station data from DynamoDB.

### Table: Station_Information

#### Schema Details
```
Primary Key: Station_Id (NUMBER)

Attributes:
- Station_Id (NUMBER) - Unique station identifier
- Latitude (NUMBER) - Station latitude coordinate
- Longitude (NUMBER) - Station longitude coordinate
- Geohash (STRING) - 7-character geohash for proximity search (e.g., "wecpz09")
- TAZID (NUMBER) - Traffic Analysis Zone ID
- SlowCount (NUMBER) - Number of slow chargers at station
- FastCount (NUMBER) - Number of fast chargers at station
- TotalChargers (NUMBER) - Total number of chargers

GSI 1: GeohashIndex
  - Partition Key: Geohash (STRING)
  - Projection: ALL
  - Purpose: Proximity-based queries

GSI 2: TazidIndex
  - Partition Key: TAZID (NUMBER)
  - Projection: ALL
  - Purpose: Zone-level aggregation and queries
```

### Pattern 1: Get Station by ID (Direct Lookup)

**Use Case**: Retrieve complete information for a specific station

```javascript
const params = {
  TableName: 'Station_Information',
  Key: {
    Station_Id: 1002
  }
};

const result = await dynamoDb.get(params);
// Returns: Single station with all attributes
// Example: {Station_Id: 1002, Latitude: 22.7319, Longitude: 113.7800, Geohash: "wecpz09", ...}
```

### Pattern 2: Find Nearby Stations (Proximity Search using Geohash)

**Use Case**: User wants to find charging stations within 5km radius

```javascript
// Step 1: Calculate geohash from user location
const ngeohash = require('ngeohash');
const userLat = 22.5212;
const userLon = 113.9103;
const userGeohash = ngeohash.encode(userLat, userLon, 7); 
// Example result: "wecpz09"

// Step 2: Query by geohash prefix for proximity
const params = {
  TableName: 'Station_Information',
  IndexName: 'GeohashIndex',
  KeyConditionExpression: 'begins_with(Geohash, :prefix)',
  ExpressionAttributeValues: {
    ':prefix': userGeohash.substring(0, 5) // "wecpz" = ~4.9km × 4.9km area
  }
};

const result = await dynamoDb.query(params);
// Returns: All stations within approximate radius

// Step 3: Calculate actual distances and sort by proximity
const stationsWithDistance = result.Items.map(station => ({
  ...station,
  distance: calculateHaversineDistance(userLat, userLon, station.Latitude, station.Longitude)
})).sort((a, b) => a.distance - b.distance);

// Helper function: Haversine distance calculation
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in km
}
```

#### Geohash Precision Reference

| Precision | Cell Size     | Use Case                    |
|-----------|---------------|-----------------------------|
| 5         | ~5km × 5km    | City-level search           |
| 6         | ~1.2km × 600m | Neighborhood search         |
| 7         | ~150m × 150m  | Street-level search (✅ recommended) |
| 8         | ~38m × 19m    | Building-level precision    |

### Pattern 3: Get All Stations in a Zone (TAZID-based)

**Use Case**: Retrieve all stations within a specific traffic analysis zone

```javascript
// Example: User location maps to TAZID 558
const userTazid = 558;

const params = {
  TableName: 'Station_Information',
  IndexName: 'TazidIndex',
  KeyConditionExpression: 'TAZID = :tazid',
  ExpressionAttributeValues: {
    ':tazid': 558
  }
};

const result = await dynamoDb.query(params);
// Returns: All stations in zone 558 (e.g., stations [1002, 1003])
```

### Table: Station_Data

#### Schema Details
```
Primary Key: 
  - Partition Key: Station_Id (NUMBER)
  - Sort Key: Time#Attribute (STRING)

Format: "YYYY-MM-DDTHH:MM:SS#metric_name"
Example: "2022-09-01T14:00:00#e_price"

Attributes:
- Station_Id (NUMBER) - Station identifier
- Time#Attribute (STRING) - Composite sort key (timestamp + metric)
- Value (NUMBER) - Metric value
- TAZID (NUMBER) - Zone reference (for aggregation)
- Metric (STRING) - Metric name (e_price, slow_available, etc.)
- Timestamp (STRING) - ISO timestamp

Available Metrics:
- e_price: Electricity price (HKD/kWh)
- slow_available: Available slow chargers
- fast_available: Available fast chargers
- queue_time: Average queue wait time (minutes)
- slow_avg_duration: Average slow charging duration (hours)
- fast_avg_duration: Average fast charging duration (hours)
```

### Pattern 4: Get All Metrics for a Station at Specific Time

**Use Case**: Retrieve complete charging status snapshot for a station

```javascript
const params = {
  TableName: 'Station_Data',
  KeyConditionExpression: 'Station_Id = :sid AND begins_with(#sk, :time)',
  ExpressionAttributeNames: {
    '#sk': 'Time#Attribute'
  },
  ExpressionAttributeValues: {
    ':sid': 1002,
    ':time': '2022-09-01T14:00:00'
  }
};

const result = await dynamoDb.query(params);
// Returns: Array of all metrics for that timestamp
// [
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#e_price", Value: 0.85},
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#slow_available", Value: 3},
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#fast_available", Value: 2},
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#queue_time", Value: 5.2},
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#slow_avg_duration", Value: 2.5},
//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#fast_avg_duration", Value: 0.8}
// ]
```

### Pattern 5: Get Specific Metric for a Station

**Use Case**: Check current electricity price at a station

```javascript
const params = {
  TableName: 'Station_Data',
  KeyConditionExpression: 'Station_Id = :sid AND #sk = :sk',
  ExpressionAttributeNames: {
    '#sk': 'Time#Attribute'
  },
  ExpressionAttributeValues: {
    ':sid': 1002,
    ':sk': '2022-09-01T14:00:00#e_price'
  }
};

const result = await dynamoDb.query(params);
// Returns: Single metric value
// [{Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#e_price", Value: 0.85}]
```

### Pattern 6: Get Time Series Data for a Station

**Use Case**: Retrieve historical price trends for a specific station

```javascript
const params = {
  TableName: 'Station_Data',
  KeyConditionExpression: 'Station_Id = :sid AND #sk BETWEEN :start AND :end',
  ExpressionAttributeNames: {
    '#sk': 'Time#Attribute'
  },
  ExpressionAttributeValues: {
    ':sid': 1002,
    ':start': '2022-09-01T00:00:00#e_price',
    ':end': '2022-09-01T23:59:59#e_price'
  }
};

const result = await dynamoDb.query(params);
// Returns: All e_price values for Sept 1, 2022 (24 hourly data points)
```

## Complete Station Recommendation Algorithm

This comprehensive example shows how to recommend the best charging station based on user location and preferences.

```javascript
/**
 * Recommend optimal charging stations based on user location and preferences
 * 
 * @param {number} userLat - User's latitude
 * @param {number} userLon - User's longitude
 * @param {Object} userPreferences - User preferences and constraints
 * @returns {Array} Top N recommended stations with scores
 */
async function recommendStations(userLat, userLon, userPreferences = {}) {
  const {
    maxDistance = 5,        // Maximum search radius in km
    topN = 5,               // Number of recommendations to return
    preferFastCharging = false,
    maxPrice = null,        // Maximum acceptable price (HKD/kWh)
    weights = {             // Scoring weights (must sum to 1.0)
      distance: 0.3,
      price: 0.3,
      availability: 0.2,
      speed: 0.2
    }
  } = userPreferences;

  // Step 1: Find nearby stations using Geohash proximity search
  const geohash = ngeohash.encode(userLat, userLon, 7);
  const nearbyStations = await queryGeohashIndex(geohash);
  
  // Step 2: Calculate actual distances and filter by max radius
  const stationsWithDistance = nearbyStations
    .map(station => ({
      ...station,
      distance: calculateHaversineDistance(userLat, userLon, station.Latitude, station.Longitude)
    }))
    .filter(s => s.distance <= maxDistance);
  
  // Step 3: Get current charging metrics for each station
  const currentTime = getCurrentHourTimestamp(); // e.g., "2022-09-01T14:00:00"
  
  const stationsWithMetrics = await Promise.all(
    stationsWithDistance.map(async station => {
      const metrics = await getStationMetrics(station.Station_Id, currentTime);
      
      // Parse metrics into structured object
      const metricsObj = {};
      metrics.forEach(m => {
        const metricName = m['Time#Attribute'].split('#')[1];
        metricsObj[metricName] = m.Value;
      });
      
      return {
        ...station,
        metrics: metricsObj
      };
    })
  );
  
  // Step 4: Filter by price constraint if specified
  let filteredStations = stationsWithMetrics;
  if (maxPrice !== null) {
    filteredStations = filteredStations.filter(s => 
      s.metrics.e_price <= maxPrice
    );
  }
  
  // Step 5: Calculate composite scores
  const scoredStations = filteredStations.map(station => ({
    ...station,
    score: calculateCompositeScore(station, userPreferences, weights)
  }));
  
  // Step 6: Rank by score and return top N
  const rankedStations = scoredStations
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  
  return rankedStations;
}

/**
 * Calculate composite score for a station
 */
function calculateCompositeScore(station, prefs, weights) {
  // Distance score: Closer = better (inverse relationship)
  const distanceScore = (1 / (station.distance + 0.1)) * 10; // Normalize to 0-100
  
  // Price score: Cheaper = better (inverse relationship)
  const priceScore = (1 / (station.metrics.e_price + 0.1)) * 10;
  
  // Availability score: More available chargers = better
  const totalAvailable = (station.metrics.slow_available || 0) + 
                         (station.metrics.fast_available || 0);
  const availabilityScore = (totalAvailable / (station.TotalChargers + 0.1)) * 100;
  
  // Speed score: Higher ratio of fast chargers = better
  const speedScore = prefs.preferFastCharging 
    ? (station.FastCount / (station.TotalChargers + 0.1)) * 100
    : ((station.SlowCount + station.FastCount) / (station.TotalChargers + 0.1)) * 100;
  
  // Queue time penalty (if available)
  const queuePenalty = station.metrics.queue_time 
    ? Math.max(0, 100 - station.metrics.queue_time * 10) 
    : 50; // Neutral if no data
  
  // Weighted composite score
  return (
    weights.distance * distanceScore +
    weights.price * priceScore +
    weights.availability * availabilityScore +
    weights.speed * speedScore
  ) * (queuePenalty / 100); // Apply queue penalty
}

/**
 * Query stations by geohash prefix
 */
async function queryGeohashIndex(geohash) {
  const params = {
    TableName: 'Station_Information',
    IndexName: 'GeohashIndex',
    KeyConditionExpression: 'begins_with(Geohash, :prefix)',
    ExpressionAttributeValues: {
      ':prefix': geohash.substring(0, 5)
    }
  };
  
  const result = await dynamoDb.query(params);
  return result.Items;
}

/**
 * Get current metrics for a station
 */
async function getStationMetrics(stationId, timestamp) {
  const params = {
    TableName: 'Station_Data',
    KeyConditionExpression: 'Station_Id = :sid AND begins_with(#sk, :time)',
    ExpressionAttributeNames: {
      '#sk': 'Time#Attribute'
    },
    ExpressionAttributeValues: {
      ':sid': stationId,
      ':time': timestamp
    }
  };
  
  const result = await dynamoDb.query(params);
  return result.Items;
}

/**
 * Get current hour timestamp (rounded down)
 */
function getCurrentHourTimestamp() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return now.toISOString().split('.')[0]; // "2022-09-01T14:00:00"
}
```

### Example Usage

```javascript
// Example: User at Hong Kong Convention Centre looking for charging station
const recommendations = await recommendStations(
  22.2828, 114.1746, // Latitude, Longitude
  {
    maxDistance: 3,           // Within 3km
    topN: 5,                  // Top 5 recommendations
    preferFastCharging: true, // Prefer fast chargers
    maxPrice: 1.0,            // Max 1.0 HKD/kWh
    weights: {
      distance: 0.4,          // Prioritize proximity
      price: 0.2,
      availability: 0.25,
      speed: 0.15
    }
  }
);

console.log(recommendations);
// Output:
// [
//   {
//     Station_Id: 1045,
//     Latitude: 22.2845,
//     Longitude: 114.1723,
//     distance: 0.3,
//     TotalChargers: 8,
//     FastCount: 6,
//     metrics: {
//       e_price: 0.82,
//       slow_available: 1,
//       fast_available: 4,
//       queue_time: 2.5
//     },
//     score: 87.5
//   },
//   ... more stations
// ]
```

## Zone-Based Queries (Alternative Approach)

For administrative dashboards or zone-level analytics, you can query by TAZID instead of geohash.

### Get All Stations in User's Zone

```javascript
async function getStationsInUserZone(userTazid) {
  const params = {
    TableName: 'Station_Information',
    IndexName: 'TazidIndex',
    KeyConditionExpression: 'TAZID = :tazid',
    ExpressionAttributeValues: {
      ':tazid': userTazid
    }
  };
  
  const result = await dynamoDb.query(params);
  return result.Items;
}
```

### Get Stations from Multiple Zones (Zone + Neighbors)

```javascript
async function getStationsInUserAndNeighborZones(userTazid, neighborTazids) {
  const allTazids = [userTazid, ...neighborTazids];
  
  // Query all zones in parallel
  const results = await Promise.all(
    allTazids.map(tazid => getStationsInUserZone(tazid))
  );
  
  // Flatten results and remove duplicates
  const allStations = results.flat();
  const uniqueStations = Array.from(
    new Map(allStations.map(s => [s.Station_Id, s])).values()
  );
  
  return uniqueStations;
}
```

### Aggregate Zone-Level Metrics

```javascript
async function getZoneAverageMetrics(tazid, timestamp) {
  // Get all stations in zone
  const stations = await getStationsInUserZone(tazid);
  
  // Get metrics for each station
  const allMetrics = await Promise.all(
    stations.map(s => getStationMetrics(s.Station_Id, timestamp))
  );
  
  // Calculate zone-level averages
  const flatMetrics = allMetrics.flat();
  const aggregated = {
    zone: tazid,
    timestamp,
    avgPrice: average(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#e_price')).map(m => m.Value)),
    totalSlowAvailable: sum(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#slow_available')).map(m => m.Value)),
    totalFastAvailable: sum(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#fast_available')).map(m => m.Value)),
    avgQueueTime: average(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#queue_time')).map(m => m.Value))
  };
  
  return aggregated;
}

function average(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
```

## Query Performance Optimization

### 1. Caching Strategy

```javascript
// Cache static station information (changes infrequently)
const stationCache = new Map();

async function getCachedStation(stationId) {
  if (stationCache.has(stationId)) {
    return stationCache.get(stationId);
  }
  
  const station = await getStationById(stationId);
  stationCache.set(stationId, station);
  return station;
}

// Only query real-time metrics from Station_Data
```

### 2. Batch Queries

```javascript
// Use BatchGetItem for multiple stations
async function getMultipleStations(stationIds) {
  const params = {
    RequestItems: {
      'Station_Information': {
        Keys: stationIds.map(id => ({ Station_Id: id }))
      }
    }
  };
  
  const result = await dynamoDb.batchGet(params);
  return result.Responses['Station_Information'];
}
```

### 3. Geohash vs TAZID - When to Use What

| Scenario | Recommended Approach | Reason |
|----------|---------------------|--------|
| **User-facing station search** | ✅ Geohash (GeohashIndex) | Single query, precise proximity |
| **Zone-level analytics** | ✅ TAZID (TazidIndex) | Natural data grouping |
| **Administrative dashboards** | ✅ TAZID (TazidIndex) | Matches zone boundaries |
| **Mobile app "nearby stations"** | ✅ Geohash (GeohashIndex) | Fast, location-aware |
| **Hybrid: Zone + distance filter** | ✅ Both | Query by TAZID, then filter by distance |

## Performance Characteristics

- **Parallel Transformation**: 6 charge metrics processed concurrently
- **Batch Writes**: 25 items per DynamoDB BatchWriteItem
- **Retry Logic**: Exponential backoff (3 retries max)
- **Lambda Timeouts**: 
  - Validation: 5 minutes
  - TransformStationInfo: 10 minutes
  - TransformStationData: 15 minutes
- **Memory Allocation**:
  - Validation: 1024 MB
  - TransformStationInfo: 2048 MB
  - TransformStationData: 3008 MB

## Error Handling

### Validation Failures
- **Detection**: Schema mismatches, missing files, invalid data types
- **Response**: Immediate fail with detailed error report
- **Recovery**: Fix CSV files and re-upload

### Transformation Failures
- **Detection**: Lambda errors, DynamoDB throttling, unprocessed items
- **Response**: Continue processing other files (partial failure tolerance)
- **Recovery**: Check CloudWatch logs, retry failed batches

### Unprocessed Items
- **Cause**: DynamoDB capacity limits, throttling
- **Handling**: Automatic retry with exponential backoff
- **Reporting**: Returned in Lambda response for monitoring

## Useful Commands

* `npm run test`         - Perform jest unit tests
* `npx cdk deploy`       - Deploy stack to AWS
* `npx cdk diff`         - Compare deployed stack with current state
* `npx cdk synth`        - Emit synthesized CloudFormation template
* `npx cdk destroy`      - Delete the stack (WARNING: deletes all data)
* `node upload-to-s3.js` - Upload CSV files and trigger ingestion

## Problems Encountered During Development

### 1. Lambda Timeout - Processing 6.9 Million Data Points

**Problem**: TransformStationData Lambda timed out after 900 seconds (15 minutes - AWS Lambda maximum):
```json
{
  "errorType": "Sandbox.Timedout",
  "errorMessage": "RequestId: ... Error: Task timed out after 900.00 seconds"
}
```

**Data Volume Calculation**:

Let's break down where these numbers come from:

**Dataset Dimensions**:
- **275 TAZIDs** (Traffic Analysis Zones)
- **1,682 stations** total across all zones
- **Timestamps**: ~27,000 rows in charge_1hour CSV files (6 months of hourly data)
- **6 metrics** processed in parallel

**How 6.9 Million Data Points Are Generated**:

1. **Single CSV Row Processing**:
   ```
   time,102,104,105,...,1173 (276 columns total: 1 time + 275 TAZIDs)
   2022-09-01 00:00:00,0.924,0.923,1.124,...
   ```

2. **For Each Row** (e.g., one timestamp):
   - 275 TAZID columns × average 6 stations per TAZID = ~1,650 data points
   
3. **For Entire File** (e.g., e_price.csv):
   - 27,000 timestamps × 1,650 data points per row = ~44.5 million potential points
   
4. **Zone-to-Station Mapping** actually generates:
   ```javascript
   // For TAZID "102" with 4 stations: [2069, 2076, 2084, 2095]
   // One CSV value (e.g., e_price = 0.924) becomes 4 DynamoDB records:
   
   { Station_Id: 2069, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }
   { Station_Id: 2076, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }
   { Station_Id: 2084, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }
   { Station_Id: 2095, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }
   ```

5. **Actual Volume** (from CloudWatch logs):
   ```
   Finished parsing 6,893,928 data points for metric volume-11kw
   Writing 6,893,928 items in 275,758 batches to Station_Data
   ```

**Where 275,758 Batches Come From**:
- DynamoDB BatchWriteItem supports maximum **25 items per batch**
- 6,893,928 data points ÷ 25 items/batch = 275,757.12 ≈ **275,758 batches**

**Why It Times Out**:
- Each batch write takes ~130-250ms (including retries for unprocessed items)
- 275,758 batches × 0.2 seconds average = **55,151 seconds** (~15.3 hours!)
- Lambda maximum timeout: 900 seconds (15 minutes)
- **Result**: Timeout after processing only ~4,500 batches (~2.7% of data)

**Temporary Solution** (for development/testing):
```javascript
// Limit processing to first 1,000 rows to avoid timeout
const MAX_ROWS = 1000;
let rowCount = 0;

stream.pipe(csv.parse(...))
  .on('data', (row) => {
    if (isFirstRow) { /* handle headers */ return; }
    
    rowCount++;
    if (rowCount > MAX_ROWS) return;  // Skip remaining rows
    
    // Process row...
  });
```

With 1,000 rows:
- 1,000 timestamps × 275 TAZIDs × 6 avg stations = ~1.65 million points
- 1.65M ÷ 25 = 66,000 batches
- 66,000 × 0.2s = 13,200 seconds (~3.7 hours) - still too long

**Production Solutions** (not yet implemented):
1. **Option A - Chunk Processing with Step Functions**:
   - Split CSV into date ranges (e.g., one week at a time)
   - Use Step Functions Map state to process chunks in parallel
   - 6 months ÷ 26 weeks = ~1,000 rows per chunk
   
2. **Option B - Use DynamoDB PartiQL Batch**:
   - Use `ExecuteStatement` with batching for better performance
   - Requires code restructuring

3. **Option C - Use AWS Glue or EMR**:
   - Better suited for large-scale data transformation
   - Can process millions of rows efficiently
   
4. **Option D - Stream Processing**:
   - Write to DynamoDB as data streams (avoid accumulating in memory)
   - Implement backpressure handling

5. **Option E - Data Aggregation**:
   - Instead of storing every timestamp for every station, aggregate by hour/day
   - Reduce 27,000 timestamps to ~180 days × stations

**Current Status**: Development version limited to 1,000 rows for testing. Production implementation requires architectural changes to handle full dataset.

---

## Architecture Decision: Zone-Level vs Station-Level Data Storage

### Problem Context

After thorough analysis of the UrbanEV dataset and understanding its research purpose, we identified a critical architectural mismatch between the dataset structure and our implementation approach.

**Dataset Reality**:
- Data is collected and aggregated at **zone-level** (275 TAZIDs)
- Each CSV value represents **aggregate metrics for all stations in a zone**
- Example: `occupancy = 17` means "17 charging piles are busy across all stations in TAZID 102"
- Dataset source: [UrbanEV GitHub Repository](https://github.com/IntelligentSystemsLab/UrbanEV)
- Published in Scientific Data journal (2025): "UrbanEV: An Open Benchmark Dataset for Urban Electric Vehicle Charging Demand Prediction"

**Original Implementation** (Incorrect):
- Expanded each zone-level value to create **duplicate records for every station in the zone**
- TAZID 102 with 4 stations → 1 CSV value became 4 identical DynamoDB records
- 6.9M zone-level data points → **266M station-level duplicates** (38x multiplication)
- Result: 15+ hour processing time vs 15-minute Lambda limit

### Dataset Research Findings

From the official UrbanEV documentation:

**Data Collection Methodology**:
```
"The data was aggregated both temporally (hourly) and spatially (by traffic zones)"
```

**Metric Definitions** (from GitHub README):

1. **occupancy.csv**: "Hourly EV charging occupancy rate (Unit: %)"
   - Actually represents **count** of unavailable/busy piles in the zone
   - Measured from "availability perspective" (includes occupied, broken, reserved)

2. **duration.csv**: "Hourly EV charging duration (Unit: hour)"
   - Average charging session duration for piles **actively providing electricity**
   - Measured from "utilization standpoint"

3. **volume.csv**: "Hourly EV charging volume (Unit: kWh)"
   - Total electricity delivered in the zone
   - Calculated using **rated power of charging piles** (may overestimate)

4. **volume-11kw.csv**: "Vehicle-side estimation of charging volume"
   - Alternative calculation using **11kW standard** (Tesla Model Y - most common EV)
   - Purpose: Mitigate overestimation from pile-rated power
   - More realistic for user-facing applications

5. **e_price.csv**: "Electricity price (Unit: Yuan/kWh)"
   - Cost of electricity itself (0.23-1.8 Yuan/kWh range in dataset)

6. **s_price.csv**: "Service price (Unit: Yuan/kWh)"
   - Station operator service fee (0.57-1.45 Yuan/kWh range)
   - Covers maintenance, operation, parking
   - **Total charging cost = e_price + s_price**

**Critical Note from Documentation**:
> "Our occupancy data is gathered from an availability perspective, while the duration and volume data is collected from a utilization standpoint. Specifically, the occupancy data records all unavailable or busy charging piles. In contrast, the duration and volume data only account for the piles actively providing electricity."

### Decision: Migrate to Zone-Level Storage

**New Architecture**:

#### DynamoDB Schema Changes

**Zone_Information Table** (NEW):
```javascript
{
  PK: `ZONE#${TAZID}`,              // e.g., "ZONE#102"
  latitude: 22.5212867,              // Zone centroid
  longitude: 113.9103013,
  charge_count: 40,                  // Total piles in zone (from zone-information.csv)
  area: 1577892.982,                 // Zone area in m²
  perimeter: 5119.3013,              // Zone perimeter in meters
  geohash: 'ws0q4h'                  // For proximity queries
}
```

**Station_Data Table** (UPDATED - Zone-Level):
```javascript
{
  PK: `ZONE#${TAZID}`,              // e.g., "ZONE#102"
  SK: `${timestamp}`,                // e.g., "2022-09-01T00:00:00"
  occupancy: 17,                     // Busy piles in zone
  duration: 8.833,                   // Average charging duration (minutes)
  total_price: 1.78,                 // e_price + s_price combined (Yuan/kWh)
  volume_11kw: 56.29                 // Energy delivered (kWh) - vehicle-side estimation
}
```

**Station_Information Table** (UNCHANGED):
```javascript
{
  PK: Station_Id,                    // Individual station ID
  Latitude: 22.5212,
  Longitude: 113.9103,
  TAZID: 102,                        // Link to zone
  Geohash: 'ws0q4h',
  SlowCount: 15,
  FastCount: 10,
  TotalChargers: 25
}
```

### Data Reduction Impact

**Before (Station-Level Expansion)**:
```
6 metrics × 27,000 timestamps × 275 TAZIDs × 6 stations/zone (avg)
= 266,400,000 records
= 10,656,000 DynamoDB batches
= ~592 hours processing time
```

**After (Zone-Level Storage)**:
```
4 metrics × 27,000 timestamps × 275 zones
= 29,700,000 data points → stored as 7,425,000 records (multi-metric)
= 297,000 batches
= ~16.4 hours (still needs chunking, but 97% reduction in records)
```

**With Full Dataset + Time Windowing (Last 90 Days)**:
```
4 metrics × 2,160 hours × 275 zones
= 2,376,000 data points → 594,000 records
= 23,760 batches
= ~79 minutes (still needs chunking)
```

**With Chunking (26 weekly chunks in parallel)**:
```
Each chunk: ~1,000 rows × 275 zones × 4 metrics
= 1,100,000 data points → 275,000 records per chunk
= 11,000 batches per chunk
= ~37 minutes per chunk (sequential)
= ~3-5 minutes total (parallel via Step Functions Map)
```

### Metric Optimization Decisions

**1. Combine e_price + s_price → total_price**
- **Why**: Users care about total cost, not the breakdown
- **Impact**: Reduces from 6 metrics to 5 metrics (16.7% fewer writes)
- **Trade-off**: Lose granular price breakdown (acceptable for MVP)

**2. Use volume-11kw, drop volume.csv**
- **Why**: volume-11kw provides more realistic vehicle-side estimation
- **Impact**: Reduces from 6 metrics to 5 metrics (16.7% fewer writes)
- **Trade-off**: Lose infrastructure-side capacity data (can re-add later if needed)
- **Research Context**: Dataset creators specifically added volume-11kw to mitigate overestimation from pile-rated power

**3. Store occupancy as count, not percentage**
- **Why**: Dataset already stores as count (misleading documentation)
- **Impact**: No change to storage, just correct interpretation
- **Trade-off**: None

**Combined Metric Reduction**:
- From: duration, e_price, s_price, volume, volume-11kw, occupancy (6 metrics)
- To: duration, total_price, volume_11kw, occupancy (4 metrics)
- **Result**: 33% fewer writes

### Recommendation Algorithm with Zone-Level Data

**User Request Flow**:

1. **Input**: User location (lat, lon)

2. **Find Nearby Zones**:
   ```javascript
   // Calculate distance to zone centroids (from zone-information.csv)
   const nearbyZones = zones
     .map(z => ({
       tazid: z.TAZID,
       distance: haversineDistance(userLat, userLon, z.latitude, z.longitude),
       totalPiles: z.charge_count
     }))
     .filter(z => z.distance < 5); // Within 5km
   ```

3. **Get Zone Metrics**:
   ```javascript
   // Query Station_Data for current/historical patterns
   const metrics = getZoneMetrics(nearbyZones.map(z => z.tazid), currentHour);
   // Returns: { '102': {occupancy: 17, total_price: 1.78, ...}, ... }
   ```

4. **Calculate Zone Scores**:
   ```javascript
   const scores = nearbyZones.map(zone => ({
     tazid: zone.tazid,
     score: 
       (distanceScore(zone.distance) * 0.35) +
       (availabilityScore(zone.totalPiles, metrics[zone.tazid].occupancy) * 0.40) +
       (priceScore(metrics[zone.tazid].total_price) * 0.25)
   }));
   ```

5. **Show Stations in Top Zones**:
   ```javascript
   const topZones = scores.sort((a, b) => b.score - a.score).slice(0, 3);
   const stations = topZones.flatMap(zone => getStationsInZone(zone.tazid));
   // Display actual station addresses within recommended zones
   ```

**Example User Display**:
```
🔋 Recommended Charging Zones Near You

📍 ZONE 104 - Excellent Availability (Score: 92/100)
   Distance: 0.8 km from you
   ✅ High availability: 18 of 19 piles available (95%)
   💰 Price: ¥1.65/kWh (~$0.23 USD)
   ⚡ Typical wait: 1.5 minutes
   
   Stations in this zone:
   • Station Alpha - 0.9 km (22 Futian Road)
   
---

📍 ZONE 102 - Moderate Availability (Score: 78/100)
   Distance: 0.3 km from you (closest!)
   ⚠️ Medium availability: 13 of 30 piles available (43%)
   💰 Price: ¥1.78/kWh (~$0.25 USD)
   ⚡ Typical wait: 8.8 minutes
   
   Stations in this zone:
   • Station Beta - 0.4 km (15 Huaqiang North)
   • Station Gamma - 0.5 km (8 Electronics Market)
```

### Trade-offs and Limitations

**✅ Advantages**:
- **Accuracy**: Matches how data was actually collected (zone aggregates)
- **Performance**: 97% reduction in DynamoDB writes (266M → 7.4M records)
- **Cost**: Lower DynamoDB storage and write costs
- **Timeout Resolution**: Processing time drops from 592 hours → ~80 minutes (manageable with chunking)
- **Simplicity**: No artificial data duplication
- **Research-Aligned**: Uses dataset as intended by researchers

**⚠️ Limitations**:
- **Granularity**: Cannot show real-time status of individual stations (data doesn't support this anyway)
- **Recommendation Precision**: All stations in same zone share same metrics
- **User Expectation**: Users may expect station-specific availability (we show zone availability instead)

**🔄 Mitigations**:
- **Clear UX**: Display as "Zone 102 typically has 13 of 30 piles available" instead of claiming individual station status
- **Station Selection**: Show all stations in recommended zones, let user pick based on exact location/amenities
- **Historical Patterns**: Frame as "typical availability at this time" rather than "current live status"
- **Future Enhancement**: If real-time station-level data becomes available, can add supplementary table without changing zone-level historical patterns

### Implementation Plan

**Phase 1: Data Model Changes** (Current Sprint)
- [ ] Create Zone_Information table and Lambda transformation
- [ ] Update Station_Data schema to zone-level storage
- [ ] Modify transform-station-data Lambda to NOT expand to stations
- [ ] Combine e_price + s_price during transformation
- [ ] Use volume-11kw exclusively

**Phase 2: Query Pattern Updates**
- [ ] Update recommendation algorithm for zone-based queries
- [ ] Add zone centroid distance calculations
- [ ] Create zone → stations lookup helper

**Phase 3: Chunking Implementation** (for full dataset)
- [ ] Add Step Functions Map state for chunk processing
- [ ] Split CSV by date ranges (weekly chunks)
- [ ] Parallel execution coordinator

**Phase 4: UI/UX Alignment**
- [ ] Update user-facing language to reflect zone-level recommendations
- [ ] Show zone boundaries on map (if applicable)
- [ ] Display "typical patterns" vs "live status"

### Validation Criteria

**Success Metrics**:
- [ ] Lambda completes processing within 15-minute limit
- [ ] Total records in Station_Data < 10M (vs 266M before)
- [ ] Recommendation queries return results in < 200ms
- [ ] Zone availability calculations match source data expectations

**Data Integrity Checks**:
- [ ] 275 zones in Zone_Information table
- [ ] Each zone has ~27,000 timestamp records (6 months hourly)
- [ ] All TAZID values from CSVs are represented
- [ ] Total_price = e_price + s_price (spot check)
- [ ] volume_11kw values are ≤ volume values (estimation should be lower)

---

## AWS Free Tier Optimization

### Problem Context

The initial deployment encountered two critical constraints:
1. **Lambda Timeout**: Processing 6.9M zone-level data points expanded to 266M station-level records would require 15+ hours (Lambda max: 15 minutes)
2. **Cost Concerns**: Using PAY_PER_REQUEST billing mode is not eligible for AWS Free Tier benefits

### Solution: PROVISIONED Billing with Reduced Dataset

To stay within AWS Free Tier limits while validating the architecture, we implemented strict capacity constraints and reduced the test dataset size.

#### DynamoDB Free Tier Limits (Always Free)
```
- 25 GB storage
- 25 WCU (Write Capacity Units) across all tables and GSIs
- 25 RCU (Read Capacity Units) across all tables and GSIs
```

**Important**: Free Tier only applies to **PROVISIONED** billing mode, not PAY_PER_REQUEST.

#### Capacity Allocation

**Tables:**
```javascript
Zone_Information:    3 RCU / 3 WCU
Station_Information: 3 RCU / 3 WCU
Station_Data:        3 RCU / 5 WCU  // Higher write for bulk loading
```

**Global Secondary Indexes (GSIs):**
```javascript
Zone_Information → GeohashIndex:        3 RCU / 3 WCU
Station_Information → GeohashIndex:     3 RCU / 3 WCU
Station_Information → TazidIndex:       3 RCU / 3 WCU
```

**Total Capacity Usage:**
- **Read Capacity**: 3+3+3+3+3+3 = **21 RCU** ✅ (within 25 limit)
- **Write Capacity**: 3+3+5+3+3+3 = **23 WCU** ✅ (within 25 limit)
- **Cost**: **$0.00** (completely free)

#### Dataset Reduction (MAX_ROWS Limit)

To avoid Lambda timeout with limited write capacity, we reduced the test dataset size:

**Configuration** (`lambda/transform-station-data/index.js`):
```javascript
const MAX_ROWS = 10;  // Process first 10 timestamps only
```

**Processing Calculations:**

**Per Metric:**
- 10 timestamps × 275 zones = **2,750 data points**
- Batch size: 25 items (DynamoDB BatchWriteItem limit)
- Number of batches: 2,750 ÷ 25 = **110 batches**

**With 5 WCU:**
- Write throughput: ~5 items/second (throttled by provisioned capacity)
- Processing time: 2,750 ÷ 5 = **550 seconds ≈ 9 minutes** ✅

**All 5 Metrics (duration, e_price, s_price, occupancy, volume-11kw):**
- Step Functions processes metrics in parallel (maxConcurrency: 4)
- Total items: 5 × 2,750 = **13,750 writes**
- Total time: ~9 minutes per Lambda (parallel execution)
- **Lambda timeout**: 15 minutes ✅ **NO TIMEOUT**

**Storage:**
- 13,750 items × ~150 bytes/item = **~2 MB**
- Well within 25 GB Free Tier limit ✅

#### Why These Limits?

**1. Timeout Avoidance:**
Without MAX_ROWS limit:
- Full dataset: 27,000 timestamps × 275 zones = 7,425,000 items per metric
- At 5 WCU: 7,425,000 ÷ 5 = **1,485,000 seconds = 412 hours** ❌
- Lambda max timeout: 15 minutes (900 seconds)
- **Result**: Would timeout after processing ~4,500 items

With MAX_ROWS = 10:
- 2,750 items ÷ 5 WCU = **550 seconds = 9 minutes** ✅
- Comfortable buffer of 6 minutes before timeout

**2. Free Tier Compliance:**
DynamoDB Free Tier provides:
- 2.5M write requests per month (25 WCU × 2,592,000 seconds/month)
- Our usage: 13,750 writes (0.55% of monthly limit)
- **Cost**: $0.00 ✅

**3. Architecture Validation:**
Even with 10 timestamps, we can validate:
- ✅ Zone-level storage architecture
- ✅ Data transformation pipeline
- ✅ DynamoDB schema design
- ✅ Query patterns with geohash indexing
- ✅ Step Functions orchestration
- ✅ Lambda integration

#### Production Scaling Strategy

For production deployment with full dataset (27,000 timestamps):

**Option 1: Temporary Capacity Boost**
- Increase Station_Data to 25 WCU before data load
- Process time: 7.4M items ÷ 25 = ~82 hours (still too long)
- Not recommended ❌

**Option 2: Step Functions Map with Chunking**
- Split CSV into chunks (e.g., 1000 rows per chunk)
- Process chunks in parallel using Step Functions Map state
- Each chunk: 1000 × 275 = 275,000 items
- At 25 WCU: 275,000 ÷ 25 = 11,000 seconds = ~3 hours per chunk ✅
- Process 27 chunks in parallel batches
- Recommended ✅

**Option 3: Use PAY_PER_REQUEST for Bulk Load**
- Temporarily switch Station_Data to PAY_PER_REQUEST
- Load full dataset: 37M items × $1.25/million = **~$46**
- Switch back to PROVISIONED for queries
- Cost-effective for one-time load ✅

#### Current Deployment Status

**Tables Created:**
- Zone_Information (275 zones) - PROVISIONED 3/3
- Station_Information (1,362 stations) - PROVISIONED 3/3
- Station_Data (zone-level metrics) - PROVISIONED 3/5

**Test Dataset:**
- 10 timestamps per metric
- 5 metrics processed
- 13,750 total records
- ~2 MB storage
- $0.00 cost ✅

**Next Steps for Full Dataset:**
1. Validate current architecture with test data
2. Implement Step Functions chunking strategy
3. Test with 100 timestamps (27,500 items)
4. Scale to full dataset (37M items) using Option 2 or 3

---

## Next Steps

When adding transformation and loading logic:
- Create new workflow files in `lib/workflows/`
- Add transformation Lambda in `lambda/transform-csv/`
- Add loading Lambda in `lambda/load-to-dynamodb/`
- Update `csv-ingest-workflow.js` to chain new steps
- Stack file remains clean - just add new Lambda declarations
```
