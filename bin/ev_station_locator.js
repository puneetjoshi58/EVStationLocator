#!/usr/bin/env node

const cdk = require('aws-cdk-lib/core');
const { EvStationLocatorStack } = require('../lib/ev_station_locator-stack');

const app = new cdk.App();
new EvStationLocatorStack(app, 'EvStationLocatorStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

});
