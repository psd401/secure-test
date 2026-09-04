import Foundation

/// The build's identity as a person and a log line see it.
///
/// `PSDBuildCommit` is written into the generated `Info.plist` by the "Stamp
/// build commit" run-script phase (`client/SecureTest.xcodeproj`), so it is
/// present in any build made through Xcode/`xcodebuild` and absent only if
/// that phase was skipped — hence the `unknown` fallbacks rather than a crash.
///
/// Lives in the app target, not `SecureTestCore`, because it reads
/// `Bundle.main`: under `swift test` the main bundle is the test runner's, so
/// there is nothing here the package could meaningfully assert. The
/// observability slice puts `buildStamp` on every error line
/// (`docs/observability-design.md`), which is why it is a stored constant and
/// not built at each call site.
enum AppVersion {
    /// `CFBundleShortVersionString`, i.e. `MARKETING_VERSION` — "1.0.0".
    static let marketing: String =
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"

    /// The short git sha of the checkout the app was built from.
    static let commit: String =
        Bundle.main.infoDictionary?["PSDBuildCommit"] as? String ?? "unknown"

    /// What About shows and what an error line carries: `1.0.0 (a1b2c3d4e5f6)`.
    static let buildStamp = "\(marketing) (\(commit))"
}
