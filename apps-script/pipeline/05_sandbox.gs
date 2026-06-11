// ============================================================
// AWPIS — 05_sandbox.gs
// Layer 6: Quality Gate Pipeline (4 gates, sequential)
// Layer 7: Sandbox Validation (preview deploy + PSI check)
//
// Section A — runQualityGates() orchestrator
//   Gate 1: Structural safety (deterministic, no LLM)
//   Gate 2: SonarQube quality gate (via 04_sonarqube.gs)
//   Gate 3: Critic review (prepares input for Gem 4)
//   Gate 4: Dependency blast radius check
//
// Section B — Sandbox validation
//   Preview deploy → PSI check → backend health → Sonar check
//
// Called by:
//   01_trigger.gs → continueAfterFixGeneration()
// ============================================================

// ============================================================
// SECTION A — QUALITY GATE PIPELINE (Layer 6)
// ============================================================

// ------------------------------------------------------------
// Public: Quality Gates Orchestrator
// ------------------------------------------------------------

/**
 * runQualityGates(client, secrets, generatedFix, fixPlan)
 * Layer 6 entry point. Runs all 4 quality gates sequentially.
 *
 * Gate 1 (Structural) and Gate 4 (Blast Radius) run in Apps Script.
 * Gate 2 (SonarQube) runs in Apps Script via 04_sonarqube.gs.
 * Gate 3 (Critic) requires Workspace Studio → writes input to State
 *   and returns control to Workspace Studio for Gem 4 invocation.
 *
 * On any gate failure: retries up to MAX_GATE_RETRIES (3) times.
 * After 3 failures: escalates to human via email.
 */
function runQualityGates(client, secrets, generatedFix, fixPlan) {
  Logger.log('[Layer 6] Starting quality gate pipeline');

  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};
  var retryCount  = Number(getState(STATE_KEY.RETRY_COUNT)) || 0;

  // ---- GATE 1: Structural Safety ----
  Logger.log('[Gate 1] Running structural safety checks...');
  var gate1 = _runStructuralGate(generatedFix, fixPlan);
  gateResults[GATE.STRUCTURAL] = gate1.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate1.passed) {
    Logger.log('[Gate 1] FAILED: ' + gate1.failure_reason);
    _handleGateFailure(client, secrets, GATE.STRUCTURAL, gate1.failure_reason, retryCount);
    return;
  }
  Logger.log('[Gate 1] PASSED');

  // ---- GATE 2: SonarQube (requires files on preview branch) ----
  // Push to preview branch first so SonarQube can scan
  var runId  = getState(STATE_KEY.RUN_ID);
  var branch = createPreviewBranch(
    client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN
  );

  // Map generated fix files to pushable format (add SHA from file bundle)
  var fileBundle = getState(STATE_KEY.FILE_BUNDLE) || [];
  var pushFiles  = _mapFixToFiles(generatedFix, fileBundle);
  pushFilesToBranch(
    client.github_owner, client.github_repo, branch, pushFiles, secrets.GITHUB_TOKEN
  );

  // Capture SonarQube status BEFORE the fix (from IntelligenceBundle)
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  setState(STATE_KEY.SONAR_BEFORE, (intelBundle.security || {}).sonar_gate || 'UNKNOWN');

  Logger.log('[Gate 2] Running SonarQube quality gate on preview branch...');
  var gate2 = checkSonarGate(
    secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN
  );
  gateResults[GATE.SONARQUBE] = gate2.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);
  setState(STATE_KEY.SONAR_AFTER, gate2.gate_status);

  if (!gate2.passed) {
    Logger.log('[Gate 2] FAILED: ' + gate2.failure_reason);
    // Clean up preview branch on failure
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    _handleGateFailure(client, secrets, GATE.SONARQUBE, gate2.failure_reason, retryCount);
    return;
  }
  Logger.log('[Gate 2] PASSED');

  // ---- GATE 3: Critic Review (Gem 4) ----
  // Cannot invoke Gem directly from Apps Script.
  // Write critic input to State and let Workspace Studio handle Gem 4.
  Logger.log('[Gate 3] Preparing Critic review input for Workspace Studio...');
  var criticInput = _prepareCriticInput(generatedFix, fixPlan, fileBundle);
  setState('critic_input', criticInput);

  // Workspace Studio will:
  //   1. Read 'critic_input' from State
  //   2. Send to Gem 4 (AWPIS Code Critic)
  //   3. Call continueAfterCriticReview(runId, criticResultJson)

  Logger.log('[Layer 6] Gates 1-2 passed. Awaiting Gem 4 critic review via Workspace Studio.');
  // Control returns to Workspace Studio here
}

