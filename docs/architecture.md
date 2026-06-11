# AWPIS Architecture

> Autonomous Web Performance Intelligence System — Technical Architecture Reference

---

## System Overview

AWPIS is a fully autonomous daily pipeline that monitors website performance, reasons about fixes using AI, validates changes through multiple safety gates, and deploys improvements to production — all without human intervention.

The system runs entirely on Google Workspace infrastructure (Gems + Workspace Studio + Apps Script) with external integrations to PageSpeed Insights, GitHub, Vercel, and SonarCloud.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AWPIS — 10-Layer Pipeline                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐                                                            │
│  │  Layer 0    │  Configuration                                             │
│  │  Sheets DB  │  Google Sheets: Config, Secrets, Clients tabs              │
│  └──────┬──────┘                                                            │
│         │                                                                   │
│  ┌──────▼──────┐                                                            │
│  │  Layer 1    │  Trigger                                                   │
│  │  01_trigger │  Daily 9 AM  ·  Form Submit  ·  Manual Button              │
│  └──────┬──────┘                                                            │
│         │                                                                   │
│  ┌──────▼──────────────────────────────────────────────────┐                │
│  │  Layer 2 — Parallel Intelligence Gathering              │                │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │                │
│  │  │   PSI    │ │  GitHub  │ │ History  │ │  Security  │ │                │
│  │  │ Metrics  │ │  State   │ │  Trends  │ │   Audit    │ │                │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘ │                │
│  │       └─────────────┴────────────┴─────────────┘        │                │
│  │                         │                               │                │
│  │              IntelligenceBundle                          │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 3 — Gem 1: Performance Strategist                │                │
│  │  Analyzes bundle → produces ranked FixPlan              │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 4 — Targeted Code Fetch                          │                │
│  │  GitHub API: fetch only files referenced in FixPlan     │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 5 — Fix Generation                               │                │
│  │  Gem 2 (Frontend) or Gem 3 (Backend) writes the patch   │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 6 — Quality Gates (4 sequential gates)           │                │
│  │  Gate 1: Syntax  →  Gate 2: Gem 4 Critic  →             │                │
│  │  Gate 3: SonarCloud  →  Gate 4: Complexity              │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 7 — Sandbox Validation                           │                │
│  │  Preview deploy on Vercel → PSI comparison              │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 8 — Production Deploy                            │                │
│  │  PR → Merge → Post-deploy verification (90s monitor)    │                │
│  └─────────────────────────┬───────────────────────────────┘                │
│                            │                                                │
│  ┌─────────────────────────▼───────────────────────────────┐                │
│  │  Layer 9 — Learning + Reporting                         │                │
│  │  Fix memory · Baseline update · Gem 5 email report      │                │
│  └─────────────────────────────────────────────────────────┘                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Layer-by-Layer Reference

### Layer 0 — Configuration

| Attribute  | Detail                                                     |
| ---------- | ---------------------------------------------------------- |
| **Source** | `00_config.gs` + Google Sheets (`Config`, `Secrets` tabs)  |
| **Input**  | Raw sheet data, Script Properties                          |
| **Output** | Resolved configuration object with thresholds and targets  |

Layer 0 establishes all runtime constants before the pipeline begins. Configuration is split between two sources:

