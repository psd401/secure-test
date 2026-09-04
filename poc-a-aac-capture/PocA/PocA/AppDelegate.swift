import Cocoa

// PoC-A's window: two buttons and a log.
//
// EXIT PATH (added 2026-08-26, RESULTS finding #10). The first successful AAC
// session begun from this file could not be left, and the Mac had to be
// power-cycled. Four separate defects here, each sufficient on its own:
//
//   - the Enter Assessment button ended the session on a second click, but its
//     title was hard-coded, so nothing on screen ever said an exit existed;
//   - no main menu was installed, so Cmd-Q dispatched to nothing (the same
//     "no menu item, no shortcut" behaviour PoC-B measured for Cmd-V);
//   - `applicationShouldTerminateAfterLastWindowClosed` was unimplemented and
//     therefore false, so closing the window orphaned the process with the
//     session still up and no UI at all;
//   - nothing ended the session on any path except that one button.
//
// All four are closed below. The ordering principle: the button is what a
// person will actually reach for, the menu and SIGTERM are for when it is not
// reachable, and the controller's watchdog is what guarantees the machine comes
// back even if every interactive path fails. Only the last one is a guarantee —
// whether the menu bar is even usable inside a session is unmeasured
// (unblock-checklist step 5).

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var logView: NSTextView!
    private var sessionButton: NSButton!
    private var endMenuItem: NSMenuItem!
    private let session = AssessmentSessionController(
        timeout: AppDelegate.requestedTimeout,
        mode: AppDelegate.requestedMode,
        allowsScreenshots: ProcessInfo.processInfo.arguments.contains("--allow-screenshots"),
        allowsCalculator: ProcessInfo.processInfo.arguments.contains("--allow-calculator")
    )
    private let capture = ScreenCaptureService()
    private var sigterm: DispatchSourceSignal?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    /// `--session-timeout <seconds>` lengthens the watchdog for a run that needs
    /// to observe more than one thing (checklist steps 5 and 6). It cannot
    /// disable it, and the controller clamps it to a floor — a spike with no
    /// upper bound on lockdown is what caused the power-cycle.
    private static var requestedTimeout: TimeInterval {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--session-timeout"),
              args.indices.contains(flag + 1),
              let seconds = TimeInterval(args[flag + 1])
        else { return AssessmentSessionController.defaultTimeout }
        return seconds
    }

    /// `--simulate-lockdown` drives the whole exit path with no
    /// `AEAssessmentSession` behind it, so the state machine, watchdog,
    /// escalation and confirmed-teardown handshake can be verified on a Mac
    /// with no entitlement — which is every Mac that is not registered to the
    /// PSD team. `--simulate-stuck-end` additionally rigs `end()` never to
    /// confirm, the only way to reach the escalation path deliberately.
    private static var requestedMode: AssessmentSessionController.Mode {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--simulate-stuck-end") { return .simulated(stuckEnd: true) }
        if args.contains("--simulate-lockdown") { return .simulated(stuckEnd: false) }
        return .live
    }

    /// Begins a session at launch instead of waiting for a click, so a
    /// simulated run is scriptable. Deliberately ignored in live mode: a flag
    /// that locks the Mac the instant the app opens, before anyone has read the
    /// window, is the same class of mistake as shipping no exit at all.
    private static var wantsAutoBegin: Bool {
        ProcessInfo.processInfo.arguments.contains("--auto-begin")
            && requestedMode.isSimulated
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        let frame = NSRect(x: 0, y: 0, width: 720, height: 480)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = Self.requestedMode.isSimulated
            ? "PoC-A — SIMULATION (nothing will lock)"
            : "PoC-A — AAC + ScreenCaptureKit"
        window.center()

        let content = NSView(frame: frame)

        sessionButton = NSButton(
            title: "Enter Assessment",
            target: self,
            action: #selector(toggleSession)
        )
        sessionButton.frame = NSRect(x: 16, y: 432, width: 260, height: 32)
        content.addSubview(sessionButton)

        let captureButton = NSButton(
            title: "Capture Frame",
            target: self,
            action: #selector(captureFrame)
        )
        captureButton.frame = NSRect(x: 284, y: 432, width: 180, height: 32)
        content.addSubview(captureButton)

        let snapshotButton = NSButton(
            title: "Snapshot Window",
            target: self,
            action: #selector(snapshotWindow)
        )
        snapshotButton.frame = NSRect(x: 472, y: 432, width: 232, height: 32)
        content.addSubview(snapshotButton)

        let scroll = NSScrollView(frame: NSRect(x: 16, y: 16, width: 688, height: 400))
        scroll.hasVerticalScroller = true
        logView = NSTextView(frame: scroll.bounds)
        logView.isEditable = false
        logView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        logView.autoresizingMask = [.width]
        scroll.documentView = logView
        content.addSubview(scroll)

        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        session.onLog = { [weak self] in self?.log($0) }
        capture.onLog = { [weak self] in self?.log($0) }
        session.onStateChange = { [weak self] in self?.render(state: $0) }
        session.onTick = { [weak self] in self?.renderCountdown($0) }
        session.onWatchdogEscalation = { NSApp.terminate(nil) }
        // Runs on the controller's backstop queue, not the main one, precisely
        // because the case it exists for is "the main thread is not coming
        // back". exit() is the only thing safe to reach for there.
        session.onTerminationTimeout = { exit(0) }
        installSignalHandler()
        render(state: session.state)

        if Self.requestedMode.isSimulated {
            log("SIMULATION MODE — no AEAssessmentSession is created and the Mac will not lock.")
            log("This proves the exit path's logic, NOT that AAC releases the machine.")
        }
        log("PoC-A ready. Click Enter Assessment to start a session, then Capture Frame.")
        log("Grant Screen Recording to this app in System Settings > Privacy & Security on first capture.")
        log("Exits: the button, Cmd-E, Cmd-Q, `killall PocA`, or the automatic watchdog.")

        if Self.wantsAutoBegin {
            log("--auto-begin: starting a simulated session without waiting for a click.")
            session.beginSession()
        }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Was unimplemented, and the default is `false` — which meant closing the
    /// window left a live session with no UI attached to it. Closing the window
    /// is now a quit, and quitting ends the session.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Quitting waits for the session to be confirmed ended — by CANCELLING
    /// this quit and re-issuing it once the confirmation arrives.
    ///
    /// Two earlier versions of this were wrong, in opposite directions.
    ///
    /// The first called `end()` from `applicationWillTerminate` and let the
    /// process exit immediately after, racing an XPC call — and losing that race
    /// relocks the Mac with no app left to run a watchdog.
    ///
    /// The second returned `.terminateLater` and waited for a reply. That was
    /// worse, and simulation caught it: after `.terminateLater`, AppKit waits in
    /// a nested run loop that does not drain `DispatchQueue.main`, so neither
    /// the session's confirmation callback nor the fallback timer ever ran. The
    /// app hung forever with the session live — the exact state the exit path
    /// exists to prevent, reached by the code meant to prevent it.
    ///
    /// `.terminateCancel` returns control to the normal run loop instead, so
    /// main keeps draining, the confirmation arrives, and the completion simply
    /// asks to terminate again — at which point no session is active and this
    /// returns `.terminateNow`. The backstop that guarantees an exit regardless
    /// lives off the main queue in the controller.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard session.isActive else { return .terminateNow }
        session.endSessionBeforeTerminating {
            NSApp.terminate(nil)
        }
        return .terminateCancel
    }

    // MARK: Exits

    @objc private func toggleSession() {
        if session.isActive {
            session.endSession()
        } else {
            session.beginSession()
        }
    }

    @objc private func endSessionFromMenu() {
        guard session.isActive else { return }
        session.endSession()
    }

    /// `killall PocA` from another machine is the documented out-of-band escape
    /// (unblock-checklist step 0). Trapping SIGTERM turns it from "kill the
    /// process and hope the system reclaims the session" into an ordered
    /// teardown. SIGKILL is untrappable by definition, so the watchdog remains
    /// the backstop for that case.
    private func installSignalHandler() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        sigterm = source
        source.resume()
    }

    // MARK: Rendering

    /// The button's title is derived from the controller's state on every
    /// change, never set optimistically at click time — a title set when the
    /// click happens would lie for as long as `begin()` takes to fail.
    private func render(state: AssessmentSessionController.State) {
        switch state {
        case .idle:
            sessionButton.title = "Enter Assessment"
        case .starting:
            sessionButton.title = "End Assessment (starting…)"
        case .active:
            sessionButton.title = "End Assessment"
            if Self.wantsCalculator { scheduleSecondaryAppProbe() }
        }
        endMenuItem.isEnabled = state != .idle
    }

    /// `--allow-calculator` (2026-08-27, checklist step 6). The Dock and
    /// Spotlight are suppressed inside a session, so the only way to open a
    /// secondary app is for the assessment app to do it itself — which is how
    /// the shipping client would open an assistive-tech app anyway. Calculator
    /// is in the configuration; Safari is not, and is the negative control.
    private static var wantsCalculator: Bool {
        ProcessInfo.processInfo.arguments.contains("--allow-calculator")
    }

    private func scheduleSecondaryAppProbe() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.openSecondary(bundleID: "com.apple.calculator", label: "Calculator (allowed)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.openSecondary(bundleID: "com.apple.Safari", label: "Safari (NOT allowed)")
        }
    }

    private func openSecondary(bundleID: String, label: String) {
        guard session.isActive else {
            log("Secondary: skipped \(label) — session no longer active.")
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            log("Secondary: \(label) — no app found for \(bundleID).")
            return
        }
        log("Secondary: opening \(label) via NSWorkspace…")
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] app, error in
            DispatchQueue.main.async {
                if let error {
                    self?.log("Secondary: \(label) FAILED — \(error.localizedDescription)")
                } else {
                    self?.log("Secondary: \(label) launched — pid \(app?.processIdentifier ?? -1). Is it visible? (hand-check)")
                }
            }
        }
    }

    private func renderCountdown(_ remaining: TimeInterval) {
        guard session.isActive else { return }
        sessionButton.title = "End Assessment — auto-ends in \(Int(remaining.rounded()))s"
    }

    @objc private func captureFrame() {
        Task {
            await capture.captureOnce()
        }
    }

    @objc private func snapshotWindow() {
        guard let view = window.contentView else {
            log("Snapshot: FAILED — no content view.")
            return
        }
        capture.snapshot(view: view)
    }

    /// Log lines go to stderr as well as the window. The window copy dies with
    /// the process, so a SIGKILL — or a run ended any way other than politely —
    /// used to take the entire record of what happened with it. stderr survives
    /// into whatever terminal launched the app, which is how
    /// `run-with-deadline.sh` runs it.
    private func log(_ msg: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(msg)\n"
        FileHandle.standardError.write(Data(line.utf8))
        DispatchQueue.main.async { [weak self] in
            self?.logView.textStorage?.append(NSAttributedString(string: line))
            self?.logView.scrollToEndOfDocument(nil)
        }
    }

    /// There was no main menu at all, which is why Cmd-Q did nothing. Whether
    /// the menu bar is reachable during an active session is one of the things
    /// checklist step 5 is meant to find out; until it is measured, treat this
    /// as a secondary exit and the watchdog as the real one.
    ///
    /// `autoenablesItems` is off so End Assessment's enabled state tracks the
    /// session rather than the responder chain.
    private func installMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.autoenablesItems = false

        endMenuItem = appMenu.addItem(
            withTitle: "End Assessment",
            action: #selector(endSessionFromMenu),
            keyEquivalent: "e"
        )
        endMenuItem.target = self
        endMenuItem.isEnabled = false

        appMenu.addItem(.separator())

        let quit = appMenu.addItem(
            withTitle: "Quit PocA",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quit.isEnabled = true

        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        NSApp.mainMenu = mainMenu
    }
}
