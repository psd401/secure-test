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

    /// Loaded once per process; ~104 KB of base64 for the two faces.
    public static let shared: Assets = load()

    static func load(bundle: Bundle = .module) -> Assets {
        var missing: [String] = []
        var rules: [String] = []
        for face in faces {
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
