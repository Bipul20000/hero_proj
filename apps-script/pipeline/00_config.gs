// ============================================================
// AWPIS — 00_config.gs
// All constants. No secrets here — those live in PropertiesService.
// Every other .gs file imports from this one.
// ============================================================

// ------------------------------------------------------------
// SHEET NAMES
// ------------------------------------------------------------
var SHEET = {
  CONFIG:     'Config',
  SECRETS:    'Secrets',
  RUNS:       'Runs',
  FIX_MEMORY: 'FixMemory',
  BASELINE:   'Baseline',
  STATE:      'State',
  CLIENTS:    'Clients'
};

// ------------------------------------------------------------
// CONFIG TAB — column indices (0-based)
// ------------------------------------------------------------
var CONFIG_COL = {
  CLIENT_ID:         0,
  CLIENT_NAME:       1,
  WEBSITE_URL:       2,
  GITHUB_REPO:       3,
  GITHUB_OWNER:      4,
  VERCEL_PROJECT_ID: 5,
  REPORT_EMAIL:      6,
  RUN_MODE:          7,   // 'AUTOMATED' | 'SUPERVISED'
  PERF_TARGET:       8,
  LCP_TARGET_MS:     9,
  BACKEND_URL:       10,
  ACTIVE:            11
};

// ------------------------------------------------------------
// RUNS TAB — column indices (0-based)
// ------------------------------------------------------------
var RUNS_COL = {
  RUN_ID:              0,
  TIMESTAMP:           1,
  CLIENT_ID:           2,
  STATUS:              3,
  PERF_BEFORE:         4,
  A11Y_BEFORE:         5,
  BP_BEFORE:           6,
  SEO_BEFORE:          7,
  FCP_BEFORE:          8,
  LCP_BEFORE:          9,
  TBT_BEFORE:          10,
  CLS_BEFORE:          11,
  BACKEND_AVG_BEFORE:  12,
  BACKEND_STATUS_BEFORE: 13,
  PERF_AFTER:          14,
  A11Y_AFTER:          15,
  BP_AFTER:            16,
  SEO_AFTER:           17,
  FCP_AFTER:           18,
  LCP_AFTER:           19,
  TBT_AFTER:           20,
  CLS_AFTER:           21,
  BACKEND_AVG_AFTER:   22,
  BACKEND_STATUS_AFTER: 23,
  FOCUS:               24,
  ROOT_CAUSE:          25,
  FILES_CHANGED:       26,
  FIX_DESCRIPTION:     27,
  GATES_PASSED:        28,
  GATES_FAILED:        29,
  SANDBOX_RESULT:      30,
  DEPLOY_STATUS:       31,
  REVERTED:            32,
  SONAR_GATE_BEFORE:   33,
  SONAR_GATE_AFTER:    34,
  GEMINI_ANALYSIS:     35,
  PR_URL:              36,
  RUN_DURATION_MS:     37
};

// ------------------------------------------------------------
// FIX MEMORY TAB — column indices (0-based)
// ------------------------------------------------------------
var FIX_MEMORY_COL = {
  DATE:          0,
  FOCUS:         1,
  APPROACH:      2,
  FILES_CHANGED: 3,
  PSI_BEFORE:    4,
  PSI_AFTER:     5,
  SONAR_BEFORE:  6,
  SONAR_AFTER:   7,
  SUCCESS:       8,
  REVERTED:      9,
  SIDE_EFFECTS:  10,
  RETRY_COUNT:   11,
  GATES_FAILED:  12
};

// ------------------------------------------------------------
// BASELINE TAB — column indices (0-based)
// ------------------------------------------------------------
var BASELINE_COL = {
  CLIENT_ID:       0,
  PERFORMANCE:     1,
  ACCESSIBILITY:   2,
  BEST_PRACTICES:  3,
  SEO:             4,
  LCP_MS:          5,
  FCP_MS:          6,
  TBT_MS:          7,
  CLS:             8,
  BACKEND_AVG_MS:  9,
  LAST_UPDATED:    10
};

// ------------------------------------------------------------
// STATE TAB — column indices (0-based)
// ------------------------------------------------------------
var STATE_COL = {
  KEY:   0,
  VALUE: 1
};

// ------------------------------------------------------------
// SECRETS TAB — column indices (0-based)
// ------------------------------------------------------------
var SECRETS_COL = {
  KEY_NAME:        0,
  ENCRYPTED_VALUE: 1
};

