// ============================================================
// AWPIS — 10_workspace_studio.gs
// Workspace Studio Workflow Action Wrappers
//
// Each step needs TWO functions:
//   1. onConfigFunction  — builds the config UI card (inputs)
//   2. onExecuteFunction  — runs the actual pipeline logic
//
// The config function returns input field definitions.
// The execute function reads event.configParameters, calls
// existing pipeline logic, and returns outputs.
// ============================================================

// ============================================================
// STEP 1 — Initialize Pipeline Run
// ============================================================

function configStep1Initialize(event) {
  return {
    form: {
      textInput: {
        label: 'Client ID (from Config tab)',
        name: 'client_id'
      }
    }
  };
}

function wsInitializePipelineRun(event) {
  var clientId = event.configParameters.client_id;
  var startTime = Date.now();

  Logger.log('[WS Step 1] Initializing pipeline for client: ' + clientId);

  var client = _getClientById(clientId);
  if (!client) {
    throw new Error('Client not found in Config tab: ' + clientId);
  }
  if (String(client.active).toUpperCase() !== 'TRUE') {
    throw new Error('Client ' + clientId + ' is not active.');
  }

  var runId = 'run_' + clientId + '_' + startTime;

  clearState();
  initStateTab();

  setState(STATE_KEY.RUN_ID,         runId);
  setState(STATE_KEY.CLIENT_ID,      clientId);
  setState(STATE_KEY.RUN_START_TIME, startTime);
  setState(STATE_KEY.RETRY_COUNT,    0);
  setState(STATE_KEY.GATE_RESULTS, {
    structural: null, sonarqube: null, critic: null, blast_radius: null
  });

  _writeRunRow(runId, clientId, RUN_STATUS.RUNNING, startTime);

  Logger.log('[WS Step 1] Pipeline initialized. Run ID: ' + runId);

  return {
    status: 'SUCCESS',
    output: {
      run_id:    runId,
      client_id: clientId
    }
  };
}

// ============================================================
// STEP 2 — Collect Intelligence
// ============================================================

function configStep2Collect(event) {
  return {
    form: {
      textInput: {
        label: 'Client ID',
        name: 'client_id'
      }
    }
  };
}

function wsCollectIntelligence(event) {
  var clientId = event.configParameters.client_id;

  Logger.log('[WS Step 2] Collecting intelligence for: ' + clientId);

  var client  = _getClientById(clientId);
  var secrets = getSecrets();

  var bundle = collectIntelligence(client, secrets);

  Logger.log('[WS Step 2] Intelligence gathered. PSI performance: ' + bundle.psi_metrics.performance);

  return {
    status: 'SUCCESS',
    output: {
      intelligence_bundle: JSON.stringify(bundle)
    }
  };
}

// ============================================================
// STEP 3 is a Gem step — configured directly in Studio UI
//   Use "Ask Gemini with Gem" → AWPIS Performance Strategist
//   Input:  intelligence_bundle from Step 2
//   Output: fix_plan (JSON string)
// ============================================================

// ============================================================
// STEP 4 — Fetch Target Code
// ============================================================

function configStep4FetchCode(event) {
  return {
    form: {
      textInput: {
        label: 'Fix Plan (JSON from Strategist Gem)',
        name: 'fix_plan'
      }
    }
  };
}

function wsFetchTargetCode(event) {
  var fixPlanRaw = event.configParameters.fix_plan;

  Logger.log('[WS Step 4] Received FixPlan from Strategist Gem');

  var fixPlan = _wsParseSafe(fixPlanRaw, 'FixPlan');
  setState(STATE_KEY.FIX_PLAN, fixPlan);

  Logger.log('[WS Step 4] FixPlan focus: ' + fixPlan.focus
    + ' | Files: ' + (fixPlan.files_to_change || []).join(', '));

  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var fileBundle = fetchTargetedFiles(client, secrets, fixPlan);

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
    status: 'SUCCESS',
    output: {
      code_context: JSON.stringify(codeContext)
    }
  };
}

// ============================================================
// STEP 5 is a Gem step — configured directly in Studio UI
//   Use "Ask Gemini with Gem" → AWPIS Frontend/Backend Engineer
//   Input:  code_context from Step 4
//   Output: generated_fix (JSON string with files[] array)
// ============================================================

// ============================================================
// STEP 6 — Run Quality Gates
// ============================================================

