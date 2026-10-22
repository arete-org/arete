# Garmin Connect Developer Program: application dossier

> **DRAFT for the owner, not sent.** Prepared for ARE-143 so the application
> can go out the day Garmin reopens new access requests. Every statement about
> Arete below was checked against the code and `docs/` on 2026-10-22; items
> marked **[OWNER]** need a decision or a fact only the owner has. The
> "Internal notes" section at the end is for the owner only and must not be
> pasted into the form.

## 1. Programme status and what to request

- Garmin's programme page (developer.garmin.com/gc-developer-program/overview)
  now lists a **Personal** track (one's own data, pull only) and a **Business**
  track in two tiers: **Starter** (Activity, Courses, Health, Training and
  Women's Health APIs, push delivery only, no historical data, limited user
  capacity) and **Enterprise** (adds ping/pull, a month or more of history,
  unlimited users, technical support, tailored terms).
- Garmin has paused the review of new access requests; its forum replies give
  no reopening date. Check the form
  (garmin.com/forms/GarminConnectDeveloperAccess) before preparing anything
  else: when it opens, file this dossier the same day.
- **Request: Business, Starter access**, which fits 5–10 athletes; ask for
  Enterprise later if Arete opens wider (the historical backfill is the main
  reason to move up).
- Applicants report Garmin asking for a registered legal entity, a public
  website, a public privacy policy and a company-domain e-mail, then a project
  background during "Partner Verification", with an answer in two business
  days to two weeks. Some metrics may require a licence fee for commercial use.

## 2. Company identity [OWNER]

| Field | Value |
|---|---|
| Legal entity name, form and registration number (SIREN) | [OWNER] (the privacy policy currently names a natural person as publisher; Garmin expects a legal entity) |
| Registered address, country | [OWNER], France |
| Contact for the programme (company-domain e-mail, not a free mailbox) | [OWNER] |
| Public website | [OWNER] (today: https://arete-main-arete15.vercel.app is a preview, not a public site) |
| Public privacy policy URL | [OWNER] (text in `frontend/src/legal/confidentialite.md`, still a draft with `[À COMPLÉTER]` items) |
| Terms of use URL | [OWNER] (`frontend/src/legal/conditions.md`) |
| Mail filters | allow garmin.com, health.garmin.com and developer.garmin.com |

## 3. Product description (for "project background")

Arete is a training assistant for amateur hybrid athletes (running, cycling,
strength, Hyrox-style training), in French, run by its publisher as a hosted web
application (Vercel functions, MotherDuck database; the code can also run in a
private Docker stack, which shares the same database). It reads the athlete's
completed workouts and recovery data, keeps a training plan, logs strength
sessions, and gives a daily briefing and post-session feedback written by an
AI coach. It is a web application (installable PWA) with a small number of
invited athletes; each athlete only ever sees their own data.

What Garmin data does for the athlete:

- **Completed activities** fill the training journal and the session page
  (heart-rate, pace, cadence, power and altitude curves, laps, route, terrain
  and weather), match the planned session of the day, compute training load
  (acute/chronic workload, form curve) and personal records.
- **Daily health summaries** (sleep, HRV, resting heart rate, stress, Body
  Battery, training readiness, VO2max) set the day's readiness, which adapts
  the day's planned session (rest, easier or as planned).
- **Workouts** that Arete plans are sent to the athlete's Garmin Connect
  calendar so the watch guides the session.

Arete does not sell data, does not advertise and does not build cross-user
profiles. Arete itself does not train models on athlete data; see section 5
for what the AI providers it calls may do.

## 4. APIs and data requested

| API | Data types | Arete feature |
|---|---|---|
| Activity API | Activity summaries, activity details, activity files (.FIT) | Journal, session page, plan matching, load, records, post-session feedback |
| Health API | Dailies (steps, intensity minutes, resting HR), sleeps (duration, stages, score), HRV, stress details, Body Battery (from stress/dailies), user metrics (VO2max), training readiness if exposed | Daily readiness and plan adaptation, morning briefing |
| Training API | Workout import and scheduling to the user's calendar | Sending planned, structured sessions to the watch |

Not requested: Courses API, Women's Health API, Golf API.

Delivery: Starter is push-only, which suits Arete: an HTTPS endpoint receives
the notifications and stores them for the athlete they belong to. Backfill:
the consent screen's backfill option, if the athlete ticks it.

## 5. Data handling

### Consent

- **Garmin's OAuth consent** authorises Arete per athlete; Arete never asks
  for the Garmin password once on the official API.
- **Arete's own consent** (GDPR art. 9, health data) is required before any
  processing when sign-in is on: the terms, the privacy policy and an explicit
  health-data box, recorded with both text versions in the append-only
  `app.athlete_consents` (`services/consent.py`). Without current consent every
  route but sign-in, account deletion and export answers 403, and scheduled
  jobs skip the athlete. Withdrawal (Settings → À propos) stops processing at
  the next request or job; a new text version asks everyone again.

### Use of AI

The coach's answers, briefings and session feedback are produced by language
models reached through OpenRouter. Requests carry the training and health facts
the answer needs (Garmin data included). Arete itself does not train models on
them. The default routes are free models
(`agent/models/registry.py`: `max_price` 0, no other provider restriction);
a paid model is used only when an administrator turns it on. Arete does not
send OpenRouter's `data_collection: "deny"` preference, so the providers
OpenRouter routes free requests to may retain prompts or use them for
training under their own terms; the privacy policy already warns of possible
training on free requests.

**[OWNER]** two questions before submitting: (1) whether Garmin's API licence
allows Garmin data in AI-generated coaching at all (the Strava agreement of
1 June 2026 forbade it, which is why Strava was retired as a source); (2)
whether to send `data_collection: "deny"` (and accept fewer free providers, or
paid ones) so that no provider may retain or train on Garmin-derived prompts,
which Garmin is likely to require.

### Storage and isolation

- One database (MotherDuck, DuckDB) shared by the deployment; every athlete
  table carries an owner column, reads go through per-athlete projections
  (`app.visible_*`) and writes filter by owner (`docs/multi-athlete.md`). This
  isolation is enforced by the application.
- The application runs on Vercel (serverless functions); traffic is HTTPS only.
- Sign-in through Clerk; administrators are named by the owner; an
  administrator's reads of an athlete's data through Slack are written to the
  application log (`services/admin_athlete_data.py`).
- Garmin credentials (OAuth tokens once on the official API) are stored per
  athlete in the database and never exported (`services/data_export.py`
  leaves them out).

### Retention, export and deletion

- Data is kept while the account exists.
- **Export**: Settings → Données downloads every table as CSV (ZIP) or JSON
  (`GET /export/zip`, `GET /export/json`), available even after consent is
  withdrawn.
- **Deletion**: Settings → deleting the account (`POST /auth/me/delete`) erases
  every private row of the athlete in one transaction, then their files and
  Clerk login; only a dated, hashed erasure record and the consent history
  remain. Database backup clones (two kept, made before schema migrations)
  hold the data until replaced.
- **Garmin deregistration**: on Garmin's deregistration or permission-change
  notification, Arete will delete the stored tokens and stop requests for that
  athlete; activities already imported stay in the athlete's journal until
  they delete them or their account (to be built with the integration, see 7).

### Sub-processors

Vercel (hosting), MotherDuck (database), Clerk (sign-in), OpenRouter and the
model providers it routes to (AI answers, voice transcription), Open-Meteo
(weather at a session's start: position and time only), optional LangSmith
tracing, Google Calendar and Slack when the athlete connects them, browser
push services. Several are in the United States **[OWNER]**: transfer
safeguards are still `[À COMPLÉTER]` in the privacy policy.

## 6. Brand and attribution

Follow the Garmin brand guidelines once access is granted: "Garmin" and
"Garmin Connect" named as the data source on the session page (the source
label "Garmin" is already shown) and in Settings → Connexions; no Garmin logo
before the guidelines' approval.

## 7. Technical plan after approval

1. OAuth 2.0 (three-legged, redirect URI under the API's domain) replacing the
   current connection form in Settings → Connexions; tokens per athlete in the
   existing credential storage.
2. One push endpoint for activities, activity files and health summaries,
   checked against Garmin's signature or client credentials, mapping the
   Garmin user id to the athlete; payloads go through the same import path as
   today (`garmin/sync.py` for Garmin activities, `services/activity_import.py`
   for files). The file import refuses a workout already stored from any
   source; the Garmin sync only takes over legacy Strava rows today and must
   also recognise an imported file's row before going official.
3. Deregistration and user-permission notifications: delete tokens, mark the
   connection closed, record the date.
4. Training API for the existing workout export (`services/garmin_export.py`),
   keeping its reservations and never replaying an ambiguous write.
5. Until then, and for athletes on other watches, the file import (FIT, TCX,
   GPX, ZIP) in the Journal is the supported path.

## 8. Screenshots to attach

Take them on the preview with a test account (no personal data), at desktop
width and 390 px:

1. Settings → Connexions with the Garmin row and "Autres montres".
2. The consent screen (two unticked boxes, links to the texts).
3. The Journal's cardio tab with an imported activity list.
4. A session page: summary, curves, laps, route (source label visible).
5. The dashboard's readiness and the morning briefing.
6. The Planning page with a structured session and its "send to Garmin" state.
7. Settings → Données (export) and the account deletion panel.
8. Settings → À propos with the consent state and withdrawal.

## 9. Form answers, ready to paste

- **How will Garmin data be used?** Linked to identifiable users (each athlete
  sees and is coached on their own data); not aggregated, not anonymised for
  third parties, never sold.
- **Which APIs?** Activity, Health, Training.
- **Number of users:** invited athletes, 5–10 in the first year [OWNER].
- **Platforms:** web application (PWA), France, French language.
- **Monetisation:** [OWNER] (no billing exists in the product today).

## 10. Before submitting: checklist [OWNER]

- [ ] Legal entity created and named in the privacy policy and terms.
- [ ] Public website and published privacy policy (no `[À COMPLÉTER]` left),
      mentioning Garmin as a source and the AI processing.
- [ ] Company-domain e-mail.
- [ ] Answer on AI use under Garmin's licence.
- [ ] Screenshots of section 8.

## Internal notes (owner only, not for the form)

- Today's Garmin connection uses the community `garminconnect` library with
  the athlete's credentials (MFA supported), not the official API; the
  password is not stored, the session tokens are. The application must not
  describe this as an official integration, and the official API replaces it
  on approval.
- The privacy policy lists activities as "séances Garmin ou fichiers FIT";
  with ARE-143 it should read FIT, TCX and GPX files. Changing it means a new
  `PRIVACY_VERSION`, which asks every athlete to consent again.
