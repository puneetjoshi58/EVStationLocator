/**
 * CSV Validation Lambda Function
 * 
 * This function validates 7 CSV files from S3:
 * 1. station_information.csv - Master station data (1,682 stations across 275 zones)
 * 2-7. charge_1hour/*.csv - Zone-level time-series charging data (6 files)
 * 
 * Data Model:
 * - station_information.csv has station_id + TAZID (Traffic Analysis Zone ID)
 * - charge_1hour files have TAZID columns (NOT station_id)
 * - Multiple stations can belong to one TAZID
 * - Example: TAZID 558 contains stations [1002, 1003]
 * 
 * Validation performed:
 * - Schema validation: Correct columns exist
 * - Data type validation: Numbers are numeric, dates are valid
 * - Range validation: Latitude/longitude within Hong Kong/Shenzhen bounds
 * - Cross-file consistency: TAZIDs in charge files match station_information
 * - Completeness: No critical missing values
 * 
 * Returns detailed validation report for Step Functions to decide next steps
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parse } = require('fast-csv');

const s3Client = new S3Client();

// Define expected schemas for each file type
const SCHEMAS = {
  station_information: {
    requiredColumns: ['station_id', 'longitude', 'latitude', 'slow_count', 'fast_count', 'charge_count', 'TAZID'],
  },
  charge_1hour: {
    requiredColumns: ['time'], // Plus dynamic TAZID columns
    files: ['duration.csv', 'e_price.csv', 'occupancy.csv', 's_price.csv', 'volume-11kw.csv', 'volume.csv']
  }
};

// Hong Kong and Shenzhen coordinate bounds
const GEO_BOUNDS = {
  lat: { min: 22.0, max: 23.0 },  // Approximate latitude range
  lon: { min: 113.0, max: 115.0 }  // Approximate longitude range
};

/**
 * Main Lambda handler
 * Receives manifest data from Step Functions execution input
 */
exports.handler = async (event) => { 
  console.log('Starting CSV validation', JSON.stringify(event, null, 2));
  
  try {
    // Extract bucket and file list from manifest
    const { bucket, files } = event;
    
    if (!bucket || !files || !Array.isArray(files)) {
      throw new Error('Invalid input: Expected bucket name and files array from manifest');
    }
    
    // Validation results accumulator
    const validationResults = {
      isValid: true,
      errors: [],
      warnings: [],
      summary: {
        totalFiles: files.length,
        validatedFiles: 0,
        stationIds: new Set(), // Track unique station IDs
        tazids: new Set(), // Track unique TAZIDs from charge files
        tazidToStations: new Map(), // Map TAZID -> [station_ids]
        timeRange: { earliest: null, latest: null }
      }
    };
    
    // Step 1: Validate station_information.csv first (master data)
    console.log('Step 1: Validating station_information.csv');
    const stationFile = files.find(f => f.endsWith('station_information.csv'));
    
    if (!stationFile) {
      validationResults.isValid = false;
      validationResults.errors.push({
        file: 'station_information.csv',
        error: 'Required file not found in manifest'
      });
      return buildResponse(validationResults);
    }
    
    const stationValidation = await validateStationInformation(bucket, stationFile);
    mergeValidationResults(validationResults, stationValidation, 'station_information.csv');
    
    // If station_information fails critical validation, stop here
    if (!stationValidation.isValid) {
      validationResults.isValid = false;
      return buildResponse(validationResults);
    }
    
    // Store TAZID mapping from master file for cross-validation
    const tazidToStations = stationValidation.tazidToStations;
    const masterTazids = new Set(tazidToStations.keys());
    console.log(`Found ${stationValidation.stationIds.size} stations across ${masterTazids.size} TAZIDs`);
    validationResults.summary.tazidToStations = tazidToStations;
    
    // Step 2: Validate all charge_1hour files
    console.log('Step 2: Validating charge_1hour CSV files');
    const charge1hourFiles = files.filter(f => f.includes('charge_1hour/'));
    
    if (charge1hourFiles.length !== 6) {
      validationResults.warnings.push({
        message: `Expected 6 charge_1hour files, found ${charge1hourFiles.length}`,
        files: charge1hourFiles
      });
    }
    
    // Validate each charge_1hour file
    for (const file of charge1hourFiles) {
      const fileName = file.split('/').pop();
      console.log(`Validating ${fileName}`);
      
      const chargeValidation = await validateCharge1HourFile(
        bucket, 
        file, 
        fileName,
        masterTazids  // Pass TAZIDs, not station IDs
      );
      
      mergeValidationResults(validationResults, chargeValidation, fileName);
      
      // Update time range
      if (chargeValidation.timeRange) {
        updateTimeRange(validationResults.summary, chargeValidation.timeRange);
      }
    }
    
    // Step 3: Cross-file validation
    console.log('Step 3: Performing cross-file validation');
    performCrossFileValidation(validationResults, masterTazids);
    
    // Build final response
    return buildResponse(validationResults);
    
  } catch (error) {
    console.error('Validation failed with exception:', error);
    return {
      statusCode: 500,
      isValid: false,
      errors: [{
        error: 'Validation exception',
        message: error.message,
        stack: error.stack
      }]
    };
  }
};

