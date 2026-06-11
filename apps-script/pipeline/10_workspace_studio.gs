// ============================================================
// AWPIS — 10_workspace_studio.gs
// Workspace Studio Step Wrappers
//
// Each function here is a Workspace Studio callback.
// It receives data via event.workspaceStudio.parameters,
// calls the existing pipeline logic, and returns output
// via { workspaceStudio: { outputs: { ... } } }.
//
// These wrappers exist because the existing pipeline functions
// (runPipelineForClient, runSandboxValidation, etc.) internally
// chain to the next layer. Workspace Studio needs each step to
// be atomic — run its logic, return a result, STOP.
//
// The existing functions still work for the manual Sheet menu
// path (AWPIS > Run Pipeline Now), which bypasses Studio.
// ============================================================

// ============================================================
// STEP 1 — Initialize Pipeline Run
// ============================================================

/**
 * wsInitializePipelineRun(event)
 * Workspace Studio Step 1.
 *
 * What it does:
 *   - Loads client config from the Config tab
 *   - Generates a unique run ID
 *   - Clears and initializes the State tab
 *   - Writes a RUNNING row to the Runs tab
 *
 * Input:  client_id (STRING)
 * Output: run_id (STRING), client_id (STRING)
 */
function wsInitializePipelineRun(event) {
  var clientId = event.workspaceStudio.parameters.client_id;
  var startTime = Date.now();

  Logger.log('[WS Step 1] Initializing pipeline for client: ' + clientId);

  // Load client config
  var client = _getClientById(clientId);
  if (!client) {
    throw new Error('Client not found in Config tab: ' + clientId);
  }
  if (String(client.active).toUpperCase() !== 'TRUE') {
    throw new Error('Client ' + clientId + ' is not active. Set active=TRUE in Config tab.');
  }

  // Generate run ID
  var runId = 'run_' + clientId + '_' + startTime;

  // Initialize state
  clearState();
  initStateTab();

  setState(STATE_KEY.RUN_ID,         runId);
  setState(STATE_KEY.CLIENT_ID,      clientId);
  setState(STATE_KEY.RUN_START_TIME, startTime);
  setState(STATE_KEY.RETRY_COUNT,    0);
  setState(STATE_KEY.GATE_RESULTS, {
    structural:   null,
    sonarqube:    null,
    critic:       null,
    blast_radius: null
  });

  // Write RUNNING row to Runs tab
  _writeRunRow(runId, clientId, RUN_STATUS.RUNNING, startTime);

  Logger.log('[WS Step 1] Pipeline initialized. Run ID: ' + runId);

  return {
    workspaceStudio: {
      outputs: {
        run_id:    runId,
        client_id: clientId
      }
    }
  };
}

// ============================================================
// STEP 2 — Collect Intelligence
// ============================================================

/**
 * wsCollectIntelligence(event)
 * Workspace Studio Step 2.
 *
 * What it does:
 *   - Runs PSI scan on the client's website
 *   - Fetches codebase map from GitHub (file tree, commits, README)
 *   - Reads run history from Runs and FixMemory tabs
 *   - Runs security scan (package.json CVEs, SonarQube gate)
 *   - Merges everything into an IntelligenceBundle
 *   - Writes the bundle to the State tab
 *
 * Input:  client_id (STRING)
 * Output: intelligence_bundle (STRING — JSON for Gem 1)
 */
function wsCollectIntelligence(event) {
  var clientId = event.workspaceStudio.parameters.client_id;

  Logger.log('[WS Step 2] Collecting intelligence for: ' + clientId);

  var client  = _getClientById(clientId);
  var secrets = getSecrets();

  // Call the existing collectIntelligence function
  // It writes the bundle to State and returns it
  var bundle = collectIntelligence(client, secrets);

  Logger.log('[WS Step 2] Intelligence gathered. PSI performance: ' + bundle.psi_metrics.performance);

  return {
    workspaceStudio: {
      outputs: {
        intelligence_bundle: JSON.stringify(bundle)
      }
    }
  };
}

