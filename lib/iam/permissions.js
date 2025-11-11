function grantValidationLambdaPermissions(validateCsvFn, evStationBucket) {

  evStationBucket.grantRead(validateCsvFn);
}

function grantManifestTriggerPermissions(manifestTriggerFn, evStationBucket, ingestStateMachine) {

  evStationBucket.grantRead(manifestTriggerFn);
  ingestStateMachine.grantStartExecution(manifestTriggerFn);
}

function grantStationInfoTransformPermissions(transformStationInfoFn, evStationBucket, stationInfoTable) {

  evStationBucket.grantRead(transformStationInfoFn);
  stationInfoTable.grantWriteData(transformStationInfoFn);
}

function grantStationDataTransformPermissions(transformStationDataFn, evStationBucket, stationDataTable) {

  evStationBucket.grantRead(transformStationDataFn);
  stationDataTable.grantWriteData(transformStationDataFn);
}

module.exports = {
  grantValidationLambdaPermissions,
  grantManifestTriggerPermissions,
  grantStationInfoTransformPermissions,
  grantStationDataTransformPermissions
};
