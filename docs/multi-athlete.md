# Private athletes in one database

Each Clerk subject maps to a login account in `app.users` and one private athlete
in `app.athletes`. A new account receives empty training data and its own settings.
The first account to sign in with a verified address listed in `ARETE_OWNER_EMAIL`
claims the historical athlete (ID 1). A listed address on another person's account
gets its own athlete instead: athlete 1's data and Garmin session stay with the
address that holds it. Attaching a second login of the owner is a deliberate
`UPDATE app.users SET athlete_id = 1`. Subsequent email changes update contact
details without changing that mapping.
Email is retained with its verification timestamp; storing it does not subscribe
the account to a newsletter or implement an email delivery service.

[Approved Excalidraw diagram](multi-athlete.excalidraw) ·
[Excalidraw link](https://excalidraw.com/#json=eRirgE5b-k__cxd7rUetg,KgW6uORe5ugr29JEDThaYA)

## Connect an athlete end to end

1. Enable `ARETE_AUTH=clerk`, configure Clerk's public/secret keys and the verified
   historical owner address in `ARETE_OWNER_EMAIL`. Without authentication the
   installation remains a single, implicit athlete; it is not a public multi-user mode.
2. Sign in to Arete. In **Réglages → Connexions**, choose **Connecter Garmin**,
   enter that athlete's Garmin email/password, and complete MFA if requested.
3. Choose **Synchroniser**. Imported activities, health data, training plans,
   strength sessions, goals, analytics, game state and coaching belong to that athlete.
   Detailed health/range sync controls remain in the System tab.
4. **Déconnecter Garmin** removes that athlete's session, including any pending
   login, while retaining imported workouts. It cannot disconnect another athlete.

`GARMIN_EMAIL` and `GARMIN_PASSWORD` are no longer read. Existing saved tokens
remain with athlete 1; new accounts must connect independently. The current
integration uses the pinned `garminconnect` library, not Garmin's partner OAuth API.
Passwords are used for the login call and are not persisted. MFA continuations
store bounded JSON (128 KiB, at most 128 cookies) in private database rows for
10 minutes, not live Python objects. Completion consumes the row before calling
Garmin; an expired/failed completion requires starting the connection again.
The serialization adapter follows SDK 0.3.17's private MFA fields, so SDK upgrades
must exercise portal, iOS and widget continuations. This preserves cookies and
TLS impersonation across workers without storing a password or using pickle.

## Consent before any data flows

With sign-in on, an athlete reaches nothing but their account, the consent
routes and their data export until they accept the current terms, privacy
policy and, explicitly, the processing of their health data (Settings → À
propos to withdraw). Every per-athlete job skips an athlete without current
consent, the owner included: after migration 63 the owner's scheduled jobs
simply pause until the owner consents on their next visit. A withdrawal keeps
the data. See [the architecture](architecture.md#consent-to-health-data-processing).

## Ownership contract

- Authentication, signed OAuth state and the scheduler establish a trusted
  `athlete_scope`. Request bodies and model arguments cannot choose another owner.
- `dataio.db.connect()` sets a **connection-local** `arete_athlete_id`. Domain reads
  use `app.visible_<table>` projections; writes explicitly filter by owner, and
  inserts get an owner default from that connection. Authenticated connections
  without a scope see no private rows and cannot insert a default owner.
- Historical `user_id` columns mean athlete ID. New private columns use
  `athlete_id`; this avoids renaming existing API fields. Natural keys such as
  file paths, game settings and push endpoints are unique within an athlete.
- Domain services validate referenced parents through live private projections.
  Child projections require a live parent. This is application-enforced isolation,
  **not DuckDB row-level security or universal composite foreign keys**. The server
  credential is privileged. New SQL requires both a scope review and cross-account
  behavior tests; the structural test catches literal raw private-table reads.
- Sessions, goals and accounts use soft deletion. Account deactivation closes all
  mapped logins and retains the login email; reactivation reopens them. Explicit document deletion, forgotten
  facts and disconnected credentials retain their existing physical purge semantics.
- Files live under the historical root for athlete 1 and `athletes/<id>/` for
  others. Database file mirrors, Garmin MFA and coach caches are partitioned.
  Remote Garmin tokens are read from the database for each fresh client so another
  worker's logout is observed. Requests already running cannot be forcibly revoked.
- Browser conversations use athlete-specific storage keys; account changes clear
  API/query caches and remount the app. Private API responses are network-only in
  the service worker. Switching accounts revokes the old device push channel.

## Roles and administration

`app.users.role` is `athlete` or `admin` (migration 39). The owner, every login of
athlete 1, administers by right whatever the column says; `/auth/me` returns
`role` and `is_admin`. **Réglages → Administration**, shown to administrators,
lists each athlete with its logins, role, last activity (refreshed hourly with the
Clerk profile) and daily sync, and acts on the account tables only, never on an
athlete's private data:

- **Désactiver / Réactiver** an athlete: its logins are refused (within the
  bound below) and its data is hidden, then restored as it was. Nobody deactivates athlete 1, and only
  the owner deactivates an administrator's athlete.
- **Libérer la synchro**: clears a lease kept by a failed or stopped daily run, so
  the next window runs the day again. Check first what that run already did at
  Garmin or the calendar. A lease within its 15 minutes belongs to a run
  in progress and is not released.
- **Nommer admin / Retirer admin**: the owner only, never on its own logins.

Deleting another athlete's account is not an administration action: only the
athlete erases their own (below).

The same tab shows **Indicateurs produit** (`GET /admin/kpis?weeks=12`, 1 to 52
ISO weeks, exportable as CSV in the browser): one aggregate SQL per indicator over
the base tables (`services/product_kpis.py`), returning counts only, never an
athlete id or row. Like the live projections, it skips soft-deleted rows and
deactivated athletes, and a ratio's numerator only counts athletes created by the
week's end. The cohort indicators (first action, 30-day retention) count sign-ups
only: athletes created after migrations 35 and 36 were recorded, which created the
pre-existing ones (athlete 1 included) at migration time. The CSV uses `;` and
decimal commas for French spreadsheets. `last_seen_at` keeps only the latest visit, so a past week's
active accounts are the athletes with a recorded action in it (check-in answered,
briefing reaction, strength log, review accepted, evening answer, a thread started
or last continued, push subscription) or whose last visit falls in it. A device
subscribing again keeps its first subscription date; deleted push subscriptions
leave no trace, and no column records a briefing read without a reaction. The
eight queries read one snapshot.

A change applies at the account's next request on the instance that made it.
Each instance reuses a resolved account (the login and whether its athlete is
live, read in one query) for 30 seconds (`ACCOUNT_TTL_SECONDS` in
`api/auth.py`, at most 60), so other instances follow within that bound.

## Erasing an account

**Réglages → Données** offers the export first, then **Supprimer mon compte**:
the athlete types `SUPPRIMER`, which the server checks again
(`POST /auth/me/delete`). Erasure is immediate, with no grace period, and
physical, unlike deactivation. `services/account_deletion.py` acts on the
trusted athlete scope only:

1. It refuses (409) the owner's athlete, whatever the other administrators:
   the instance keeps its owner, who administers by right and alone names
   administrators. Erasing it is a manual operation for the instance's
   operator. Every other athlete, `admin` logins included, may leave.
2. One transaction deletes the athlete's logins (`app.users`, read with
   `RETURNING` so a login attached meanwhile is not missed), every row of
   every relation in `dataio/tenant_schema.py` (`PRIVATE_TABLES`,
   soft-deleted rows included; the list is derived from that module, never
   copied), the other account rows (`app.athletes`, `app.slack_athletes`, the
   Slack identities, private threads and operations of its logins) and writes
   `app.account_deletions` (migration 61): the day and the SHA-256 of each
   login's Clerk id, nothing else. The athlete-keyed deletions travel as one
   script, so the database work is a handful of round trips: `BEGIN`, the
   logins, the script, three login-keyed deletions, the log, `COMMIT`. A
   failure rolls everything back, files included, and answers 503; asking
   again finishes the job. The consent history (`app.athlete_consents`,
   `KEPT_TABLES`) stays, as proof that consent was given (GDPR art. 7(1)).
3. After the commit, it removes the athlete's directory on this instance,
   `athletes/<id>/`, best effort: a file a sync is still writing does not fail
   the erasure, the server logs how many remain with the athlete's id.
4. The endpoint then deletes each Clerk user with one request (10-second
   timeout), without the SDK's retries. A Clerk failure answers 502 once the
   data is gone: the page says so and offers to sign out. The log refuses that
   login a fresh athlete, and the operator deletes it in Clerk's dashboard (the
   server log names it).

