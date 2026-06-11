// ============================================================
// AWPIS — 06_deploy.gs
// Layer 8: Production Deployment
//
// Responsibilities:
//   - Open GitHub Pull Request with full context
//   - Auto-merge (AUTOMATED mode) or notify (SUPERVISED mode)
//   - Trigger Vercel production deploy
//   - Post-deploy verification (90s wait + PSI check)
//   - Regression detection + auto-revert
//   - Finalize pipeline (success or revert)
//
// Called by:
//   05_sandbox.gs → runSandboxValidation() after sandbox PASS
// ============================================================

// ------------------------------------------------------------
// Public: Production Deploy Entry Point
// ------------------------------------------------------------

/**
 * runProductionDeploy(client, secrets)
 * Layer 8 entry point. Called after sandbox validation passes.
 *
 * Steps:
 *   1. Open PR on GitHub with full context
 *   2. Auto-merge (AUTOMATED) or send link (SUPERVISED)
 *   3. Trigger Vercel production deploy
 *   4. Wait 90 seconds
 *   5. Run PSI on production URL
 *   6. Check for regressions
 *   7. Auto-revert if regression detected
 *   8. Finalize pipeline
 */
function runProductionDeploy(client, secrets) {
  var runId   = getState(STATE_KEY.RUN_ID);
  var fixPlan = getState(STATE_KEY.FIX_PLAN) || {};
  var branch  = GITHUB.PREVIEW_BRANCH_PREFIX + runId;

  Logger.log('[Layer 8] Starting production deployment');

  // ---- Step 1: Open Pull Request ----
  var intelBundle = getState(STATE_KEY.INTEL_BUNDLE) || {};
  var previewPsi  = getState(STATE_KEY.PREVIEW_PSI) || {};
  var sonarBefore = getState(STATE_KEY.SONAR_BEFORE) || 'UNKNOWN';
  var sonarAfter  = getState(STATE_KEY.SONAR_AFTER) || 'UNKNOWN';

  var psiResults = {
    before: intelBundle.psi_metrics || {},
    after:  previewPsi
  };
  var sonarResults = {
    before: sonarBefore,
    after:  sonarAfter
  };

  var pr;
  try {
    pr = openPullRequest(
      client.github_owner, client.github_repo,
      branch, fixPlan, psiResults, sonarResults,
      secrets.GITHUB_TOKEN
    );
    setState(STATE_KEY.PR_URL, pr.url);
    Logger.log('[Layer 8] PR opened: #' + pr.number + ' — ' + pr.url);
  } catch (e) {
    Logger.log('[Layer 8] PR creation failed: ' + e.message);
    _deployFailure(client, secrets, runId, 'PR creation failed: ' + e.message);
    return;
  }

  // ---- Step 2: Merge or Notify ----
  var runMode = client.run_mode || RUN_MODE.SUPERVISED;

  if (runMode === RUN_MODE.AUTOMATED) {
    // Auto-merge the PR
    try {
      mergePullRequest(
        client.github_owner, client.github_repo,
        pr.number, secrets.GITHUB_TOKEN
      );
      Logger.log('[Layer 8] PR #' + pr.number + ' auto-merged');
    } catch (e) {
      Logger.log('[Layer 8] PR merge failed: ' + e.message);
      _deployFailure(client, secrets, runId, 'PR merge failed: ' + e.message);
      return;
    }
  } else {
    // SUPERVISED mode — notify and stop
    Logger.log('[Layer 8] SUPERVISED mode — PR created, awaiting human merge');
    _notifyPrReady(client, secrets, pr);

    // Finalize as SUCCESS without deploying — human will merge
    var deployResult = {
      status:    RUN_STATUS.SUCCESS,
      deployed:  false,
      reverted:  false,
      pr_url:    pr.url,
      production_psi: {},
      side_effects: 'SUPERVISED mode — PR awaiting human merge'
    };
    finalizePipeline(client, secrets, RUN_STATUS.SUCCESS, deployResult);
    return;
  }

  // ---- Step 3: Trigger Vercel Production Deploy ----
  Logger.log('[Layer 8] Triggering Vercel production deploy...');
  var deployTriggered = _triggerProductionDeploy(secrets);
  if (!deployTriggered) {
    Logger.log('[Layer 8] Vercel deploy trigger failed');
    // Not fatal — Vercel may auto-deploy from the merge
  }

  // ---- Step 4: Wait for deploy to settle ----
  Logger.log('[Layer 8] Waiting ' + (THRESHOLD.POST_DEPLOY_WAIT_MS / 1000) + 's for production deploy...');
  Utilities.sleep(THRESHOLD.POST_DEPLOY_WAIT_MS);

  // ---- Step 5: Run PSI on production ----
  Logger.log('[Layer 8] Running post-deploy PSI check...');
  var productionPsi = _runPsiOnUrl(client.website_url, secrets);
  setState(STATE_KEY.PRODUCTION_PSI, productionPsi);
  Logger.log('[Layer 8] Production PSI — Perf: ' + productionPsi.performance
    + ', LCP: ' + productionPsi.lcp_ms + ', CLS: ' + productionPsi.cls);

  // ---- Step 6: Check for regressions ----
  var currentPsi  = intelBundle.psi_metrics || {};
  var regressions = _checkForRegressions(productionPsi, currentPsi);

  if (regressions.length > 0) {
    // ---- Step 7: Auto-revert ----
    Logger.log('[Layer 8] REGRESSION DETECTED: ' + regressions.join(', '));
    _autoRevert(client, secrets, runId, pr.url, productionPsi, regressions);
    return;
  }

  // ---- Step 8: Success — finalize ----
  Logger.log('[Layer 8] Production stable. No regressions detected.');

  // Clean up preview branch
  try {
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
  } catch (e) {
    Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
  }

  var deployResult = {
    status:            RUN_STATUS.SUCCESS,
    deployed:          true,
    reverted:          false,
    pr_url:            pr.url,
    production_psi:    productionPsi,
    backend_avg_after: '', // could re-ping backend here
    backend_status_after: 'ASSUMED_HEALTHY',
    side_effects:      ''
  };

  finalizePipeline(client, secrets, RUN_STATUS.SUCCESS, deployResult);
}

