const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const s3 = new S3Client();
const sfn = new SFNClient();

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const BUCKET = process.env.BUCKET_NAME;

exports.handler = async (event) => {
  console.log('Received S3 event:', JSON.stringify(event, null, 2));
  
  for (const record of event.Records || []) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (!key.endsWith('_manifest.json')) {
      console.log(`Skipping non-manifest file: ${key}`);
      continue;
    }
    
    console.log(`Processing manifest: ${key}`);
    
    try {
      const obj = await s3.send(new GetObjectCommand({ 
        Bucket: BUCKET, 
        Key: key 
      }));
      
      const manifestData = await streamToString(obj.Body);
      const manifest = JSON.parse(manifestData);
      
      console.log(`Manifest contains ${manifest.counts.totalFiles} files`);
      
      const execName = `manifest-${Date.now()}`;
      const input = {
        bucket: BUCKET,
        manifestKey: key,
        files: manifest.files,
        counts: manifest.counts,
        createdAt: manifest.createdAt,
        metadata: manifest.metadata,

        metrics: [
          'duration',
          'e_price',
          's_price',
          'occupancy',
          'volume-11kw'
        ]
      };
      
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: execName,
        input: JSON.stringify(input)
      }));
      
      console.log(` Started Step Functions execution: ${execName}`);
      
    } catch (error) {
      console.error(` Error processing manifest ${key}:`, error);
      throw error;
    }
  }
  
  return { 
    statusCode: 200, 
    body: 'Manifest processed successfully' 
  };
};

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}
