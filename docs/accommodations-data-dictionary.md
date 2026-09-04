# Accommodations Data Dictionary (TIDE ↔ PSD Secure-Test Browser)

Reconciles WA OSPI's TIDE accommodations format with the PSD secure-test browser's session schema (`docs/accommodations.md`). Source of truth for any TIDE-import or TIDE-export pipeline (Slice B and beyond).

## Source files

- `docs/AccommodationData.xlsx` — TIDE student-accommodations **export**. Columns: `Student ID | Subject | Tool Name | Value`. The "Student ID" column carries what PSD calls SSID — TIDE labels it inconsistently across export and upload.
- `docs/StudentSettings.xlsx` — TIDE **upload template**. Columns: `SSID | Subject | Tool Name | Value`. Cascading dropdown validations (Subject → Tool → Value) defined in `Sheet2` via `OFFSET()` formulas.
- Both files share an identical lookup sheet (`Dropdown_Lookup` / `Sheet2`) with 448 rows covering all `(Subject, Tool, Value, TDS_code)` combinations.

## Subjects

TIDE scopes settings per subject. Our model **preserves** this — accommodations are stored per `(student, subject)`, not per student.

| TIDE label | PSD usage |
|---|---|
| `ELA-CAT` | ELA computer-adaptive portion |
| `ELA-PT` | ELA performance task portion |
| `Mathematics` | SBA Math |
| `Science` | WCAS Science |

At session begin, the test runner picks the row matching the test's subject. If a student has no row for a subject, all in-app accommodations default to off and `permissive_mode_apps` is empty.

## Strategy taxonomy (from `accommodations.md`)

- **A** — In-app feature (WKWebView + AppKit).
- **B** — `AEAssessmentConfiguration.setConfiguration(_:for:)` allowing an AT-app bundle ID.
- **C** — `AEAssessmentConfiguration` per-session flag (`allowsSpellCheck`, `allowsAccessibilityReader`, etc.).
- **D** — Out-of-band (paper, human, external device). App displays the tag for TA reference but doesn't act on it.

## Round-trip codes

Every per-student record stores TIDE's internal code (e.g., `TDS_CC1`) alongside the human value. Two reasons:

- Reverse export to `StudentSettings.xlsx` becomes a string lookup, not a re-derivation.
- TIDE occasionally reuses or changes codes for new subjects (see `TDS_BT_UCN` below) — keeping the source code means we don't have to re-encode if OSPI revises the catalog.

Some codes are composite (TIDE uses `&` as the internal separator), e.g. `TDS_Emboss_Stim&TDS_Emboss_Item` for "Stimuli+Items". Store the composite string as-is.

## Mapping tables

Value cells use ` / ` as the canonical separator; the validation script (`scripts/parse-tide-xlsx.py --validate`) expects that. Subject column uses `all` when the tool exists in all 4 subjects; otherwise lists subjects comma-separated.

### Universal Tools

| TIDE Tool | Subject(s) | Value | TDS code | Strategy | Target session-JSON field | Notes |
|---|---|---|---|---|---|---|
| Digital Notepad | ELA-CAT, Mathematics, Science | `Off` / `On` | TDS_SC0 / TDS_SCNotepadHtml | A | `in_app.digital_notepad` | Per-item scratchpad |
| English Glossary | all | `Off` / `On` | TDS_KG0 / TDS_KG1 | A | `in_app.english_glossary` | Pre-tagged term lookup |
| Expandable Items | all | `Off` / `On` | TDS_ExpandableItems0 / TDS_ExpandableItems1 | A | `in_app.expandable_items` | Stim/item split adjustable |
| Expandable Stimuli | all | `Off` / `On` | TDS_ExpandablePassages0 / TDS_ExpandablePassages1 | A | `in_app.expandable_stimuli` | |
| Global Notes | ELA-PT | `Off` / `On` | TDS_GN0 / TDS_GN1 | A | `in_app.global_notes` | Cross-item notes |
| Highlighter | all | `OFF` / `On` | TDS_Highlight0 / TDS_HighlightColors | A | `in_app.highlighter` | TIDE uses uppercase `OFF` here |
| Line Reader | all | `Off` / `On` / `Hybrid Masking Tool` | TDS_LR0 / TDS_LR1 / TDS_LR1&TDS_LR_Enhanced | A | `in_app.line_reader` | Three-state enum |
| Mark for Review | all | `Off` / `On` | TDS_MfR0 / TDS_MfR1 | A | `in_app.mark_for_review` | |
| Strikethrough | all | `Off` / `On` | TDS_ST0 / TDS_ST1&TDS_ST_Enhanced | A | `in_app.strikethrough` | Per-choice MC strike-out |

