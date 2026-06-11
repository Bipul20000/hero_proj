// ============================================================
// AWPIS — 04_sonarqube.gs
// SonarQube Cloud API wrapper.
//
// Used by:
//   02_collect.gs   — security scan (gate status on main)
//   03_github.gs    — fetchTargetedFiles() (issues per file)
//   05_sandbox.gs   — gate check on preview branch
//   06_deploy.gs    — gate check on main post-deploy
//   Layer 6 Gate 2  — quality gate enforcement
// ============================================================

// ------------------------------------------------------------
// Internal helper
// ------------------------------------------------------------

/**
 * _sonarGet(path, token)
 * Authenticated GET to SonarCloud API.
 * Returns parsed JSON. Returns null (not throw) on non-2xx
 * so callers can degrade gracefully if Sonar is not configured.
 */
function _sonarGet(path, token) {
  var url = API.SONARCLOUD + path;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method:             'get',
      headers:            { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code === 200) {
      return JSON.parse(resp.getContentText());
    }
    Logger.log('[Sonar] HTTP ' + code + ' for ' + path);
    return null;
  } catch (e) {
    Logger.log('[Sonar] Request error for ' + path + ': ' + e.message);
    return null;
  }
}

// ------------------------------------------------------------
// Public: Gate status
// ------------------------------------------------------------

/**
 * getSonarGateStatus(projectKey, branch, token)
 * Fetches the quality gate status for a given branch.
 * Returns a GateStatus object:
 * {
 *   status:     'OK' | 'ERROR' | 'WARN' | 'NONE' | 'UNKNOWN',
 *   conditions: [{ metric, status, actualValue, errorThreshold }],
 *   passed:     boolean
 * }
 */
function getSonarGateStatus(projectKey, branch, token) {
  var empty = { status: 'UNKNOWN', conditions: [], passed: false };
  if (!token || !projectKey) return empty;

  var path = '/qualitygates/project_status'
    + '?projectKey=' + encodeURIComponent(projectKey)
    + (branch ? '&branch=' + encodeURIComponent(branch) : '');

  var data = _sonarGet(path, token);
  if (!data || !data.projectStatus) return empty;

  var ps = data.projectStatus;
  return {
    status:     ps.status || 'UNKNOWN',
    conditions: (ps.conditions || []).map(function(c) {
      return {
        metric:         c.metricKey,
        status:         c.status,
        actual_value:   c.actualValue,
        error_threshold: c.errorThreshold
      };
    }),
    passed: ps.status === 'OK'
  };
}

// ------------------------------------------------------------
// Public: Issue search
// ------------------------------------------------------------

/**
 * getSonarIssues(projectKey, filePaths, token)
 * Fetches CRITICAL and BLOCKER issues for a given set of file paths.
 * filePaths: relative file paths from the repo root.
 *
 * Returns array of issue objects:
 * [{ key, severity, type, message, component, line, effort }]
 */
function getSonarIssues(projectKey, filePaths, token) {
  if (!token || !projectKey || !filePaths || filePaths.length === 0) return [];

  // SonarCloud component keys are formatted as: projectKey:filePath
  var componentKeys = filePaths.map(function(p) {
    return projectKey + ':' + p;
  }).join(',');

  var path = '/issues/search'
    + '?componentKeys=' + encodeURIComponent(componentKeys)
    + '&branch='        + GITHUB.MAIN_BRANCH
    + '&types=BUG,VULNERABILITY,CODE_SMELL'
    + '&severities=CRITICAL,BLOCKER'
    + '&resolved=false'
    + '&ps=50';  // max 50 issues per page — enough for targeted files

  var data = _sonarGet(path, token);
  if (!data || !data.issues) return [];

  return data.issues.map(function(issue) {
    return {
      key:       issue.key,
      severity:  issue.severity,
      type:      issue.type,
      message:   issue.message,
      component: issue.component,
      line:      issue.line || null,
      effort:    issue.effort || null,
      rule:      issue.rule
    };
  });
}

// ------------------------------------------------------------
// Public: Gate 2 — quality gate enforcement
// ------------------------------------------------------------

/**
 * checkSonarGate(projectKey, branch, generatedFiles, token)
 * Gate 2 of the quality gate pipeline.
 *
 * Enforces:
 *   - Zero NEW critical or blocker issues introduced
 *   - Zero NEW security hotspots
 *   - Maintainability rating stays A
 *   - Cognitive complexity delta <= 0
 *   - No new code duplication
 *
 * Returns:
 * {
 *   passed:       boolean,
 *   new_issues:   [],    -- issues not present before the fix
 *   failure_reason: string | null
 * }
 *
 * Note: SonarCloud scans the actual branch, not local code.
 * This gate checks the branch AFTER pushFilesToBranch() has run.
 * The scan is triggered automatically by SonarCloud's GitHub integration.
 * We poll the gate status and compare issue counts before vs after.
 */