A `COMMIT` whose answer is lost on the network may have happened. The retry
then comes from a login the log records: every route refuses it (403, `code`
`account_deleted`) except the deletion route, which finishes with that
login's Clerk deletion and answers 204. The page takes that code as an
erasure too.

The worst case is therefore well under Vercel's 300 seconds: the database
script (about sixty statements in one transaction) plus ten seconds per login.
Every Clerk login attached to the athlete is deleted, so an administrator must
never attach their own login to another athlete.

Data goes before Clerk on purpose: a failure while erasing leaves the session
open and asking again finishes the job, whereas a Clerk user deleted first
would leave data nobody can reach to erase. Once the server has answered, the
page shows the erasure whatever the sign-out does; the browser forgets the
athlete's conversations and drafts, and the still-mounted coach panel stops
saving them. If Clerk's sign-out fails (it may already have revoked the
deleted user's session), the page ends the session itself: caches, persisted
answers and push channel cleared, then a reload.
`tests/test_account_deletion.py` fills every private and account table for
two athletes, erases one and checks the other is untouched; it also fails when
a new table holds an athlete or a login outside this list.

The export offered first stays within one response for years of history: the
tables that grow by a text or JSON row a day or per session (streams,
conversations, briefings, plan decisions, fact revisions, game events and
ledger, automation runs, interrupts and effects) are opt-in, best taken over a
period (`tests/test_data_export.py` builds five years of history).