// ------------------------------------------------------------
// STATE KEYS — used by 08_state.gs
// ------------------------------------------------------------
var STATE_KEY = {
  RUN_ID:               'run_id',
  CLIENT_ID:            'client_id',
  INTEL_BUNDLE:         'intelligence_bundle',
  FIX_PLAN:             'fix_plan',
  FILE_BUNDLE:          'file_bundle',
  GENERATED_FIX:        'generated_fix',
  SANDBOX_RESULT:       'sandbox_result',
  PREVIEW_URL:          'preview_url',
  PREVIEW_PSI:          'preview_psi',
  PRODUCTION_PSI:       'production_psi',
  BASELINE_PSI:         'baseline_psi',
  PR_URL:               'pr_url',
  GATE_RESULTS:         'gate_results',
  RUN_START_TIME:       'run_start_time',
  SONAR_BEFORE:         'sonar_before',
  SONAR_AFTER:          'sonar_after',
  RETRY_COUNT:          'retry_count'
};

// ------------------------------------------------------------
// RUN STATUS VALUES
// ------------------------------------------------------------
var RUN_STATUS = {
  RUNNING:   'RUNNING',
  SUCCESS:   'SUCCESS',
  BLOCKED:   'BLOCKED',
  REVERTED:  'REVERTED',
  FAILED:    'FAILED',
  ESCALATED: 'ESCALATED'
};

// ------------------------------------------------------------
// RUN MODES
// ------------------------------------------------------------
var RUN_MODE = {
  AUTOMATED:  'AUTOMATED',
  SUPERVISED: 'SUPERVISED'
};

// ------------------------------------------------------------
// GATE NAMES + RESULTS
// ------------------------------------------------------------
var GATE = {
  STRUCTURAL:   'structural',
  SONARQUBE:    'sonarqube',
  CRITIC:       'critic',
  BLAST_RADIUS: 'blast_radius'
};

var GATE_RESULT = {
  PASS:    'PASS',
  FAIL:    'FAIL',
  APPROVE: 'APPROVE',
  REJECT:  'REJECT',
  CLEAR:   'CLEAR',
  WIDE:    'WIDE'
};

// ------------------------------------------------------------
// THRESHOLDS — match Layer 3 priority queue exactly
// ------------------------------------------------------------
var THRESHOLD = {
  CLS_MAX:              0.3,
  PERF_TARGET_DEFAULT:  90,
  A11Y_MIN:             95,
  BP_MIN:               100,
  SEO_MIN:              100,
  BACKEND_RESP_MAX_MS:  500,
  REGRESSION_DROP_MAX:  5,      // >5 point drop triggers revert
  CONFIDENCE_AUTO:      0.75,   // above this = auto-proceed
  VERCEL_POLL_TIMEOUT_MS: 180000, // 3 minutes
  VERCEL_POLL_INTERVAL_MS: 5000,
  POST_DEPLOY_WAIT_MS:  90000,  // 90 seconds before PSI check
  MAX_GATE_RETRIES:     3,
  FIX_HISTORY_ROWS:     10,
  RECENT_COMMITS_COUNT: 5
};

// ------------------------------------------------------------
// EXTERNAL API BASE URLS
// ------------------------------------------------------------
var API = {
  PSI:       'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
  GITHUB:    'https://api.github.com',
  VERCEL:    'https://api.vercel.com',
  SONARCLOUD: 'https://sonarcloud.io/api'
};

// ------------------------------------------------------------
// PSI STRATEGY + CATEGORIES
// ------------------------------------------------------------
var PSI = {
  STRATEGY:   'mobile',
  CATEGORIES: ['performance', 'accessibility', 'best-practices', 'seo']
};

// ------------------------------------------------------------
// GITHUB BRANCH PREFIX
// ------------------------------------------------------------
var GITHUB = {
  PREVIEW_BRANCH_PREFIX: 'awpis/preview-',
  MAIN_BRANCH:           'main',
  PR_TITLE_PREFIX:       'perf'
};

// ------------------------------------------------------------
// STRUCTURAL GATE — regex patterns (Gate 1)
// Frontend checks
// ------------------------------------------------------------
var STRUCTURAL_CHECK = {
  FRONTEND: {
    ROOT_DIV:          /<div\s+id=["']root["']/,
    MAIN_SCRIPT:       /main\.(jsx?|tsx?)/,
    EXPORT_DEFAULT:    /export\s+default/,
    FORBIDDEN_EVAL:    /\beval\s*\(/,
    FORBIDDEN_DOC_WRITE: /document\.write\s*\(/,
    FORBIDDEN_INNER_HTML: /dangerouslySetInnerHTML/,
    HARDCODED_SECRET:  /(?:API_KEY|api_key|token|TOKEN|secret|SECRET)\s*=\s*["'][^"']{8,}/
  },
  BACKEND: {
    APP_LISTEN:        /app\.listen\s*\(/,
    MODULE_EXPORTS:    /module\.exports/,
    TRY_CATCH:         /try\s*\{[\s\S]*?\}\s*catch/,
    INLINED_ENV:       /process\.env\.[A-Z_]+\s*=\s*["']/
  }
};

// ------------------------------------------------------------
// PIPELINE VERSION (bump when architecture changes)
// ------------------------------------------------------------
var PIPELINE_VERSION = '1.0.0';
