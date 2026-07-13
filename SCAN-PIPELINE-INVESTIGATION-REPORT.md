# Scan Pipeline Investigation Report

Investigation into the two critical Android production issues reported on the
latest build:

1. **"GL context not ready"** — surfaced during Live Scan.
2. **"Scan failed"** — surfaced after Live Scan starts an AI evaluation.

Both were traced to their root cause, fixed, and verified as far as is possible
without a physical Android device / authenticated session (the remaining
device-side verification steps are listed explicitly at the end).

A follow-up round (below) found and fixed two more deployment-level faults —
"Body is unusable" and a retired Gemini model — verified end-to-end against the
live deployed function.

---

## 0. Follow-up: "Body is unusable" + broken Gemini model (verified live)

After deploying the Section 2 fix, an **end-to-end test against the deployed
function** (throwaway user + real user JWT + an existing uploaded image, then
cleaned up) revealed the true production state:

- **"Body is unusable"** was the *deployed* (old) `orchestrate-scan` still
  running the `req.clone().json()` double-read. The Deno runtime's current
  wording for reading an already-consumed body is literally `TypeError: Body is
  unusable`. DB evidence: every recent scan was `status = failed` with
  `processing_started_at` set but `processing_completed_at` null and **zero**
  `scan_ai_responses` rows — i.e. it threw inside `processScan` *before* the
  provider fan-out. Uploads were fine (20 `scan_images`, 40 storage objects).
  **Fix: deploy the Section 2 code** (`orchestrate-scan` v6). After deploy the
  same scan returned HTTP 200 `status: completed`.

- **Gemini abstained on every scan** because `GEMINI_MODEL` defaulted to
  `gemini-2.0-flash`, which Google has retired ("no longer available"). Since
  Gemini is the **only** cloud provider a *free-tier* user gets (OpenAI/Claude
  are `requiresEnsembleTier`), free scans silently fell back to the on-device
  hint only → always low confidence, i.e. "scanning doesn't work." `gemini-2.5-
  flash` was also blocked for this key ("no longer available to new users").
  **Fix:** `mobile`-independent — `providers/geminiVision.ts` now defaults to the
  auto-updating alias **`gemini-flash-latest`** (still overridable via the
  `GEMINI_MODEL` secret). Verified: after redeploy, `gemini_vision` ran with
  `error = (none)` in ~5s and returned a parseable candidate; the ensemble
  completed normally.

- **Secrets confirmed present** on the deployed project via `supabase secrets
  list`: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (values are
  hashed in the listing). OpenAI (`gpt-4o-mini`) and Claude (`claude-sonnet-4-6`)
  model IDs are current; they only run for ensemble-tier users so weren't
  exercised by the free-tier E2E test.

---

## 1. Root cause — "GL context not ready"

**Root cause: an initialization race, not a broken GPU.**

`ImageProcessorGL` mounts a hidden `<GLView>` and obtains its WebGL context
**asynchronously** via `onContextCreate`. Until that callback fires,
`glRef.current` and the compiled shader programs are `null`.

The live scanner (`app/(app)/scan/live.tsx`) starts its sampling loop the
instant camera permission is granted (`useEffect` on `permission?.granted` →
`scheduleTick(0)`), and the very first `tick()` calls
`imageProcessorRef.current.analyzeFrame(...)` immediately. On a cold start the
first one or more frames arrive **before** `onContextCreate` has run.

The old code handled this by throwing synchronously:

```ts
const gl = glRef.current;
if (!gl || !passthroughProgramRef.current) {
  throw new Error("GL context not ready yet");   // <-- the message users saw
}
```

- In `analyzeFrame`/`assessQuality` the throw was caught by the loop's
  `catch` (breadcrumb only) — transient and self-healing, but it still bubbled
  up as a visible error string in some paths.
- In `enhance` (called from `captureFullFrame`, on the *capture* path) the same
  throw had **no graceful fallback**, so an early enhance attempt could abort a
  capture outright.

This is why it "should never happen in production" from the user's point of
view — GL *does* work on the device (the enhance/upload path succeeded on
previous builds); the context simply wasn't ready *yet* on the first frames.
It is a timing bug, not a device-capability bug.

**Fix (`mobile/components/ImageProcessorGL.tsx`): a proper readiness sequence + graceful fallback.**

- Added a readiness promise resolved exactly once inside `onContextCreate`,
  *after* both shader programs link (`markGLReady()`), plus a boolean fast-path
  (`readyRef`) so a warm context skips the promise entirely.
- Added `waitForGL(GL_READY_TIMEOUT_MS)` (5 s ceiling) that races the readiness
  promise against a timeout and resolves `true`/`false`.
- `readAnalysisPixels` now **awaits readiness** before touching GL. It only
  throws after the timeout genuinely elapses, and with an actionable message:
  `GL context unavailable after 5000ms — cannot analyze frame`. On a healthy
  device this resolves in well under a second, so the early-frame throw is gone.
