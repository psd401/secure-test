# Text-to-speech and speech-to-text — design note

Side: client (most of it) + design-tool (small). Written 2026-10-01 after the
accommodations portfolio was narrowed (`ad819ea`: teachers see only the tools
the client delivers plus these two). James: TTS and STT are the highest
priority; options before any build. **Nothing here is built.**

## Where things stand

- **Catalog ids (all visible to teachers since `ad819ea`):**
  `tts_test_content` (TIDE: None / Items / Stimuli / Stimuli+Items),
  `tts_student_responses` (Off / On), `tts_for_ela_reading` (construct-
  altering), `tts_spanish`, `speech_to_text` (Off / On) with
  `speech_to_text_language` (English only / English & Spanish; Math +
  Science). Values arrive in the delivery bundle's `accommodations` map
  today; **the client reads none of them.**
- **macOS dictation is not the accommodation.** AAC on macOS has no dictation
  knob (`allowsDictation` is iOS-only), so the app can neither grant it per
  student nor block it. Hand-run 2026-10-01 (`client/MANUAL-CHECKS.md`
  "Dictation under the Jamf configuration"): no Jamf dictation block exists
  (IT planned one, never deployed; IT blocks only if we ask), and inside a
  real AAC session on macOS 26.7.1 the dictation menu appeared but dictation
  never started, in both text fields. On 26.6.2 (2026-08-27) text landed. One
  run — not a guarantee either way.
- **Page constraints that shape the UI:** the assessment page disables text
  selection outside inputs (by design), so "select text, then Speak" is out;
  speech controls attach to blocks. The page talks to the app through
  `WKScriptMessageHandler` channels (`response`, `upload`, `submit`, `home`,
  `withdraw`, `timer` in `AssessmentViewController`); speech adds channels the
  same way. Math renders through KaTeX; its TeX annotation is stripped (ME-3).

## Options

### Text-to-speech

| Option | For | Against |
|---|---|---|
| **A. `AVSpeechSynthesizer` in the app (recommended)** | Native, offline, no cost; system voices incl. Spanish; `willSpeakRangeOfSpeechString` gives word ranges for highlighting; one engine for content and student responses | Voice quality varies by installed voice; Spanish / enhanced voices may need to be pushed to the fleet (Jamf); math needs a spoken form |
| B. Web Speech `speechSynthesis` in the web view | No bridge | Unreliable in WKWebView on macOS |
| C. Amazon Polly via the server | Best voices; content audio could be generated at publish time and ride the bundle | Network mid-test, cost, latency; student responses cannot be pre-generated, so two engines |
| D. VoiceOver / Spoken Content | Already works under AAC (2026-09-23 sitting) | A screen reader, not OSPI's TTS tool; cannot be granted per student |

### Speech-to-text

| Option | For | Against |
|---|---|---|
| A. macOS dictation | Nothing to build | Not grantable per student, not blockable, and stopped inside AAC today |
| **B. On-device recognition in the app (recommended)** — `SpeechAnalyzer` / `SpeechTranscriber` (macOS 26; fleet floor is 26.4), falling back to `SFSpeechRecognizer` with on-device recognition required | Per-student mic button; audio never leaves the Mac; works with no network | Microphone entitlement + a one-time permission prompt; the language model may need a download before first use (verify); Spanish needs its model too |
| C. Amazon Transcribe streaming via the server | Strong accuracy | Student voice leaves the Mac; network, cost; still needs the microphone |

### Microphone permission (STT option B)

- macOS asks the first time the app requests the microphone, and the app
  decides when that is. **Recommended:** request it only when the student's
  bundle carries `speech_to_text`, after join and **before**
  `AEAssessmentSession.begin()` — a prompt inside a locked session may be
  suppressed (spike S-2 checks).
- Permission is per Mac login, not per student: on 1:1 Macs that is the
  student; on a shared login one student's Allow carries to the next, which
  is harmless because the mic button still appears only for granted students.
- Fallback: prompt every student once at first launch. Simpler timing, but a
  confusing prompt for most students, and a "Don't Allow" can only be undone
  in System Settings — a trap for a student granted STT later.
- To my knowledge MDM (PPPC) can deny but not pre-approve the microphone —
  confirm with IT before relying on either.