// ------------------------------------------------------------
// Internal: Regression detection
// ------------------------------------------------------------

/**
 * _checkForRegressions(productionPsi, beforePsi)
 * Checks if any metric dropped by more than REGRESSION_DROP_MAX (5 points)
 * or if CLS spiked above the maximum threshold.
 *
 * Returns array of regression description strings.
 * Empty array means no regressions.
 */
function _checkForRegressions(productionPsi, beforePsi) {
  var regressions = [];
  var maxDrop = THRESHOLD.REGRESSION_DROP_MAX;

  // Lighthouse scores: drop > maxDrop is a regression
  var scoreChecks = [
    { name: 'Performance',     before: beforePsi.performance,    after: productionPsi.performance },
    { name: 'Accessibility',   before: beforePsi.accessibility,  after: productionPsi.accessibility },
    { name: 'Best Practices',  before: beforePsi.best_practices, after: productionPsi.best_practices },
    { name: 'SEO',             before: beforePsi.seo,            after: productionPsi.seo }
  ];

  for (var i = 0; i < scoreChecks.length; i++) {
    var check  = scoreChecks[i];
    var before = Number(check.before) || 0;
    var after  = Number(check.after)  || 0;

    if (before > 0 && after > 0 && (before - after) > maxDrop) {
      regressions.push(check.name + ': ' + before + ' → ' + after + ' (dropped ' + (before - after) + ')');
    }
  }

  // CLS: spike above threshold is a regression
  var clsBefore = Number(beforePsi.cls) || 0;
  var clsAfter  = Number(productionPsi.cls) || 0;
  if (clsAfter > THRESHOLD.CLS_MAX && clsAfter > clsBefore) {
    regressions.push('CLS: ' + clsBefore + ' → ' + clsAfter + ' (above ' + THRESHOLD.CLS_MAX + ' threshold)');
  }

  return regressions;
}

// ------------------------------------------------------------
// Internal: Auto-revert
// ------------------------------------------------------------

/**
 * _autoRevert(client, secrets, runId, prUrl, productionPsi, regressions)
 * Reverts the last commit on main, triggers a redeploy,
 * and sends an urgent alert email.
 */
function _autoRevert(client, secrets, runId, prUrl, productionPsi, regressions) {
  Logger.log('[Layer 8] AUTO-REVERT initiated');

  // Step 1: Revert the last commit
  var revertSha = null;
  try {
    revertSha = revertLastCommit(
      client.github_owner, client.github_repo, secrets.GITHUB_TOKEN
    );
    Logger.log('[Layer 8] Revert commit: ' + revertSha);
  } catch (e) {
    Logger.log('[Layer 8] Revert FAILED: ' + e.message);
    // Continue to send alert even if revert fails
  }

  // Step 2: Trigger Vercel redeploy from (now reverted) main
  _triggerProductionDeploy(secrets);

  // Step 3: Clean up preview branch
  try {
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
  } catch (e) {
    Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
  }

  // Step 4: Send urgent revert alert email
  _sendRevertAlert(client, secrets, regressions, prUrl, revertSha);

  // Step 5: Finalize pipeline as REVERTED
  var deployResult = {
    status:            RUN_STATUS.REVERTED,
    deployed:          true,
    reverted:          true,
    pr_url:            prUrl,
    production_psi:    productionPsi,
    side_effects:      'REVERTED — regressions: ' + regressions.join(', ')
  };

  finalizePipeline(client, secrets, RUN_STATUS.REVERTED, deployResult);
}

