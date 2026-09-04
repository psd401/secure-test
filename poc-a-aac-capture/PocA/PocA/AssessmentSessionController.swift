import AutomaticAssessmentConfiguration
import Foundation

// Wraps AEAssessmentSession lifecycle for PoC-A.
//
// Property names and version availability come from reading Apple's framework
// headers directly (SDK 26.x, recorded in poc-a-aac-capture/RESULTS.md
// finding #5). Earlier scaffolding used `Mirror` introspection which yields
// nothing for Obj-C bridged types.
//
// Defaults are restrictive. The accommodations example shows the loosening
// pattern: set the relevant `allows*` flags to true and register
// assistive-tech apps via setConfiguration(_:for:).
//
// EXIT PATH (added 2026-08-26, RESULTS finding #10). The first session this
// controller ever began could not be left: the machine had to be power-cycled.
// AAC suppresses app switching, so once `begin()` succeeds NOTHING outside this
// process can recover the Mac — the exit has to be in here. Three mechanisms,
// deliberately independent, because the whole failure was that one mechanism
// had one unnoticed hole:
//
//   1. `state` is published so the UI can never show a stale "Enter Assessment"
//      label while a session is up. The button was the exit all along; it just
//      never said so.
//   2. `endSessionForTermination()` gives every quit path — menu, Cmd-Q,
//      SIGTERM, last-window-closed — somewhere to call `end()` on the way out.
//   3. A watchdog ends the session after `timeout` whether or not anyone asks,
//      and if `end()` itself does not call back within
//      `escalationGrace`, `onWatchdogEscalation` fires so the app can quit the
//      process outright. A session that outlives its app dies with it.
//
// Mechanism 3 is the one that makes a forced shutdown impossible, so it is not
// switchable off. `--session-timeout` can lengthen it for a characterization
// run; it cannot remove it.
//
// SIMULATION (added 2026-08-26). Testing the above on real AAC needs the
// restricted entitlement, which needs a provisioning profile from the PSD team,
// which needs the device registered to it — so it can only ever happen on a
// district-owned Mac. But only ONE of the behaviours above actually involves
// AAC: whether ending a session gives the machine back. The state machine, the
// watchdog, the escalation, and the confirmed-teardown handshake are all ours,
// and `Mode.simulated` exercises every one of them on any Mac, with no
// entitlement, without ever locking anything.
//
// What simulation cannot tell you is the one thing left: whether
// `AEAssessmentSession.end()` really releases the Mac. Do not read a green
// simulated run as proof the exits work in lockdown.

final class AssessmentSessionController: NSObject, AEAssessmentSessionDelegate {
    enum Mode: Equatable {
        /// Real `AEAssessmentSession`. Locks the Mac.
        case live
        /// Drives the same state machine with no `AEAssessmentSession` behind
        /// it. Nothing locks. `stuckEnd` additionally makes the simulated
        /// `end()` never confirm, which is the only way to exercise the
        /// escalation and termination-fallback paths on purpose.
        case simulated(stuckEnd: Bool)

        var isSimulated: Bool {
            if case .simulated = self { return true }
            return false
        }
    }

    enum State: Equatable {
        /// No session. Safe.
        case idle
        /// `begin()` called, delegate has not answered yet. Ending is still the
        /// right action — a session that is starting can trap you just as well
        /// as one that has started.
        case starting
        /// Delegate confirmed the session is up.
        case active
    }

    /// Default watchdog window. Nothing about this spike needs an open-ended
    /// session; every question in the checklist is answerable in well under two
    /// minutes.
    static let defaultTimeout: TimeInterval = 120

    /// Floor on `--session-timeout`. Short enough to be a real safety net,
    /// long enough to click one thing and read the result.
    static let minimumTimeout: TimeInterval = 10

    /// How long `end()` gets to call back before we stop being polite and quit
    /// the process instead.
    static let escalationGrace: TimeInterval = 5

    private var session: AEAssessmentSession?
    private var watchdog: DispatchSourceTimer?
    private var escalation: DispatchSourceTimer?
    private var terminationFallback: DispatchSourceTimer?
    private var terminationCompletion: (() -> Void)?
    private var deadline: Date?
    private let timeout: TimeInterval
    private let mode: Mode
    private let allowsScreenshots: Bool
    private let allowsCalculator: Bool