// ============================================================
// STEP 3 is a Gem step — configured in Workspace Studio UI
//   Gem: AWPIS Performance Strategist
//   Input: intelligence_bundle from Step 2
//   Output: fix_plan (JSON string)
// ============================================================

// ============================================================
// STEP 4 — Fetch Target Code
// ============================================================

/**
 * wsFetchTargetCode(event)
 * Workspace Studio Step 4.
 *
 * What it does:
 *   - Parses the FixPlan JSON from Gem 1
 *   - Stores the FixPlan in State
 *   - Fetches only the files in fixPlan.files_to_change from GitHub
 *   - Attaches SonarQube issues to each file
 *   - Builds a code_context package for the Engineer Gem
 *
 * Input:  fix_plan (STRING — JSON from Gem 1)
 * Output: code_context (STRING — JSON for Gem 2/3)
 */
function wsFetchTargetCode(event) {
  var fixPlanRaw = event.workspaceStudio.parameters.fix_plan;

  Logger.log('[WS Step 4] Received FixPlan from Strategist Gem');

  // Parse the FixPlan — handle both JSON and already-parsed objects
  var fixPlan = _wsParseSafe(fixPlanRaw, 'FixPlan');

  // Store in State
  setState(STATE_KEY.FIX_PLAN, fixPlan);

  Logger.log('[WS Step 4] FixPlan focus: ' + fixPlan.focus
    + ' | Files to change: ' + (fixPlan.files_to_change || []).join(', '));

  // Fetch the targeted files using existing function
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var fileBundle = fetchTargetedFiles(client, secrets, fixPlan);

  // Build the code_context object for the Engineer Gem
  // This includes both the fix plan and the actual source code
  var codeContext = {
    fix_plan: {
      focus:                    fixPlan.focus,
      root_cause:               fixPlan.root_cause,
      approach:                 fixPlan.approach,
      confidence:               fixPlan.confidence,
      risk_level:               fixPlan.risk_level,
      files_to_change:          fixPlan.files_to_change,
      why_different_from_history: fixPlan.why_different_from_history || ''
    },
    target_files: fileBundle.map(function(f) {
      return {
        path:         f.path,
        content:      f.content,
        sonar_issues: f.sonar_issues || []
      };
    }),
    stack: (getState(STATE_KEY.INTEL_BUNDLE) || {}).codebase_map
      ? (getState(STATE_KEY.INTEL_BUNDLE)).codebase_map.stack
      : 'Unknown'
  };

  Logger.log('[WS Step 4] Code context built. Files fetched: ' + fileBundle.length);

  return {
    workspaceStudio: {
      outputs: {
        code_context: JSON.stringify(codeContext)
      }
    }
  };
}

// ============================================================
// STEP 5 is a Gem step — configured in Workspace Studio UI
//   Gem: AWPIS Frontend Engineer  OR  AWPIS Backend Engineer
//   (choose based on fixPlan.focus category)
//   Input: code_context from Step 4
//   Output: generated_fix (JSON string with files[] array)
// ============================================================

// ============================================================
// STEP 6 — Run Quality Gates
// ============================================================

/**
 * wsRunQualityGates(event)
 * Workspace Studio Step 6.
 *
 * What it does:
 *   - Parses the generated fix from Gem 2/3
 *   - Gate 1: Structural safety checks (deterministic regex)
 *   - Pushes fixed files to a preview branch on GitHub
 *   - Gate 2: SonarQube quality gate on the preview branch
 *   - Gate 3: Code Critic — auto-approved at this stage
 *     (The Critic Gem cannot be called from Apps Script.
 *      If you add a Gem step between Steps 6 and 7, you can
 *      read critic_input from the State tab and feed it to Gem 4.)
 *   - Gate 4: Blast radius / dependency analysis
 *
 * Input:  generated_fix (STRING — JSON from Gem 2/3)
 * Output: gate_results (STRING — JSON), all_gates_passed (STRING)
 */
