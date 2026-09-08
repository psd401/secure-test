import AppKit
import Foundation
import Security
import SecureTestCore
import UniformTypeIdentifiers

/// AppKit shell for the secure-test client.
///
/// Two findings from the PoCs are codified here:
///
/// 1. `@main` on an NSApplicationDelegate does NOT wire the class up as the
///    application's delegate — a storyboard normally does that, and this app has
///    none. Without an explicit `main()` the app launches, never fires
///    `applicationDidFinishLaunching`, and shows no window (PoC-A finding #7).
///
/// 2. Without a programmatic main menu, standard shortcuts silently no-op:
///    PoC-B measured Cmd-V and Cmd-F doing nothing, because there was no menu
///    item for the responder chain to dispatch to. Right-click Paste still
///    worked, since that path is per-view. So the Edit menu below is what makes
///    Cmd-V behave — which matters for a student pasting assistive-tech output.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var controller: AssessmentViewController?
    private var entry: SessionEntryViewController?
    private var clipboardItems: [NSMenuItem] = []
    /// File → Open Test Bundle…, pinned by `isEnabled` from `screen` (the rule
    /// is `OfflineBundle.canOpen`, Core) — never from the responder chain.
    private var openBundleItem: NSMenuItem?
    /// UX pass 2 slice 8: Cmd-E. PoC-A had it; the shipping client never
    /// did (the 2026-08-31 hand-run beeped in real AND simulated sessions —
    /// diagnosis: no menu item binds the key). Autoenable off; enabled only
    /// while a session is starting or active, from lockdownStateChanged.
    private var endSessionItem: NSMenuItem?
    private var screen: OfflineBundle.Screen = .entry {
        didSet { openBundleItem?.isEnabled = OfflineBundle.canOpen(on: screen) }
    }
    /// In memory on purpose (James, 2026-08-31, follow-on to UX pass 2
    /// slice 9): the session JWT dies with the process, so every launch
    /// starts signed out and forces a real Google sign-in (prompt=login).
    /// A crash mid-test therefore costs a full re-auth before Resume —
    /// accepted; on a shared lab Mac nothing may outlive the process.
    /// The Keychain-backed store this replaces is purged at launch.
    private let tokens = InMemoryTokenStore()
    private var lockdown: AssessmentLockdown?
    /// AAC-2b: set from each loaded bundle's accommodations before its
    /// beginLockdown(); read by makeSession per begin(). Restrictive until a
    /// bundle says otherwise.
    private var lockdownPlan: LockdownConfigurationPlan = .restrictive
    private var lockdownAccessory: NSTitlebarAccessoryViewController?
    /// UX pass 2 slice 6 (finding 10.3): the way home. Installed when the
    /// lockdown reaches .idle on a server attempt — which is both the
    /// hand-in and the emergency-end aftermath — removed by showEntry().
    private var backToTestsAccessory: NSTitlebarAccessoryViewController?
    private var lockdownStatusLabel: NSTextField?
    private var terminatingAfterLockdown = false
    /// UX pass 2: set the moment a quit starts so the session-ended sheet
    /// never flashes under a terminating app.
    private var quitInProgress = false
    // Slice 92: one reporter per server-delivered attempt; nil otherwise.
    // Focus events stop at hand-in (the flag), but the reporter stays for the
    // lockdown_end that follows and for a quit on the way out.
    private var eventReporter: AttemptEventReporter?
    /// On-demand peek (P2): lives exactly as long as the reporter — one per
    /// server-delivered attempt, polling while the attempt is on screen,
    /// stopped at hand-in. Deliberately NOT stopped when lockdown ends:
    /// decision 6.2 wants peek on any in-progress attempt, and the unlocked
    /// stretch after an emergency end is exactly when a teacher wants eyes.
    private var peekResponder: PeekResponder?
    private var attemptHandedIn = false

    /// Observability slice 4 (`docs/observability-design.md`): this build's
    /// identity, on every error line and every pre-formatted crash line.
    static let buildStamp = AppBuildStamp(version: AppVersion.marketing, commit: AppVersion.commit)

    /// Observability slice 4, D-4: the reporter `logError` posts a
    /// `client_error` event through when an attempt is open. Static because
    /// the sink's `onRecord` hook is a plain closure reached from anywhere,
    /// including Core; it tracks `eventReporter` exactly.
    nonisolated(unsafe) static var activeEventReporter: AttemptEventReporter?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // AAC-2b follow-up 3.1: WebKit keeps continuous spell checking OFF
        // unless the app's defaults say otherwise (TextCheckerMac.mm reads
        // `boolForKey:` — an absent key is NO; Safari sets it for itself), so
        // the essay's `spellcheck=true` never squiggled. Registration domain
        // rather than a disk write, and it must land before the first
        // WKWebView exists — WebKit snapshots the state once, on first use.
        // Whether a given FIELD is checked stays with the per-student
        // `spellcheck` attribute the bundle's accommodations drive; inside a
        // real session the AAC `allowsSpellCheck` knob gates it besides
        // (both measured live 2026-08-28, MANUAL-CHECKS AAC-2b).
        UserDefaults.standard.register(defaults: [
            "WebContinuousSpellCheckingEnabled": true
        ])
        // Observability slice 4: FIRST, before anything that could fail —
        // the sink and the crash handlers are what make the rest of this
        // launch legible on a Mac nobody is watching.
        Self.installErrorSink()
        Self.purgeLegacyKeychainToken()
        installMainMenu()

        // Slice 92: focus changes are reported for the whole server attempt
        // (decision 3.2) — under real AAC losing focus should be impossible,
        // which is exactly what makes it worth a teacher's glance when it
        // happens; under the simulated session it is rehearsable today. The
        // handlers gate on the reporter, so outside an attempt this is inert.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidResignActive),
            name: NSApplication.didResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Secure Test"
        // Batch 4 slice D: the window's own ground is Pacific, so the frame
        // the student sees while a bundle loads, between screens, and after
        // "End secure session" is district colour rather than system grey
        // (James, 2026-09-07 — `docs/client-ui-pass-design.md` §D).
        window.backgroundColor = PSDColor.pacific
        // The minimum that keeps the entry card whole: the 520-pt card plus
        // its 24-pt margins either side, and enough height for the header,
        // the account row, three two-line sitting rows, the code row and the
        // status block. Below this the card would clip rather than reflow.
        window.contentMinSize = NSSize(width: 720, height: 620)
        window.center()
        self.window = window

        // Slice 66: a bundle passed on the command line skips the join flow.
        // Kept because it is how the renderer is exercised without a server —
        // the only way to look at an assessment in this environment. Inside
        // the sandbox the path must be in the app's own container; File →
        // Open Test Bundle… is the way in from anywhere else.
        if Self.hasOfflineBundleArgument {
            showAssessment(source: .file(Self.launchBundleURL))
        } else {
            showEntry()
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private static var hasOfflineBundleArgument: Bool {
        ProcessInfo.processInfo.arguments.contains("--bundle")
    }

    /// `--bundle <path>`, or the embedded sample when the flag dangles — the
    /// fallback the argv path has always had.
    private static var launchBundleURL: URL? {
        if let path = OfflineBundle.argumentPath(in: ProcessInfo.processInfo.arguments) {
            return URL(fileURLWithPath: path)
        }
        let sample = Bundle.main.url(forResource: "sample-delivery", withExtension: "json")
        if sample != nil { log("bundle source: embedded sample") }
        return sample
    }

    /// File → Open Test Bundle… (Cmd-O). An NSOpenPanel is the one way a
    /// sandboxed app gets to read a file outside its container without a
    /// broader entitlement: `files.user-selected.read-only` (synthesized from
    /// `ENABLE_USER_SELECTED_FILES = readonly`, never Xcode's capability UI —
    /// slice 93) covers exactly the URL the user picked, for this launch.
    /// The pick lands on the same offline `.file` path as `--bundle`: no
    /// attempt, no reporter, no lockdown.
    @objc private func openTestBundle() {
        guard OfflineBundle.canOpen(on: screen), let window else {
            Self.log("open test bundle refused: a server-delivered attempt is on screen")
            return
        }
        let panel = NSOpenPanel()
        panel.title = "Open Test Bundle"
        panel.message = "Choose a delivery bundle (.\(OfflineBundle.fileExtension)) to open offline."
        panel.allowedContentTypes = [UTType(filenameExtension: OfflineBundle.fileExtension) ?? .json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let url = panel.url else {
                Self.log("open test bundle: cancelled")
                return
            }
            // Re-checked after the sheet: the state could have moved while
            // it was up (a code-entry join completing, for one).
            guard OfflineBundle.canOpen(on: self.screen) else {
                Self.log("open test bundle refused: a server-delivered attempt is on screen")
                return
            }
            Self.log("open test bundle: \(url.path)")
            self.showAssessment(source: .file(url))
        }
    }

    /// Slice 80 (presenter swapped in UX pass 2 slice 9): sign-in is Google
    /// OIDC + PKCE through our own WKWebView on a non-persistent data store
    /// (`WebViewAuthPresenter`), configured by
    /// SECURE_TEST_GOOGLE_CLIENT_ID or `--google-client-id <id>`. Without a
    /// client id the app keeps the dev/CI posture from slice 66: a session JWT
    /// from `--token <jwt>` or SECURE_TEST_TOKEN goes into the in-memory store and the
    /// sign-in button is not shown.
    /// Deletes the session token earlier builds kept in the Keychain
    /// (`KeychainTokenStore`, retired 2026-08-31 when the store went
    /// in-memory). One shot at launch; without it a Mac that ran an old
    /// build keeps a live bearer credential on disk forever.
    private static func purgeLegacyKeychainToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "net.psd401.securetest.client",
            kSecAttrAccount as String: "session",
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess {
            log("legacy keychain session token purged")
        } else if status != errSecItemNotFound {
            log("legacy keychain purge failed: \(status)")
        }
    }

    private func seedTokenFromLaunchArgumentsIfPresent() {
        let args = ProcessInfo.processInfo.arguments
        var supplied: String?
        if let flag = args.firstIndex(of: "--token"), args.indices.contains(flag + 1) {
            supplied = args[flag + 1]
        } else if let fromEnv = ProcessInfo.processInfo.environment["SECURE_TEST_TOKEN"] {
            supplied = fromEnv
        }
        guard let supplied, !supplied.isEmpty else { return }
        do {
            try tokens.store(supplied)
            Self.log("session token seeded (in-memory, this process only)")
        } catch {
            Self.log("could not store token: \(error)")
        }
    }

    /// The Google OAuth client id for the NATIVE client (an iOS/macOS-type
    /// client in Google Cloud — it has no secret, and its redirect is the
    /// reverse-client-id scheme). Distinct from the design tool's web client;
    /// the server lists both in OIDC_AUDIENCE (slice 77).
    private static var googleClientID: String? {
        let args = ProcessInfo.processInfo.arguments
        if let flag = args.firstIndex(of: "--google-client-id"), args.indices.contains(flag + 1) {
            return args[flag + 1]
        }
        let fromEnv = ProcessInfo.processInfo.environment["SECURE_TEST_GOOGLE_CLIENT_ID"] ?? ""
        return fromEnv.isEmpty ? nil : fromEnv
    }

    private func showEntry() {
        // 10.3: arriving here from Back to your tests (or any later caller)
        // tears the attempt surface down completely.
        backToTestsAccessory?.removeFromParent()
        backToTestsAccessory = nil
        peekResponder?.stop()
        peekResponder = nil
        eventReporter = nil
        Self.activeEventReporter = nil
        // Slice 4: no attempt is open, so neither an error line nor a crash
        // line should claim one.
        ClientErrorLog.shared?.attemptID = nil
        CrashReporter.prepare(stamp: Self.buildStamp, attemptID: nil)
        controller = nil
        attemptHandedIn = false
        seedTokenFromLaunchArgumentsIfPresent()
        let client = APIClient(
            baseURL: Self.serverBaseURL,
            transport: URLSessionTransport(),
            tokens: tokens
        )

        var signIn: (() async throws -> SignedInSession)?
        if let clientID = Self.googleClientID {
            let presenter = WebViewAuthPresenter(window: window)
            let flow = GoogleSignInFlow(
                config: .google(clientID: clientID),
                transport: URLSessionTransport(),
                api: client,
                present: { url, scheme in try await presenter.present(url, callbackScheme: scheme) },
                log: Self.log
            )
            signIn = { try await flow.signIn() }
            Self.log("google sign-in configured for client \(clientID.prefix(8))…")
        } else {
            Self.log("no SECURE_TEST_GOOGLE_CLIENT_ID — sign-in button hidden; token from --token / SECURE_TEST_TOKEN only")
        }

        let entry = SessionEntryViewController(client: client, signIn: signIn, log: Self.log) { [weak self] assessmentID, attemptID in
            self?.showAssessment(
                source: .server(
                    client: client,
                    assessmentID: assessmentID,
                    attemptID: attemptID
                )
            )
        }
        // Slice 4: the drain runs after a sign-in succeeds — and once here,
        // for the dev/CI path where `--token` seeded a session already.
        entry.onSignedIn = { [weak self] in
            self?.drainClientErrors(using: client)
        }
        self.entry = entry
        window?.contentView = entry.view
        screen = .entry
        drainClientErrors(using: client)
    }

    private func showAssessment(source: AssessmentViewController.Source) {
        let controller = AssessmentViewController(source: source, log: Self.log)
        let isServerDelivered: Bool
        if case .server(let client, _, let attemptID) = source {
            isServerDelivered = true
            // Slice 92: the reporter lives exactly as long as the attempt is
            // the thing on screen. The offline --bundle path stays silent.
            eventReporter = AttemptEventReporter(api: client, attemptID: attemptID, log: Self.log)
            Self.activeEventReporter = eventReporter
            // Slice 4: from here an error line names the attempt, and so does
            // the crash line — which is re-prepared because a signal handler
            // cannot read the id at the time it fires.
            ClientErrorLog.shared?.attemptID = attemptID
            CrashReporter.prepare(stamp: Self.buildStamp, attemptID: attemptID)
            peekResponder?.stop()
            peekResponder = makePeekResponder(client: client, attemptID: attemptID, controller: controller)
            peekResponder?.start()
        } else {
            isServerDelivered = false
            eventReporter = nil
            Self.activeEventReporter = nil
            peekResponder?.stop()
            peekResponder = nil
        }
        attemptHandedIn = false
        controller.onBundleLoaded = { [weak self] bundle in
            self?.setClipboardAllowed(bundle.allowClipboard)
            // AAC-2b: resolve this attempt's session knobs before the begin
            // that reads them.
            self?.lockdownPlan = LockdownConfigurationPlan(accommodations: bundle.accommodations)
            // AAC-1: lockdown wraps a server-delivered attempt, never the
            // offline --bundle path — that one exists to look at the renderer.
            if isServerDelivered {
                self?.beginLockdown()
            }
        }
        controller.onBackToTests = { [weak self] in
            Self.log("back to your tests pressed (in-page) — leaving the attempt screen")
            self?.showEntry()
        }
        controller.onHandedIn = { [weak self] in
            // Before endLockdown, so focus noise stops but the reporter is
            // still there for the lockdown_end the teardown produces.
            self?.attemptHandedIn = true
            // A submitted attempt has no screen worth peeking (the server
            // answers 409 to new requests); stop asking.
            self?.peekResponder?.stop()
            self?.endLockdown(reason: "hand-in confirmed")
        }
        self.controller = controller
        window?.contentView = controller.view
        screen = isServerDelivered ? .serverAttempt : .offlineBundle
    }

    /// On-demand peek (P2): the responder's callbacks land off-main (the poll
    /// completes on a Task executor), so everything AppKit hops to the main
    /// actor. Order inside the hop is the 6.6 contract: banner FIRST — and a
    /// runloop turn for it to draw — then the render, which captures the
    /// banner too, so the teacher's frame shows the student was told.
    private func makePeekResponder(
        client: APIClient,
        attemptID: String,
        controller: AssessmentViewController
    ) -> PeekResponder {
        let responder = PeekResponder(
            api: client,
            attemptID: attemptID,
            scheduler: DispatchLockdownScheduler.main,
            log: { Self.log("peek: \($0)") }
        )
        responder.onPeekRequested = { [weak self, weak controller, weak responder] pending in
            Task { @MainActor in
                guard let self, let controller, let responder, !self.attemptHandedIn else { return }
                controller.showPeekNotice("Your teacher is viewing your screen")
                DispatchQueue.main.async {
                    guard let frame = controller.renderPeekFrame() else {
                        Self.log("peek: render failed — nothing uploaded")
                        return
                    }
                    responder.deliver(peekID: pending.id, imageBase64: frame)
                    let time = DateFormatter.localizedString(
                        from: Date(), dateStyle: .none, timeStyle: .short
                    )
                    controller.showPeekNotice("Your teacher viewed your screen at \(time)")
                }
            }
        }
        return responder
    }

    // MARK: focus (slice 92)

    @objc private func appDidResignActive() {
        guard let reporter = eventReporter, !attemptHandedIn else { return }
        Self.log("app lost focus during an attempt")
        reporter.report(.focusLoss)
    }

    @objc private func appDidBecomeActive() {
        guard let reporter = eventReporter, !attemptHandedIn else { return }
        Self.log("app regained focus during an attempt")
        reporter.report(.focusRegained)
    }

    // MARK: lockdown (AAC-1 lifecycle; AAC-2a real session)

    /// One controller for the app's lifetime; its state machine returns to
    /// idle after every end, so attempts can follow each other.
    ///
    /// AAC-2a: which session backs it is decided per begin(), in order:
    ///   1. `SECURE_TEST_SIMULATE_LOCKDOWN` set → simulated, with that
    ///      behaviour. Rehearsals stay possible on any build, entitled or not.
    ///   2. The binary carries the AAC entitlement → `RealLockdownSession`.
    ///      THE MAC ACTUALLY LOCKS. Every exit path this machine enforces is
    ///      now load-bearing.
    ///   3. Otherwise → simulated, cooperative. A CI or unentitled dev build
    ///      falls back by design rather than failing begin().
    private func makeLockdown() -> AssessmentLockdown {
        let lockdown = AssessmentLockdown(
            timings: .fromEnvironment(ProcessInfo.processInfo.environment),
            scheduler: DispatchLockdownScheduler.main,
            backstopScheduler: DispatchLockdownScheduler.backstop,
            makeSession: { [weak self] in
                // AAC-2b: logged for every backing — a simulated rehearsal
                // audits the same plan line a real session would apply.
                let plan = self?.lockdownPlan ?? .restrictive
                Self.log("lockdown config plan: \(plan.logDescription)")
                let env = ProcessInfo.processInfo.environment
                if env["SECURE_TEST_SIMULATE_LOCKDOWN"] != nil {
                    Self.log("lockdown session: SIMULATED (SECURE_TEST_SIMULATE_LOCKDOWN override)")
                    return SimulatedLockdownSession(
                        behaviour: SimulatedLockdownSession.behaviourFromEnvironment(env)
                    )
                }
                if RealLockdownSession.binaryHasEntitlement {
                    Self.log("lockdown session: REAL AEAssessmentSession (entitled binary) — the Mac will lock")
                    return RealLockdownSession(plan: plan)
                }
                Self.log("lockdown session: SIMULATED (no AAC entitlement in this binary)")
                return SimulatedLockdownSession(behaviour: .cooperative)
            }
        )
        lockdown.onLog = { Self.log("lockdown: \($0)") }
        // Slice 92: the lifecycle, in wire terms, to the teacher monitor.
        // Fire-and-forget by contract — nothing here waits on the network.
        lockdown.onSessionEvent = { [weak self] event in
            self?.eventReporter?.report(event)
        }
        // The watchdog forcing an end is an emergency exit as a teacher reads
        // it (decision 3.1), distinct from the lockdown_end that follows.
        lockdown.onWatchdogExpired = { [weak self] in
            self?.eventReporter?.report(.emergencyExit, detail: ["via": "watchdog"])
        }
        // State can change from the backstop queue (a grace-expired teardown
        // clears there), so every AppKit touch hops to the main actor.
        lockdown.onState = { [weak self] state in
            Task { @MainActor in
                self?.lockdownStateChanged(state)
            }
        }
        lockdown.onCountdown = { [weak self] remaining in
            guard remaining <= 60 else { return }
            Task { @MainActor in
                self?.lockdownStatusLabel?.stringValue = "auto-ends in \(Int(remaining))s"
            }
        }
        // Fires on the BACKSTOP queue with the main thread presumed gone;
        // process exit is the only safe reach (PoC-A finding #11's lesson).
        lockdown.onUnrecoverable = {
            Self.log("lockdown UNRECOVERABLE — exiting")
            // Slice 4: the ONE line this exit can leave behind. Same
            // mechanism as the signal handlers — a pre-formatted buffer
            // written to an already-open descriptor — because the main
            // thread is presumed gone and nothing else would survive.
            CrashReporter.writeUnrecoverableLine()
            exit(70)
        }
        return lockdown
    }

    private func beginLockdown() {
        if lockdown == nil { lockdown = makeLockdown() }
        lockdown?.begin()
    }

    private func endLockdown(reason: String) {
        guard let lockdown, lockdown.isActive else { return }
        Self.log("lockdown ending: \(reason)")
        lockdown.endBeforeTeardown {}
    }

    private func lockdownStateChanged(_ state: AssessmentLockdown.State) {
        switch state {
        case .idle:
            endSessionItem?.isEnabled = false
            lockdownAccessory?.removeFromParent()
            lockdownAccessory = nil
            lockdownStatusLabel = nil
            // 10.3: the session is down; on a shared Mac the next student
            // needs a way back without Cmd-Q + relaunch.
            installBackToTestsAccessoryIfNeeded()
            presentSessionEndedSheetIfNeeded()
        case .starting, .active:
            endSessionItem?.isEnabled = true
            installLockdownAccessoryIfNeeded()
            lockdownStatusLabel?.stringValue =
                state == .starting ? "secure session starting…" : "secure session active"
        }
    }

    /// The always-visible, truthfully-labelled way out (AAC-1 decision 2.3).
    /// It ends the SESSION, not the attempt — answers stay spooled and the
    /// student can keep working unlocked; the [security] log records it.
    private func installLockdownAccessoryIfNeeded() {
        guard lockdownAccessory == nil, let window else { return }
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 28))
        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 11)
        label.textColor = PSDColor.inkSoft
        label.alignment = .right
        label.frame = NSRect(x: 0, y: 6, width: 170, height: 16)
        view.addSubview(label)
        // Slice D: the same Whulge primary as the entry screen's Join. It is
        // the only action in the titlebar during a session, and the exit path
        // should be the most findable thing there. Title, target, action and
        // the Cmd-E companion are unchanged — this is styling only.
        let button = PSDPrimaryButton(
            title: "End secure session",
            target: self,
            action: #selector(emergencyEndLockdown)
        )
        button.setAccessibilityLabel("End secure session")
        button.frame = NSRect(x: 178, y: 1, width: 136, height: 24)
        view.addSubview(button)

        let accessory = NSTitlebarAccessoryViewController()
        accessory.view = view
        accessory.layoutAttribute = .right
        window.addTitlebarAccessoryViewController(accessory)
        lockdownAccessory = accessory
        lockdownStatusLabel = label
    }

    /// UX pass 2 slice 6 (10.3): after the session is down (hand-in or an
    /// emergency end) there was no route back to "Your tests" — Cmd-Q and
    /// relaunch was the only path (noticed live 2026-08-29 and again on the
    /// 2026-08-31 hand-run, where it pushed a student into handing in from
    /// the non-secure window).
    private func installBackToTestsAccessoryIfNeeded() {
        guard backToTestsAccessory == nil, let window, screen == .serverAttempt else { return }
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 150, height: 28))
        // Slice D: primary — after the session is down this IS the next step.
        let button = PSDPrimaryButton(
            title: "Back to your tests",
            target: self,
            action: #selector(backToTests)
        )
        button.setAccessibilityLabel("Back to your tests")
        button.frame = NSRect(x: 0, y: 1, width: 144, height: 24)
        view.addSubview(button)
        let accessory = NSTitlebarAccessoryViewController()
        accessory.view = view
        accessory.layoutAttribute = .right
        window.addTitlebarAccessoryViewController(accessory)
        backToTestsAccessory = accessory
    }

    /// UX pass 2 (James, 2026-08-31 hand-run): after an emergency end the
    /// titlebar button alone is too subtle — a centered sheet makes the
    /// choice explicit. Hand-in does NOT get the sheet; its in-page button
    /// beside the handed-in notice is the route there.
    private func presentSessionEndedSheetIfNeeded() {
        guard screen == .serverAttempt, !attemptHandedIn, !quitInProgress, let window else { return }
        let alert = NSAlert()
        alert.messageText = "Secure session ended"
        alert.informativeText =
            "Your answers are saved. You can keep working here, or go back to your tests."
        alert.addButton(withTitle: "Back to your tests")
        alert.addButton(withTitle: "Stay here")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn {
                self?.backToTests()
            }
        }
    }

    @objc private func backToTests() {
        Self.log("back to your tests pressed — leaving the attempt screen")
        showEntry()
    }

    @objc private func emergencyEndLockdown() {
        // Slice 92 closes the AAC-1 TODO here: the button now shows up on the
        // teacher's monitor as well as in the [security] log.
        eventReporter?.report(.emergencyExit, detail: ["via": "button"])
        endLockdown(reason: "emergency end control pressed")
    }

    /// Cmd-Q during an active session is ALLOWED (decision 2.1): the session
    /// ends first, then the quit is re-issued from the confirmation. Returning
    /// `.terminateLater` and waiting would starve the main queue and hang the
    /// app with the session live (PoC-A RESULTS finding #11) — hence cancel
    /// and re-issue.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Slice 92 closes the AAC-1 TODO here: a quit mid-attempt is reported
        // whether or not the lockdown is still up (a student who pressed the
        // emergency button and then quit is still a quit mid-attempt).
        // Best-effort by design — the post gets whatever runloop time the
        // teardown leaves it and is never waited for; a delayed exit would be
        // worse than a lost event.
        if !terminatingAfterLockdown, eventReporter != nil, !attemptHandedIn {
            eventReporter?.report(.quit, detail: ["via": "terminate"])
        }
        guard let lockdown, lockdown.isActive, !terminatingAfterLockdown else {
            return .terminateNow
        }
        quitInProgress = true
        Self.log("quit requested with lockdown active — ending the session first")
        lockdown.endBeforeTeardown { [weak self] in
            // The confirmed path lands on main; the grace-expired path lands
            // on the backstop queue — hop, and if main is truly gone the
            // onUnrecoverable exit already covers it.
            Task { @MainActor in
                self?.terminatingAfterLockdown = true
                NSApp.terminate(nil)
            }
        }
        return .terminateCancel
    }

    /// Menu items are pinned by `isEnabled` and the menu's autoenabling is
    /// switched off, so AppKit cannot quietly re-enable them from the responder
    /// chain the moment a text field takes focus — which is exactly what it does
    /// by default.
    func setClipboardAllowed(_ allowed: Bool) {
        NSApp.mainMenu?.items
            .first { $0.submenu?.title == "Edit" }?
            .submenu?.autoenablesItems = allowed
        for item in clipboardItems {
            item.isEnabled = allowed
        }
        Self.log("clipboard \(allowed ? "enabled" : "disabled") for this assessment")
    }

    static var serverBaseURL: URL {
        let raw = ProcessInfo.processInfo.environment["SECURE_TEST_SERVER"]
            ?? "http://localhost:3000"
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Security-relevant events go to stderr with a `[security]` prefix, the
    /// same channel PoC-B used so blocked navigations are visible while
    /// developing. Slice 64 routes these to the server alongside responses.
    ///
    /// `nonisolated` because the project builds with
    /// SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor and this is passed as an
    /// escaping closure into non-isolated contexts. Writing to a file
    /// descriptor needs no actor.
    nonisolated static func log(_ message: String) {
        FileHandle.standardError.write(Data("[security] \(message)\n".utf8))
    }

    // MARK: errors (observability slice 4)

    /// Open `errors.log` and arm the crash handlers.
    ///
    /// Failure here is not fatal and must not be: a student whose container
    /// is unwritable still gets the whole app, just without the file. Every
    /// `logError` call still reaches stderr in that case.
    private static func installErrorSink() {
        do {
            let sink = try ClientErrorLog(
                fileURL: ClientErrorLog.defaultFileURL(),
                stamp: buildStamp
            )
            // The `[security]` channel keeps showing everything it showed
            // before this slice; the file is an addition, not a move.
            sink.echo = { message in AppDelegate.log(message) }
            // D-4: an error hit WHILE an attempt is open also goes to the
            // teacher's monitor, fire-and-forget. Outside an attempt there is
            // no reporter and the file is the only channel — which is the
            // whole reason the file exists.
            sink.onRecord = { entry in
                AppDelegate.activeEventReporter?.report(
                    .clientError,
                    detail: ["kind": entry.kind, "message": entry.message]
                )
            }
            ClientErrorLog.shared = sink
            CrashReporter.install(log: sink, stamp: buildStamp)
            log("errors.log open at \(sink.fileURL.path)")
        } catch {
            log("errors.log unavailable (\(error)) — errors go to stderr only")
        }
    }

    /// The companion to `log`: one JSON line in `errors.log`, the same text on
    /// stderr, and — when an attempt is open — a `client_error` event on the
    /// teacher's monitor.
    ///
    /// `kind` is a short stable token (`join_failed`, `submit_failed`), not
    /// prose; `message` is what went wrong, truncated by the sink. Redaction
    /// rule from the design page: never response text, stems, choices, names
    /// or tokens — ids, statuses and error descriptions only.
    nonisolated static func logError(
        kind: String,
        message: String,
        context: [String: String] = [:]
    ) {
        guard let sink = ClientErrorLog.shared else {
            log("\(kind): \(message)")
            return
        }
        sink.record(kind: kind, message: message, context: context)
    }

    /// Send whatever `errors.log` collected while nobody was signed in.
    ///
    /// This is the only moment the client HAS a session token for errors that
    /// happened without one: the sign-in screen's failures, a failed join, and
    /// the previous launch's crash line. Detached and never awaited — a slow
    /// or dead server must not hold the entry screen.
    private func drainClientErrors(using client: APIClient) {
        guard let sink = ClientErrorLog.shared else { return }
        Task.detached(priority: .utility) {
            guard await client.isSignedIn() else { return }
            await ClientErrorDrain.drain(
                log: sink,
                api: client,
                report: { AppDelegate.log("errors: \($0)") }
            )
        }
    }

    /// The hand-run's crash trigger (`SECURE_TEST_DEBUG_CRASH=1`). Gated on
    /// the environment variable at menu-build time, so a shipped app has no
    /// menu item at all rather than a disabled one.
    private static var debugCrashEnabled: Bool {
        ProcessInfo.processInfo.environment["SECURE_TEST_DEBUG_CRASH"] == "1"
    }

    @objc private func triggerDebugCrash() {
        Self.log("SECURE_TEST_DEBUG_CRASH — raising SIGABRT on purpose")
        CrashReporter.triggerDebugCrash()
    }

    /// The standard About panel, with the build stamp in the version line.
    ///
    /// `.version` is set to "" on purpose: AppKit renders `.applicationVersion`
    /// and `.version` as two lines ("Version X (Y)"), and the build already
    /// carries its sha inside `applicationVersion`, so the second line would
    /// only repeat `CURRENT_PROJECT_VERSION`.
    @objc private func showAboutPanel() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Secure Test",
            .applicationVersion: AppVersion.buildStamp,
            .version: "",
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Minimal menu. Cut/Copy/Paste/Select All bind to the standard responder
    /// chain selectors so text fields behave normally.
    ///
    /// No Undo/Redo: PoC-B left them out deliberately — typical assessment
    /// interactions do not need them and they widen the surface.
    ///
    /// Slice 69: Cut/Copy/Paste start DISABLED and are enabled only if the
    /// bundle says the assessment permits the clipboard. Building them enabled
    /// and switching off later would leave a window, however short, in which the
    /// shortcuts worked.
    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        // About: the only place the build identifies itself. Version reads
        // "1.0.0 (<git sha>)" — the sha is what an error report or a hand-run
        // row needs to name the exact binary (client-release-plan.md slice 1).
        let about = appMenu.addItem(
            withTitle: "About Secure Test",
            action: #selector(showAboutPanel),
            keyEquivalent: ""
        )
        about.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Secure Test",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // File → Open Test Bundle… — the offline path from anywhere on disk.
        // Autoenabling off and `isEnabled` pinned from `screen`, so AppKit
        // cannot re-enable it from the responder chain while a server attempt
        // is up (the same reason the clipboard items are pinned).
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.autoenablesItems = false
        let open = fileMenu.addItem(
            withTitle: "Open Test Bundle…",
            action: #selector(openTestBundle),
            keyEquivalent: "o"
        )
        open.target = self
        open.isEnabled = OfflineBundle.canOpen(on: screen)
        openBundleItem = open
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // Session → End Secure Session (Cmd-E): the keyboard path to the
        // same truthfully-labelled exit as the titlebar button (AAC-1
        // decision 2.3 — it ends the SESSION, not the attempt).
        let sessionMenuItem = NSMenuItem()
        let sessionMenu = NSMenu(title: "Session")
        sessionMenu.autoenablesItems = false
        let endSession = sessionMenu.addItem(
            withTitle: "End Secure Session",
            action: #selector(emergencyEndLockdown),
            keyEquivalent: "e"
        )
        endSession.target = self
        endSession.isEnabled = false
        endSessionItem = endSession
        // Observability slice 4: the crash path cannot be unit-tested (a
        // raised SIGSEGV takes the test runner with it), so it is hand-run
        // instead — and needs a way to be raised on purpose. Present ONLY
        // when SECURE_TEST_DEBUG_CRASH=1, so a shipped app has no such item.
        if Self.debugCrashEnabled {
            sessionMenu.addItem(.separator())
            let crash = sessionMenu.addItem(
                withTitle: "Trigger Debug Crash (SIGABRT)",
                action: #selector(triggerDebugCrash),
                keyEquivalent: ""
            )
            crash.target = self
            crash.isEnabled = true
        }
        sessionMenuItem.submenu = sessionMenu
        mainMenu.addItem(sessionMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        let cut = editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        let copy = editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        let paste = editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        clipboardItems = [cut, copy, paste]
        setClipboardAllowed(false)
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApp.mainMenu = mainMenu
    }
}
