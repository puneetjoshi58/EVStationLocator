const StepFunction = require('aws-cdk-lib/aws-stepfunctions');
const tasks = require('aws-cdk-lib/aws-stepfunctions-tasks');

/**
 * Create CSV Ingestion Workflow
 * 
 * Workflow:
 * 1. Validate CSV files (schema + data quality)
 * 2. If valid → Parallel transformation:
 *    a. Transform zone-information.csv → Zone_Information table
 *    b. Transform station_information.csv → Station_Information table
 *    c. Transform charge_1hour CSV files (all metrics combined) → Station_Data table (zone-level)
 *       - Merges e_price + s_price into total_price
 *       - Results in 4 metrics: duration, total_price, occupancy, volume_11kw
 * 3. Evaluate transformation results
 * 4. If all transformations successful → TransformationComplete (Success)
 *    If any transformation failed → TransformationFailed (Fail)
 * 
 * Error Handling:
 * - Validation failures: Immediate fail (ValidationFailed)
 * - Transformation failures: Evaluated after parallel execution (TransformationFailed)
 */
function IngestionStepFunction(scope, ValidateCsvLambda, transformZoneInfoLambda, transformStationInfoLambda, transformStationDataLambda) {
  
  // Step 1: Validate all CSV files
  const validateTask = new tasks.LambdaInvoke(scope, 'ValidateCSVFiles', {
    lambdaFunction: ValidateCsvLambda,
    comment: 'Validate schema and data quality of all CSV files',
    payload: StepFunction.TaskInput.fromObject({
      'bucket.$': '$.bucket',
      'files.$': '$.files'
    }),
    resultPath: '$.validationResult',
    outputPath: '$'
  });

  // Step 2a: Transform Zone Information
  const transformZoneInfo = new tasks.LambdaInvoke(scope, 'TransformZoneInfo', {
    lambdaFunction: transformZoneInfoLambda,
    comment: 'Transform zone-information.csv and calculate zone centroids',
    payload: StepFunction.TaskInput.fromObject({
      'bucketName.$': '$.bucket'
    }),
    resultPath: '$.zoneInfoResult',
    outputPath: '$'
  });

  // Step 2b: Transform Station Information
  const transformStationInfo = new tasks.LambdaInvoke(scope, 'TransformStationInfo', {
    lambdaFunction: transformStationInfoLambda,
    comment: 'Transform station_information.csv and calculate geohash',
    payload: StepFunction.TaskInput.fromObject({
      'bucketName.$': '$.bucket'
    }),
    resultPath: '$.stationInfoResult',
    outputPath: '$'
  });

  // Step 2c: Transform Station Data (reads all 5 metrics, merges e_price + s_price into total_price)
  const transformStationData = new tasks.LambdaInvoke(scope, 'TransformStationData', {
    lambdaFunction: transformStationDataLambda,
    comment: 'Transform all charge_1hour CSVs to Station_Data table (4 metrics: duration, total_price, occupancy, volume_11kw)',
    payload: StepFunction.TaskInput.fromObject({
      'bucketName.$': '$.bucket'
    }),
    resultPath: '$.stationDataResult',
    outputPath: '$'
  });

  // Step 2: Parallel execution of zone info + station info + charge metrics
  const parallelTransform = new StepFunction.Parallel(scope, 'TransformInParallel', {
    comment: 'Transform zone information, station information, and charge metrics in parallel',
    resultPath: '$.transformResults'
  });

  parallelTransform.branch(transformZoneInfo);
  parallelTransform.branch(transformStationInfo);
  parallelTransform.branch(transformStationData);

  // Step 3: Evaluate transformation results
  const evaluateResults = new StepFunction.Pass(scope, 'EvaluateTransformationResults', {
    comment: 'Process transformation results and check for success',
    parameters: {
      'bucket.$': '$.bucket',
      'validationResult.$': '$.validationResult',
      'transformResults.$': '$.transformResults',
      // Extract success status from all three branches
      'zoneInfoSuccess.$': '$.transformResults[0].Payload.success',
      'stationInfoSuccess.$': '$.transformResults[1].Payload.success',
      'stationDataSuccess.$': '$.transformResults[2].Payload.success',
      'timestamp.$': '$$.Execution.StartTime'
    },
    resultPath: '$.evaluationResult'
  });

  // Choice: Check if all transformations succeeded
  const checkTransformationSuccess = new StepFunction.Choice(scope, 'AllTransformationsSuccessful?')
    .when(
      // Check if all three transformations succeeded
      StepFunction.Condition.and(
        StepFunction.Condition.booleanEquals('$.evaluationResult.zoneInfoSuccess', true),
        StepFunction.Condition.booleanEquals('$.evaluationResult.stationInfoSuccess', true),
        StepFunction.Condition.booleanEquals('$.evaluationResult.stationDataSuccess', true)
      ),
      new StepFunction.Succeed(scope, 'TransformationComplete', {
        comment: 'CSV data successfully transformed and loaded into DynamoDB'
      })
    )
    .otherwise(
      new StepFunction.Fail(scope, 'TransformationFailed', {
        comment: 'One or more transformations failed - check Lambda execution logs',
        error: 'TransformationError',
        cause: 'Failed to transform CSV data into DynamoDB tables'
      })
    );

  // Validation failed state
  const validationFailed = new StepFunction.Fail(scope, 'ValidationFailed', {
    comment: 'CSV validation failed - check errors in execution output',
    error: 'ValidationError',
    cause: 'One or more CSV files failed validation checks'
  });

  // Choice: Route based on validation result
  const isValid = new StepFunction.Choice(scope, 'IsValidationSuccessful?')
    .when(
      StepFunction.Condition.booleanEquals('$.validationResult.Payload.isValid', true),
      parallelTransform
        .next(evaluateResults)
        .next(checkTransformationSuccess)
    )
    .otherwise(validationFailed);

  // Define workflow chain
  return validateTask.next(isValid);
}

module.exports = { IngestionStepFunction };