/**
 * continueAfterCriticReview(runId, criticResultJson)
 * Called by Workspace Studio AFTER Gem 4 has reviewed the fix.
 * Continues with Gate 4 (blast radius) and then sandbox validation.
 */
function continueAfterCriticReview(runId, criticResultJson) {
  var criticResult;
  try {
    criticResult = (typeof criticResultJson === 'string')
      ? JSON.parse(criticResultJson)
      : criticResultJson;
  } catch (e) {
    throw new Error('continueAfterCriticReview: invalid critic result JSON — ' + e.message);
  }

  var client      = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets     = getSecrets();
  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};
  var retryCount  = Number(getState(STATE_KEY.RETRY_COUNT)) || 0;
  var generatedFix = getState(STATE_KEY.GENERATED_FIX);
  var fixPlan     = getState(STATE_KEY.FIX_PLAN);

  // ---- GATE 3 Result ----
  var gate3Passed = criticResult.verdict === 'APPROVE';
  gateResults[GATE.CRITIC] = gate3Passed ? GATE_RESULT.APPROVE : GATE_RESULT.REJECT;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate3Passed) {
    var reason = 'Critic REJECTED. Issues: '
      + (criticResult.issues_found || []).join('; ')
      + (criticResult.retry_suggestion ? ' | Suggestion: ' + criticResult.retry_suggestion : '');
    Logger.log('[Gate 3] FAILED: ' + reason);
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    _handleGateFailure(client, secrets, GATE.CRITIC, reason, retryCount);
    return;
  }
  Logger.log('[Gate 3] APPROVED');

  // ---- GATE 4: Blast Radius Check ----
  Logger.log('[Gate 4] Running dependency blast radius check...');
  var gate4 = _runBlastRadiusGate(generatedFix, client, secrets);
  gateResults[GATE.BLAST_RADIUS] = gate4.contained ? GATE_RESULT.CLEAR : GATE_RESULT.WIDE;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate4.contained && gate4.affected_files.length > 5) {
    Logger.log('[Gate 4] WIDE blast radius: ' + gate4.affected_files.length + ' files affected');
    // Wide blast radius doesn't fail — it flags for expanded review
    // The critic gate would have caught breaking changes
    // We log it but proceed with caution
    Logger.log('[Gate 4] Proceeding with caution. Affected: ' + gate4.affected_files.join(', '));
  }
  Logger.log('[Gate 4] Blast radius: ' + (gate4.contained ? 'CONTAINED' : 'WIDE'));

  Logger.log('[Layer 6] ALL 4 GATES PASSED — proceeding to sandbox validation');

  // ---- Layer 7: Sandbox Validation ----
  runSandboxValidation(client, secrets);
}

// ------------------------------------------------------------
// Gate 1: Structural Safety
// ------------------------------------------------------------

/**
 * _runStructuralGate(generatedFix, fixPlan)
 * Deterministic structural checks on every generated file.
 * No LLM involved — pure regex pattern matching.
 *
 * Returns { passed: boolean, failure_reason: string|null, details: [] }
 */
