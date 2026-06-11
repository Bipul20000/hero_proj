// ============================================================
// AWPIS — 08_state.gs
// State tab = per-run scratchpad. Cleared at run start.
// Secrets tab = protected; only this function touches it.
// ============================================================

// ------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------

/**
 * Returns the active spreadsheet's sheet by name.
 * Throws clearly if the sheet doesn't exist.
 */
function _getSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('AWPIS: Sheet not found — "' + sheetName + '". Check AWPIS Control Center tabs.');
  }
  return sheet;
}

/**
 * Reads all data rows from State tab into a plain object.
 * Returns {} if tab is empty.
 */
function _readStateMap() {
  var sheet = _getSheet(SHEET.STATE);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var map = {};
  for (var i = 0; i < data.length; i++) {
    var key = data[i][STATE_COL.KEY];
    var value = data[i][STATE_COL.VALUE];
    if (key && key !== '') {
      map[String(key)] = value;
    }
  }
  return map;
}

/**
 * Finds the row number (1-based) of a key in the State tab.
 * Returns -1 if not found.
 */
function _findStateRow(key) {
  var sheet = _getSheet(SHEET.STATE);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var keys = sheet.getRange(2, STATE_COL.KEY + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) {
      return i + 2; // +2 because row 1 is header, array is 0-based
    }
  }
  return -1;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * setState(key, value)
 * Writes or updates a key-value pair in the State tab.
 * Value can be string, number, boolean, or object (auto-serialised to JSON).
 */
function setState(key, value) {
  var sheet = _getSheet(SHEET.STATE);
  var serialised = (typeof value === 'object' && value !== null)
    ? JSON.stringify(value)
    : String(value);

  var existingRow = _findStateRow(key);
  if (existingRow > 0) {
    sheet.getRange(existingRow, STATE_COL.VALUE + 1).setValue(serialised);
  } else {
    sheet.appendRow([key, serialised]);
  }
}

/**
 * getState(key)
 * Reads a value from the State tab by key.
 * Auto-parses JSON if the value looks like an object/array.
 * Returns null if key not found.
 */
function getState(key) {
  var existingRow = _findStateRow(key);
  if (existingRow < 0) return null;

  var sheet = _getSheet(SHEET.STATE);
  var raw = sheet.getRange(existingRow, STATE_COL.VALUE + 1).getValue();

  if (raw === '' || raw === null || raw === undefined) return null;

  var str = String(raw);
  // Attempt JSON parse for objects and arrays
  if ((str.startsWith('{') && str.endsWith('}')) ||
      (str.startsWith('[') && str.endsWith(']'))) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return str;
    }
  }
  return str;
}

/**
 * clearState()
 * Wipes all data rows in the State tab (keeps the header row).
 * Called at the start of every pipeline run.
 */
function clearState() {
  var sheet = _getSheet(SHEET.STATE);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // nothing to clear

  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
}

/**
 * getSecrets()
 * Reads from the protected Secrets tab.
 * Returns a plain object: { GITHUB_TOKEN: '...', PAGESPEED_KEY: '...', ... }
 * Never logs any values — only used at runtime.
 *
 * Falls back to Script Properties (PropertiesService) if the Secrets tab
 * row is empty, so dev environments can use script props without a sheet.
 */
function getSecrets() {
  var sheet = _getSheet(SHEET.SECRETS);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    // No rows in Secrets tab — fall back entirely to PropertiesService
    return _secretsFromProperties();
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var secrets = {};
  var props = PropertiesService.getScriptProperties().getProperties();

  for (var i = 0; i < data.length; i++) {
    var keyName = String(data[i][SECRETS_COL.KEY_NAME]).trim();
    var encValue = String(data[i][SECRETS_COL.ENCRYPTED_VALUE]).trim();

    if (!keyName) continue;

    // If sheet cell is empty, fall back to Script Property with same name
    if (!encValue || encValue === '') {
      secrets[keyName] = props[keyName] || '';
    } else {
      secrets[keyName] = encValue;
    }
  }

  return secrets;
}

/**
 * _secretsFromProperties()
 * Full fallback: read all secrets from Script Properties.
 * Used when Secrets tab is empty (local dev / first-time setup).
 */
function _secretsFromProperties() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var expected = [
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'PAGESPEED_KEY',
    'VERCEL_DEPLOY_HOOK',
    'VERCEL_TOKEN',
    'VERCEL_PROJECT_ID',
    'SONARQUBE_TOKEN',
    'SONARQUBE_PROJECT_KEY',
    'REPORT_EMAIL',
    'RUN_MODE',
    'WEBSITE_URL',
    'BACKEND_URL'
  ];

  var secrets = {};
  for (var i = 0; i < expected.length; i++) {
    secrets[expected[i]] = props[expected[i]] || '';
  }
  return secrets;
}

// ------------------------------------------------------------
// State tab initialisation (idempotent — safe to call anytime)
// ------------------------------------------------------------

/**
 * initStateTab()
 * Ensures the State tab exists with correct headers.
 * Safe to call multiple times.
 */
function initStateTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET.STATE);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET.STATE);
  }

  // Write header row if missing
  var firstCell = sheet.getRange(1, 1).getValue();
  if (!firstCell || firstCell === '') {
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
}

// ------------------------------------------------------------
// Diagnostic helper (safe to run manually from Apps Script editor)
// ------------------------------------------------------------

/**
 * testStateReadWrite()
 * Manually runnable function to verify State tab is working.
 * Run from the Apps Script editor: Functions > testStateReadWrite
 */
function testStateReadWrite() {
  clearState();

  setState(STATE_KEY.RUN_ID, 'test-run-001');
  setState(STATE_KEY.CLIENT_ID, 'motoverse');
  setState(STATE_KEY.INTEL_BUNDLE, { test: true, score: 95 });

  var runId = getState(STATE_KEY.RUN_ID);
  var bundle = getState(STATE_KEY.INTEL_BUNDLE);

  Logger.log('RUN_ID: ' + runId);
  Logger.log('INTEL_BUNDLE.test: ' + bundle.test);
  Logger.log('INTEL_BUNDLE.score: ' + bundle.score);

  clearState();
  var afterClear = getState(STATE_KEY.RUN_ID);
  Logger.log('After clearState, RUN_ID: ' + afterClear); // should be null

  Logger.log('State tab test PASSED');
}