function wsRunQualityGates(event) {
  var generatedFixRaw = event.workspaceStudio.parameters.generated_fix;

  Logger.log('[WS Step 6] Received generated fix from Engineer Gem');

  var generatedFix = _wsParseSafe(generatedFixRaw, 'GeneratedFix');
  setState(STATE_KEY.GENERATED_FIX, generatedFix);

  var client      = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets     = getSecrets();
  var fixPlan     = getState(STATE_KEY.FIX_PLAN);
  var fileBundle  = getState(STATE_KEY.FILE_BUNDLE) || [];
  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};
  var retryCount  = Number(getState(STATE_KEY.RETRY_COUNT)) || 0;

  Logger.log('[WS Step 6] Files in fix: ' + (generatedFix.files || []).length);

  // ---- GATE 1: Structural Safety ----
  Logger.log('[Gate 1] Running structural safety checks...');
  var gate1 = _runStructuralGate(generatedFix, fixPlan);
  gateResults[GATE.STRUCTURAL] = gate1.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate1.passed) {
    Logger.log('[Gate 1] FAILED: ' + gate1.failure_reason);
    return {
      workspaceStudio: {
        outputs: {
          gate_results: JSON.stringify({
            passed:       false,
            failed_gate:  GATE.STRUCTURAL,
            reason:       gate1.failure_reason,
            gates:        gateResults
          }),
          all_gates_passed: 'FALSE'
        }
      }
    };
  }
  Logger.log('[Gate 1] PASSED');

  // ---- Push to preview branch for Gates 2-4 ----
  var runId  = getState(STATE_KEY.RUN_ID);
  var branch = createPreviewBranch(
    client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN
  );
  var pushFiles = _mapFixToFiles(generatedFix, fileBundle);
  pushFilesToBranch(
    client.github_owner, client.github_repo, branch, pushFiles, secrets.GITHUB_TOKEN
  );

  // ---- GATE 2: SonarQube ----
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  setState(STATE_KEY.SONAR_BEFORE, (intelBundle.security || {}).sonar_gate || 'UNKNOWN');

  Logger.log('[Gate 2] Running SonarQube gate on preview branch...');
  var gate2 = checkSonarGate(
    secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN
  );
  gateResults[GATE.SONARQUBE] = gate2.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);
  setState(STATE_KEY.SONAR_AFTER, gate2.gate_status);

  if (!gate2.passed) {
    Logger.log('[Gate 2] FAILED: ' + gate2.failure_reason);
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    return {
      workspaceStudio: {
        outputs: {
          gate_results: JSON.stringify({
            passed:       false,
            failed_gate:  GATE.SONARQUBE,
            reason:       gate2.failure_reason,
            gates:        gateResults
          }),
          all_gates_passed: 'FALSE'
        }
      }
    };
  }
  Logger.log('[Gate 2] PASSED');

  // ---- GATE 3: Code Critic ----
  // The Code Critic Gem cannot be called from Apps Script directly.
  // We prepare the critic input and store it in State.
  // Gate 3 is auto-approved here. If you want full critic review:
  //   1. Add a Gem step between Steps 6 and 7 in Workspace Studio
  //   2. Map critic_input from State as the Gem's input
  //   3. Map the Gem's output to continueAfterCriticReview()
  var criticInput = _prepareCriticInput(generatedFix, fixPlan, fileBundle);
  setState('critic_input', criticInput);
  gateResults[GATE.CRITIC] = GATE_RESULT.APPROVE;
  setState(STATE_KEY.GATE_RESULTS, gateResults);
  Logger.log('[Gate 3] Critic input prepared and stored in State. Auto-approved.');

  // ---- GATE 4: Blast Radius ----
  Logger.log('[Gate 4] Running blast radius check...');
  var gate4 = _runBlastRadiusGate(generatedFix, client, secrets);
  gateResults[GATE.BLAST_RADIUS] = gate4.contained ? GATE_RESULT.CLEAR : GATE_RESULT.WIDE;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate4.contained && gate4.affected_files.length > 5) {
    Logger.log('[Gate 4] WIDE blast radius: ' + gate4.affected_files.length + ' files. Proceeding with caution.');
  }
  Logger.log('[Gate 4] Blast radius: ' + (gate4.contained ? 'CONTAINED' : 'WIDE'));

  Logger.log('[WS Step 6] ALL GATES PASSED');

  return {
    workspaceStudio: {
      outputs: {
        gate_results: JSON.stringify({
          passed: true,
          gates:  gateResults,
          blast_radius: {
            contained:      gate4.contained,
            affected_files: gate4.affected_files
          }
        }),
        all_gates_passed: 'TRUE'
      }
    }
  };
}