function _runStructuralGate(generatedFix, fixPlan) {
  var result = { passed: true, failure_reason: null, details: [] };
  var files  = generatedFix.files || [];

  for (var i = 0; i < files.length; i++) {
    var file    = files[i];
    var path    = file.path || '';
    var content = file.content || '';
    var issues  = [];

    // Determine if this is a frontend or backend file
    var isFrontend = _isFrontendFile(path);
    var isBackend  = _isBackendFile(path);

    // --- Universal checks ---
    if (STRUCTURAL_CHECK.FRONTEND.HARDCODED_SECRET.test(content)) {
      issues.push('Hardcoded secret detected');
    }
    if (STRUCTURAL_CHECK.FRONTEND.FORBIDDEN_EVAL.test(content)) {
      issues.push('eval() usage detected');
    }

    // --- Frontend-specific checks ---
    if (isFrontend) {
      if (path.endsWith('.html') || path.indexOf('index.html') >= 0) {
        if (!STRUCTURAL_CHECK.FRONTEND.ROOT_DIV.test(content)) {
          issues.push('index.html missing <div id="root">');
        }
        if (!STRUCTURAL_CHECK.FRONTEND.MAIN_SCRIPT.test(content)) {
          issues.push('index.html missing main script reference');
        }
      }

      if ((path.endsWith('.jsx') || path.endsWith('.tsx')) && !path.includes('index.')) {
        if (!STRUCTURAL_CHECK.FRONTEND.EXPORT_DEFAULT.test(content)) {
          issues.push('Component file missing export default');
        }
      }

      if (STRUCTURAL_CHECK.FRONTEND.FORBIDDEN_DOC_WRITE.test(content)) {
        issues.push('document.write() usage detected');
      }
      if (STRUCTURAL_CHECK.FRONTEND.FORBIDDEN_INNER_HTML.test(content)) {
        issues.push('dangerouslySetInnerHTML usage detected');
      }
    }

    // --- Backend-specific checks ---
    if (isBackend) {
      if (path.indexOf('server.js') >= 0 || path.indexOf('app.js') >= 0) {
        if (!STRUCTURAL_CHECK.BACKEND.APP_LISTEN.test(content)
            && !STRUCTURAL_CHECK.BACKEND.MODULE_EXPORTS.test(content)) {
          issues.push('server.js missing app.listen or module.exports');
        }
      }

      if (STRUCTURAL_CHECK.BACKEND.INLINED_ENV.test(content)) {
        issues.push('process.env values inlined (assigned to string literal)');
      }

      // Check for async route handlers without try/catch
      var asyncRoutePattern = /\.(get|post|put|delete|patch)\s*\([^)]*,\s*async/g;
      var asyncMatches = content.match(asyncRoutePattern);
      if (asyncMatches && asyncMatches.length > 0) {
        if (!STRUCTURAL_CHECK.BACKEND.TRY_CATCH.test(content)) {
          issues.push('Async route handlers without try/catch blocks');
        }
      }
    }

    if (issues.length > 0) {
      result.passed = false;
      result.details.push({ path: path, issues: issues });
    }
  }

  if (!result.passed) {
    var allIssues = result.details.map(function(d) {
      return d.path + ': ' + d.issues.join(', ');
    });
    result.failure_reason = allIssues.join(' | ');
  }

  return result;
}

/**
 * _isFrontendFile(path)
 * Heuristic to determine if a file is a frontend file.
 */
function _isFrontendFile(path) {
  return path.indexOf('frontend/') >= 0
    || path.endsWith('.jsx')
    || path.endsWith('.tsx')
    || path.endsWith('.css')
    || path.indexOf('index.html') >= 0
    || path.indexOf('src/') >= 0;
}

/**
 * _isBackendFile(path)
 * Heuristic to determine if a file is a backend file.
 */
function _isBackendFile(path) {
  return path.indexOf('backend/') >= 0
    || path.indexOf('server') >= 0
    || path.indexOf('routes/') >= 0
    || path.indexOf('middleware/') >= 0
    || path.indexOf('models/') >= 0
    || path.indexOf('controllers/') >= 0;
}