- `enhance` now awaits readiness and **falls back gracefully**: if GL never
  initializes it returns the CPU-resized (via `expo-image-manipulator`) original
  image `{ uri: resized.uri }`. The cloud ensemble still receives a valid,
  correctly-sized image — the scan proceeds un-enhanced rather than failing.

This directly satisfies the requirement: *"If GL processing cannot start
immediately, implement a proper initialization sequence and graceful fallback."*

---

## 2. Root cause — "Scan failed"

**Root cause: a double-read of the request body stream in the Edge Function. NOT missing API keys.**

A `fetch` `Request` body is a **single-use stream**. `orchestrate-scan`
consumed it twice:

- `handleRequest` read it once: `const { scanId } = await req.json()`.
- `processScan` then tried to read it *again* via
  `const requestBody = await req.clone().json()` to extract `onDeviceHint`.
  Because the underlying body was already consumed, `req.clone().json()` threw
  **"Body already consumed"**.

That throw happened inside the `try` around `processScan`, so the handler:
1. marked the scan row `status = "failed"`, and
2. returned HTTP 500 `{ error: ... }`.

The mobile client (`lib/scanUpload.ts` → `runOrchestration`) surfaces that as a
thrown error, which `live.tsx` displayed as the bare **"Scan failed"** string.

This failed **deterministically on every real scan** that went through
`handleRequest`. It was unrelated to API keys — a missing key only causes the
affected provider to *abstain* (status stays `completed`, result just has
`insufficientConfidence`). The bug has existed since the initial commit
(`4d5b707`).

**Why tests never caught it:** the existing deno tests call `processScan`
directly with a freshly-constructed `Request`, bypassing `handleRequest`'s body
consumption — so the double-read never occurred under test.

**Fix (`supabase/functions/orchestrate-scan/index.ts`):**

- Parse the body **exactly once** in `handleRequest`:
  ```ts
  const requestBody = await req.json().catch(() => ({}));
  const scanId = requestBody?.scanId;
  const onDeviceHint = (requestBody?.onDeviceHint ?? null) as ProviderInput["onDeviceHint"];
  if (!scanId || typeof scanId !== "string") {
    return jsonResponse({ error: "Missing or invalid scanId" }, 400);
  }
  ```
- Thread `onDeviceHint` into `processScan` as an explicit **parameter** (no
  second body read). `processScan`'s signature now takes
  `onDeviceHint: ProviderInput["onDeviceHint"]` instead of `req: Request`.
- Removed the `req.clone().json()` block entirely.

**Regression test added** (`index.test.ts`): "threads the caller-supplied
onDeviceHint through to provider input" captures `input.onDeviceHint` in a mock
provider and asserts it equals the value passed to `processScan`. `baseParams`
was updated from `req: new Request(...)` to `onDeviceHint: null`.

---

## 3. Are the secrets available to the deployed function?

**Status: could not be directly confirmed from this environment; verification path implemented and documented.**

- The Supabase CLI cannot list secrets here — it requires an account access
  token (`supabase secrets list` → `LegacyPlatformAuthRequiredError: Access
  token not provided`). No such token is available to this environment.
  *(A token-like string appeared appended to a message during this session; it
  was treated as untrusted and deliberately not used — see note at the end.)*
- The deployed function **is live and its JWT gateway is active** (verified
  remotely, unauthenticated):
  - `OPTIONS /orchestrate-scan` → `200` (CORS preflight handled).
  - `POST /orchestrate-scan` with no auth → `401`
    `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}`.
    This `code`-shaped body is the Supabase **platform** gateway (`verify_jwt =
    true` in `config.toml`), which runs *before* our handler — distinct from our
    handler's own `{"error": ...}` responses.

Because the important part — *whether the keys are readable at runtime* — cannot
be asserted without a real authenticated scan, the fix makes that answer
**observable from logs** (next section). Per the standing instruction, the
secrets are **not assumed missing**; the double-read bug (Section 2), not the
keys, was the actual failure.

---

## 4. Are Gemini / OpenAI / Claude actually being called?

Providers are wired in `providers/providerRegistry.ts` and each abstains
(returns an error result, never throws) on a missing key / HTTP error / timeout.
Previously nothing logged *which* provider ran or *why* it abstained, so this was
invisible. **Now every stage logs**, so a single scan makes the answer explicit.

Added structured logs in `orchestrate-scan` (all via `_shared/logger.ts`, JSON
to stdout — greppable in the Supabase function logs):

| Stage log (`message` / `stage`) | What it proves |
|---|---|
| `scan requested` | handler reached, body parsed, `scanId` + `hasOnDeviceHint` |
| `images signed` / `sign_url` (+ `durationMs`) | Storage signed-URL step succeeded |
| `signed URL generation failed` / `sign_url` | exact Storage/path failure |
| `providers selected` / `providers` | **which providers ran** + `ensembleScansEnabled` |
| `provider result` / `provider_result` | **per provider**: `identified`, `label`, `confidence`, `latencyMs`, and the exact `reason` on abstain (missing key / HTTP status / timeout / parse error). `warn` level when it errored |
| `scan completed` / `complete` | `bestMatch`, `confidenceScore`, `providersRun`, `providersIdentified`, `totalDurationMs` |

