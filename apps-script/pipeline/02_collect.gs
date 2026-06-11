// ============================================================
// AWPIS — 02_collect.gs
// Layer 2: Parallel Intelligence Gathering
//
// collectIntelligence(client, secrets) is the public entry point.
// It runs 4 UrlFetchApp calls as close to parallel as Apps Script
// allows (fetch-all batch), merges results into an IntelligenceBundle,
// and writes it to the State tab for Gem 1 to consume.
// ============================================================

// ------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------

/**
 * collectIntelligence(client, secrets)
 * Orchestrates all 4 collectors and writes IntelligenceBundle to State.
 * Called by 01_trigger.gs > runPipelineForClient().
 */
function collectIntelligence(client, secrets) {
  Logger.log('[Layer 2] Starting intelligence gathering for: ' + client.client_name);

  // Apps Script does not have true parallelism, but UrlFetchApp.fetchAll()
  // fires all HTTP requests concurrently and waits for all responses.
  // We prepare all requests first, batch-fire them, then parse results.

  var psiRequests      = _buildPsiRequests(client, secrets);
  var githubRequests   = _buildGithubRequests(client, secrets);

  // PSI + GitHub are network-heavy — fire them together
  var networkRequests  = psiRequests.concat(githubRequests);
  var networkResponses = UrlFetchApp.fetchAll(networkRequests);

  var psiResponse    = networkResponses.slice(0, psiRequests.length);
  var githubResponse = networkResponses.slice(psiRequests.length);

  // Parse all 4 collectors
  var metrics  = _parseMetrics(psiResponse, client, secrets);
  var codebase = _parseCodebase(githubResponse, client, secrets);
  var history  = _collectHistory(client);
  var security = _collectSecurity(client, secrets);

  // Merge into IntelligenceBundle
  var bundle = _buildIntelligenceBundle(client, metrics, codebase, history, security);

  setState(STATE_KEY.INTEL_BUNDLE, bundle);
  setState(STATE_KEY.BASELINE_PSI, history.baseline);

  Logger.log('[Layer 2] IntelligenceBundle written to State. PSI perf: ' + metrics.psi.performance);
  return bundle;
}

// ============================================================
// COLLECTOR 1 — METRICS (PSI + Backend health)
// ============================================================

/**
 * _buildPsiRequests(client, secrets)
 * Builds the PSI API UrlFetchApp request objects.
 * Returns an array with one request (mobile strategy, all 4 categories).
 */
function _buildPsiRequests(client, secrets) {
  var url = API.PSI
    + '?url='      + encodeURIComponent(client.website_url)
    + '&strategy=' + PSI.STRATEGY
    + '&category=' + PSI.CATEGORIES.join('&category=')
    + '&key='      + secrets.PAGESPEED_KEY;

  return [{ url: url, method: 'get', muteHttpExceptions: true }];
}

/**
 * _parseMetrics(psiResponses, client, secrets)
 * Parses PSI response and pings all backend endpoints.
 * Returns MetricsReport.
 */
function _parseMetrics(psiResponses, client, secrets) {
  var psiReport = { performance: 0, accessibility: 0, best_practices: 0, seo: 0,
                    fcp_ms: 0, lcp_ms: 0, tbt_ms: 0, cls: 0 };

  try {
    var raw = JSON.parse(psiResponses[0].getContentText());
    if (raw.error) {
      Logger.log('[PSI] API error: ' + JSON.stringify(raw.error));
    } else {
      var cats = raw.lighthouseResult.categories;
      var audits = raw.lighthouseResult.audits;

      psiReport.performance    = Math.round((cats['performance']    || {}).score * 100) || 0;
      psiReport.accessibility  = Math.round((cats['accessibility']  || {}).score * 100) || 0;
      psiReport.best_practices = Math.round((cats['best-practices'] || {}).score * 100) || 0;
      psiReport.seo            = Math.round((cats['seo']            || {}).score * 100) || 0;

      psiReport.fcp_ms = Math.round((audits['first-contentful-paint']  || {}).numericValue || 0);
      psiReport.lcp_ms = Math.round((audits['largest-contentful-paint']|| {}).numericValue || 0);
      psiReport.tbt_ms = Math.round((audits['total-blocking-time']     || {}).numericValue || 0);
      psiReport.cls    = parseFloat(((audits['cumulative-layout-shift'] || {}).numericValue || 0).toFixed(3));
    }
  } catch (e) {
    Logger.log('[PSI] Parse error: ' + e.message);
  }

  // Backend health pings — build requests for all configured endpoints
  var backendMetrics = _pingBackendEndpoints(client);

  return {
    psi:     psiReport,
    backend: backendMetrics
  };
}

