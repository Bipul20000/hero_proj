# AWPIS: Autonomous Web Performance Intelligence System

AWPIS is an autonomous, AI-driven daily pipeline that monitors website performance, generates code fixes using Google Gems (Gemini), validates changes through multi-stage quality gates, and deploys improvements to production — entirely without human intervention.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AWPIS — 10-Layer Pipeline                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [ Layer 0 ] Configuration (Google Sheets)                                  │
│  [ Layer 1 ] Trigger (Daily 9 AM / Manual / Form)                           │
│  [ Layer 2 ] Parallel Intelligence Gathering (PSI, GitHub, Sonar)           │
│  [ Layer 3 ] Gem 1: Performance Strategist (Creates FixPlan)                │
│  [ Layer 4 ] Targeted Code Fetch                                            │
│  [ Layer 5 ] Gem 2/3: Frontend/Backend Engineer (Generates Fix)             │
│  [ Layer 6 ] Quality Gates (Syntax, Critic, SonarCloud, Complexity)         │
│  [ Layer 7 ] Sandbox Validation (Preview Deploy + PSI check)                │
│  [ Layer 8 ] Production Deploy (PR + Merge + Post-deploy monitor)           │
│  [ Layer 9 ] Learning + Reporting (Memory update, Email Report)             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Autonomous Operation**: Runs daily on a cron trigger, requiring zero human input unless escalation occurs.
- **AI-Driven Reasoning**: Uses a team of 5 specialized Google Gems (Strategist, Frontend Engineer, Backend Engineer, Code Critic, Reporter).
- **Comprehensive Intelligence Gathering**: Pulls data from Google PageSpeed Insights, GitHub API, SonarCloud, and historical pipeline runs.
- **Robust Quality Gates**: Generated code must pass structural checks, adversarial AI review, SonarCloud static analysis, and blast radius limits.
- **Sandbox Validation**: Proves performance improvements in a Vercel preview environment before modifying production.
- **Auto-Revert**: Post-deploy monitoring will automatically revert commits if Core Web Vitals (like CLS or LCP) regress in production.
- **Fix Memory**: Remembers failed approaches and avoids repeating past mistakes.
- **Serverless Architecture**: Runs entirely on Google Workspace (Apps Script + Sheets + Workspace Studio) with no dedicated servers.

## Tech Stack

- **Orchestrator**: Google Workspace Studio
- **Execution Engine**: Google Apps Script
- **Database**: Google Sheets (`AWPIS Control Center`)
- **AI Reasoning**: Google Gems (Gemini Models)
- **External Integrations**:
  - Google PageSpeed Insights API
  - GitHub REST API
  - Vercel Deploy Hooks and API
  - SonarCloud API

## Quick Start

To set up AWPIS for your organization, follow the comprehensive [Setup Guide](docs/setup_guide.md).

For a deep dive into how the system reasons and guarantees safety, see the [Architecture Reference](docs/architecture.md).

To view or modify the AI personas, check the [Gem Prompts](docs/gem_prompts.md).

## Safety Guarantees

AWPIS is designed with defense-in-depth to prevent AI hallucinations from breaking production:

1. **No untested code**: 4 sequential quality gates must all pass.
2. **Prove before deploy**: Sandbox preview must show measurable improvement.
3. **Automatic rollback**: 90-second post-deploy monitor auto-reverts on regression.
4. **Retry limits**: Maximum 3 retries per fix before stopping and emailing a human.
5. **No hardcoded secrets**: All credentials live in encrypted Script Properties.

## Project Structure

```text
awpis/
├── apps-script/
│   ├── pipeline/
│   │   ├── 00_config.gs      — Constants, column indices, thresholds
│   │   ├── 01_trigger.gs     — 3 triggers + core pipeline entry
│   │   ├── 02_collect.gs     — 4 parallel collectors (PSI, GitHub, History, Security)
│   │   ├── 03_github.gs      — All GitHub API operations
│   │   ├── 04_sonarqube.gs   — SonarQube Cloud API wrapper
│   │   ├── 05_sandbox.gs     — Quality gates + sandbox validation
│   │   ├── 06_deploy.gs      — Production deploy + auto-revert
│   │   ├── 07_memory.gs      — Fix memory + baseline + reporting
│   │   └── 08_state.gs       — State management + secrets
│   └── gems/
│       ├── gem1_strategist.md — Performance Strategist prompt
│       ├── gem2_frontend.md   — Frontend Engineer prompt
│       ├── gem3_backend.md    — Backend Engineer prompt
│       ├── gem4_critic.md     — Code Critic prompt
│       └── gem5_reporter.md   — Report Writer prompt
├── docs/
│   ├── architecture.md       — Full system architecture
│   ├── setup_guide.md        — Installation instructions
│   └── gem_prompts.md        — Consolidated gem prompt reference
└── README.md
```

## License

MIT License. See [LICENSE](LICENSE) for more information.

## Author

**Bipul Kumar**