### Designated Supports

| TIDE Tool | Subject(s) | Value | TDS code | Strategy | Target session-JSON field | Notes |
|---|---|---|---|---|---|---|
| Color Contrast | all | `Black on Rose` / `Black on White` / `Medium Gray on Light Gray` / `Red on White` / `Reverse Contrast` / `White on Red` / `Yellow on Black` / `Yellow on Blue` | TDS_CCMagenta / TDS_CC0 / TDS_CCMedGrayLtGray / TDS_CCRedW / TDS_CCInvert / TDS_CCWhiteR / TDS_CCYellowBlk / TDS_CCYellowB | A | `in_app.color_contrast` | CSS-variable themed; ship all 8 |
| Illustration Glossaries | Mathematics | `Off` / `On` | TDS_KI0 / TDS_KI1 | A | `in_app.illustration_glossaries` | Content-driven (needs per-item data) |
| Language | all | `English` / `Spanish` / `Braille` | ENU / ESN / ENU-Braille | A | `in_app.test_language` | Subject-restricted in TIDE: ELA-CAT/ELA-PT support only English+Braille; Math supports all three; Science supports English+Spanish (no Braille). Non-`TDS_*` codes. |
| Language Display | Mathematics, Science | `Show Spanish above English` / `Switch between Spanish only or English only` | TDS_LD_Stacked / TDS_LD_Toggle | A | `in_app.language_display` | Only meaningful when `test_language=Spanish` |
| Masking | all | `Off` / `On` | TDS_Masking0 / TDS_Masking1 | A | `in_app.masking` | Student-controlled rectangle masks |
| Mouse Pointer | all | `System Default` / `Large Black` / `Large Green` / `Large Red` / `Large White` / `Large Yellow` / `Extra Large Black` / `Extra Large Green` / `Extra Large Red` / `Extra Large White` / `Extra Large Yellow` | TDS_MP_Off / TDS_MP_Black_L / TDS_MP_Green_L / TDS_MP_Red_L / TDS_MP_White_L / TDS_MP_Yellow_L / TDS_MP_Black_XL / TDS_MP_Green_XL / TDS_MP_Red_XL / TDS_MP_White_XL / TDS_MP_Yellow_XL | A | `in_app.mouse_pointer` | Strategy may shift to C post-AAC-entitlement testing |
| Streamline Interface Mode | all | `Off` / `On` | TDS_SLM0 / TDS_SLM1 | A | `in_app.streamlined_layout` | Vertical-stack CSS variant |
| Text-to-Speech (Student Responses) | all | `Off` / `On` | TDS_TTSCR0 / TDS_TTSCR1 | A | `in_app.tts_student_responses` | AVSpeechSynthesizer reads back input |
| Text-to-Speech (Test Content) | all | `None (Default)` / `Items` / `Stimuli` / `Stimuli+Items` | TDS_TTS0 / TDS_TTS_Item / TDS_TTS_Stim / TDS_TTS_Stim&TDS_TTS_Item | A | `in_app.tts_test_content` | Four-state enum, not boolean |
| Translated Glossaries | Mathematics, Science | `None (Default)` / `Arabic` / `Burmese` / `Cantonese` / `Filipino` / `Hmong` / `Korean` / `Mandarin` / `Punjabi` / `Russian` / `Somali` / `Spanish` / `Ukrainian` / `Vietnamese` | TDS_KT0 / TDS_KT_ar / TDS_KT_my / TDS_KT_zh-yue / TDS_KT_tl / TDS_KT_hmn / TDS_KT_ko / TDS_KT_zh-cn / TDS_KT_pa / TDS_KT_ru / TDS_KT_so / TDS_KT_es / TDS_KT_uk / TDS_KT_vi | A | `in_app.translated_glossary_language` | Matches OSPI's 13 languages |
| Zoom Test Level | all | `1X (Default)` / `1.5X` / `1.75X` / `2.5X` / `3X` / `05X (Streamlined Mode Only)` / `10X (Streamlined Mode Only)` / `15X (Streamlined Mode Only)` / `20X (Streamlined Mode Only)` | TDS_PS_L0 / TDS_PS_L1 / TDS_PS_L2 / TDS_PS_L3 / TDS_PS_L4 / TDS_PS_L5 / TDS_PS_L6 / TDS_PS_L7 / TDS_PS_L8 | A | `in_app.zoom_level` | Keep 9 discrete levels — streamlined-only levels require `streamlined_layout=true` |
| Non-Embedded Designated Supports | all | `None (Default)` / `Amplification` / `Bilingual Dictionary` / `Color Overlay` / `Illustration Glossary` / `Magnification Device` / `Medical Supports` / `Noise Buffers` / `Printed test directions in English` / `Read Aloud Items - English` / `Read Aloud Items - Spanish` / `Read Aloud Stimuli - English` / `Read Aloud Stimuli - Spanish` / `Read Aloud Stimuli+Items - English` / `Read Aloud Stimuli+Items - Spanish` / `Scribe Items` / `Separate Setting` / `Simplified Test Directions` / `Translated Test Directions` / `Translated test directions in ASL` | NEDS0 / NEDS_Amplify / NEDS_BD / NEDS_CO / NEDS_TIllustration / NEDS_Mag / NEDS_MedDev / NEDS_NoiseBuf / NEDS_PrintDirs / NEDS_RA_Items / NEDS_RA_Items_ESN / NEDS_RA_Stimuli / NEDS_RA_Stimuli_ESN / NEDS_RA_Stimuli&Items / NEDS_RA_Stimuli&Items_ESN / NEDS_SC_Items / NEDS_SS / NEDS_SimpDirs / NEDS_TransDirs / NEDS_TransDirs_ASL | D | `out_of_band[]` (multi-valued; one tag per row) | Value list is the full union across subjects. TIDE subsets which values are valid per subject (e.g., Bilingual Dictionary is ELA-PT + Science only; Spanish read-aloud variants are Math + Science). The importer validates against the live catalog, not this row. Magnification Device may *also* warrant a Strategy-B Permissive Mode bundle ID — track separately. |

