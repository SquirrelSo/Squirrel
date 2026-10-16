# ADR-031: Deployment Stance

| Field          | Value               |
|---------------|---------------------|
| **Status**     | Accepted            |
| **Date**       | 2026-09-29          |
| **Ticket**     | ADR-031             |
| **Authors**    | Run Module owner    |
| **Supersedes** | —                   |

## Context

The Run Module is deployed alongside the Exercise and Social services on a shared database. The current Render deployment is a single free-tier web service. Worker placement, migration ordering, and token verification each cross service or deployment boundaries, so their operating assumptions need to be explicit.

## Decisions

### 1. Workers run inside the API process

`render.yaml` sets `RUN_WORKERS_IN_API=1`. This is deliberate: the deployment has one free-tier Render service, so a separate worker service is not available.

On the free tier, the web service sleeps after inactivity. When it sleeps, run finalization, territory decay, leaderboard sync, and notification outbox processing stop with it and resume when the service wakes. A run that reaches `finishing` just before sleep waits in that state until wake; the recovery sweeper added in FIX-1 picks it up then.

Revisit this decision when a dedicated worker service exists. At that point, workers must run in **one place only**. Running them in both the API and a worker service would duplicate scheduled jobs; for example, duplicate territory decay could expire a territory that should have survived.

### 2. Migration ordering follows the shared database history

The Run Module, Exercise, and Social services share a database, and each service keeps its own migration ledger. Migration numbers were chosen in parallel by two people. The Run Module migrations formerly named `012_challenges` and `013_run_finishing_recovery` were therefore ordered before migrations already applied by the shared database. They were renamed to `014_challenges` and `015_run_finishing_recovery` so they sort after that applied history.

The renumbering was verified three ways:

1. A clean database applied migrations 001 through 015 in order.
2. The existing development database reported that no migrations were left to run.
3. A local simulation of the deployed database state, with migrations applied through `013_runs_timezone`, then applied 014 and 015 successfully.

Migration 004's filename sorts before migrations it depends on. `node-pg-migrate` 7.9.1 orders migrations by the timestamp in the filename, not alphabetically, so it applies 004 after the schema migration that creates `runs`. This remains a latent risk if a different migration tool or version sorts filenames alphabetically.

**Toolchain pin:** `node-pg-migrate` is pinned to exactly `7.9.1` for this reason; the pin is load-bearing, not incidental.

### 3. Production JWT verification requires RS256

`render.yaml` currently sets `JWT_ALGORITHM=HS256` with a shared secret. This contradicts ADR-003, which requires RS256 before real user data. It has not yet changed because the Exercise Module is the only service that issues tokens, and switching algorithms requires all three services to change together.

The agreed plan is for the Exercise service to sign tokens with a private key held only by that service and publish the corresponding public key. The Run and Social services will verify tokens with that public key. Production must not launch using the shared HS256 secret. See ADR-003, *JWT Verification Strategy*.

## Consequences

- Worker availability follows the API service's free-tier sleep and wake cycle until a dedicated worker service is available.
- Any future worker-service split must ensure each scheduled worker runs in one place only.
- Fresh deployments and the deployed migration state have both been checked against the renamed Run Module migrations; migration 004 still relies on timestamp-based ordering.
- Production launch remains blocked on coordinated RS256 token issuance and verification across Exercise, Run, and Social.