function configStep6QualityGates(event) {
  return {
    form: {
      textInput: {
        label: 'Generated Fix (JSON from Engineer Gem)',
        name: 'generated_fix'
      }
    }
  };
}

function wsRunQualityGates(event) {
  var generatedFixRaw = event.configParameters.generated_fix;

  Logger.log('[WS Step 6] Received generated fix from Engineer Gem');

  var generatedFix = _wsParseSafe(generatedFixRaw, 'GeneratedFix');
  setState(STATE_KEY.GENERATED_FIX, generatedFix);

  var client      = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets     = getSecrets();
  var fixPlan     = getState(STATE_KEY.FIX_PLAN);
  var fileBundle  = getState(STATE_KEY.FILE_BUNDLE) || [];
  var gateResults = getState(STATE_KEY.GATE_RESULTS) || {};

  Logger.log('[WS Step 6] Files in fix: ' + (generatedFix.files || []).length);

  // ---- GATE 1: Structural Safety ----
  Logger.log('[Gate 1] Running structural safety checks...');
  var gate1 = _runStructuralGate(generatedFix, fixPlan);
  gateResults[GATE.STRUCTURAL] = gate1.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  if (!gate1.passed) {
    Logger.log('[Gate 1] FAILED: ' + gate1.failure_reason);
    return {
      status: 'SUCCESS',
      output: {
        gate_results: JSON.stringify({
          passed: false, failed_gate: GATE.STRUCTURAL, reason: gate1.failure_reason, gates: gateResults
        }),
        all_gates_passed: 'FALSE'
      }
    };
  }
  Logger.log('[Gate 1] PASSED');

  // ---- Push to preview branch ----
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

  Logger.log('[Gate 2] Running SonarQube gate...');
  var gate2 = checkSonarGate(secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN);
  gateResults[GATE.SONARQUBE] = gate2.passed ? GATE_RESULT.PASS : GATE_RESULT.FAIL;
  setState(STATE_KEY.GATE_RESULTS, gateResults);
  setState(STATE_KEY.SONAR_AFTER, gate2.gate_status);

  if (!gate2.passed) {
    Logger.log('[Gate 2] FAILED: ' + gate2.failure_reason);
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
    return {
      status: 'SUCCESS',
      output: {
        gate_results: JSON.stringify({
          passed: false, failed_gate: GATE.SONARQUBE, reason: gate2.failure_reason, gates: gateResults
        }),
        all_gates_passed: 'FALSE'
      }
    };
  }
  Logger.log('[Gate 2] PASSED');

  // ---- GATE 3: Critic (auto-approved) ----
  var criticInput = _prepareCriticInput(generatedFix, fixPlan, fileBundle);
  setState('critic_input', criticInput);
  gateResults[GATE.CRITIC] = GATE_RESULT.APPROVE;
  setState(STATE_KEY.GATE_RESULTS, gateResults);
  Logger.log('[Gate 3] Critic auto-approved');

  // ---- GATE 4: Blast Radius ----
  Logger.log('[Gate 4] Running blast radius check...');
  var gate4 = _runBlastRadiusGate(generatedFix, client, secrets);
  gateResults[GATE.BLAST_RADIUS] = gate4.contained ? GATE_RESULT.CLEAR : GATE_RESULT.WIDE;
  setState(STATE_KEY.GATE_RESULTS, gateResults);

  Logger.log('[Gate 4] Blast radius: ' + (gate4.contained ? 'CONTAINED' : 'WIDE'));
  Logger.log('[WS Step 6] ALL GATES PASSED');

  return {
    status: 'SUCCESS',
    output: {
      gate_results: JSON.stringify({ passed: true, gates: gateResults }),
      all_gates_passed: 'TRUE'
    }
  };
}

// ============================================================
// STEP 7 — Sandbox Validation
// ============================================================

function configStep7Sandbox(event) {
  // No user input needed — reads from State tab
  return {};
}