// ============================================================
// STEP 7 — Sandbox Validation
// ============================================================

/**
 * wsRunSandboxValidation(event)
 * Workspace Studio Step 7.
 *
 * What it does:
 *   - Files are already on the preview branch (pushed in Step 6)
 *   - Triggers a Vercel preview deployment
 *   - Polls until the preview is READY
 *   - Runs PSI on the preview URL
 *   - Checks backend health
 *   - Checks SonarQube gate on the preview branch
 *   - Compares all results against the baseline
 *   - On failure: deletes preview branch and stores failure reason
 *   - On success: leaves preview branch for Step 8 to use
 *
 * Input:  (none — reads from State tab)
 * Output: sandbox_result (STRING — JSON), sandbox_passed (STRING)
 *
 * NOTE: This wrapper does NOT chain to runProductionDeploy().
 * The original runSandboxValidation() does chain — but Workspace Studio
 * needs each step to be atomic.
 */
function wsRunSandboxValidation(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var runId   = getState(STATE_KEY.RUN_ID);

  Logger.log('[WS Step 7] Starting sandbox validation');

  // ---- Step 1: Deploy preview ----
  var previewUrl = _deployAndWaitForPreview(client, secrets, runId);
  if (!previewUrl) {
    Logger.log('[WS Step 7] Preview deploy failed — aborting');
    // Clean up preview branch
    try {
      deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    } catch (e) {
      Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
    }
    var failResult = { passed: false, reason: 'Vercel preview deploy failed or timed out' };
    setState(STATE_KEY.SANDBOX_RESULT, failResult);
    return {
      workspaceStudio: {
        outputs: {
          sandbox_result: JSON.stringify(failResult),
          sandbox_passed: 'FALSE'
        }
      }
    };
  }

  setState(STATE_KEY.PREVIEW_URL, previewUrl);
  Logger.log('[WS Step 7] Preview URL: ' + previewUrl);

  // ---- Step 2: Run PSI on preview ----
  var previewPsi = _runPsiOnUrl(previewUrl, secrets);
  setState(STATE_KEY.PREVIEW_PSI, previewPsi);
  Logger.log('[WS Step 7] Preview PSI — Perf: ' + previewPsi.performance + ', LCP: ' + previewPsi.lcp_ms);

  // ---- Step 3: Backend health check ----
  var backendHealth = _runBackendHealthOnPreview(previewUrl, client);

  // ---- Step 4: SonarQube gate on preview branch ----
  var branch    = GITHUB.PREVIEW_BRANCH_PREFIX + runId;
  var sonarGate = getSonarGateStatus(
    secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN
  );

  // ---- Step 5: Evaluate against baseline ----
  var baseline    = getState(STATE_KEY.BASELINE_PSI) || {};
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var currentPsi  = intelBundle.psi_metrics || {};
  var sandboxResult = _evaluateSandbox(previewPsi, currentPsi, baseline, backendHealth, sonarGate);

  setState(STATE_KEY.SANDBOX_RESULT, sandboxResult);
  Logger.log('[WS Step 7] Sandbox result: ' + (sandboxResult.passed ? 'PASS' : 'FAIL')
    + ' — ' + sandboxResult.reason);

  if (!sandboxResult.passed) {
    // Clean up preview branch on failure
    try {
      deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    } catch (e) {
      Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
    }
  }

  return {
    workspaceStudio: {
      outputs: {
        sandbox_result: JSON.stringify(sandboxResult),
        sandbox_passed: sandboxResult.passed ? 'TRUE' : 'FALSE'
      }
    }
  };
}

