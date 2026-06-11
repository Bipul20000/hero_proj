// ============================================================
// AWPIS — 07_memory.gs
// Layer 9: Learning + Reporting
//
// Responsibilities:
//   - Write fix memory to FixMemory tab
//   - Update baseline scores when new highs achieved
//   - Update Runs tab with final status + scores
//   - Build PipelineResult JSON for Gem 5 (Report Writer)
//   - Finalize pipeline: assemble report data, send email
//
// Called by:
//   06_deploy.gs — after production deploy or blocked/reverted
// ============================================================

// ------------------------------------------------------------
// Public: Write Fix Memory
// ------------------------------------------------------------

/**
 * writeFixMemory(runData)
 * Appends a row to the FixMemory tab recording what was tried,
 * whether it worked, and any gates that failed.
 *
 * runData shape:
 * {
 *   focus, approach, files_changed, psi_before, psi_after,
 *   sonar_before, sonar_after, success, reverted,
 *   side_effects, retry_count, gates_failed
 * }
 */
function writeFixMemory(runData) {
  var sheet = _getSheet(SHEET.FIX_MEMORY);

  var row = [
    new Date().toISOString(),                                           // DATE
    runData.focus          || '',                                       // FOCUS
    runData.approach       || '',                                       // APPROACH
    _safeJoin(runData.files_changed),                                   // FILES_CHANGED
    _safePsiString(runData.psi_before),                                 // PSI_BEFORE
    _safePsiString(runData.psi_after),                                  // PSI_AFTER
    runData.sonar_before   || '',                                       // SONAR_BEFORE
    runData.sonar_after    || '',                                       // SONAR_AFTER
    runData.success        ? 'TRUE' : 'FALSE',                          // SUCCESS
    runData.reverted       ? 'TRUE' : 'FALSE',                          // REVERTED
    runData.side_effects   || '',                                       // SIDE_EFFECTS
    runData.retry_count    || 0,                                        // RETRY_COUNT
    _safeJoin(runData.gates_failed)                                     // GATES_FAILED
  ];

  sheet.appendRow(row);
  Logger.log('[Memory] FixMemory row written. Focus: ' + runData.focus + ' | Success: ' + runData.success);
}

// ------------------------------------------------------------
// Public: Update Baseline
// ------------------------------------------------------------

/**
 * updateBaseline(clientId, psiMetrics)
 * Updates the Baseline tab if any metric in psiMetrics exceeds
 * the current baseline (new high score).
 *
 * For Lighthouse scores: higher is better.
 * For timing metrics (LCP, FCP, TBT): lower is better.
 * For CLS: lower is better.
 *
 * psiMetrics shape: { performance, accessibility, best_practices,
 *   seo, lcp_ms, fcp_ms, tbt_ms, cls, backend_avg_ms }
 */
