// ============================================================
// AWPIS — 01_trigger.gs
// Three ways the pipeline starts:
//   A. Daily 9 AM time-based trigger
//   B. Google Form submission (new client)
//   C. Manual "Run Now" button in the Sheet
//
// All three converge on runPipelineForClient(clientId).
// ============================================================

// ------------------------------------------------------------
// TRIGGER A — Daily 9 AM (set up once, runs forever)
// ------------------------------------------------------------

/**
 * createDailyTrigger()
 * Run this ONCE from the Apps Script editor to install the daily trigger.
 * Do not run again — it will create a duplicate.
 * Safe to check first: Extensions > Apps Script > Triggers
 */
function createDailyTrigger() {
  // Guard: delete any existing AWPIS daily trigger before creating a new one
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailyPipeline') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('runDailyPipeline')
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .inTimezone('Asia/Kolkata')
    .create();

  Logger.log('Daily trigger created: runDailyPipeline at 9 AM IST');
}

/**
 * runDailyPipeline()
 * Called by the time-based trigger every day at 9 AM.
 * Runs the pipeline for every active client in the Config tab.
 */
function runDailyPipeline() {
  var clients = _getActiveClients();
  Logger.log('Daily pipeline started. Active clients: ' + clients.length);

  for (var i = 0; i < clients.length; i++) {
    try {
      runPipelineForClient(clients[i].client_id);
    } catch (e) {
      Logger.log('ERROR running pipeline for client ' + clients[i].client_id + ': ' + e.message);
      _sendErrorAlert(clients[i], e);
    }
  }
}

// ------------------------------------------------------------
// TRIGGER B — Google Form submission (new client registration)
// ------------------------------------------------------------

/**
 * onFormSubmit(e)
 * Bound to the Google Form via Apps Script trigger.
 * Install via: Extensions > Apps Script > Triggers > Add Trigger
 *   Function: onFormSubmit
 *   Event source: From spreadsheet
 *   Event type: On form submit
 */
function onFormSubmit(e) {
  try {
    var responses = e.namedValues;

    // Map form field names to Config tab columns
    // These names must match your Google Form question text exactly
    var newClient = {
      client_id:         _generateClientId(responses['Client Name'][0]),
      client_name:       responses['Client Name'][0],
      website_url:       responses['Website URL'][0],
      github_repo:       responses['GitHub Repository Name'][0],
      github_owner:      responses['GitHub Owner/Username'][0],
      vercel_project_id: responses['Vercel Project ID'][0],
      report_email:      responses['Report Email'][0],
      run_mode:          responses['Run Mode (AUTOMATED or SUPERVISED)'][0] || RUN_MODE.SUPERVISED,
      perf_target:       responses['Performance Target (0-100)'][0] || THRESHOLD.PERF_TARGET_DEFAULT,
      lcp_target_ms:     responses['LCP Target (ms)'][0] || 2500,
      backend_url:       responses['Backend API Base URL'][0],
      active:            'TRUE'
    };

    _writeClientToConfig(newClient);
    Logger.log('New client registered: ' + newClient.client_name);

    // Optionally kick off the pipeline immediately for the new client
    // runPipelineForClient(newClient.client_id);

  } catch (err) {
    Logger.log('onFormSubmit ERROR: ' + err.message);
  }
}

// ------------------------------------------------------------
// TRIGGER C — Manual "Run Now" button in the Sheet
// ------------------------------------------------------------

/**
 * runPipelineManual()
 * Assigned to a button in the Google Sheet via:
 *   Insert > Drawing > assign script "runPipelineManual"
 *
 * Reads the selected/first active client and runs the pipeline.
 * Shows a toast notification in the Sheet while running.
 */
function runPipelineManual() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('AWPIS pipeline starting...', 'AWPIS', 5);

  var clients = _getActiveClients();
  if (clients.length === 0) {
    ss.toast('No active clients found in Config tab.', 'AWPIS Error', 10);
    return;
  }

  // Run for the first active client (extend this if you want a picker UI)
  var client = clients[0];
  ss.toast('Running for: ' + client.client_name, 'AWPIS', 5);

  try {
    runPipelineForClient(client.client_id);
    ss.toast('Pipeline complete for ' + client.client_name, 'AWPIS Done', 10);
  } catch (e) {
    ss.toast('Pipeline ERROR: ' + e.message, 'AWPIS Error', 15);
    Logger.log('Manual run ERROR: ' + e.message);
  }
}

// ------------------------------------------------------------
// CORE ENTRY POINT
// ------------------------------------------------------------

/**
 * runPipelineForClient(clientId)
 * The single entry point all three triggers converge on.
 *
 * Responsibilities:
 *   1. Load client config
 *   2. Generate run_id
 *   3. Write RUNNING row to Runs tab
 *   4. Clear State tab from any previous run
 *   5. Seed State with run metadata
 *   6. Hand off to Layer 2 (02_collect.gs)
 *
 * Layer 2 onwards is called sequentially from here. Each layer
 * reads its inputs from State and writes its outputs back to State.
 */
