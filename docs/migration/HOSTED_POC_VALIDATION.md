# Hosted Supabase PoC Validation

## Status and boundary

This is a test plan for a later, isolated Hosted PoC. The foundation migration has not been applied and these tests have not been run. Firebase remains authoritative. The PoC Session model is not the Firebase current-game Session lifecycle, and creator Admin membership is not the proposed installation-wide first-Admin bootstrap. Use only disposable Auth identities and fictional data in the project named `Transit Tag Game PoC`; never use production/staging projects, real participants, or real locations.

The SQL file [`supabase/tests/poc_foundation_test.sql`](../../supabase/tests/poc_foundation_test.sql) contains rollback-only catalog assertions and a runtime validation specification. It does not assume pgTAP, create Auth identities, or apply the migration. Behavioral checks must use authenticated client requests with each persona's own session; do not substitute service-role requests for RLS tests.

## Validation goals

- The reviewed schema is applied once, and a clean PoC can be recreated from repository migrations.
- Auth identity is derived from `auth.uid()` rather than caller-supplied user IDs.
- Session reads are isolated by membership; cross-Session reads fail closed.
- RLS is enabled and forced for every PoC table, with no client mutation policies.
- Admin cannot be self-assigned through any client input or direct table mutation.
- The internal `poc_private` schema is not exposed through the Hosted client API.
- Session creation and creator membership commit atomically.
- Duplicate create requests replay the same result; rejoining does not duplicate or elevate membership.
- Direct client INSERT/UPDATE/DELETE and schema-version access are denied.
- Realtime does not disclose unauthorized rows in either initial state or later events.
- Cleanup and a reviewed rollback path are demonstrated.

## Test personas

Create temporary identities through the approved Hosted Auth flow at validation time. The SQL and repository must not contain their IDs, emails, JWTs, or credentials.

- **User A:** creates Session A and receives its creator/Admin membership.
- **User B:** joins Session A using its join code and is a participant.
- **User C:** creates Session C independently and is its creator/Admin.
- **Unauthenticated caller:** has no valid Auth identity.

All identifiers and display names are ephemeral fictional test data. The migration permits one Auth identity to be a member of multiple Sessions; whether that matches the eventual game remains an open product decision.

## Test matrix

| ID | Actor | Action | Expected result | Security boundary | Evidence to retain | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | User A | Call `poc_create_session` with a fresh request ID, session name, and display name | One Session and one Admin membership are created atomically; a 32-character random code is returned | Identity comes from `auth.uid()`; creator role is trusted | Pass/fail, migration version, sanitized row counts | Delete fictional Session and identity after all checks |
| P2 | User A | Repeat the same create request and payload | Same Session/code, `duplicate=true`; no extra rows | Request ID is scoped to creator; payload mismatch is rejected | Pass/fail only; never retain the join code | Same as P1 |
| N1 | User A | Reuse the create request ID with a changed payload | Rejected with no additional write | Idempotency payload binding | Redacted error category | Same as P1 |
| P3 | User B | Call `poc_join_session` with Session A's valid code | Membership is created as `participant` | Caller identity is derived from `auth.uid()`; role is fixed server-side | Pass/fail and sanitized counts | Same as P1 |
| P4 | User B | Join Session A again | Safe no-op; one membership and unchanged role | Duplicate join cannot elevate authority | Pass/fail and sanitized counts | Same as P1 |
| P5 | Users A and B | Select Session A and its membership roster | Both see only allowed Session A fields and roster | Same-Session RLS; join code and creator ID are not selectable | Sanitized result counts and pass/fail | Same as P1 |
| P6 | User C | Create Session C and read its roster | User C sees Session C only | Membership-scoped SELECT | Sanitized result counts | Same as P1 |
| N2 | User A | Read Session C and its roster by known test UUID | No rows or a non-enumerating authorization denial | Cross-Session confidentiality | Pass/fail; do not retain IDs | Same as P1 |
| N3 | Unauthenticated caller | Call either trusted RPC | Rejected | Authentication required | Redacted error category | No data created |
| N4 | Unauthenticated caller | Read or mutate any PoC table | Denied | No `anon` grants and deny-by-default RLS | Pass/fail | No data created |
| N5 | User B | Directly insert a Session or membership, set `created_by`/`user_id`, or request `membership_role='admin'` | Denied; RPC exposes no caller-controlled identity or role | No direct mutation grants; trusted creation path only | Pass/fail and redacted error category | Verify no extra rows |
| N6 | User A | Directly update role, `created_by`, Session status, or trusted fields; direct delete | Denied | No direct UPDATE/DELETE grants or policies | Pass/fail | Verify original rows unchanged |
| N7 | User A | Join with malformed or unknown code | Rejected with a non-enumerating result | High-entropy code validation and Session lookup boundary | Redacted error category only | No data created |
| N8 | Disposable operator fixture | Mark a fictional Session inactive through the trusted test setup, then join as a new persona | Join rejected and no membership created | Inactive Session rejection | Pass/fail; sanitized counts | Restore fixture or remove it |
| N9 | `anon` and `authenticated` | Read or mutate `poc_schema_versions` | Denied | Schema marker is migration-owned | Pass/fail | No data created |
| N9a | PoC operator | Inspect exposed API schemas | `poc_private` is absent | Internal helper functions are not client RPC endpoints | Pass/fail only | No data created |
| N10 | User A subscriber, User C writer | Subscribe to membership changes, then create a Session C membership | User A receives neither User C's initial roster nor subsequent row event | Realtime must preserve current RLS and Session scope | Pass/fail, sanitized event count; no payload/user IDs | Unsubscribe and remove fixtures |
| R1 | PoC operator | Run catalog assertions and inspect migration history | Version 1 marker and expected grants/policies/functions exist; clean replay is reproducible | Repository migration is source of truth | Migration version and pass/fail | Roll back the read-only assertion transaction |
| R2 | PoC operator | Execute reviewed cleanup/rollback | All PoC Auth and database fixtures are removed; no unexplained data remains | Destructive work is limited to the verified PoC target | Pass/fail and sanitized counts | No remaining test fixtures |