function updateBaseline(clientId, psiMetrics) {
  var sheet   = _getSheet(SHEET.BASELINE);
  var lastRow = sheet.getLastRow();
  var found   = false;
  var rowIdx  = -1;

  // Find existing baseline row for this client
  if (lastRow >= 2) {
    var data = sheet.getRange(2, 1, lastRow - 1, Object.keys(BASELINE_COL).length).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][BASELINE_COL.CLIENT_ID]) === String(clientId)) {
        found  = true;
        rowIdx = i + 2; // 1-indexed, skip header
        break;
      }
    }
  }

  if (!found) {
    // First run — insert new baseline row
    var newRow = _buildBaselineRow(clientId, psiMetrics);
    sheet.appendRow(newRow);
    Logger.log('[Memory] New baseline created for client: ' + clientId);
    return;
  }

  // Update existing baseline — only if new values are better
  var current = sheet.getRange(rowIdx, 1, 1, Object.keys(BASELINE_COL).length).getValues()[0];
  var updated = false;

  // Higher is better: performance, accessibility, best_practices, seo
  var higherBetter = [
    { col: BASELINE_COL.PERFORMANCE,    val: psiMetrics.performance },
    { col: BASELINE_COL.ACCESSIBILITY,  val: psiMetrics.accessibility },
    { col: BASELINE_COL.BEST_PRACTICES, val: psiMetrics.best_practices },
    { col: BASELINE_COL.SEO,            val: psiMetrics.seo }
  ];

  for (var h = 0; h < higherBetter.length; h++) {
    var item = higherBetter[h];
    if (item.val > (Number(current[item.col]) || 0)) {
      sheet.getRange(rowIdx, item.col + 1).setValue(item.val);
      updated = true;
    }
  }

  // Lower is better: lcp_ms, fcp_ms, tbt_ms, cls, backend_avg_ms
  var lowerBetter = [
    { col: BASELINE_COL.LCP_MS,         val: psiMetrics.lcp_ms },
    { col: BASELINE_COL.FCP_MS,         val: psiMetrics.fcp_ms },
    { col: BASELINE_COL.TBT_MS,         val: psiMetrics.tbt_ms },
    { col: BASELINE_COL.CLS,            val: psiMetrics.cls },
    { col: BASELINE_COL.BACKEND_AVG_MS, val: psiMetrics.backend_avg_ms || 0 }
  ];

  for (var l = 0; l < lowerBetter.length; l++) {
    var entry      = lowerBetter[l];
    var currentVal = Number(current[entry.col]) || 0;
    // Only update if we have a value and it's better (lower), or baseline was 0 (first measurement)
    if (entry.val > 0 && (currentVal === 0 || entry.val < currentVal)) {
      sheet.getRange(rowIdx, entry.col + 1).setValue(entry.val);
      updated = true;
    }
  }

  if (updated) {
    sheet.getRange(rowIdx, BASELINE_COL.LAST_UPDATED + 1).setValue(new Date().toISOString());
    Logger.log('[Memory] Baseline updated for client: ' + clientId);
  } else {
    Logger.log('[Memory] No baseline improvement for client: ' + clientId);
  }
}

// ------------------------------------------------------------
// Public: Update Run Status
// ------------------------------------------------------------

/**
 * updateRunStatus(runId, status, finalData)
 * Updates the existing RUNNING row in the Runs tab with final
 * status, scores, and metadata.
 *
 * finalData shape:
 * {
 *   psi_before, psi_after, backend_before, backend_after,
 *   focus, root_cause, files_changed, fix_description,
 *   gates_passed, gates_failed, sandbox_result, deploy_status,
 *   reverted, sonar_before, sonar_after, gemini_analysis,
 *   pr_url, run_duration_ms
 * }
 */
