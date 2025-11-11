const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const csv = require('fast-csv');
const { writeToDynamoDB } = require('./shared/dynamodb-utils');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  const bucketName = event.bucketName || process.env.BUCKET_NAME;
  const tableName = process.env.STATION_DATA_TABLE_NAME;

  try {
    console.log('Starting zone-level charge metrics transformation');
    
    // Process all metrics and combine them
    const combinedData = await processAllMetrics(bucketName);
    console.log(`Parsed ${combinedData.length} zone-level records (combined metrics)`);

    const results = await writeToDynamoDB(combinedData, tableName);
    const isSuccess = results.successCount > 0;

    return {
      statusCode: isSuccess ? 200 : 500,
      success: isSuccess,
      message: isSuccess 
        ? `Zone-level charge metrics transformed with ${results.failedCount > 0 ? 'partial' : 'complete'} success`
        : `Failed to transform zone-level charge metrics`,
      stats: {
        totalRecords: combinedData.length,
        successfulWrites: results.successCount,
        failedWrites: results.failedCount,
        unprocessedItems: results.unprocessedItems.length
      },
      unprocessedItems: results.unprocessedItems
    };

  } catch (error) {
    console.error(`Error transforming zone-level charge metrics:`, error);
    
    return {
      statusCode: 500,
      success: false,
      error: error.message,
      stats: {
        totalRecords: 0,
        successfulWrites: 0,
        failedWrites: 0,
        unprocessedItems: 0
      }
    };
  }
};

async function processAllMetrics(bucketName) {

  const metrics = ['duration', 'e_price', 's_price', 'occupancy', 'volume-11kw'];
  
  console.log('Reading all metric CSVs...');
  const metricDataMaps = await Promise.all(
    metrics.map(metric => readMetricCsv(bucketName, metric))
  );

  // Combine into zone-timestamp records
  const combinedMap = new Map();

  metricDataMaps.forEach((metricMap, idx) => {
    const metricName = metrics[idx];
    console.log(`Processing ${metricName}: ${metricMap.size} zone-timestamp combinations`);

    metricMap.forEach((value, key) => {
      if (!combinedMap.has(key)) {
        const [tazid, timestamp] = key.split('#');
        combinedMap.set(key, {
          PK: `ZONE#${tazid}`,
          SK: timestamp,
          TAZID: parseInt(tazid),
          Timestamp: timestamp
        });
      }
      
      const record = combinedMap.get(key);
      record[metricName === 'volume-11kw' ? 'volume_11kw' : metricName] = value;
    });
  });

  const finalRecords = [];
  combinedMap.forEach(record => {
    if (record.e_price !== undefined && record.s_price !== undefined) {
      record.total_price = record.e_price + record.s_price;
      delete record.e_price;
      delete record.s_price;
    }
    finalRecords.push(record);
  });

  console.log(`Combined ${finalRecords.length} records with metrics merged`);
  return finalRecords;
}

async function readMetricCsv(bucketName, metric) {
  const key = `urban-ev-data/charge_1hour/${metric}.csv`;
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  });

  const response = await s3Client.send(command);
  const dataMap = new Map(); // key: "tazid#timestamp", value: metric value
  
  const MAX_ROWS = 1000;
  let rowCount = 0;

  return new Promise((resolve, reject) => {
    const stream = response.Body;
    let headers = [];
    let isFirstRow = true;

    stream
      .pipe(csv.parse({ headers: false, trim: true, ignoreEmpty: true }))
      .on('data', (row) => {
        try {
          if (isFirstRow) {
            headers = row.map(h => h.trim().toLowerCase());
            isFirstRow = false;
            return;
          }

          rowCount++;
          if (rowCount > MAX_ROWS) {
            return;
          }

          const timestamp = row[0];

          for (let i = 1; i < headers.length; i++) {
            const header = headers[i];
            const value = parseFloat(row[i]);

            if (isNaN(value)) continue;

            const tazid = parseInt(header);
            if (isNaN(tazid)) continue;

            const key = `${tazid}#${timestamp}`;
            dataMap.set(key, value);
          }

        } catch (error) {
          console.warn(`Skipping invalid row in ${metric}:`, error.message);
        }
      })
      .on('end', () => {
        console.log(`Finished parsing ${metric}: ${dataMap.size} data points (${rowCount} rows)`);
        resolve(dataMap);
      })
      .on('error', (error) => {
        console.error(`CSV parsing error for ${metric}:`, error);
        reject(error);
      });
  });
}
