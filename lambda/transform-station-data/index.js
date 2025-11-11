const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const csv = require('fast-csv');
const { writeToDynamoDB } = require('./shared/dynamodb-utils');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  const bucketName = event.bucketName || process.env.BUCKET_NAME;
  const metric = event.metric;
  const csvKey = `urban-ev-data/charge_1hour/${metric}.csv`;
  const tableName = process.env.STATION_DATA_TABLE_NAME;

  try {

    console.log(`Reading ${csvKey} from bucket ${bucketName}`);
    const dataPoints = await readChargeCsv(bucketName, csvKey, metric);
    console.log(`Parsed ${dataPoints.length} zone-level data points from CSV for metric: ${metric}`);

    const results = await writeToDynamoDB(dataPoints, tableName);
    const isSuccess = results.successCount > 0;

    return {
      statusCode: isSuccess ? 200 : 500,
      success: isSuccess,
      metric: metric,
      message: isSuccess 
        ? `Metric ${metric} transformed with ${results.failedCount > 0 ? 'partial' : 'complete'} success`
        : `Failed to transform metric ${metric}`,
      stats: {
        totalDataPoints: dataPoints.length,
        successfulWrites: results.successCount,
        failedWrites: results.failedCount,
        unprocessedItems: results.unprocessedItems.length
      },
      unprocessedItems: results.unprocessedItems
    };

  } catch (error) {
    console.error(`Error transforming metric ${metric}:`, error);
    
    // Continue processing other metrics even if this one fails
    return {
      statusCode: 500,
      success: false,
      metric: metric,
      error: error.message,
      stack: error.stack,
      stats: {
        totalDataPoints: 0,
        successfulWrites: 0,
        failedWrites: 0,
        unprocessedItems: 0
      }
    };
  }
};

async function readChargeCsv(bucketName, key, metric) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  });

  const response = await s3Client.send(command);
  const dataPoints = [];
  
  // Limit processing to avoid timeout and stay within Free Tier write capacity
  // With 5 WCU for Station_Data, we can write ~5 items/second
  // 10 rows × 275 zones = 2,750 items per metric
  // At 5 WCU: ~550 seconds (~9 minutes) - well within 15-minute Lambda timeout
  const MAX_ROWS = 10;
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
            // First row contains headers: ['time', '102', '104', '105', ...]
            headers = row.map(h => h.trim().toLowerCase());
            isFirstRow = false;
            console.log(`Headers found: ${headers.length} columns (${headers.slice(0, 3).join(', ')}...)`);
            return;
          }

          // Stop processing after MAX_ROWS to prevent timeout
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
            if (isNaN(tazid)) {
              console.warn(`Could not parse TAZID from header: ${header}`);
              continue;
            }

            dataPoints.push({
              ZoneId: `ZONE#${tazid}`,
              Timestamp: timestamp,
              TAZID: tazid,
              [metric]: value  // Store metric as attribute name
            });
          }

        } catch (error) {
          console.warn(`Skipping invalid row: ${JSON.stringify(row)}`, error.message);
        }
      })
      .on('end', () => {
        console.log(`Finished parsing ${dataPoints.length} zone-level data points for metric ${metric} (processed ${rowCount} rows)`);
        resolve(dataPoints);
      })
      .on('error', (error) => {
        console.error('CSV parsing error:', error);
        reject(error);
      });
  });
}