### Accommodations (IEP/504)

| TIDE Tool | Subject(s) | Value | TDS code | Strategy | Target session-JSON field | Notes |
|---|---|---|---|---|---|---|
| 100s Number Table | Mathematics | `Off` / `On` | TDS_NB0 / TDS_NB1 | A | `in_app.number_table_100s` | Static math reference |
| American Sign Language Videos | ELA-CAT, ELA-PT, Mathematics | `Off` / `ON` | TDS_ASL0 / TDS_ASL1 | A | `in_app.asl_videos` | Per-item ASL player; TIDE uses uppercase `ON` for the enabled value |
| Braille Transcriptions | ELA-CAT | `Off` / `On` | TDS_AudioScript0 / TDS_AudioScript1 | D | `out_of_band[] += "braille_transcription"` | Out of MVP scope |
| Braille Type | ELA-CAT, ELA-PT, Mathematics | `No Braille` / `UEB Contracted` / `UEB Contracted with Nemeth Math` / `UEB Contracted with UEB Math` / `UEB Uncontracted` / `UEB Uncontracted with Nemeth Math` / `UEB Uncontracted with UEB Math` | TDS_BT0 / TDS_BT_UCN / TDS_BT_UCN / TDS_BT_UCT / TDS_BT_UXN / TDS_BT_UXN / TDS_BT_UXT | D | `in_app.braille_type` | Captured but app does not implement — Phase 4. Value list is the full union; in TIDE the Nemeth/UEB-Math variants apply to Mathematics only, ELA-CAT/ELA-PT use the four plain values. Codes intentionally reuse: `TDS_BT_UCN` covers both ELA `UEB Contracted` and Math `UEB Contracted with Nemeth Math`. |
| Closed Captioning | ELA-CAT, ELA-PT | `Off` / `On` | TDS_ClosedCap0 / TDS_ClosedCap1 | A | `in_app.closed_captioning` | Caption track for audio stimuli |
| Emboss | ELA-CAT, ELA-PT, Mathematics | `None` / `Stimuli+Items` | TDS_Emboss0 / TDS_Emboss_Stim&TDS_Emboss_Item | D | `out_of_band[] += "emboss"` | Tactile printing; not handled by district browser |
| Multiplication Table | Mathematics | `Off` / `On` | TDS_MP0 / TDS_MP2 | A | `in_app.multiplication_table` | Static math reference |
| **Permissive Mode** | all | `Off` / `On` | TDS_PM0 / TDS_PM1 | **B** | `permissive_mode_apps[]` | Master toggle. When `On`, populate with the student's AT-app bundle IDs from the IEP system. When `Off`, leave array empty. |
| Print on Demand | all | `None (default)` / `Items` / `Stimuli` / `Stimuli+Items` | TDS_PoD0 / TDS_PoD_Item / TDS_PoD_Stim / TDS_PoD_Stim&TDS_PoD_Item | A | `in_app.print_on_demand` | Requires TA-side print endpoint (Phase 2+) |
| Speech-to-Text | all | `Off` / `On` | TDS_Dictation_0 / TDS_Dictation_1 | A | `in_app.speech_to_text` | In-app dictation (built-in). External STT AT apps separately handled via Permissive Mode. |
| Speech-to-Text Language | Mathematics, Science | `English only` / `English & Spanish` | en-us / es-mx&en-us | A | `in_app.speech_to_text_language` | Non-`TDS_*` BCP-47 codes |
| Word Completion | all | `Off` / `On` | TDS_CoWriter0 / TDS_CoWriter1 | A | `in_app.word_completion` | Predictive text in response box; "Word prediction" in OSPI catalog |
| Non-Embedded Accommodations | all | `None (Default)` / `100s Number Table` / `Abacus` / `Alternate Response Options` / `American Sign Language (ASL)` / `Braille Graphics` / `Multiplication Table` / `Paper Pencil Braille` / `Paper Pencil Large Print` / `Paper Pencil Spanish SBA` / `Paper Pencil Spanish WCAS` / `Paper Pencil Standard` / `Read Aloud Stimuli - English` / `Read Aloud Stimuli+Items - English` / `Scribe Full Write` / `Sensory Items` / `Specialized Calculator` / `Speech-to-Text` / `Word Completion` | NEA0 / NEA_NumTbl / NEA_Abacus / NEA_AR / NEA_ASL / NEA_Braille_Graphics / NEA_MT / NEA_Braille / NEA_IEP_LP / NEA_SBA_PNPSpan / NEA_WCAS_PNPSpan / NEA_IEP / NEA_RA_Stimuli / NEA_RA_Stimuli&Items / NEA_SC_WritItems / NEA_SI / NEA_Calc / NEA_STT / NEA_WordPred | D | `out_of_band[]` (multi-valued; one tag per row) | Value list is the full union across subjects. TIDE subsets per subject — e.g. `Abacus` and `Specialized Calculator` are Math + Science only; `Read Aloud Stimuli` variants are ELA-CAT only. The importer validates against the live catalog. The "Speech-to-Text" and "Word Completion" values here are paper-mode alternatives — distinct from the embedded TIDE tools of the same name. Use a tag prefix in `out_of_band` (e.g. `nea:speech_to_text`) to disambiguate. |

