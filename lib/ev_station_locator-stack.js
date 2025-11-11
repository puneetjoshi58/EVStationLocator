const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const lambda = require('aws-cdk-lib/aws-lambda');
const StepFunction = require('aws-cdk-lib/aws-stepfunctions');
const s3n = require('aws-cdk-lib/aws-s3-notifications');
const path = require('path');
const { IngestionStepFunction } = require('./workflows/DataIngestionStepFunction');
const { 
  grantValidationLambdaPermissions,
  grantManifestTriggerPermissions,
  grantStationInfoTransformPermissions,
  grantStationDataTransformPermissions
} = require('./iam/permissions');

class EvStationLocatorStack extends Stack {

  constructor(scope, id, props) {
    super(scope, id, props);

    const evStationBucket = new s3.Bucket(this, 'EvStationBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Query Patterns:
    // 1. Get zone by TAZID: Query by ZoneId (ZONE#102)
    // 2. Find nearby zones: Query GeohashIndex (proximity search for zone centroids)
    const zoneInfoTable = new dynamodb.Table(this, 'ZoneInformation', {
      tableName: 'Zone_Information',
      partitionKey: {
        name: 'ZoneId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 3,
      writeCapacity: 3,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    zoneInfoTable.addGlobalSecondaryIndex({
      indexName: 'GeohashIndex',
      partitionKey: {
        name: 'Geohash',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 3,
      writeCapacity: 3,
    });

    // Query Patterns:
    // 1. Get station by ID: Query by Station_Id (PK)
    // 2. Find nearby stations: Query GeohashIndex (proximity search)
    // 3. Get all stations in a zone: Query TazidIndex (zone-level aggregation)
    const stationInfoTable = new dynamodb.Table(this, 'StationInformation', {
      tableName: 'Station_Information',
      partitionKey: {
        name: 'Station_Id',
        type: dynamodb.AttributeType.NUMBER
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 3,
      writeCapacity: 3,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    stationInfoTable.addGlobalSecondaryIndex({
      indexName: 'GeohashIndex',
      partitionKey: {
        name: 'Geohash',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 3,
      writeCapacity: 3,
    });

    stationInfoTable.addGlobalSecondaryIndex({
      indexName: 'TazidIndex',
      partitionKey: {
        name: 'TAZID',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 3,
      writeCapacity: 3,
    });

    const stationDataTable = new dynamodb.Table(this, 'StationData', {
      tableName: 'Station_Data',
      partitionKey: {
        name: 'ZoneId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'Timestamp',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 3,
      writeCapacity: 5,
      removalPolicy: RemovalPolicy.DESTROY,
    });


    const ValidateCsvLambda = new lambda.Function(this, 'ValidateCsvFn', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/validate-csv')),
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: evStationBucket.bucketName
      }
    });

    grantValidationLambdaPermissions(ValidateCsvLambda, evStationBucket);

    const transformZoneInfoLambda = new lambda.Function(this, 'TransformZoneInfoFn', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/transform-zone-info')),
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: evStationBucket.bucketName,
        ZONE_INFO_TABLE_NAME: zoneInfoTable.tableName
      }
    });

    evStationBucket.grantRead(transformZoneInfoLambda);
    zoneInfoTable.grantWriteData(transformZoneInfoLambda);
    

    const transformStationInfoLambda = new lambda.Function(this, 'TransformStationInfoFn', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/transform-station-info')),
      timeout: Duration.minutes(10),
      memorySize: 2048,
      environment: {
        BUCKET_NAME: evStationBucket.bucketName,
        STATION_INFO_TABLE_NAME: stationInfoTable.tableName
      }
    });

    grantStationInfoTransformPermissions(transformStationInfoLambda, evStationBucket, stationInfoTable);

    // Combined Lambda that processes all metrics and merges e_price + s_price into total_price
    const transformStationDataLambda = new lambda.Function(this, 'TransformStationDataFn', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/transform-station-data')),
      timeout: Duration.minutes(15),
      memorySize: 3008,
      environment: {
        BUCKET_NAME: evStationBucket.bucketName,
        STATION_DATA_TABLE_NAME: stationDataTable.tableName
      }
    });

    grantStationDataTransformPermissions(transformStationDataLambda, evStationBucket, stationDataTable);

    const ingestDefinition = IngestionStepFunction(
      this, 
      ValidateCsvLambda, 
      transformZoneInfoLambda, 
      transformStationInfoLambda, 
      transformStationDataLambda
    );
    
    const ingestionStateMachine = new StepFunction.StateMachine(this, 'CsvIngestStateMachine', {
      definitionBody: StepFunction.DefinitionBody.fromChainable(ingestDefinition),
      timeout: Duration.minutes(30),
      comment: 'ETL Pipeline for EV Station Locator CSV data from S3 to DynamoDB'
    });

    const manifestTriggerFn = new lambda.Function(this, 'ManifestTriggerFn', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/trigger-stepfunction')),
      timeout: Duration.minutes(1),
      environment: {
        STATE_MACHINE_ARN: ingestionStateMachine.stateMachineArn,
        BUCKET_NAME: evStationBucket.bucketName
      }
    });

    grantManifestTriggerPermissions(manifestTriggerFn, evStationBucket, ingestionStateMachine);

    evStationBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(manifestTriggerFn),
      { prefix: 'urban-ev-data/', suffix: '_manifest.json' }
    );

    new CfnOutput(this, 'BucketName', {
      value: evStationBucket.bucketName,
      description: 'S3 Bucket for EV station data'
    });

    new CfnOutput(this, 'StateMachineArn', {
      value: ingestionStateMachine.stateMachineArn,
      description: 'Step Functions State Machine ARN for CSV ingestion'
    });

    new CfnOutput(this, 'ValidationLambdaArn', {
      value: ValidateCsvLambda.functionArn,
      description: 'Validation Lambda Function ARN'
    });

    new CfnOutput(this, 'TransformZoneInfoLambdaArn', {
      value: transformZoneInfoLambda.functionArn,
      description: 'Transform Zone Info Lambda Function ARN'
    });

    new CfnOutput(this, 'TransformStationInfoLambdaArn', {
      value: transformStationInfoLambda.functionArn,
      description: 'Transform Station Info Lambda Function ARN'
    });

    new CfnOutput(this, 'TransformStationDataLambdaArn', {
      value: transformStationDataLambda.functionArn,
      description: 'Transform Station Data Lambda Function ARN'
    });

  }
}

module.exports = { EvStationLocatorStack }