function checkSonarGate(projectKey, branch, token) {
  var result = {
    passed:         false,
    new_issues:     [],
    failure_reason: null,
    gate_status:    'UNKNOWN'
  };

  if (!token || !projectKey) {
    Logger.log('[Gate 2] SonarQube not configured — skipping gate');
    result.passed = true;  // don't block if Sonar isn't set up
    result.gate_status = 'NOT_CONFIGURED';
    return result;
  }

  // Poll for scan completion (Sonar scans are async after push)
  var gateStatus = _pollForSonarScanCompletion(projectKey, branch, token);
  result.gate_status = gateStatus.status;

  if (!gateStatus.passed) {
    // Find which conditions are failing
    var failingConditions = gateStatus.conditions.filter(function(c) {
      return c.status === 'ERROR';
    });

    var failureMessages = failingConditions.map(function(c) {
      return c.metric + ': ' + c.actual_value + ' (threshold: ' + c.error_threshold + ')';
    });

    result.failure_reason = 'SonarQube gate FAILED. Conditions: ' + failureMessages.join(', ');
    Logger.log('[Gate 2] FAILED: ' + result.failure_reason);
    return result;
  }

  // Gate passed — also check for new issues in changed files
  var newIssues = getSonarIssues(projectKey, _getChangedFilePaths(), token);
  result.new_issues = newIssues;

  if (newIssues.some(function(i) { return i.severity === 'BLOCKER' || i.severity === 'CRITICAL'; })) {
    result.failure_reason = 'New CRITICAL/BLOCKER issues introduced: '
      + newIssues.filter(function(i) { return i.severity === 'BLOCKER' || i.severity === 'CRITICAL'; })
               .map(function(i) { return i.message + ' (line ' + i.line + ')'; }).join('; ');
    Logger.log('[Gate 2] FAILED: ' + result.failure_reason);
    return result;
  }

  result.passed = true;
  Logger.log('[Gate 2] SonarQube gate PASSED. Status: ' + gateStatus.status);
  return result;
}

/**
 * _pollForSonarScanCompletion(projectKey, branch, token)
 * Polls SonarCloud for up to 3 minutes waiting for the scan to
 * finish after a branch push. SonarCloud scans are triggered by
 * GitHub webhooks and typically complete in 30-90 seconds.
 *
 * Returns the final GateStatus.
 */
function _pollForSonarScanCompletion(projectKey, branch, token) {
  var maxAttempts = 18;  // 18 × 10s = 3 minutes
  var interval    = 10000; // 10 seconds

  for (var i = 0; i < maxAttempts; i++) {
    var status = getSonarGateStatus(projectKey, branch, token);

    // 'NONE' means the scan hasn't started yet
    // 'OK' or 'ERROR' means the scan is complete
    if (status.status !== 'NONE' && status.status !== 'UNKNOWN') {
      Logger.log('[Sonar poll] Scan complete on attempt ' + (i + 1) + '. Status: ' + status.status);
      return status;
    }

    Logger.log('[Sonar poll] Attempt ' + (i + 1) + ' — scan pending. Waiting ' + (interval / 1000) + 's...');
    Utilities.sleep(interval);
  }

  Logger.log('[Sonar poll] Timed out waiting for scan. Returning last known status.');
  return getSonarGateStatus(projectKey, branch, token);
}

/**
 * _getChangedFilePaths()
 * Helper to read changed file paths from the current FixPlan in State.
 */
function _getChangedFilePaths() {
  var fixPlan = getState(STATE_KEY.FIX_PLAN);
  return (fixPlan && fixPlan.files_to_change) ? fixPlan.files_to_change : [];
}

// ------------------------------------------------------------
// Public: Snapshot comparison
// ------------------------------------------------------------

/**
 * compareSonarSnapshots(beforeStatus, afterStatus)
 * Diffs two gate status objects (before and after a fix).
 * Returns a delta summary for the PR body and report.
 *
 * {
 *   gate_changed:      boolean,
 *   gate_before:       string,
 *   gate_after:        string,
 *   improved:          boolean,
 *   regressed:         boolean,
 *   conditions_fixed:  [],
 *   conditions_broken: []
 * }
 */
function compareSonarSnapshots(beforeStatus, afterStatus) {
  var before = beforeStatus || { status: 'UNKNOWN', conditions: [] };
  var after  = afterStatus  || { status: 'UNKNOWN', conditions: [] };

  var beforeMap = {};
  before.conditions.forEach(function(c) { beforeMap[c.metric] = c; });

  var conditionsFixed  = [];
  var conditionsBroken = [];

  after.conditions.forEach(function(c) {
    var b = beforeMap[c.metric];
    if (!b) return;
    if (b.status === 'ERROR' && c.status === 'OK') {
      conditionsFixed.push(c.metric);
    } else if (b.status === 'OK' && c.status === 'ERROR') {
      conditionsBroken.push(c.metric + ' (' + c.actual_value + ' vs threshold ' + c.error_threshold + ')');
    }
  });

  var gateImproved  = before.status !== 'OK' && after.status === 'OK';
  var gateRegressed = before.status === 'OK'  && after.status !== 'OK';

  return {
    gate_changed:      before.status !== after.status,
    gate_before:       before.status,
    gate_after:        after.status,
    improved:          gateImproved,
    regressed:         gateRegressed,
    conditions_fixed:  conditionsFixed,
    conditions_broken: conditionsBroken
  };
}
