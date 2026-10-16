# ADR-003: JWT Verification Strategy

| Field          | Value                                            |
|---------------|--------------------------------------------------|
| **Status**     | Accepted                                         |
| **Date**       | 2026-09-19                                       |
| **Ticket**     | RM-0c                                            |
| **Authors**    | Run Module team                                  |
| **Supersedes** | —                                                |

---

## Context

RM-3.2 attributes territory ownership to a verified user identity.  A user
identity written to the database without verification is a security defect:
a client that can forge or reuse another user's identifier can claim that
user's territory.

The Run Module does **not** own user accounts.  An external account service
(existing or future) issues tokens.  This repository only VERIFIES them.

There is no Technical Specification document that carries this decision.  It
is recorded here so the choice is auditable and can be revised without
archaeology.

---

## Decision

### 1. Verification Library
We use `jose` for JWT verification via `jwtVerify`.

### 2. Algorithms and Keys
The algorithm is configurable via `JWT_ALGORITHM`.
- **HS256** is the LOCAL DEVELOPMENT DEFAULT. It uses a symmetric secret. 
- **RS256** is REQUIRED before any real user data. With a symmetric secret, anything holding it can forge tokens for any user, whereas RS256 gives this repo a public key that verifies but cannot sign.
- `JWT_ALGORITHM` is configurable specifically so that migration is a configuration change, not a code change.
- The algorithms allowlist is a single-element array (the configured algorithm). This makes `alg: "none"` and algorithm confusion attacks unrepresentable.

### 3. Clock Skew
A clock tolerance of 30 seconds is applied to `exp` (expiration) and `nbf` (not before) claims to handle minor time synchronization differences.

### 4. Explicit Trust Boundary
**Rule:** No route handler may read a `user_id` from a request body, query parameter, or custom header. 
Every protected route must read the actor's identity exclusively from `request.userId`. 
This guarantees that a malicious client cannot spoof another user's identity by manipulating a JSON payload (e.g., trying to claim territory for someone else).

### 5. Uniform Rejection
All rejections return an identical `401 Unauthorized` body (`{"error":"unauthorized"}`). The specific failure reason (missing claim, bad signature, expired) is logged server-side only to prevent information leakage.

## Consequences

-   The Run Module is decoupled from the identity service. It only needs the shared secret or public key.
-   Test fixtures must generate and sign their own JWTs using the local test secret.
-   Foreign keys in our database that reference `user_id` (like `runs.user_id`) technically dangle; there is no `users` table to enforce referential integrity. This is accepted in our modular architecture.

---

*Corrected 2026-09-19: Explicitly stated jose usage, local dev vs prod keys, the single-element allowlist, the 30s clock tolerance, and uniform 401 rejections.*