- Ships with: `com.apple.security.device.audio-input` in
  `SecureTest.entitlements` **and** `client/expected-entitlements.txt`
  (psd-sign step 2a), `NSMicrophoneUsageDescription` (and
  `NSSpeechRecognitionUsageDescription` if `SFSpeechRecognizer` is used).

## Spikes first (each a real AAC session)

Run in **PoC-A** (`poc-a-aac-capture`, already entitled, the regression
harness), not the shipping client, so nothing half-built rides a release.

- **S-1 TTS inside AAC.** `AVSpeechSynthesizer` speaks an English and a
  Spanish sentence inside a real session; word-range callbacks fire; list the
  voices present on a fleet Mac. Pass = audio + callbacks while locked.
- **S-2 STT inside AAC.** Request the microphone before `begin()`, then
  inside the session: does the mic deliver audio, does `SpeechTranscriber`
  (and `SFSpeechRecognizer` on-device) return text with the network blocked,
  is a model download needed and can it happen before the session? Also: what
  happens if the prompt is first triggered inside the session.
- **S-3 Interaction with macOS dictation.** With in-app recognition running,
  does the dictation key still do anything? If IT ever blocks dictation for
  non-entitled students, does that block the Speech framework too? (Asked of
  IT only if S-2 passes and we want the block.)

## Proposed slices (after the spikes and decisions)

1. **TTS test content (client).** A Speak control on each item stem and each
   stimulus / source, per the `tts_test_content` value (Items / Stimuli /
   both); play / pause / stop, rate, word highlight; one utterance at a
   time; stops on page turn and on session end. Math: spoken form (see D-4).
2. **TTS student responses (client).** "Read my answer" on short text,
   essay and table cells when `tts_student_responses` is on.
3. **STT (client).** Entitlement + usage strings + permission pre-flight
   before `begin()`; a mic button on short text, essay and table cells when
   `speech_to_text` is on; partial results inserted at the caret; autosave
   as for typing; `speech_to_text_language` picks English / Spanish.
4. **Design-tool.** Preview shows the controls a granted student would see;
   help page + quick-start lines; TIDE value mapping already exists.
5. **Hand-run rows + release** (one client release carrying 1–3).

## Decisions (James, 2026-10-01)

- **D-1 = A** `AVSpeechSynthesizer`.
- **D-2 = B** on-device recognition; Amazon Transcribe only if on-device
  accuracy fails S-2.
- **D-3** Microphone prompt only for granted students, before lockdown.
- **D-4 = (b)** a small LaTeX-to-words mapper for v1 — **a gap or failure in
  math speech must not delay the rollout** (unsupported math falls back to
  "math expression").
- **D-5** `tts_for_ela_reading` is treated as TTS (stimulus / passage read
  aloud, construct-altering flag as it exists) and **included** in v1.
- **D-6** Spanish **held** — English first.
- **D-7** **No** dictation block requested from IT.

## Decisions as first written (kept for the record)

- **D-1** TTS engine: A (`AVSpeechSynthesizer`) — recommended.
- **D-2** STT engine: B (on-device) — recommended; C only if on-device
  accuracy fails S-2.
- **D-3** Microphone prompt: only for granted students, before lockdown
  (recommended) vs every student at first launch.
- **D-4** Math in TTS: (a) read KaTeX's MathML through the Speech Rule
  Engine (vendored JS, larger, most complete); (b) a small LaTeX-to-words
  mapper for the subset teachers use; (c) skip math in v1 and say "math
  expression". Recommend (b) for v1.
- **D-5** `tts_for_ela_reading`: treat as "stimulus TTS allowed on ELA
  passages" (the construct-altering flag already exists per assessment), or
  keep it visible but unbuilt in v1.
- **D-6** Spanish (`tts_spanish`, STT Spanish): in v1, or after English
  works? Needs the Spanish voice / model on the fleet either way.
- **D-7** Ask IT for a dictation block for non-entitled students? Today AAC
  appears to stop dictation on its own; revisit after S-3.

## Progress

