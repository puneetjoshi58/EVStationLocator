const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const csv = require('fast-csv');
const ngeohash = require('ngeohash');
const { writeToDynamoDB } = require('./shared/dynamodb-utils');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  const bucketName = event.bucketName || process.env.BUCKET_NAME;
  const stationInfoKey = 'urban-ev-data/station_information.csv';
  const tableName = process.env.STATION_INFO_TABLE_NAME;

  try {
    console.log(`Reading ${stationInfoKey} from bucket ${bucketName}`);
    const stations = await readStationInfoCsv(bucketName, stationInfoKey);
    console.log(`Parsed ${stations.length} stations from CSV`);

    const results = await writeToDynamoDB(stations, tableName);

    return {
      statusCode: 200,
      success: true,
      message: 'Station information transformed successfully',
      stats: {
        totalStations: stations.length,
        successfulWrites: results.successCount,
        failedWrites: results.failedCount,
        unprocessedItems: results.unprocessedItems.length
      },
      unprocessedItems: results.unprocessedItems
    };

  } catch (error) {
    console.error('Error transforming station information:', error);
    return {
      statusCode: 500,
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
};

async function readStationInfoCsv(bucketName, key) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  });

  const response = await s3Client.send(command);
  const stations = [];

  return new Promise((resolve, reject) => {
    const stream = response.Body;

    
    stream
      .pipe(csv.parse({ headers: true, trim: true, ignoreEmpty: true }))
      .on('data', (row) => { //Callback till there is 'data' match headers to columns to get data for each row till 'end' or 'error' 
        try {
          const stationId = parseInt(row.station_id);
          const latitude = parseFloat(row.latitude);
          const longitude = parseFloat(row.longitude);
          const slowCount = parseInt(row.slow_count) || 0;
          const fastCount = parseInt(row.fast_count) || 0;
          const tazid = parseInt(row.TAZID);

          const geohash = ngeohash.encode(latitude, longitude, 7);

          stations.push({
            Station_Id: stationId,
            Latitude: latitude,
            Longitude: longitude,
            SlowCount: slowCount,
            FastCount: fastCount,
            TotalChargers: slowCount + fastCount,
            TAZID: tazid,
            Geohash: geohash
          });
        } catch (error) {
          console.warn(`Skipping invalid row: ${JSON.stringify(row)}`, error.message);
        }
      })
      .on('end', () => {
        console.log(`Finished parsing ${stations.length} stations`);
        resolve(stations);
      })
      .on('error', (error) => {
        console.error('Error parsing CSV:', error);
        reject(error);
      });
  });
}