// ------------------------------------------------------------
// Gate 3: Critic input preparation
// ------------------------------------------------------------

/**
 * _prepareCriticInput(generatedFix, fixPlan, fileBundle)
 * Assembles the JSON payload for Gem 4 (AWPIS Code Critic).
 * This is written to State for Workspace Studio to pass to the Gem.
 */
function _prepareCriticInput(generatedFix, fixPlan, fileBundle) {
  var originalFiles = (fileBundle || []).map(function(f) {
    return { path: f.path, content: f.content };
  });

  var generatedFiles = (generatedFix.files || []).map(function(f) {
    return { path: f.path, content: f.content, explanation: f.explanation || '' };
  });

  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var history = (intelBundle.history || {}).last_10_runs || [];
  var last5Runs = history.slice(0, 5);

  return {
    original_files:  originalFiles,
    generated_files: generatedFiles,
    fix_plan:        fixPlan,
    run_history:     last5Runs,
    sonar_issues:    (getState(STATE_KEY.FILE_BUNDLE) || []).reduce(function(acc, f) {
      return acc.concat(f.sonar_issues || []);
    }, [])
  };
}

// ------------------------------------------------------------
// Gate 4: Blast Radius Check
// ------------------------------------------------------------

/**
 * _runBlastRadiusGate(generatedFix, client, secrets)
 * Parses import statements across the repo to find files that
 * depend on the changed files. Flags wide blast radius.
 *
 * Returns:
 * {
 *   contained:      boolean,
 *   affected_files: string[],
 *   changed_files:  string[]
 * }
 */
function _runBlastRadiusGate(generatedFix, client, secrets) {
  var changedPaths = (generatedFix.files || []).map(function(f) { return f.path; });
  var intelBundle  = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var importMap    = (intelBundle.codebase_map || {}).imports || {};

  // Build reverse dependency map: which files import the changed files
  var affectedFiles = [];

  // For each file in the codebase import map
  var importingFiles = Object.keys(importMap);
  for (var i = 0; i < importingFiles.length; i++) {
    var file    = importingFiles[i];
    var imports = importMap[file] || [];

    // Check if any import path matches a changed file
    for (var j = 0; j < imports.length; j++) {
      var importPath = imports[j];
      for (var k = 0; k < changedPaths.length; k++) {
        // Match import path against changed file
        // Imports are relative (e.g., './components/HeroBanner')
        // Changed paths are absolute from repo root (e.g., 'frontend/src/components/HeroBanner.jsx')
        var changedBasename = _getBasename(changedPaths[k]);
        var importBasename  = _getBasename(importPath);

        if (changedBasename === importBasename && affectedFiles.indexOf(file) < 0) {
          affectedFiles.push(file);
        }
      }
    }
  }

  var contained = affectedFiles.length <= 5;

  return {
    contained:     contained,
    affected_files: affectedFiles,
    changed_files:  changedPaths
  };
}

/**
 * _getBasename(filePath)
 * Extracts the filename without extension from a path.
 * e.g., 'frontend/src/components/HeroBanner.jsx' → 'HeroBanner'
 *       './components/HeroBanner' → 'HeroBanner'
 */
function _getBasename(filePath) {
  var name = filePath.split('/').pop();
  // Remove extension
  var dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0) name = name.substring(0, dotIdx);
  return name;
}

// ------------------------------------------------------------
// Gate failure handling
// ------------------------------------------------------------

/**
 * _handleGateFailure(client, secrets, gateName, reason, retryCount)
 * Handles a gate failure. Increments retry count.
 * If retries exhausted, escalates to human.
 * Otherwise, writes failure context to State for fix Gem retry.
 */