function runPipelineForClient(clientId) {
  var startTime = Date.now();

  // ---- Load client config ----
  var client = _getClientById(clientId);
  if (!client) {
    throw new Error('Client not found in Config tab: ' + clientId);
  }
  if (client.active !== 'TRUE') {
    Logger.log('Client ' + clientId + ' is not active. Skipping.');
    return;
  }

  var secrets = getSecrets();

  // ---- Generate run_id ----
  var runId = 'run_' + clientId + '_' + startTime;

  // ---- Initialise state for this run ----
  clearState();
  initStateTab();

  setState(STATE_KEY.RUN_ID,         runId);
  setState(STATE_KEY.CLIENT_ID,      clientId);
  setState(STATE_KEY.RUN_START_TIME, startTime);
  setState(STATE_KEY.RETRY_COUNT,    0);
  setState(STATE_KEY.GATE_RESULTS,   {
    structural:   null,
    sonarqube:    null,
    critic:       null,
    blast_radius: null
  });

  // ---- Write RUNNING row to Runs tab ----
  _writeRunRow(runId, clientId, RUN_STATUS.RUNNING, startTime);

  Logger.log('[AWPIS] Run started: ' + runId);

  // ---- Hand off to Layer 2: Intelligence Gathering ----
  // 02_collect.gs reads client + secrets, writes IntelligenceBundle to State
  collectIntelligence(client, secrets);

  Logger.log('[AWPIS] Layer 2 complete — IntelligenceBundle ready');

  // ---- Layer 3 is invoked from Workspace Studio (Gem 1) ----
  // Apps Script cannot directly call Workspace Studio steps.
  // The pipeline continues in Workspace Studio after this function
  // writes the IntelligenceBundle to the State tab.
  //
  // In the Workspace Studio flow:
  //   Step 1 → calls runPipelineForClient (this function)
  //   Step 2 → "Ask Gemini with Gem" reads IntelligenceBundle from State tab
  //   Step 3 → Workspace Studio calls continueAfterFixPlan(runId, fixPlanJson)
  //
  // If running in FULLY_SCRIPTED mode (no Workspace Studio), call:
  //   continueAfterFixPlan(runId, mockFixPlan) directly from here.
}

/**
 * continueAfterFixPlan(runId, fixPlanJson)
 * Called by Workspace Studio AFTER Gem 1 has produced a FixPlan.
 * Workspace Studio passes the FixPlan JSON as a string argument.
 *
 * This is the bridge between the Gem layer and the Apps Script layer.
 */
function continueAfterFixPlan(runId, fixPlanJson) {
  var fixPlan;
  try {
    fixPlan = (typeof fixPlanJson === 'string') ? JSON.parse(fixPlanJson) : fixPlanJson;
  } catch (e) {
    throw new Error('continueAfterFixPlan: invalid FixPlan JSON — ' + e.message);
  }

  setState(STATE_KEY.FIX_PLAN, fixPlan);
  Logger.log('[AWPIS] FixPlan received. Focus: ' + fixPlan.focus + ' | Confidence: ' + fixPlan.confidence);

  // Layer 4 — fetch only the files Gem 1 identified
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  fetchTargetedFiles(client, secrets, fixPlan);

  Logger.log('[AWPIS] Layer 4 complete — targeted files fetched');
  // Workspace Studio takes over again for Layer 5 (Fix Generation Gems)
}

/**
 * continueAfterFixGeneration(runId, generatedFixJson)
 * Called by Workspace Studio AFTER Gem 2/3 have produced fixed file contents.
 * Runs the 4-gate quality pipeline, sandbox, and production deploy.
 */
function continueAfterFixGeneration(runId, generatedFixJson) {
  var generatedFix;
  try {
    generatedFix = (typeof generatedFixJson === 'string') ? JSON.parse(generatedFixJson) : generatedFixJson;
  } catch (e) {
    throw new Error('continueAfterFixGeneration: invalid fix JSON — ' + e.message);
  }

  setState(STATE_KEY.GENERATED_FIX, generatedFix);
  Logger.log('[AWPIS] Generated fix received. Files: ' + generatedFix.files.length);

  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var fixPlan = getState(STATE_KEY.FIX_PLAN);

  // Layer 6 — Quality Gate Pipeline (all 4 gates, sequential)
  // runQualityGates() is defined in 05_sandbox.gs
  // It runs Gates 1 (structural) + 2 (SonarQube) in Apps Script,
  // then returns control to Workspace Studio for Gate 3 (Gem 4 Critic).
  //
  // After Gem 4 reviews, Workspace Studio calls:
  //   continueAfterCriticReview(runId, criticResultJson)
  //   (defined in 05_sandbox.gs)
  //
  // Which continues with Gate 4 (blast radius), then:
  //   → runSandboxValidation() (05_sandbox.gs, Layer 7)
  //   → runProductionDeploy()  (06_deploy.gs, Layer 8)
  //   → finalizePipeline()     (07_memory.gs, Layer 9)
  //
  // Full bridge function map:
  //   1. runPipelineForClient()         — 01_trigger.gs (this file)
  //   2. continueAfterFixPlan()         — 01_trigger.gs (this file)
  //   3. continueAfterFixGeneration()   — 01_trigger.gs (this file)
  //   4. continueAfterCriticReview()    — 05_sandbox.gs
  //
  runQualityGates(client, secrets, generatedFix, fixPlan);
}