function updateRunStatus(runId, status, finalData) {
  var sheet   = _getSheet(SHEET.RUNS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // Find the row with this run_id
  var runIds = sheet.getRange(2, RUNS_COL.RUN_ID + 1, lastRow - 1, 1).getValues();
  var rowIdx = -1;
  for (var i = 0; i < runIds.length; i++) {
    if (String(runIds[i][0]) === String(runId)) {
      rowIdx = i + 2;
      break;
    }
  }

  if (rowIdx < 0) {
    Logger.log('[Memory] Run row not found for: ' + runId);
    return;
  }

  var fd = finalData || {};
  var pb = fd.psi_before || {};
  var pa = fd.psi_after  || {};

  // Build update values — one by one to avoid overwriting the whole row
  var updates = {};
  updates[RUNS_COL.STATUS]             = status;
  updates[RUNS_COL.PERF_BEFORE]        = pb.performance    || '';
  updates[RUNS_COL.A11Y_BEFORE]        = pb.accessibility  || '';
  updates[RUNS_COL.BP_BEFORE]          = pb.best_practices || '';
  updates[RUNS_COL.SEO_BEFORE]         = pb.seo            || '';
  updates[RUNS_COL.FCP_BEFORE]         = pb.fcp_ms         || '';
  updates[RUNS_COL.LCP_BEFORE]         = pb.lcp_ms         || '';
  updates[RUNS_COL.TBT_BEFORE]         = pb.tbt_ms         || '';
  updates[RUNS_COL.CLS_BEFORE]         = pb.cls !== undefined ? pb.cls : '';
  updates[RUNS_COL.BACKEND_AVG_BEFORE] = fd.backend_avg_before || '';
  updates[RUNS_COL.BACKEND_STATUS_BEFORE] = fd.backend_status_before || '';
  updates[RUNS_COL.PERF_AFTER]         = pa.performance    || '';
  updates[RUNS_COL.A11Y_AFTER]         = pa.accessibility  || '';
  updates[RUNS_COL.BP_AFTER]           = pa.best_practices || '';
  updates[RUNS_COL.SEO_AFTER]          = pa.seo            || '';
  updates[RUNS_COL.FCP_AFTER]          = pa.fcp_ms         || '';
  updates[RUNS_COL.LCP_AFTER]          = pa.lcp_ms         || '';
  updates[RUNS_COL.TBT_AFTER]          = pa.tbt_ms         || '';
  updates[RUNS_COL.CLS_AFTER]          = pa.cls !== undefined ? pa.cls : '';
  updates[RUNS_COL.BACKEND_AVG_AFTER]  = fd.backend_avg_after  || '';
  updates[RUNS_COL.BACKEND_STATUS_AFTER] = fd.backend_status_after || '';
  updates[RUNS_COL.FOCUS]              = fd.focus            || '';
  updates[RUNS_COL.ROOT_CAUSE]         = fd.root_cause       || '';
  updates[RUNS_COL.FILES_CHANGED]      = _safeJoin(fd.files_changed);
  updates[RUNS_COL.FIX_DESCRIPTION]    = fd.fix_description  || '';
  updates[RUNS_COL.GATES_PASSED]       = _safeJoin(fd.gates_passed);
  updates[RUNS_COL.GATES_FAILED]       = _safeJoin(fd.gates_failed);
  updates[RUNS_COL.SANDBOX_RESULT]     = fd.sandbox_result   || '';
  updates[RUNS_COL.DEPLOY_STATUS]      = fd.deploy_status    || '';
  updates[RUNS_COL.REVERTED]           = fd.reverted ? 'TRUE' : 'FALSE';
  updates[RUNS_COL.SONAR_GATE_BEFORE]  = fd.sonar_before     || '';
  updates[RUNS_COL.SONAR_GATE_AFTER]   = fd.sonar_after      || '';
  updates[RUNS_COL.GEMINI_ANALYSIS]    = fd.gemini_analysis   || '';
  updates[RUNS_COL.PR_URL]             = fd.pr_url            || '';
  updates[RUNS_COL.RUN_DURATION_MS]    = fd.run_duration_ms   || '';

  // Write all updates in a single batch for performance
  var cols = Object.keys(updates);
  for (var c = 0; c < cols.length; c++) {
    var colIdx = Number(cols[c]);
    sheet.getRange(rowIdx, colIdx + 1).setValue(updates[colIdx]);
  }

  Logger.log('[Memory] Run status updated: ' + runId + ' → ' + status);
}

// ------------------------------------------------------------
// Public: Build PipelineResult
// ------------------------------------------------------------

/**
 * buildPipelineResult()
 * Assembles the full PipelineResult JSON from State tab data.
 * This is the input to Gem 5 (Report Writer).
 * Called by finalizePipeline() and also exposed for Workspace Studio.
 *
 * Returns PipelineResult JSON.
 */
function buildPipelineResult() {
  var runId     = getState(STATE_KEY.RUN_ID);
  var clientId  = getState(STATE_KEY.CLIENT_ID);
  var startTime = Number(getState(STATE_KEY.RUN_START_TIME)) || 0;
  var fixPlan   = getState(STATE_KEY.FIX_PLAN) || {};
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};
  var sandboxResult = getState(STATE_KEY.SANDBOX_RESULT);
  var previewPsi = getState(STATE_KEY.PREVIEW_PSI);
  var productionPsi = getState(STATE_KEY.PRODUCTION_PSI);
  var prUrl      = getState(STATE_KEY.PR_URL);
  var sonarBefore = getState(STATE_KEY.SONAR_BEFORE);
  var sonarAfter  = getState(STATE_KEY.SONAR_AFTER);
  var generatedFix = getState(STATE_KEY.GENERATED_FIX) || {};

  var psiBefore = (intelBundle.psi_metrics) || {};
  var psiAfter  = productionPsi || previewPsi || {};

  var gatesPassed = [];
  var gatesFailed = [];
  var gateNames = [GATE.STRUCTURAL, GATE.SONARQUBE, GATE.CRITIC, GATE.BLAST_RADIUS];
  for (var i = 0; i < gateNames.length; i++) {
    var g = gateNames[i];
    var result = gateResults[g];
    if (result === GATE_RESULT.PASS || result === GATE_RESULT.APPROVE || result === GATE_RESULT.CLEAR) {
      gatesPassed.push(g);
    } else if (result === GATE_RESULT.FAIL || result === GATE_RESULT.REJECT) {
      gatesFailed.push(g);
    }
  }

  var filesChanged = (generatedFix.files || []).map(function(f) { return f.path; });

  return {
    run_id:          runId,
    client_id:       clientId,
    client_name:     intelBundle.client_name || '',
    status:          '', // set by caller
    duration_ms:     startTime > 0 ? (Date.now() - startTime) : 0,
    psi_before:      psiBefore,
    psi_after:       psiAfter,
    backend_before:  (intelBundle.backend_metrics) || {},
    backend_after:   {}, // populated after production PSI if available
    sonar_before:    sonarBefore || {},
    sonar_after:     sonarAfter || {},
    fix_plan:        fixPlan,
    files_changed:   filesChanged,
    fix_description: (generatedFix.fix_summary) || fixPlan.approach || '',
    gates: {
      structural:   gateResults[GATE.STRUCTURAL]   || 'NOT_RUN',
      sonarqube:    gateResults[GATE.SONARQUBE]    || 'NOT_RUN',
      critic:       gateResults[GATE.CRITIC]       || 'NOT_RUN',
      blast_radius: gateResults[GATE.BLAST_RADIUS] || 'NOT_RUN'
    },
    gates_passed:    gatesPassed,
    gates_failed:    gatesFailed,
    sandbox: {
      gate:        sandboxResult ? (sandboxResult.passed ? 'PASS' : 'FAIL') : 'NOT_RUN',
      preview_url: getState(STATE_KEY.PREVIEW_URL) || '',
      reason:      sandboxResult ? (sandboxResult.reason || '') : ''
    },
    deploy: {
      pr_url:   prUrl || '',
      deployed: false, // set by caller
      reverted: false  // set by caller
    },
    gemini_analysis:          fixPlan.root_cause || '',
    next_recommended_focus:   '', // set by caller or Gem 5
    pipeline_version:         PIPELINE_VERSION,
    targets:                  intelBundle.targets || {}
  };
}