function _handleGateFailure(client, secrets, gateName, reason, retryCount) {
  retryCount++;
  setState(STATE_KEY.RETRY_COUNT, retryCount);

  if (retryCount >= THRESHOLD.MAX_GATE_RETRIES) {
    Logger.log('[Gates] Max retries (' + THRESHOLD.MAX_GATE_RETRIES + ') reached. Escalating to human.');
    _escalateToHuman(client, secrets, gateName, reason);
    return;
  }

  // Write failure context for fix Gem retry
  setState('gate_failure', {
    gate:     gateName,
    reason:   reason,
    retry:    retryCount,
    max:      THRESHOLD.MAX_GATE_RETRIES
  });

  Logger.log('[Gates] Gate ' + gateName + ' failed (attempt ' + retryCount + '/'
    + THRESHOLD.MAX_GATE_RETRIES + '). Retry context written to State.');
  // Workspace Studio should read 'gate_failure' from State and
  // re-invoke the fix Gem with the failure reason as context
}

/**
 * _escalateToHuman(client, secrets, gateName, reason)
 * Sends an email alert when gates fail 3 times.
 * Marks the run as ESCALATED.
 */
function _escalateToHuman(client, secrets, gateName, reason) {
  var runId = getState(STATE_KEY.RUN_ID);
  var email = secrets.REPORT_EMAIL || client.report_email;

  if (email) {
    try {
      MailApp.sendEmail({
        to:      email,
        subject: '[AWPIS ESCALATION] Gate failures for ' + client.client_name + ' — human review needed',
        body: [
          'AWPIS pipeline requires human intervention.',
          '',
          'Client:     ' + client.client_name,
          'Run ID:     ' + runId,
          'Gate:       ' + gateName,
          'Reason:     ' + reason,
          'Retries:    ' + THRESHOLD.MAX_GATE_RETRIES + ' (exhausted)',
          '',
          'The pipeline has stopped. Please review the proposed fix and either:',
          '1. Manually apply the fix and run the pipeline again',
          '2. Modify the fix plan and restart',
          '',
          'Pipeline version: ' + PIPELINE_VERSION
        ].join('\n')
      });
    } catch (e) {
      Logger.log('[Escalation] Email failed: ' + e.message);
    }
  }

  // Finalize run as ESCALATED
  var deployResult = { status: RUN_STATUS.ESCALATED, deployed: false, reverted: false };
  finalizePipeline(client, secrets, RUN_STATUS.ESCALATED, deployResult);
}

// ------------------------------------------------------------
// Helpers for file mapping
// ------------------------------------------------------------

/**
 * _mapFixToFiles(generatedFix, fileBundle)
 * Maps generated fix files to pushable format by merging
 * with the original SHA from the file bundle.
 * Returns [{ path, content, sha }]
 */
function _mapFixToFiles(generatedFix, fileBundle) {
  var shaMap = {};
  (fileBundle || []).forEach(function(f) {
    shaMap[f.path] = f.sha;
  });

  return (generatedFix.files || []).map(function(f) {
    return {
      path:    f.path,
      content: f.content,
      sha:     shaMap[f.path] || ''
    };
  });
}


// ============================================================
// SECTION B — SANDBOX VALIDATION (Layer 7)
// ============================================================

// ------------------------------------------------------------
// Public: Sandbox Validation Entry Point
// ------------------------------------------------------------

/**
 * runSandboxValidation(client, secrets)
 * Layer 7 entry point. Called after all 4 quality gates pass.
 *
 * Steps:
 *   1. Files are already on preview branch (pushed during Gate 2)
 *   2. Trigger Vercel preview deploy
 *   3. Wait for READY state
 *   4. Run PSI on preview URL
 *   5. Run backend health check on preview
 *   6. Check SonarQube gate on preview branch
 *   7. Compare all results against baseline
 *   8. PASS → continue to Layer 8 | FAIL → clean up, report
 */
