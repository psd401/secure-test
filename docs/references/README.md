# References

External material used while building this project. Kept here for convenience and to make findings traceable.

## Linked, not committed

- **OSPI, *2025–26 Guidelines on Tools, Supports, and Accommodations* (GTSA)** — the Washington Office of Superintendent of Public Instruction's guidelines on accessibility tools, supports, and accommodations for state assessments. Source of truth for what PSD's secure-testing browser must support for IEP/504 students; it drives `docs/accommodations.md`. Published by OSPI on its state-testing accessibility pages (https://ospi.k12.wa.us — search "Guidelines on Tools, Supports, and Accommodations"); the 2025-08-01 edition is the one the catalog was built from. Until the public release the PDF was committed here; it was removed because a state document is not ours to redistribute, and `design-tool/test/pdf-extract.test.ts` now builds its own multi-page fixture instead of reading it.

## Local-only reference, NOT in this repo

- **`BuildAnEducationalAssessmentApp/`** (gitignored). Apple's official sample project for the AutomaticAssessmentConfiguration framework on macOS. Demonstrates `AEAssessmentSession`, `AEAssessmentConfiguration`, `AEAssessmentParticipantConfiguration`, and the `setConfiguration(_:for:)` allow-by-bundle-ID accommodations pattern. Includes both Swift and Objective-C implementations.

  Canonical URL: https://developer.apple.com/documentation/automaticassessmentconfiguration/build_an_educational_assessment_app

  Key takeaways already extracted into PoC-A's `RESULTS.md` (finding #5 — the macOS API surface):

  1. The entitlement Apple's sample declares is exactly the one we need: `com.apple.developer.automatic-assessment-configuration`.
  2. Sandboxed AAC apps require an additional **temporary-exception**: `com.apple.security.temporary-exception.mach-lookup.global-name` with value `com.apple.assessmentagent`. Apple's sample sets `com.apple.security.app-sandbox = true` together with this mach-lookup exception, and the docs say a sandboxed AAC app cannot otherwise reach the assessment daemon. **Contradicted in practice 2026-08-26**: PoC-A is sandboxed (the "currently unsandboxed" note here described only its pre-`.xcodeproj` build), declares no such exception, and its session began on macOS 26.6.2. Treat the exception as a fallback to add if `begin()` fails, not a prerequisite. See `poc-a-aac-capture/RESULTS.md` finding #9.
  3. The accommodations mechanism is exactly `setConfiguration(_:for:)` with `AEAssessmentApplication(bundleIdentifier:)` for each allowed AT app, paired with a per-app `AEAssessmentParticipantConfiguration` whose only meaningful per-app flag is `allowsNetworkAccess`.
  4. The session lifecycle is: build the config (with all `setConfiguration` calls), `AEAssessmentSession.begin()`, observe via `AEAssessmentSessionDelegate`, and `session.end()` when finished.

  The Apple sample is **not committed** to our repo because: it has its own `.git/`, ships under Apple's own license, and is freely downloadable from the URL above. Anyone who needs it can re-download.
