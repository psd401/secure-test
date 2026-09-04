# Accommodations Catalog (PSD Secure-Test Browser)

Mapping from OSPI's *2025–26 Guidelines on Tools, Supports, and Accommodations* (GTSA) to a macOS implementation strategy for PSD's district-built secure-testing browser.

**Source**: OSPI, *2025–26 Guidelines on Tools, Supports, and Accommodations* (66 pages, published 2025-08-01) — linked from `docs/references/README.md`, not committed.

**Audience**: anyone building the test app, the teacher monitor, or the per-student accommodation lookup. **Not** an OSPI compliance document — for state assessments, use OSPI's TDS. This catalog only governs what PSD's own browser must support so students who are accommodated on state tests get equivalent treatment on PSD-administered tests.

**Companion**: `docs/accommodations-data-dictionary.md` maps every TIDE (Subject, Tool, Value) triple to its strategy + target field in the session JSON. Use it as the source of truth when importing/exporting student accommodations against TIDE.

## OSPI's three-tier framework

- **Universal Tools** — available to **all** students.
- **Designated Supports** — available to a student when their educator team decides (with parent and student input). No IEP/504 required.
- **Accommodations** — available only with a documented IEP or 504 plan.

Each tier has **embedded** features (inside the test delivery system) and **non-embedded** features (paper, external devices, human assistance, or external AT apps).

## Implementation strategy taxonomy

Every entry below maps to one of these four strategies. The strategy is the *how*; OSPI's category is the *what*.

| Strategy | Mechanism | What it covers |
|---|---|---|
| **A. In-app feature** | Built into the WKWebView UI or the AppKit shell. | Highlighting, masking, color contrast, in-app TTS, glossaries, calculators, reference tables, mark-for-review, item zoom, etc. |
| **B. AAC `setConfiguration(_:for:)`** | At session start, allow specific assistive-tech app bundle IDs. This is the macOS analog of OSPI's "Permissive Mode" accommodation. | External AT apps that must keep working alongside the test — Read & Write, Co:Writer, JAWS-style screen readers, switch-control apps, magnification apps. |
| **C. AAC `AEAssessmentConfiguration` flag** | Set a per-session AAC property: `allowsSpellCheck` / `autocorrectMode` / `allowsKeyboardShortcuts` / `allowsPredictiveKeyboard` (macOS 15+), plus `allowsAccessibilityReader` / `allowsAccessibilityLiveCaptions` / `allowsAccessibilityKeyboard` (macOS 26.1+). | Loosening specific OS-level restrictions for an accommodated student. |
| **D. Out-of-band** | Paper / human / external device. Not handled by the app. | Color overlays, bilingual paper dictionaries, scribes, oral test administration, FM-system amplification, etc. |

Many accommodations layer two strategies (e.g., **B + C**: allow JAWS to run AND set `allowsAccessibilityReader = true`).

## Implementation tiers (what ships when)

The strategy taxonomy describes the *mechanism* per accommodation; the tier list below describes *prioritization* — which tools the district browser will actually render in which phase. Tools without a tier are out-of-band only (captured on the per-student record and surfaced to the TA, but the app does not act on them).

### Tier 1 — Phase 1 MVP (CSS/HTML only, no external blockers)

Self-contained, content-agnostic, no AAC dependencies. Works identically on free-form district assessments and state-aligned tests.

- **Color Contrast** — 8 CSS-variable themes
- **Optional Font** — bundled dyslexia-friendly font (e.g., OpenDyslexic) + CSS swap
- **Zoom Test Level** — CSS transform; 5 standard levels (Streamlined-only levels gate on Tier 1 Streamline shipping in the same phase)
- **Streamline Interface Mode** — CSS vertical-stack layout variant
- **Highlighter** — text selection + color marking via WKWebView native APIs
- **Strikethrough** — per-choice strike toggle in MC UI
- **Mark for Review** — per-item flag in nav state (already partially modeled in PoC-B)
- **Masking / Hybrid Masking** — DOM overlay rectangles, student-controlled
- **Line Reader** — single-line highlight follow-cursor
- **Expandable Items / Stimuli** — responsive layout, stimulus/item split adjustable

### Tier 2 — Phase 2 (real engineering work; no external blockers)