/**
 * _pingBackendEndpoints(client)
 * Pings standard backend routes. Extend endpoint list per client config.
 * Returns BackendMetrics.
 */
function _pingBackendEndpoints(client) {
  var baseUrl = client.backend_url;
  if (!baseUrl) {
    return { avg_response_ms: 0, endpoints: [], all_healthy: false };
  }

  // Standard endpoints to check — adjust to match MotoVerse routes
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

  var start = Date.now();
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    Logger.log('[Backend] fetchAll error: ' + e.message);
    return { avg_response_ms: 0, endpoints: [], all_healthy: false };
  }

  var results = [];
  var totalMs = 0;
  var allHealthy = true;

  for (var i = 0; i < responses.length; i++) {
    var resp       = responses[i];
    var statusCode = resp.getResponseCode();
    var elapsed    = Math.round((Date.now() - start) / responses.length); // rough per-endpoint estimate
    var healthy    = statusCode >= 200 && statusCode < 300;

    if (!healthy) allHealthy = false;
    totalMs += elapsed;

    results.push({
      name:        endpointPaths[i].name,
      path:        endpointPaths[i].path,
      status:      statusCode,
      response_ms: elapsed,
      healthy:     healthy
    });
  }

  return {
    avg_response_ms: results.length > 0 ? Math.round(totalMs / results.length) : 0,
    endpoints:       results,
    all_healthy:     allHealthy
  };
}

// ============================================================
// COLLECTOR 2 — CODEBASE MAP (GitHub API)
// ============================================================

/**
 * _buildGithubRequests(client, secrets)
 * Builds GitHub API request objects for:
 *   - Repo file tree
 *   - Last 5 commits
 *   - README (for stack detection)
 * Returns array of request objects for UrlFetchApp.fetchAll.
 */
function _buildGithubRequests(client, secrets) {
  var base    = API.GITHUB + '/repos/' + client.github_owner + '/' + client.github_repo;
  var headers = { Authorization: 'Bearer ' + secrets.GITHUB_TOKEN,
                  Accept: 'application/vnd.github.v3+json' };
  var opts    = { method: 'get', headers: headers, muteHttpExceptions: true };

  return [
    Object.assign({ url: base + '/git/trees/' + GITHUB.MAIN_BRANCH + '?recursive=1' }, opts),
    Object.assign({ url: base + '/commits?per_page=' + THRESHOLD.RECENT_COMMITS_COUNT }, opts),
    Object.assign({ url: base + '/readme' }, opts)
  ];
}

/**
 * _parseCodebase(githubResponses, client, secrets)
 * Parses GitHub responses into a CodebaseMap.
 * Also fetches package.json content for stack/dependency info.
 */
