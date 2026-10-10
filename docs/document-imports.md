# Documents → Planning → Garmin Connect

The coach accepts XLSX, XLS, CSV, Markdown, UTF-8 text, PDF, PNG, JPEG and WebP.
Drop up to five files into the coach or use **Joindre des fichiers**. After upload,
ask the coach to create sessions, and to send them to Garmin if desired. The coach
reads the requested dates, checks existing sessions, then creates each session
directly with typed steps and source references. There is no import draft or approval
card. A request to read a document alone creates nothing. Source quotes are verified
against the current thread; they do not prove the model assigned the correct date.
The document skill keeps each spreadsheet date and its workout in the same column.


The Planning page's **Séances structurées et Garmin Connect** panel is a separate
human action. Select sessions, optionally select a documented compatible device,
review and send. Local edits become **À resynchroniser**. Deleting an exported
session leaves an explicit removal task. No background job exports these workouts.

## Ownership and persistence

Migration 13 added document/chunk/quota, legacy draft and Garmin operation tables, plus
`prescription`, `provenance` and `revision` on existing planned sessions. Originals,
extractions use the configured DuckDB/MotherDuck database, not the
server filesystem. Upload reservations count towards quota even when interrupted;
delete incomplete files to release their reservation. Individual 3 MiB chunks are
idempotent, finalized bytes are checked with SHA-256, and finalization is atomic.
Downloads also use chunks to remain below Vercel's response-body limit.

Conversation history stays in browser storage. Before any model call, each invocation
reconstructs the thread's selected, fully extracted documents in a Deep Agents
StateBackend mounted at `/attachments/`. References from sent messages survive the
30-message request window and browser reloads; unsent draft files are excluded.
Missing or unfinished selected files fail explicitly before the agent starts.
Legacy callers that omit the selection require every document in the thread to be ready.
The context builder includes a manifest of paths and sizes from that same state snapshot.
Document bodies and source locators enter through `read_file`/`grep` results after
consulting the document skill, not through a second preview or memory-search injection.
The UI's OCR/source preview remains available to the athlete.


