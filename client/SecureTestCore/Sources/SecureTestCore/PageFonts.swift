import Foundation

/// The PSD brand faces for the assessment page — client UI pass slice A
/// (`docs/client-ui-pass-design.md` §A), built in the shape `KatexBundle`
/// already proved: vendored by a script under `client/scripts/`, checked in,
/// read from the package's resource bundle, and inlined as `data:` URIs.
///
/// Inlining is not a preference. The page is loaded with
/// `loadHTMLString(_:baseURL: nil)` under `font-src data:`, so a `url(...)`
/// pointing anywhere else silently fails and the student reads the fallback.
///
/// The files are the SAME latin-subset variable woff2 the design tool
/// self-hosts (`design-tool/app/fonts/`), so a stem looks the same in the
/// teacher's preview and on the student's screen. Both are SIL OFL 1.1; the
/// licences are vendored beside them.
///
/// Missing resources are not fatal: the faces simply do not load and every
/// rule falls through to the system stack in `--font-body` / `--font-heading`.
public enum PageFonts {
    public struct Assets: Sendable {
        /// `@font-face` rules, ready to inline as a stylesheet.
        public let css: String
        /// Resource names that could not be read. Empty when everything loaded.
        public let missing: [String]

        public var isComplete: Bool { missing.isEmpty }
    }

    /// One face: the family name the tokens name, the vendored file, and the
    /// weight range the variable axis carries.
    struct Face {
        let family: String
        let resource: String
        let weightRange: String
    }

    static let faces = [
        Face(family: "Inter", resource: "inter-latin-var.woff2", weightRange: "100 900"),
        Face(family: "Josefin Sans", resource: "josefin-sans-latin-var.woff2", weightRange: "100 700"),
    ]

    /// Slice B, D-B1 (James, 2026-09-07): the `optional_font`
    /// ("dyslexia-friendly") accommodation is Atkinson Hyperlegible — the
    /// Braille Institute's face, SIL OFL 1.1, vendored from the
    /// `@fontsource/atkinson-hyperlegible` npm package by
    /// `client/scripts/vendor-fonts.mjs`.
    ///
    /// Two static faces rather than one variable file, because that is what
    /// the family ships: regular and bold, each a latin subset. Bold matters —
    /// `<strong>` in a stem, the pager's current-page label and the finish
    /// button all ask for 600/700, and without a bold face the student would
    /// read a synthesised one, which is exactly the letterform ambiguity the
    /// accommodation exists to remove.
    static let optionalFaces = [
        Face(family: "Atkinson Hyperlegible",
             resource: "atkinson-hyperlegible-latin-400.woff2", weightRange: "400"),
        Face(family: "Atkinson Hyperlegible",
             resource: "atkinson-hyperlegible-latin-700.woff2", weightRange: "700"),
    ]

    /// Loaded once per process; ~104 KB of base64 for the two brand faces.
    public static let shared: Assets = load()

    /// The brand pair PLUS Atkinson Hyperlegible; ~150 KB of base64.
    ///
    /// D-B2: this set is inlined ONLY when the student's accommodations select
    /// the optional font. Every other page pays nothing for it, which is why
    /// the two sets are separate constants rather than one always-loaded blob.
    /// The brand faces stay in the document because `--font-body` still names
    /// them as the fallback after 'Atkinson Hyperlegible' — a face that fails
    /// to decode must land on Inter, not on the system stack.
    public static let sharedWithOptionalFont: Assets = load(includeOptionalFont: true)

    /// - Parameter optionalFont: true when the bundle's accommodations select
    ///   `optional_font`; the page shell resolves this from the effective map.
    public static func assets(optionalFont: Bool) -> Assets {
        optionalFont ? sharedWithOptionalFont : shared
    }

    static func load(bundle: Bundle = .module, includeOptionalFont: Bool = false) -> Assets {
        var missing: [String] = []
        var rules: [String] = []
        for face in (includeOptionalFont ? faces + optionalFaces : faces) {
            guard let url = bundle.url(
                    forResource: (face.resource as NSString).deletingPathExtension,
                    withExtension: "woff2",
                    subdirectory: "fonts"),
                  let data = try? Data(contentsOf: url)
            else {
                missing.append("fonts/\(face.resource)")
                continue
            }
            // `swap` rather than `block`: a face that fails to decode must never
            // leave an assessment page blank while a student is waiting.
            rules.append("""
            @font-face {
              font-family: '\(face.family)';
              src: url(data:font/woff2;base64,\(data.base64EncodedString())) format('woff2');
              font-weight: \(face.weightRange);
              font-style: normal;
              font-display: swap;
            }
            """)
        }
        return Assets(css: rules.joined(separator: "\n"), missing: missing)
    }
}
