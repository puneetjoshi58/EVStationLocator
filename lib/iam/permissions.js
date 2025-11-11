function grantValidationLambdaPermissions(validateCsvFn, evStationBucket) {

  evStationBucket.grantRead(validateCsvFn);

  console.log('[IAM] Granted S3 read permissions to Validation Lambda');
}

function grantManifestTriggerPermissions(manifestTriggerFn, evStationBucket, ingestStateMachine) {

  evStationBucket.grantRead(manifestTriggerFn);
  ingestStateMachine.grantStartExecution(manifestTriggerFn);
  
  console.log('[IAM] Granted S3 read and Step Functions start permissions to Manifest Trigger Lambda');
}

function grantStationInfoTransformPermissions(transformStationInfoFn, evStationBucket, stationInfoTable) {

  evStationBucket.grantRead(transformStationInfoFn);
  stationInfoTable.grantWriteData(transformStationInfoFn);
  
  console.log('[IAM] Granted S3 read and Station_Information write permissions to TransformStationInfo Lambda');
}

function grantStationDataTransformPermissions(transformStationDataFn, evStationBucket, stationDataTable) {

  evStationBucket.grantRead(transformStationDataFn);
  stationDataTable.grantWriteData(transformStationDataFn);

  console.log('[IAM] Granted S3 read and Station_Data write permissions to TransformStationData Lambda');
}

function grantStateMachinePermissions(ingestStateMachine, validateCsvFn) {
  
  console.log('[IAM] Step Functions Lambda invoke permissions handled automatically by CDK');
}

module.exports = {
  grantValidationLambdaPermissions,
  grantManifestTriggerPermissions,
  grantStationInfoTransformPermissions,
  grantStationDataTransformPermissions,
  grantStateMachinePermissions
};