function _parseCodebase(githubResponses, client, secrets) {
  var treeResp    = githubResponses[0];
  var commitsResp = githubResponses[1];
  var readmeResp  = githubResponses[2];

  // --- File tree ---
  var allFiles = [];
  var importMap = {};
  try {
    var treeData = JSON.parse(treeResp.getContentText());
    if (treeData.tree) {
      allFiles = treeData.tree
        .filter(function(f) { return f.type === 'blob'; })
        .map(function(f)    { return f.path; });
    }
  } catch (e) {
    Logger.log('[GitHub tree] Parse error: ' + e.message);
  }

  // --- Commits ---
  var recentCommits = [];
  try {
    var commitsData = JSON.parse(commitsResp.getContentText());
    if (Array.isArray(commitsData)) {
      recentCommits = commitsData.map(function(c) {
        return {
          sha:     c.sha ? c.sha.substring(0, 7) : '',
          message: (c.commit && c.commit.message) ? c.commit.message.split('\n')[0] : '',
          date:    (c.commit && c.commit.author)  ? c.commit.author.date : ''
        };
      });
    }
  } catch (e) {
    Logger.log('[GitHub commits] Parse error: ' + e.message);
  }

  // --- README for stack detection ---
  var stackContext = '';
  try {
    var readmeData = JSON.parse(readmeResp.getContentText());
    if (readmeData.content) {
      var decoded = Utilities.newBlob(
        Utilities.base64Decode(readmeData.content.replace(/\n/g, ''))
      ).getDataAsString();
      // Take first 800 chars — enough for stack info, not too large for the bundle
      stackContext = decoded.substring(0, 800);
    }
  } catch (e) {
    Logger.log('[GitHub readme] Parse error: ' + e.message);
  }

  // --- Detect stack from file list ---
  var stack = _detectStack(allFiles, stackContext);

  // --- Build import map from key files ---
  // We fetch package.json separately since it wasn't in the batch
  importMap = _buildImportMap(allFiles, client, secrets);

  return {
    stack:          stack,
    files:          allFiles,
    imports:        importMap,
    recent_commits: recentCommits,
    readme_excerpt: stackContext
  };
}

/**
 * _detectStack(files, readmeText)
 * Infers the tech stack from file names and README content.
 */
function _detectStack(files, readmeText) {
  var hasVite     = files.some(function(f) { return f.indexOf('vite.config')  >= 0; });
  var hasReact    = files.some(function(f) { return f.endsWith('.jsx') || f.endsWith('.tsx'); });
  var hasExpress  = files.some(function(f) { return f.indexOf('server.js')    >= 0 || f.indexOf('app.js') >= 0; });
  var hasMongo    = readmeText.toLowerCase().indexOf('mongo')  >= 0;
  var hasNext     = files.some(function(f) { return f.indexOf('next.config')  >= 0; });
  var hasTS       = files.some(function(f) { return f.endsWith('.ts') || f.endsWith('.tsx'); });

  var parts = [];
  if (hasReact) parts.push(hasNext ? 'Next.js' : 'React');
  if (hasVite)  parts.push('Vite');
  if (hasExpress) parts.push('Node.js + Express');
  if (hasMongo) parts.push('MongoDB');
  if (hasTS)    parts.push('TypeScript');

  return parts.length > 0 ? parts.join(' + ') : 'Unknown (check README)';
}

/**
 * _buildImportMap(files, client, secrets)
 * Fetches content of key frontend files and parses import statements
 * to build a dependency map. Only processes files likely to have imports.
 * Limits to 10 files to stay within Apps Script execution limits.
 */
function _buildImportMap(files, client, secrets) {
  var importableExts = ['.jsx', '.tsx', '.js', '.ts'];
  var skipPaths      = ['node_modules', '.min.', 'dist/', 'build/'];

  var targetFiles = files.filter(function(f) {
    var hasExt  = importableExts.some(function(ext) { return f.endsWith(ext); });
    var skip    = skipPaths.some(function(s) { return f.indexOf(s) >= 0; });
    return hasExt && !skip;
  }).slice(0, 10); // cap at 10 to avoid timeout

  if (targetFiles.length === 0) return {};

  var base    = API.GITHUB + '/repos/' + client.github_owner + '/' + client.github_repo + '/contents/';
  var headers = { Authorization: 'Bearer ' + secrets.GITHUB_TOKEN,
                  Accept: 'application/vnd.github.v3+json' };

  var requests = targetFiles.map(function(f) {
    return { url: base + f, method: 'get', headers: headers, muteHttpExceptions: true };
  });

  var importMap = {};
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < responses.length; i++) {
      try {
        var data    = JSON.parse(responses[i].getContentText());
        var content = data.content
          ? Utilities.newBlob(Utilities.base64Decode(data.content.replace(/\n/g, ''))).getDataAsString()
          : '';
        var imports = _parseImportStatements(content);
        if (imports.length > 0) {
          importMap[targetFiles[i]] = imports;
        }
      } catch (e) { /* skip unparseable file */ }
    }
  } catch (e) {
    Logger.log('[ImportMap] fetchAll error: ' + e.message);
  }

  return importMap;
}