Limits: the MotherDuck clones the boot takes before a migration
(`<db>_bak_<stamp>`, the two newest kept, `docs/deployment.md`) keep the data
until they rotate out, as the deletion screen says. Requests already running,
or served by another instance within the 30-second account cache, cannot be
revoked: a write they finish lands under an id no login maps to, invisible
but stored. A tombstone refusing writes for an erased id is a follow-up. A Vercel
instance's `/tmp` copies of the files die with it. Remote providers are not
called: Strava and Garmin sessions are erased here but not revoked there, and
events already written to the athlete's Google Calendar stay in it.

## Migrations and deployment

Migrations **35 and 36** are versioned in the monorepo. They preserve old account
mappings, map null legacy owners to athlete 1, inherit child ownership from parents,
and rebuild private tables transactionally to add non-null owners and scoped keys.
Migration 36 is replayable after a commit interrupted before version recording.
Missing older migration versions still run. Global IDs and existing data remain.

The rollout requires a maintenance cutover: old application versions read base
tables without filtering, and cannot safely coexist with newly onboarded athletes.
Back up the database; stop old Docker/API processes, cron and accessible old
production deployments; migrate and start only this version; verify the original
account and a second empty account before reopening access. Restore the backup
and old application together if rollback is needed. Do not run the old application
against a migrated database containing multiple athletes.

Production has run on these migrations since 10 October 2026: the cutover above
was performed once, and accounts outside the owner's now receive their own
athlete. Previews use the separate database `md:arete_preview_v2`; a preview with
`VERCEL_ENV=preview` and an `ARETE_DB` whose name lacks `preview` (production's
`md:arete_v2`, say) still refuses database access before connecting, including
initialization. Production ships through the repository's
manual deployment workflow, after the main preview has served the same commit
(`docs/deployment.md`).

## Daily sync

