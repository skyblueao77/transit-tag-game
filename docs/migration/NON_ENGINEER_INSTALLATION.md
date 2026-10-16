# Non-Engineer Installation Experience

## 1. Audience

The intended installer is a university club representative or event operator who is not expected to write software. The developer may use CLI tools, Git, Docker, and migrations during development; the goal is to simplify the **installer's** final setup experience, not to eliminate engineering tools from development.

This is a proposed user journey, not an implemented installer. The current repository is Firebase-based and does not yet contain a Supabase/Vercel deployment flow.

## 2. Installation success criteria

The target experience is:

- source-code editing: **0**;
- manual SQL paste: **0**;
- terminal commands: **0**;
- secrets posted to an Issue or chat: **0**;
- browser-oriented setup;
- target completion time: **20 minutes or less**, to be validated through usability tests and not guaranteed;
- each club owns its own deployment and provider relationship;
- a system check is completed before the first event;
- a clear event-data and full-environment deletion path exists; and
- Admin access can be recovered without exposing a service credential.

## 3. Proposed user journey

1. Open the project installation page and review the data/privacy summary.
2. Sign in to the required provider accounts, subject to the final ownership model.
3. Create or select a club-owned Supabase project.
4. Create or select a club-owned Vercel deployment.
5. Complete a guided, reviewed infrastructure initialization that applies versioned schema without asking the user to paste SQL.
6. Open the deployed application setup wizard.
7. Create the first Admin through a one-time, server-validated bootstrap.
8. Configure the club, locale/timezone, event, privacy notice and retention choices.
9. Run system diagnostics and resolve any failed checks.
10. Share the participant join URL or QR code.

The journey is a target, not a claim that a Vercel/Supabase Marketplace integration or provider button will always exist or remain available. Provider UI, permission scopes, quotas, policies, and integration reliability must be checked at implementation time.

## 4. Account and ownership model

- GitHub, Vercel, and Supabase accounts are **candidates**; the exact required accounts are an open design decision.
- Organization/team ownership is preferable to a personal student account so access can survive graduation or role turnover.
- The project must document ownership transfer, emergency contact, and administrator succession.
- Each club controls its own provider billing and is responsible for provider terms and quota usage.
- The original maintainer should not receive club production credentials or routine access to its participant/location data.
- Each club is responsible for its own retention, backup, export, and deletion lifecycle.

## 5. Secret-handling model

### Browser-safe only when designed for public use

- public project URL;
- public/anonymous key explicitly intended for browser clients and protected by tested RLS.

A public key identifies a project; it does not grant permission by itself and does not replace authorization.

### Server-only

- Supabase service-role key;
- access/refresh tokens and OAuth client secrets;
- database password/connection strings;
- deployment credentials;
- bootstrap authorization material; and
- any provider secret or signing key.

Never place server-only values in `VITE_` variables, source control, screenshots, public logs, Issues, or chat. Do not implement a client-side unrestricted bootstrap. Diagnostics must report a redacted status/category and must never render a secret value.

## 6. First Admin bootstrap

A one-time bootstrap is a **design candidate**, with final mechanism still open. It must:

- be available only while the installation is uninitialized;
- require short-lived or single-use authorization;
- validate authorization server-side;
- create only the first Admin membership;
- atomically mark the installation initialized so concurrent or later attempts are denied;
- never expose service-role credentials to the browser;
- keep recovery separate from bootstrap; and
- retain an audit record without storing the raw bootstrap secret.

The bootstrap must fail closed on partial state, expired authorization, or uncertain completion. The recovery process must use an independent trusted path and must not silently reopen first-Admin bootstrap.

## 7. Authentication experience

**Candidates:** anonymous Auth for participants and persistent, recoverable Auth for Admins.

Considerations:

- deleting browser data may lose an anonymous participant identity;
- Admin authority must not depend solely on a browser-local anonymous session;
- Admin membership must be assigned by trusted server-side logic, never by a client-selected role;
- identity provider choices require accessibility, privacy, account ownership, and recovery review; and
- rejoin, duplicate identity, lost device, and account transfer flows need explicit tests and operator guidance.

## 8. Setup wizard

Potential screens:

1. installation status and current application/schema versions;
2. club name;
3. locale and timezone;
4. first Admin and recovery verification;
5. game/event configuration;
6. mission catalog status;
7. privacy notice and participant consent guidance;
8. location retention and cleanup policy;
9. diagnostic test; and
10. completion screen with join link/QR and next-step checklist.

The wizard must not create or alter infrastructure schema by sending a service-role credential to the browser. Schema changes should be prebuilt, versioned, reviewed, and applied through a controlled trusted deployment/provisioning path. The mechanism that provides this without manual SQL is an open question.

## 9. System diagnostics

A proposed diagnostics page should test and report:

- frontend configuration presence (without showing secret values);
- Auth reachability;
- database schema version and migration status;
- a safe RLS denial check using a dedicated test identity/fixture;
- Realtime connection and authorized subscription behavior;
- trusted-operation reachability and a non-destructive check;
- current Admin authorization;
- scheduled lifecycle status/last successful run where observable;
- provider quota/plan warnings where provider APIs permit; and
- browser location permission/device guidance without collecting location into diagnostic logs.

Diagnostics should provide stable status codes, a redacted error category, and a recovery action. They must not expose secrets, raw user records, or private coordinates.

## 10. Updates

The proposed update experience should include:

- application version and database schema version;
- human-readable release notes;
- pre-update backup reminder and recovery instructions;
- a migration compatibility/preflight check;
- rollback guidance and an explicit warning for irreversible data migrations; and
- protection against silently overwriting club-owned customization.

Do not enable automatic application/schema updates without compatibility checks, a backup policy, and a tested recovery path. The update mechanism across independently owned deployments remains open.

## 11. Backup, retention, and deletion

The design must state and test:

- event-data retention period and owner;
- private-location cleanup and any required legal/consent basis;
- exposed snapshot and Emergency Projection cleanup;
- Auth identity cleanup and identity unlinking behavior;
- request receipt and audit retention;
- backup/export before destructive changes;
- a complete club-project deletion procedure with confirmation and an audit trail; and
- limits on recovery after accidental deletion or provider-side expiry.

Do not assume or promise a provider backup, point-in-time recovery, retention period, or free-tier capability until verified for the actual plan. Data deletion should cover database rows, Auth identities, backups/exports where controllable, and deployment secrets/configuration.

## 12. Support model

Users may share:

- application version;
- diagnostic status code;
- redacted error category; and
- migration/schema version.

Users must not share:

- service-role key;
- access/refresh token;
- database password or connection string;
- deployment credentials;
- bootstrap secret;
- private location or raw user data; or
- authentication token/session cookie.

Support documentation should direct security-sensitive reports to a private vulnerability-reporting channel, not a public Issue. Support should not require the maintainer to take ownership of a club's production project.

## 13. Usability validation

Before claiming the target experience is met, test with at least three students who are not software developers and who have not been coached through the steps. Include mobile-only feasibility as a separately recorded result rather than assuming the provider consoles are usable on phones.

Measure:

- completion rate;
- elapsed time from installation-page open to successful system check;
- number and type of support questions;
- abandoned or repeated steps;
- accidental secret exposure or unsafe secret handling;
- account/project ownership mistakes;
- mobile-only completion feasibility; and
- successful pre-event diagnostic completion.

Record failures and revise the proposed flow before treating “20 minutes or less” as a validated target.