// ------------------------------------------------------------
// Public: Finalize Pipeline
// ------------------------------------------------------------

/**
 * finalizePipeline(client, secrets, status, deployResult)
 * Layer 9 entry point. Called after deploy (success or failure).
 *
 * Steps:
 *   1. Build PipelineResult
 *   2. Write FixMemory row
 *   3. Update baseline (if success)
 *   4. Update Runs tab with final status
 *   5. Write PipelineResult to State for Gem 5
 *
 * Gem 5 (report generation) and Gmail send are handled by
 * Workspace Studio after this function completes.
 *
 * deployResult shape:
 * {
 *   status:   'SUCCESS' | 'BLOCKED' | 'REVERTED' | 'FAILED',
 *   deployed: boolean,
 *   reverted: boolean,
 *   pr_url:   string,
 *   production_psi: {},
 *   side_effects: string
 * }
 */
function finalizePipeline(client, secrets, status, deployResult) {
  var runId    = getState(STATE_KEY.RUN_ID);
  var fixPlan  = getState(STATE_KEY.FIX_PLAN) || {};
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var retryCount = Number(getState(STATE_KEY.RETRY_COUNT)) || 0;
  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};
  var generatedFix = getState(STATE_KEY.GENERATED_FIX) || {};
  var sonarBefore = getState(STATE_KEY.SONAR_BEFORE) || '';
  var sonarAfter  = getState(STATE_KEY.SONAR_AFTER) || '';
  var startTime   = Number(getState(STATE_KEY.RUN_START_TIME)) || 0;
  var durationMs  = startTime > 0 ? (Date.now() - startTime) : 0;

  var dr = deployResult || {};
  var psiBefore = intelBundle.psi_metrics || {};
  var psiAfter  = dr.production_psi || getState(STATE_KEY.PREVIEW_PSI) || {};

  // 1. Build PipelineResult
  var pipelineResult = buildPipelineResult();
  pipelineResult.status        = status;
  pipelineResult.deploy.deployed = dr.deployed || false;
  pipelineResult.deploy.reverted = dr.reverted || false;
  pipelineResult.deploy.pr_url   = dr.pr_url   || pipelineResult.deploy.pr_url;
  pipelineResult.duration_ms     = durationMs;

  // 2. Compute gates summary
  var gatesPassed = pipelineResult.gates_passed;
  var gatesFailed = pipelineResult.gates_failed;

  // 3. Write FixMemory
  writeFixMemory({
    focus:          fixPlan.focus || '',
    approach:       fixPlan.approach || '',
    files_changed:  pipelineResult.files_changed,
    psi_before:     psiBefore,
    psi_after:      psiAfter,
    sonar_before:   sonarBefore,
    sonar_after:    sonarAfter,
    success:        status === RUN_STATUS.SUCCESS,
    reverted:       dr.reverted || false,
    side_effects:   dr.side_effects || '',
    retry_count:    retryCount,
    gates_failed:   gatesFailed
  });

  // 4. Update baseline if this was a success
  if (status === RUN_STATUS.SUCCESS && psiAfter.performance) {
    updateBaseline(client.client_id, {
      performance:    psiAfter.performance    || 0,
      accessibility:  psiAfter.accessibility  || 0,
      best_practices: psiAfter.best_practices || 0,
      seo:            psiAfter.seo            || 0,
      lcp_ms:         psiAfter.lcp_ms         || 0,
      fcp_ms:         psiAfter.fcp_ms         || 0,
      tbt_ms:         psiAfter.tbt_ms         || 0,
      cls:            psiAfter.cls            || 0,
      backend_avg_ms: dr.backend_avg_after    || 0
    });
  }

  // 5. Update Runs tab
  var backendBefore = intelBundle.backend_metrics || {};
  updateRunStatus(runId, status, {
    psi_before:            psiBefore,
    psi_after:             psiAfter,
    backend_avg_before:    backendBefore.avg_response_ms || '',
    backend_status_before: backendBefore.all_healthy ? 'ALL_HEALTHY' : 'UNHEALTHY',
    backend_avg_after:     dr.backend_avg_after || '',
    backend_status_after:  dr.backend_status_after || '',
    focus:                 fixPlan.focus || '',
    root_cause:            fixPlan.root_cause || '',
    files_changed:         pipelineResult.files_changed,
    fix_description:       pipelineResult.fix_description,
    gates_passed:          gatesPassed,
    gates_failed:          gatesFailed,
    sandbox_result:        pipelineResult.sandbox.gate,
    deploy_status:         status,
    reverted:              dr.reverted || false,
    sonar_before:          sonarBefore,
    sonar_after:           sonarAfter,
    gemini_analysis:       fixPlan.root_cause || '',
    pr_url:                pipelineResult.deploy.pr_url,
    run_duration_ms:       durationMs
  });

  // 6. Store PipelineResult in State for Gem 5 / Workspace Studio
  setState(STATE_KEY.PRODUCTION_PSI, psiAfter);
  setState('pipeline_result', pipelineResult);

  Logger.log('[Layer 9] Pipeline finalized. Status: ' + status + ' | Duration: ' + durationMs + 'ms');
  return pipelineResult;
}

