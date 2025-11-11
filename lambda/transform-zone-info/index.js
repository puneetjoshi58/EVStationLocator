const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const csv = require('fast-csv');
const ngeohash = require('ngeohash');
const { writeToDynamoDB } = require('./shared/dynamodb-utils');

const s3Client = new S3Client({ region: process.env.AWS_REGION });

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  const bucketName = event.bucketName || process.env.BUCKET_NAME;
  const zoneInfoKey = 'urban-ev-data/zone-information.csv';
  const tableName = process.env.ZONE_INFO_TABLE_NAME;

  try {
    console.log(`Reading ${zoneInfoKey} from bucket ${bucketName}`);
    const zones = await readZoneInfoCsv(bucketName, zoneInfoKey);
    console.log(`Parsed ${zones.length} zones from CSV`);

    const results = await writeToDynamoDB(zones, tableName);

    return {
      statusCode: 200,
      success: true,
      message: 'Zone information transformed successfully',
      stats: {
        totalZones: zones.length,
        successfulWrites: results.successCount,
        failedWrites: results.failedCount,
        unprocessedItems: results.unprocessedItems.length
      },
      unprocessedItems: results.unprocessedItems
    };

  } catch (error) {
    console.error('Error transforming zone information:', error);
    return {
      statusCode: 500,
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
};

async function readZoneInfoCsv(bucketName, key) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  });

  const response = await s3Client.send(command);
  const zones = [];

  return new Promise((resolve, reject) => {
    const stream = response.Body;

    stream
      .pipe(csv.parse({ headers: true, trim: true, ignoreEmpty: true }))
      .on('data', (row) => {
        try {
          const tazid = parseInt(row.TAZID);
          const latitude = parseFloat(row.latitude);
          const longitude = parseFloat(row.longitude);
          const chargeCount = parseInt(row.charge_count);
          const area = parseFloat(row.area);
          const perimeter = parseFloat(row.perimeter);

          if (isNaN(tazid) || isNaN(latitude) || isNaN(longitude) || isNaN(chargeCount)) {
            console.warn(`Skipping invalid zone row: ${JSON.stringify(row)}`);
            return;
          }

          // Generate 7-character geohash for proximity queries
          const geohash = ngeohash.encode(latitude, longitude, 7);

          zones.push({
            ZoneId: `ZONE#${tazid}`,
            TAZID: tazid,
            Latitude: latitude,
            Longitude: longitude,
            ChargeCount: chargeCount,
            Area: area,
            Perimeter: perimeter,
            Geohash: geohash
          });

        } catch (error) {
          console.warn(`Error parsing zone row: ${JSON.stringify(row)}`, error.message);
        }
      })
      .on('end', () => {
        console.log(`Successfully parsed ${zones.length} zones`);
        resolve(zones);
      })
      .on('error', (error) => {
        console.error('CSV parsing error:', error);
        reject(error);
      });
  });
}