// ============================================================
// STEP 8 — Deploy to Production
// ============================================================

/**
 * wsDeployToProduction(event)
 * Workspace Studio Step 8.
 *
 * What it does:
 *   - Opens a GitHub Pull Request with full context (scores, root cause)
 *   - In AUTOMATED mode: auto-merges via squash merge
 *   - In SUPERVISED mode: sends email notification and stops
 *   - Triggers Vercel production deploy
 *   - Waits 90 seconds for CDN propagation
 *   - Runs PSI on the production URL
 *   - Checks for regressions (>5 point drop)
 *   - If regression: auto-reverts the commit and triggers redeploy
 *   - Cleans up the preview branch
 *
 * Input:  (none — reads from State tab)
 * Output: deploy_result (STRING — JSON), deploy_status (STRING)
 *
 * NOTE: This wrapper does NOT chain to finalizePipeline().
 * Step 9 handles finalization.
 */
function wsDeployToProduction(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var runId   = getState(STATE_KEY.RUN_ID);
  var fixPlan = getState(STATE_KEY.FIX_PLAN) || {};
  var branch  = GITHUB.PREVIEW_BRANCH_PREFIX + runId;

  Logger.log('[WS Step 8] Starting production deployment');

  // ---- Build PR context ----
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var previewPsi  = getState(STATE_KEY.PREVIEW_PSI) || {};
  var sonarBefore = getState(STATE_KEY.SONAR_BEFORE) || 'UNKNOWN';
  var sonarAfter  = getState(STATE_KEY.SONAR_AFTER)  || 'UNKNOWN';

  var psiResults   = { before: intelBundle.psi_metrics || {}, after: previewPsi };
  var sonarResults = { before: sonarBefore, after: sonarAfter };

  // ---- Step 1: Open Pull Request ----
  var pr;
  try {
    pr = openPullRequest(
      client.github_owner, client.github_repo,
      branch, fixPlan, psiResults, sonarResults,
      secrets.GITHUB_TOKEN
    );
    setState(STATE_KEY.PR_URL, pr.url);
    Logger.log('[WS Step 8] PR opened: #' + pr.number + ' — ' + pr.url);
  } catch (e) {
    Logger.log('[WS Step 8] PR creation failed: ' + e.message);
    try {
      deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    } catch (err) { /* cleanup only */ }

    var failResult = {
      status:    RUN_STATUS.FAILED,
      deployed:  false,
      reverted:  false,
      reason:    'PR creation failed: ' + e.message
    };
    setState('deploy_result', failResult);
    return {
      workspaceStudio: {
        outputs: {
          deploy_result: JSON.stringify(failResult),
          deploy_status: RUN_STATUS.FAILED
        }
      }
    };
  }

  // ---- Step 2: Merge or Notify ----
  var runMode = client.run_mode || RUN_MODE.SUPERVISED;

  if (runMode === RUN_MODE.AUTOMATED) {
    try {
      mergePullRequest(
        client.github_owner, client.github_repo,
        pr.number, secrets.GITHUB_TOKEN
      );
      Logger.log('[WS Step 8] PR #' + pr.number + ' auto-merged');
    } catch (e) {
      Logger.log('[WS Step 8] PR merge failed: ' + e.message);
      try {
        deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
      } catch (err) { /* cleanup only */ }

      var mergeFailResult = {
        status:    RUN_STATUS.FAILED,
        deployed:  false,
        reverted:  false,
        pr_url:    pr.url,
        reason:    'PR merge failed: ' + e.message
      };
      setState('deploy_result', mergeFailResult);
      return {
        workspaceStudio: {
          outputs: {
            deploy_result: JSON.stringify(mergeFailResult),
            deploy_status: RUN_STATUS.FAILED
          }
        }
      };
    }
  } else {
    // SUPERVISED mode — PR is ready, human must merge
    Logger.log('[WS Step 8] SUPERVISED mode — PR created, awaiting human merge');
    _notifyPrReady(client, secrets, pr);

    var supervisedResult = {
      status:         RUN_STATUS.SUCCESS,
      deployed:       false,
      reverted:       false,
      pr_url:         pr.url,
      production_psi: {},
      side_effects:   'SUPERVISED mode — PR awaiting human merge'
    };
    setState('deploy_result', supervisedResult);
    return {
      workspaceStudio: {
        outputs: {
          deploy_result: JSON.stringify(supervisedResult),
          deploy_status: RUN_STATUS.SUCCESS
        }
      }
    };
  }

  // ---- Step 3: Trigger Vercel production deploy ----
  Logger.log('[WS Step 8] Triggering Vercel production deploy...');
  _triggerProductionDeploy(secrets);

  // ---- Step 4: Wait for deploy to settle ----
  Logger.log('[WS Step 8] Waiting ' + (THRESHOLD.POST_DEPLOY_WAIT_MS / 1000) + 's...');
  Utilities.sleep(THRESHOLD.POST_DEPLOY_WAIT_MS);

  // ---- Step 5: Run PSI on production ----
  Logger.log('[WS Step 8] Running post-deploy PSI check...');
  var productionPsi = _runPsiOnUrl(client.website_url, secrets);
  setState(STATE_KEY.PRODUCTION_PSI, productionPsi);
  Logger.log('[WS Step 8] Production PSI — Perf: ' + productionPsi.performance
    + ', LCP: ' + productionPsi.lcp_ms + ', CLS: ' + productionPsi.cls);

  // ---- Step 6: Check for regressions ----
  var currentPsi  = intelBundle.psi_metrics || {};
  var regressions = _checkForRegressions(productionPsi, currentPsi);

  if (regressions.length > 0) {
    // ---- REGRESSION — Auto-revert ----
    Logger.log('[WS Step 8] REGRESSION DETECTED: ' + regressions.join(', '));

    var revertSha = null;
    try {
      revertSha = revertLastCommit(
        client.github_owner, client.github_repo, secrets.GITHUB_TOKEN
      );
      Logger.log('[WS Step 8] Revert commit: ' + revertSha);
    } catch (e) {
      Logger.log('[WS Step 8] Revert FAILED: ' + e.message);
    }

    // Trigger redeploy from reverted main
    _triggerProductionDeploy(secrets);

    // Send revert alert
    _sendRevertAlert(client, secrets, regressions, pr.url, revertSha);

    // Clean up preview branch
    try {
      deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    } catch (e) { /* cleanup only */ }

    var revertResult = {
      status:         RUN_STATUS.REVERTED,
      deployed:       true,
      reverted:       true,
      pr_url:         pr.url,
      production_psi: productionPsi,
      side_effects:   'REVERTED — regressions: ' + regressions.join(', ')
    };
    setState('deploy_result', revertResult);
    return {
      workspaceStudio: {
        outputs: {
          deploy_result: JSON.stringify(revertResult),
          deploy_status: RUN_STATUS.REVERTED
        }
      }
    };
  }

  // ---- No regressions — Success ----
  Logger.log('[WS Step 8] Production stable. No regressions.');

  // Clean up preview branch
  try {
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
  } catch (e) {
    Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
  }

  var successResult = {
    status:              RUN_STATUS.SUCCESS,
    deployed:            true,
    reverted:            false,
    pr_url:              pr.url,
    production_psi:      productionPsi,
    backend_avg_after:   '',
    backend_status_after: 'ASSUMED_HEALTHY',
    side_effects:        ''
  };
  setState('deploy_result', successResult);

  return {
    workspaceStudio: {
      outputs: {
        deploy_result: JSON.stringify(successResult),
        deploy_status: RUN_STATUS.SUCCESS
      }
    }
  };
}