For N8, use only a disposable test Session and an approved trusted test setup. Never grant a browser or participant a direct status-update path merely to make the test possible.

## Execution and cleanup rules

1. Confirm the Hosted target by displayed project name before each test or destructive step.
2. Apply the migration only through a separately approved, version-pinned process after PR review/merge.
3. Create test identities through the approved Auth flow; use each identity's normal authenticated client context for RLS and Realtime tests.
4. Use no service-role client to claim that a client-side access-control test passed.
5. Verify `poc_private` is absent from the Hosted API's exposed schema list. Run the rollback-only catalog assertions in `poc_foundation_test.sql`; that script ends in `ROLLBACK` and does not create persistent fixtures.
6. Run behavioral tests using disposable fixtures and explicitly remove Auth identities and PoC rows. If cleanup cannot be proven, mark No-Go and stop further destructive work.
7. Realtime publication configuration is not part of the migration. Enable only `public.poc_session_memberships` during a separate reviewed step and test both initial snapshots and subsequent events across Sessions.
8. Do not retain join codes, tokens, raw SQL results containing user identifiers, or any secret in logs or evidence.

## Evidence rules

May be retained:

- migration/schema version;
- pass/fail status;
- redacted error category/code;
- sanitized query/event row counts; and
- whether cleanup completed.

Must not be retained or shared:

- access/refresh token, complete JWT, cookie, API key, or service-role key;
- password, connection string, or project URL/reference identifier;
- raw join code;
- real user data, emails, or Auth IDs; or
- private or real location data.

## Go / No-Go

**GO for a subsequent bounded PoC step only if all applicable checks pass:**

- cross-Session reads and Realtime events are denied;
- direct trusted-state mutation and Admin self-assignment are denied;
- create/join RPCs are atomic and identity-bound;
- repeated create and join requests are safe;
- the migration can be recreated from the repository;
- cleanup succeeds and the rollback plan is demonstrated; and
- no browser use of service-role or other server-only credential is required.

**NO-GO if any of the following occurs:**

- an unauthorized Session or membership row/event is visible;
- a client can write a trusted role, Session, or membership field;
- service-role access is needed in a browser;
- a migration requires undocumented Dashboard-only schema edits;
- unknown or irreversible data remains after cleanup;
- Realtime bypasses the tested Session boundary; or
- rollback/cleanup cannot be demonstrated safely.

A GO result for this minimal Session foundation is not approval to migrate Firebase data, connect the application, deploy to Vercel, or adopt Supabase as the authoritative backend.
