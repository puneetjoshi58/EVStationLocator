const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const s3Client = new S3Client({ region: 'ap-south-1' }); 
const BUCKET_NAME = 'evstationlocatorstack-evstationbucketcd730d2e-mlyquswkwdoa';
const DATASET_PATH = 'C:\\Users\\Admin\\Desktop\\Projects\\AWS projects\\EV Station Locator\\DataSet\\UrbanEVDataset\\20220901-20230228_zone-cleaned-aggregated';
const S3_PREFIX = 'urban-ev-data';

const FILES_TO_UPLOAD = [
  'adj.csv',
  'distance.csv',
  'station_information.csv',
  'zone-information.csv',
  'charge_1hour/duration.csv',
  'charge_1hour/e_price.csv',
  'charge_1hour/occupancy.csv',
  'charge_1hour/s_price.csv',
  'charge_1hour/volume-11kw.csv',
  'charge_1hour/volume.csv',
  'charge_5min/duration.csv',
  'charge_5min/e_price.csv',
  'charge_5min/occupancy.csv',
  'charge_5min/s_price.csv',
  'charge_5min/volume-11kw.csv',
  'charge_5min/volume.csv'
];

async function uploadFile(relPath) {
  const localPath = path.join(DATASET_PATH, relPath);
  const s3Key = `${S3_PREFIX}/${relPath}`;
  const fileContent = fs.readFileSync(localPath);
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: fileContent,
  }));
  const sizeKB = (fileContent.length / 1024).toFixed(2);
  console.log(` ${relPath} (${sizeKB} KB)`);
  return s3Key;
}

async function verifyFile(s3Key) {
  const resp = await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }));
  return { key: s3Key, etag: resp.ETag, size: resp.ContentLength };
}

async function uploadManifest(uploadedKeys) {
  console.log(`\nVerifying ${uploadedKeys.length} files...`);
  const metadata = [];
  for (const key of uploadedKeys) {
    const meta = await verifyFile(key);
    metadata.push(meta);
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    files: metadata.map(m => m.key),
    counts: {
      totalFiles: metadata.length,
      totalSizeBytes: metadata.reduce((sum, m) => sum + m.size, 0)
    },
    metadata
  };
  const manifestKey = `${S3_PREFIX}/_manifest.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: manifestKey,
    Body: Buffer.from(JSON.stringify(manifest, null, 2)),
    ContentType: 'application/json'
  }));
  console.log(` All ${metadata.length} files verified!`);
  console.log(`\n Manifest uploaded: ${manifestKey}`);
  console.log(`  - Total size: ${(manifest.counts.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('\n Step Function will be triggered automatically');
}

async function main() {
  try {
    console.log('Starting upload to S3...\n');
    console.log(`Uploading ${FILES_TO_UPLOAD.length} CSV files:\n`);
    const uploadedKeys = [];
    for (const file of FILES_TO_UPLOAD) {
      const s3Key = await uploadFile(file);
      uploadedKeys.push(s3Key);
    }
    console.log(`\n All ${FILES_TO_UPLOAD.length} files uploaded successfully!`);
    await uploadManifest(uploadedKeys);
    console.log('\n Upload process complete!');
  } catch (error) {
    console.error('\n Upload failed:', error.message);
    process.exit(1);
  }
}

main();