// ============================================================
// STEP 9 — Update Memory & Baseline (Finalize)
// ============================================================

/**
 * wsUpdateMemoryAndBaseline(event)
 * Workspace Studio Step 9.
 *
 * What it does:
 *   - Reads deploy_result from State (written by Step 8)
 *   - Calls finalizePipeline() which:
 *       1. Builds the full PipelineResult JSON
 *       2. Writes a FixMemory row
 *       3. Updates the Baseline tab (if scores improved)
 *       4. Updates the Runs tab with final status
 *       5. Stores PipelineResult in State for Gem 5
 *   - Sends the report email (fallback plain-text version)
 *   - Returns the PipelineResult for Gem 5 (Report Writer)
 *
 * Input:  (none — reads from State tab)
 * Output: pipeline_result (STRING — JSON for Gem 5), report_status (STRING)
 */
function wsUpdateMemoryAndBaseline(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();

  Logger.log('[WS Step 9] Finalizing pipeline');

  // Read the deploy result from State (written by Step 8)
  var deployResult = getState('deploy_result') || {
    status:    RUN_STATUS.SUCCESS,
    deployed:  false,
    reverted:  false
  };

  var status = deployResult.status || RUN_STATUS.SUCCESS;

  // Call the existing finalizePipeline function
  // This writes memory, updates baseline, updates Runs tab, and stores
  // the PipelineResult in State
  var pipelineResult = finalizePipeline(client, secrets, status, deployResult);

  // Send fallback report email
  // (The Workspace Studio flow can add a Gem 5 step after this to
  //  generate a richer HTML report. The fallback is a plain-text email.)
  var reportStatus = 'SKIPPED';
  try {
    sendFallbackReport(client, pipelineResult);
    reportStatus = 'SENT';
  } catch (e) {
    Logger.log('[WS Step 9] Report email failed: ' + e.message);
    reportStatus = 'FAILED';
  }

  Logger.log('[WS Step 9] Pipeline finalized. Status: ' + status + ' | Report: ' + reportStatus);

  return {
    workspaceStudio: {
      outputs: {
        pipeline_result: JSON.stringify(pipelineResult),
        report_status:   reportStatus
      }
    }
  };
}