/**
 * _parseImportStatements(fileContent)
 * Extracts local import paths from JS/JSX/TS file content.
 * Only captures relative imports (starts with . or ..) — not npm packages.
 */
function _parseImportStatements(content) {
  var importRegex = /import\s+.*?from\s+['"](\.[^'"]+)['"]/g;
  var requireRegex = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  var matches = [];
  var m;

  while ((m = importRegex.exec(content))  !== null) matches.push(m[1]);
  while ((m = requireRegex.exec(content)) !== null) matches.push(m[1]);

  return matches;
}

// ============================================================
// COLLECTOR 3 — HISTORY READER (Runs tab + FixMemory tab)
// ============================================================

/**
 * _collectHistory(client)
 * Reads the last N runs from the Runs tab and the full FixMemory tab.
 * Returns HistoryContext.
 */
function _collectHistory(client) {
  var runsSheet   = _getSheet(SHEET.RUNS);
  var memorySheet = _getSheet(SHEET.FIX_MEMORY);
  var baselineSheet = _getSheet(SHEET.BASELINE);

  // --- Last N runs ---
  var lastNRuns = [];
  var runsLastRow = runsSheet.getLastRow();
  if (runsLastRow >= 2) {
    var startRow = Math.max(2, runsLastRow - THRESHOLD.FIX_HISTORY_ROWS + 1);
    var numRows  = runsLastRow - startRow + 1;
    var runsData = runsSheet.getRange(startRow, 1, numRows, Object.keys(RUNS_COL).length).getValues();

    lastNRuns = runsData
      .filter(function(r) { return String(r[RUNS_COL.CLIENT_ID]) === client.client_id; })
      .map(function(r) {
        return {
          run_id:       r[RUNS_COL.RUN_ID],
          date:         r[RUNS_COL.TIMESTAMP],
          status:       r[RUNS_COL.STATUS],
          focus:        r[RUNS_COL.FOCUS],
          root_cause:   r[RUNS_COL.ROOT_CAUSE],
          fix_desc:     r[RUNS_COL.FIX_DESCRIPTION],
          perf_before:  r[RUNS_COL.PERF_BEFORE],
          perf_after:   r[RUNS_COL.PERF_AFTER],
          gates_failed: r[RUNS_COL.GATES_FAILED],
          reverted:     r[RUNS_COL.REVERTED]
        };
      });
  }

  // --- Fix memory ---
  var fixMemory = [];
  var memLastRow = memorySheet.getLastRow();
  if (memLastRow >= 2) {
    var memData = memorySheet.getRange(2, 1, memLastRow - 1, Object.keys(FIX_MEMORY_COL).length).getValues();
    fixMemory = memData.map(function(r) {
      return {
        date:          r[FIX_MEMORY_COL.DATE],
        focus:         r[FIX_MEMORY_COL.FOCUS],
        approach:      r[FIX_MEMORY_COL.APPROACH],
        files_changed: r[FIX_MEMORY_COL.FILES_CHANGED],
        success:       r[FIX_MEMORY_COL.SUCCESS],
        reverted:      r[FIX_MEMORY_COL.REVERTED],
        retry_count:   r[FIX_MEMORY_COL.RETRY_COUNT],
        gates_failed:  r[FIX_MEMORY_COL.GATES_FAILED]
      };
    });
  }

  // --- Baseline scores ---
  var baseline = { performance: 0, accessibility: 0, best_practices: 0, seo: 0,
                   lcp_ms: 0, fcp_ms: 0, tbt_ms: 0, cls: 0, backend_avg_ms: 0 };
  var baseLastRow = baselineSheet.getLastRow();
  if (baseLastRow >= 2) {
    var baseData = baselineSheet.getRange(2, 1, baseLastRow - 1, Object.keys(BASELINE_COL).length).getValues();
    for (var i = 0; i < baseData.length; i++) {
      if (String(baseData[i][BASELINE_COL.CLIENT_ID]) === client.client_id) {
        baseline = {
          performance:    baseData[i][BASELINE_COL.PERFORMANCE],
          accessibility:  baseData[i][BASELINE_COL.ACCESSIBILITY],
          best_practices: baseData[i][BASELINE_COL.BEST_PRACTICES],
          seo:            baseData[i][BASELINE_COL.SEO],
          lcp_ms:         baseData[i][BASELINE_COL.LCP_MS],
          fcp_ms:         baseData[i][BASELINE_COL.FCP_MS],
          tbt_ms:         baseData[i][BASELINE_COL.TBT_MS],
          cls:            baseData[i][BASELINE_COL.CLS],
          backend_avg_ms: baseData[i][BASELINE_COL.BACKEND_AVG_MS]
        };
        break;
      }
    }
  }

  return {
    last_10_runs: lastNRuns,
    fix_memory:   fixMemory,
    baseline:     baseline
  };
}