- **§Progress — slice 1 (TTS test content) BUILT 2026-10-01, not committed,
  rows NOT RUN.** Core: `TextToSpeechScope` (Items → stems, Stimuli →
  passage introductions + sources, Stimuli+Items or any other enabled value →
  both, `tts_for_ela_reading` → sources/passages, off-ish values off),
  `SpeechScript` (segments → the spoken string, word ranges back to segment +
  UTF-16 offset), `SpeechCommand` / `SpeechCallback` (the `tts` channel both
  ways), `MathSpeech` (LaTeX subset → words, whole-expression fallback
  "math expression"). Page: Speak / Pause / Resume / Stop per block, one
  page-wide speed (applies from the next Speak), word highlight via the CSS
  Custom Highlight API (formulas and pictures marked whole), stop on page
  turn, source-tab change and Finish; the math pass keeps each formula's TeX
  on its span as an expando (ME-3's annotation strip unchanged). App:
  `SpeechReader` (default en-US voice) behind the `tts` channel in
  `AssessmentViewController`, refused without the accommodation; stopped on
  hand-in, every session end (`flushPendingInput`), teardown (`retire`) and
  quit. Items (James, 2026-10-01): one Speak reads the stem AND its options —
  MC choices numbered "Choice 1, …" (the page shows no letters), order
  entries in their current on-screen order, match prompts then the options
  once, table header cells (never input cells); short text / essay / drawing
  / hotspot read the stem only; the student's selection or typed answer is
  never read (that is `tts_student_responses`, slice 2).
  Rows: `client/MANUAL-CHECKS.md` "Text-to-speech — test content (slice 1,
  2026-10-01)", none run.