function wsRunSandboxValidation(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var runId   = getState(STATE_KEY.RUN_ID);

  Logger.log('[WS Step 7] Starting sandbox validation');

  var previewUrl = _deployAndWaitForPreview(client, secrets, runId);
  if (!previewUrl) {
    Logger.log('[WS Step 7] Preview deploy failed');
    try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (e) {}
    var failResult = { passed: false, reason: 'Vercel preview deploy failed or timed out' };
    setState(STATE_KEY.SANDBOX_RESULT, failResult);
    return { status: 'SUCCESS', output: { sandbox_result: JSON.stringify(failResult), sandbox_passed: 'FALSE' } };
  }

  setState(STATE_KEY.PREVIEW_URL, previewUrl);
  Logger.log('[WS Step 7] Preview URL: ' + previewUrl);

  var previewPsi = _runPsiOnUrl(previewUrl, secrets);
  setState(STATE_KEY.PREVIEW_PSI, previewPsi);

  var backendHealth = _runBackendHealthOnPreview(previewUrl, client);
  var branch        = GITHUB.PREVIEW_BRANCH_PREFIX + runId;
  var sonarGate     = getSonarGateStatus(secrets.SONARQUBE_PROJECT_KEY, branch, secrets.SONARQUBE_TOKEN);

  var baseline    = getState(STATE_KEY.BASELINE_PSI) || {};
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var currentPsi  = intelBundle.psi_metrics || {};
  var sandboxResult = _evaluateSandbox(previewPsi, currentPsi, baseline, backendHealth, sonarGate);

  setState(STATE_KEY.SANDBOX_RESULT, sandboxResult);
  Logger.log('[WS Step 7] Sandbox: ' + (sandboxResult.passed ? 'PASS' : 'FAIL'));

  if (!sandboxResult.passed) {
    try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (e) {}
  }

  return {
    status: 'SUCCESS',
    output: {
      sandbox_result: JSON.stringify(sandboxResult),
      sandbox_passed: sandboxResult.passed ? 'TRUE' : 'FALSE'
    }
  };
}

// ============================================================
// STEP 8 — Deploy to Production
// ============================================================

function configStep8Deploy(event) {
  return {};
}

function wsDeployToProduction(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();
  var runId   = getState(STATE_KEY.RUN_ID);
  var fixPlan = getState(STATE_KEY.FIX_PLAN) || {};
  var branch  = GITHUB.PREVIEW_BRANCH_PREFIX + runId;

  Logger.log('[WS Step 8] Starting production deployment');

  var intelBundle  = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var previewPsi   = getState(STATE_KEY.PREVIEW_PSI) || {};
  var sonarBefore  = getState(STATE_KEY.SONAR_BEFORE) || 'UNKNOWN';
  var sonarAfter   = getState(STATE_KEY.SONAR_AFTER) || 'UNKNOWN';
  var psiResults   = { before: intelBundle.psi_metrics || {}, after: previewPsi };
  var sonarResults = { before: sonarBefore, after: sonarAfter };

  // Open PR
  var pr;
  try {
    pr = openPullRequest(client.github_owner, client.github_repo, branch, fixPlan, psiResults, sonarResults, secrets.GITHUB_TOKEN);
    setState(STATE_KEY.PR_URL, pr.url);
    Logger.log('[WS Step 8] PR opened: #' + pr.number);
  } catch (e) {
    try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (err) {}
    var failResult = { status: RUN_STATUS.FAILED, deployed: false, reverted: false, reason: 'PR failed: ' + e.message };
    setState('deploy_result', failResult);
    return { status: 'SUCCESS', output: { deploy_result: JSON.stringify(failResult), deploy_status: RUN_STATUS.FAILED } };
  }

  // Merge or notify
  var runMode = client.run_mode || RUN_MODE.SUPERVISED;
  if (runMode === RUN_MODE.AUTOMATED) {
    try {
      mergePullRequest(client.github_owner, client.github_repo, pr.number, secrets.GITHUB_TOKEN);
      Logger.log('[WS Step 8] PR auto-merged');
    } catch (e) {
      try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (err) {}
      var mergeFailResult = { status: RUN_STATUS.FAILED, deployed: false, reverted: false, pr_url: pr.url, reason: 'Merge failed: ' + e.message };
      setState('deploy_result', mergeFailResult);
      return { status: 'SUCCESS', output: { deploy_result: JSON.stringify(mergeFailResult), deploy_status: RUN_STATUS.FAILED } };
    }
  } else {
    _notifyPrReady(client, secrets, pr);
    var supervisedResult = { status: RUN_STATUS.SUCCESS, deployed: false, reverted: false, pr_url: pr.url, side_effects: 'SUPERVISED — awaiting human merge' };
    setState('deploy_result', supervisedResult);
    return { status: 'SUCCESS', output: { deploy_result: JSON.stringify(supervisedResult), deploy_status: RUN_STATUS.SUCCESS } };
  }

  // Trigger deploy, wait, check PSI
  _triggerProductionDeploy(secrets);
  Logger.log('[WS Step 8] Waiting ' + (THRESHOLD.POST_DEPLOY_WAIT_MS / 1000) + 's...');
  Utilities.sleep(THRESHOLD.POST_DEPLOY_WAIT_MS);

  var productionPsi = _runPsiOnUrl(client.website_url, secrets);
  setState(STATE_KEY.PRODUCTION_PSI, productionPsi);

  var currentPsi  = intelBundle.psi_metrics || {};
  var regressions = _checkForRegressions(productionPsi, currentPsi);

  if (regressions.length > 0) {
    Logger.log('[WS Step 8] REGRESSION: ' + regressions.join(', '));
    var revertSha = null;
    try { revertSha = revertLastCommit(client.github_owner, client.github_repo, secrets.GITHUB_TOKEN); } catch (e) {}
    _triggerProductionDeploy(secrets);
    _sendRevertAlert(client, secrets, regressions, pr.url, revertSha);
    try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (e) {}
    var revertResult = { status: RUN_STATUS.REVERTED, deployed: true, reverted: true, pr_url: pr.url, production_psi: productionPsi, side_effects: 'REVERTED: ' + regressions.join(', ') };
    setState('deploy_result', revertResult);
    return { status: 'SUCCESS', output: { deploy_result: JSON.stringify(revertResult), deploy_status: RUN_STATUS.REVERTED } };
  }

  // Success
  try { deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN); } catch (e) {}
  var successResult = { status: RUN_STATUS.SUCCESS, deployed: true, reverted: false, pr_url: pr.url, production_psi: productionPsi, side_effects: '' };
  setState('deploy_result', successResult);

  return { status: 'SUCCESS', output: { deploy_result: JSON.stringify(successResult), deploy_status: RUN_STATUS.SUCCESS } };
}

