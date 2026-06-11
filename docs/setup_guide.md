# AWPIS Setup Guide

> Step-by-step instructions to deploy the Autonomous Web Performance Intelligence System from scratch.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the Google Sheet](#2-create-the-google-sheet)
3. [Create the Apps Script Project](#3-create-the-apps-script-project)
4. [Add Pipeline Code](#4-add-pipeline-code)
5. [Configure Script Properties](#5-configure-script-properties)
6. [Create the 5 Google Gems](#6-create-the-5-google-gems)
7. [Build the Workspace Studio Flow](#7-build-the-workspace-studio-flow)
8. [Install Triggers](#8-install-triggers)
9. [Create the Client Registration Form](#9-create-the-client-registration-form)
10. [First Run Checklist](#10-first-run-checklist)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

Before you begin, ensure you have the following accounts and services set up:

### Required Accounts

| Service          | What You Need                                  | Where to Get It                       |
| ---------------- | ---------------------------------------------- | ------------------------------------- |
| Google Workspace | Business or Enterprise account with Gemini     | [workspace.google.com](https://workspace.google.com) |
| GitHub           | Account with a repository for your website     | [github.com](https://github.com)      |
| Vercel           | Account with a project linked to your repo     | [vercel.com](https://vercel.com)      |
| SonarCloud       | Free account with a project configured         | [sonarcloud.io](https://sonarcloud.io)|
| Google Cloud     | Project with PageSpeed Insights API enabled    | [console.cloud.google.com](https://console.cloud.google.com) |

### Required Tokens and Keys

Generate these before proceeding (you will enter them in Step 5):

| Token                  | How to Generate                                                          |
| ---------------------- | ------------------------------------------------------------------------ |
| `GITHUB_TOKEN`         | GitHub → Settings → Developer Settings → Personal Access Tokens → Generate new token (classic). Scopes: `repo`, `workflow` |
| `PAGESPEED_KEY`        | Google Cloud Console → APIs & Services → Credentials → Create API Key. Enable "PageSpeed Insights API" |
| `VERCEL_TOKEN`         | Vercel → Settings → Tokens → Create                                     |
| `VERCEL_DEPLOY_HOOK`   | Vercel → Project → Settings → Git → Deploy Hooks → Create Hook          |
| `VERCEL_PROJECT_ID`    | Vercel → Project → Settings → General → Project ID                      |
| `SONARQUBE_TOKEN`      | SonarCloud → My Account → Security → Generate Token                     |
| `SONARQUBE_PROJECT_KEY`| SonarCloud → Project → Information → Project Key                        |

### Verify Gemini Access

Confirm you have access to Google Gems (Gemini) in your Workspace account:

1. Go to [gemini.google.com](https://gemini.google.com).
2. Click the **Gems** icon in the left sidebar.
3. Verify you can create custom Gems.

If Gems are not available, contact your Workspace administrator to enable Gemini features.

---

## 2. Create the Google Sheet

### 2a. Create the Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com).
2. Create a new spreadsheet.
3. Rename it to **"AWPIS Control Center"**.

### 2b. Create All 7 Tabs

Rename the default tab and create additional tabs. You should have exactly these 7 tabs:

| Tab #  | Tab Name      | Purpose                                    |
| ------ | ------------- | ------------------------------------------ |
| 1      | `Config`      | Runtime configuration settings             |
| 2      | `Secrets`     | Secret inventory (not actual values)       |
| 3      | `Runs`        | Pipeline execution history                 |
| 4      | `FixMemory`   | Record of all attempted fixes              |
| 5      | `Baseline`    | Current performance baseline per client    |
| 6      | `State`       | Key-value state store                      |
| 7      | `Clients`     | Registered client/website list             |

### 2c. Add Column Headers

Add the following headers to **Row 1** of each tab:

#### Config Tab

```
A1: key
B1: value
C1: description
D1: lastModified
```

Populate these initial configuration rows:

| key                       | value   | description                                      |
| ------------------------- | ------- | ------------------------------------------------ |
| `PERF_THRESHOLD`          | `80`    | Minimum acceptable performance score             |
| `ACCESSIBILITY_THRESHOLD` | `90`    | Minimum acceptable accessibility score           |
| `SEO_THRESHOLD`           | `90`    | Minimum acceptable SEO score                     |
| `BP_THRESHOLD`            | `90`    | Minimum acceptable best practices score          |
| `LCP_TARGET_MS`           | `2500`  | Largest Contentful Paint target (ms)             |
| `CLS_TARGET`              | `0.1`   | Cumulative Layout Shift target                   |
| `INP_TARGET_MS`           | `200`   | Interaction to Next Paint target (ms)            |
| `MAX_RETRIES`             | `3`     | Maximum fix generation retries                   |
| `STABILIZATION_WAIT_SEC`  | `90`    | Seconds to wait after deploy before verification |
| `HISTORY_LOOKBACK`        | `10`    | Number of past runs to include in history        |
| `DRY_RUN`                 | `false` | If true, skip production deployment              |

#### Secrets Tab

```
A1: key
B1: status
C1: lastRotated
D1: notes
```

Populate with all 13 secret names (status will be updated after Step 5):

| key                    | status    | notes                          |
| ---------------------- | --------- | ------------------------------ |
| `GITHUB_TOKEN`         | `MISSING` | GitHub PAT with repo scope     |
| `GITHUB_OWNER`         | `MISSING` | GitHub username or org         |
| `GITHUB_REPO`          | `MISSING` | Repository name                |
| `PAGESPEED_KEY`        | `MISSING` | PSI API key                    |
| `VERCEL_DEPLOY_HOOK`   | `MISSING` | Vercel preview deploy hook URL |
| `VERCEL_TOKEN`         | `MISSING` | Vercel API token               |
| `VERCEL_PROJECT_ID`    | `MISSING` | Vercel project ID              |
| `SONARQUBE_TOKEN`      | `MISSING` | SonarCloud API token           |
| `SONARQUBE_PROJECT_KEY`| `MISSING` | SonarCloud project key         |
| `REPORT_EMAIL`         | `MISSING` | Email for reports              |
| `RUN_MODE`             | `MISSING` | production or dry_run          |
| `WEBSITE_URL`          | `MISSING` | Primary URL to monitor         |
| `BACKEND_URL`          | `MISSING` | Backend API URL                |

#### Runs Tab

```
A1: runId
B1: clientUrl
C1: startedAt
D1: completedAt
E1: status
F1: scoreBefore
G1: scoreAfter
H1: fixTitle
I1: duration
J1: errorLog
```

#### FixMemory Tab

```
A1: fixId
B1: category
C1: title
D1: status
E1: scoreBefore
F1: scoreAfter
G1: appliedAt
H1: gemFeedback
I1: failureReason
```

#### Baseline Tab

```
A1: clientUrl
B1: performanceScore
C1: accessibilityScore
D1: bestPracticesScore
E1: seoScore
F1: lcp
G1: fid
H1: cls
I1: ttfb
J1: inp
K1: updatedAt
```

#### State Tab

```
A1: key
B1: value
C1: updatedAt
```

#### Clients Tab

```
A1: clientName
B1: websiteUrl
C1: githubRepo
D1: vercelProjectId
E1: registeredAt
F1: active
G1: lastRunId
```

### 2d. Format the Sheet

1. **Freeze Row 1** on all tabs (View → Freeze → 1 row).
2. **Bold** all header rows.
3. Set the `Runs` and `FixMemory` date columns to **Date time** format.
4. Set score columns to **Number** format with 0 decimal places.

---

## 3. Create the Apps Script Project

1. In the AWPIS Control Center spreadsheet, go to **Extensions → Apps Script**.
2. This opens the bound Apps Script editor.
3. The default `Code.gs` file will be created automatically — you will rename it in the next step.

> [!IMPORTANT]
> The Apps Script project must be **bound** to the spreadsheet (opened from Extensions menu), not a standalone project. This gives the script automatic access to the spreadsheet via `SpreadsheetApp.getActiveSpreadsheet()`.

---

## 4. Add Pipeline Code

### 4a. Create Script Files

In the Apps Script editor, create the following `.gs` files. Delete the default `Code.gs` file, then create each file via **File → New → Script**:

| Order | Filename         | Source File in Repository               |
| ----- | ---------------- | --------------------------------------- |
| 1     | `00_config.gs`   | `apps-script/pipeline/00_config.gs`     |
| 2     | `01_trigger.gs`  | `apps-script/pipeline/01_trigger.gs`    |
| 3     | `02_collect.gs`  | `apps-script/pipeline/02_collect.gs`    |
| 4     | `03_github.gs`   | `apps-script/pipeline/03_github.gs`     |
| 5     | `04_sonarqube.gs`| `apps-script/pipeline/04_sonarqube.gs`  |
| 6     | `05_sandbox.gs`  | `apps-script/pipeline/05_sandbox.gs`    |
| 7     | `06_deploy.gs`   | `apps-script/pipeline/06_deploy.gs`     |
| 8     | `07_memory.gs`   | `apps-script/pipeline/07_memory.gs`     |
| 9     | `08_state.gs`    | `apps-script/pipeline/08_state.gs`      |

### 4b. Paste Code

For each file:

1. Open the corresponding source file from the repository.
2. Copy the entire contents.
3. Paste into the matching Apps Script file.
4. Save (Ctrl+S / Cmd+S).

### 4c. Verify File Order

Apps Script executes files in alphabetical order for global declarations. The `00_`–`08_` prefix naming ensures correct initialization order. Verify in the left sidebar that files appear in numerical order.

### 4d. Initial Save and Authorization

1. Click **Save All** (disk icon or Ctrl+S).
2. Click **Run** on any function (e.g., a test function from `00_config.gs`).
3. A permissions dialog will appear. Click **Review Permissions**.
4. Select your Google account.
5. Click **Advanced → Go to AWPIS Control Center (unsafe)**.
6. Click **Allow**.

This grants the script permission to:
- Read/write the bound spreadsheet
- Make external HTTP requests (`UrlFetchApp`)
- Send emails (`GmailApp`)
- Create triggers (`ScriptApp`)

---

## 5. Configure Script Properties

Script Properties store all sensitive values. They are encrypted at rest and never exposed in code.

### 5a. Open Script Properties

In the Apps Script editor:

1. Click the **gear icon** (Project Settings) in the left sidebar.
2. Scroll down to **Script Properties**.
3. Click **Edit script properties**.

### 5b. Add All 13 Properties

Add each property one at a time:

| Property               | Value to Enter                                          |
| ---------------------- | ------------------------------------------------------- |
| `GITHUB_TOKEN`         | Your GitHub Personal Access Token                       |
| `GITHUB_OWNER`         | Your GitHub username or organization name               |
| `GITHUB_REPO`          | Your repository name (e.g., `my-website`)               |
| `PAGESPEED_KEY`        | Your PageSpeed Insights API key                         |
| `VERCEL_DEPLOY_HOOK`   | Your Vercel deploy hook URL                             |
| `VERCEL_TOKEN`         | Your Vercel API token                                   |
| `VERCEL_PROJECT_ID`    | Your Vercel project ID                                  |
| `SONARQUBE_TOKEN`      | Your SonarCloud API token                               |
| `SONARQUBE_PROJECT_KEY`| Your SonarCloud project key                             |
| `REPORT_EMAIL`         | Email address to receive reports (e.g., `you@gmail.com`)|
| `RUN_MODE`             | `dry_run` (change to `production` after first test)     |
| `WEBSITE_URL`          | Your website URL (e.g., `https://example.com`)          |
| `BACKEND_URL`          | Your backend URL (e.g., `https://api.example.com`)      |

### 5c. Click Save.

### 5d. Update Secrets Tab

Go back to the spreadsheet's `Secrets` tab and update the `status` column to `SET` for all 13 rows. Enter today's date in the `lastRotated` column.

> [!CAUTION]
> Never paste actual secret values into the Google Sheet. The `Secrets` tab only tracks whether each secret is configured — the actual values must only exist in Script Properties.

---

## 6. Create the 5 Google Gems

Each Gem is a custom Gemini persona with a specialized system prompt. Create them in Google Gems (Gemini).

### 6a. Navigate to Gems

1. Go to [gemini.google.com](https://gemini.google.com).
2. Click the **Gems** icon in the left sidebar.
3. Click **New Gem**.

### 6b. Create Each Gem

Create 5 Gems with the following names and prompts:

| # | Gem Name                      | Source Prompt File                    |
| - | ----------------------------- | ------------------------------------- |
| 1 | **AWPIS Performance Strategist** | `apps-script/gems/gem1_strategist.md` |
| 2 | **AWPIS Frontend Engineer**      | `apps-script/gems/gem2_frontend.md`   |
| 3 | **AWPIS Backend Engineer**       | `apps-script/gems/gem3_backend.md`    |
| 4 | **AWPIS Code Critic**            | `apps-script/gems/gem4_critic.md`     |
| 5 | **AWPIS Report Writer**          | `apps-script/gems/gem5_reporter.md`   |

For each Gem:

1. Click **New Gem**.
2. Enter the Gem name exactly as shown above.
3. In the **Instructions** field, paste the entire contents of the corresponding prompt file from the repository.
4. Click **Save**.
5. Test the Gem with a sample prompt to verify it responds in character.

> [!TIP]
> After creating each Gem, send it a test message like "Describe your role in the AWPIS pipeline." It should respond with a clear explanation of its specific responsibility.

### 6c. Note Gem IDs

After creating each Gem, note its URL. The Gem ID is the last segment of the URL (e.g., `gemini.google.com/gem/abc123` → ID is `abc123`). You will need these IDs when configuring the Workspace Studio flow.

---

## 7. Build the Workspace Studio Flow

Workspace Studio orchestrates the pipeline by connecting Apps Script functions with Gem invocations in a defined sequence.

### 7a. Open Workspace Studio

1. Go to [Workspace Studio](https://studio.google.com) (or the equivalent URL provided by your Workspace admin).
2. Click **Create New Flow**.
3. Name it **"AWPIS Daily Pipeline"**.

### 7b. Define the Flow Steps

Build the flow with the following step sequence:

```
START
  │
  ▼
┌─────────────────────────────────────────┐
│ Step 1: Trigger & Initialize            │
│ Type: Apps Script Function              │
│ Function: initializePipelineRun()       │
│ Output: runId, clientConfig             │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 2: Intelligence Gathering          │
│ Type: Apps Script Function              │
│ Function: collectIntelligence()         │
│ Input: clientConfig                     │
│ Output: intelligenceBundle              │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 3: Strategic Analysis              │
│ Type: Gem Invocation                    │
│ Gem: AWPIS Performance Strategist       │
│ Input: intelligenceBundle (JSON)        │
│ Output: fixPlan (JSON)                  │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 4: Decision Gate                   │
│ Type: Conditional Branch                │
│ Condition: fixPlan.status ≠ NO_FIX      │
│ True → Step 5                           │
│ False → Step 10 (Report Only)           │
└────────────────┬────────────────────────┘
                 │ (fix needed)
                 ▼
┌─────────────────────────────────────────┐
│ Step 5: Code Fetch                      │
│ Type: Apps Script Function              │
│ Function: fetchTargetCode()             │
│ Input: fixPlan.targetFiles              │
│ Output: targetCodeMap                   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 6: Fix Generation                  │
│ Type: Gem Invocation (conditional)      │
│ Gem: AWPIS Frontend Engineer (if        │
│       fixPlan.category == "frontend")   │
│   OR: AWPIS Backend Engineer (if        │
│       fixPlan.category == "backend")    │
│ Input: fixPlan + targetCodeMap          │
│ Output: generatedFix                    │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 7: Quality Gates                   │
│ Type: Apps Script Function + Gem        │
│ Function: runQualityGates()             │
│ (includes Gem 4 invocation for Gate 2)  │
│ Input: generatedFix                     │
│ Output: qualityResult                   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 8: Sandbox Validation              │
│ Type: Apps Script Function              │
│ Function: runSandboxValidation()        │
│ Input: generatedFix                     │
│ Output: sandboxResult                   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 9: Production Deploy               │
│ Type: Apps Script Function              │
│ Function: deployToProduction()          │
│ Input: sandboxResult                    │
│ Output: deployResult                    │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Step 10: Learning + Reporting           │
│ Type: Apps Script Function + Gem        │
│ Function: updateMemoryAndBaseline()     │
│ Gem: AWPIS Report Writer                │
│ Input: full pipelineResult              │
│ Output: email report sent               │
└─────────────────────────────────────────┘
                 │
                 ▼
               END
```

### 7c. Configure Error Handling

For each step, configure the error behavior:

- **On Error:** Log the error to the `State` tab, then jump to Step 10 (Reporting) so that even failed runs produce a report.
- **Timeout:** Set a 5-minute timeout per step.
- **Retry:** Enable 1 automatic retry for Steps 2, 5, 8, and 9 (API-dependent steps).

### 7d. Connect Apps Script

In Workspace Studio, link to your Apps Script project:

1. In each Apps Script step, select **Custom Connector → Apps Script**.
2. Choose the AWPIS Control Center project.
3. Select the appropriate function name.
4. Map input/output variables to the flow's data context.

### 7e. Save and Activate

1. Click **Save** to save the flow.
2. Click **Activate** to enable the flow to be triggered.

---

## 8. Install Triggers

### 8a. Daily Trigger (Automated)

In the Apps Script editor:

1. Click the **clock icon** (Triggers) in the left sidebar.
2. Click **+ Add Trigger**.
3. Configure:

| Setting                   | Value                       |
| ------------------------- | --------------------------- |
| Function to run           | `runDailyPipeline`          |
| Deployment                | Head                        |
| Event source              | Time-driven                 |
| Type of time-based trigger| Day timer                   |
| Time of day               | 9am to 10am                 |

4. Click **Save**.

### 8b. Form Submit Trigger

This trigger fires when a new client registers via the Google Form (created in Step 9):

1. Click **+ Add Trigger**.
2. Configure:

| Setting                   | Value                       |
| ------------------------- | --------------------------- |
| Function to run           | `onFormSubmit`              |
| Deployment                | Head                        |
| Event source              | From spreadsheet            |
| Event type                | On form submit              |

3. Click **Save**.

### 8c. Manual Run Button

Add a custom menu to the spreadsheet for on-demand runs:

The `01_trigger.gs` file includes an `onOpen()` function that adds a custom menu:

```javascript
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('AWPIS')
    .addItem('Run Pipeline Now', 'runPipelineManual')
    .addItem('Run Dry Run', 'runPipelineDryRun')
    .addItem('View Last Report', 'showLastReport')
    .addToUi();
}
```

This menu appears automatically when the spreadsheet is opened. No additional trigger setup is needed — the `onOpen` function is a simple trigger that runs automatically.

### 8d. Verify Triggers

After installation, you should see at least 2 triggers in the Triggers panel:

| Trigger          | Function            | Event                    |
| ---------------- | ------------------- | ------------------------ |
| Daily timer      | `runDailyPipeline`  | Time-driven, daily 9 AM |
| Form submit      | `onFormSubmit`      | Spreadsheet form submit  |

---

## 9. Create the Client Registration Form

### 9a. Create the Form

1. In the AWPIS Control Center spreadsheet, go to **Tools → Create a new form**.
2. This creates a Google Form linked to the spreadsheet.
3. Rename the form to **"AWPIS Client Registration"**.

### 9b. Add Form Fields

Add the following fields:

| Field #  | Question Text             | Type       | Required |
| -------- | ------------------------- | ---------- | -------- |
| 1        | Client / Project Name     | Short text | Yes      |
| 2        | Website URL               | Short text | Yes      |
| 3        | GitHub Repository (owner/repo) | Short text | Yes  |
| 4        | Vercel Project ID         | Short text | Yes      |

### 9c. Link Form to Clients Tab

By default, the form creates a new tab called "Form Responses 1". You need to map this to the `Clients` tab:

1. In the Google Form editor, click **Responses**.
2. Click the **Sheets icon** to link responses.
3. Select **Existing spreadsheet** → AWPIS Control Center.
4. Form responses will appear in a new tab.

Then update the `onFormSubmit()` function in `01_trigger.gs` to copy new submissions from the form responses tab into the `Clients` tab with the correct column mapping and default values (`active = TRUE`, `registeredAt = NOW()`).

### 9d. Share the Form

Copy the form URL and share it with clients or team members who need to register new websites for monitoring.

---

## 10. First Run Checklist

Before running the pipeline for the first time, verify each item:

### Pre-flight Checks

- [ ] **Google Sheet** has all 7 tabs with correct column headers
- [ ] **Config tab** has all threshold values populated
- [ ] **Script Properties** has all 13 secrets set (no `MISSING` values)
- [ ] **RUN_MODE** is set to `dry_run` for the first test
- [ ] **Apps Script** has all 9 `.gs` files in correct order
- [ ] **Authorization** was completed (permissions granted)
- [ ] **5 Gems** are created and respond to test prompts
- [ ] **Workspace Studio** flow is saved and activated
- [ ] **Triggers** are installed (at least the daily trigger)
- [ ] **At least one client** is registered (either via form or manual entry in `Clients` tab)
- [ ] **GitHub repo** has a `main` branch with deployable code
- [ ] **Vercel** project builds successfully from the repo
- [ ] **SonarCloud** project is analyzing the repo

### First Dry Run

1. Go to the AWPIS Control Center spreadsheet.
2. Verify `RUN_MODE` is set to `dry_run` in Script Properties.
3. Click **AWPIS → Run Pipeline Now** from the custom menu.
4. Monitor the `Runs` tab for a new row with status updates.
5. Check the Apps Script execution log: **Apps Script Editor → Executions** (left sidebar).
6. Verify each layer completes:
   - `STARTED` → `COLLECTING` → `ANALYZING` → `GENERATING` → `QUALITY_CHECK` → `SUCCESS` (dry run skips deploy)

### First Production Run

After a successful dry run:

1. Change `RUN_MODE` to `production` in Script Properties.
2. Click **AWPIS → Run Pipeline Now**.
3. Monitor the `Runs` tab.
4. Check your email for the pipeline report.
5. Verify the GitHub PR was created, merged, and deployed.
6. Confirm the Vercel production deployment is live.

---

## 11. Troubleshooting

### Common Issues

#### "Authorization required" Error

**Cause:** The script hasn't been authorized yet, or permissions were revoked.

**Fix:**
1. Open the Apps Script editor.
2. Select any function and click **Run**.
3. Complete the authorization flow (Step 4d).

#### "Lock timeout" or "Another run in progress"

**Cause:** A previous pipeline run didn't release its lock, or a run is genuinely in progress.

**Fix:**
1. Check the `State` tab for a `PIPELINE_LOCK` key.
2. If the lock's timestamp is more than 10 minutes old, delete that row.
3. Alternatively, wait for the current run to complete (check `Runs` tab).

#### "PAGESPEED_KEY not found" or Similar Missing Secret

**Cause:** A Script Property was not set or was misspelled.

**Fix:**
1. Open Apps Script → Project Settings → Script Properties.
2. Verify the property name matches exactly (case-sensitive).
3. Verify the value is not empty.

#### PSI API Returns 429 (Rate Limited)

**Cause:** Too many PageSpeed Insights requests in a short period.

**Fix:**
1. The pipeline has built-in retry with exponential backoff.
2. If it persists, check your API quota in the Google Cloud Console.
3. Consider increasing the daily trigger interval.

#### Vercel Preview Deployment Timeout

**Cause:** The Vercel build is taking longer than expected.

**Fix:**
1. Check the Vercel dashboard for build errors.
2. Verify the deploy hook URL is correct in Script Properties.
3. Increase the sandbox timeout in the `Config` tab if builds are legitimately slow.

#### Gem Returns Malformed Output

**Cause:** The Gem's response didn't follow the expected JSON format.

**Fix:**
1. The pipeline retries up to 3 times automatically.
2. If it persists, review and update the Gem's system prompt to be more explicit about output format.
3. Test the Gem manually with a sample `IntelligenceBundle`.

#### SonarCloud Analysis Not Found

**Cause:** The SonarCloud project key doesn't match, or analysis hasn't been run.

**Fix:**
1. Verify `SONARQUBE_PROJECT_KEY` matches the project key shown in SonarCloud → Project → Information.
2. Ensure at least one analysis has completed on SonarCloud.
3. Check that the `SONARQUBE_TOKEN` has the correct permissions.

#### Auto-revert Triggered Unexpectedly

**Cause:** Post-deploy PSI scores showed a regression.

**Fix:**
1. Check the `Runs` tab for the specific run.
2. Review the `errorLog` column for details.
3. The revert commit will be in your GitHub repo's history.
4. Consider increasing `STABILIZATION_WAIT_SEC` in the `Config` tab to allow more time for CDN propagation.

### Logs and Debugging

| What to Check               | Where to Find It                                              |
| --------------------------- | ------------------------------------------------------------- |
| Script execution logs       | Apps Script Editor → Executions (left sidebar)                |
| Pipeline run history        | AWPIS Control Center → `Runs` tab                             |
| Detailed error messages     | `Runs` tab → `errorLog` column (JSON)                         |
| Current pipeline state      | `State` tab                                                   |
| Fix history                 | `FixMemory` tab                                               |
| Trigger history             | Apps Script Editor → Triggers → click trigger → Recent runs   |
| Vercel build logs           | Vercel Dashboard → Deployments                                |
| SonarCloud analysis         | SonarCloud → Project → Activity                               |

### Getting Help

If you encounter an issue not covered here:

1. Check the Apps Script execution log for the full error stack trace.
2. Search for the error message in the [Apps Script documentation](https://developers.google.com/apps-script).
3. Review the [architecture documentation](architecture.md) for expected data flow.
4. Open an issue in the project's GitHub repository with the error details and the relevant `Runs` tab row.

---

*Last updated: June 2026*
