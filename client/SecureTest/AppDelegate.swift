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
    /// C-4 / D-7: Actual Size / Zoom In / Zoom Out. Pinned by `isEnabled` from
    /// `screen` like the File and clipboard items — there is nothing to zoom on
    /// the entry screen, and autoenabling is off on this menu.
    private var zoomItems: [NSMenuItem] = []
    private var screen: OfflineBundle.Screen = .entry {
        didSet {
            openBundleItem?.isEnabled = OfflineBundle.canOpen(on: screen)
            let onAssessment = screen != .entry
            zoomItems.forEach { $0.isEnabled = onAssessment }
        }
    }
    /// In memory on purpose (James, 2026-08-31, follow-on to UX pass 2
    /// slice 9): the session JWT dies with the process, so every launch
    /// starts signed out and forces a real Google sign-in (prompt=login).
    /// A crash mid-test therefore costs a full re-auth before Resume —
    /// accepted; on a shared lab Mac nothing may outlive the process.
    /// The Keychain-backed store this replaces is purged at launch.
    private let tokens = InMemoryTokenStore()
    private var lockdown: AssessmentLockdown?
    /// C-1: this attempt's page-load gate, opened when the lockdown session
    /// becomes active. One per `showAssessment`; nil on the offline path.
    private var pageLoadGate: PageLoadGate?
    /// Security slice 1: did THIS attempt's session ever reach `.active`? Set
    /// on the main actor, where the lockdown's states are ordered, so the
    /// `.idle` that ends a legitimate session can never be mistaken for a
    /// begin() that failed. Reset with the gate, per attempt.
    private var lockdownBecameActive = false
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
    /// Time limit slice 2 (`docs/time-limit-and-unfinished-attempts-design.md`,
    /// D-2 / D-3): this attempt's clock, or nil when the assessment has no
    /// limit. One per attempt, started from the bundle's deadline and stopped
    /// when the attempt leaves the screen.
    private var countdown: TimeLimitCountdown?
    /// Set when the countdown reached zero, so the session-ended sheet reads
    /// "Time is up." instead of the ordinary copy.
    private var sessionEndedByTimeLimit = false
    /// One session-ended sheet per attempt screen. The time-limit path can
    /// reach `presentSessionEndedSheetIfNeeded` both through the lockdown's
    /// `.idle` state and directly (a session that was never active), and two
    /// stacked sheets would be worse than either.
    private var sessionEndedSheetShown = false

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
        // Security slice 2: which posture this binary was built in, before any
        // of the gated paths below could confuse a reader of the log.
        Self.log(BuildPosture.logLine)
        Self.purgeLegacyKeychainToken()
        Self.resolveConfiguration()
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
        // Fix slice S-8: lets AppKit hand this window into full screen —
        // required for `toggleFullScreen(nil)` below to have any effect.
        window.collectionBehavior.insert(.fullScreenPrimary)
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
        enterFullScreenAtLaunchIfNeeded()
    }

    /// Fix slice S-8 (2026-09-08 sitting): the main window goes full screen
    /// as soon as it is on screen — at launch, and again as a backstop when a
    /// lockdown session becomes active. Guarded on `styleMask` rather than a
    /// one-shot flag, so calling it twice (launch, then lockdown begin) is
    /// idempotent by construction: `toggleFullScreen` only ever runs the
    /// zero-to-one transition, never one-to-zero. The AAC session is what
    /// actually locks the Mac (`RealLockdownSession` / the watchdog / the
    /// exit paths above) — this only removes the windowed chrome and the
    /// stray-click-to-Finder surface between attempts; exiting full screen
    /// (green button, Esc-equivalent gesture) is never blocked by the app.
    /// `SECURE_TEST_NO_FULLSCREEN=1` skips this entirely, for `--bundle` /
    /// dev runs where a full-screen relaunch loop is just friction
    /// (documented in `client/README.md`).
    private func enterFullScreenAtLaunchIfNeeded() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        // Security slice 2: Debug only. In Release the knob is not read at all,
        // so a Terminal launch cannot keep the window small enough to leave the
        // Finder reachable around it.
        if BuildPosture.allowsDevelopmentOverrides,
           ProcessInfo.processInfo.environment["SECURE_TEST_NO_FULLSCREEN"] == "1" {
            Self.log("SECURE_TEST_NO_FULLSCREEN=1 — staying windowed")
            return
        }
        window.toggleFullScreen(nil)
    }

    /// Security slice 2: `--bundle` is Debug only. In Release the argument is
    /// ignored entirely and the app starts on the entry screen as usual — the
    /// offline path renders assessment content with no session behind it.
    private static var hasOfflineBundleArgument: Bool {
        guard BuildPosture.allowsOfflineBundle else {
            if ProcessInfo.processInfo.arguments.contains("--bundle") {
                log("--bundle ignored: offline bundles are development-only")
            }
            return false
        }
        return ProcessInfo.processInfo.arguments.contains("--bundle")
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
        // Security slice 2: the menu item does not exist in Release, so this
        // can only be reached in Debug — belt and braces for a stray sender.
        guard BuildPosture.allowsOfflineBundle else { return }
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
        // Security slice 2: a seeded bearer token is a dev/CI affordance — in
        // Release the only way to a session is Google sign-in.
        guard BuildPosture.allowsDevelopmentOverrides else { return }
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

    /// Where this Mac's server origin and Google client id come from
    /// (`ClientConfiguration`, 2026-09-11): launch arguments, then the
    /// environment, then the managed preferences an MDM configuration profile
    /// writes into this app's preference domain — in a RELEASE build that order
    /// is inverted and the managed preference wins (security slice 2). The Google client id is the
    /// NATIVE client (an iOS/macOS-type client in Google Cloud — no secret,
    /// redirect is the reverse-client-id scheme), distinct from the design
    /// tool's web client; the server lists both in OIDC_AUDIENCE (slice 77).
    ///
    /// A Finder or Jamf launch supplies neither argument nor environment, which
    /// is why the profile exists — see `client/RELEASING.md`, "Configuration
    /// profile". There is no localhost fallback: unconfigured is a state the
    /// entry screen names rather than a silent connection to nothing.
    private static var resolvedConfiguration: ClientConfiguration?

    static var configuration: ClientConfiguration {
        resolvedConfiguration ?? resolveConfiguration()
    }

    /// Resolves once at launch and logs one line per value naming the source,
    /// so a Mac that comes up blank says why on stderr.
    @discardableResult
    private static func resolveConfiguration() -> ClientConfiguration {
        let resolved = ClientConfiguration(
            arguments: ProcessInfo.processInfo.arguments,
            environment: ProcessInfo.processInfo.environment,
            // A `Forced` payload from a configuration profile surfaces through
            // the standard defaults like any other value, inside the sandbox
            // too — nothing else is needed to read one.
            defaults: { UserDefaults.standard.string(forKey: $0) },
            // Security slice 2: in Release a Jamf-forced ServerURL /
            // GoogleClientID outranks `--server` and the environment, so a
            // student cannot point a managed Mac at a server of their own.
            // A dev Mac has no profile, so Debug's historical order (argument,
            // environment, then preference) is unchanged.
            managedPreferenceWins: BuildPosture.managedPreferenceWins
        )
        resolvedConfiguration = resolved
        for line in resolved.logLines { log(line) }
        return resolved
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
        // Security slice 1 (2026-09-15): the controller is told it is gone
        // BEFORE the reference is dropped. `WKUserContentController` retains
        // its message handlers, so dropping the reference does not deallocate
        // it — without this a page-load gate that opens late (an emergency end
        // raced against a slow begin()) would still build the test into the
        // detached view. Answers already spooled are untouched: the spool is a
        // SQLite file in Application Support, written before it is sent, and
        // the next attempt's flush carries whatever is still queued.
        controller?.retire()
        controller = nil
        attemptHandedIn = false
        // Time limit: the attempt is gone, and so is its clock.
        countdown?.stop()
        countdown = nil
        sessionEndedByTimeLimit = false
        sessionEndedSheetShown = false
        let config = Self.configuration
        // A seeded token is a credential for a server; with none configured it
        // has nothing to authenticate against, so the app stays in the
        // unconfigured state rather than half-signed-in against nowhere.
        if config.serverURL != nil {
            seedTokenFromLaunchArgumentsIfPresent()
        }
        // With no server URL the client is never exercised: `signIn` is nil,
        // no token is seeded, so the entry screen shows the not-configured
        // message and reaches nothing. The placeholder only exists because
        // `APIClient` takes a URL.
        let client = APIClient(
            baseURL: config.serverURL ?? Self.unconfiguredPlaceholderURL,
            transport: URLSessionTransport(),
            tokens: tokens
        )

        var signIn: (() async throws -> SignedInSession)?
        if let clientID = config.googleClientID, config.serverURL != nil {
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

        let entry = SessionEntryViewController(
            client: client,
            signIn: signIn,
            configured: config.isFullyConfigured,
            log: Self.log
        ) { [weak self] assessmentID, attemptID in
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
        countdown?.stop()
        countdown = nil
        sessionEndedByTimeLimit = false
        sessionEndedSheetShown = false
        // C-1 (docs/multi-source-stimulus-design.md): one gate per attempt, set
        // on the controller BEFORE its fetch Task gets to run, so the page
        // builds after the AAC begin() transition has finished resizing the
        // window rather than during it. The offline path gets none. The student
        // sees the "Loading your test…" notice while it is shut.
        let gate = isServerDelivered ? PageLoadGate() : nil
        pageLoadGate = gate
        lockdownBecameActive = false
        controller.pageLoadGate = gate
        controller.onBundleLoaded = { [weak self] bundle in
            self?.setClipboardAllowed(bundle.allowClipboard)
            // AAC-2b: resolve this attempt's session knobs before the begin
            // that reads them.
            self?.lockdownPlan = LockdownConfigurationPlan(accommodations: bundle.accommodations)
            // AAC-1: lockdown wraps a server-delivered attempt, never the
            // offline --bundle path — that one exists to look at the renderer.
            if isServerDelivered {
                self?.beginLockdown()
                // Time limit (D-2): the deadline is computed from the bundle's
                // own two instants at RECEIPT — `ends_at − server_now` added to
                // this Mac's now — so a skewed clock counts the right number of
                // seconds. Absent on an assessment with no limit, and on the
                // offline path, where there is no attempt to run out.
                self?.startCountdownIfNeeded(for: bundle)
            } else {
                // C-1: no begin, so nothing will ever settle — never hold the
                // page for the backstop's sake.
                self?.openPageLoadGate()
            }
        }
        controller.onBackToTests = { [weak self] in
            Self.log("back to your tests pressed (in-page) — leaving the attempt screen")
            self?.showEntry()
        }
        // Security slice 1: the gate refused or never answered, so no test page
        // was built. Whatever is up comes down and the student goes home told.
        controller.onCouldNotStartSecurely = { [weak self] reason in
            self?.couldNotStartSecurely(reason)
        }
        controller.onTimerDismissed = { [weak self] in
            // D-3: the banner is hidden for the rest of the attempt. The clock
            // keeps running — the notices and the end of the session at zero
            // are not the student's to switch off.
            self?.countdown?.dismiss()
        }
        controller.onHandedIn = { [weak self] in
            // Time limit: handed in, so there is nothing left to run out.
            self?.countdown?.stop()
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

    // MARK: time limit (slice 2)

    /// Start this attempt's clock, if it has one.
    ///
    /// Everything the countdown decides — the text, the two notices, the danger
    /// colour, zero — lives in `TimeLimitCountdown` and is unit-tested; this is
    /// only where each decision is presented. The scheduler is the main-queue
    /// one, like the lockdown's own watchdog.
    private func startCountdownIfNeeded(for bundle: DeliveryBundle) {
        countdown?.stop()
        countdown = nil
        guard let deadline = bundle.deadline() else { return }
        Self.log("time limit: \(Int(deadline.timeIntervalSinceNow))s left on this attempt")
        let clock = TimeLimitCountdown(
            deadline: deadline,
            scheduler: DispatchLockdownScheduler.main
        )
        clock.onTick = { [weak self] text, danger in
            Task { @MainActor in
                self?.controller?.updateTimeLimit(text: text, danger: danger)
            }
        }
        clock.onNotice = { [weak self] notice in
            Task { @MainActor in
                Self.log("time limit: \(notice.text)")
                self?.controller?.showTimeNotice(notice.text)
            }
        }
        clock.onExpired = { [weak self] in
            Task { @MainActor in
                self?.timeLimitExpired()
            }
        }
        countdown = clock
        clock.start()
    }

    /// Zero (D-2). The secure session ends; the attempt does NOT hand itself in
    /// — it stays in progress so the teacher can review it, or hand it in for
    /// the student, from the design tool.
    private func timeLimitExpired() {
        Self.log("time limit reached — ending the secure session")
        sessionEndedByTimeLimit = true
        // The flag first: from here the server refuses this attempt's answers
        // with 409 `time_expired`, and those drops are expected rather than
        // reportable.
        controller?.timeExpired = true
        // Retried like the other lifecycle kinds — this is the event that
        // explains an unfinished attempt on the teacher's timeline.
        eventReporter?.report(.timeExpired)
        let wasActive = lockdown?.isActive == true
        endLockdown(reason: "time_expired")
        // A session that was never up (a failed begin, the cooperative
        // fallback) produces no `.idle` transition, so nothing else would send
        // the student home or tell them what happened.
        if !wasActive { returnHomeAfterSessionEnd() }
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
    ///   1. **Debug only** — `SECURE_TEST_SIMULATE_LOCKDOWN` set → simulated,
    ///      with that behaviour. Rehearsals stay possible on any dev build,
    ///      entitled or not.
    ///   2. The binary carries the AAC entitlement → `RealLockdownSession`.
    ///      THE MAC ACTUALLY LOCKS. Every exit path this machine enforces is
    ///      now load-bearing.
    ///   3. Otherwise → Debug falls back to a simulated cooperative session (an
    ///      unsigned dev build or CI); **Release refuses** with
    ///      `RefusedLockdownSession`, so a shipped app whose entitlement is
    ///      missing or stripped never renders a test on an unlocked Mac.
    ///
    /// Security slice 2 reordered 1 and 2 in substance: the simulate knob used
    /// to be read BEFORE the entitlement in every build, so a student could
    /// turn a real session into a cooperative fake from a Terminal launch.
    private func makeLockdown() -> AssessmentLockdown {
        let lockdown = AssessmentLockdown(
            // Security slice 2: the watchdog is a development backstop and is
            // NOT armed in Release. It counted from begin() and never reset, so
            // on the fleet it was ending real sittings at ten minutes.
            timings: .fromEnvironment(
                ProcessInfo.processInfo.environment,
                allowOverride: BuildPosture.allowsDevelopmentOverrides
            ),
            scheduler: DispatchLockdownScheduler.main,
            backstopScheduler: DispatchLockdownScheduler.backstop,
            makeSession: { [weak self] in
                // AAC-2b: logged for every backing — a simulated rehearsal
                // audits the same plan line a real session would apply.
                let plan = self?.lockdownPlan ?? .restrictive
                Self.log("lockdown config plan: \(plan.logDescription)")
                let env = ProcessInfo.processInfo.environment
                if BuildPosture.allowsDevelopmentOverrides,
                   env["SECURE_TEST_SIMULATE_LOCKDOWN"] != nil {
                    Self.log("lockdown session: SIMULATED (SECURE_TEST_SIMULATE_LOCKDOWN override)")
                    return SimulatedLockdownSession(
                        behaviour: SimulatedLockdownSession.behaviourFromEnvironment(env)
                    )
                }
                if RealLockdownSession.binaryHasEntitlement {
                    Self.log("lockdown session: REAL AEAssessmentSession (entitled binary) — the Mac will lock")
                    return RealLockdownSession(plan: plan)
                }
                guard BuildPosture.allowsUnentitledFallback else {
                    // Security slice 2: a Release build with no entitlement
                    // cannot lock this Mac, so it refuses to start a session at
                    // all. begin() reports failedToBegin, the page-load gate
                    // refuses, and slice 1 shows "Couldn't start a secure
                    // session" instead of the whole test on an unlocked Mac.
                    Self.log("lockdown session: REFUSED — no AAC entitlement in this RELEASE binary")
                    return RefusedLockdownSession(
                        reason: "no AAC entitlement in this build — a secure session cannot be started"
                    )
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
        // C-1: a cooperative simulated session is `.active` by the time begin()
        // returns (and begin() is a no-op while one is already up), so no
        // further state change is coming and nothing else would open the gate —
        // which is what keeps `SECURE_TEST_SIMULATE_LOCKDOWN`, the dev launcher
        // and every rehearsal working.
        //
        // Security slice 1: `.active` is now the ONLY state that opens it. A
        // synchronous failure to begin lands back on `.idle` and refuses.
        switch lockdown?.state {
        case .active: openPageLoadGate()
        case .idle: refusePageLoadGate()
        case .starting, nil: break
        }
    }

    /// Security slice 1: releases the page build. Called only for `.active`.
    /// Idempotent in the gate itself.
    ///
    /// The flag is what makes the ORDER safe. `open()` and `refuse()` each hop
    /// onto the gate's actor in their own Task, and two Tasks have no order
    /// between them — so a session that went `.active` and then straight back
    /// to `.idle` (an emergency end seconds after begin) could otherwise have
    /// its refusal land first and report a start that never failed. This is
    /// decided here, on the main actor, where the states genuinely are ordered.
    private func openPageLoadGate() {
        lockdownBecameActive = true
        guard let gate = pageLoadGate else { return }
        Task { await gate.open() }
    }

    /// Security slice 1: the session reached `.idle`. A no-op in the gate if it
    /// is already open — every session ends eventually, and the end of a
    /// legitimate one must not read as a failure to start — so this is only
    /// consequential for a begin() that failed or was interrupted before it
    /// ever became active, which is exactly the case that used to deliver the
    /// whole test to an unlocked Mac.
    private func refusePageLoadGate() {
        guard !lockdownBecameActive else { return }
        guard let gate = pageLoadGate else { return }
        Task { await gate.refuse() }
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
            // Security slice 1: if the page never built, this is a begin() that
            // failed or was interrupted — refuse it rather than letting the
            // backstop hand the test over. No-op once the page is legitimately
            // up, which is every ordinary end.
            refusePageLoadGate()
            // 10.3: after a HAND-IN the session goes down with the attempt
            // still on screen (the handed-in notice), so the titlebar route
            // home stays. Every other end sends the student home itself, just
            // below, and `showEntry` removes this accessory anyway.
            if attemptHandedIn { installBackToTestsAccessoryIfNeeded() }
            returnHomeAfterSessionEnd()
        case .starting, .active:
            // Security slice 1: `.active` — and nothing else — releases the
            // page build (C-1's reason for the gate is unchanged: the AAC
            // begin() transition has finished resizing the window by now).
            if state == .active { openPageLoadGate() }
            endSessionItem?.isEnabled = true
            installLockdownAccessoryIfNeeded()
            lockdownStatusLabel?.stringValue =
                state == .starting ? "secure session starting…" : "secure session active"
            // Fix slice S-8: DID BEGIN drives state to .active (AAC-1's
            // `AssessmentLockdown.handle(.didBegin)`) — if the launch-time
            // full screen somehow did not stick (a relaunch mid-flight, the
            // knob above, or AppKit declining), this is the second and last
            // chance, gated the same way.
            if state == .active { enterFullScreenAtLaunchIfNeeded() }
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

    /// Security slice 1 (James, 2026-09-15): **the test is on screen only while
    /// the assessment session is active.** After ANY end that is not a hand-in
    /// — the Cmd-E / titlebar emergency exit, the watchdog, an interruption,
    /// the time limit — the student goes back to "Your tests" and is told.
    ///
    /// This replaces the UX-pass-2 sheet, which offered "Stay here" beside
    /// "Back to your tests". The 2026-09-15 end-state audit is why: nothing but
    /// `showEntry()` ever removed assessment content from the window, so
    /// "Stay here" left the whole test — stems, sources, the student's answers
    /// — rendered on a Mac that was no longer locked, still saving. The copy
    /// that invited it ("You can keep working here") is gone with it.
    ///
    /// Hand-in is untouched: its session ends with the handed-in notice on
    /// screen and its own in-page "Back to your tests" button, and the
    /// `attemptHandedIn` guard below is what keeps it that way.
    ///
    /// `showEntry()` comes FIRST — it is the call that tears the web view down
    /// — and the sheet is then presented on the entry screen, so the student
    /// can never read the alert over their own test paper.
    private func returnHomeAfterSessionEnd() {
        guard screen == .serverAttempt, !attemptHandedIn, !quitInProgress, window != nil else {
            return
        }
        // Once per attempt screen: the time-limit path can arrive both through
        // `.idle` and directly (a session that was never active), and two
        // stacked sheets would be worse than either.
        guard !sessionEndedSheetShown else { return }
        sessionEndedSheetShown = true
        // Read before `showEntry()`, which resets it along with the rest of the
        // attempt's state.
        let byTimeLimit = sessionEndedByTimeLimit
        Self.log("secure session ended without a hand-in — leaving the test screen")
        let goHome: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            self.showEntry()
            let alert = NSAlert()
            if byTimeLimit {
                alert.messageText = "Time is up."
                alert.informativeText = "Your answers are saved."
            } else {
                alert.messageText = "Secure session ended"
                alert.informativeText = "Your answers are saved. You can rejoin from Your tests."
            }
            alert.addButton(withTitle: "OK")
            self.presentOnEntryWindow(alert)
        }
        // A field still holding focus has not posted yet (essay / short text
        // post on blur); flush it and the dirty drawings, then go. The Mac is
        // already unlocked for this beat — the page is modal-free but the
        // student cannot type anything the spool would miss again.
        if let controller {
            controller.flushPendingInput(then: goHome)
        } else {
            goHome()
        }
    }

    /// Security slice 1: the page-load gate refused or timed out, so the test
    /// was never built and never will be on this controller. End whatever is
    /// up, go home, say so — the same landing as every other end, because a
    /// student staring at "Loading your test…" forever is the failure mode this
    /// replaces.
    private func couldNotStartSecurely(_ reason: String) {
        Self.log("SECURE START REFUSED (\(reason)) — the test page was not built")
        Self.logError(
            kind: "secure_start_refused",
            message: "the assessment session never became active",
            context: ["reason": reason]
        )
        // A `.starting` session that never answered is still nominally up; the
        // 8.3 rule defers the physical end() to DID BEGIN, and the watchdog and
        // escalation stay armed either way.
        endLockdown(reason: "secure start refused: \(reason)")
        // Nothing is on screen worth keeping, and nothing about this attempt
        // should stay half-built. `showEntry()` also flips `screen` to `.entry`,
        // so the `.idle` that the end above produces arrives with the
        // return-home path already guarded and cannot stack a second sheet.
        showEntry()
        let alert = NSAlert()
        alert.messageText = "Couldn't start a secure session"
        alert.informativeText = "Your test didn't open. Ask your teacher for help."
        alert.addButton(withTitle: "OK")
        presentOnEntryWindow(alert)
    }

    /// One button, so Escape and Return both land on the same harmless
    /// dismissal. Presented on the window the entry screen now occupies.
    private func presentOnEntryWindow(_ alert: NSAlert) {
        guard let window else { return }
        alert.beginSheetModal(for: window) { _ in }
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

    /// Stands in for a server URL that was never configured. Nothing is ever
    /// sent to it — the entry screen shows the not-configured message and every
    /// path that would use the client is closed (`showEntry`) — but `APIClient`
    /// has to be handed some URL, and a reserved `.invalid` host cannot
    /// resolve, so a future path that slipped through fails loudly and offline
    /// rather than reaching a real host.
    static let unconfiguredPlaceholderURL = URL(string: "https://secure-test-not-configured.invalid")!

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
    /// Security slice 2: and on the build posture besides — the item cannot
    /// exist in a Release binary however the environment is set.
    private static var debugCrashEnabled: Bool {
        BuildPosture.allowsDevelopmentOverrides
            && ProcessInfo.processInfo.environment["SECURE_TEST_DEBUG_CRASH"] == "1"
    }

    @objc private func triggerDebugCrash() {
        Self.log("SECURE_TEST_DEBUG_CRASH — raising SIGABRT on purpose")
        CrashReporter.triggerDebugCrash()
    }

    /// C-4 / D-7: the Session menu's zoom items, forwarded to whichever
    /// assessment controller is on screen. Nil is not an error — the items are
    /// disabled off the assessment screens, and a stale key press is a no-op.
    @objc private func zoomInPage() { controller?.zoomIn() }

    @objc private func zoomOutPage() { controller?.zoomOut() }

    @objc private func zoomActualSize() { controller?.actualSize() }

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
        //
        // Security slice 2: the item — and with it the whole File menu, which
        // holds nothing else — is absent in Release. Offline rendering has no
        // attempt, no lockdown and no reporting behind it, so Cmd-O in a
        // shipped app is a way to put assessment content on an unlocked Mac.
        if BuildPosture.allowsOfflineBundle {
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
        }

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
        // C-4 / D-7 (docs/multi-source-stimulus-design.md): the keyboard half of
        // pinch-to-zoom. These route through the MENU, like Cmd-E, so the
        // shortcuts still reach the host inside a real AAC session rather than
        // depending on anything the page can do for itself.
        sessionMenu.addItem(.separator())
        let actualSize = sessionMenu.addItem(
            withTitle: "Actual Size",
            action: #selector(zoomActualSize),
            keyEquivalent: "0"
        )
        let zoomIn = sessionMenu.addItem(
            withTitle: "Zoom In",
            action: #selector(zoomInPage),
            keyEquivalent: "="
        )
        let zoomOut = sessionMenu.addItem(
            withTitle: "Zoom Out",
            action: #selector(zoomOutPage),
            keyEquivalent: "-"
        )
        for item in [actualSize, zoomIn, zoomOut] {
            item.target = self
            item.isEnabled = false
        }
        zoomItems = [actualSize, zoomIn, zoomOut]
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
