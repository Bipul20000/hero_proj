/**
 * Run this function once to automatically create all required tabs,
 * set up column headers, and populate default configuration values.
 */
function initializeSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Define the required tabs and their initial data (headers + default rows)
  const schemas = {
    'Config': [
      ['key', 'value', 'description', 'lastModified'],
      ['PERF_THRESHOLD', '80', 'Minimum acceptable performance score', new Date()],
      ['ACCESSIBILITY_THRESHOLD', '90', 'Minimum acceptable accessibility score', new Date()],
      ['SEO_THRESHOLD', '90', 'Minimum acceptable SEO score', new Date()],
      ['BP_THRESHOLD', '90', 'Minimum acceptable best practices score', new Date()],
      ['LCP_TARGET_MS', '2500', 'Largest Contentful Paint target (ms)', new Date()],
      ['CLS_TARGET', '0.1', 'Cumulative Layout Shift target', new Date()],
      ['INP_TARGET_MS', '200', 'Interaction to Next Paint target (ms)', new Date()],
      ['MAX_RETRIES', '3', 'Maximum fix generation retries', new Date()],
      ['STABILIZATION_WAIT_SEC', '90', 'Seconds to wait after deploy before verification', new Date()],
      ['HISTORY_LOOKBACK', '10', 'Number of past runs to include in history', new Date()],
      ['DRY_RUN', 'false', 'If true, skip production deployment', new Date()]
    ],
    'Secrets': [
      ['key', 'status', 'lastRotated', 'notes'],
      ['GITHUB_TOKEN', 'MISSING', '', 'GitHub PAT with repo scope'],
      ['GITHUB_OWNER', 'MISSING', '', 'GitHub username or org'],
      ['GITHUB_REPO', 'MISSING', '', 'Repository name'],
      ['PAGESPEED_KEY', 'MISSING', '', 'PSI API key'],
      ['VERCEL_DEPLOY_HOOK', 'MISSING', '', 'Vercel preview deploy hook URL'],
      ['VERCEL_TOKEN', 'MISSING', '', 'Vercel API token'],
      ['VERCEL_PROJECT_ID', 'MISSING', '', 'Vercel project ID'],
      ['SONARQUBE_TOKEN', 'MISSING', '', 'SonarCloud API token'],
      ['SONARQUBE_PROJECT_KEY', 'MISSING', '', 'SonarCloud project key'],
      ['REPORT_EMAIL', 'MISSING', '', 'Email for reports'],
      ['RUN_MODE', 'dry_run', '', 'production or dry_run'],
      ['WEBSITE_URL', 'MISSING', '', 'Primary URL to monitor'],
      ['BACKEND_URL', 'MISSING', '', 'Backend API URL']
    ],
    'Runs': [['runId', 'clientUrl', 'startedAt', 'completedAt', 'status', 'scoreBefore', 'scoreAfter', 'fixTitle', 'duration', 'errorLog']],
    'FixMemory': [['fixId', 'category', 'title', 'status', 'scoreBefore', 'scoreAfter', 'appliedAt', 'gemFeedback', 'failureReason']],
    'Baseline': [['clientUrl', 'performanceScore', 'accessibilityScore', 'bestPracticesScore', 'seoScore', 'lcp', 'fid', 'cls', 'ttfb', 'inp', 'updatedAt']],
    'State': [['key', 'value', 'updatedAt']],
    'Clients': [['clientName', 'websiteUrl', 'githubRepo', 'vercelProjectId', 'registeredAt', 'active', 'lastRunId']]
  };

  for (const tabName in schemas) {
    let sheet = ss.getSheetByName(tabName);
    
    // Create tab if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }
    
    // If the sheet is completely empty, populate it
    if (sheet.getLastRow() === 0) {
      const data = schemas[tabName];
      sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      
      // Make the first row bold and freeze it
      sheet.getRange(1, 1, 1, data[0].length).setFontWeight("bold");
      sheet.setFrozenRows(1);
      Logger.log(`Initialized tab: ${tabName}`);
    } else {
      Logger.log(`Tab ${tabName} already has data. Skipping.`);
    }
  }

  // Remove the default "Sheet1" if we created the others and it is empty
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet1);
    Logger.log("Removed default Sheet1.");
  }

  Logger.log("Spreadsheet initialization complete! You can safely close this log.");
  try {
    SpreadsheetApp.getUi().alert("Spreadsheet Initialized successfully!");
  } catch (e) {
    // Ignore error if run from editor without UI attached
  }
}