/**
 * Validate station_information.csv
 * Checks schema, data types, geo bounds, uniqueness, and builds TAZID mapping
 */
async function validateStationInformation(bucket, key) {
  const result = {
    isValid: true,
    errors: [],
    warnings: [],
    stationIds: new Set(),
    tazidToStations: new Map(), // Map TAZID -> [station_ids]
    rowCount: 0
  };
  
  try {
    // Stream CSV from S3
    const stream = await getS3Stream(bucket, key);
    const rows = [];
    
    // Parse CSV and collect rows
    await new Promise((resolve, reject) => {
      stream
        .pipe(parse({ headers: true, trim: true }))
        .on('data', (row) => {
          rows.push(row);
        })
        .on('error', reject)
        .on('end', resolve);
    });
    
    console.log(`Parsed ${rows.length} rows from station_information.csv`);
    
    if (rows.length === 0) {
      result.isValid = false;
      result.errors.push({ error: 'File is empty' });
      return result;
    }
    
    // Validate schema (check first row for column names)
    const actualColumns = Object.keys(rows[0]);
    const missingColumns = SCHEMAS.station_information.requiredColumns.filter(
      col => !actualColumns.includes(col)
    );
    
    if (missingColumns.length > 0) {
      result.isValid = false;
      result.errors.push({
        error: 'Missing required columns',
        missing: missingColumns,
        found: actualColumns
      });
      return result;
    }
    
    // Validate each row
    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 because: +1 for header, +1 for 1-based indexing
      
      // Validate station_id (required, numeric)
      let stationId = null;
      if (!row.station_id || row.station_id.trim() === '') {
        result.errors.push({ row: rowNum, field: 'station_id', error: 'Missing station_id' });
        result.isValid = false;
      } else {
        stationId = parseInt(row.station_id);
        if (isNaN(stationId)) {
          result.errors.push({ row: rowNum, field: 'station_id', error: 'Invalid numeric value' });
          result.isValid = false;
        } else {
          // Check for duplicate station IDs
          if (result.stationIds.has(stationId)) {
            result.errors.push({ row: rowNum, field: 'station_id', error: `Duplicate station_id: ${stationId}` });
            result.isValid = false;
          } else {
            result.stationIds.add(stationId);
          }
        }
      }
      
      // Validate TAZID (required, numeric) and build mapping
      if (!row.TAZID || row.TAZID.trim() === '') {
        result.errors.push({ row: rowNum, field: 'TAZID', error: 'Missing TAZID' });
        result.isValid = false;
      } else {
        const tazid = parseInt(row.TAZID);
        if (isNaN(tazid)) {
          result.errors.push({ row: rowNum, field: 'TAZID', error: 'Invalid numeric value' });
          result.isValid = false;
        } else if (stationId !== null) {
          // Build TAZID -> [station_ids] mapping
          if (!result.tazidToStations.has(tazid)) {
            result.tazidToStations.set(tazid, []);
          }
          result.tazidToStations.get(tazid).push(stationId);
        }
      }
      
      // Validate latitude (required, numeric, within bounds)
      if (!row.latitude || row.latitude.trim() === '') {
        result.errors.push({ row: rowNum, field: 'latitude', error: 'Missing latitude' });
        result.isValid = false;
      } else {
        const lat = parseFloat(row.latitude);
        if (isNaN(lat)) {
          result.errors.push({ row: rowNum, field: 'latitude', error: 'Invalid numeric value' });
          result.isValid = false;
        } else if (lat < GEO_BOUNDS.lat.min || lat > GEO_BOUNDS.lat.max) {
          result.warnings.push({ 
            row: rowNum, 
            field: 'latitude', 
            warning: `Value ${lat} outside expected range [${GEO_BOUNDS.lat.min}, ${GEO_BOUNDS.lat.max}]` 
          });
        }
      }
      
      // Validate longitude (required, numeric, within bounds)
      if (!row.longitude || row.longitude.trim() === '') {
        result.errors.push({ row: rowNum, field: 'longitude', error: 'Missing longitude' });
        result.isValid = false;
      } else {
        const lon = parseFloat(row.longitude);
        if (isNaN(lon)) {
          result.errors.push({ row: rowNum, field: 'longitude', error: 'Invalid numeric value' });
          result.isValid = false;
        } else if (lon < GEO_BOUNDS.lon.min || lon > GEO_BOUNDS.lon.max) {
          result.warnings.push({ 
            row: rowNum, 
            field: 'longitude', 
            warning: `Value ${lon} outside expected range [${GEO_BOUNDS.lon.min}, ${GEO_BOUNDS.lon.max}]` 
          });
        }
      }
      
      // Validate count fields (required, numeric, non-negative)
      ['slow_count', 'fast_count', 'charge_count'].forEach(field => {
        if (!row[field] || row[field].trim() === '') {
          result.errors.push({ row: rowNum, field, error: `Missing ${field}` });
          result.isValid = false;
        } else {
          const value = parseInt(row[field]);
          if (isNaN(value)) {
            result.errors.push({ row: rowNum, field, error: 'Invalid numeric value' });
            result.isValid = false;
          } else if (value < 0) {
            result.errors.push({ row: rowNum, field, error: 'Negative count not allowed' });
            result.isValid = false;
          }
        }
      });
    });
    
    result.rowCount = rows.length;
    console.log(`Station information validation complete: ${result.stationIds.size} unique stations across ${result.tazidToStations.size} TAZIDs`);
    
  } catch (error) {
    console.error('Error validating station_information.csv:', error);
    result.isValid = false;
    result.errors.push({ error: 'Failed to parse file', message: error.message });
  }
  
  return result;
}

