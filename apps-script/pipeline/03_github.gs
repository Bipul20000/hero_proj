// ============================================================
// AWPIS — 03_github.gs
// All GitHub API operations used across Layers 4, 7, 8.
//
// Called by:
//   04_sonarqube.gs  — fetchFiles() for targeted code fetch
//   05_sandbox.gs    — createPreviewBranch(), pushFilesToBranch(),
//                      deletePreviewBranch()
//   06_deploy.gs     — openPullRequest(), mergePullRequest(),
//                      revertLastCommit()
// ============================================================

// ------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------

/**
 * _ghHeaders(token)
 * Returns standard GitHub API headers.
 */
function _ghHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept:        'application/vnd.github.v3+json',
    'Content-Type':'application/json'
  };
}

/**
 * _ghGet(url, token)
 * Authenticated GET to the GitHub API.
 * Returns parsed JSON body. Throws on non-2xx.
 */
function _ghGet(url, token) {
  var resp = UrlFetchApp.fetch(url, {
    method:             'get',
    headers:            _ghHeaders(token),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('[GitHub GET ' + url + '] HTTP ' + code + ': ' + body);
  }
  return JSON.parse(body);
}

/**
 * _ghPost(url, token, payload)
 * Authenticated POST to the GitHub API.
 * Returns parsed JSON body. Throws on non-2xx.
 */
function _ghPost(url, token, payload) {
  var resp = UrlFetchApp.fetch(url, {
    method:             'post',
    headers:            _ghHeaders(token),
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('[GitHub POST ' + url + '] HTTP ' + code + ': ' + body);
  }
  return JSON.parse(body);
}

/**
 * _ghPut(url, token, payload)
 * Authenticated PUT to the GitHub API.
 * Returns parsed JSON body. Throws on non-2xx.
 */
function _ghPut(url, token, payload) {
  var resp = UrlFetchApp.fetch(url, {
    method:             'put',
    headers:            _ghHeaders(token),
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('[GitHub PUT ' + url + '] HTTP ' + code + ': ' + body);
  }
  return JSON.parse(body);
}

/**
 * _ghDelete(url, token)
 * Authenticated DELETE to the GitHub API.
 * Returns true on success. Does not throw on 404 (already deleted).
 */
function _ghDelete(url, token) {
  var resp = UrlFetchApp.fetch(url, {
    method:             'delete',
    headers:            _ghHeaders(token),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code === 404) return true;  // already gone
  if (code < 200 || code >= 300) {
    throw new Error('[GitHub DELETE ' + url + '] HTTP ' + code);
  }
  return true;
}

/**
 * _repoBase(owner, repo)
 * Shorthand for the GitHub repo API base URL.
 */
function _repoBase(owner, repo) {
  return API.GITHUB + '/repos/' + owner + '/' + repo;
}

// ------------------------------------------------------------
// Public: File operations
// ------------------------------------------------------------

/**
 * fetchFiles(owner, repo, paths, token)
 * Fetches full content + SHA for each path in the paths[] array.
 * Returns FileBundle[]: [{ path, content, sha }]
 *
 * Used by Layer 4 (targeted code fetch after FixPlan).
 */
function fetchFiles(owner, repo, paths, token) {
  if (!paths || paths.length === 0) return [];

  var base     = _repoBase(owner, repo) + '/contents/';
  var headers  = _ghHeaders(token);
  var requests = paths.map(function(p) {
    return { url: base + p, method: 'get', headers: headers, muteHttpExceptions: true };
  });

  var responses = UrlFetchApp.fetchAll(requests);
  var bundle    = [];

  for (var i = 0; i < responses.length; i++) {
    var code = responses[i].getResponseCode();
    if (code !== 200) {
      Logger.log('[fetchFiles] ' + paths[i] + ' returned HTTP ' + code + ' — skipping');
      continue;
    }
    try {
      var data    = JSON.parse(responses[i].getContentText());
      var content = Utilities.newBlob(
        Utilities.base64Decode(data.content.replace(/\n/g, ''))
      ).getDataAsString();

      bundle.push({
        path:    paths[i],
        content: content,
        sha:     data.sha
      });
    } catch (e) {
      Logger.log('[fetchFiles] Parse error for ' + paths[i] + ': ' + e.message);
    }
  }

  return bundle;
}

/**
 * fetchTargetedFiles(client, secrets, fixPlan)
 * Layer 4 entry point.
 * Fetches only the files in fixPlan.files_to_change, adds Sonar issues,
 * and writes the FileBundle to State.
 */
function fetchTargetedFiles(client, secrets, fixPlan) {
  Logger.log('[Layer 4] Fetching ' + fixPlan.files_to_change.length + ' targeted files');

  var fileBundle = fetchFiles(
    client.github_owner,
    client.github_repo,
    fixPlan.files_to_change,
    secrets.GITHUB_TOKEN
  );

  // Attach SonarQube issues to each file (from 04_sonarqube.gs)
  if (secrets.SONARQUBE_TOKEN && secrets.SONARQUBE_PROJECT_KEY) {
    var sonarIssues = getSonarIssues(
      secrets.SONARQUBE_PROJECT_KEY,
      fixPlan.files_to_change,
      secrets.SONARQUBE_TOKEN
    );

    fileBundle = fileBundle.map(function(f) {
      f.sonar_issues = sonarIssues.filter(function(issue) {
        return issue.component && issue.component.indexOf(f.path) >= 0;
      });
      return f;
    });
  }

  setState(STATE_KEY.FILE_BUNDLE, fileBundle);
  Logger.log('[Layer 4] FileBundle written to State. Files fetched: ' + fileBundle.length);
  return fileBundle;
}

// ------------------------------------------------------------
// Public: Branch operations
// ------------------------------------------------------------

/**
 * getMainBranchSha(owner, repo, token)
 * Returns the current HEAD SHA of the main branch.
 * Needed to create a new branch from main.
 */
function getMainBranchSha(owner, repo, token) {
  var data = _ghGet(
    _repoBase(owner, repo) + '/git/ref/heads/' + GITHUB.MAIN_BRANCH,
    token
  );
  return data.object.sha;
}

/**
 * createPreviewBranch(owner, repo, runId, token)
 * Creates branch "awpis/preview-{runId}" from current main HEAD.
 * Returns the new branch name.
 */
function createPreviewBranch(owner, repo, runId, token) {
  var branchName = GITHUB.PREVIEW_BRANCH_PREFIX + runId;
  var mainSha    = getMainBranchSha(owner, repo, token);

  _ghPost(_repoBase(owner, repo) + '/git/refs', token, {
    ref: 'refs/heads/' + branchName,
    sha: mainSha
  });

  Logger.log('[GitHub] Preview branch created: ' + branchName);
  return branchName;
}

/**
 * deletePreviewBranch(owner, repo, runId, token)
 * Deletes the preview branch. Safe to call even if branch doesn't exist.
 */
function deletePreviewBranch(owner, repo, runId, token) {
  var branchName = GITHUB.PREVIEW_BRANCH_PREFIX + runId;
  _ghDelete(
    _repoBase(owner, repo) + '/git/refs/heads/' + branchName,
    token
  );
  Logger.log('[GitHub] Preview branch deleted: ' + branchName);
}

// ------------------------------------------------------------
// Public: File push to branch
// ------------------------------------------------------------

/**
 * pushFilesToBranch(owner, repo, branch, files, token)
 * Updates each file on the specified branch using the GitHub Contents API.
 * files: [{ path, content (string), sha (original SHA from fetchFiles) }]
 *
 * Each file is updated individually — GitHub API does not support
 * multi-file commits via the Contents API. For multi-file atomic commits,
 * we'd need the Git Data API (trees/commits) — using simple approach here
 * since AWPIS typically touches 1-3 files per run.
 */
function pushFilesToBranch(owner, repo, branch, files, token) {
  var runId = getState(STATE_KEY.RUN_ID) || 'unknown';

  for (var i = 0; i < files.length; i++) {
    var file    = files[i];
    var encoded = Utilities.base64Encode(
      Utilities.newBlob(file.content).getBytes()
    );

    var payload = {
      message: 'chore(awpis): update ' + file.path + ' [run ' + runId + ']',
      content: encoded,
      sha:     file.sha,
      branch:  branch
    };

    try {
      _ghPut(
        _repoBase(owner, repo) + '/contents/' + file.path,
        token,
        payload
      );
      Logger.log('[GitHub] Pushed: ' + file.path + ' to ' + branch);
    } catch (e) {
      Logger.log('[GitHub] Push FAILED for ' + file.path + ': ' + e.message);
      throw e;
    }
  }
}

// ------------------------------------------------------------
// Public: Pull Request operations
// ------------------------------------------------------------

/**
 * openPullRequest(owner, repo, branch, fixPlan, psiResults, sonarResults, token)
 * Creates a PR from the preview branch to main.
 * PR body includes before/after scores, root cause, files changed,
 * Sonar status, and sandbox PSI results — for full auditability.
 * Returns { number, url }.
 */
function openPullRequest(owner, repo, branch, fixPlan, psiResults, sonarResults, token) {
  var title = GITHUB.PR_TITLE_PREFIX
    + '(' + fixPlan.focus.toLowerCase() + '): '
    + fixPlan.approach.substring(0, 60)
    + ' [AWPIS auto]';

  var body = _buildPrBody(fixPlan, psiResults, sonarResults);

  var data = _ghPost(_repoBase(owner, repo) + '/pulls', token, {
    title: title,
    body:  body,
    head:  branch,
    base:  GITHUB.MAIN_BRANCH
  });

  Logger.log('[GitHub] PR created: #' + data.number + ' — ' + data.html_url);
  return { number: data.number, url: data.html_url };
}

/**
 * _buildPrBody(fixPlan, psiResults, sonarResults)
 * Builds the GitHub PR description markdown.
 */
function _buildPrBody(fixPlan, psiResults, sonarResults) {
  var before = psiResults.before || {};
  var after  = psiResults.after  || {};

  var lines = [
    '## AWPIS Automated Performance Fix',
    '',
    '### What changed',
    '**Focus:** ' + fixPlan.focus,
    '**Root cause:** ' + fixPlan.root_cause,
    '**Approach:** ' + fixPlan.approach,
    '**Files changed:** `' + (fixPlan.files_to_change || []).join('`, `') + '`',
    '',
    '### Score comparison',
    '| Metric | Before | After (sandbox) |',
    '|--------|--------|----------------|',
    '| Performance | ' + (before.performance || '--') + ' | ' + (after.performance || '--') + ' |',
    '| Accessibility | ' + (before.accessibility || '--') + ' | ' + (after.accessibility || '--') + ' |',
    '| Best Practices | ' + (before.best_practices || '--') + ' | ' + (after.best_practices || '--') + ' |',
    '| SEO | ' + (before.seo || '--') + ' | ' + (after.seo || '--') + ' |',
    '| LCP (ms) | ' + (before.lcp_ms || '--') + ' | ' + (after.lcp_ms || '--') + ' |',
    '| CLS | ' + (before.cls !== undefined ? before.cls : '--') + ' | ' + (after.cls !== undefined ? after.cls : '--') + ' |',
    '',
    '### SonarQube',
    '- Gate before: ' + (sonarResults.before || 'UNKNOWN'),
    '- Gate after:  ' + (sonarResults.after  || 'UNKNOWN'),
    '',
    '### Risk assessment',
    '- Risk level: ' + fixPlan.risk_level,
    '- Confidence: ' + fixPlan.confidence,
    '- Why different from history: ' + fixPlan.why_different_from_history,
    '',
    '---',
    '_Generated by AWPIS v' + PIPELINE_VERSION + '_'
  ];

  return lines.join('\n');
}

/**
 * mergePullRequest(owner, repo, prNumber, token)
 * Merges a PR using squash merge strategy.
 * Only called in AUTOMATED mode.
 */
function mergePullRequest(owner, repo, prNumber, token) {
  var data = _ghPut(
    _repoBase(owner, repo) + '/pulls/' + prNumber + '/merge',
    token,
    {
      merge_method:   'squash',
      commit_title:   'perf: AWPIS automated fix [PR #' + prNumber + ']',
      commit_message: 'Auto-merged by AWPIS pipeline v' + PIPELINE_VERSION
    }
  );
  Logger.log('[GitHub] PR #' + prNumber + ' merged. SHA: ' + data.sha);
  return data.sha;
}

// ------------------------------------------------------------
// Public: Revert
// ------------------------------------------------------------

/**
 * revertLastCommit(owner, repo, token)
 * Creates a revert commit on main by reverting the last commit.
 * Used by 06_deploy.gs when regression is detected post-deploy.
 *
 * Strategy:
 *   1. Get current HEAD SHA and its parent SHA
 *   2. Create a new tree from the parent commit's tree
 *   3. Create a revert commit pointing to that tree
 *   4. Update main branch ref to the new commit
 *
 * Returns the new HEAD SHA after revert.
 */
function revertLastCommit(owner, repo, token) {
  var base = _repoBase(owner, repo);

  // 1. Get current HEAD
  var headRef  = _ghGet(base + '/git/ref/heads/' + GITHUB.MAIN_BRANCH, token);
  var headSha  = headRef.object.sha;

  // 2. Get the HEAD commit to find its parent and message
  var headCommit  = _ghGet(base + '/git/commits/' + headSha, token);
  var parentSha   = headCommit.parents[0].sha;
  var parentCommit = _ghGet(base + '/git/commits/' + parentSha, token);
  var parentTree   = parentCommit.tree.sha;

  // 3. Create a new commit that uses the parent's tree (effectively a revert)
  var revertCommit = _ghPost(base + '/git/commits', token, {
    message: 'revert: AWPIS regression detected — reverting to stable state\n\nReverted: ' + headSha,
    tree:    parentTree,
    parents: [headSha]
  });

  // 4. Update main branch to point to the revert commit
  _ghPut(base + '/git/refs/heads/' + GITHUB.MAIN_BRANCH, token, {
    sha:   revertCommit.sha,
    force: false
  });

  Logger.log('[GitHub] Revert commit created: ' + revertCommit.sha);
  return revertCommit.sha;
}

// ------------------------------------------------------------
// Public: Recent commits (used by 02_collect.gs)
// ------------------------------------------------------------

/**
 * getRecentCommits(owner, repo, token)
 * Returns last N commit summaries from main.
 */
function getRecentCommits(owner, repo, token) {
  var data = _ghGet(
    _repoBase(owner, repo) + '/commits?per_page=' + THRESHOLD.RECENT_COMMITS_COUNT,
    token
  );
  return (data || []).map(function(c) {
    return {
      sha:     c.sha ? c.sha.substring(0, 7) : '',
      message: (c.commit && c.commit.message) ? c.commit.message.split('\n')[0] : '',
      date:    (c.commit && c.commit.author)  ? c.commit.author.date : ''
    };
  });
}