## TIDE-only catalog entries (gaps in `accommodations.md`)

`accommodations.md` was missing these. They have been added to its catalog in this commit, classified per the Strategy column above:

- **Braille Type** (Strategy D — captured but not implemented in district browser)
- **Braille Transcriptions** (Strategy D)
- **Emboss** (Strategy D)
- **Language** (Strategy A — test display language toggle)
- **Language Display** (Strategy A — bilingual layout style when `Language=Spanish`)
- **Speech-to-Text Language** (Strategy A)

## Universal-only appendix (in `accommodations.md`, no TIDE column)

These are OSPI universal tools — TIDE doesn't track them per student because they're available to all students. Our app surfaces them unconditionally; the import pipeline does not write to them.

- Breaks
- Desmos Calculator
- Keyboard Navigation
- Optional Font (dyslexia-friendly)
- Periodic Table (Eng/Spanish)
- Scratch Paper (out-of-band)
- Spell Check
- Writing Tools (Bold/Italic/etc.)

## Validation

Run `python3 docs/scripts/parse-tide-xlsx.py --validate` to confirm every `(Subject, Tool, Value)` triple in `AccommodationData.xlsx` is mapped to a row above. The script:

- Parses dictionary tables that contain a `Value` column header.
- Expands `Subject(s)` cells using aliases (`all` → 4 subjects; `Math` → `Mathematics`).
- Splits `Value` cells on ` / ` and strips backticks.
- Fails loudly with the missing triples; passes silently with a count.

## Open questions

- 2.1 Mouse Pointer strategy A vs C — confirm post-AAC-entitlement.
- 2.2 Non-Embedded *categories* are TIDE's way of catching out-of-band tools. Should our `out_of_band[]` tags use TIDE's NEA/NEDS prefix (`nea:specialized_calculator`) or strategy-neutral PSD tags (`specialized_calculator`)? Recommended: keep TIDE prefix for round-trip determinism.
- 2.3 When TIDE export lists both `Permissive Mode = On` and a `Non-Embedded Designated Supports = Magnification Device`, should the import pipeline auto-populate `permissive_mode_apps` with ZoomText bundle ID, or leave that as a manual step in the editor?