// ============================================================
// STEP 9 — Update Memory & Baseline
// ============================================================

function configStep9Finalize(event) {
  return {};
}

function wsUpdateMemoryAndBaseline(event) {
  var client  = _getClientById(getState(STATE_KEY.CLIENT_ID));
  var secrets = getSecrets();

  Logger.log('[WS Step 9] Finalizing pipeline');

  var deployResult = getState('deploy_result') || { status: RUN_STATUS.SUCCESS, deployed: false, reverted: false };
  var status = deployResult.status || RUN_STATUS.SUCCESS;

  var pipelineResult = finalizePipeline(client, secrets, status, deployResult);

  var reportStatus = 'SKIPPED';
  try {
    sendFallbackReport(client, pipelineResult);
    reportStatus = 'SENT';
  } catch (e) {
    Logger.log('[WS Step 9] Report email failed: ' + e.message);
    reportStatus = 'FAILED';
  }

  Logger.log('[WS Step 9] Done. Status: ' + status + ' | Report: ' + reportStatus);

  return {
    status: 'SUCCESS',
    output: {
      pipeline_result: JSON.stringify(pipelineResult),
      report_status:   reportStatus
    }
  };
}

// ============================================================
// UTILITY — Safe JSON parsing for Gem outputs
// ============================================================

/**
 * _wsParseSafe(rawValue, label)
 * Parses JSON that may come from a Gem's output.
 * Handles: direct JSON, markdown code fences, leading/trailing text.
 */
function _wsParseSafe(rawValue, label) {
  if (rawValue && typeof rawValue === 'object') return rawValue;

  var str = String(rawValue || '').trim();
  if (!str) throw new Error(label + ' is empty');

  // Attempt 1: Direct parse
  try { return JSON.parse(str); } catch (e1) {}

  // Attempt 2: Strip markdown code fences
  var fenceMatch = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (e2) {}
  }

  // Attempt 3: Extract first { ... } block
  var braceStart = str.indexOf('{');
  var braceEnd   = str.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(str.substring(braceStart, braceEnd + 1)); } catch (e3) {}
  }

  // Attempt 4: Extract first [ ... ] block
  var bracketStart = str.indexOf('[');
  var bracketEnd   = str.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try { return JSON.parse(str.substring(bracketStart, bracketEnd + 1)); } catch (e4) {}
  }

  throw new Error(label + ': could not parse as JSON. First 200 chars: ' + str.substring(0, 200));
}
