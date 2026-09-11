import XCTest
@testable import SecureTestCore

/// The launch-time resolver behind the managed-preference configuration
/// (2026-09-11): a district Mac launched from Finder or Jamf has no launch
/// arguments and no environment, so the profile's `ServerURL` /
/// `GoogleClientID` keys are the only thing standing between the app and a
/// blank card. The lookups themselves (`ProcessInfo`, `UserDefaults`) belong to
/// the app; the precedence is here, where it can be tested.
final class ClientConfigurationTests: XCTestCase {
    private func config(
        arguments: [String] = ["SecureTest"],
        environment: [String: String] = [:],
        defaults: [String: String] = [:]
    ) -> ClientConfiguration {
        ClientConfiguration(
            arguments: arguments,
            environment: environment,
            defaults: { defaults[$0] }
        )
    }

    // MARK: nothing configured

    func testNothingConfiguredResolvesToNothing() {
        let resolved = config()
        XCTAssertNil(resolved.serverURL)
        XCTAssertEqual(resolved.serverURLSource, .none)
        XCTAssertNil(resolved.googleClientID)
        XCTAssertEqual(resolved.googleClientIDSource, .none)
        XCTAssertNil(resolved.invalidServerURL)
        XCTAssertFalse(resolved.isFullyConfigured)
    }

    /// The regression the whole slice exists for: no fallback to localhost.
    func testThereIsNoLocalhostFallback() {
        XCTAssertNil(config().serverURL)
    }

    func testUnconfiguredLogLinesSaySo() {
        XCTAssertEqual(config().logLines, [
            "config: server URL not configured",
            "config: google client id not configured",
        ])
    }

    // MARK: managed preferences

    func testManagedPreferencesAloneAreEnough() {
        let resolved = config(defaults: [
            "ServerURL": "https://example.invalid",
            "GoogleClientID": "prefs-client",
        ])
        XCTAssertEqual(resolved.serverURL, URL(string: "https://example.invalid"))
        XCTAssertEqual(resolved.serverURLSource, .managedPreference)
        XCTAssertEqual(resolved.googleClientID, "prefs-client")
        XCTAssertEqual(resolved.googleClientIDSource, .managedPreference)
        XCTAssertTrue(resolved.isFullyConfigured)
        XCTAssertEqual(resolved.logLines, [
            "config: server URL from managed preference",
            "config: google client id from managed preference",
        ])
    }

    // MARK: precedence

    func testEnvironmentBeatsManagedPreferences() {
        let resolved = config(
            environment: [
                "SECURE_TEST_SERVER": "https://env.invalid",
                "SECURE_TEST_GOOGLE_CLIENT_ID": "env-client",
            ],
            defaults: [
                "ServerURL": "https://prefs.invalid",
                "GoogleClientID": "prefs-client",
            ]
        )
        XCTAssertEqual(resolved.serverURL, URL(string: "https://env.invalid"))
        XCTAssertEqual(resolved.serverURLSource, .environment)
        XCTAssertEqual(resolved.googleClientID, "env-client")
        XCTAssertEqual(resolved.googleClientIDSource, .environment)
    }

    func testLaunchArgumentsBeatEverything() {
        let resolved = config(
            arguments: [
                "SecureTest",
                "--server", "https://arg.invalid",
                "--google-client-id", "arg-client",
            ],
            environment: [
                "SECURE_TEST_SERVER": "https://env.invalid",
                "SECURE_TEST_GOOGLE_CLIENT_ID": "env-client",
            ],
            defaults: [
                "ServerURL": "https://prefs.invalid",
                "GoogleClientID": "prefs-client",
            ]
        )
        XCTAssertEqual(resolved.serverURL, URL(string: "https://arg.invalid"))
        XCTAssertEqual(resolved.serverURLSource, .launchArgument)
        XCTAssertEqual(resolved.googleClientID, "arg-client")
        XCTAssertEqual(resolved.googleClientIDSource, .launchArgument)
        XCTAssertEqual(resolved.logLines, [
            "config: server URL from launch argument",
            "config: google client id from launch argument",
        ])
    }