// ============================================================
// COLLECTOR 4 — SECURITY SCANNER (package.json CVE + secrets + Sonar)
// ============================================================

/**
 * _collectSecurity(client, secrets)
 * Fetches package.json, scans for CVE patterns and hardcoded secrets,
 * and checks SonarQube Cloud quality gate status.
 * Returns SecurityReport.
 */
function _collectSecurity(client, secrets) {
  var report = {
    sonar_gate:   'UNKNOWN',
    sonar_issues: [],
    secret_scan:  'CLEAN',
    cve_scan:     'CLEAN',
    findings:     []
  };

  // --- Fetch package.json from GitHub ---
  var base    = API.GITHUB + '/repos/' + client.github_owner + '/' + client.github_repo + '/contents/';
  var headers = { Authorization: 'Bearer ' + secrets.GITHUB_TOKEN,
                  Accept: 'application/vnd.github.v3+json' };

  // Try both frontend and backend package.json locations
  var pkgPaths = ['package.json', 'frontend/package.json', 'backend/package.json'];
  var pkgRequests = pkgPaths.map(function(p) {
    return { url: base + p, method: 'get', headers: headers, muteHttpExceptions: true };
  });

  try {
    var pkgResponses = UrlFetchApp.fetchAll(pkgRequests);
    for (var i = 0; i < pkgResponses.length; i++) {
      if (pkgResponses[i].getResponseCode() === 200) {
        var data = JSON.parse(pkgResponses[i].getContentText());
        if (data.content) {
          var content = Utilities.newBlob(
            Utilities.base64Decode(data.content.replace(/\n/g, ''))
          ).getDataAsString();

          var cveFindings = _scanForCVEPatterns(content, pkgPaths[i]);
          report.findings = report.findings.concat(cveFindings);
        }
      }
    }
  } catch (e) {
    Logger.log('[Security] package.json fetch error: ' + e.message);
  }

  if (report.findings.length > 0) {
    report.cve_scan = 'FINDINGS';
  }

  // --- SonarQube Cloud gate status ---
  if (secrets.SONARQUBE_TOKEN && secrets.SONARQUBE_PROJECT_KEY) {
    try {
      var sonarUrl = API.SONARCLOUD + '/qualitygates/project_status'
        + '?projectKey=' + encodeURIComponent(secrets.SONARQUBE_PROJECT_KEY)
        + '&branch=' + GITHUB.MAIN_BRANCH;

      var sonarResp = UrlFetchApp.fetch(sonarUrl, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + secrets.SONARQUBE_TOKEN },
        muteHttpExceptions: true
      });

      if (sonarResp.getResponseCode() === 200) {
        var sonarData = JSON.parse(sonarResp.getContentText());
        report.sonar_gate   = (sonarData.projectStatus || {}).status || 'UNKNOWN';
        report.sonar_issues = (sonarData.projectStatus || {}).conditions || [];
      } else {
        Logger.log('[Sonar] Non-200 response: ' + sonarResp.getResponseCode());
      }
    } catch (e) {
      Logger.log('[Sonar] API error: ' + e.message);
    }
  } else {
    Logger.log('[Sonar] Token or project key missing — skipping gate check');
    report.sonar_gate = 'NOT_CONFIGURED';
  }

  return report;
}

/**
 * _scanForCVEPatterns(content, filePath)
 * Scans package.json content for known vulnerable dependency patterns
 * and hardcoded secrets using regex.
 * Returns array of finding strings.
 */
