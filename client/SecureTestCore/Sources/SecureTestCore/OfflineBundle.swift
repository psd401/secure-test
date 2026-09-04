import Foundation

/// The offline bundle path: a delivery bundle read from disk, with no server,
/// no attempt, no lockdown and no event reporting — it exists so the renderer
/// can be looked at in this environment (slice 53/66). Two ways in:
///
/// - `--bundle <path>` on the command line (slice 66). Inside the sandbox
///   (added with Google sign-in) an argv path is readable ONLY from the app's
///   own container — `files.user-selected.read-only` covers open-panel picks,
///   not paths typed on a command line — which is the workaround MANUAL-CHECKS
///   documented on 2026-08-27.
/// - File → Open Test Bundle… (the slice this file lands in), an NSOpenPanel
///   whose pick the entitlement DOES cover. The panel itself is AppKit and
///   hand-run; everything here is what it hands the panel and what it does
///   with the pick.
///
/// The rules below are the app target's, pulled out so `swift test` pins them.
public enum OfflineBundle {
    /// The one file type the open panel offers. A delivery bundle is JSON on
    /// the wire (`DeliveryBundleSchema`); nothing else is a bundle.
    public static let fileExtension = "json"

    /// The path after `--bundle`, or nil when the flag is absent or dangling.
    /// First occurrence wins, matching how the app has always read it.
    public static func argumentPath(in arguments: [String]) -> String? {
        guard let flag = arguments.firstIndex(of: "--bundle"),
              arguments.indices.contains(flag + 1) else {
            return nil
        }
        return arguments[flag + 1]
    }

    /// What the window is showing, as far as the open command cares.
    public enum Screen: Equatable, Sendable {
        /// The join/sign-in screen — nothing is in progress.
        case entry
        /// A bundle opened offline. Opening another one just replaces it.
        case offlineBundle
        /// A server-delivered attempt is on screen — joined, possibly locked
        /// down, possibly already handed in. Nothing may replace it.
        case serverAttempt
    }

    /// File → Open is disabled for the whole life of a server-delivered
    /// attempt on screen, handed in or not: replacing the view would drop the
    /// attempt's event reporter and its spool mid-flight, and inside a real
    /// session it would put a filesystem browser in front of a student. The
    /// menu item is pinned by `isEnabled` from this — AppKit's autoenabling is
    /// off for it, the same posture as the clipboard items (slice 69).
    public static func canOpen(on screen: Screen) -> Bool {
        screen != .serverAttempt
    }

    /// A bundle that decoded, with the ORIGINAL text kept alongside: the page
    /// is handed those bytes, not a re-encoding, so a field this build does
    /// not know about survives the trip (slice 53's rule).
    public struct Loaded {
        public let bundle: DeliveryBundle
        public let json: String
    }

    public enum LoadError: Error, Equatable {
        /// The bytes are not UTF-8 text — a binary or mis-encoded pick.
        case notText
    }

    /// Decode first to prove the bytes are sound, then keep them verbatim. A
    /// decode failure means client/design-tool version skew and propagates as
    /// `DecodingError` — the caller refuses rather than renders a partial test.
    public static func load(_ data: Data) throws -> Loaded {
        guard let json = String(data: data, encoding: .utf8) else {
            throw LoadError.notText
        }
        let bundle = try DeliveryBundle.decode(from: data)
        return Loaded(bundle: bundle, json: json)
    }
}