    var onLog: ((String) -> Void)?
    var onStateChange: ((State) -> Void)?
    /// Seconds left on the watchdog, once per second while a session is up.
    var onTick: ((TimeInterval) -> Void)?
    /// `end()` did not call back in time. The app is expected to terminate.
    var onWatchdogEscalation: (() -> Void)?
    /// A quit has been waiting on confirmation for too long. Fires on a
    /// BACKGROUND queue, deliberately — see `terminationBackstop`. The app is
    /// expected to hard-exit from here; it cannot rely on the main thread.
    var onTerminationTimeout: (@Sendable () -> Void)?

    private(set) var state: State = .idle {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
        }
    }

    var isActive: Bool { state != .idle }

    init(
        timeout: TimeInterval = AssessmentSessionController.defaultTimeout,
        mode: Mode = .live,
        allowsScreenshots: Bool = false,
        allowsCalculator: Bool = false
    ) {
        self.timeout = max(timeout, Self.minimumTimeout)
        self.mode = mode
        self.allowsScreenshots = allowsScreenshots
        self.allowsCalculator = allowsCalculator
        super.init()
    }

    func beginSession() {
        guard state == .idle else {
            onLog?("Session already active — end it first.")
            return
        }

        let config = AEAssessmentConfiguration()
        applyAccommodationsExample(to: config)
        // `--allow-screenshots` (2026-08-27): the one variable left after the
        // capture measurement. With the default (false) ScreenCaptureKit
        // returns the app's own window as a flat grey box once the session is
        // up (RESULTS finding #13). Off by default; the log line below prints
        // the effective value so a run is self-describing.
        if allowsScreenshots, #available(macOS 26.1, *) {
            config.allowsScreenshots = true
        }
        // `--allow-calculator` (2026-08-27): checklist step 6 — the secondary-app
        // mechanism every assistive-tech accommodation runs through. Apple's
        // own example app; signature validation on, network off.
        if allowsCalculator {
            let calc = AEAssessmentApplication(bundleIdentifier: "com.apple.calculator")
            calc.requiresSignatureValidation = true
            let calcConfig = AEAssessmentParticipantConfiguration()
            calcConfig.allowsNetworkAccess = false
            config.setConfiguration(calcConfig, for: calc)
        }
        logSessionPreconditions(for: config)

        // State and watchdog go up BEFORE begin(), not after. If begin()
        // succeeds and something later in this method throws or returns early,
        // the arming must already have happened — otherwise we are back to a
        // live session with no way out, which is the exact bug this fixes.
        switch mode {
        case .live:
            let newSession = AEAssessmentSession(configuration: config)
            newSession.delegate = self
            session = newSession
            state = .starting
            armWatchdog()
            newSession.begin()
            onLog?("AEAssessmentSession.begin() called. Watchdog will end it in \(Int(timeout))s if nothing else does.")

        case .simulated(let stuckEnd):
            state = .starting
            armWatchdog()
            onLog?("SIMULATION: no AEAssessmentSession created, nothing is locked. Watchdog set to \(Int(timeout))s.")
            if stuckEnd {
                onLog?("SIMULATION: end() is rigged NEVER to confirm — the escalation path is what should fire.")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.state == .starting else { return }
                    self.handleDidBegin()
                }
            }
        }
    }

    func endSession() {
        guard state != .idle else {
            onLog?("No session to end.")
            return
        }
        switch mode {
        case .live:
            onLog?("AEAssessmentSession.end() called.")
            session?.end()

        case .simulated(let stuckEnd):
            guard !stuckEnd else {
                onLog?("SIMULATION: end() called and deliberately ignored.")
                return
            }
            onLog?("SIMULATION: end() called.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.state != .idle else { return }
                    self.handleDidEnd()
                }
            }
        }
    }

    /// Ends the session and calls back only once the system has CONFIRMED it,
    /// or once the grace window expires — whichever comes first, exactly once.
    ///
    /// This exists because the obvious version is not good enough. Calling
    /// `end()` from `applicationWillTerminate` and letting the process exit
    /// immediately after is a race: `end()` is an XPC call to the assessment
    /// daemon, and nothing guarantees it lands before the process dies. If AAC
    /// does not reclaim the session on process death, that reproduces the
    /// original failure exactly — locked Mac, and now no app left running, so
    /// no watchdog either. Cmd-Q and closing the window are the most reflexive
    /// exits we have, so they get the strongest guarantee rather than the
    /// weakest.
    ///
    /// The caller is expected to hold termination open (`.terminateLater`)
    /// until the completion fires.
    func endSessionBeforeTerminating(completion: @escaping () -> Void) {
        guard state != .idle else {
            completion()
            return
        }
        guard terminationCompletion == nil else { return }
        terminationCompletion = completion
        onLog?("Terminating with a session active — ending it and waiting for confirmation.")

        let timer = DispatchSource.makeTimerSource(queue: Self.backstopQueue)
        timer.schedule(deadline: .now() + Self.escalationGrace)
        let onTimeout = onTerminationTimeout
        timer.setEventHandler {
            FileHandle.standardError.write(Data(
                "[PocA] end() did not confirm within \(Int(Self.escalationGrace))s — hard-exiting.\n".utf8
            ))
            onTimeout?()
        }
        terminationFallback = timer
        timer.resume()

        endSession()
    }

    /// Last-resort backstop for a quit that never gets its confirmation.
    ///
    /// This runs on its own queue rather than the main one, and the reason is a
    /// bug found in simulation on 2026-08-26. The first version of this used
    /// `.terminateLater` plus a main-queue fallback timer, and BOTH the
    /// confirmation callback and the timer were starved: once
    /// `applicationShouldTerminate` returns `.terminateLater`, AppKit waits in a
    /// nested run loop that does not drain `DispatchQueue.main`, so nothing
    /// scheduled there ever ran and the app hung forever with the session still
    /// live. A watchdog that shares a thread with the thing it is watching is
    /// not a watchdog.
    private static let backstopQueue = DispatchQueue(label: "net.psd401.securetest.PocA.termination-backstop")

    /// Fires the pending termination completion exactly once and tears down its
    /// fallback timer. Safe to call when no termination is pending.
    private func finishTermination() {
        terminationFallback?.cancel()
        terminationFallback = nil
        let completion = terminationCompletion
        terminationCompletion = nil
        completion?()
    }

    // MARK: Watchdog

    private func armWatchdog() {
        disarmWatchdog()
        deadline = Date().addingTimeInterval(timeout)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1.0)
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.watchdogTick() }
        }
        watchdog = timer
        timer.resume()
    }

    private func disarmWatchdog() {
        watchdog?.cancel()
        watchdog = nil
        deadline = nil
    }

    private func watchdogTick() {
        guard let deadline else { return }
        let remaining = deadline.timeIntervalSinceNow
        guard remaining <= 0 else {
            onTick?(remaining)
            return
        }
        // Disarm before ending, or this fires again every second while end()
        // is in flight.
        disarmWatchdog()
        onLog?("WATCHDOG: \(Int(timeout))s elapsed — ending the session automatically.")
        armEscalation()
        endSession()
    }

    /// If `end()` does not produce `assessmentSessionDidEnd` within the grace
    /// window, the polite exit has failed and the process should go. Untested
    /// against a real stuck `end()` — we have never seen one — but the cost of
    /// being wrong here is another power-cycle.
    private func armEscalation() {
        disarmEscalation()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.escalationGrace)
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.disarmEscalation()
                self.onLog?("WATCHDOG: end() did not call back in \(Int(Self.escalationGrace))s — quitting the process.")
                self.onWatchdogEscalation?()
            }
        }
        escalation = timer
        timer.resume()
    }

    private func disarmEscalation() {
        escalation?.cancel()
        escalation = nil
    }

    private func clearSession() {
        disarmWatchdog()
        disarmEscalation()
        session = nil
        state = .idle
        // If a quit is being held open waiting for this, release it now — the
        // session is confirmed gone, which is the whole point of the wait.
        finishTermination()
    }

    /// Demonstrates the accommodations pattern. Currently sets nothing in
    /// the restrictive branch; comment in the looser lines to test
    /// per-feature allowances once the entitlement clears.
    private func applyAccommodationsExample(to config: AEAssessmentConfiguration) {
        // Default (most restrictive) — no setters needed.

        // Examples for an accommodations build, gated on macOS version:
        //
        // if #available(macOS 15.0, *) {
        //     config.allowsSpellCheck = true
        //     config.autocorrectMode = [.spelling]
        //     config.allowsKeyboardShortcuts = true
        //     config.allowsPredictiveKeyboard = true
        // }
        // if #available(macOS 26.1, *) {
        //     config.allowsAccessibilityKeyboard = true
        //     config.allowsAccessibilityReader = true
        //     config.allowsAccessibilityLiveCaptions = true
        //     // config.allowsScreenshots intentionally left false — clipboard
        //     // screenshots are not something we want even for accommodations.
        // }
        //
        // Allow a known assistive-tech bundle ID. Apple's example uses
        // Calculator; replace with the AT app's real bundle ID and team ID:
        //
        // let calc = AEAssessmentApplication(bundleIdentifier: "com.apple.calculator")
        // calc.requiresSignatureValidation = true
        // let calcConfig = AEAssessmentParticipantConfiguration()
        // calcConfig.allowsNetworkAccess = false
        // config.setConfiguration(calcConfig, for: calc)
    }

    private func logSessionPreconditions(for config: AEAssessmentConfiguration) {
        let pi = ProcessInfo.processInfo.operatingSystemVersion
        onLog?("macOS \(pi.majorVersion).\(pi.minorVersion).\(pi.patchVersion)")
        onLog?("AEAssessmentSession.supportsMultipleParticipants = \(AEAssessmentSession.supportsMultipleParticipants)")
        onLog?("AEAssessmentSession.supportsConfigurationUpdates = \(AEAssessmentSession.supportsConfigurationUpdates)")
        onLog?("Config: mainParticipantConfiguration.allowsNetworkAccess = \(config.mainParticipantConfiguration.allowsNetworkAccess)")
        if #available(macOS 15.0, *) {
            onLog?("Config (macOS 15+): allowsSpellCheck=\(config.allowsSpellCheck) autocorrectMode=\(config.autocorrectMode.rawValue) allowsKeyboardShortcuts=\(config.allowsKeyboardShortcuts) allowsPredictiveKeyboard=\(config.allowsPredictiveKeyboard)")
        }
        if #available(macOS 26.1, *) {
            onLog?("Config (macOS 26.1+): allowsAccessibilityKeyboard=\(config.allowsAccessibilityKeyboard) allowsAccessibilityLiveCaptions=\(config.allowsAccessibilityLiveCaptions) allowsAccessibilityReader=\(config.allowsAccessibilityReader) allowsScreenshots=\(config.allowsScreenshots)")
        }
        onLog?("Secondary apps allowed: \(config.configurationsByApplication.count)")
    }

    // MARK: AEAssessmentSessionDelegate

    func assessmentSessionDidBegin(_ session: AEAssessmentSession) {
        handleDidBegin()
    }

    func assessmentSession(_ session: AEAssessmentSession, failedToBeginWithError error: Error) {
        let ns = error as NSError
        onLog?("Delegate: session FAILED TO BEGIN — \(error.localizedDescription) [domain=\(ns.domain) code=\(ns.code)]")
        if ns.domain == AEAssessmentErrorDomain {
            onLog?("  (code \(ns.code) per AEErrors.h: 1=Unknown, 2=UnsupportedPlatform, 3=MultipleParticipantsNotSupported, 4=ConfigurationUpdatesNotSupported, 5=RequiredParticipantsNotAvailable)")
        }
        clearSession()
    }

    func assessmentSession(_ session: AEAssessmentSession, wasInterruptedWithError error: Error) {
        onLog?("Delegate: session INTERRUPTED — \(error.localizedDescription)")
        clearSession()
    }

    func assessmentSessionDidEnd(_ session: AEAssessmentSession) {
        handleDidEnd()
    }

    // MARK: Delegate bodies

    /// Split out of the delegate methods so `Mode.simulated` can drive exactly
    /// the same transitions the real framework would, rather than a parallel
    /// code path that could drift from it.

    private func handleDidBegin() {
        onLog?("Delegate: session DID BEGIN.\(mode.isSimulated ? " (simulated)" : "")")
        state = .active
    }

    private func handleDidEnd() {
        onLog?("Delegate: session DID END.\(mode.isSimulated ? " (simulated)" : "")")
        clearSession()
    }
}
