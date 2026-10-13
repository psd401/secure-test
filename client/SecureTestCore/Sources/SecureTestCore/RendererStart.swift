import Foundation

// Server-delivered renderer slice 4c (docs/server-delivered-renderer-design.md
// D-6, D-11): the decision the app makes between the bundle's arrival and
// `onBundleLoaded` (which begins lockdown) — load the served renderer, fall
// back to the bundled page (Debug only), or refuse the join. Pure, so the
// AppKit wiring that cannot be tested headless only calls it.

public enum RendererStart {
    /// What to do with the bundle's `renderer` field before begin().
    public enum Plan: Equatable, Sendable {
        /// The bundle names a renderer: fetch / verify it.
        case load(RendererRef)
        /// No field, Debug build: the bundled page (local dev servers do not
        /// set `RENDERER_DELIVERY`).
        case bundledFallback
        /// No field, Release build: refuse (D-11 — v2.0 requires the field).
        case refuseMissing
    }

    /// Where the test page's code came from, or why there is no page.
    public enum Outcome: Equatable, Sendable {
        case served(LoadedRenderer)
        case bundled
        case refused(Refusal)
    }

    public enum Refusal: Equatable, Sendable {
        /// Release, and the bundle named no renderer.
        case missing
        /// The loader failed (unavailable, refused by the verifier, integrity).
        case failed(RendererLoadFailure)

        /// True only when a newer app could run the renderer — the "update
        /// SecureTest in Self Service" sheet. Every other refusal is "try
        /// again".
        public var needsUpdate: Bool {
            if case .failed(let failure) = self { return failure.studentShouldUpdate }
            return false
        }

        /// The sheet's bold line.
        public var sheetMessage: String { JoinErrorCopy.rendererLoadFailedMessage }

        /// The sheet's second line.
        public var sheetInformative: String {
            if needsUpdate { return JoinErrorCopy.message(forCode: "client_update_required") }
            // A bundle with no renderer is a server configuration problem
            // (James, 2026-10-13): retrying will not help, so the student is
            // sent to the teacher rather than told to check the connection.
            if case .missing = self { return JoinErrorCopy.rendererMissingInformative }
            return JoinErrorCopy.rendererLoadFailedInformative
        }

        /// stderr / errors.log text. Ids, versions and reasons only.
        public var logLine: String {
            switch self {
            case .missing: return "renderer missing: the bundle names no renderer and this build has no fallback"
            case .failed(let failure): return failure.logLine
            }
        }

        /// A short stable token for the error context (`reason`).
        public var reason: String {
            switch self {
            case .missing: return "missing"
            case .failed(.unavailable): return "unavailable"
            case .failed(.refused): return needsUpdate ? "update_needed" : "refused"
            case .failed(.integrity): return "integrity"
            }
        }
    }

    public static func plan(for ref: RendererRef?, allowsBundledFallback: Bool) -> Plan {
        if let ref { return .load(ref) }
        return allowsBundledFallback ? .bundledFallback : .refuseMissing
    }

    /// The public keys a build trusts: the release keys always, the dev key
    /// only when the caller is a Debug build.
    public static func trustedKeys(includeDevKey: Bool) -> [String] {
        RendererKeys.releaseKeys + (includeDevKey ? [RendererKeys.devKey] : [])
    }

    /// Plan, then (for `.load`) run `load` and map its result. `load` is the
    /// app's `RendererLoader.load` call with the fetcher, cache, keys and
    /// policy bound; tests pass a fake.
    public static func resolve(
        ref: RendererRef?,
        allowsBundledFallback: Bool,
        load: (RendererRef) async -> Result<LoadedRenderer, RendererLoadFailure>
    ) async -> Outcome {
        switch plan(for: ref, allowsBundledFallback: allowsBundledFallback) {
        case .bundledFallback:
            return .bundled
        case .refuseMissing:
            return .refused(.missing)
        case .load(let ref):
            switch await load(ref) {
            case .success(let loaded): return .served(loaded)
            case .failure(let failure): return .refused(.failed(failure))
            }
        }
    }

    /// The one line per test start: `renderer: served v<version> <sha12>`,
    /// `renderer: from cache v<version> <sha12>`, or
    /// `renderer: bundled (Debug fallback)`.
    public static func logLine(for loaded: LoadedRenderer?) -> String {
        guard let loaded else { return "renderer: bundled (Debug fallback)" }
        let source = loaded.fromCache ? "from cache" : "served"
        return "renderer: \(source) v\(loaded.ref.version) \(loaded.ref.sha256.prefix(12))"
    }
}