- **TTS Test Content** + **TTS Student Responses** — `AVSpeechSynthesizer`; four-state enum for test content (none / items / stimuli / stimuli+items). Needs Spanish voice pack via Jamf.
- **Digital Notepad** + **Global Notes** — per-item / cross-item scratchpads
- **Mouse Pointer** — in-app cursor replacement if AAC won't honor system pointer changes (verify post-entitlement)
- **Word Completion** — predictive text in response box (built-in autocomplete)
- **100s Number Table** / **Multiplication Table** — static math reference panels
- **Desmos Calculator** — embed via WKWebView (terms permitting) or build minimal arithmetic

### Tier 3 — Phase 3 (content-driven OR depends on teacher-monitor)

- **English Glossary** — needs teacher-authored glossary data per item
- **Translated Glossaries** — 13 languages × per-item glossary data; large authoring lift
- **Illustration Glossaries** — illustrations per term per item
- **Closed Captioning** — caption tracks for audio stimuli (only matters once audio stimuli exist)
- **Speech-to-Text (in-app)** — macOS dictation behind a response-box UI
- **Print on Demand** — needs TA-side print endpoint in the teacher monitor

### Tier 4 — Distant (external blockers or low-realism for district scope)

- **Permissive Mode** + **AAC flags (Strategy C)** — blocked on AAC entitlement *and* AT app bundle-ID inventory. Most-important OSPI accommodation by GTSA-text count, but currently unactionable.
- **Test display Language (English/Spanish/Braille)** + **Language Display** — needs Spanish-authored items or auto-translation; product question, not just engineering.
- **ASL Videos** — needs signed-video content per item
- **All Braille variants** (Braille Type, Transcriptions, Emboss) — Phase 4; hardware integration

### Out-of-band only (captured, never acted on by the app)

Everything under TIDE's **Non-Embedded Accommodations** and **Non-Embedded Designated Supports** categories — scribe, separate setting, sensory items, paper-mode alternatives, magnification device (hardware), medical supports, etc. Stored on the per-student record and surfaced to the TA as a tag list. Round-trip preserved via the `nea:`/`neds:` tag prefix (see `accommodations-data-dictionary.md`).

### Picker scope decision

The assessment-level **allowed-accommodations picker** in the design tool surfaces all OSPI tools regardless of tier or subject — teachers may opt in to forward-compatible tools the browser doesn't render yet (no-op at runtime; metadata preserved). This trades minor authoring clutter for forward compatibility; debt to back out later is near-zero (add a filter prop to the picker).

## Cross-cutting requirement: "Permissive Mode" equivalence

OSPI's **"Permissive Mode"** is an embedded accommodation (GTSA p. 35) defined as:

> "Allows accessibility software/devices to be used with the secure browser. Assistive technology devices are permitted to make notes. … Access to internet must be disabled on assistive technology devices."

This is **exactly** what AAC's `setConfiguration(_:for:)` mechanism provides on macOS: register an `AEAssessmentApplication(bundleIdentifier:teamIdentifier:)` for each allowed AT app, with a per-app `AEAssessmentParticipantConfiguration` whose `allowsNetworkAccess = false` (mirroring OSPI's no-internet requirement). Set `requiresSignatureValidation = true` so a user can't rename a non-AT binary to match a permitted bundle ID.

**Treat Permissive Mode as the primary accommodations interface in the MVP.** Per-student data only needs to express which AT apps they're permitted to use; the app does the rest.

## Catalog

### Universal Tools (available to all students)

| OSPI tool | Embedded? | Strategy | Notes |
|---|---|---|---|
| Breaks | E | A | Test-app pause logic. Already implicit in MVP item-by-item delivery. |
| Desmos Calculator | E | A | Embed Desmos via WKWebView (terms permitting) or build/license a calculator. For ad-hoc tests, likely build minimal arithmetic calculator. |
| Digital notepad | E | A | Per-item scratchpad; localStorage equivalent (but per-item, cleared on next item or after long break). |
| English dictionary | E | A | In-app dictionary lookup for designated items. |
| English glossary | E | A | Pre-tagged term lookup in item content. |
| Expandable items/stimuli | E | A | Layout responsiveness; stimulus/item split adjustable. |
| Global notes | E | A | Cross-item notes carried within a session segment. |
| Highlighter | E | A | Text selection + color marking in WKWebView. |
| Keyboard navigation | E | A + C | Tab order, focus management. Note: `allowsKeyboardShortcuts` (macOS 15+) must be set if standard system shortcuts are expected to work. |
| Line reader | E | A | Single-line highlight follow-cursor. |
| Mark for review | E | A | Per-item flag; rendered in nav UI. |
| Optional Font | E | A | Switch to dyslexia-friendly font (OpenDyslexic or similar). |
| Periodic table (Eng/Spanish) | E | A | Static reference for science items. |
| Spell check | E | A + C | WKWebView's `spellcheck` attribute is off by default in our hardened mode; for items where it's allowed, opt in per item *and* set `allowsSpellCheck = true` (macOS 15+) on the session. |
| Strikethrough | E | A | Per-choice strike-out in MC items. |
| Writing tools (Bold/Italic/etc.) | E | A | Constructed-response WYSIWYG; baseline contenteditable. |
| Zoom (in-app) | E | A | CSS-driven zoom on item content. |
| Scratch paper | N | D | Physical paper provided by test admin. |