/**
 * Validate charge_1hour CSV files
 * Checks schema, timestamp format, TAZID consistency, and numeric values
 * Note: Column headers are TAZIDs, NOT station_ids
 */
async function validateCharge1HourFile(bucket, key, fileName, masterTazids) {
  const result = {
    isValid: true,
    errors: [],
    warnings: [],
    tazids: new Set(), // Track TAZIDs found in this file
    rowCount: 0,
    timeRange: { earliest: null, latest: null }
  };
  
  try {
    // Stream CSV from S3
    const stream = await getS3Stream(bucket, key);
    const rows = [];
    
    // Parse CSV - collect first 10 rows for validation (to avoid memory issues with large files)
    // We'll validate schema and sample data
    let rowCount = 0;
    const sampleSize = 100; // Validate first 100 rows thoroughly
    
    await new Promise((resolve, reject) => {
      stream
        .pipe(parse({ headers: true, trim: true }))
        .on('data', (row) => {
          rowCount++;
          if (rowCount <= sampleSize) {
            rows.push(row);
          }
        })
        .on('error', reject)
        .on('end', () => {
          result.rowCount = rowCount;
          resolve();
        });
    });
    
    console.log(`Parsed ${rowCount} total rows from ${fileName}, validating first ${rows.length}`);
    
    if (rows.length === 0) {
      result.isValid = false;
      result.errors.push({ error: 'File is empty' });
      return result;
    }
    
    // Validate schema
    const actualColumns = Object.keys(rows[0]);
    console.log(`Columns found in ${fileName}:`, actualColumns.slice(0, 5)); // Log first 5 columns for debugging
    
    // Check if 'time' column exists (case-insensitive and trim whitespace/BOM)
    const timeColumn = actualColumns.find(col => col.trim().toLowerCase() === 'time');
    
    if (!timeColumn) {
      result.isValid = false;
      result.errors.push({
        error: 'Required "time" column not found',
        found: actualColumns.slice(0, 10), // Show first 10 columns
        hint: 'Check for BOM or encoding issues'
      });
      return result;
    }
    
    console.log(`Time column found: "${timeColumn}"`);
    
    // Get TAZID columns (all columns except time)
    const tazidColumns = actualColumns.filter(col => col.trim().toLowerCase() !== 'time');
    
    if (tazidColumns.length === 0) {
      result.isValid = false;
      result.errors.push({ error: 'No TAZID columns found' });
      return result;
    }
    
    // Validate TAZID columns are numeric and match master file
    tazidColumns.forEach(col => {
      const tazid = parseInt(col);
      if (isNaN(tazid)) {
        result.warnings.push({ 
          column: col, 
          warning: 'Column name is not a valid TAZID (expected numeric)' 
        });
      } else {
        result.tazids.add(tazid);
        
        // Check if TAZID exists in master file
        if (!masterTazids.has(tazid)) {
          result.warnings.push({ 
            tazid, 
            warning: 'TAZID not found in station_information.csv' 
          });
        }
      }
    });
    
    console.log(`Found ${result.tazids.size} TAZID columns in ${fileName}`);
    
    // Validate sample rows
    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 for header and 1-based indexing
      
      // Validate timestamp format (use the actual time column name we found)
      const timeValue = row[timeColumn];
      if (!timeValue || timeValue.trim() === '') {
        result.errors.push({ row: rowNum, field: 'time', error: 'Missing timestamp' });
        result.isValid = false;
      } else {
        // Parse timestamp (format: "2022-09-01 00:00:00")
        const timestamp = new Date(timeValue);
        if (isNaN(timestamp.getTime())) {
          result.errors.push({ 
            row: rowNum, 
            field: 'time', 
            error: `Invalid timestamp format: ${timeValue}` 
          });
          result.isValid = false;
        } else {
          // Update time range
          if (!result.timeRange.earliest || timestamp < result.timeRange.earliest) {
            result.timeRange.earliest = timestamp;
          }
          if (!result.timeRange.latest || timestamp > result.timeRange.latest) {
            result.timeRange.latest = timestamp;
          }
        }
      }
      
      // Validate numeric values in TAZID columns (sample check)
      tazidColumns.slice(0, 10).forEach(tazidCol => { // Check first 10 TAZIDs per row
        const value = row[tazidCol];
        
        // Empty values are acceptable (means no data for that hour/zone)
        if (value && value.trim() !== '') {
          const numValue = parseFloat(value);
          if (isNaN(numValue)) {
            result.errors.push({ 
              row: rowNum, 
              column: tazidCol, 
              error: `Invalid numeric value: ${value}` 
            });
            result.isValid = false;
          } else if (numValue < 0) {
            result.warnings.push({ 
              row: rowNum, 
              column: tazidCol, 
              warning: `Negative value found: ${numValue}` 
            });
          }
        }
      });
    });
    
    console.log(`${fileName} validation complete: ${result.tazids.size} TAZIDs, time range: ${result.timeRange.earliest} to ${result.timeRange.latest}`);
    
  } catch (error) {
    console.error(`Error validating ${fileName}:`, error);
    result.isValid = false;
    result.errors.push({ error: 'Failed to parse file', message: error.message });
  }
  
  return result;
}