- **§Progress — slice 2 (TTS student responses) BUILT 2026-10-01, not
  committed, rows NOT RUN.** `TextToSpeechScope.responses` from
  `tts_student_responses` (same off-value rule; the host's `tts` refusal
  passes when any of items / stimuli / responses is granted). Page: "Read my
  answer" (the slice-1 bar) under every short text, essay, E12 outline and
  one per table; reads the field's value at the press — `$…$` split by the
  page tokenizer, a value with keypad LaTeX (a command, `^`, `_`) sent whole
  to `MathSpeech`, otherwise plain text (so "$5" is money); an empty field
  says "No answer yet."; a table reads "Row <row>, <column>: <value>." for
  filled cells only. The field (or table) is outlined while read — no word
  highlight, a CSS highlight range cannot reach inside an input. Reading
  never touches the value, the autosave baseline or dirty state, and a
  pointer press keeps focus in the field (the keypad's rule); typing in the
  field being read stops it, as do the slice-1 stops. `MathSpeech` gained
  "λ". Rows: `client/MANUAL-CHECKS.md` "Text-to-speech — student responses
  (slice 2, 2026-10-01)", none run.
- **§Progress — slice 3 (STT) BUILT 2026-10-01, not committed, rows NOT
  RUN.** Pre-flight (PoC-A finding #16): in `AssessmentViewController`'s
  server fetch Task, after the bundle is fetched and BEFORE `onBundleLoaded`
  (which begins lockdown) — only when `SpeechToText.isGranted` — `SpeechPreflight`
  requests the microphone, then speech recognition, checks
  `SpeechTranscriber` (en-US) and installs its assets; capped at 20 s, any
  other outcome than ready proceeds without STT; students without the grant
  skip it, so their begin sequence is unchanged. The result
  (`SpeechToTextPreflight.availability` → `STT_STATE`) builds the page: `ready`
  draws "Speak my answer" under short text, essay and E12 outline (tables not
  in v1); `unavailable` draws a notice. App: `SpeechListener`
  (`SpeechAnalyzer` + `SpeechTranscriber`, `AVAudioEngine` tap → converter,
  the spike's code) behind a new `stt` channel, refused unless ready and
  started only on already-authorized permissions; 60 s cap, 10 s silence
  stop. Core: grant, pre-flight outcome, `DictationTranscript` (volatile shown
  as "Hearing: …", final phrases spaced / capitalised against the caret's
  context), `DictationTimeout`, channel codecs. The page inserts each final
  phrase at the caret and runs the field's own `oninput` (preview, word
  count, autosave as for typing), saves on stop, stops on typing in the
  field, page turn, Finish, read-aloud starting; the host stops on every
  session end, teardown and quit, and stops read-aloud when listening starts.
  Entitlement `com.apple.security.device.audio-input` (via
  `ENABLE_RESOURCE_ACCESS_AUDIO_INPUT`, also in
  `client/expected-entitlements.txt`), both usage strings. The time limit
  counts from the bundle's ARRIVAL, before the pre-flight (James,
  2026-10-01, option b): preparation time comes out of the student's time
  (up to 20 s, in practice only on first use on a Mac), so the client's zero
  matches the server's deadline and the full 30 s write grace stays intact. Rows: `client/MANUAL-CHECKS.md`
  "Speech-to-text (slice 3, 2026-10-01)", none run.

## Follow-ups (from the 2026-10-01 sitting)

- **Highlight words in a student's answer** (James, 2026-10-01). "Read my
  answer" outlines the field but cannot highlight the spoken word: a CSS
  highlight range does not reach inside an `<input>` / `<textarea>`. A
  mirror element laid over the field (same font, padding, wrapping, scroll)
  carrying the highlight would do it. **BUILT 2026-10-01, not committed,
  row "Answer word highlight" NOT RUN** — see §Progress.
- Rows still open: order / match / table options, Stimuli-only, Off, ELA
  reading, keyboard-only, contrast + zoom, every stop path, the prose-dollar
  and fallback math reads, denied / prompt-left-open / asset download on a
  fresh Mac, the time-limit row on a FRESH attempt, and the real-session
  end paths.
- **§Progress — answer word highlight (follow-up) BUILT 2026-10-01, not
  committed, row NOT RUN.** While "Read my answer" reads, a mirror `div`
  (`ttsMirrorFor`) is laid over the field — or over the table cell whose
  value is being spoken — in page coordinates, copying the field's computed
  font, line-height, spacing, text-align, padding, border widths and
  box-sizing, `pre-wrap` for a textarea / `pre` for an input, and its
  scroll; it holds the value as one text node with transparent text,
  `aria-hidden`, `pointer-events: none`, `user-select: text` (the c7848ad
  rule). Each word callback maps the slice-2 segment (now carrying the field
  and its offset into the value) to a Range in that node; a value read whole
  through `MathSpeech` is highlighted whole. The mirror is re-placed on every
  word and on the field's own scroll; in a textarea the field scrolls to
  keep the spoken word in view (single-line inputs are not scrolled). The
  c7848ad `ttsRepaint` toggle runs on the mirror too. Removed on finish,
  Stop and every stop path (typing in the field stops reading). The pager
  gained `z-index: 2` so it covers the mirror. Known limits: inside a
  scrolling column (`side_by_side`) the mirror is not clipped to the column
  and follows a column scroll only at the next word; the mirror's text is
  the value at the press (a keypad insertion mid-read is not followed).
- **§Progress — failure visibility BUILT 2026-10-01, not committed, rows NOT
  RUN.** A failed pre-flight was visible only to the student ("…tell your
  teacher"). Now the client posts one `speech_preflight` attempt event per
  join for a granted student, whatever the outcome — detail
  `{ outcome: ready | denied | timed_out | unavailable, step?: microphone |
  recognition | transcriber | assets }` from
  `SpeechToTextPreflight.eventDetail` (Core, unit-tested: the first step
  that did not answer yes; a permission not granted = `denied`, transcriber
  / assets = `unavailable`, the budget = `timed_out` with no step), through
  the retrying `AttemptEventReporter`; never a transcript or error text.
  Server: client-postable kind + **migration 0049** (kind CHECK); the events
  route keeps only `{ outcome, step }` from closed lists (unknown outcome →
  `unavailable`). Monitor: `speech_to_text_unavailable` on the attendance
  row from the NEWEST pre-flight (a ready rejoin clears it) → grey note
  "Speech-to-text unavailable on this Mac" — a note, not an alert. Timeline:
  "Speech-to-text ready" / "Speech-to-text unavailable — microphone
  permission denied" / "… timed out while preparing" / "… not supported on
  this Mac". The print Integrity line skips the kind (a count cannot say how
  it came out). Usage: `design-tool/infra/README.md` "Speech-to-text
  pre-flight outcomes" (read-only, counts per day / outcome). Rows:
  `client/MANUAL-CHECKS.md` "Speech-to-text (slice 3, 2026-10-01)" (last two)
  and `docs/design-tool-manual-checks.md` 340–344. Ships with the next client
  release; older clients post nothing, so their rows never show the note.
- **Open considerations (James, 2026-10-01)** — speed / voice controls,
  changing speed mid-reading, starting from a chosen point in a passage:
  recorded in `docs/roadmap-2026-09.md` "Speech tools — open
  considerations"; not decisions.