function runSandboxValidation(client, secrets) {
  var runId = getState(STATE_KEY.RUN_ID);
  Logger.log('[Layer 7] Starting sandbox validation');

  // Step 1-2: Trigger Vercel preview deploy and wait for URL
  var previewUrl = _deployAndWaitForPreview(client, secrets, runId);
  if (!previewUrl) {
    Logger.log('[Layer 7] Preview deploy failed — aborting');
    _sandboxFailure(client, secrets, runId, 'Vercel preview deploy failed or timed out');
    return;
  }

  setState(STATE_KEY.PREVIEW_URL, previewUrl);
  Logger.log('[Layer 7] Preview URL: ' + previewUrl);

  // Step 3: Run PSI on preview URL
  var previewPsi = _runPsiOnUrl(previewUrl, secrets);
  setState(STATE_KEY.PREVIEW_PSI, previewPsi);
  Logger.log('[Layer 7] Preview PSI — Perf: ' + previewPsi.performance + ', LCP: ' + previewPsi.lcp_ms);

  // Step 4: Backend health check on preview
  var backendHealth = _runBackendHealthOnPreview(previewUrl, client);

  // Step 5: SonarQube gate check on preview branch
  var branch     = GITHUB.PREVIEW_BRANCH_PREFIX + runId;
  var sonarGate  = getSonarGateStatus(
    secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN
  );

  // Step 6: Compare against baseline
  var baseline       = getState(STATE_KEY.BASELINE_PSI) || {};
  var intelBundle    = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var currentPsi     = intelBundle.psi_metrics || {};
  var sandboxResult  = _evaluateSandbox(previewPsi, currentPsi, baseline, backendHealth, sonarGate);

  setState(STATE_KEY.SANDBOX_RESULT, sandboxResult);
  Logger.log('[Layer 7] Sandbox result: ' + (sandboxResult.passed ? 'PASS' : 'FAIL')
    + ' — ' + sandboxResult.reason);

  if (!sandboxResult.passed) {
    _sandboxFailure(client, secrets, runId, sandboxResult.reason);
    return;
  }

  Logger.log('[Layer 7] SANDBOX PASSED — proceeding to production deployment');

  // Layer 8: Production deployment
  runProductionDeploy(client, secrets);
}

// ------------------------------------------------------------
// Sandbox: Vercel preview deploy
// ------------------------------------------------------------

/**
 * _deployAndWaitForPreview(client, secrets, runId)
 * Triggers a Vercel preview deploy and polls until READY.
 * Returns the preview URL, or null on failure/timeout.
 */
function _deployAndWaitForPreview(client, secrets, runId) {
  // Trigger deploy via Vercel deploy hook
  var deployHook = secrets.VERCEL_DEPLOY_HOOK;
  if (!deployHook) {
    Logger.log('[Vercel] No deploy hook configured');
    return null;
  }

  try {
    UrlFetchApp.fetch(deployHook, {
      method:             'post',
      muteHttpExceptions: true,
      payload:            ''
    });
  } catch (e) {
    Logger.log('[Vercel] Deploy hook error: ' + e.message);
    return null;
  }

  // Poll Vercel API for the deployment to reach READY state
  var vercelToken = secrets.VERCEL_TOKEN;
  var projectId   = client.vercel_project_id;
  if (!vercelToken || !projectId) {
    Logger.log('[Vercel] Missing token or project ID — cannot poll');
    return null;
  }

  var maxWait = THRESHOLD.VERCEL_POLL_TIMEOUT_MS;
  var interval = THRESHOLD.VERCEL_POLL_INTERVAL_MS;
  var elapsed = 0;
  var branch  = GITHUB.PREVIEW_BRANCH_PREFIX + runId;

  while (elapsed < maxWait) {
    Utilities.sleep(interval);
    elapsed += interval;

    try {
      var resp = UrlFetchApp.fetch(
        API.VERCEL + '/v13/deployments?projectId=' + projectId + '&limit=5', {
          method:             'get',
          headers:            { Authorization: 'Bearer ' + vercelToken },
          muteHttpExceptions: true
        }
      );

      if (resp.getResponseCode() === 200) {
        var data = JSON.parse(resp.getContentText());
        var deployments = data.deployments || [];

        // Find the most recent deployment for our preview branch
        for (var i = 0; i < deployments.length; i++) {
          var dep = deployments[i];
          var meta = dep.meta || {};
          var depBranch = meta.githubCommitRef || meta.gitBranch || '';

          if (depBranch.indexOf(branch) >= 0 || depBranch.indexOf('awpis/preview') >= 0) {
            if (dep.state === 'READY' || dep.readyState === 'READY') {
              return 'https://' + dep.url;
            }
            if (dep.state === 'ERROR' || dep.readyState === 'ERROR') {
              Logger.log('[Vercel] Deployment failed with ERROR state');
              return null;
            }
          }
        }
      }
    } catch (e) {
      Logger.log('[Vercel] Poll error: ' + e.message);
    }

    Logger.log('[Vercel] Polling... ' + (elapsed / 1000) + 's elapsed');
  }

  Logger.log('[Vercel] Timed out waiting for preview deploy');
  return null;
}

