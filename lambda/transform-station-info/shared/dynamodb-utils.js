const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const BATCH_SIZE = 25; 
const MAX_RETRIES = 3;

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

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

    const unprocessedItems = response.UnprocessedItems?.[tableName] || [];

    if (unprocessedItems.length > 0) {
      console.warn(`Batch had ${unprocessedItems.length} unprocessed items`);

      if (retryCount < MAX_RETRIES) {
        const backoffMs = Math.pow(2, retryCount) * 100;
        console.log(`Retrying ${unprocessedItems.length} unprocessed items after ${backoffMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        
        await sleep(backoffMs);

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

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  writeToDynamoDB,
  writeBatchWithRetry,
  chunkArray,
  sleep,
  BATCH_SIZE,
  MAX_RETRIES
};