function _scanForCVEPatterns(content, filePath) {
  var findings = [];

  // Known vulnerable package patterns (extend as needed)
  var vulnerablePackages = [
    { pattern: /"lodash":\s*"[^"]*3\.[0-4]\./,  desc: 'lodash < 4.17.21 (prototype pollution)' },
    { pattern: /"axios":\s*"[^"]*0\.[01]\d\./,   desc: 'axios < 0.21.2 (SSRF vulnerability)' },
    { pattern: /"express":\s*"[^"]*[34]\.[01]\./,desc: 'express old major version' },
    { pattern: /"node-fetch":\s*"[^"]*2\.6\.[0-5]/,desc: 'node-fetch < 2.6.7 (ReDoS)' }
  ];

  for (var i = 0; i < vulnerablePackages.length; i++) {
    if (vulnerablePackages[i].pattern.test(content)) {
      findings.push('[' + filePath + '] Potentially vulnerable: ' + vulnerablePackages[i].desc);
    }
  }

  // Hardcoded secret patterns
  var secretPatterns = [
    { pattern: /["']?(?:api_key|apikey|API_KEY)\s*["']?\s*[:=]\s*["'][^"']{8,}["']/i, desc: 'Hardcoded API key' },
    { pattern: /["']?(?:password|passwd|pwd)\s*["']?\s*[:=]\s*["'][^"']{4,}["']/i,   desc: 'Hardcoded password' },
    { pattern: /["']?(?:secret|token)\s*["']?\s*[:=]\s*["'][^"']{8,}["']/i,          desc: 'Hardcoded secret/token' },
    { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/,                                           desc: 'AWS access key pattern' }
  ];

  for (var j = 0; j < secretPatterns.length; j++) {
    if (secretPatterns[j].pattern.test(content)) {
      findings.push('[' + filePath + '] ' + secretPatterns[j].desc);
    }
  }

  return findings;
}

// ============================================================
// BUNDLE ASSEMBLY
// ============================================================

/**
 * _buildIntelligenceBundle(client, metrics, codebase, history, security)
 * Merges all 4 collectors into the final IntelligenceBundle JSON
 * that Gem 1 (AWPIS Performance Strategist) will receive.
 */
function _buildIntelligenceBundle(client, metrics, codebase, history, security) {
  var runId     = getState(STATE_KEY.RUN_ID);
  var timestamp = new Date().toISOString();

  return {
    run_id:      runId,
    client_id:   client.client_id,
    client_name: client.client_name,
    timestamp:   timestamp,

    psi_metrics: {
      performance:    metrics.psi.performance,
      accessibility:  metrics.psi.accessibility,
      best_practices: metrics.psi.best_practices,
      seo:            metrics.psi.seo,
      fcp_ms:         metrics.psi.fcp_ms,
      lcp_ms:         metrics.psi.lcp_ms,
      tbt_ms:         metrics.psi.tbt_ms,
      cls:            metrics.psi.cls
    },

    backend_metrics: {
      avg_response_ms: metrics.backend.avg_response_ms,
      endpoints:       metrics.backend.endpoints,
      all_healthy:     metrics.backend.all_healthy
    },

    codebase_map: {
      stack:          codebase.stack,
      files:          codebase.files,
      imports:        codebase.imports,
      recent_commits: codebase.recent_commits,
      readme_excerpt: codebase.readme_excerpt
    },

    history: {
      last_10_runs: history.last_10_runs,
      fix_memory:   history.fix_memory,
      baseline:     history.baseline
    },

    security: {
      sonar_gate:   security.sonar_gate,
      sonar_issues: security.sonar_issues,
      secret_scan:  security.findings.some(function(f) { return f.indexOf('secret') >= 0 || f.indexOf('key') >= 0; }) ? 'FINDINGS' : 'CLEAN',
      cve_scan:     security.cve_scan,
      findings:     security.findings
    },

    targets: {
      perf_target:  client.perf_target,
      lcp_target_ms: client.lcp_target_ms,
      a11y_min:     THRESHOLD.A11Y_MIN,
      bp_min:       THRESHOLD.BP_MIN,
      seo_min:      THRESHOLD.SEO_MIN,
      cls_max:      THRESHOLD.CLS_MAX,
      backend_ms_max: THRESHOLD.BACKEND_RESP_MAX_MS
    }
  };
}