### Designated Supports (educator-decided)

| OSPI support | Embedded? | Strategy | Notes |
|---|---|---|---|
| Color contrast | E | A | In-app theme picker (background/text color combinations from OSPI's defined options: Red/White, White/Red, Yellow/Black, etc.). CSS variables drive it. |
| Hybrid masking tool | E | A | Line reader + mask the rest of the page. |
| Illustration glossaries | E | A | Per-item illustrated tooltips for ML support. Content-driven — needs glossary data per item. |
| Masking | E | A | Student-controlled rectangle masks over arbitrary screen regions. |
| Mouse pointer (size/color) | E | A or C | macOS provides system mouse-pointer settings. AAC may or may not honor in-session changes — verify post-entitlement. If it doesn't, in-app cursor is a fallback (replace cursor with a div that follows mousemove). |
| Streamlined Interface Mode | E | A | Vertical-stack layout variant. CSS media-feature toggle. |
| Text-to-speech (test content) | E | A | macOS's `AVSpeechSynthesizer` is the cheapest path. Multiple voices per language (English, Spanish per Table 3). Needs voice packs installed system-wide — Jamf can manage. |
| Text-to-speech (student responses) | E | A | Same engine; reads back what the student typed. |
| Translated glossaries | E | A | Per-item glossary lookup in 13 languages (Arabic, Burmese, Cantonese, Filipino, Hmong, Korean, Mandarin, Punjabi, Russian, Somali, Spanish, Ukrainian, Vietnamese). Content-driven. |
| Translated test directions (Spanish) | E | A | Localized item-rendering chrome. |
| Language (test display) | E | A | TIDE: `Language` — `English` / `Spanish` / `Braille`. Subject-restricted in TIDE; see data dictionary. Toggles the test's display language. |
| Language Display (bilingual layout) | E | A | TIDE: `Language Display` — `Show Spanish above English` / `Switch between Spanish only or English only`. Only meaningful when `Language = Spanish`. Math + Science only in TIDE. |
| Amplification | N | D + (possibly) B | External FM/headphone. Test app needs to support audio output and not interfere. AAC has no special hook here. |
| Bilingual dictionary | N | D | Paper word-to-word dictionary. |
| Color overlays | N | D | Physical transparencies. |
| Illustration glossaries (paper) | N | D | Test-admin-distributed paper supplement; OSPI ships these on request. |
| Magnification device | N | B (preferred) + D | If a software magnifier (Zoom, ZoomText) is used, allow via `setConfiguration(_:for:)`. macOS's built-in Zoom is system-wide; AAC interaction unknown. Hardware magnifiers are out-of-band. |
| Medical supports | N | D + B | A medical device with cell-phone capability may need to be allowed (e.g., CGM apps). If on the same Mac, register via `setConfiguration(_:for:)` with `allowsNetworkAccess = false` per OSPI. |
| Noise buffers | N | D | Physical earmuffs / white noise device. |
| Read aloud | N | D | Human reader provides oral presentation. |
| Scribe | N | D | Human writes student's spoken answers. |
| Separate setting | N | D | Different physical room; test-app behavior unchanged. |
| Simplified test directions | N | D | TA reads/clarifies; app behavior unchanged. |

### Accommodations (IEP/504-documented)

| OSPI accommodation | Embedded? | Strategy | Notes |
|---|---|---|---|
| 100s Number Table | E | A | Static reference table for math. |
| American Sign Language (ASL) | E | A | Per-item ASL video player. Content-driven (need signed videos). |
| Braille | E | D | Refreshable braille display or paper. Out of scope for district-tests Phase 1; revisit Phase 4 if needed. |
| Braille Type (UEB / Nemeth variants) | E | D | TIDE: `Braille Type` — 7-value enum spanning `No Braille`, `UEB Contracted/Uncontracted`, and Math-specific Nemeth/UEB-Math variants. Captured by import; not rendered by district browser in Phase 1. |
| Braille Transcriptions | E | D | TIDE: `Braille Transcriptions` Off/On. ELA-CAT only. Audio-script availability for braille users. Out of scope for district browser. |
| Emboss | E | D | TIDE: `Emboss` — `None` / `Stimuli+Items`. Tactile-print of test materials. Captured for round-trip; not rendered by district browser. |
| Speech-to-Text (in-app dictation) | E | A | TIDE: `Speech-to-Text` Off/On (all subjects), with `Speech-to-Text Language` `English only` / `English & Spanish` for Math + Science. Built-in macOS dictation; external STT AT apps handled separately via Permissive Mode. |
| Closed captioning | E | A | Caption track for audio stimuli. |
| Multiplication Table | E | A | Static reference table for math. |
| **Permissive Mode** | E | **B** | **The primary mechanism for AT apps.** See "Cross-cutting requirement" above. |
| Print on demand | E | A | TA prints individual items from the TA interface; student writes on paper. Requires a TA-side print endpoint in the teacher monitor. |
| Streamlined Interface Mode | (also accommodation) | A | Same as designated-support entry. |
| Text-to-speech for ELA reading | E | A | Read-aloud for content normally not allowed to be read aloud (reading test items). Special case — content-construct-altering accommodation. |
| Text-to-speech in Spanish | E | A | Same as designated, but as an accommodation in some contexts. |
| Word completion (formerly Word prediction) | E | A | Predictive text in the response box. Built-in, not AAC. |
| Calculator on non-calc items | N | D | Hardware calculator; out-of-band per OSPI. |
| Scribe | N | D | Same as designated. |
| Math/science TTS in Spanish | E | A | Same engine; language selection. |
| Sensory Items | N | D | New for 2025-26; manipulables/sensory tools provided physically. |

## Assistive-tech apps PSD will likely need to allow

These are the AT apps PSD students likely use under "Permissive Mode" / IEP-documented accommodations. The bundle IDs and team IDs are **not yet confirmed** — they need verification from a real installation. This is the open data-collection task.

| App | Vendor | macOS Bundle ID (TBD) | Apple Team ID (TBD) | Used for |
|---|---|---|---|---|
| Read & Write | Texthelp | `com.texthelp.ReadWriteGoldOSX` (verify) | Texthelp Limited | TTS, dictionary, word prediction, screenshot reader |
| Co:Writer Universal | Don Johnston | `com.donjohnston.CoWriterUniversal` (verify) | Don Johnston Inc. | Word prediction, topic dictionaries |
| Snap & Read | Don Johnston | `com.donjohnston.SnapAndRead` (verify) | Don Johnston Inc. | TTS, leveling, OCR |
| Equatio | Texthelp | `com.texthelp.Equatio` (verify) | Texthelp Limited | Math input, equation TTS |
| JAWS for Mac | Freedom Scientific | n/a — no current macOS JAWS | — | Screen reader (Windows only; macOS uses VoiceOver) |
| ZoomText for Mac | Freedom Scientific | n/a — discontinued; macOS uses built-in Zoom | — | Magnifier |
| VoiceOver | Apple (built-in) | `com.apple.VoiceOver` | Apple | Screen reader |
| Zoom (system) | Apple (built-in) | n/a (system-level, not an app bundle) | Apple | Magnification |
| Switch Control | Apple (built-in) | n/a (system-level) | Apple | Switch input |
| Speak Selection / Speak Screen | Apple (built-in) | n/a (system-level) | Apple | TTS |

**Open question**: macOS built-in accessibility features (VoiceOver, Zoom, Switch Control, Speak Selection) are **system-level**, not separate app bundles. AAC's relationship to them is partially exposed through the `allowsAccessibility*` flags introduced in macOS 26.1, but pre-26.1 behavior is unclear. We need to test post-entitlement whether VoiceOver remains usable inside an active assessment session by default, and whether the macOS 26.1+ flags actually toggle it.

**Next steps for AT bundle IDs**:
1. Inventory which AT apps PSD's special-education department actually deploys (Read & Write is near-certain; check Co:Writer, Snap & Read).
2. For each, install on a test Mac, find the bundle ID via `mdls -name kMDItemCFBundleIdentifier /Applications/<App>.app`, and find the team ID via `codesign -dv /Applications/<App>.app` (or `codesign -d --verbose=4 ...`).
3. Add the verified IDs back to the table above and commit.

## What gets encoded in the per-session accommodations data

Records are per `(student, subject)` because TIDE scopes settings that way and the secure-test browser is invoked per-test. At session begin, the runner picks the record matching the test's subject (`ELA-CAT`, `ELA-PT`, `Mathematics`, `Science`).

Recommended shape (one record):

```json
{
  "student_sourcedid": "...",
  "subject": "Mathematics",
  "accommodations": {
    "in_app": {
      "color_contrast": "yellow_on_black",
      "font": "default",
      "tts_test_content": "stimuli_and_items",
      "tts_student_responses": true,
      "translated_glossary_language": "es",
      "test_language": "english",
      "language_display": null,
      "speech_to_text": true,
      "speech_to_text_language": "english_only",
      "streamlined_layout": true,
      "zoom_level": "1.5x",
      "extended_time_factor": 2.0
    },
    "aac_flags": {
      "allows_spell_check": false,
      "autocorrect_mode": [],
      "allows_keyboard_shortcuts": true,
      "allows_accessibility_reader": true,
      "allows_accessibility_live_captions": false
    },
    "permissive_mode_apps": [
      { "bundle_id": "com.texthelp.ReadWriteGoldOSX", "team_id": "..." },
      { "bundle_id": "com.donjohnston.CoWriterUniversal", "team_id": "..." }
    ],
    "out_of_band": ["neds:separate_setting", "nea:specialized_calculator"],
    "tide_codes": {
      "color_contrast": "TDS_CCYellowBlk",
      "tts_test_content": "TDS_TTS_Stim&TDS_TTS_Item",
      "translated_glossary_language": "TDS_KT_es",
      "test_language": "ENU",
      "speech_to_text": "TDS_Dictation_1",
      "speech_to_text_language": "en-us",
      "streamlined_layout": "TDS_SLM1",
      "zoom_level": "TDS_PS_L1",
      "permissive_mode": "TDS_PM1"
    }
  }
}
```

The four strategy objects map 1:1 to Strategies A / C / B / D. `tide_codes` is the round-trip ledger — it stores TIDE's internal code per accommodation so the reverse export to `StudentSettings.xlsx` is deterministic without re-deriving codes. Schema decisions:

- `in_app` flags drive the WKWebView item-rendering chrome and the AppKit menus. Enum values follow TIDE's vocabulary (snake-cased): all 8 `color_contrast` themes; 9 discrete `zoom_level` values (`1x`, `1.5x`, `1.75x`, `2.5x`, `3x`, and four streamlined-only multipliers that require `streamlined_layout: true`); `tts_test_content` is a four-state enum (`none` / `items` / `stimuli` / `stimuli_and_items`), not a boolean.
- `aac_flags` are passed directly to `AEAssessmentConfiguration` properties at session begin.
- `permissive_mode_apps` becomes a series of `setConfiguration(_:for:)` calls at session begin. Populate only when TIDE `Permissive Mode = On` — see `accommodations-data-dictionary.md` for the disambiguation rule when Magnification Device or Medical Supports are also listed.
- `out_of_band` is multi-valued; one tag per TIDE row. Tags carry the TIDE category prefix (`nea:` for Non-Embedded Accommodations, `neds:` for Non-Embedded Designated Supports) to avoid collisions and ease round-trip.
- See the full TIDE ↔ field mapping in `docs/accommodations-data-dictionary.md`.

## Open questions

1. **Source of truth for accommodations data**: IEP system, PSD SIS, or a manual entry at session-create time? (Plan unresolved-question 6.8.) Tonight's catalog work suggests the data structure shape; the source of truth is still open.
2. **Coverage**: which accommodations does PSD's district-test program prioritize for MVP vs. Phase 3? The full catalog is large; a phased rollout is probably right.
3. **AT app bundle IDs**: need physical confirmation per AT app PSD deploys (see "Next steps" above).
4. **Pre-macOS-26.1 behavior of system accessibility**: are VoiceOver / Zoom / Switch Control usable inside an AAC session on older macOS? Test post-entitlement.
5. **Spanish text-to-speech**: requires a Spanish voice pack installed system-wide. Jamf can manage this — needs a small ops project to ensure all assessment-eligible Macs have it.
6. **Print on Demand**: requires a TA-side print endpoint. Out of MVP scope; revisit at Phase 2 when teacher monitor exists.
7. **OSPI revisions**: this catalog references the 2025–26 edition. OSPI publishes annually; the catalog needs an annual review.