// ------------------------------------------------------------
// Public: Send Report Email (fallback — if not using Gem 5)
// ------------------------------------------------------------

/**
 * sendFallbackReport(client, pipelineResult)
 * Sends a simple plain-text email report if Gem 5 / Workspace Studio
 * is not available. The Workspace Studio flow should use Gem 5 to
 * generate the HTML report instead.
 */
function sendFallbackReport(client, pipelineResult) {
  var email = client.report_email;
  if (!email) {
    Logger.log('[Report] No email configured — skipping report');
    return;
  }

  var pr = pipelineResult;
  var subject = '[AWPIS] ' + pr.status + ' — ' + (pr.fix_plan.focus || 'Pipeline Run')
    + ' | ' + client.client_name;

  var body = [
    'AWPIS Pipeline Report',
    '=====================',
    '',
    'Client:   ' + client.client_name,
    'Status:   ' + pr.status,
    'Duration: ' + Math.round(pr.duration_ms / 1000) + ' seconds',
    'Run ID:   ' + pr.run_id,
    '',
    '--- Scores ---',
    'Performance:    ' + (pr.psi_before.performance || '--') + ' → ' + (pr.psi_after.performance || '--'),
    'Accessibility:  ' + (pr.psi_before.accessibility || '--') + ' → ' + (pr.psi_after.accessibility || '--'),
    'Best Practices: ' + (pr.psi_before.best_practices || '--') + ' → ' + (pr.psi_after.best_practices || '--'),
    'SEO:            ' + (pr.psi_before.seo || '--') + ' → ' + (pr.psi_after.seo || '--'),
    'LCP (ms):       ' + (pr.psi_before.lcp_ms || '--') + ' → ' + (pr.psi_after.lcp_ms || '--'),
    'CLS:            ' + (pr.psi_before.cls !== undefined ? pr.psi_before.cls : '--')
                       + ' → ' + (pr.psi_after.cls !== undefined ? pr.psi_after.cls : '--'),
    '',
    '--- Fix Applied ---',
    'Focus:       ' + (pr.fix_plan.focus || 'N/A'),
    'Root Cause:  ' + (pr.fix_plan.root_cause || 'N/A'),
    'Approach:    ' + (pr.fix_plan.approach || 'N/A'),
    'Files:       ' + (pr.files_changed || []).join(', '),
    '',
    '--- Quality Gates ---',
    'Structural:   ' + pr.gates.structural,
    'SonarQube:    ' + pr.gates.sonarqube,
    'Critic:       ' + pr.gates.critic,
    'Blast Radius: ' + pr.gates.blast_radius,
    '',
    '--- Deploy ---',
    'Deployed: ' + pr.deploy.deployed,
    'Reverted: ' + pr.deploy.reverted,
    'PR URL:   ' + (pr.deploy.pr_url || 'N/A'),
    '',
    '---',
    'AWPIS v' + PIPELINE_VERSION
  ].join('\n');

  try {
    MailApp.sendEmail({ to: email, subject: subject, body: body });
    Logger.log('[Report] Fallback email sent to: ' + email);
  } catch (e) {
    Logger.log('[Report] Email send failed: ' + e.message);
  }
}