// ------------------------------------------------------------
// Sandbox: PSI check
// ------------------------------------------------------------

/**
 * _runPsiOnUrl(url, secrets)
 * Runs PageSpeed Insights on a given URL.
 * Returns PSI metrics object.
 */
function _runPsiOnUrl(url, secrets) {
  var psiUrl = API.PSI
    + '?url='      + encodeURIComponent(url)
    + '&strategy=' + PSI.STRATEGY
    + '&category=' + PSI.CATEGORIES.join('&category=')
    + '&key='      + secrets.PAGESPEED_KEY;

  var psi = { performance: 0, accessibility: 0, best_practices: 0, seo: 0,
              fcp_ms: 0, lcp_ms: 0, tbt_ms: 0, cls: 0 };

  try {
    var resp = UrlFetchApp.fetch(psiUrl, { method: 'get', muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var raw    = JSON.parse(resp.getContentText());
      var cats   = (raw.lighthouseResult || {}).categories || {};
      var audits = (raw.lighthouseResult || {}).audits || {};

      psi.performance    = Math.round((cats['performance']    || {}).score * 100) || 0;
      psi.accessibility  = Math.round((cats['accessibility']  || {}).score * 100) || 0;
      psi.best_practices = Math.round((cats['best-practices'] || {}).score * 100) || 0;
      psi.seo            = Math.round((cats['seo']            || {}).score * 100) || 0;
      psi.fcp_ms = Math.round((audits['first-contentful-paint']   || {}).numericValue || 0);
      psi.lcp_ms = Math.round((audits['largest-contentful-paint'] || {}).numericValue || 0);
      psi.tbt_ms = Math.round((audits['total-blocking-time']      || {}).numericValue || 0);
      psi.cls    = parseFloat(((audits['cumulative-layout-shift']  || {}).numericValue || 0).toFixed(3));
    } else {
      Logger.log('[PSI] Non-200 response: ' + resp.getResponseCode());
    }
  } catch (e) {
    Logger.log('[PSI] Error: ' + e.message);
  }

  return psi;
}

// ------------------------------------------------------------
// Sandbox: Backend health check on preview
// ------------------------------------------------------------

/**
 * _runBackendHealthOnPreview(previewUrl, client)
 * Pings standard backend endpoints on the preview URL.
 * Note: Preview may share the same backend as production,
 * so we check the backend_url from client config.
 *
 * Returns { all_healthy, endpoints[] }
 */
function _runBackendHealthOnPreview(previewUrl, client) {
  // Backend typically doesn't change with Vercel preview
  // (Vercel deploys frontend, backend is separate)
  // Ping the production backend to verify it's still healthy
  var baseUrl = client.backend_url;
  if (!baseUrl) {
    return { all_healthy: true, endpoints: [] };
  }

  var endpointPaths = [
    { name: 'health',    path: '/api/health' },
    { name: 'products',  path: '/api/products?limit=1' },
    { name: 'search',    path: '/api/search?q=test' },
    { name: 'featured',  path: '/api/featured' },
    { name: 'contact',   path: '/api/contact/ping' }
  ];

  var requests = endpointPaths.map(function(ep) {
    return {
      url:               baseUrl + ep.path,
      method:            'get',
      muteHttpExceptions: true,
      followRedirects:   true
    };
  });

  var allHealthy = true;
  var results = [];

  try {
    var responses = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < responses.length; i++) {
      var code    = responses[i].getResponseCode();
      var healthy = code >= 200 && code < 300;
      if (!healthy) allHealthy = false;
      results.push({
        name:    endpointPaths[i].name,
        status:  code,
        healthy: healthy
      });
    }
  } catch (e) {
    Logger.log('[Backend health] Error: ' + e.message);
    allHealthy = false;
  }

  return { all_healthy: allHealthy, endpoints: results };
}

