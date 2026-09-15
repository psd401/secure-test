import Foundation

/// Which build this is, and therefore which development affordances exist.
///
/// Security slice 2 (2026-09-15). The client had no `#if DEBUG` anywhere: every
/// knob written for development — `SECURE_TEST_SIMULATE_LOCKDOWN`,
/// `SECURE_TEST_TOKEN` / `--token`, `SECURE_TEST_NO_FULLSCREEN`,
/// `SECURE_TEST_DEBUG_CRASH`, `SECURE_TEST_WATCHDOG_SECONDS`, `--bundle` and
/// File → Open Test Bundle… — was live in the shipped, notarized app, where a
/// student with a Terminal window is exactly the threat the app exists to
/// contain. `SECURE_TEST_SIMULATE_LOCKDOWN=1` in particular was checked BEFORE
/// the entitlement, so it turned a real session into a cooperative fake and the
/// test rendered on an unlocked Mac.
///
/// The compilation condition itself is set by the Xcode project: the Debug
/// configuration defines `DEBUG`, Release does not. Every gate hangs off this
/// one flag so the whole Release posture reads in one place, and so the
/// branches stay COMPILED in both configurations (a `guard` on a `static let`
/// rather than `#if` scattered through the app) except where the point is that
/// a code path must not exist in the shipped binary at all.
///
/// `SecureTestCore` deliberately has none of this. SwiftPM builds it in debug
/// for `swift test`, so a `#if DEBUG` there would be true in every test run and
/// false in the app for the same source — the worst of both. Core takes
/// explicit parameters (`Timings.fromEnvironment(_:allowOverride:)`,
/// `ClientConfiguration(… managedPreferenceWins:)`) and the app target decides.
enum BuildPosture {
    #if DEBUG
    static let isDebug = true
    #else
    static let isDebug = false
    #endif

    /// Development environment knobs (`SECURE_TEST_*` and the matching launch
    /// arguments) are honoured. False in Release: a student cannot weaken a
    /// session from a Terminal launch.
    static var allowsDevelopmentOverrides: Bool { isDebug }

    /// A build with no AAC entitlement may fall back to a cooperative simulated
    /// session — the unsigned development posture. In Release a missing
    /// entitlement is a refusal, not a rehearsal.
    static var allowsUnentitledFallback: Bool { isDebug }

    /// A managed-preference (MDM `Forced`) value outranks the launch argument
    /// and the environment. Release only.
    static var managedPreferenceWins: Bool { !isDebug }

    /// The offline bundle path — `--bundle` and File → Open Test Bundle… — is
    /// a renderer-inspection tool. It delivers assessment content with no
    /// attempt, no lockdown and no reporting, so it is Debug only.
    static var allowsOfflineBundle: Bool { isDebug }

    /// One line at launch, so a hand-run can tell from stderr which posture the
    /// binary it is holding was built in.
    static var logLine: String {
        isDebug
            ? "build posture: DEBUG — development overrides honoured"
            : "build posture: RELEASE — development overrides ignored"
    }
}
