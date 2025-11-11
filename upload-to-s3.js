const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const fs = require('fs');
const path = require('path');

const REGION = 'ap-south-1';
const STACK_NAME = 'EvStationLocatorStack';
const s3Client = new S3Client({ region: REGION });
const cfnClient = new CloudFormationClient({ region: REGION });

const DATASET_PATH = 'C:\\Users\\Admin\\Desktop\\Projects\\AWS projects\\EV Station Locator\\DataSet\\UrbanEVDataset\\20220901-20230228_zone-cleaned-aggregated';
const S3_PREFIX = 'urban-ev-data';

// Fetch bucket name from CloudFormation stack outputs
async function getBucketName() {
  try {
    const command = new DescribeStacksCommand({ StackName: STACK_NAME });
    const response = await cfnClient.send(command);
    const stack = response.Stacks[0];
    const bucketOutput = stack.Outputs.find(output => output.OutputKey === 'BucketName');
    
    if (!bucketOutput) {
      throw new Error('BucketName output not found in CloudFormation stack');
    }
    
    return bucketOutput.OutputValue;
  } catch (error) {
    console.error('Error fetching bucket name from CloudFormation:', error.message);
    console.error('\nMake sure the stack is deployed: cdk deploy');
    process.exit(1);
  }
}

const FILES_TO_UPLOAD = [
  'station_information.csv',
  'zone-information.csv',
  'charge_1hour/duration.csv',
  'charge_1hour/e_price.csv',
  'charge_1hour/occupancy.csv',
  'charge_1hour/s_price.csv',
  'charge_1hour/volume-11kw.csv',
];

async function uploadFile(relPath, bucketName) {
  const localPath = path.join(DATASET_PATH, relPath);
  const s3Key = `${S3_PREFIX}/${relPath}`;
  const fileContent = fs.readFileSync(localPath);
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: fileContent,
  }));
  const sizeKB = (fileContent.length / 1024).toFixed(2);
  console.log(` ${relPath} (${sizeKB} KB)`);
  return s3Key;
}

async function verifyFile(s3Key, bucketName) {
  const resp = await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
  return { key: s3Key, etag: resp.ETag, size: resp.ContentLength };
}

async function uploadManifest(uploadedKeys, bucketName) {
  console.log(`\nVerifying ${uploadedKeys.length} files...`);
  const metadata = [];
  for (const key of uploadedKeys) {
    const meta = await verifyFile(key, bucketName);
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
    Bucket: bucketName,
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
    console.log('Fetching bucket name from CloudFormation stack...\n');
    const bucketName = await getBucketName();
    console.log(`Using bucket: ${bucketName}\n`);
    
    console.log('Starting upload to S3...\n');
    console.log(`Uploading ${FILES_TO_UPLOAD.length} CSV files:\n`);
    const uploadedKeys = [];
    for (const file of FILES_TO_UPLOAD) {
      const s3Key = await uploadFile(file, bucketName);
      uploadedKeys.push(s3Key);
    }
    console.log(`\n All ${FILES_TO_UPLOAD.length} files uploaded successfully!`);
    await uploadManifest(uploadedKeys, bucketName);
    console.log('\n Upload process complete!');
  } catch (error) {
    console.error('\n Upload failed:', error.message);
    process.exit(1);
  }
}

main();