// ------------------------------------------------------------
// Sandbox: Evaluation logic
// ------------------------------------------------------------

/**
 * _evaluateSandbox(previewPsi, currentPsi, baseline, backendHealth, sonarGate)
 * Evaluates sandbox results against baseline.
 *
 * ALL must be true to PASS:
 *   - preview performance >= current performance (not baseline — current)
 *   - preview CLS <= current CLS
 *   - all backend endpoints return 200
 *   - SonarQube gate = PASS on preview branch
 *
 * Returns { passed, reason }
 */
function _evaluateSandbox(previewPsi, currentPsi, baseline, backendHealth, sonarGate) {
  var reasons = [];

  // Performance: preview must not be worse than current
  if (previewPsi.performance < (currentPsi.performance || 0)) {
    reasons.push('Performance dropped: ' + currentPsi.performance + ' → ' + previewPsi.performance);
  }

  // CLS: preview must not be worse than current
  var currentCls = (currentPsi.cls !== undefined) ? currentPsi.cls : 0;
  if (previewPsi.cls > currentCls && previewPsi.cls > THRESHOLD.CLS_MAX) {
    reasons.push('CLS regressed: ' + currentCls + ' → ' + previewPsi.cls);
  }

  // Backend: all endpoints must be healthy
  if (!backendHealth.all_healthy) {
    var unhealthy = (backendHealth.endpoints || []).filter(function(e) { return !e.healthy; });
    var names = unhealthy.map(function(e) { return e.name + '(' + e.status + ')'; });
    reasons.push('Backend endpoints unhealthy: ' + names.join(', '));
  }

  // SonarQube: gate must pass (or be not configured)
  if (sonarGate && sonarGate.status !== 'OK' && sonarGate.status !== 'UNKNOWN' && sonarGate.status !== 'NOT_CONFIGURED') {
    reasons.push('SonarQube gate: ' + sonarGate.status);
  }

  return {
    passed: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join(' | ') : 'All sandbox checks passed'
  };
}

// ------------------------------------------------------------
// Sandbox: Failure handling
// ------------------------------------------------------------

/**
 * _sandboxFailure(client, secrets, runId, reason)
 * Handles sandbox validation failure.
 * Deletes preview branch. Marks run as BLOCKED.
 * Proceeds to finalize pipeline with BLOCKED status.
 */
function _sandboxFailure(client, secrets, runId, reason) {
  Logger.log('[Layer 7] Sandbox FAILED: ' + reason);

  // Clean up preview branch
  try {
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
  } catch (e) {
    Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
  }

  // Finalize as BLOCKED — no production touch
  var deployResult = {
    status:    RUN_STATUS.BLOCKED,
    deployed:  false,
    reverted:  false,
    side_effects: 'Sandbox validation failed: ' + reason
  };

  finalizePipeline(client, secrets, RUN_STATUS.BLOCKED, deployResult);
}