Each athlete is synced once a day: Garmin activities and health, plan
adaptation, the calendar and the session feedback, then the briefing
and, any day but Sunday, the week's review when Sunday evening's was missed
(the last window, 16:00 UTC, writes it on Sunday: `docs/architecture.md`). Vercel's Hobby plan runs a cron at most once
a day, so `vercel.json` lists ten daily windows on the same path, from 07:00 to
16:00 UTC (each fires within its hour). Two earlier windows, 05:00 and 06:00
UTC on `/api/cron/checkin`, only send the morning check-in push, between
06:00 and 12:00 on the athlete's clock and outside their quiet hours; the
answer then reaches the day's decision. The first window waits for Garmin to
have the night's sleep and HRV, which arrive when the watch syncs after waking.

An athlete is owed from 07:00 on their own clock (their timezone setting), or
from `ARETE_AUTO_SYNC_HOUR` when set, and never during their quiet hours
(21:30-07:00 by default): a run there would sync before the night's data and
lose the briefing, feedback and review pushes that quiet hours drop. With the
default quiet hours, athletes from UTC-9 to UTC+5 run in their morning, those
further east in their afternoon or evening; west of UTC-9 no window falls after
07:00 local, so the scheduler skips them until a later window is added to
`vercel.json`.

A dispatch reads the athletes still owed today, least recent run or claim
first, and claims them one at a time. Time bounds it rather than a count: one
athlete's run lasts from seconds to minutes, and Vercel stops the function at
300 seconds. No
athlete is claimed after 120 seconds and no briefing or review starts after 210;
a deferred briefing is written by the dashboard's own request (`POST
/tips/daily`) when the athlete opens it, and the review stays one click away in
Planning. Later windows take whoever is still owed; a window with nothing to do
costs one query, which also reads each athlete's timezone and quiet hours. A
dispatch that reaches the 500-athlete scan bound reports `deferred` like one
stopped by time.

Each athlete carries a daily marker (`last_sync_at`) and a lease
(`sync_lease_until`), both naive UTC timestamps written from the dispatch's
clock, so Docker and Vercel writers agree whatever their timezone. Both are
dated by the claim: a run claimed at 23:58 that ends after midnight counts for
the day it started, and skips its briefing and review once that day has ended.
Markers stored by a non-UTC writer before this rule are read as UTC: shifted by
that writer's offset, they can skip one day or hold a lease longer, once. A
failed or stopped run keeps its lease for the rest of the day, so the same day
never replays it. The next day's dispatch reclaims a lease
dated before today and starts a new day: every step is idempotent per day
(activities are deduplicated by id, the scheduler writes one briefing a day and
one review a week). Overlapping windows skip what the other claimed. To park an
athlete, set its `sync_lease_until` far in the future; to force a run at the
next window, clear both columns. An always-on Docker scheduler dispatches every
five minutes around the clock; `ARETE_AUTO_SYNC_HOUR` is read on each athlete's
clock, not the host's. No queue infrastructure is introduced.

## Local validation

`make check` covers static checks, backend/frontend tests and the production build.
`npm --prefix frontend run test:browser` covers browser workflows. Tests mock
external Garmin/Clerk calls and use temporary local databases. In particular,
`test_multi_athlete.py` exercises two independent HTTP logins, MFA across workers,
Garmin import/disconnect, shared storage, files, documents, coach memory and jobs.
The browser connection test covers the visible form → MFA → sync → logout flow.
A real Garmin login and a dedicated MotherDuck preview remain rollout checks.

### Private administrator consultation in Slack

The Slack product assistant additionally permits verified Arete administrators
to read an active athlete's settings, training, health, facts, journal and stored
document extraction. This is separate from the administration HTTP endpoints,
which retain their account-management scope. Reads are restricted to an
administrator-owned DM, audited by actor/target/section, and have no training
writes or outbound communication tools. Revocation is checked at each privileged
operation. A private consultation thread never becomes a public product thread.
See [Slack administrator behavior](slack.md#administrator-product-assistant).