// ------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------

/**
 * _buildBaselineRow(clientId, psiMetrics)
 * Creates a new baseline row array for appendRow().
 */
function _buildBaselineRow(clientId, psiMetrics) {
  var row = new Array(Object.keys(BASELINE_COL).length).fill('');
  row[BASELINE_COL.CLIENT_ID]       = clientId;
  row[BASELINE_COL.PERFORMANCE]     = psiMetrics.performance    || 0;
  row[BASELINE_COL.ACCESSIBILITY]   = psiMetrics.accessibility  || 0;
  row[BASELINE_COL.BEST_PRACTICES]  = psiMetrics.best_practices || 0;
  row[BASELINE_COL.SEO]             = psiMetrics.seo            || 0;
  row[BASELINE_COL.LCP_MS]          = psiMetrics.lcp_ms         || 0;
  row[BASELINE_COL.FCP_MS]          = psiMetrics.fcp_ms         || 0;
  row[BASELINE_COL.TBT_MS]          = psiMetrics.tbt_ms         || 0;
  row[BASELINE_COL.CLS]             = psiMetrics.cls            || 0;
  row[BASELINE_COL.BACKEND_AVG_MS]  = psiMetrics.backend_avg_ms || 0;
  row[BASELINE_COL.LAST_UPDATED]    = new Date().toISOString();
  return row;
}

/**
 * _safeJoin(value)
 * Safely joins an array to a comma-separated string.
 * Returns empty string if value is not an array.
 */
function _safeJoin(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  return '';
}

/**
 * _safePsiString(psi)
 * Converts a PSI metrics object to a compact string for the FixMemory tab.
 * e.g. "P:93 A:95 BP:96 S:91 LCP:1862"
 */
function _safePsiString(psi) {
  if (!psi || typeof psi !== 'object') return '';
  return 'P:' + (psi.performance || 0)
    + ' A:' + (psi.accessibility || 0)
    + ' BP:' + (psi.best_practices || 0)
    + ' S:' + (psi.seo || 0)
    + ' LCP:' + (psi.lcp_ms || 0);
}