    /// The two values resolve independently — a profile can supply the server
    /// while a developer overrides only the client id.
    func testTheTwoValuesResolveIndependently() {
        let resolved = config(
            environment: ["SECURE_TEST_GOOGLE_CLIENT_ID": "env-client"],
            defaults: ["ServerURL": "https://prefs.invalid"]
        )
        XCTAssertEqual(resolved.serverURLSource, .managedPreference)
        XCTAssertEqual(resolved.googleClientIDSource, .environment)
    }

    /// A flag with no value after it is not a value.
    func testATrailingFlagWithNoValueIsIgnored() {
        let resolved = config(
            arguments: ["SecureTest", "--server"],
            defaults: ["ServerURL": "https://prefs.invalid"]
        )
        XCTAssertEqual(resolved.serverURL, URL(string: "https://prefs.invalid"))
        XCTAssertEqual(resolved.serverURLSource, .managedPreference)
    }

    // MARK: empty as unset

    func testAnEmptyValueCountsAsUnsetAndFallsThrough() {
        let resolved = config(
            arguments: ["SecureTest", "--server", "", "--google-client-id", "   "],
            environment: ["SECURE_TEST_SERVER": "", "SECURE_TEST_GOOGLE_CLIENT_ID": ""],
            defaults: [
                "ServerURL": "https://prefs.invalid",
                "GoogleClientID": "prefs-client",
            ]
        )
        XCTAssertEqual(resolved.serverURL, URL(string: "https://prefs.invalid"))
        XCTAssertEqual(resolved.serverURLSource, .managedPreference)
        XCTAssertEqual(resolved.googleClientID, "prefs-client")
        XCTAssertEqual(resolved.googleClientIDSource, .managedPreference)
    }

    func testAnEmptyValueEverywhereIsNotConfigured() {
        let resolved = config(
            environment: ["SECURE_TEST_SERVER": " ", "SECURE_TEST_GOOGLE_CLIENT_ID": ""],
            defaults: ["ServerURL": "", "GoogleClientID": "  "]
        )
        XCTAssertNil(resolved.serverURL)
        XCTAssertNil(resolved.googleClientID)
        XCTAssertNil(resolved.invalidServerURL)
    }

    func testSurroundingWhitespaceIsTrimmed() {
        let resolved = config(defaults: [
            "ServerURL": "  https://example.invalid  ",
            "GoogleClientID": " prefs-client\n",
        ])
        XCTAssertEqual(resolved.serverURL, URL(string: "https://example.invalid"))
        XCTAssertEqual(resolved.googleClientID, "prefs-client")
    }

    // MARK: invalid URLs

    func testAnInvalidServerURLIsUnsetAndReported() {
        for raw in ["not a url", "example.invalid", "htp:/example.invalid", "ftp://example.invalid"] {
            let resolved = config(defaults: ["ServerURL": raw])
            XCTAssertNil(resolved.serverURL, "\(raw) should not resolve")
            XCTAssertEqual(resolved.serverURLSource, .none, "\(raw)")
            XCTAssertEqual(
                resolved.invalidServerURL,
                InvalidConfigurationValue(raw: raw, source: .managedPreference),
                "\(raw)"
            )
        }
    }

    func testAnInvalidServerURLLogsWhereItCameFrom() {
        let resolved = config(environment: ["SECURE_TEST_SERVER": "example.invalid"])
        XCTAssertEqual(resolved.logLines, [
            "config: server URL from environment is not a usable http(s) URL — ignored",
            "config: server URL not configured",
            "config: google client id not configured",
        ])
    }

    /// http is accepted — the dev launcher points at `http://localhost:3000`.
    func testPlainHTTPIsAccepted() {
        let resolved = config(environment: ["SECURE_TEST_SERVER": "http://localhost:3000"])
        XCTAssertEqual(resolved.serverURL, URL(string: "http://localhost:3000"))
        XCTAssertEqual(resolved.serverURLSource, .environment)
    }
}