1. **Google Sheets (`Config` tab)** — Human-editable settings: performance thresholds, target URLs, scoring weights, retry limits, and feature flags.
2. **Script Properties** — Sensitive credentials that never appear in code or sheets (see [Environment Variables](#environment-variables)).

The `00_config.gs` file defines column indices for every sheet tab, numeric thresholds for quality gates, and convenience accessors that merge both sources into a single configuration namespace.

**Decision Points:**
- If `RUN_MODE` is set to `dry_run`, the pipeline will execute all reasoning layers but skip production deployment.
- If a required secret is missing, the pipeline halts immediately with a descriptive error logged to the `Runs` tab.

---

### Layer 1 — Trigger

| Attribute  | Detail                                                          |
| ---------- | --------------------------------------------------------------- |
| **Source** | `01_trigger.gs`                                                 |
| **Input**  | Trigger event (time-based / form / manual)                      |
| **Output** | New row in `Runs` tab with status `STARTED`, pipeline kickoff   |

Three trigger mechanisms invoke the core pipeline entry point `runPipeline()`:

| Trigger        | When                                 | How Installed                          |
| -------------- | ------------------------------------ | -------------------------------------- |
| Daily cron     | Every day at 9:00 AM (project TZ)    | `ScriptApp.newTrigger().timeBased()`   |
| Form submit    | Client registers via Google Form     | `ScriptApp.newTrigger().forForm()`     |
| Manual button  | Operator clicks "Run Now" in Sheet   | Custom menu / sidebar button           |

On trigger, Layer 1:
1. Reads the client list from the `Clients` tab.
2. Acquires a pipeline lock via `LockService` to prevent concurrent runs.
3. Creates a new run record in `Runs` with a unique `runId` and timestamp.
4. Passes control to Layer 2.

**Decision Points:**
- If another run is already in progress (lock held), the trigger is silently skipped and logged.
- If no clients are registered, the pipeline logs a warning and exits cleanly.

---

### Layer 2 — Parallel Intelligence Gathering

| Attribute  | Detail                                                               |
| ---------- | -------------------------------------------------------------------- |
| **Source** | `02_collect.gs`                                                      |
| **Input**  | Client URL, GitHub repo reference, prior run history                 |
| **Output** | `IntelligenceBundle` object                                          |

Four collectors execute in parallel (via `UrlFetchApp.fetchAll()` where possible):

| Collector     | API / Source                     | Data Gathered                                                      |
| ------------- | -------------------------------- | ------------------------------------------------------------------ |
| **PSI**       | PageSpeed Insights API v5        | Lighthouse scores, Core Web Vitals (LCP, FID, CLS, TTFB, INP), opportunities, diagnostics |
| **GitHub**    | GitHub REST API                  | Recent commits, open PRs, last deploy SHA, branch protection status |
| **History**   | Google Sheets (`Runs` tab)       | Last N runs' scores, fix success rate, regression trends            |
| **Security**  | SonarCloud + custom checks       | Vulnerability count, code smells, dependency audit flags            |

All four results are merged into a single `IntelligenceBundle`:

```
IntelligenceBundle {
  psi: {
    performanceScore: number,       // 0–100
    accessibilityScore: number,     // 0–100
    bestPracticesScore: number,     // 0–100
    seoScore: number,               // 0–100
    webVitals: {
      lcp: number,                  // milliseconds
      fid: number,                  // milliseconds
      cls: number,                  // unitless
      ttfb: number,                 // milliseconds
      inp: number                   // milliseconds
    },
    opportunities: Opportunity[],   // ranked by estimated savings
    diagnostics: Diagnostic[]
  },
  github: {
    lastDeploySha: string,
    recentCommits: Commit[],
    openPRs: PR[],
    branchProtection: boolean
  },
  history: {
    lastNScores: number[],
    avgScoreDelta: number,
    fixSuccessRate: number,
    regressionsDetected: boolean
  },
  security: {
    vulnerabilities: number,
    codeSmells: number,
    coveragePercent: number,
    dependencyFlags: string[]
  },
  collectedAt: string              // ISO 8601 timestamp
}
```

**Decision Points:**
- If PSI API returns an error or timeout, the pipeline retries up to 3 times with exponential backoff.
- If all collectors fail, the run is marked `COLLECTION_FAILED` and the pipeline halts.

---

### Layer 3 — Gem 1: Performance Strategist

| Attribute  | Detail                                                       |
| ---------- | ------------------------------------------------------------ |
| **Source** | Workspace Studio → `gem1_strategist.md`                      |
| **Input**  | `IntelligenceBundle` (JSON)                                  |
| **Output** | `FixPlan` (JSON)                                             |

Gem 1 receives the full `IntelligenceBundle` and reasons about the highest-impact fix to apply. It produces a structured `FixPlan`:

```
FixPlan {
  fixId: string,                    // unique identifier for this fix
  category: "frontend" | "backend", // determines which Gem handles generation
  title: string,                    // human-readable fix title
  description: string,              // what the fix does and why
  targetFiles: string[],            // repo paths to fetch and modify
  expectedImpact: {
    metric: string,                 // e.g. "LCP", "CLS", "performanceScore"
    currentValue: number,
    projectedValue: number,
    confidence: "high" | "medium" | "low"
  },
  reasoning: string,                // chain-of-thought explanation
  priority: number,                 // 1 = highest
  risks: string[],                  // potential side effects
  rollbackPlan: string              // how to undo if it fails
}
```

**Decision Points:**
- If the `IntelligenceBundle` shows all scores above threshold and no regressions, Gem 1 may return a `NO_FIX_NEEDED` status, and the pipeline ends with a healthy status report.
- If prior fixes for the same issue have failed (checked via `FixMemory` tab), Gem 1 avoids repeating them.

---

### Layer 4 — Targeted Code Fetch

| Attribute  | Detail                                                     |
| ---------- | ---------------------------------------------------------- |
| **Source** | `03_github.gs`                                             |
| **Input**  | `FixPlan.targetFiles[]`                                    |
| **Output** | Map of file paths to their current source content          |

Using the GitHub Contents API, Layer 4 fetches only the files specified in the `FixPlan`. This minimizes API calls and token usage. Each file's content is base64-decoded and stored alongside its SHA (needed for the commit/update API later).

```
TargetCodeMap {
  [filePath: string]: {
    content: string,        // decoded file content
    sha: string,            // current blob SHA
    size: number            // bytes
  }
}
```

**Decision Points:**
- If a target file does not exist in the repo, it is flagged as a new file creation (the fix may add new files).
- If total fetched content exceeds 100 KB, a warning is logged (Gem context windows have practical limits).

---

### Layer 5 — Fix Generation

| Attribute  | Detail                                                               |
| ---------- | -------------------------------------------------------------------- |
| **Source** | Workspace Studio → `gem2_frontend.md` or `gem3_backend.md`          |
| **Input**  | `FixPlan` + `TargetCodeMap`                                         |
| **Output** | `GeneratedFix` (modified file contents)                              |

Based on `FixPlan.category`:
- **`frontend`** → Gem 2 (Frontend Engineer) generates the fix.
- **`backend`** → Gem 3 (Backend Engineer) generates the fix.

The selected Gem receives the fix plan, the current file contents, and any relevant context from the `IntelligenceBundle`. It returns the complete modified file contents (not a diff):

```
GeneratedFix {
  fixId: string,
  files: {
    [filePath: string]: {
      originalContent: string,
      modifiedContent: string,
      changeDescription: string
    }
  },
  testSuggestions: string[],
  breakingRiskAssessment: string
}
```

**Decision Points:**
- If the Gem returns malformed output (not valid JSON, missing required fields), the pipeline retries with a clarification prompt (up to 3 attempts).
- If the Gem refuses to generate a fix (e.g., the change is too risky), the pipeline records this in `FixMemory` and halts gracefully.

---

### Layer 6 — Quality Gates

| Attribute  | Detail                                                    |
| ---------- | --------------------------------------------------------- |
| **Source** | `04_sonarqube.gs`, `05_sandbox.gs`                        |
| **Input**  | `GeneratedFix`                                            |
| **Output** | `QualityResult` (pass/fail per gate + aggregate)          |

Four gates execute sequentially. **All four must pass** for the fix to proceed:

| Gate | Name          | What It Checks                                                           | Fail Action              |
| ---- | ------------- | ------------------------------------------------------------------------ | ------------------------ |
| 1    | **Syntax**    | Validates modified files parse correctly (no unclosed tags, brackets)     | Reject fix, retry Gem    |
| 2    | **Critic**    | Gem 4 (Code Critic) reviews the diff for anti-patterns, regressions      | Reject fix, log feedback |
| 3    | **SonarCloud**| Submits to SonarCloud API; checks for new bugs, vulnerabilities, smells   | Reject fix, log issues   |
| 4    | **Complexity**| Measures cyclomatic complexity delta; rejects if complexity increases     | Reject fix, log delta    |

```
QualityResult {
  passed: boolean,
  gates: {
    syntax:     { passed: boolean, errors: string[] },
    critic:     { passed: boolean, feedback: string, score: number },
    sonarcloud: { passed: boolean, bugs: number, vulns: number, smells: number },
    complexity: { passed: boolean, delta: number, threshold: number }
  },
  failedAt: string | null,    // name of first failed gate, or null
  retryable: boolean           // whether a retry with Gem feedback might help
}
```

**Decision Points:**
- If Gate 2 (Critic) fails but provides actionable feedback, the pipeline can loop back to Layer 5 with the feedback appended to the Gem prompt (up to 3 retries).
- If any gate fails after max retries, the run is marked `QUALITY_GATE_FAILED` and the issue is escalated via email.

---

### Layer 7 — Sandbox Validation

| Attribute  | Detail                                                              |
| ---------- | ------------------------------------------------------------------- |
| **Source** | `05_sandbox.gs`, `03_github.gs`                                     |
| **Input**  | `GeneratedFix` (quality-gate-approved)                              |
| **Output** | `SandboxResult` (preview URL + before/after PSI comparison)         |

Layer 7 deploys the fix to a Vercel preview environment and runs a real PageSpeed Insights test against it:

1. Push the fix to a new branch (`awpis/fix-{fixId}`) via GitHub API.
2. Trigger a Vercel preview deployment via the deploy hook.
3. Wait for the preview URL to become available (polling with timeout).
4. Run PSI against the preview URL.
5. Compare preview PSI scores against the current production scores.

```
SandboxResult {
  previewUrl: string,
  previewBranch: string,
  beforeScores: PSIScores,
  afterScores: PSIScores,
  improvement: {
    performanceDelta: number,
    targetMetricDelta: number
  },
  passed: boolean              // true if scores improved or held steady
}
```

**Decision Points:**
- If the preview deployment fails or times out, the branch is deleted and the run is marked `SANDBOX_DEPLOY_FAILED`.
- If PSI scores **regress** in the sandbox, the fix is rejected and the branch is deleted. The regression is recorded in `FixMemory` to prevent future repetition.
- The fix must show measurable improvement (or at minimum no regression) to proceed.

---

### Layer 8 — Production Deploy

| Attribute  | Detail                                                           |
| ---------- | ---------------------------------------------------------------- |
| **Source** | `06_deploy.gs`, `03_github.gs`                                   |
| **Input**  | `SandboxResult` (passed)                                         |
| **Output** | `DeployResult` (PR URL, merge SHA, post-deploy verification)     |

Production deployment follows a conservative sequence:

1. **Create Pull Request** — From the preview branch to `main`, with a detailed description including before/after scores, fix reasoning, and rollback instructions.
2. **Auto-merge** — If branch protection allows, the PR is merged via the API. If reviews are required, the pipeline waits and escalates.
3. **Trigger Production Build** — Vercel automatically builds on merge to `main`.
4. **Post-deploy Verification** — After a 90-second stabilization window, PSI is run against the production URL.
5. **Auto-revert on Regression** — If production scores drop below the pre-fix baseline, the merge commit is automatically reverted via a new commit pushed to `main`.

```
DeployResult {
  prUrl: string,
  prNumber: number,
  mergeSha: string,
  deployedAt: string,             // ISO 8601
  postDeployScores: PSIScores,
  verified: boolean,              // post-deploy check passed
  reverted: boolean,              // true if auto-revert triggered
  revertSha: string | null
}
```

**Decision Points:**
- If the merge fails (conflict, protection rules), the pipeline marks the run `MERGE_BLOCKED` and sends an escalation email.
- If post-deploy scores regress, auto-revert executes immediately and the run is marked `REVERTED`.
- The 90-second stabilization window accounts for CDN cache propagation and Vercel's edge network.

---

### Layer 9 — Learning + Reporting

| Attribute  | Detail                                                            |
| ---------- | ----------------------------------------------------------------- |
| **Source** | `07_memory.gs`, Workspace Studio → `gem5_reporter.md`             |
| **Input**  | Full pipeline result (all layers)                                 |
| **Output** | Updated sheets, email report                                      |

Three sub-steps execute in Layer 9:

#### 9a — Fix Memory Update

The `FixMemory` tab is updated with the outcome of this fix:

| Column             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `fixId`            | Unique fix identifier                               |
| `category`         | frontend / backend                                  |
| `title`            | Human-readable fix title                            |
| `status`           | `SUCCESS` / `FAILED` / `REVERTED`                   |
| `scoreBefore`      | Performance score before fix                        |
| `scoreAfter`       | Performance score after fix                         |
| `appliedAt`        | Timestamp                                           |
| `gemFeedback`      | Critic feedback if applicable                       |
| `failureReason`    | Why the fix failed, if applicable                   |

This memory is consulted by Gem 1 in future runs to avoid repeating failed strategies.

#### 9b — Baseline Update

If the fix was successful, the `Baseline` tab is updated with the new performance scores. This becomes the comparison point for future runs.

#### 9c — Email Report (Gem 5)

Gem 5 (Report Writer) receives the full `PipelineResult` and generates a human-readable email report:

- Executive summary (one paragraph)
- Scores before and after (table)
- What was fixed and why
- Quality gate results
- Sandbox validation results
- Next recommended actions

The report is sent via `GmailApp.sendEmail()` to the address in `REPORT_EMAIL`.

---

## Key Data Structures

### PipelineResult

The master object that accumulates state across all layers:

```
PipelineResult {
  runId: string,
  clientUrl: string,
  startedAt: string,
  completedAt: string,
  status: "SUCCESS" | "NO_FIX_NEEDED" | "QUALITY_GATE_FAILED"
          | "SANDBOX_FAILED" | "DEPLOY_FAILED" | "REVERTED"
          | "COLLECTION_FAILED" | "ERROR",
  
  intelligence: IntelligenceBundle,
  fixPlan: FixPlan | null,
  generatedFix: GeneratedFix | null,
  qualityResult: QualityResult | null,
  sandboxResult: SandboxResult | null,
  deployResult: DeployResult | null,
  
  retries: number,
  errorLog: string[],
  duration: number                    // total pipeline duration in ms
}
```

---

## Safety Guarantees

AWPIS implements defense-in-depth with multiple independent safety mechanisms:

| # | Guarantee                   | Mechanism                                                        |
| - | --------------------------- | ---------------------------------------------------------------- |
| 1 | **No untested code**        | 4 quality gates must all pass before any deployment              |
| 2 | **Prove before deploy**     | Sandbox preview must show improvement before production merge    |
| 3 | **Automatic rollback**      | 90-second post-deploy monitor auto-reverts on regression         |
| 4 | **Retry limits**            | Max 3 retries per fix before human escalation                    |
| 5 | **No hardcoded secrets**    | All credentials stored in Script Properties, never in code       |
| 6 | **Concurrency protection**  | `LockService` prevents parallel pipeline runs                   |
| 7 | **Fix memory**              | Failed fixes are remembered and never repeated                   |
| 8 | **Human escalation**        | Unresolvable failures trigger email alerts to operators          |

### Rollback Flow

```
Production Deploy
       │
       ▼
  Wait 90 seconds
       │
       ▼
  Run PSI on production
       │
       ├── Scores OK ──────► Mark SUCCESS, update baseline
       │
       └── Scores REGRESSED ──► Auto-revert commit
                                       │
                                       ▼
                                 Verify revert
                                       │
                                       ▼
                                 Mark REVERTED
                                       │
                                       ▼
                                 Email alert
```

---

## External API Integrations

| API                  | Purpose                                            | Auth Method             | Rate Limits             |
| -------------------- | -------------------------------------------------- | ----------------------- | ----------------------- |
| PageSpeed Insights   | Lighthouse audits, Core Web Vitals                 | API Key (`PAGESPEED_KEY`) | 25,000 queries/day      |
| GitHub REST API      | Code read/write, PR management, branch ops         | PAT (`GITHUB_TOKEN`)    | 5,000 requests/hour     |
| Vercel API           | Deploy hooks, deployment status, preview URLs      | Token (`VERCEL_TOKEN`)  | Varies by plan          |
| SonarCloud API       | Static analysis, quality gate status               | Token (`SONARQUBE_TOKEN`) | Varies by plan         |
| Gmail (Apps Script)  | Email report delivery                              | OAuth (automatic)       | 100 emails/day          |

---

## Google Sheets as Database

The Google Sheet "AWPIS Control Center" serves as the system's persistent state store, with seven tabs:

### Tab Schema

#### 1. Config

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `key`              | string   | Configuration key name                     |
| `value`            | string   | Configuration value                        |
| `description`      | string   | Human-readable explanation                 |
| `lastModified`     | datetime | When this value was last changed           |

Stores editable runtime settings: performance thresholds, scoring weights, retry limits, feature flags, and target URLs.

#### 2. Secrets

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `key`              | string   | Secret name (mirrors Script Property name) |
| `status`           | string   | `SET` or `MISSING`                         |
| `lastRotated`      | datetime | When the secret was last updated           |
| `notes`            | string   | Usage notes                                |

This tab does **not** store actual secret values. It serves as an inventory to track which secrets are configured and when they were last rotated. Actual values live in Script Properties.

#### 3. Runs

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `runId`            | string   | Unique run identifier (UUID)               |
| `clientUrl`        | string   | URL that was analyzed                      |
| `startedAt`        | datetime | Pipeline start time                        |
| `completedAt`      | datetime | Pipeline end time                          |
| `status`           | string   | Final status (see PipelineResult.status)   |
| `scoreBefore`      | number   | Performance score before fix               |
| `scoreAfter`       | number   | Performance score after fix                |
| `fixTitle`         | string   | Title of the applied fix                   |
| `duration`         | number   | Total duration in seconds                  |
| `errorLog`         | string   | JSON-encoded error messages (if any)       |

#### 4. FixMemory

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `fixId`            | string   | Unique fix identifier                      |
| `category`         | string   | `frontend` or `backend`                    |
| `title`            | string   | Human-readable fix title                   |
| `status`           | string   | `SUCCESS` / `FAILED` / `REVERTED`          |
| `scoreBefore`      | number   | Performance score before                   |
| `scoreAfter`       | number   | Performance score after                    |
| `appliedAt`        | datetime | When the fix was applied                   |
| `gemFeedback`      | string   | Critic feedback                            |
| `failureReason`    | string   | Reason for failure (if applicable)         |

Gem 1 reads this tab to avoid repeating fixes that previously failed.

#### 5. Baseline

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `clientUrl`        | string   | Website URL                                |
| `performanceScore` | number   | Current baseline performance score         |
| `accessibilityScore` | number | Current baseline accessibility score      |
| `bestPracticesScore` | number | Current baseline best practices score     |
| `seoScore`         | number   | Current baseline SEO score                 |
| `lcp`              | number   | Baseline LCP (ms)                          |
| `fid`              | number   | Baseline FID (ms)                          |
| `cls`              | number   | Baseline CLS                               |
| `ttfb`             | number   | Baseline TTFB (ms)                         |
| `inp`              | number   | Baseline INP (ms)                          |
| `updatedAt`        | datetime | When baseline was last updated             |

Updated after every successful deployment. Used for regression detection.

#### 6. State

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `key`              | string   | State variable name                        |
| `value`            | string   | Current value (JSON-encoded if complex)    |
| `updatedAt`        | datetime | Last update timestamp                      |

General-purpose key-value store for pipeline state: current run ID, lock status, last successful SHA, pipeline phase, etc.

#### 7. Clients

| Column             | Type     | Description                                |
| ------------------ | -------- | ------------------------------------------ |
| `clientName`       | string   | Client/project name                        |
| `websiteUrl`       | string   | URL to monitor                             |
| `githubRepo`       | string   | `owner/repo` format                        |
| `vercelProjectId`  | string   | Vercel project identifier                  |
| `registeredAt`     | datetime | When the client was added                  |
| `active`           | boolean  | Whether monitoring is enabled              |
| `lastRunId`        | string   | Most recent run ID for this client         |

Populated via Google Form submissions or manual entry.

---

## Workspace Studio ↔ Apps Script Bridge

AWPIS uses two runtime environments that communicate through Google Sheets:

```
┌─────────────────────────────┐      ┌─────────────────────────────┐
│     Workspace Studio        │      │       Apps Script            │
│                             │      │                             │
│  Orchestration flow:        │      │  Execution engine:          │
│  - Gem invocations          │◄────►│  - API calls (PSI, GitHub)  │
│  - Step sequencing          │      │  - Sheet read/write         │
│  - Conditional branching    │      │  - Email sending            │
│  - Gem prompt assembly      │      │  - Deploy operations        │
│                             │      │  - Quality gate logic       │
└─────────────────────────────┘      └─────────────────────────────┘
         │                                      │
         └──────────── Google Sheets ───────────┘
                   (shared state layer)
```

**Bridge Mechanism:**

1. **Apps Script → Workspace Studio:** Apps Script writes intelligence data and intermediate results to the `State` tab. Workspace Studio reads these as inputs for Gem steps.
2. **Workspace Studio → Apps Script:** Gem outputs (FixPlan, GeneratedFix, CriticReview, Report) are written to the `State` tab. Apps Script reads them to continue execution.
3. **Trigger Handoff:** Apps Script triggers can invoke Workspace Studio flows via HTTP endpoints, and Workspace Studio can call Apps Script functions as custom connectors.

This architecture allows the compute-heavy API work to run in Apps Script (with its generous execution time limits) while the AI reasoning runs through Workspace Studio's native Gem integration.

---

## Environment Variables

All stored as Apps Script **Script Properties** (Project Settings → Script Properties):

| Variable               | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `GITHUB_TOKEN`         | GitHub Personal Access Token (repo scope)         |
| `GITHUB_OWNER`         | GitHub repository owner/organization              |
| `GITHUB_REPO`          | GitHub repository name                            |
| `PAGESPEED_KEY`        | Google PageSpeed Insights API key                 |
| `VERCEL_DEPLOY_HOOK`   | Vercel deploy hook URL for preview builds         |
| `VERCEL_TOKEN`         | Vercel API bearer token                           |
| `VERCEL_PROJECT_ID`    | Vercel project identifier                         |
| `SONARQUBE_TOKEN`      | SonarCloud API token                              |
| `SONARQUBE_PROJECT_KEY`| SonarCloud project key                            |
| `REPORT_EMAIL`         | Email address for pipeline reports                |
| `RUN_MODE`             | `production` or `dry_run`                         |
| `WEBSITE_URL`          | Primary website URL to monitor                    |
| `BACKEND_URL`          | Backend API URL (if applicable)                   |

---

## Error Handling Strategy

Every layer follows a consistent error handling pattern:

1. **Try** the operation.
2. **Retry** up to 3 times with exponential backoff (for transient failures).
3. **Log** the error to the `Runs` tab `errorLog` column.
4. **Update** the run status to the appropriate failure state.
5. **Escalate** via email if retries are exhausted.
6. **Clean up** any partial state (delete branches, close PRs).

```
function withRetry(operation, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      Utilities.sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

---

## Performance Characteristics

| Metric                  | Typical Value            |
| ----------------------- | ------------------------ |
| Full pipeline duration  | 4–8 minutes              |
| PSI API call            | 15–30 seconds            |
| Gem reasoning (each)    | 10–30 seconds            |
| Vercel preview deploy   | 30–90 seconds            |
| Post-deploy wait        | 90 seconds (fixed)       |
| Apps Script max runtime | 6 minutes (extendable)   |

---

*Last updated: June 2026*
