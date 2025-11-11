/**
 * Shared DynamoDB utility functions for batch write operations
 * Used by both transform-station-info and transform-station-data Lambdas
 */

const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const BATCH_SIZE = 25; // DynamoDB BatchWriteItem limit
const MAX_RETRIES = 3;

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

/**
 * Write items to DynamoDB using BatchWriteItem with retry logic
 * 
 * @param {Array} items - Array of items to write
 * @param {string} tableName - DynamoDB table name
 * @returns {Object} - { successCount, failedCount, unprocessedItems }
 */
async function writeToDynamoDB(items, tableName) {
  const batches = chunkArray(items, BATCH_SIZE);
  let successCount = 0;
  let failedCount = 0;
  const allUnprocessedItems = [];

  console.log(`Writing ${items.length} items in ${batches.length} batches to ${tableName}`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    // Log progress every 100 batches to avoid CloudWatch spam
    if ((i + 1) % 100 === 0 || i === 0) {
      console.log(`Processing batch ${i + 1}/${batches.length}...`);
    }

    const result = await writeBatchWithRetry(batch, tableName);
    successCount += result.successCount;
    failedCount += result.failedCount;

    if (result.unprocessedItems.length > 0) {
      allUnprocessedItems.push(...result.unprocessedItems);
    }
  }

  console.log(`Write complete: ${successCount} success, ${failedCount} failed, ${allUnprocessedItems.length} unprocessed`);

  return {
    successCount,
    failedCount,
    unprocessedItems: allUnprocessedItems
  };
}

/**
 * Write a single batch with exponential backoff retry for unprocessed items
 * 
 * @param {Array} items - Batch of items to write
 * @param {string} tableName - DynamoDB table name
 * @param {number} retryCount - Current retry attempt (for exponential backoff)
 * @returns {Object} - { successCount, failedCount, unprocessedItems }
 */
async function writeBatchWithRetry(items, tableName, retryCount = 0) {
  const requestItems = {
    [tableName]: items.map(item => ({
      PutRequest: {
        Item: marshall(item, { removeUndefinedValues: true })
      }
    }))
  };

  try {
    const command = new BatchWriteItemCommand({
      RequestItems: requestItems
    });

    const response = await dynamoClient.send(command);

    // Handle unprocessed items (throttling, capacity limits, etc.)
    const unprocessedItems = response.UnprocessedItems?.[tableName] || [];

    if (unprocessedItems.length > 0) {
      console.warn(`Batch had ${unprocessedItems.length} unprocessed items`);

      // Retry unprocessed items with exponential backoff
      if (retryCount < MAX_RETRIES) {
        const backoffMs = Math.pow(2, retryCount) * 100; // 100ms, 200ms, 400ms
        console.log(`Retrying ${unprocessedItems.length} unprocessed items after ${backoffMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        
        await sleep(backoffMs);

        // Unmarshall items back to plain objects for retry
        const unprocessedData = unprocessedItems.map(item => unmarshallItem(item.PutRequest.Item));

        return await writeBatchWithRetry(unprocessedData, tableName, retryCount + 1);
      } else {
        console.error(`Max retries reached. ${unprocessedItems.length} items remain unprocessed`);
        return {
          successCount: items.length - unprocessedItems.length,
          failedCount: 0,
          unprocessedItems: unprocessedItems.map(item => item.PutRequest.Item)
        };
      }
    }

    return {
      successCount: items.length,
      failedCount: 0,
      unprocessedItems: []
    };

  } catch (error) {
    console.error(`Error writing batch (attempt ${retryCount + 1}/${MAX_RETRIES}):`, error);

    // Retry entire batch on error (network issues, temporary service errors, etc.)
    if (retryCount < MAX_RETRIES) {
      const backoffMs = Math.pow(2, retryCount) * 100;
      console.log(`Retrying entire batch after ${backoffMs}ms`);
      await sleep(backoffMs);
      return await writeBatchWithRetry(items, tableName, retryCount + 1);
    } else {
      console.error('Max retries reached. Batch failed completely.');
      return {
        successCount: 0,
        failedCount: items.length,
        unprocessedItems: items
      };
    }
  }
}

/**
 * Unmarshall a DynamoDB item back to plain JavaScript object
 * 
 * @param {Object} marshalledItem - DynamoDB marshalled item
 * @returns {Object} - Plain JavaScript object
 */
function unmarshallItem(marshalledItem) {
  const obj = {};
  Object.keys(marshalledItem).forEach(key => {
    const value = marshalledItem[key];
    if (value.N) obj[key] = parseFloat(value.N);
    else if (value.S) obj[key] = value.S;
    else if (value.BOOL) obj[key] = value.BOOL;
    else if (value.NULL) obj[key] = null;
  });
  return obj;
}

/**
 * Split array into chunks of specified size
 * 
 * @param {Array} array - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array[]} - Array of chunks
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Sleep for specified milliseconds
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Merge zone-level metric records by PK+SK combination
 * Combines metrics from multiple CSVs into single records
 * Also combines e_price + s_price into total_price
 * 
 * @param {Array} records - Array of records with PK, SK, and metric attributes
 * @returns {Array} - Merged records with all metrics combined
 */
function mergeZoneRecords(records) {
  const recordMap = new Map();

  records.forEach(record => {
    const key = `${record.PK}#${record.SK}`;
    
    if (!recordMap.has(key)) {
      recordMap.set(key, {
        PK: record.PK,
        SK: record.SK,
        TAZID: record.TAZID,
        Timestamp: record.Timestamp
      });
    }

    const existing = recordMap.get(key);
    
    // Merge metric attributes
    Object.keys(record).forEach(attr => {
      if (!['PK', 'SK', 'TAZID', 'Timestamp'].includes(attr)) {
        existing[attr] = record[attr];
      }
    });
  });

  // Convert to array and combine e_price + s_price
  const merged = [];
  recordMap.forEach(record => {
    if (record.e_price !== undefined && record.s_price !== undefined) {
      record.total_price = record.e_price + record.s_price;
      delete record.e_price;
      delete record.s_price;
    }
    
    // Rename volume-11kw to volume_11kw (DynamoDB attribute naming)
    if (record['volume-11kw'] !== undefined) {
      record.volume_11kw = record['volume-11kw'];
      delete record['volume-11kw'];
    }
    
    merged.push(record);
  });

  console.log(`Merged ${records.length} records into ${merged.length} combined zone-level records`);
  return merged;
}

module.exports = {
  writeToDynamoDB,
  writeBatchWithRetry,
  chunkArray,
  sleep,
  mergeZoneRecords,
  BATCH_SIZE,
  MAX_RETRIES
};
