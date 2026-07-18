# Release gate — complete backlog

The release report covers all mandatory phase tasks and FR evidence, NFR budgets, security/privacy, migration recovery, dashboards/runbooks, costs/limits, goldens, user prerequisites, rollout controls, UI/API/MCP parity, public catalogs, production-like demonstrations and documentation consistency.

No critical security/privacy finding may remain open. Database-dependent integration runs in CI with PostgreSQL 16; local absence of Docker is an environment limitation, not permission to skip the CI gate. Final status is granted only by the executable fourteen-check gate and the full regression/build pipeline.
