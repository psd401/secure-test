import Foundation

/// Where a configured value came from. Carried alongside every resolved value
/// so the app can say so in one stderr line at launch — which is the whole
/// diagnostic when a district Mac comes up unconfigured.
public enum ConfigurationSource: String, Equatable, Sendable {
    case launchArgument
    case environment
    case managedPreference
    case none

    /// The words that go in the log line.
    public var description: String {
        switch self {
        case .launchArgument: return "launch argument"
        case .environment: return "environment"
        case .managedPreference: return "managed preference"
        case .none: return "nowhere"
        }
    }
}

/// A value that was supplied but could not be used — today only a server URL
/// string that is not an http(s) URL. Kept so the launch log can name the
/// source rather than silently reporting "not configured".
public struct InvalidConfigurationValue: Equatable, Sendable {
    public let raw: String
    public let source: ConfigurationSource

    public init(raw: String, source: ConfigurationSource) {
        self.raw = raw
        self.source = source
    }
}

/// The two things the app cannot run without: which server to talk to, and the
/// Google client id to sign in with. Resolved once at launch from three places,
/// in this order:
///
/// 1. launch arguments — `--server <url>`, `--google-client-id <id>`
/// 2. the environment — `SECURE_TEST_SERVER`, `SECURE_TEST_GOOGLE_CLIENT_ID`
/// 3. managed preferences — the `ServerURL` and `GoogleClientID` keys under
///    the app's own preference domain (`net.psd401.securetest.client`), which
///    is how an MDM configuration profile reaches a sandboxed app: a `Forced`
///    payload surfaces through `UserDefaults.standard` like any other default.
///
/// An empty string counts as unset at every level, so a profile that ships a
/// blank key does not shadow the environment. A server URL string that is not
/// an http(s) URL is treated as unset too, and reported (`invalidServerURL`) so
/// the typo is visible in the log instead of becoming a silent "not
/// configured".
///
/// **There is no localhost fallback.** Earlier builds defaulted the server to
/// `http://localhost:3000`, which on a district Mac means the app quietly talks
/// to nothing at all and the entry card comes up blank (the v1.2.0 field
/// report, 2026-09-11). Unconfigured is now a state the app names to the
/// student. The dev launcher (`client/scripts/launch-client.ts`) always sets
/// `SECURE_TEST_SERVER`, so the development posture is unchanged.
public struct ClientConfiguration: Equatable, Sendable {
    public let serverURL: URL?
    public let serverURLSource: ConfigurationSource
    public let invalidServerURL: InvalidConfigurationValue?
    public let googleClientID: String?
    public let googleClientIDSource: ConfigurationSource

    /// The managed-preference (and `defaults write`) key for the server origin.
    public static let serverURLDefaultsKey = "ServerURL"
    /// The managed-preference key for the native Google OAuth client id.
    public static let googleClientIDDefaultsKey = "GoogleClientID"

    /// - Parameters:
    ///   - arguments: `ProcessInfo.processInfo.arguments` in the app.
    ///   - environment: `ProcessInfo.processInfo.environment` in the app.
    ///   - defaults: a lookup into the app's preference domain — in the app,
    ///     `UserDefaults.standard.string(forKey:)`. A closure so this type
    ///     stays pure and testable.
    public init(
        arguments: [String],
        environment: [String: String],
        defaults: (String) -> String?
    ) {
        let rawServer = Self.resolve(
            argument: "--server",
            environmentKey: "SECURE_TEST_SERVER",
            defaultsKey: Self.serverURLDefaultsKey,
            arguments: arguments,
            environment: environment,
            defaults: defaults
        )
        if let rawServer {
            if let url = Self.validURL(rawServer.value) {
                self.serverURL = url
                self.serverURLSource = rawServer.source
                self.invalidServerURL = nil
            } else {
                self.serverURL = nil
                self.serverURLSource = .none
                self.invalidServerURL = InvalidConfigurationValue(
                    raw: rawServer.value,
                    source: rawServer.source
                )
            }
        } else {
            self.serverURL = nil
            self.serverURLSource = .none
            self.invalidServerURL = nil
        }

        let rawClientID = Self.resolve(
            argument: "--google-client-id",
            environmentKey: "SECURE_TEST_GOOGLE_CLIENT_ID",
            defaultsKey: Self.googleClientIDDefaultsKey,
            arguments: arguments,
            environment: environment,
            defaults: defaults
        )
        self.googleClientID = rawClientID?.value
        self.googleClientIDSource = rawClientID?.source ?? .none
    }

    /// True when the app has everything it needs to reach the server and sign a
    /// student in. False is the state the entry screen names to the student.
    public var isFullyConfigured: Bool {
        serverURL != nil && googleClientID != nil
    }

    /// One line per value for the launch log, in the order a reader wants them.
    public var logLines: [String] {
        var lines: [String] = []
        if let invalid = invalidServerURL {
            lines.append(
                "config: server URL from \(invalid.source.description) is not a usable http(s) URL — ignored"
            )
        }
        if serverURL != nil {
            lines.append("config: server URL from \(serverURLSource.description)")
        } else {
            lines.append("config: server URL not configured")
        }
        if googleClientID != nil {
            lines.append("config: google client id from \(googleClientIDSource.description)")
        } else {
            lines.append("config: google client id not configured")
        }
        return lines
    }

    // MARK: resolution

    private struct RawValue {
        let value: String
        let source: ConfigurationSource
    }

    private static func resolve(
        argument: String,
        environmentKey: String,
        defaultsKey: String,
        arguments: [String],
        environment: [String: String],
        defaults: (String) -> String?
    ) -> RawValue? {
        if let flag = arguments.firstIndex(of: argument),
           arguments.indices.contains(flag + 1),
           let value = nonEmpty(arguments[flag + 1]) {
            return RawValue(value: value, source: .launchArgument)
        }
        if let value = nonEmpty(environment[environmentKey]) {
            return RawValue(value: value, source: .environment)
        }
        if let value = nonEmpty(defaults(defaultsKey)) {
            return RawValue(value: value, source: .managedPreference)
        }
        return nil
    }

    /// Empty — and whitespace-only, which is what a hand-edited profile tends
    /// to carry — counts as unset.
    private static func nonEmpty(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    /// `URL(string:)` accepts nearly any string, so a typo like `htp:/origin`
    /// or a bare hostname would otherwise become a URL the app fails on later
    /// with no explanation. The server is always an http(s) origin with a host.
    private static func validURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host,
              !host.isEmpty
        else { return nil }
        return url
    }
}