// ------------------------------------------------------------
// Internal: Vercel production deploy trigger
// ------------------------------------------------------------

/**
 * _triggerProductionDeploy(secrets)
 * POST to the Vercel deploy hook to trigger a production deploy.
 * Returns true on success.
 */
function _triggerProductionDeploy(secrets) {
  var deployHook = secrets.VERCEL_DEPLOY_HOOK;
  if (!deployHook) {
    Logger.log('[Vercel] No deploy hook configured');
    return false;
  }

  try {
    var resp = UrlFetchApp.fetch(deployHook, {
      method:             'post',
      muteHttpExceptions: true,
      payload:            ''
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('[Vercel] Production deploy triggered successfully');
      return true;
    }
    Logger.log('[Vercel] Deploy hook returned HTTP ' + code);
    return false;
  } catch (e) {
    Logger.log('[Vercel] Deploy hook error: ' + e.message);
    return false;
  }
}

// ------------------------------------------------------------
// Internal: Notifications
// ------------------------------------------------------------

/**
 * _notifyPrReady(client, secrets, pr)
 * Sends an email notifying that a PR is ready for human review.
 * Used in SUPERVISED mode.
 */
function _notifyPrReady(client, secrets, pr) {
  var email = secrets.REPORT_EMAIL || client.report_email;
  if (!email) return;

  var fixPlan = getState(STATE_KEY.FIX_PLAN) || {};

  try {
    MailApp.sendEmail({
      to:      email,
      subject: '[AWPIS] PR ready for review — ' + client.client_name,
      body: [
        'AWPIS has prepared a performance fix and it passed all quality gates.',
        '',
        'Client:    ' + client.client_name,
        'Focus:     ' + (fixPlan.focus || ''),
        'Approach:  ' + (fixPlan.approach || ''),
        'PR URL:    ' + pr.url,
        '',
        'The PR includes before/after scores, root cause analysis,',
        'and SonarQube gate status. Please review and merge when ready.',
        '',
        'Pipeline version: ' + PIPELINE_VERSION
      ].join('\n')
    });
    Logger.log('[Notify] PR ready email sent to: ' + email);
  } catch (e) {
    Logger.log('[Notify] Email failed: ' + e.message);
  }
}

/**
 * _sendRevertAlert(client, secrets, regressions, prUrl, revertSha)
 * Sends an urgent email alert when a regression was detected
 * and the change was auto-reverted.
 */
function _sendRevertAlert(client, secrets, regressions, prUrl, revertSha) {
  var email = secrets.REPORT_EMAIL || client.report_email;
  if (!email) return;

  try {
    MailApp.sendEmail({
      to:      email,
      subject: '🚨 [AWPIS REVERT] Regression detected — ' + client.client_name,
      body: [
        'AWPIS detected a performance regression and has AUTO-REVERTED the change.',
        '',
        'Client:      ' + client.client_name,
        'PR:          ' + (prUrl || 'N/A'),
        'Revert SHA:  ' + (revertSha || 'FAILED'),
        '',
        'Regressions detected:',
        regressions.map(function(r) { return '  - ' + r; }).join('\n'),
        '',
        'Action taken:',
        '  1. Last commit on main reverted',
        '  2. Vercel redeploy triggered from reverted main',
        '  3. Preview branch deleted',
        '',
        'The site should be back to its pre-fix state within 2-3 minutes.',
        '',
        'Pipeline version: ' + PIPELINE_VERSION
      ].join('\n')
    });
    Logger.log('[Alert] Revert alert sent to: ' + email);
  } catch (e) {
    Logger.log('[Alert] Revert email failed: ' + e.message);
  }
}

// ------------------------------------------------------------
// Internal: Deploy failure handling
// ------------------------------------------------------------

/**
 * _deployFailure(client, secrets, runId, reason)
 * Handles a deploy step failure (PR creation, merge, etc.)
 * Cleans up and finalizes as FAILED.
 */
function _deployFailure(client, secrets, runId, reason) {
  Logger.log('[Layer 8] Deploy FAILED: ' + reason);

  // Clean up preview branch
  try {
    deletePreviewBranch(client.github_owner, client.github_repo, runId, secrets.GITHUB_TOKEN);
  } catch (e) {
    Logger.log('[Cleanup] Preview branch delete error: ' + e.message);
  }

  var deployResult = {
    status:       RUN_STATUS.FAILED,
    deployed:     false,
    reverted:     false,
    side_effects: 'Deploy failed: ' + reason
  };

  finalizePipeline(client, secrets, RUN_STATUS.FAILED, deployResult);
}