// ------------------------------------------------------------
// Config tab helpers
// ------------------------------------------------------------

/**
 * _getActiveClients()
 * Returns array of client config objects where active === 'TRUE'.
 */
function _getActiveClients() {
  var sheet = _getSheet(SHEET.CONFIG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, Object.keys(CONFIG_COL).length).getValues();
  var clients = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (String(row[CONFIG_COL.ACTIVE]).toUpperCase() === 'TRUE') {
      clients.push(_rowToClient(row));
    }
  }
  return clients;
}

/**
 * _getClientById(clientId)
 * Returns a single client config object, or null if not found.
 */
function _getClientById(clientId) {
  var sheet = _getSheet(SHEET.CONFIG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, Object.keys(CONFIG_COL).length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][CONFIG_COL.CLIENT_ID]) === String(clientId)) {
      return _rowToClient(data[i]);
    }
  }
  return null;
}

/**
 * _rowToClient(row)
 * Maps a raw sheet row array to a typed client object.
 */
function _rowToClient(row) {
  return {
    client_id:         String(row[CONFIG_COL.CLIENT_ID]),
    client_name:       String(row[CONFIG_COL.CLIENT_NAME]),
    website_url:       String(row[CONFIG_COL.WEBSITE_URL]),
    github_repo:       String(row[CONFIG_COL.GITHUB_REPO]),
    github_owner:      String(row[CONFIG_COL.GITHUB_OWNER]),
    vercel_project_id: String(row[CONFIG_COL.VERCEL_PROJECT_ID]),
    report_email:      String(row[CONFIG_COL.REPORT_EMAIL]),
    run_mode:          String(row[CONFIG_COL.RUN_MODE]) || RUN_MODE.SUPERVISED,
    perf_target:       Number(row[CONFIG_COL.PERF_TARGET])  || THRESHOLD.PERF_TARGET_DEFAULT,
    lcp_target_ms:     Number(row[CONFIG_COL.LCP_TARGET_MS]) || 2500,
    backend_url:       String(row[CONFIG_COL.BACKEND_URL]),
    active:            String(row[CONFIG_COL.ACTIVE])
  };
}

/**
 * _writeClientToConfig(client)
 * Appends a new client row to the Config tab.
 */
function _writeClientToConfig(client) {
  var sheet = _getSheet(SHEET.CONFIG);
  sheet.appendRow([
    client.client_id,
    client.client_name,
    client.website_url,
    client.github_repo,
    client.github_owner,
    client.vercel_project_id,
    client.report_email,
    client.run_mode,
    client.perf_target,
    client.lcp_target_ms,
    client.backend_url,
    client.active
  ]);
}

// ------------------------------------------------------------
// Runs tab helpers
// ------------------------------------------------------------

/**
 * _writeRunRow(runId, clientId, status, startTime)
 * Creates the initial run row with RUNNING status.
 * All score columns start empty and are filled in by 07_memory.gs.
 */
function _writeRunRow(runId, clientId, status, startTime) {
  var sheet = _getSheet(SHEET.RUNS);

  // Build a row with the right number of columns, mostly empty
  var totalCols = Object.keys(RUNS_COL).length;
  var row = new Array(totalCols).fill('');

  row[RUNS_COL.RUN_ID]    = runId;
  row[RUNS_COL.TIMESTAMP] = new Date(startTime).toISOString();
  row[RUNS_COL.CLIENT_ID] = clientId;
  row[RUNS_COL.STATUS]    = status;

  sheet.appendRow(row);
}

// ------------------------------------------------------------
// Utility helpers
// ------------------------------------------------------------

/**
 * _generateClientId(clientName)
 * Produces a safe, lowercase, hyphenated client ID from a display name.
 * e.g. "MotoVerse" -> "motoverse", "My Company!" -> "my-company"
 */
function _generateClientId(clientName) {
  return clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * _sendErrorAlert(client, error)
 * Sends a plain-text email alert when the pipeline crashes unexpectedly.
 */
function _sendErrorAlert(client, error) {
  try {
    var secrets = getSecrets();
    var email   = secrets.REPORT_EMAIL || client.report_email;
    if (!email) return;

    MailApp.sendEmail({
      to:      email,
      subject: '[AWPIS ALERT] Pipeline crashed for ' + client.client_name,
      body:    [
        'AWPIS pipeline encountered an unhandled error.',
        '',
        'Client: ' + client.client_name,
        'Error:  ' + error.message,
        'Stack:  ' + (error.stack || 'unavailable'),
        '',
        'Check the Runs tab in AWPIS Control Center for details.',
        '',
        'Pipeline version: ' + PIPELINE_VERSION
      ].join('\n')
    });
  } catch (mailErr) {
    Logger.log('Failed to send error alert email: ' + mailErr.message);
  }
}