This follows the [Deep Agents backend contract](https://docs.langchain.com/oss/python/deepagents/backends):
`CompositeBackend` routes `/attachments/` to `StateBackend`, whose keys are relative
to that mount (`/<document-id>.md`). Database hydration supplies those keys for each
invocation; no checkpointer or server-owned conversation history is introduced.

`services/documents.py` owns storage/extraction; `services/planning.py` owns direct
creation and source validation. `create_planned_session` accepts a typed prescription
object rather than JSON text, plus optional `{document_id, locator, quote}` sources.
Quotes must match extracted locators in the current thread. Strength uses the Lark
grammar and exercise matching; supplied steps must agree with recognized sets.
Existing sessions are reused by id. Writes are never automatically retried.


PDF extraction runs on the server with pinned PyMuPDF. Native text is extracted
without OCR; pages with images (including a native header above a scan), unreadable
characters, or no text use French/English Tesseract OCR at 200 dpi. Partial OCR
preserves readable native text. Each line retains its page, bounding box in PDF
points, and `text`/`ocr` method. PyMuPDF supplies no confidence score: OCR confidence
stays null and appears in the preview's uncertain-text filter. An OCR warning asks
the athlete to verify dates, numbers and units.

One disposable subprocess per API process isolates MuPDF from concurrent request
threads. Another extraction fails explicitly while it is occupied; there is no
queue or automatic retry. A 240-second timeout kills and reaps the subprocess.
The browser waits up to 270 seconds for finalization. Closing or cancelling the
browser request does not cancel server work; it can still finalize within that
budget. Failed extraction leaves the upload incomplete, with no partial text saved.

Standalone images still use a browser Tesseract worker with app-hosted French and
English resources. PDF.js remains responsible for PDF previews only. The preview
shows the original beside its transcription, with image zoom, page/sheet navigation,
source references and a filter for OCR confidence below 80% (or missing confidence).
Mobile uses Original/Text tabs. This indicator is not a guarantee of correctness:
high-confidence numbers also require review.
Originals remain downloadable. Preview bytes are SHA-256 checked, requests cancel on
close, and blob URLs are revoked when their views unmount.
XLSX retains formulas and available cached values, dates, coordinates and merged-cell
warnings. XLS retains cached values and decompiled BIFF formulas. If a shared or
array expression cannot be decompiled, its tokens remain visible with a verification
warning; convert to XLSX for a readable expression. Unsupported old formula formats
fail explicitly rather than masquerading as ordinary values.
No macros or formulas are executed. Unsupported, encrypted and malformed files fail
explicitly. OCR and exact source quotes do not prove semantic transcription accuracy:
the athlete must still compare the prescription to the original.

## Bounds

| Resource | Limit |
| --- | --- |
| Original | 20 MiB; 5 per drop |
| Thread | 20 documents / 100 MiB originals / 8 MiB extracted JSON |
| Global originals | 1 GiB reserved and finalized bytes |
| Extraction | 2 MiB per document; 100 PDF pages; 25 MP image/page raster |
| Workbook | 20 sheets / 100,000 cells; 64 MiB expanded XLSX / 1,000 ZIP entries |
| PDF extraction | One subprocess per API process; 240 seconds per document; 5,000 lines per page |
| Image OCR | One browser worker; 60 seconds per image / 10 minutes per document |
| Creation | One session per tool call; at most 20 source references |
| Prescription | 100 steps, 2 nested repeat levels, 1,000 expanded steps |
| Coach | 24 model turns / 96 tool calls / 300 seconds |
| Garmin | Sequential; 120-second operation budget / 12 HTTP requests / 10 seconds per request |

Exceeding a bound fails explicitly. There is no silent truncation or automatic replay
of an ambiguous write. Large documents should be split before upload.

## Garmin guarantees and limits

`garminconnect==0.3.17` is pinned. `GarminClient` remains the sole authenticated
transport. Outbound exports load tokens locally and use the pinned SDK's session
and headers without its automatic refresh/replay, so the request budget counts
actual requests. An expired/refused token requires reconnecting in Settings.
Authentication and existing activity synchronization retain their current SDK flow.

Conversion is deterministic for running, cycling, pool swimming, strength, walking
and hiking. Unsupported prescriptions remain local with a reason. Examples include
unspecified pools, mixed strokes without explicit individual steps, unrecognized
Garmin exercise names, open heart-rate zones without numeric bounds and unsupported
sport/target combinations. No approximate target conversion or model call is used.

The device list recognizes documented running/cycling/pool-swimming/strength support
for fēnix 8 and Forerunner 965. Other models are explicitly unknown; export to Connect
remains available, but automatic device transfer is disabled. Family names alone do
not establish compatibility. Extend this mapping only with a model-specific Garmin
manual and test it on the device.

The service persists remote IDs, intended content/date, exported fingerprint,
remote snapshot and operation phase before writes. It rereads content and schedules;
remote changes become conflicts. A timeout after a write becomes **indeterminate**,
blocking resends until explicit reconciliation can identify a unique remote object.
Reconciliation is read-only and scans at most 500 workouts. An ambiguous device push
stays indeterminate because delivery cannot be proven. A persistent operation ID
fences stale workers. Explicit removal checks ownership/content and rereads absence.

**Programmé dans Garmin Connect** and **Transfert demandé** are separate states.
Neither means **reçu sur la montre**. Sync Connect with the watch and inspect it.

## Local verification and acceptance

`make dev` prepares both OCR engines. `make backend` and `make test` also prepare
server language data with `scripts/bundle_ocr_data.py`. Docker, Vercel backend builds
and backend CI run this same script. It downloads only French and English from
`tesseract-ocr/tessdata_fast` 4.1.0, verifies pinned SHA-256 digests, and reuses verified
files. No OCR download happens during an upload. The language data is Apache-2.0
licensed; PyMuPDF is AGPL-3.0/commercial licensed.

Browser image OCR resources still come from pinned npm packages during `predev` and
`prebuild`. Both sets of generated OCR assets are ignored by Git and Vercel upload.

```sh
make check
cd frontend
npx playwright install chromium
npm run test:browser
```

Tests use isolated databases and mocked Garmin transport. Browser tests run actual
Tesseract extraction on a tilted printed image and PDF delegation to the server,
and exercise drop → direct creation → reload with scripted coach responses.
They also cover separate Garmin confirmation and the document preview on desktop and
mobile (original rendering, OCR confidence filtering, zoom/source controls and Escape
focus restoration). Browser checks run in the frontend CI job.
Backend tests exercise actual PyMuPDF/Tesseract extraction on textual/scanned/mixed
PDFs, encrypted/malformed files, missing languages, limits, timeouts and concurrent
requests. They also cover actual workbook bytes, formulas, merged sheets, French units,
quotas, isolation, interrupted uploads, typed source validation, direct creation/export,
export reservation, lost create/schedule/delete responses and remote conflicts.
Live LLM interpretation, Garmin authentication/network behavior, MotherDuck/Vercel
persistence and watch reception are **not validated by these mocks**.

Before production acceptance:

1. Review a real training document locally, including ambiguous dates and OCR digits.
2. Update the local Vercel CLI before preview testing (`npm i -g vercel@latest`;
   use the current release). Test a Vercel preview backed by an isolated persistent database: upload, reload,
   restart/cold-start and delete a conversation, retaining saved sessions.
3. Explicitly send one dated workout per sport compatible with the selected watch.
   Compare every step and date in Connect, sync the watch, then inspect it there.
4. Edit locally and explicitly resync; change the remote workout to verify conflict
   detection; delete locally and explicitly remove only the Arete-created object.

No live Garmin writes, Vercel deployment, commit or push is part of the automated suite.

## Coexistence with daily planning

Explicit prescriptions are excluded from automatic daily adaptation and
watch push. Their editor and export service remain their only owners; daily
sessions keep the existing structure/push flow. Moving a structured session via
the coach increments its revision and marks its Garmin copy stale. Summary-only
changes to its duration, targets or sport are rejected to preserve its steps.
The prescription editor cannot convert a daily session while its separate export
may be in flight. Migration 13 follows main's readiness, adaptation and Web Push
migrations, and both sets of fields are retained in planning responses.
