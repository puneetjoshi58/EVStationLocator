const sfn = require('aws-cdk-lib/aws-stepfunctions');
const tasks = require('aws-cdk-lib/aws-stepfunctions-tasks');

/**
 * Create CSV Ingestion Workflow
 * 
 * Workflow:
 * 1. Validate CSV files (schema + data quality)
 * 2. If valid → Parallel transformation:
 *    a. Transform zone-information.csv → Zone_Information table
 *    b. Transform station_information.csv → Station_Information table
 *    c. Transform charge_1hour CSV files (Map over 4 metrics) → Station_Data table (zone-level)
 * 3. Evaluate transformation results
 * 4. If all transformations successful → TransformationComplete (Success)
 *    If any transformation failed → TransformationFailed (Fail)
 * 
 * Error Handling:
 * - Validation failures: Immediate fail (ValidationFailed)
 * - Transformation failures: Evaluated after parallel execution (TransformationFailed)
 * - Partial failures in charge metrics: Reported but evaluated per Lambda's success flag
 */
function createCsvIngestWorkflow(scope, validateCsvFn, transformZoneInfoFn, transformStationInfoFn, transformStationDataFn) {
  
  // Step 1: Validate all CSV files
  const validateTask = new tasks.LambdaInvoke(scope, 'ValidateCSVFiles', {
    lambdaFunction: validateCsvFn,
    comment: 'Validate schema and data quality of all CSV files',
    payload: sfn.TaskInput.fromObject({
      'bucket.$': '$.bucket',
      'files.$': '$.files'
    }),
    resultPath: '$.validationResult',
    outputPath: '$'
  });

  // Step 2a: Transform Zone Information
  const transformZoneInfo = new tasks.LambdaInvoke(scope, 'TransformZoneInfo', {
    lambdaFunction: transformZoneInfoFn,
    comment: 'Transform zone-information.csv and calculate zone centroids',
    payload: sfn.TaskInput.fromObject({
      'bucketName.$': '$.bucket'
    }),
    resultPath: '$.zoneInfoResult',
    outputPath: '$'
  });

  // Step 2b: Transform Station Information
  const transformStationInfo = new tasks.LambdaInvoke(scope, 'TransformStationInfo', {
    lambdaFunction: transformStationInfoFn,
    comment: 'Transform station_information.csv and calculate geohash',
    payload: sfn.TaskInput.fromObject({
      'bucketName.$': '$.bucket'
    }),
    resultPath: '$.stationInfoResult',
    outputPath: '$'
  });

  // Step 2b: Transform Station Data (Map over 4 charge metrics in parallel)
  const transformStationDataTask = new tasks.LambdaInvoke(scope, 'TransformStationData', {
    lambdaFunction: transformStationDataFn,
    comment: 'Transform charge_1hour CSV to Station_Data table (zone-level storage)',
    payload: sfn.TaskInput.fromJsonPathAt('$'),
    resultPath: '$.transformResult'
  });

  const transformStationData = new sfn.Map(scope, 'TransformChargeMetrics', {
    comment: 'Transform 4 charge_1hour CSV files in parallel (zone-level)',
    maxConcurrency: 4, // Process all 4 metrics concurrently
    itemsPath: '$.metrics',
    itemSelector: {
      'bucketName.$': '$.bucket',
      'metric.$': '$$.Map.Item.Value'
    },
    resultPath: '$.chargeMetricsResults'
  });

  // Call itemProcessor method to define the iterator logic
  transformStationData.itemProcessor(transformStationDataTask);

  // Step 2: Parallel execution of zone info + station info + charge metrics
  const parallelTransform = new sfn.Parallel(scope, 'TransformInParallel', {
    comment: 'Transform zone information, station information, and charge metrics in parallel',
    resultPath: '$.transformResults'
  });

  parallelTransform.branch(transformZoneInfo);
  parallelTransform.branch(transformStationInfo);
  parallelTransform.branch(transformStationData);

  // Step 3: Evaluate transformation results
  const evaluateResults = new sfn.Pass(scope, 'EvaluateTransformationResults', {
    comment: 'Process transformation results and check for success',
    parameters: {
      'bucket.$': '$.bucket',
      'validationResult.$': '$.validationResult',
      'transformResults.$': '$.transformResults',
      // Extract success status from all three branches
      'zoneInfoSuccess.$': '$.transformResults[0].Payload.success',
      'stationInfoSuccess.$': '$.transformResults[1].Payload.success',
      'chargeMetricsResults.$': '$.transformResults[2]',
      'timestamp.$': '$$.Execution.StartTime'
    },
    resultPath: '$.evaluationResult'
  });

  // Choice: Check if all transformations succeeded
  const checkTransformationSuccess = new sfn.Choice(scope, 'AllTransformationsSuccessful?')
    .when(
      // Check if both zone info and station info transformations succeeded
      sfn.Condition.and(
        sfn.Condition.booleanEquals('$.evaluationResult.zoneInfoSuccess', true),
        sfn.Condition.booleanEquals('$.evaluationResult.stationInfoSuccess', true)
      ),
      new sfn.Succeed(scope, 'TransformationComplete', {
        comment: 'CSV data successfully transformed and loaded into DynamoDB'
      })
    )
    .otherwise(
      new sfn.Fail(scope, 'TransformationFailed', {
        comment: 'One or more transformations failed - check Lambda execution logs',
        error: 'TransformationError',
        cause: 'Failed to transform CSV data into DynamoDB tables'
      })
    );

  // Validation failed state
  const validationFailed = new sfn.Fail(scope, 'ValidationFailed', {
    comment: 'CSV validation failed - check errors in execution output',
    error: 'ValidationError',
    cause: 'One or more CSV files failed validation checks'
  });

  // Choice: Route based on validation result
  const isValid = new sfn.Choice(scope, 'IsValidationSuccessful?')
    .when(
      sfn.Condition.booleanEquals('$.validationResult.Payload.isValid', true),
      parallelTransform
        .next(evaluateResults)
        .next(checkTransformationSuccess)
    )
    .otherwise(validationFailed);

  // Define workflow chain
  return validateTask.next(isValid);
}

module.exports = { createCsvIngestWorkflow };