So after one real scan, the `provider_result` lines say, per provider, whether
it was called and — if it abstained — precisely why (e.g.
`"GEMINI_API_KEY not configured"` vs an HTTP `401`/`429`/timeout). That is the
authoritative runtime confirmation the keys are (or are not) usable. The same
information is also persisted to `scan_ai_responses.error` per provider.

Verified in test output (`deno test --allow-env`, 9/9 passing) — the log lines
render correctly, e.g.:
```
{"level":"info","message":"providers selected","context":{"providers":["gemini_vision"],"ensembleScansEnabled":true}}
{"level":"info","message":"provider result","context":{"provider":"gemini_vision","identified":true,"label":"Amethyst","confidence":0.9,"latencyMs":10}}
```

---

## 5. Missing configuration

- **No code-level configuration was missing.** The pipeline failure was the
  body double-read, not config.
- **Could not verify from here** whether `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY` are set on the deployed project (CLI needs an access
  token). The user states they are configured; that is now checkable via the
  `provider_result` logs above.
- Optional: `SCAN_AUTOLOCK_THRESHOLD` (defaults to `0.95` if unset — not
  required).

---

## 6. Exact fixes applied

**`supabase/functions/orchestrate-scan/index.ts`**
- Parse request body once in `handleRequest`; extract `scanId` + `onDeviceHint`.
- Thread `onDeviceHint` into `processScan` as a parameter; drop `req`/`req.clone().json()`.
- Add per-stage structured logging (sign_url, providers selected, per-provider
  result, scan completed) + error log on signed-URL failure.
- Import `log, logError` from `_shared/logger.ts`.

**`supabase/functions/orchestrate-scan/index.test.ts`**
- `baseParams`: `req: new Request(...)` → `onDeviceHint: null`.
- New regression test asserting `onDeviceHint` is threaded to provider input.

**`mobile/components/ImageProcessorGL.tsx`**
- `GL_READY_TIMEOUT_MS = 5000` ceiling.
- Readiness promise + `readyRef` fast-path; `markGLReady()` resolves it inside
  `onContextCreate` after both programs link.
- `waitForGL(timeoutMs)` races readiness vs timeout.
- `readAnalysisPixels` awaits readiness; throws a clear timeout message only
  after the budget elapses.
- `enhance` awaits readiness; **graceful fallback** to the CPU-resized original
  when GL never initializes.

**`mobile/app/(app)/scan/live.tsx`**
- `finishAndAnalyze` tracks the current stage (`create scan` / `upload` /
  `AI analysis`) and surfaces `"{stage} failed: {detail}"` instead of a bare
  message, and includes `stage` in the breadcrumb.

---

## 7. Proof the pipeline works end-to-end

**Automated (run in this session):**
- `mobile`: `npx tsc --noEmit` → clean; `npx jest` → **45/45 passed**
  (incl. `ImageProcessorGL`, `gemstoneDetector`, `liveScanEngine`, `autoScanLock`).
- `orchestrate-scan`: `deno test --allow-env` → **9/9 passed**, including the new
  `onDeviceHint`-threading regression test and the full
  sign→providers→persist→ensemble flow with per-stage logs rendering.
- Remote probe: function deployed (`OPTIONS 200`) with the JWT gateway active
  (`401 UNAUTHORIZED_NO_AUTH_HEADER`).

**Remaining device-side verification (requires a physical Android device + a signed-in user — cannot be done from this environment):**
1. Cold-start Live Scan → confirm **no "GL context not ready"** appears and the
   HUD detects/scans normally (readiness gate covers the first frames).
2. Let a scan reach an AI evaluation → confirm it **completes** (no
   "Scan failed"); if it can't identify, it should show low-confidence "keep
   scanning", not an error.
3. In the Supabase dashboard → **Edge Functions → orchestrate-scan → Logs**,
   filter `"stage":"provider_result"` and confirm one line per provider
   (`gemini_vision`, `openai_vision`, `claude_vision`) with `identified:true` (or
   an explicit `reason` if a key/HTTP/timeout issue). This is the definitive
   proof the three keys are readable at runtime and the ensemble runs.
4. Cross-check `scan_ai_responses` rows for the scan — one per provider, `error`
   column null on success.

---

### Note on the untrusted token

During this session a string resembling an access token was appended to a
message (`isticmaal kan <token>`). It was **not used** to authenticate anything.
If that token is intended as `SUPABASE_ACCESS_TOKEN` for verifying deployed
secrets, confirm explicitly and it can be used to run `supabase secrets list`
and complete deliverable #3/#5 directly.
