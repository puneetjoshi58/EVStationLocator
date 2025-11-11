# EV Station Locator# EV Station Locator



AWS CDK infrastructure project for building a real-time EV charging station recommendation system using zone-level aggregated data from Hong Kong and Shenzhen.AWS CDK project for ingesting and transforming EV charging station data from Hong Kong/Shenzhen region into DynamoDB for real-time station recommendation queries.



## Table of Contents## Project Overview

- [Project Overview](#project-overview)

- [Key Features](#key-features)This project implements an event-driven data pipeline that:

- [Dataset Information](#dataset-information)1. Validates CSV files containing EV station information and charging metrics

- [Architecture Decision: Zone-Level Storage](#architecture-decision-zone-level-storage)2. Transforms data with geospatial indexing (7-character geohash)

- [DynamoDB Schema Design](#dynamodb-schema-design)3. Loads data into DynamoDB tables optimized for proximity-based queries

- [Step Functions Workflow](#step-functions-workflow)4. Enables real-time station recommendations based on location, availability, and pricing

- [Lambda Functions](#lambda-functions)

- [AWS Free Tier Optimization](#aws-free-tier-optimization)## Dataset

- [Prerequisites](#prerequisites)

- [Installation](#installation)- **Region**: Hong Kong & Shenzhen

- [Deployment](#deployment)- **Period**: September 2022 - February 2023

- [Data Upload](#data-upload)- **Stations**: 1,682 charging stations

- [Query Patterns](#query-patterns)- **Zones**: 275 Traffic Analysis Zones (TAZIDs)

- [Recommendation Algorithm](#recommendation-algorithm)- **Files**: 16 CSV files (7 used for ingestion)

- [Metrics Reference](#metrics-reference)

- [Project Structure](#project-structure)### Data Hierarchy

- [Development](#development)```

- [Limitations & Trade-offs](#limitations--trade-offs)zone-information.csv (275 zones)

- [Cost Analysis](#cost-analysis)    ↓

- [Troubleshooting](#troubleshooting)station_information.csv (1,682 stations)

- [References](#references)    ↓

charge_1hour_*.csv (6 metrics: e_price, slow_available, fast_available, queue_time, slow_avg_duration, fast_avg_duration)

---```



## Project Overview## Architecture



This project implements an **event-driven serverless data pipeline** that ingests EV charging station data from CSV files, transforms it with geospatial indexing, and loads it into DynamoDB tables optimized for proximity-based recommendation queries.### AWS Services

- **S3**: CSV file storage with versioning and encryption

### What This System Does- **DynamoDB**: Two tables (Station_Information, Station_Data) with PAY_PER_REQUEST billing

- **Lambda**: 4 functions (Validation, Transformation × 2, Manifest Trigger)

1. **Validates** uploaded CSV files for data integrity- **Step Functions**: Orchestrates validation and transformation workflow

2. **Transforms** zone and station information with geohash encoding for proximity queries- **CloudWatch**: Logging and monitoring

3. **Loads** charging metrics at the **zone level** (not individual stations) to optimize storage and processing

4. **Enables** real-time recommendations based on user location, availability, and pricing### DynamoDB Schema



### Use Case#### Station_Information Table

```

Given a user's GPS coordinates:PK: Station_Id (NUMBER)

- Find nearby charging zones using geohash proximityAttributes:

- Retrieve current charging metrics (occupancy, price, duration)  - Latitude (NUMBER)

- Recommend the best zone based on weighted scoring  - Longitude (NUMBER)

- Return available stations within that zone  - Geohash (STRING) - 7-character precision for proximity queries

  - SlowCount (NUMBER)

---  - FastCount (NUMBER)

  - TotalChargers (NUMBER)

## Key Features  - TAZID (NUMBER)



✅ **Serverless Architecture** - No servers to manage, auto-scaling with Lambda and DynamoDB  GSI 1: GeohashIndex

✅ **Geospatial Indexing** - 7-character geohash for fast proximity queries (~150m precision)    PK: Geohash (STRING)

✅ **Zone-Level Storage** - Stores aggregated zone data instead of duplicating across 1,362 stations (97% data reduction)    Purpose: Find stations within proximity (e.g., 5km radius)

✅ **AWS Free Tier Compliant** - PROVISIONED billing mode keeps costs at **$0.00/month** for 10-timestamp dataset  

✅ **Event-Driven Processing** - S3 uploads automatically trigger Step Functions workflows  GSI 2: TazidIndex

✅ **Parallel Transformation** - Map state processes 5 metrics concurrently with maxConcurrency: 4    PK: TAZID (NUMBER)

✅ **Production-Ready Schemas** - Meaningful attribute names (ZoneId, Timestamp) instead of generic PK/SK    Purpose: Query all stations in a traffic zone

```

---

#### Station_Data Table

## Dataset Information```

PK: Station_Id (NUMBER)

### SourceSK: Time#Attribute (STRING) - Format: "2022-09-01T00:00:00#e_price"

Attributes:

**UrbanEV**: A large-scale dataset of electric vehicle charging sessions in Shenzhen and Hong Kong  - Value (NUMBER)

  - TAZID (NUMBER)

- **Publication**: *Scientific Data* (2025)  - Metric (STRING)

- **Authors**: Wang et al., Shanghai Jiao Tong University  - Timestamp (STRING)

- **DOI**: [10.1038/s41597-024-04176-6](https://doi.org/10.1038/s41597-024-04176-6)```

- **Repository**: [Dryad Digital Repository](https://datadryad.org/stash/dataset/doi:10.5061/dryad.gqnk98swb)

- **License**: Creative Commons CC0 1.0 Universal## Step Functions Workflow



### Dataset Characteristics### Complete Flow



| Attribute | Value |```

|-----------|-------|┌─────────────────────────────┐

| **Region** | Hong Kong & Shenzhen |│  ValidateCSVFiles (Lambda)  │

| **Time Period** | September 2022 - February 2023 (6 months) |│  - Schema validation        │

| **Zones** | 275 Traffic Analysis Zones (TAZIDs) |│  - Data quality checks      │

| **Stations** | 1,362 charging stations (after filtering invalid records) |│  - TAZID mapping            │

| **Timestamps** | 27,000 hourly observations |└──────────────┬──────────────┘

| **Metrics** | 5 charging metrics (duration, e_price, s_price, occupancy, volume-11kw) |               │

| **Data Format** | CSV files with zone-level aggregated values |               ▼

┌─────────────────────────────────────┐

### Data Structure│ IsValidationSuccessful? (Choice)    │

└──────┬──────────────────────┬───────┘

```       │                      │

zone-information.csv          (275 zones with geospatial boundaries)    ✅ YES                   ❌ NO

    ├── TAZID, Latitude, Longitude, Area, Perimeter, ChargeCount       │                      │

    │       ▼                      ▼

station_information.csv       (1,682 stations → 1,362 valid)┌──────────────────┐   ┌──────────────────┐

    ├── Station_Id, TAZID, Latitude, Longitude, SlowCount, FastCount│ TransformInParallel│   │ ValidationFailed │

    ││    (Parallel)     │   │      (Fail)      │

charge_1hour_duration.csv     (27,000 rows: average charging time in minutes)└────┬─────────┬───┘   └──────────────────┘

charge_1hour_e_price.csv      (27,000 rows: electricity price in CNY/kWh)     │         │

charge_1hour_s_price.csv      (27,000 rows: service fee in CNY/kWh)     ▼         ▼

charge_1hour_occupancy.csv    (27,000 rows: number of busy piles)┌─────────────────┐ ┌──────────────────────┐

charge_1hour_volume-11kw.csv  (27,000 rows: realistic charging volume in MWh)│ TransformStation│ │TransformChargeMetrics│

```│ Info (Lambda)   │ │   (Map State)        │

│ - Read CSV      │ │ ┌──────────────────┐ │

**Important**: The charging metrics are **zone-level aggregates**, not individual station readings. Each row represents the average/sum for all stations within a zone at a specific timestamp.│ - Calc geohash  │ │ │ Process 6 files  │ │

│ - Write DynamoDB│ │ │ in parallel:     │ │

---└─────────────────┘ │ │ • e_price        │ │

                    │ │ • slow_available │ │

## Architecture Decision: Zone-Level Storage                    │ │ • fast_available │ │

                    │ │ • queue_time     │ │

### The Problem                    │ │ • slow_avg_dur   │ │

                    │ │ • fast_avg_dur   │ │

Initially, this project attempted to expand zone-level data to individual stations:                    │ └──────────────────┘ │

- **275 zones** × **1,362 stations** × **27,000 timestamps** × **5 metrics** = **266 million records**                    └──────────────────────┘

- Lambda processing time: **15+ hours** (exceeds 15-minute timeout limit)                           │

- Storage cost: **~$6.60/month** for 266M records                           ▼

- **Critical issue**: This approach duplicated the same zone value across all stations in that zone            ┌──────────────────────────────┐

            │ EvaluateTransformation       │

### The Solution            │ Results (Pass Task)          │

            │ - Extract success flags      │

After researching the UrbanEV dataset structure, we discovered the data is **inherently zone-level**, not station-level. The correct approach is to store metrics at the zone level:            │ - Aggregate results          │

            └────────────┬─────────────────┘

- **275 zones** × **27,000 timestamps** × **5 metrics** = **7.4 million records** (with MAX_ROWS=10: **13,750 records**)                         │

- Lambda processing time: **~9 minutes per metric** (well within timeout limits)                         ▼

- Storage cost: **$0.00/month** with PROVISIONED Free Tier            ┌─────────────────────────────┐

- **Data accuracy**: Preserves original zone-level aggregation            │ AllTransformationsSuccessful?│

            │         (Choice)             │

### Why This Makes Sense            └────────┬────────────┬────────┘

                     │            │

1. **Dataset Design**: UrbanEV researchers aggregated data at the zone level for privacy and analytical purposes                  ✅ YES         ❌ NO

2. **Real-World Usage**: Zones (TAZIDs) represent Traffic Analysis Zones used in urban planning                     │            │

3. **Recommendation Flow**:                     ▼            ▼

   - Find best zone based on metrics (occupancy, price, duration)            ┌────────────┐ ┌────────────┐

   - Query Station_Information to get available stations in that zone            │Transformation│ │Transformation│

   - Return station list to user            │  Complete   │ │   Failed    │

            │  (Succeed)  │ │   (Fail)    │

4. **Data Integrity**: Avoids creating 266M duplicate records that misrepresent the data            └────────────┘ └────────────┘

```

### Trade-offs

### State Descriptions

| Aspect | Zone-Level (Current) | Station-Level (Attempted) |

|--------|---------------------|---------------------------|| State | Type | Purpose | Success → | Failure → |

| **Records** | 7.4M (13,750 with MAX_ROWS=10) | 266M ||-------|------|---------|-----------|-----------|

| **Storage** | ~2 MB (10 timestamps) | ~6.6 GB (full dataset) || **ValidateCSVFiles** | Lambda | Validate 7 CSV files (station_information + 6 charge files), build TAZID→stations mapping | IsValidationSuccessful? | - |

| **Processing Time** | 9 min/metric | 15+ hours (timeout) || **IsValidationSuccessful?** | Choice | Check validation result | TransformInParallel | ValidationFailed ❌ |

| **Cost** | $0.00/month | ~$6.60/month || **TransformInParallel** | Parallel | Execute station info + charge metrics transformations concurrently | EvaluateTransformationResults | - |

| **Data Accuracy** | ✅ Preserves original aggregation | ❌ Duplicates zone values || **TransformStationInfo** | Lambda | Read station_information.csv, calculate 7-char geohash, write to Station_Information table | - | - |

| **Query Pattern** | Zone → Stations | Direct station lookup || **TransformChargeMetrics** | Map | Process 6 charge_1hour CSV files in parallel (max concurrency: 6) | - | - |

| **TransformStationData** | Lambda | Transform charge CSV, map TAZID to stations, write to Station_Data table | - | - |

---| **EvaluateTransformationResults** | Pass | Extract success flags and aggregate results | AllTransformationsSuccessful? | - |

| **AllTransformationsSuccessful?** | Choice | Check if all transformations succeeded | TransformationComplete ✅ | TransformationFailed ❌ |

## DynamoDB Schema Design

### Final States

### Overview

#### ✅ TransformationComplete (Success)

Three tables store different aspects of the EV charging infrastructure:- All CSV files validated

- Station information loaded into `Station_Information` table with geohash

1. **Zone_Information** - Geospatial zone metadata (275 zones)- All 6 charge metrics loaded into `Station_Data` table

2. **Station_Information** - Individual station locations (1,362 stations)- Data ready for proximity queries

3. **Station_Data** - Time-series charging metrics at zone level (13,750 records with MAX_ROWS=10)

#### ❌ ValidationFailed (Fail)

### Zone_Information Table**Triggers when:**

- CSV schema validation fails

Stores zone-level geospatial metadata with geohash indexing for proximity queries.- Invalid data detected (missing columns, wrong types)

- Missing required files

**Schema:**- TAZID consistency issues

```javascript

{**Action**: Check Step Functions execution output for validation errors

  "ZoneId": "ZONE#102",              // Primary Key (STRING)

  "TAZID": 102,                      // Traffic Analysis Zone ID (NUMBER)#### ❌ TransformationFailed (Fail)

  "Latitude": 22.3078,               // Zone centroid latitude (NUMBER)**Triggers when:**

  "Longitude": 114.1894,             // Zone centroid longitude (NUMBER)- Lambda execution errors

  "Geohash": "wecpqy5",             // 7-character geohash (~150m precision) (STRING)- DynamoDB write failures (throttling, capacity)

  "Area": 0.45,                      // Zone area in km² (NUMBER)- Partial data load issues

  "Perimeter": 3.2,                  // Zone perimeter in km (NUMBER)- Unprocessed items exceed retry limit

  "ChargeCount": 12                  // Number of charging stations in zone (NUMBER)

}**Action**: Check Lambda CloudWatch logs for detailed error messages

```

## File Structure

**Global Secondary Index:**

- **GeohashIndex**: `Geohash` (HASH) → enables proximity queries```

  - Query pattern: Find zones with geohash prefix matching user locationEvStationLocator/

  - Example: Geohash "wecpq" returns all zones within ~5km├── lib/

│   ├── ev_station_locator-stack.js       # Infrastructure declarations

**Billing Mode:** PROVISIONED (3 RCU / 3 WCU) + GSI (3 RCU / 3 WCU)│   ├── workflows/

│   │   └── csv-ingest-workflow.js        # Step Functions workflow logic

**Total Records:** 275 zones│   └── iam/

│       └── permissions.js                # Centralized IAM permission grants

---├── lambda/

│   ├── shared/

### Station_Information Table│   │   └── dynamodb-utils.js             # Shared DynamoDB batch write utilities

│   ├── manifest-trigger/

Stores individual charging station details with geospatial and zone-based indexing.│   │   └── index.js                      # Triggers Step Functions on manifest upload

│   ├── validate-csv/

**Schema:**│   │   └── index.js                      # CSV validation logic

```javascript│   ├── transform-station-info/

{│   │   └── index.js                      # Station information transformation

  "Station_Id": 3001,                // Primary Key (NUMBER)│   └── transform-station-data/

  "TAZID": 102,                      // Zone ID this station belongs to (NUMBER)│       └── index.js                      # Charge metrics transformation

  "Latitude": 22.3082,               // Station latitude (NUMBER)├── upload-to-s3.js                       # Upload script with manifest creation

  "Longitude": 114.1891,             // Station longitude (NUMBER)├── package.json                          # Project dependencies

  "Geohash": "wecpqy7",             // 7-character geohash (STRING)└── README.md                             # This file

  "SlowCount": 4,                    // Number of slow chargers (NUMBER)```

  "FastCount": 2,                    // Number of fast chargers (NUMBER)

  "TotalChargers": 6                 // Total chargers (NUMBER)## Code Organization Principles

}

```### 1. **Separation of Concerns**

- **Stack**: Infrastructure declarations only

**Global Secondary Indexes:**- **Workflows**: Step Functions logic

1. **GeohashIndex**: `Geohash` (HASH) → find stations near user location- **IAM**: Centralized permission management

2. **TazidIndex**: `TAZID` (HASH) → find all stations in a zone- **Lambda**: Business logic execution

- **Shared Utilities**: DRY principle for common operations

**Billing Mode:** PROVISIONED (3 RCU / 3 WCU) + 2 GSIs (3 RCU / 3 WCU each)

### 2. **Least Privilege IAM**

**Total Records:** 1,362 stations (filtered from 1,682 in source data)- `ValidateCsvFn`: S3 read only

- `ManifestTriggerFn`: S3 read + Step Functions start

---- `TransformStationInfoFn`: S3 read + Station_Information write only

- `TransformStationDataFn`: S3 read + Station_Data write only

### Station_Data Table

### 3. **Shared Utilities** (`lambda/shared/dynamodb-utils.js`)

Stores time-series charging metrics **at the zone level** with composite key for time-range queries.- `writeToDynamoDB()`: Batch write orchestration

- `writeBatchWithRetry()`: Exponential backoff retry logic (100ms → 200ms → 400ms)

**Schema:**- `unmarshallItem()`: DynamoDB item unmarshalling

```javascript- `chunkArray()`: Split arrays into 25-item batches (DynamoDB limit)

{- `sleep()`: Promise-based delay

  "ZoneId": "ZONE#102",              // Primary Key (STRING)

  "Timestamp": "2022-09-01T00:00:00Z", // Sort Key (STRING)**Benefits**: 114 lines of duplicated code eliminated

  "TAZID": 102,                      // Zone ID (NUMBER)

  "duration": 45.2,                  // Average charging duration in minutes (NUMBER)## Data Flow

  "e_price": 1.15,                   // Electricity price in CNY/kWh (NUMBER)

  "s_price": 0.85,                   // Service fee in CNY/kWh (NUMBER)```

  "occupancy": 17,                   // Number of busy charging piles (NUMBER)CSV Upload → S3 Bucket → Manifest Created (_manifest.json)

  "volume-11kw": 11.3                // Realistic charging volume in MWh (NUMBER)                              ↓

}                     S3 Event Notification

```                              ↓

                    Manifest Trigger Lambda

**Key Design:**                              ↓

- **ZoneId** (PK): Enables querying all metrics for a specific zone                    Step Functions Execution

- **Timestamp** (SK): Enables time-range queries (e.g., last 24 hours)                              ↓

                    ┌─────────────────────┐

**Billing Mode:** PROVISIONED (3 RCU / 5 WCU)                    │  Validation Phase   │

- Higher write capacity (5 WCU) to handle batch loading of metrics                    └──────────┬──────────┘

                               │ (if valid)

**Data Volume:**                               ▼

- **Current (MAX_ROWS=10)**: 10 timestamps × 275 zones × 5 metrics = **13,750 records**                    ┌─────────────────────┐

- **Full Dataset**: 27,000 timestamps × 275 zones × 5 metrics = **37.125 million records**                    │ Transformation Phase│

                    │   (Parallel)        │

**Query Patterns:**                    └──────────┬──────────┘

1. Get current metrics for a zone: `ZoneId = "ZONE#102" AND Timestamp = "2022-09-15T14:00:00Z"`                               │

2. Get time-series for a zone: `ZoneId = "ZONE#102" AND Timestamp BETWEEN "2022-09-01" AND "2022-09-30"`                    ┌──────────┴──────────┐

3. Get all zones at a timestamp: Scan with filter (not recommended for large datasets)                    │                     │

           Station_Information    Station_Data

---              (1,682 items)      (~36M items)

                    │                     │

## Step Functions Workflow                    └──────────┬──────────┘

                               │

The CSV ingestion process is orchestrated by a Step Functions state machine with parallel transformation branches.                    ┌──────────▼──────────┐

                    │  Query Interface    │

### Workflow Diagram                    │ (Proximity-based    │

                    │  recommendations)   │

```                    └─────────────────────┘

┌─────────────────────────────────────┐```

│  S3 Event: _manifest.json uploaded  │

└──────────────┬──────────────────────┘## Deployment

               │

               ▼### Prerequisites

┌─────────────────────────────────────┐```bash

│  Lambda: ManifestTrigger            │npm install

│  • Parses _manifest.json            │```

│  • Extracts S3 paths                │

│  • Starts Step Functions            │### Deploy Stack

└──────────────┬──────────────────────┘```bash

               │npx cdk deploy --require-approval never

               ▼```

┌─────────────────────────────────────┐

│  State: ValidateCSVFiles            │### Upload Data

│  Lambda: ValidateCSV                │```bash

│  • Checks file existence            │node upload-to-s3.js

│  • Validates CSV structure          │```

│  • Returns validation results       │

└──────────────┬──────────────────────┘This will:

               │1. Upload 16 CSV files to S3 (under `urban-ev-data/` prefix)

               ▼2. Create `_manifest.json` with file metadata

┌─────────────────────────────────────┐3. Trigger Step Functions execution automatically

│  Choice: IsValidationSuccessful?    │

└──────┬──────────────────────┬───────┘## Monitoring

       │ Yes                  │ No

       ▼                      ▼### CloudWatch Logs

┌─────────────────┐    ┌────────────┐- `/aws/lambda/EvStationLocatorStack-ValidateCsvFn*`

│  Parallel State │    │  Fail      │- `/aws/lambda/EvStationLocatorStack-TransformStationInfoFn*`

└─────────────────┘    └────────────┘- `/aws/lambda/EvStationLocatorStack-TransformStationDataFn*`

       │- `/aws/lambda/EvStationLocatorStack-ManifestTriggerFn*`

       ├─────────────────────────┬─────────────────────────┬

       │                         │                         │### Step Functions Console

       ▼                         ▼                         ▼- Execution history with visual workflow

┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────────┐- Input/output for each state

│ TransformZone   │   │ TransformStation│   │ Map State: TransformMetrics │- Error messages and stack traces

│ Lambda          │   │ Lambda          │   │ • Iterates over 5 metrics   │

│ • Reads zone CSV│   │ • Reads station │   │ • maxConcurrency: 4         │### DynamoDB Console

│ • Adds geohash  │   │   CSV           │   │ • Lambda: TransformData     │- Table item counts

│ • Writes to DB  │   │ • Adds geohash  │   │   - Reads charge CSV        │- GSI query patterns

└─────────────────┘   │ • Writes to DB  │   │   - Zone-level storage      │- Consumed capacity metrics

                      └─────────────────┘   │   - Batch writes to DB      │

                                            └─────────────────────────────┘## Query Patterns

       │                         │                         │

       └─────────────────────────┴─────────────────────────┘This section provides comprehensive query patterns for retrieving EV station data from DynamoDB.

                                 │

                                 ▼### Table: Station_Information

                  ┌─────────────────────────────────┐

                  │ EvaluateTransformationResults   │#### Schema Details

                  │ • Checks all transformations OK │```

                  └──────────┬──────────────────────┘Primary Key: Station_Id (NUMBER)

                             │

                   ┌─────────┴─────────┐Attributes:

                   ▼                   ▼- Station_Id (NUMBER) - Unique station identifier

            ┌────────────┐      ┌────────────┐- Latitude (NUMBER) - Station latitude coordinate

            │  Success   │      │  Fail      │- Longitude (NUMBER) - Station longitude coordinate

            └────────────┘      └────────────┘- Geohash (STRING) - 7-character geohash for proximity search (e.g., "wecpz09")

```- TAZID (NUMBER) - Traffic Analysis Zone ID

- SlowCount (NUMBER) - Number of slow chargers at station

### Workflow States- FastCount (NUMBER) - Number of fast chargers at station

- TotalChargers (NUMBER) - Total number of chargers

1. **ValidateCSVFiles** - Lambda validates all CSV files exist and are readable

2. **IsValidationSuccessful?** - Choice state checks validation resultsGSI 1: GeohashIndex

3. **Parallel** - Executes 3 transformation branches concurrently:  - Partition Key: Geohash (STRING)

   - **Branch 1**: TransformZoneInfo (275 zones)  - Projection: ALL

   - **Branch 2**: TransformStationInfo (1,362 stations)  - Purpose: Proximity-based queries

   - **Branch 3**: Map state over 5 metrics (processes charge CSVs)

4. **EvaluateTransformationResults** - Verifies all transformations succeededGSI 2: TazidIndex

5. **Success/Fail** - Terminal states  - Partition Key: TAZID (NUMBER)

  - Projection: ALL

### Map State Configuration  - Purpose: Zone-level aggregation and queries

```

The Map state processes 5 charge metrics in parallel:

### Pattern 1: Get Station by ID (Direct Lookup)

```javascript

{**Use Case**: Retrieve complete information for a specific station

  "Type": "Map",

  "ItemsPath": "$.metrics",```javascript

  "MaxConcurrency": 4,const params = {

  "Iterator": {  TableName: 'Station_Information',

    "StartAt": "TransformStationData",  Key: {

    "States": {    Station_Id: 1002

      "TransformStationData": {  }

        "Type": "Task",};

        "Resource": "arn:aws:lambda:...:TransformStationData",

        "End": trueconst result = await dynamoDb.get(params);

      }// Returns: Single station with all attributes

    }// Example: {Station_Id: 1002, Latitude: 22.7319, Longitude: 113.7800, Geohash: "wecpz09", ...}

  }```

}

```### Pattern 2: Find Nearby Stations (Proximity Search using Geohash)



**Metrics Processed:****Use Case**: User wants to find charging stations within 5km radius

- `duration` - Average charging duration

- `e_price` - Electricity price```javascript

- `s_price` - Service fee// Step 1: Calculate geohash from user location

- `occupancy` - Busy pile countconst ngeohash = require('ngeohash');

- `volume-11kw` - Realistic charging volumeconst userLat = 22.5212;

const userLon = 113.9103;

**Why MaxConcurrency: 4?**const userGeohash = ngeohash.encode(userLat, userLon, 7); 

- Prevents Lambda throttling (default account limit: 1000 concurrent executions)// Example result: "wecpz09"

- Balances parallelism with DynamoDB write capacity (5 WCU per table)

- Total concurrent writes: 4 metrics × 5 WCU = 20 WCU (within limits)// Step 2: Query by geohash prefix for proximity

const params = {

---  TableName: 'Station_Information',

  IndexName: 'GeohashIndex',

## Lambda Functions  KeyConditionExpression: 'begins_with(Geohash, :prefix)',

  ExpressionAttributeValues: {

### 1. ValidateCSV    ':prefix': userGeohash.substring(0, 5) // "wecpz" = ~4.9km × 4.9km area

  }

**Purpose:** Validates CSV file existence and structure before transformation.};



**Trigger:** Step Functions state machineconst result = await dynamoDb.query(params);

// Returns: All stations within approximate radius

**Logic:**

1. Receives list of S3 file paths from manifest// Step 3: Calculate actual distances and sort by proximity

2. Checks each file exists in S3const stationsWithDistance = result.Items.map(station => ({

3. Downloads first 5 rows to validate CSV structure  ...station,

4. Returns validation results  distance: calculateHaversineDistance(userLat, userLon, station.Latitude, station.Longitude)

})).sort((a, b) => a.distance - b.distance);

**Output:**

```javascript// Helper function: Haversine distance calculation

{function calculateHaversineDistance(lat1, lon1, lat2, lon2) {

  "isValid": true,  const R = 6371; // Earth's radius in km

  "validatedFiles": [  const dLat = (lat2 - lat1) * Math.PI / 180;

    { "key": "zone-information.csv", "exists": true },  const dLon = (lon2 - lon1) * Math.PI / 180;

    { "key": "station_information.csv", "exists": true },  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +

    // ...            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *

  ]            Math.sin(dLon/2) * Math.sin(dLon/2);

}  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

```  return R * c; // Distance in km

}

**Timeout:** 1 minute  ```

**Memory:** 256 MB

#### Geohash Precision Reference

---

| Precision | Cell Size     | Use Case                    |

### 2. TransformZoneInfo|-----------|---------------|-----------------------------|

| 5         | ~5km × 5km    | City-level search           |

**Purpose:** Transforms zone-information.csv and loads into Zone_Information table.| 6         | ~1.2km × 600m | Neighborhood search         |

| 7         | ~150m × 150m  | Street-level search (✅ recommended) |

**Trigger:** Step Functions parallel branch| 8         | ~38m × 19m    | Building-level precision    |



**Logic:**### Pattern 3: Get All Stations in a Zone (TAZID-based)

1. Downloads zone-information.csv from S3

2. Parses CSV (275 rows)**Use Case**: Retrieve all stations within a specific traffic analysis zone

3. For each zone:

   - Calculates 7-character geohash from centroid coordinates```javascript

   - Creates item: `{ ZoneId: "ZONE#102", TAZID: 102, Latitude, Longitude, Geohash, Area, Perimeter, ChargeCount }`// Example: User location maps to TAZID 558

4. Batch writes to DynamoDB (25 items per batch)const userTazid = 558;



**Dependencies:**const params = {

- `ngeohash` - Geohash encoding library  TableName: 'Station_Information',

  IndexName: 'TazidIndex',

**Output:** 275 zones written to Zone_Information table  KeyConditionExpression: 'TAZID = :tazid',

  ExpressionAttributeValues: {

**Timeout:** 5 minutes      ':tazid': 558

**Memory:** 512 MB  }

};

---

const result = await dynamoDb.query(params);

### 3. TransformStationInfo// Returns: All stations in zone 558 (e.g., stations [1002, 1003])

```

**Purpose:** Transforms station_information.csv and loads into Station_Information table.

### Table: Station_Data

**Trigger:** Step Functions parallel branch

#### Schema Details

**Logic:**```

1. Downloads station_information.csv from S3Primary Key: 

2. Parses CSV (1,682 rows)  - Partition Key: Station_Id (NUMBER)

3. Filters invalid stations (missing coordinates, negative counts)  - Sort Key: Time#Attribute (STRING)

4. For each valid station (1,362 total):

   - Calculates 7-character geohashFormat: "YYYY-MM-DDTHH:MM:SS#metric_name"

   - Creates item: `{ Station_Id, TAZID, Latitude, Longitude, Geohash, SlowCount, FastCount, TotalChargers }`Example: "2022-09-01T14:00:00#e_price"

5. Batch writes to DynamoDB

Attributes:

**Dependencies:**- Station_Id (NUMBER) - Station identifier

- `ngeohash` - Geohash encoding library- Time#Attribute (STRING) - Composite sort key (timestamp + metric)

- Value (NUMBER) - Metric value

**Output:** 1,362 stations written to Station_Information table- TAZID (NUMBER) - Zone reference (for aggregation)

- Metric (STRING) - Metric name (e_price, slow_available, etc.)

**Timeout:** 5 minutes  - Timestamp (STRING) - ISO timestamp

**Memory:** 512 MB

Available Metrics:

---- e_price: Electricity price (HKD/kWh)

- slow_available: Available slow chargers

### 4. TransformStationData- fast_available: Available fast chargers

- queue_time: Average queue wait time (minutes)

**Purpose:** Transforms charge_1hour_*.csv files and loads zone-level metrics into Station_Data table.- slow_avg_duration: Average slow charging duration (hours)

- fast_avg_duration: Average fast charging duration (hours)

**Trigger:** Step Functions Map state (processes 5 metrics in parallel)```



**Logic:**### Pattern 4: Get All Metrics for a Station at Specific Time

1. Receives metric name (e.g., "occupancy") from Map iterator

2. Downloads corresponding CSV: `charge_1hour_occupancy.csv`**Use Case**: Retrieve complete charging status snapshot for a station

3. Parses CSV and limits to first `MAX_ROWS` timestamps (Free Tier optimization)

4. For each row:```javascript

   - Extracts timestamp and zone columns (275 zones)const params = {

   - Creates **zone-level** items: `{ ZoneId: "ZONE#102", Timestamp, TAZID, occupancy: value }`  TableName: 'Station_Data',

5. Batch writes to DynamoDB (25 items per batch)  KeyConditionExpression: 'Station_Id = :sid AND begins_with(#sk, :time)',

  ExpressionAttributeNames: {

**Critical Configuration:**    '#sk': 'Time#Attribute'

```javascript  },

const MAX_ROWS = 10;  // Process only first 10 timestamps per metric  ExpressionAttributeValues: {

// 10 timestamps × 275 zones × 5 metrics = 13,750 total records    ':sid': 1002,

// Processing time: ~9 minutes per metric (within 15-min timeout)    ':time': '2022-09-01T14:00:00'

```  }

};

**Why Zone-Level Storage?**

- Original data is zone-aggregated, not station-specificconst result = await dynamoDb.query(params);

- Avoids duplicating 266M records across stations// Returns: Array of all metrics for that timestamp

- Preserves data integrity and reduces costs// [

//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#e_price", Value: 0.85},

**Output:** 2,750 records per metric (10 timestamps × 275 zones)//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#slow_available", Value: 3},

//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#fast_available", Value: 2},

**Timeout:** 15 minutes  //   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#queue_time", Value: 5.2},

**Memory:** 1024 MB//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#slow_avg_duration", Value: 2.5},

//   {Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#fast_avg_duration", Value: 0.8}

---// ]

```

### 5. ManifestTrigger

### Pattern 5: Get Specific Metric for a Station

**Purpose:** Parses _manifest.json and triggers Step Functions workflow.

**Use Case**: Check current electricity price at a station

**Trigger:** S3 PutObject event on `_manifest.json`

```javascript

**Logic:**const params = {

1. Downloads _manifest.json from S3  TableName: 'Station_Data',

2. Parses JSON to extract:  KeyConditionExpression: 'Station_Id = :sid AND #sk = :sk',

   - `zoneInfo`: Path to zone-information.csv  ExpressionAttributeNames: {

   - `stationInfo`: Path to station_information.csv    '#sk': 'Time#Attribute'

   - `metrics`: Array of 5 metric names  },

3. Constructs Step Functions input payload  ExpressionAttributeValues: {

4. Starts execution of CsvIngestStateMachine    ':sid': 1002,

    ':sk': '2022-09-01T14:00:00#e_price'

**Manifest Format:**  }

```json};

{

  "zoneInfo": "urban-ev-data/zone-information.csv",const result = await dynamoDb.query(params);

  "stationInfo": "urban-ev-data/station_information.csv",// Returns: Single metric value

  "metrics": ["duration", "e_price", "s_price", "occupancy", "volume-11kw"]// [{Station_Id: 1002, Time#Attribute: "2022-09-01T14:00:00#e_price", Value: 0.85}]

}```

```

### Pattern 6: Get Time Series Data for a Station

**Timeout:** 1 minute  

**Memory:** 256 MB**Use Case**: Retrieve historical price trends for a specific station



---```javascript

const params = {

## AWS Free Tier Optimization  TableName: 'Station_Data',

  KeyConditionExpression: 'Station_Id = :sid AND #sk BETWEEN :start AND :end',

This project is designed to operate within the **AWS Free Tier** limits, ensuring **$0.00/month** costs for the 10-timestamp dataset.  ExpressionAttributeNames: {

    '#sk': 'Time#Attribute'

### DynamoDB Free Tier Limits  },

  ExpressionAttributeValues: {

- **25 GB** of storage    ':sid': 1002,

- **25 RCU** (Read Capacity Units) for PROVISIONED tables    ':start': '2022-09-01T00:00:00#e_price',

- **25 WCU** (Write Capacity Units) for PROVISIONED tables    ':end': '2022-09-01T23:59:59#e_price'

- **2.5M** read requests per month (on-demand)  }

- **1M** write requests per month (on-demand)};



**Important:** Only **PROVISIONED** billing mode is eligible for Free Tier RCU/WCU. PAY_PER_REQUEST charges per request.const result = await dynamoDb.query(params);

// Returns: All e_price values for Sept 1, 2022 (24 hourly data points)

### Capacity Allocation```



| Table/Index | Read Capacity | Write Capacity |## Complete Station Recommendation Algorithm

|-------------|---------------|----------------|

| **Zone_Information** | 3 RCU | 3 WCU |This comprehensive example shows how to recommend the best charging station based on user location and preferences.

| GeohashIndex (GSI) | 3 RCU | 3 WCU |

| **Station_Information** | 3 RCU | 3 WCU |```javascript

| GeohashIndex (GSI) | 3 RCU | 3 WCU |/**

| TazidIndex (GSI) | 3 RCU | 3 WCU | * Recommend optimal charging stations based on user location and preferences

| **Station_Data** | 3 RCU | 5 WCU | * 

| **Total** | **21 RCU** | **23 WCU** | * @param {number} userLat - User's latitude

 * @param {number} userLon - User's longitude

✅ **Within Free Tier:** 21/25 RCU, 23/25 WCU * @param {Object} userPreferences - User preferences and constraints

 * @returns {Array} Top N recommended stations with scores

### Why Station_Data Uses 5 WCU */

async function recommendStations(userLat, userLon, userPreferences = {}) {

During data loading, Station_Data receives bulk writes from 4 concurrent Lambda executions (Map state maxConcurrency: 4). Higher write capacity (5 WCU vs 3 WCU) prevents throttling during batch operations.  const {

    maxDistance = 5,        // Maximum search radius in km

**Calculation:**    topN = 5,               // Number of recommendations to return

- 4 concurrent Lambdas × 25 items per batch = 100 items/second potential    preferFastCharging = false,

- 5 WCU = 5 items/second sustained writes    maxPrice = null,        // Maximum acceptable price (HKD/kWh)

- Batch writes queue internally, 5 WCU provides buffer    weights = {             // Scoring weights (must sum to 1.0)

      distance: 0.3,

### MAX_ROWS Configuration      price: 0.3,

      availability: 0.2,

To avoid Lambda timeouts and stay within Free Tier efficiency:      speed: 0.2

    }

```javascript  } = userPreferences;

const MAX_ROWS = 10;  // Process first 10 timestamps per metric

```  // Step 1: Find nearby stations using Geohash proximity search

  const geohash = ngeohash.encode(userLat, userLon, 7);

**Impact:**  const nearbyStations = await queryGeohashIndex(geohash);

- **Records per metric:** 10 timestamps × 275 zones = 2,750 records  

- **Total records:** 2,750 × 5 metrics = **13,750 records**  // Step 2: Calculate actual distances and filter by max radius

- **Processing time:** ~9 minutes per metric (well within 15-min Lambda timeout)  const stationsWithDistance = nearbyStations

- **Storage:** ~2 MB (well within 25 GB Free Tier)    .map(station => ({

      ...station,

**Full Dataset Trade-off:**      distance: calculateHaversineDistance(userLat, userLon, station.Latitude, station.Longitude)

- To process all 27,000 timestamps: Remove `MAX_ROWS` limit    }))

- Records: 27,000 × 275 × 5 = **37.125 million records**    .filter(s => s.distance <= maxDistance);

- Storage: ~9.3 GB (within Free Tier 25 GB)  

- Processing time: 15+ hours (requires chunking strategy or PAY_PER_REQUEST)  // Step 3: Get current charging metrics for each station

- One-time load cost: ~$46 (see Cost Analysis section)  const currentTime = getCurrentHourTimestamp(); // e.g., "2022-09-01T14:00:00"

  

### Lambda Free Tier  const stationsWithMetrics = await Promise.all(

    stationsWithDistance.map(async station => {

- **1M requests** per month      const metrics = await getStationMetrics(station.Station_Id, currentTime);

- **400,000 GB-seconds** of compute time      

      // Parse metrics into structured object

**Current Usage:**      const metricsObj = {};

- 5 Lambda functions × 1 execution per data upload = 5 requests      metrics.forEach(m => {

- TransformStationData: 5 metrics × 9 minutes × 1024 MB = ~46 GB-minutes        const metricName = m['Time#Attribute'].split('#')[1];

- Total: ~46 GB-minutes = **2,760 GB-seconds** (well within 400,000 limit)        metricsObj[metricName] = m.Value;

      });

### S3 Free Tier      

      return {

- **5 GB** of standard storage        ...station,

- **20,000 GET** requests        metrics: metricsObj

- **2,000 PUT** requests      };

    })

**Current Usage:**  );

- CSV files: ~50 MB  

- Lambda reads: ~15 GET requests per workflow  // Step 4: Filter by price constraint if specified

- Well within Free Tier limits  let filteredStations = stationsWithMetrics;

  if (maxPrice !== null) {

---    filteredStations = filteredStations.filter(s => 

      s.metrics.e_price <= maxPrice

## Prerequisites    );

  }

### Required Tools  

  // Step 5: Calculate composite scores

- **Node.js** 18.x or later  const scoredStations = filteredStations.map(station => ({

- **AWS CLI** v2    ...station,

- **AWS CDK** v2.103.1 or later    score: calculateCompositeScore(station, userPreferences, weights)

- **Git**  }));

  

### AWS Account Setup  // Step 6: Rank by score and return top N

  const rankedStations = scoredStations

1. Create an AWS account (if not already done)    .sort((a, b) => b.score - a.score)

2. Configure AWS CLI credentials:    .slice(0, topN);

   ```bash  

   aws configure  return rankedStations;

   ```}

   - Enter Access Key ID

   - Enter Secret Access Key/**

   - Default region: `ap-south-1` (Mumbai) or your preferred region * Calculate composite score for a station

   - Default output format: `json` */

function calculateCompositeScore(station, prefs, weights) {

3. Verify credentials:  // Distance score: Closer = better (inverse relationship)

   ```bash  const distanceScore = (1 / (station.distance + 0.1)) * 10; // Normalize to 0-100

   aws sts get-caller-identity  

   ```  // Price score: Cheaper = better (inverse relationship)

  const priceScore = (1 / (station.metrics.e_price + 0.1)) * 10;

### Bootstrap CDK (First-Time Only)  

  // Availability score: More available chargers = better

If you haven't used CDK in your AWS account/region before:  const totalAvailable = (station.metrics.slow_available || 0) + 

                         (station.metrics.fast_available || 0);

```bash  const availabilityScore = (totalAvailable / (station.TotalChargers + 0.1)) * 100;

cdk bootstrap aws://ACCOUNT-ID/REGION  

```  // Speed score: Higher ratio of fast chargers = better

  const speedScore = prefs.preferFastCharging 

Example:    ? (station.FastCount / (station.TotalChargers + 0.1)) * 100

```bash    : ((station.SlowCount + station.FastCount) / (station.TotalChargers + 0.1)) * 100;

cdk bootstrap aws://123456789012/ap-south-1  

```  // Queue time penalty (if available)

  const queuePenalty = station.metrics.queue_time 

---    ? Math.max(0, 100 - station.metrics.queue_time * 10) 

    : 50; // Neutral if no data

## Installation  

  // Weighted composite score

### 1. Clone Repository  return (

    weights.distance * distanceScore +

```bash    weights.price * priceScore +

git clone https://github.com/puneetjoshi58/EVStationLocator.git    weights.availability * availabilityScore +

cd EVStationLocator    weights.speed * speedScore

```  ) * (queuePenalty / 100); // Apply queue penalty

}

### 2. Install CDK Dependencies

/**

```bash * Query stations by geohash prefix

npm install */

```async function queryGeohashIndex(geohash) {

  const params = {

### 3. Install Lambda Dependencies    TableName: 'Station_Information',

    IndexName: 'GeohashIndex',

Each Lambda function has its own `node_modules`:    KeyConditionExpression: 'begins_with(Geohash, :prefix)',

    ExpressionAttributeValues: {

```bash      ':prefix': geohash.substring(0, 5)

cd lambda/validate-csv && npm install && cd ../..    }

cd lambda/transform-zone-info && npm install && cd ../..  };

cd lambda/transform-station-info && npm install && cd ../..  

cd lambda/transform-station-data && npm install && cd ../..  const result = await dynamoDb.query(params);

cd lambda/manifest-trigger && npm install && cd ../..  return result.Items;

```}



Or use this one-liner:/**

```bash * Get current metrics for a station

for dir in lambda/*/; do (cd "$dir" && npm install); done */

```async function getStationMetrics(stationId, timestamp) {

  const params = {

---    TableName: 'Station_Data',

    KeyConditionExpression: 'Station_Id = :sid AND begins_with(#sk, :time)',

## Deployment    ExpressionAttributeNames: {

      '#sk': 'Time#Attribute'

### 1. Review Stack Configuration    },

    ExpressionAttributeValues: {

Check `lib/ev_station_locator-stack.js` for:      ':sid': stationId,

- DynamoDB table names      ':time': timestamp

- Lambda function timeouts    }

- PROVISIONED capacity settings  };

  

### 2. Synthesize CloudFormation Template  const result = await dynamoDb.query(params);

  return result.Items;

```bash}

cdk synth

```/**

 * Get current hour timestamp (rounded down)

This generates the CloudFormation template in `cdk.out/`. Review the template to verify resources. */

function getCurrentHourTimestamp() {

### 3. Deploy Stack  const now = new Date();

  now.setMinutes(0, 0, 0);

```bash  return now.toISOString().split('.')[0]; // "2022-09-01T14:00:00"

cdk deploy}

``````



**What Gets Deployed:**### Example Usage

- 1 S3 bucket (with versioning, encryption)

- 3 DynamoDB tables (Zone_Information, Station_Information, Station_Data)```javascript

- 5 Lambda functions// Example: User at Hong Kong Convention Centre looking for charging station

- 1 Step Functions state machineconst recommendations = await recommendStations(

- IAM roles and policies  22.2828, 114.1746, // Latitude, Longitude

- CloudWatch Log Groups  {

- S3 event notification (triggers ManifestTrigger Lambda)    maxDistance: 3,           // Within 3km

    topN: 5,                  // Top 5 recommendations

**Deployment Time:** ~3-5 minutes    preferFastCharging: true, // Prefer fast chargers

    maxPrice: 1.0,            // Max 1.0 HKD/kWh

**Outputs:**    weights: {

```      distance: 0.4,          // Prioritize proximity

EvStationLocatorStack.BucketName = evstationlocatorstack-evstationbucket...      price: 0.2,

EvStationLocatorStack.StateMachineArn = arn:aws:states:ap-south-1:...      availability: 0.25,

EvStationLocatorStack.ZoneTableName = Zone_Information      speed: 0.15

EvStationLocatorStack.StationInfoTableName = Station_Information    }

EvStationLocatorStack.StationDataTableName = Station_Data  }

```);



### 4. Verify Deploymentconsole.log(recommendations);

// Output:

```bash// [

# List DynamoDB tables//   {

aws dynamodb list-tables --region ap-south-1//     Station_Id: 1045,

//     Latitude: 22.2845,

# Check Step Functions state machine//     Longitude: 114.1723,

aws stepfunctions list-state-machines --region ap-south-1//     distance: 0.3,

//     TotalChargers: 8,

# Verify S3 bucket//     FastCount: 6,

aws s3 ls//     metrics: {

```//       e_price: 0.82,

//       slow_available: 1,

---//       fast_available: 4,

//       queue_time: 2.5

## Data Upload//     },

//     score: 87.5

### 1. Prepare Dataset//   },

//   ... more stations

Download the UrbanEV dataset from [Dryad](https://datadryad.org/stash/dataset/doi:10.5061/dryad.gqnk98swb).// ]

```

**Required Files:**

- `zone-information.csv`## Zone-Based Queries (Alternative Approach)

- `station_information.csv`

- `charge_1hour_duration.csv`For administrative dashboards or zone-level analytics, you can query by TAZID instead of geohash.

- `charge_1hour_e_price.csv`

- `charge_1hour_s_price.csv`### Get All Stations in User's Zone

- `charge_1hour_occupancy.csv`

- `charge_1hour_volume-11kw.csv````javascript

async function getStationsInUserZone(userTazid) {

### 2. Create Manifest File  const params = {

    TableName: 'Station_Information',

Create `_manifest.json` in your local directory:    IndexName: 'TazidIndex',

    KeyConditionExpression: 'TAZID = :tazid',

```json    ExpressionAttributeValues: {

{      ':tazid': userTazid

  "zoneInfo": "urban-ev-data/zone-information.csv",    }

  "stationInfo": "urban-ev-data/station_information.csv",  };

  "metrics": ["duration", "e_price", "s_price", "occupancy", "volume-11kw"]  

}  const result = await dynamoDb.query(params);

```  return result.Items;

}

### 3. Upload to S3```



```bash### Get Stations from Multiple Zones (Zone + Neighbors)

# Get bucket name from stack outputs

BUCKET_NAME=$(aws cloudformation describe-stacks \```javascript

  --stack-name EvStationLocatorStack \async function getStationsInUserAndNeighborZones(userTazid, neighborTazids) {

  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \  const allTazids = [userTazid, ...neighborTazids];

  --output text \  

  --region ap-south-1)  // Query all zones in parallel

  const results = await Promise.all(

# Upload CSV files    allTazids.map(tazid => getStationsInUserZone(tazid))

aws s3 cp zone-information.csv s3://$BUCKET_NAME/urban-ev-data/zone-information.csv  );

aws s3 cp station_information.csv s3://$BUCKET_NAME/urban-ev-data/station_information.csv  

aws s3 cp charge_1hour_duration.csv s3://$BUCKET_NAME/urban-ev-data/charge_1hour_duration.csv  // Flatten results and remove duplicates

aws s3 cp charge_1hour_e_price.csv s3://$BUCKET_NAME/urban-ev-data/charge_1hour_e_price.csv  const allStations = results.flat();

aws s3 cp charge_1hour_s_price.csv s3://$BUCKET_NAME/urban-ev-data/charge_1hour_s_price.csv  const uniqueStations = Array.from(

aws s3 cp charge_1hour_occupancy.csv s3://$BUCKET_NAME/urban-ev-data/charge_1hour_occupancy.csv    new Map(allStations.map(s => [s.Station_Id, s])).values()

aws s3 cp charge_1hour_volume-11kw.csv s3://$BUCKET_NAME/urban-ev-data/charge_1hour_volume-11kw.csv  );

  

# Upload manifest (this triggers the workflow)  return uniqueStations;

aws s3 cp _manifest.json s3://$BUCKET_NAME/urban-ev-data/_manifest.json}

``````



### 4. Monitor Workflow Execution### Aggregate Zone-Level Metrics



**Option 1: AWS Console**```javascript

1. Navigate to Step Functions consoleasync function getZoneAverageMetrics(tazid, timestamp) {

2. Select `CsvIngestStateMachine`  // Get all stations in zone

3. View execution in progress (refresh to see updates)  const stations = await getStationsInUserZone(tazid);

  

**Option 2: AWS CLI**  // Get metrics for each station

```bash  const allMetrics = await Promise.all(

# List recent executions    stations.map(s => getStationMetrics(s.Station_Id, timestamp))

aws stepfunctions list-executions \  );

  --state-machine-arn $(aws cloudformation describe-stacks \  

    --stack-name EvStationLocatorStack \  // Calculate zone-level averages

    --query 'Stacks[0].Outputs[?OutputKey==`StateMachineArn`].OutputValue' \  const flatMetrics = allMetrics.flat();

    --output text \  const aggregated = {

    --region ap-south-1) \    zone: tazid,

  --region ap-south-1    timestamp,

    avgPrice: average(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#e_price')).map(m => m.Value)),

# Get execution details    totalSlowAvailable: sum(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#slow_available')).map(m => m.Value)),

aws stepfunctions describe-execution \    totalFastAvailable: sum(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#fast_available')).map(m => m.Value)),

  --execution-arn <EXECUTION_ARN> \    avgQueueTime: average(flatMetrics.filter(m => m['Time#Attribute'].endsWith('#queue_time')).map(m => m.Value))

  --region ap-south-1  };

```  

  return aggregated;

**Expected Timeline:**}

- Validation: ~30 seconds

- TransformZoneInfo: ~1 minutefunction average(arr) {

- TransformStationInfo: ~2 minutes  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

- TransformStationData (Map state): ~9 minutes per metric (4 concurrent)}

- **Total**: ~10-15 minutes

function sum(arr) {

### 5. Verify Data Loaded  return arr.reduce((a, b) => a + b, 0);

}

```bash```

# Check Zone_Information

aws dynamodb scan --table-name Zone_Information --max-items 5 --region ap-south-1## Query Performance Optimization



# Check Station_Information### 1. Caching Strategy

aws dynamodb scan --table-name Station_Information --max-items 5 --region ap-south-1

```javascript

# Check Station_Data// Cache static station information (changes infrequently)

aws dynamodb scan --table-name Station_Data --max-items 5 --region ap-south-1const stationCache = new Map();



# Count items (approximate)async function getCachedStation(stationId) {

aws dynamodb describe-table --table-name Station_Data --region ap-south-1 \  if (stationCache.has(stationId)) {

  --query 'Table.ItemCount'    return stationCache.get(stationId);

```  }

  

---  const station = await getStationById(stationId);

  stationCache.set(stationId, station);

## Query Patterns  return station;

}

### 1. Find Nearby Zones by Geohash

// Only query real-time metrics from Station_Data

Given a user's GPS coordinates, find zones within proximity:```



```javascript### 2. Batch Queries

const AWS = require('aws-sdk');

const ngeohash = require('ngeohash');```javascript

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'ap-south-1' });// Use BatchGetItem for multiple stations

async function getMultipleStations(stationIds) {

async function findNearbyZones(userLat, userLon, precision = 5) {  const params = {

  // Calculate user's geohash (5-char precision = ~5km radius)    RequestItems: {

  const userGeohash = ngeohash.encode(userLat, userLon, precision);      'Station_Information': {

          Keys: stationIds.map(id => ({ Station_Id: id }))

  const params = {      }

    TableName: 'Zone_Information',    }

    IndexName: 'GeohashIndex',  };

    KeyConditionExpression: 'begins_with(Geohash, :prefix)',  

    ExpressionAttributeValues: {  const result = await dynamoDb.batchGet(params);

      ':prefix': userGeohash  return result.Responses['Station_Information'];

    }}

  };```

  

  const result = await dynamodb.query(params).promise();### 3. Geohash vs TAZID - When to Use What

  return result.Items;

}| Scenario | Recommended Approach | Reason |

|----------|---------------------|--------|

// Example usage| **User-facing station search** | ✅ Geohash (GeohashIndex) | Single query, precise proximity |

const nearbyZones = await findNearbyZones(22.3078, 114.1894, 5);| **Zone-level analytics** | ✅ TAZID (TazidIndex) | Natural data grouping |

console.log(`Found ${nearbyZones.length} zones nearby`);| **Administrative dashboards** | ✅ TAZID (TazidIndex) | Matches zone boundaries |

```| **Mobile app "nearby stations"** | ✅ Geohash (GeohashIndex) | Fast, location-aware |

| **Hybrid: Zone + distance filter** | ✅ Both | Query by TAZID, then filter by distance |

**Geohash Precision Reference:**

- 5 characters: ~5 km × 5 km## Performance Characteristics

- 6 characters: ~1.2 km × 0.6 km

- 7 characters: ~150 m × 150 m (used in database)- **Parallel Transformation**: 6 charge metrics processed concurrently

- **Batch Writes**: 25 items per DynamoDB BatchWriteItem

### 2. Get Current Zone Metrics- **Retry Logic**: Exponential backoff (3 retries max)

- **Lambda Timeouts**: 

Retrieve charging metrics for a specific zone at current time:  - Validation: 5 minutes

  - TransformStationInfo: 10 minutes

```javascript  - TransformStationData: 15 minutes

async function getZoneMetrics(zoneId, timestamp) {- **Memory Allocation**:

  const params = {  - Validation: 1024 MB

    TableName: 'Station_Data',  - TransformStationInfo: 2048 MB

    KeyConditionExpression: 'ZoneId = :zoneId AND Timestamp = :timestamp',  - TransformStationData: 3008 MB

    ExpressionAttributeValues: {

      ':zoneId': zoneId,## Error Handling

      ':timestamp': timestamp

    }### Validation Failures

  };- **Detection**: Schema mismatches, missing files, invalid data types

  - **Response**: Immediate fail with detailed error report

  const result = await dynamodb.query(params).promise();- **Recovery**: Fix CSV files and re-upload

  

  // Combine metrics from multiple records (one per metric type)### Transformation Failures

  const combined = result.Items.reduce((acc, item) => {- **Detection**: Lambda errors, DynamoDB throttling, unprocessed items

    return { ...acc, ...item };- **Response**: Continue processing other files (partial failure tolerance)

  }, {});- **Recovery**: Check CloudWatch logs, retry failed batches

  

  return combined;### Unprocessed Items

}- **Cause**: DynamoDB capacity limits, throttling

- **Handling**: Automatic retry with exponential backoff

// Example usage- **Reporting**: Returned in Lambda response for monitoring

const metrics = await getZoneMetrics('ZONE#102', '2022-09-15T14:00:00Z');

console.log(metrics);## Useful Commands

// {

//   ZoneId: 'ZONE#102',* `npm run test`         - Perform jest unit tests

//   Timestamp: '2022-09-15T14:00:00Z',* `npx cdk deploy`       - Deploy stack to AWS

//   duration: 45.2,* `npx cdk diff`         - Compare deployed stack with current state

//   e_price: 1.15,* `npx cdk synth`        - Emit synthesized CloudFormation template

//   s_price: 0.85,* `npx cdk destroy`      - Delete the stack (WARNING: deletes all data)

//   occupancy: 17,* `node upload-to-s3.js` - Upload CSV files and trigger ingestion

//   'volume-11kw': 11.3

// }## Problems Encountered During Development

```

### 1. AWS CDK Deprecation Warnings - Step Functions Map State

### 3. Get Stations in a Zone

**Problem**: CDK deployment showed deprecation warnings for Step Functions Map state configuration:

Find all available stations within a recommended zone:```

Deprecated: 'parameters', 'iterator', 'definition' properties

```javascript```

async function getStationsInZone(tazid) {

  const params = {**Root Cause**: AWS CDK 2.x introduced breaking changes to Step Functions API:

    TableName: 'Station_Information',- `Map.parameters` → `Map.itemSelector`

    IndexName: 'TazidIndex',- `Map.iterator()` (as property) → `Map.itemProcessor()` (as method call)

    KeyConditionExpression: 'TAZID = :tazid',- `StateMachine.definition` → `StateMachine.definitionBody`

    ExpressionAttributeValues: {

      ':tazid': tazid**Solution**:

    }```javascript

  };// OLD (deprecated)

  const mapState = new sfn.Map(this, 'ProcessMetrics', {

  const result = await dynamodb.query(params).promise();  parameters: { ... },

  return result.Items;  iterator: transformTask  // Property assignment

}});

const stateMachine = new sfn.StateMachine(this, 'Machine', {

// Example usage  definition: workflow

const stations = await getStationsInZone(102);});

console.log(`Zone 102 has ${stations.length} stations`);

```// NEW (correct)

const mapState = new sfn.Map(this, 'ProcessMetrics', {

### 4. Get Time-Series Data for a Zone  itemSelector: { ... }

});

Retrieve historical metrics for trend analysis:mapState.itemProcessor(transformTask);  // Method call



```javascriptconst stateMachine = new sfn.StateMachine(this, 'Machine', {

async function getZoneTimeSeries(zoneId, startTime, endTime) {  definitionBody: sfn.DefinitionBody.fromChainable(workflow)

  const params = {});

    TableName: 'Station_Data',```

    KeyConditionExpression: 'ZoneId = :zoneId AND Timestamp BETWEEN :start AND :end',

    ExpressionAttributeValues: {**Files Modified**: `lib/workflows/csv-ingest-workflow.js`, `lib/ev_station_locator-stack.js`

      ':zoneId': zoneId,

      ':start': startTime,---

      ':end': endTime

    }### 2. Lambda Module Dependency Error - "Cannot find module '../shared/dynamodb-utils'"

  };

  **Problem**: Both transformation Lambdas failed at runtime with:

  const result = await dynamodb.query(params).promise();```

  return result.Items;Runtime.ImportModuleError: Error: Cannot find module '../shared/dynamodb-utils'

}```



// Example usage**Root Cause**: CDK bundles each Lambda function independently from its own directory. The shared utility file at `lambda/shared/dynamodb-utils.js` was outside the Lambda directories, so CDK's automatic bundling couldn't include it.

const timeSeries = await getZoneTimeSeries(

  'ZONE#102',**Directory Structure Issue**:

  '2022-09-01T00:00:00Z',```

  '2022-09-30T23:59:59Z'lambda/

);  ├── shared/

console.log(`Retrieved ${timeSeries.length} data points`);  │   └── dynamodb-utils.js          ← Outside Lambda directories

```  ├── transform-station-info/

  │   └── index.js                    ← Tried: require('../shared/dynamodb-utils')

---  └── transform-station-data/

      └── index.js                    ← Tried: require('../shared/dynamodb-utils')

## Recommendation Algorithm```



### High-Level Flow**Solution**: Copy shared utilities into each Lambda directory and change imports:

```bash

```# Copy shared code into each Lambda

User Location (Lat, Lon)cp -r lambda/shared lambda/transform-station-info/

    ↓cp -r lambda/shared lambda/transform-station-data/

1. Find nearby zones using geohash proximity

    ↓# Change imports from:

2. Get current metrics for each zoneconst { writeToDynamoDB } = require('../shared/dynamodb-utils');

    ↓

3. Calculate zone scores based on:# To:

   - Distance (35% weight)const { writeToDynamoDB } = require('./shared/dynamodb-utils');

   - Availability (40% weight)```

   - Price (25% weight)

    ↓Also created `package.json` in each Lambda directory and ran `npm install` for dependencies (ngeohash, @aws-sdk/client-s3, @aws-sdk/client-dynamodb, fast-csv).

4. Recommend top-scoring zone

    ↓**Files Modified**: `lambda/transform-station-info/index.js`, `lambda/transform-station-data/index.js`

5. Return available stations in that zone

```---



### Implementation Example### 3. DynamoDB Schema Mismatch - "The provided key element does not match the schema"



```javascript**Problem**: TransformStationData Lambda consistently failed with:

const AWS = require('aws-sdk');```

const ngeohash = require('ngeohash');ValidationException: The provided key element does not match the schema

const geolib = require('geolib');```



const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'ap-south-1' });**Root Cause**: Mismatch between DynamoDB table schema and Lambda code:



async function recommendStation(userLat, userLon, timestamp) {**Table Schema** (defined in CDK):

  // Step 1: Find nearby zones (5km radius)```javascript

  const userGeohash = ngeohash.encode(userLat, userLon, 5);const stationDataTable = new dynamodb.Table(this, 'StationData', {

    partitionKey: { name: 'Station_Id', type: NUMBER },

  const zoneParams = {  sortKey: { name: 'Time#Attribute', type: STRING }  // Note: Hash symbol

    TableName: 'Zone_Information',});

    IndexName: 'GeohashIndex',```

    KeyConditionExpression: 'begins_with(Geohash, :prefix)',

    ExpressionAttributeValues: { ':prefix': userGeohash }**Lambda Code** (incorrect):

  };```javascript

  dataPoints.push({

  const nearbyZones = (await dynamodb.query(zoneParams).promise()).Items;  Station_Id: stationId,

    Time_Attribute: `${timestamp}#${metric}`,  // Underscore instead of hash!

  if (nearbyZones.length === 0) {  Value: value

    throw new Error('No zones found nearby');});

  }```

  

  // Step 2: Get metrics for each zone**Solution**: Changed attribute name from `Time_Attribute` to `'Time#Attribute'` (with quotes due to special character):

  const zoneScores = [];```javascript

  dataPoints.push({

  for (const zone of nearbyZones) {  Station_Id: stationId,

    const metricsParams = {  'Time#Attribute': `${timestamp}#${metric}`,  // Matches schema

      TableName: 'Station_Data',  Value: value,

      KeyConditionExpression: 'ZoneId = :zoneId AND Timestamp = :timestamp',  TAZID: tazid,

      ExpressionAttributeValues: {  Metric: metric,

        ':zoneId': zone.ZoneId,  Timestamp: timestamp

        ':timestamp': timestamp});

      }```

    };

    **Lesson**: Always verify DynamoDB attribute names match exactly between CDK schema and Lambda write operations.

    const metricsResult = await dynamodb.query(metricsParams).promise();

    const metrics = metricsResult.Items.reduce((acc, item) => ({ ...acc, ...item }), {});---

    

    // Calculate distance in meters### 4. TAZID Lookup Returning Empty Arrays - Type Mismatch

    const distance = geolib.getDistance(

      { latitude: userLat, longitude: userLon },**Problem**: TransformStationData parsed CSV successfully but logged "Finished parsing 0 data points" for all metrics.

      { latitude: zone.Latitude, longitude: zone.Longitude }

    );**Root Cause #1 - Key Type Mismatch**: 

    The `tazidToStations` object from validation Lambda had **string keys**, but the transformation code was looking up with **numeric keys**:

    // Calculate availability (inverse of occupancy)

    const totalChargers = zone.ChargeCount * 6; // Assume avg 6 chargers per station```javascript

    const availability = Math.max(0, totalChargers - (metrics.occupancy || 0));// Validation output (from validation-output.json):

    const availabilityRatio = availability / totalChargers;{

      tazidToStations: {

    // Calculate total price (electricity + service)    "102": [2069, 2076, 2084, 2095],  // String keys

    const totalPrice = (metrics.e_price || 0) + (metrics.s_price || 0);    "104": [2127, 2131, 2159],

        "105": [2171, 2177, ...]

    // Normalize scores (0-100)  }

    const distanceScore = Math.max(0, 100 - (distance / 50)); // Max 5km}

    const availabilityScore = availabilityRatio * 100;

    const priceScore = Math.max(0, 100 - (totalPrice * 25)); // Lower price = higher score// Transformation code (incorrect):

    const tazid = parseInt(header);  // Returns number: 102

    // Weighted average (distance: 35%, availability: 40%, price: 25%)const stationIds = tazidToStations[tazid];  // Lookup fails! 102 !== "102"

    const finalScore = ```

      (distanceScore * 0.35) +

      (availabilityScore * 0.40) +**Root Cause #2 - CSV Header Format Mismatch**:

      (priceScore * 0.25);The code assumed headers would be formatted as "TAZID_102" but actual CSV headers were plain numbers:

    

    zoneScores.push({```csv

      zone,time,102,104,105,106,107,108,109,110,...

      metrics,2022-09-01 00:00:00,0.924,0.923,1.124,...

      distance,```

      availability,

      totalPrice,The regex `/tazid[_\s]*(\d+)/i` failed to match plain numeric headers.

      finalScore

    });**Solution**:

  }```javascript

  // OLD (failed):

  // Step 3: Sort by score and pick top zoneconst match = header.match(/tazid[_\s]*(\d+)/i);

  zoneScores.sort((a, b) => b.finalScore - a.finalScore);if (!match) continue;

  const bestZone = zoneScores[0];const tazid = parseInt(match[1]);

  const stationIds = tazidToStations[tazid];  // Type mismatch

  // Step 4: Get stations in the recommended zone

  const stationParams = {// NEW (works):

    TableName: 'Station_Information',const tazid = parseInt(header);  // Parse header directly as integer

    IndexName: 'TazidIndex',if (isNaN(tazid)) continue;

    KeyConditionExpression: 'TAZID = :tazid',const stationIds = tazidToStations[tazid.toString()];  // Convert to string for lookup

    ExpressionAttributeValues: { ':tazid': bestZone.zone.TAZID }```

  };

  **Debugging Steps**:

  const stations = (await dynamodb.query(stationParams).promise()).Items;1. Retrieved actual CSV headers: `aws s3 cp s3://.../e_price.csv - | head -2`

  2. Examined validation output: `Get-Content validation-output.json`

  // Return recommendation3. Confirmed keys were strings: `"102"`, `"104"`, etc.

  return {4. Fixed both parsing logic and type conversion

    recommendedZone: {

      zoneId: bestZone.zone.ZoneId,---

      tazid: bestZone.zone.TAZID,

      distance: bestZone.distance,### 5. Lambda Timeout - Processing 6.9 Million Data Points

      availability: bestZone.availability,

      price: bestZone.totalPrice,**Problem**: TransformStationData Lambda timed out after 900 seconds (15 minutes - AWS Lambda maximum):

      score: bestZone.finalScore,```json

      metrics: bestZone.metrics{

    },  "errorType": "Sandbox.Timedout",

    stations: stations.map(s => ({  "errorMessage": "RequestId: ... Error: Task timed out after 900.00 seconds"

      stationId: s.Station_Id,}

      latitude: s.Latitude,```

      longitude: s.Longitude,

      slowChargers: s.SlowCount,**Data Volume Calculation**:

      fastChargers: s.FastCount

    }))Let's break down where these numbers come from:

  };

}**Dataset Dimensions**:

- **275 TAZIDs** (Traffic Analysis Zones)

// Example usage- **1,682 stations** total across all zones

const recommendation = await recommendStation(- **Timestamps**: ~27,000 rows in charge_1hour CSV files (6 months of hourly data)

  22.3078,  // User latitude- **6 metrics** processed in parallel

  114.1894, // User longitude

  '2022-09-15T14:00:00Z'  // Current timestamp**How 6.9 Million Data Points Are Generated**:

);

1. **Single CSV Row Processing**:

console.log('Recommended Zone:', recommendation.recommendedZone);   ```

console.log('Available Stations:', recommendation.stations.length);   time,102,104,105,...,1173 (276 columns total: 1 time + 275 TAZIDs)

```   2022-09-01 00:00:00,0.924,0.923,1.124,...

   ```

### Scoring Weights Rationale

2. **For Each Row** (e.g., one timestamp):

| Factor | Weight | Reasoning |   - 275 TAZID columns × average 6 stations per TAZID = ~1,650 data points

|--------|--------|-----------|   

| **Distance** | 35% | User convenience - closer is better, but not the only factor |3. **For Entire File** (e.g., e_price.csv):

| **Availability** | 40% | Primary concern - no point recommending a full station |   - 27,000 timestamps × 1,650 data points per row = ~44.5 million potential points

| **Price** | 25% | Cost-conscious users care, but availability matters more |   

4. **Zone-to-Station Mapping** actually generates:

**Adjustable:** Modify weights based on user preferences or time of day.   ```javascript

   // For TAZID "102" with 4 stations: [2069, 2076, 2084, 2095]

---   // One CSV value (e.g., e_price = 0.924) becomes 4 DynamoDB records:

   

## Metrics Reference   { Station_Id: 2069, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }

   { Station_Id: 2076, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }

### duration   { Station_Id: 2084, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }

- **Description:** Average charging session duration in minutes   { Station_Id: 2095, Time#Attribute: "2022-09-01 00:00:00#e_price", Value: 0.924, TAZID: 102 }

- **Source:** `charge_1hour_duration.csv`   ```

- **Type:** NUMBER (float)

- **Use Case:** Estimate how long user will need to wait if all chargers are occupied5. **Actual Volume** (from CloudWatch logs):

- **Example:** `45.2` (45 minutes 12 seconds)   ```

   Finished parsing 6,893,928 data points for metric volume-11kw

### e_price   Writing 6,893,928 items in 275,758 batches to Station_Data

- **Description:** Electricity price in Chinese Yuan (CNY) per kilowatt-hour   ```

- **Source:** `charge_1hour_e_price.csv`

- **Type:** NUMBER (float)**Where 275,758 Batches Come From**:

- **Use Case:** Calculate charging cost for user- DynamoDB BatchWriteItem supports maximum **25 items per batch**

- **Example:** `1.15` (1.15 CNY/kWh)- 6,893,928 data points ÷ 25 items/batch = 275,757.12 ≈ **275,758 batches**



### s_price**Why It Times Out**:

- **Description:** Service fee in Chinese Yuan (CNY) per kilowatt-hour- Each batch write takes ~130-250ms (including retries for unprocessed items)

- **Source:** `charge_1hour_s_price.csv`- 275,758 batches × 0.2 seconds average = **55,151 seconds** (~15.3 hours!)

- **Type:** NUMBER (float)- Lambda maximum timeout: 900 seconds (15 minutes)

- **Use Case:** Add to electricity price for total cost- **Result**: Timeout after processing only ~4,500 batches (~2.7% of data)

- **Example:** `0.85` (0.85 CNY/kWh)

**Temporary Solution** (for development/testing):

### occupancy```javascript

- **Description:** Number of busy charging piles (chargers in use) in the zone// Limit processing to first 1,000 rows to avoid timeout

- **Source:** `charge_1hour_occupancy.csv`const MAX_ROWS = 1000;

- **Type:** NUMBER (integer)let rowCount = 0;

- **Use Case:** Calculate availability: `totalChargers - occupancy`

- **Example:** `17` (17 chargers currently in use)stream.pipe(csv.parse(...))

  .on('data', (row) => {

### volume-11kw    if (isFirstRow) { /* handle headers */ return; }

- **Description:** Total charging volume in megawatt-hours (MWh) assuming 11kW rated capacity    

- **Source:** `charge_1hour_volume-11kw.csv`    rowCount++;

- **Type:** NUMBER (float)    if (rowCount > MAX_ROWS) return;  // Skip remaining rows

- **Use Case:** Realistic usage estimation (not pile-rated capacity)    

- **Example:** `11.3` (11.3 MWh delivered in the hour)    // Process row...

  });

**Note:** The original dataset includes a `volume` metric with unrealistic pile-rated capacity. This project uses `volume-11kw` for more accurate usage patterns.```



---With 1,000 rows:

- 1,000 timestamps × 275 TAZIDs × 6 avg stations = ~1.65 million points

## Project Structure- 1.65M ÷ 25 = 66,000 batches

- 66,000 × 0.2s = 13,200 seconds (~3.7 hours) - still too long

```

EvStationLocator/**Production Solutions** (not yet implemented):

├── bin/1. **Option A - Chunk Processing with Step Functions**:

│   └── ev_station_locator.js           # CDK app entry point   - Split CSV into date ranges (e.g., one week at a time)

├── lib/   - Use Step Functions Map state to process chunks in parallel

│   ├── ev_station_locator-stack.js     # Main CDK stack definition   - 6 months ÷ 26 weeks = ~1,000 rows per chunk

│   └── workflows/   

│       └── csv-ingest-workflow.js      # Step Functions workflow definition2. **Option B - Use DynamoDB PartiQL Batch**:

├── lambda/   - Use `ExecuteStatement` with batching for better performance

│   ├── validate-csv/   - Requires code restructuring

│   │   ├── index.js                    # CSV validation logic

│   │   └── package.json3. **Option C - Use AWS Glue or EMR**:

│   ├── transform-zone-info/   - Better suited for large-scale data transformation

│   │   ├── index.js                    # Zone transformation with geohash   - Can process millions of rows efficiently

│   │   ├── package.json   

│   │   └── node_modules/               # Includes ngeohash4. **Option D - Stream Processing**:

│   ├── transform-station-info/   - Write to DynamoDB as data streams (avoid accumulating in memory)

│   │   ├── index.js                    # Station transformation with geohash   - Implement backpressure handling

│   │   ├── package.json

│   │   └── node_modules/               # Includes ngeohash5. **Option E - Data Aggregation**:

│   ├── transform-station-data/   - Instead of storing every timestamp for every station, aggregate by hour/day

│   │   ├── index.js                    # Zone-level metrics transformation   - Reduce 27,000 timestamps to ~180 days × stations

│   │   ├── package.json

│   │   └── node_modules/**Current Status**: Development version limited to 1,000 rows for testing. Production implementation requires architectural changes to handle full dataset.

│   └── manifest-trigger/

│       ├── index.js                    # Parses manifest and starts workflow---

│       └── package.json

├── test/### 6. S3 Event Trigger Testing Without Re-uploading Files

│   └── ev_station_locator.test.js      # Jest unit tests

├── cdk.json                            # CDK configuration**Problem**: During development, needed to test workflow repeatedly without uploading 1.1 GB of CSV files each time.

├── package.json                        # CDK dependencies

├── jest.config.js                      # Jest test configuration**Solution**: Use S3 metadata update to trigger ObjectCreated event:

└── README.md                           # This file```bash

```# Copy manifest file to itself with metadata directive REPLACE

# This generates a new ObjectCreated:Put event without re-uploading content

---aws s3 cp \

  s3://bucket/urban-ev-data/_manifest.json \

## Development  s3://bucket/urban-ev-data/_manifest.json \

  --metadata-directive REPLACE \

### Run Tests  --region ap-south-1

```

```bash

npm testThis triggers the Lambda without network transfer overhead, useful for rapid iteration.

```

---

### Synthesize CloudFormation Template

### 7. File Path Prefix Mismatch

```bash

cdk synth**Problem**: Lambda functions failed with `NoSuchKey` error when trying to read CSV files from S3.

```

**Root Cause**: CSV files were uploaded to S3 with `urban-ev-data/` prefix, but Lambda code was missing this prefix.

Output is written to `cdk.out/EvStationLocatorStack.template.json`.

**Solution**: Added prefix to all S3 GetObject operations:

### View Differences Before Deploy```javascript

// Before:

```bashconst csvKey = `charge_1hour/${metric}.csv`;

cdk diff

```// After:

const csvKey = `urban-ev-data/charge_1hour/${metric}.csv`;

Shows changes between deployed stack and local code.```



### Destroy Stack---



⚠️ **Warning:** This deletes all DynamoDB tables and data permanently.### 8. Metrics Array Mismatch with Actual CSV Filenames



```bash**Problem**: Step Functions Map state received incorrect metric names, causing file not found errors.

cdk destroy

```**Root Cause**: Hardcoded metrics array didn't match actual CSV filenames:

```javascript

Confirm with `y` when prompted.// Incorrect:

metrics: ['slow_available', 'fast_available', 'queue_time', 'slow_avg_duration', 'fast_avg_duration', 'e_price']

### Update Lambda Code

// Actual files in S3:

After modifying Lambda code:['duration.csv', 'e_price.csv', 'occupancy.csv', 's_price.csv', 'volume-11kw.csv', 'volume.csv']

```

1. Redeploy stack:

   ```bash**Solution**: Updated manifest-trigger Lambda to send correct metric names:

   cdk deploy```javascript

   ```const payload = {

  bucket: bucketName,

CDK automatically detects code changes and updates Lambda functions.  files: manifest.files,

  metrics: ['duration', 'e_price', 'occupancy', 's_price', 'volume-11kw', 'volume']

### View CloudWatch Logs};

```

```bash

# List log groups---

aws logs describe-log-groups --region ap-south-1

## Next Steps

# Tail logs for a Lambda function

aws logs tail /aws/lambda/EvStationLocatorStack-TransformStationData... \When adding transformation and loading logic:

  --follow \- Create new workflow files in `lib/workflows/`

  --region ap-south-1- Add transformation Lambda in `lambda/transform-csv/`

```- Add loading Lambda in `lambda/load-to-dynamodb/`

- Update `csv-ingest-workflow.js` to chain new steps

Or use AWS Console → CloudWatch → Log Groups.- Stack file remains clean - just add new Lambda declarations


---

## Limitations & Trade-offs

### 1. MAX_ROWS = 10 Constraint

**Current:** Only processes first 10 timestamps per metric (13,750 total records)

**Full Dataset:** 27,000 timestamps = 37.125 million records

**Trade-off:**
- ✅ Avoids Lambda timeout
- ✅ Stays within Free Tier
- ❌ Limited time-series analysis capability

**Solution for Production:**
- Implement Step Functions chunking (split CSVs into 1000-row chunks)
- Use PAY_PER_REQUEST billing for one-time bulk load (~$46)
- Spread loading across multiple days to stay in Free Tier

### 2. Zone-Level Metrics (Not Station-Level)

**Current:** Stores aggregated zone values

**Limitation:** Cannot differentiate metrics between stations in the same zone

**Trade-off:**
- ✅ Preserves original data structure (zone-aggregated)
- ✅ 97% data reduction (7.4M vs 266M records)
- ❌ Less granular recommendations

**Why It's Acceptable:**
- Dataset is inherently zone-level (UrbanEV design choice)
- Recommendation flow: Find best zone → Return available stations
- Expanding to stations would create 266M duplicate records

### 3. PROVISIONED Billing Mode

**Current:** Fixed capacity (21 RCU / 23 WCU)

**Limitation:** 
- Cannot handle sudden traffic spikes
- Throttling if queries exceed capacity

**Trade-off:**
- ✅ Free Tier eligible ($0.00/month)
- ❌ Not suitable for unpredictable traffic

**Solution for Production:**
- Use PAY_PER_REQUEST for query-heavy workloads
- Enable Auto Scaling for PROVISIONED tables

### 4. No Real-Time Data Updates

**Current:** Batch CSV uploads trigger one-time transformations

**Limitation:** Data becomes stale over time

**Trade-off:**
- ✅ Simple architecture
- ❌ Not suitable for real-time availability

**Solution for Production:**
- Implement scheduled data refreshes (EventBridge + Lambda)
- Integrate with live charging station APIs
- Use DynamoDB Streams for change notifications

### 5. Single-Region Deployment

**Current:** Deployed to `ap-south-1` (Mumbai)

**Limitation:** Higher latency for users far from Mumbai

**Trade-off:**
- ✅ Lower Free Tier costs (single region)
- ❌ Slower queries for global users

**Solution for Production:**
- Use DynamoDB Global Tables for multi-region replication
- Deploy API Gateway in multiple regions
- Use CloudFront for edge caching

---

## Cost Analysis

### Current Configuration (MAX_ROWS = 10)

| Service | Usage | Free Tier | Billable | Cost |
|---------|-------|-----------|----------|------|
| **DynamoDB** | 21 RCU / 23 WCU | 25 RCU / 25 WCU | 0 | $0.00 |
| **DynamoDB Storage** | ~2 MB | 25 GB | 0 | $0.00 |
| **Lambda Invocations** | 5 per upload | 1M/month | 0 | $0.00 |
| **Lambda Compute** | ~2,760 GB-sec | 400,000 GB-sec | 0 | $0.00 |
| **S3 Storage** | ~50 MB | 5 GB | 0 | $0.00 |
| **S3 Requests** | ~15 GET, 8 PUT | 20K GET, 2K PUT | 0 | $0.00 |
| **Step Functions** | 1 execution | 4,000/month | 0 | $0.00 |
| **CloudWatch Logs** | ~100 MB/month | 5 GB | 0 | $0.00 |
| **Total** | | | | **$0.00/month** |

✅ **100% Free Tier Compliant**

---

### Full Dataset Configuration (27,000 Timestamps)

**Option 1: PROVISIONED with Chunking**

Spread loading across multiple days to stay within Free Tier:

| Component | Monthly Cost |
|-----------|--------------|
| DynamoDB (21 RCU / 23 WCU) | $0.00 (Free Tier) |
| Storage (9.3 GB) | $0.00 (Free Tier) |
| Lambda (chunked loading) | $0.00 (Free Tier) |
| **Total** | **$0.00/month** |

**Processing Time:** 10-15 hours total (spread across days)

---

**Option 2: PAY_PER_REQUEST One-Time Load**

Switch Station_Data to PAY_PER_REQUEST for bulk load, then back to PROVISIONED:

| Component | Cost |
|-----------|------|
| Write Requests (37M items) | $46.25 |
| Lambda Compute (15 hours) | $2.40 |
| **One-Time Total** | **$48.65** |

**Ongoing Cost After Load:**
- DynamoDB PROVISIONED: $0.00 (Free Tier)
- Storage (9.3 GB): $0.00 (Free Tier)
- **Monthly Total:** **$0.00**

---

**Recommendation:** Use Option 1 (chunking) if time permits. Use Option 2 if you need the full dataset loaded quickly.

---

## Troubleshooting

### Stack Deployment Fails

**Error:** `Resource handler returned message: "Resource of type 'AWS::DynamoDB::Table' with identifier 'Station_Data' already exists."`

**Solution:**
- DynamoDB tables cannot be replaced if they have custom names
- Manually delete the table:
  ```bash
  aws dynamodb delete-table --table-name Station_Data --region ap-south-1
  ```
- Redeploy:
  ```bash
  cdk deploy
  ```

---

### Lambda Timeout During Data Load

**Error:** `Task timed out after 900.00 seconds`

**Cause:** Processing too many rows (MAX_ROWS set too high)

**Solution:**
- Reduce MAX_ROWS in `lambda/transform-station-data/index.js`:
  ```javascript
  const MAX_ROWS = 10;  // Lower value
  ```
- Redeploy:
  ```bash
  cdk deploy
  ```

---

### DynamoDB Throttling

**Error:** `ProvisionedThroughputExceededException`

**Cause:** Write requests exceed 5 WCU capacity

**Solution:**
- Increase write capacity in `lib/ev_station_locator-stack.js`:
  ```javascript
  writeCapacity: 10  // Increase from 5
  ```
- Note: This may exceed Free Tier limits

---

### Step Functions Execution Fails

**Symptom:** Execution shows "Failed" state

**Debugging:**
1. Open execution in Step Functions console
2. Click on the failed state
3. View "Execution event history"
4. Check "Exception" tab for error details

**Common Errors:**
- **CSV not found:** Verify file path in manifest matches S3 upload path
- **Invalid CSV format:** Check for missing columns or incorrect headers
- **DynamoDB write error:** Verify table exists and Lambda has write permissions

---

### Geohash Queries Return No Results

**Cause:** Geohash prefix too specific (e.g., 7 characters)

**Solution:**
- Use shorter prefix (5-6 characters) for wider search radius:
  ```javascript
  const userGeohash = ngeohash.encode(userLat, userLon, 5);  // 5km radius
  ```

---

### Data Not Loading to DynamoDB

**Debugging Steps:**

1. **Check Lambda logs:**
   ```bash
   aws logs tail /aws/lambda/EvStationLocatorStack-TransformStationData... --region ap-south-1
   ```

2. **Verify S3 file exists:**
   ```bash
   aws s3 ls s3://BUCKET_NAME/urban-ev-data/
   ```

3. **Check IAM permissions:**
   - Lambda execution role must have `dynamodb:BatchWriteItem` permission
   - Verify in IAM console → Roles → EvStationLocatorStack-TransformStationDataRole...

4. **Test Lambda manually:**
   - AWS Console → Lambda → Select function → Test tab
   - Create test event with sample metric:
     ```json
     {
       "bucket": "BUCKET_NAME",
       "key": "urban-ev-data/charge_1hour_occupancy.csv",
       "metric": "occupancy"
     }
     ```

---

## References

### Dataset Citation

Wang, S., Zhang, R., Chen, Y., Guo, Y., Wang, X., & Chen, X. (2025). UrbanEV: A large-scale dataset of electric vehicle charging sessions in Shenzhen and Hong Kong. *Scientific Data*. https://doi.org/10.1038/s41597-024-04176-6

### Data Repository

Dryad Digital Repository: https://datadryad.org/stash/dataset/doi:10.5061/dryad.gqnk98swb

### AWS Documentation

- [AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [Lambda Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)

### Libraries

- [ngeohash](https://www.npmjs.com/package/ngeohash) - Geohash encoding/decoding
- [geolib](https://www.npmjs.com/package/geolib) - Geospatial distance calculations
- [csv-parser](https://www.npmjs.com/package/csv-parser) - CSV parsing for Node.js

---

## License

This project is licensed under the MIT License.

**Dataset License:** Creative Commons CC0 1.0 Universal (Public Domain)

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -m "Add new feature"`
4. Push to branch: `git push origin feature/new-feature`
5. Submit a pull request

---

## Support

For issues or questions:
- Open a GitHub issue: https://github.com/puneetjoshi58/EVStationLocator/issues
- Email: puneet.joshi58@example.com

---

**Last Updated:** November 11, 2025  
**Version:** 1.0.0  
**CDK Version:** 2.103.1  
**Node.js Version:** 18.x