/**
 * Perform cross-file validation
 * Checks that TAZIDs are consistent across charge files and station_information
 */
function performCrossFileValidation(validationResults, masterTazids) {
  // Get all TAZIDs from charge files
  const allTazids = validationResults.summary.tazids;
  
  // Find TAZIDs in charge files but not in master
  const orphanTazids = [...allTazids].filter(id => !masterTazids.has(id));
  
  if (orphanTazids.length > 0) {
    validationResults.warnings.push({
      warning: 'TAZIDs found in charge files but not in station_information.csv',
      count: orphanTazids.length,
      samples: orphanTazids.slice(0, 10) // Show first 10 examples
    });
  }
  
  // Find TAZIDs in master but not in any charge file
  const unusedTazids = [...masterTazids].filter(id => !allTazids.has(id));
  
  if (unusedTazids.length > 0) {
    validationResults.warnings.push({
      warning: 'TAZIDs in station_information.csv but not found in any charge file',
      count: unusedTazids.length,
      samples: unusedTazids.slice(0, 10)
    });
  }
  
  console.log(`Cross-validation: ${masterTazids.size} master TAZIDs, ${allTazids.size} in charge files`);
}

/**
 * Merge validation results from individual file into overall results
 */
function mergeValidationResults(overall, fileResult, fileName) {
  if (!fileResult.isValid) {
    overall.isValid = false;
  }
  
  // Add file context to errors and warnings
  fileResult.errors.forEach(err => {
    overall.errors.push({ file: fileName, ...err });
  });
  
  fileResult.warnings.forEach(warn => {
    overall.warnings.push({ file: fileName, ...warn });
  });
  
  // Merge station IDs and TAZIDs
  if (fileResult.stationIds) {
    fileResult.stationIds.forEach(id => overall.summary.stationIds.add(id));
  }
  
  if (fileResult.tazids) {
    fileResult.tazids.forEach(id => overall.summary.tazids.add(id));
  }
  
  overall.summary.validatedFiles++;
}