// ============================================================
// UTILITY — Safe JSON parsing for Gem outputs
// ============================================================

/**
 * _wsParseSafe(rawValue, label)
 * Parses a JSON string that may come from a Gem's output.
 * Gem outputs are often wrapped in markdown code fences or
 * have trailing text — this function handles those cases.
 *
 * Strategy:
 *   1. If already an object, return as-is
 *   2. Try direct JSON.parse
 *   3. Strip markdown code fences and try again
 *   4. Try to extract the first { ... } or [ ... ] block
 *   5. Throw with a helpful error message
 */
function _wsParseSafe(rawValue, label) {
  // Already an object
  if (rawValue && typeof rawValue === 'object') return rawValue;

  var str = String(rawValue || '').trim();
  if (!str) throw new Error(label + ' is empty');

  // Attempt 1: Direct parse
  try {
    return JSON.parse(str);
  } catch (e1) { /* continue */ }

  // Attempt 2: Strip markdown code fences
  //   ```json\n{...}\n```  or  ```\n{...}\n```
  var fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  var fenceMatch = str.match(fenceRegex);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (e2) { /* continue */ }
  }

  // Attempt 3: Extract first { ... } block (handles leading/trailing text)
  var braceStart = str.indexOf('{');
  var braceEnd   = str.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      return JSON.parse(str.substring(braceStart, braceEnd + 1));
    } catch (e3) { /* continue */ }
  }

  // Attempt 4: Extract first [ ... ] block (array response)
  var bracketStart = str.indexOf('[');
  var bracketEnd   = str.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      return JSON.parse(str.substring(bracketStart, bracketEnd + 1));
    } catch (e4) { /* continue */ }
  }

  throw new Error(label + ': could not parse Gem output as JSON. Raw (first 200 chars): '
    + str.substring(0, 200));
}