/**
 * Update overall time range from file time range
 */
function updateTimeRange(summary, fileTimeRange) {
  if (fileTimeRange.earliest) {
    if (!summary.timeRange.earliest || fileTimeRange.earliest < summary.timeRange.earliest) {
      summary.timeRange.earliest = fileTimeRange.earliest;
    }
  }
  
  if (fileTimeRange.latest) {
    if (!summary.timeRange.latest || fileTimeRange.latest > summary.timeRange.latest) {
      summary.timeRange.latest = fileTimeRange.latest;
    }
  }
}

/**
 * Build final validation response for Step Functions
 */
function buildResponse(validationResults) {
  // Convert Sets and Maps to Arrays for JSON serialization
  validationResults.summary.stationIds = Array.from(validationResults.summary.stationIds);
  validationResults.summary.tazids = Array.from(validationResults.summary.tazids);
  
  // Convert Map to object for TAZID mappings
  const tazidMappingObj = {};
  if (validationResults.summary.tazidToStations) {
    for (const [tazid, stations] of validationResults.summary.tazidToStations.entries()) {
      tazidMappingObj[tazid] = stations;
    }
  }
  
  // Format time range as strings
  if (validationResults.summary.timeRange.earliest) {
    validationResults.summary.timeRange.earliest = validationResults.summary.timeRange.earliest.toISOString();
  }
  if (validationResults.summary.timeRange.latest) {
    validationResults.summary.timeRange.latest = validationResults.summary.timeRange.latest.toISOString();
  }
  
  const response = {
    statusCode: validationResults.isValid ? 200 : 400,
    isValid: validationResults.isValid,
    summary: {
      ...validationResults.summary,
      totalStations: validationResults.summary.stationIds.length,
      totalTazids: validationResults.summary.tazids.length,
      tazidToStations: tazidMappingObj, // For use in transformation step
      errorCount: validationResults.errors.length,
      warningCount: validationResults.warnings.length
    },
    errors: validationResults.errors,
    warnings: validationResults.warnings
  };
  
  console.log('Validation complete:', JSON.stringify({
    isValid: response.isValid,
    errorCount: response.summary.errorCount,
    warningCount: response.summary.warningCount,
    totalStations: response.summary.totalStations
  }));
  
  return response;
}

/**
 * Get S3 object as stream
 */
async function getS3Stream(bucket, key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);
  return response.Body;
}
