import AppKit
import SecureTestCore

/// The screen a student sees first: sign in with Google, pick a test from
/// "Your tests" (slice 84 — pre-assigned sittings, no code), or enter the code
/// the teacher read out (kept for ad-hoc sittings).
///
/// Slice 80 replaced the sign-in stub. The sign-in is `GoogleSignInFlow` (in
/// the package, tested) behind `GoogleAuthPresenter` (the sheet, not testable
/// here — see MANUAL-CHECKS.md). `signIn` is nil when no Google client id is
/// configured, in which case the token must come from `--token` /
/// `SECURE_TEST_TOKEN` as before — the dev and CI posture is unchanged.
///
/// Managed-preference slice (2026-09-11): `configured` is false when this Mac
/// resolved no server URL and/or no Google client id (`ClientConfiguration`).
/// The card then carries one sentence telling the student to ask for help,
/// which is what the blank v1.2.0 card on a Jamf-installed app should have
/// said. A `--token` session suppresses it: that posture supplies no client id
/// on purpose.
///
/// Slice 84: the list is `GET /api/me/sittings` rendered from
/// `SittingRowModel` (in the package, tested); a row's Join/Resume calls
/// `startAttempt(testSessionID:)` directly — listed sittings never redeem.
///
/// Batch 4 slice D (`docs/client-ui-pass-design.md` §D) rebuilt the layout on
/// Auto Layout: a white card centred on the Pacific ground, headed like the
/// sign-in sheet (white emblem, app name), with the list rows full width on
/// TWO lines — which is what closes the 250-px truncation finding
/// (`docs/phase-7-slices.md`, "Also noted for UX pass 1"). Every control
/// carries an accessibility label. No behaviour on this screen changed: the
/// same controls, the same actions, the same copy.
final class SessionEntryViewController: NSObject {
    let view: NSView
    private let card = NSView()
    private let signInButton: PSDPrimaryButton
    private let signOutButton = NSButton()
    private let signedInLabel = NSTextField(labelWithString: "")
    private let accountRow = NSStackView()
    private let testsHeader = NSTextField(labelWithString: "Your tests")
    private let testsRow = NSStackView()
    private let refreshButton = NSButton()
    private let listStatusLabel = NSTextField(labelWithString: "")
    private let listScroll = NSScrollView()
    private let listStack = NSStackView()
    private let separator = NSBox()
    private let codeHeader = NSTextField(labelWithString: "Or enter a code from your teacher")
    private let codeField = NSTextField()
    private let codeRow = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    /// Shown only when this Mac has no server URL or no Google client id and
    /// no token session — the v1.2.0 field report's blank card, given words.
    private let setupLabel = NSTextField(labelWithString: "")
    private let joinButton: PSDPrimaryButton
    private let onJoined: (_ assessmentID: String, _ attemptID: String) -> Void
    private let client: APIClient
    private let signIn: (() async throws -> SignedInSession)?
    /// True when both the server URL and the Google client id resolved
    /// (`ClientConfiguration`). False puts `setupLabel` on screen in place of
    /// every control, unless a `--token` session already exists — the dev and
    /// CI posture, which supplies no client id on purpose.
    private let configured: Bool
    private let log: (String) -> Void
    private var signedInAs: String?
    private var rows: [SittingRowModel] = []
    private var rowButtons: [NSButton] = []
    private var loadingSittings = false
    /// Observability slice 4: fired after a sign-in succeeds, which is the
    /// first moment this process can post what `errors.log` collected while it
    /// had no session — including the previous launch's crash line.
    var onSignedIn: (() -> Void)?

    /// The card never grows past this: a column of text a student reads at a
    /// glance, not a full-width sprawl on a 27-inch lab iMac.
    private static let cardWidth: CGFloat = 520

    init(
        client: APIClient,
        signIn: (() async throws -> SignedInSession)?,
        configured: Bool = true,
        log: @escaping (String) -> Void,
        onJoined: @escaping (_ assessmentID: String, _ attemptID: String) -> Void,
    ) {
        self.client = client
        self.signIn = signIn
        self.configured = configured
        self.log = log
        self.onJoined = onJoined
        self.signInButton = PSDPrimaryButton(title: "Sign in with Google", target: nil, action: nil)
        self.joinButton = PSDPrimaryButton(title: "Join", target: nil, action: nil)

        let ground = NSView(frame: NSRect(x: 0, y: 0, width: 980, height: 700))
        ground.wantsLayer = true
        // §D, James 2026-09-07: the app's ground is Pacific, here and behind
        // the web view, so nothing the student sees is undressed grey.
        ground.layer?.backgroundColor = PSDColor.pacific.cgColor
        self.view = ground
        super.init()

        signInButton.target = self
        signInButton.action = #selector(startSignIn)
        signInButton.setAccessibilityLabel("Sign in with your school Google account")

        joinButton.target = self
        joinButton.action = #selector(join)
        joinButton.keyEquivalent = "\r"
        joinButton.setAccessibilityLabel("Join the test with the session code you typed")

        buildCard()
        layOut(in: ground)

        Task { @MainActor in
            await refreshSignInState()
        }
    }

    // MARK: layout (slice D)

    /// A flexible gap in a horizontal stack. The lowest hugging priority
    /// there is, so this is what stretches and every real control keeps its
    /// intrinsic width.
    private static func spacer() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        view.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        view.setAccessibilityElement(false)
        return view
    }

    /// The card: a Pacific header strip carrying the white emblem and the app
    /// name — the same shape as the sign-in sheet's header
    /// (`WebViewAuthPresenter.makeSheetContent`) — over a white body holding
    /// every control in one vertical stack.
    private func buildCard() {
        card.translatesAutoresizingMaskIntoConstraints = false
        card.wantsLayer = true
        card.layer?.backgroundColor = PSDColor.paper.cgColor
        card.layer?.cornerRadius = 12
        card.layer?.masksToBounds = true

        let header = NSView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.wantsLayer = true
        header.layer?.backgroundColor = PSDColor.pacific.cgColor

        let emblem = NSImageView()
        emblem.translatesAutoresizingMaskIntoConstraints = false
        emblem.image = NSImage(named: "psd-emblem-white")
        emblem.imageScaling = .scaleProportionallyUpOrDown
        emblem.setAccessibilityLabel("Peninsula School District")
        header.addSubview(emblem)

        // Josefin Sans is the PSD heading face but the app ships no font files
        // (the web page inlines its own); the system face at heading weight is
        // the AppKit stand-in, deliberately.
        let wordmark = NSTextField(labelWithString: "Secure Test")
        wordmark.translatesAutoresizingMaskIntoConstraints = false
        wordmark.font = .systemFont(ofSize: 20, weight: .semibold)
        wordmark.textColor = PSDColor.skylight
        wordmark.setAccessibilityRole(.staticText)
        header.addSubview(wordmark)

        NSLayoutConstraint.activate([
            header.heightAnchor.constraint(equalToConstant: 56),
            emblem.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 20),
            emblem.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            emblem.widthAnchor.constraint(equalToConstant: 24),
            emblem.heightAnchor.constraint(equalToConstant: 24),
            wordmark.leadingAnchor.constraint(equalTo: emblem.trailingAnchor, constant: 12),
            wordmark.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            wordmark.trailingAnchor.constraint(lessThanOrEqualTo: header.trailingAnchor, constant: -20),
        ])

        // The account row: signed out shows the button, signed in shows who
        // and a way out. Both live in the stack; visibility is the switch.
        signOutButton.title = "Sign out"
        signOutButton.bezelStyle = .rounded
        signOutButton.controlSize = .small
        signOutButton.target = self
        signOutButton.action = #selector(signOut)
        signOutButton.setAccessibilityLabel("Sign out of this Mac")

        signedInLabel.textColor = PSDColor.inkSoft
        signedInLabel.font = .systemFont(ofSize: 12)
        signedInLabel.lineBreakMode = .byTruncatingMiddle
        signedInLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        accountRow.orientation = .horizontal
        accountRow.alignment = .centerY
        accountRow.spacing = 12
        accountRow.addArrangedSubview(signInButton)
        accountRow.addArrangedSubview(signedInLabel)
        accountRow.addArrangedSubview(Self.spacer())
        accountRow.addArrangedSubview(signOutButton)

        testsHeader.font = .systemFont(ofSize: 16, weight: .semibold)
        testsHeader.textColor = PSDColor.pacific
        refreshButton.title = "Refresh"
        refreshButton.bezelStyle = .rounded
        refreshButton.controlSize = .small
        refreshButton.target = self
        refreshButton.action = #selector(refreshSittings)
        refreshButton.setAccessibilityLabel("Refresh the list of your tests")

        testsRow.orientation = .horizontal
        testsRow.alignment = .centerY
        testsRow.spacing = 12
        testsRow.addArrangedSubview(testsHeader)
        testsRow.addArrangedSubview(Self.spacer())
        testsRow.addArrangedSubview(refreshButton)

        // The list: a vertical stack in a scroll view. Rows are rebuilt whole
        // on every load — the list is small and diffing it buys nothing.
        listScroll.translatesAutoresizingMaskIntoConstraints = false
        listScroll.hasVerticalScroller = true
        listScroll.drawsBackground = false
        listScroll.setAccessibilityLabel("Your tests")
        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 8
        listStack.translatesAutoresizingMaskIntoConstraints = false
        let clip = listScroll.contentView
        listScroll.documentView = listStack
        NSLayoutConstraint.activate([
            listStack.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            listStack.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            listStack.topAnchor.constraint(equalTo: clip.topAnchor),
            // Three two-line rows plus their spacing: the minimum that keeps
            // the list a list rather than a peephole.
            listScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 196),
        ])

        listStatusLabel.textColor = PSDColor.inkSoft
        listStatusLabel.font = .systemFont(ofSize: 12)
        listStatusLabel.lineBreakMode = .byWordWrapping
        listStatusLabel.maximumNumberOfLines = 2

        separator.boxType = .separator

        codeHeader.font = .systemFont(ofSize: 13, weight: .semibold)
        codeHeader.textColor = PSDColor.inkSoft

        codeField.font = .monospacedSystemFont(ofSize: 20, weight: .regular)
        codeField.placeholderString = "ABC234"
        codeField.alignment = .center
        codeField.setAccessibilityLabel("Session code")
        // VoiceOver reads this after the label, which is where the "what do I
        // type here" answer belongs (the placeholder is an example, not help).
        codeField.setAccessibilityHelp("The six-character code your teacher read out. Press Join when you have typed it.")
        codeField.toolTip = "The code your teacher read out"

        codeRow.orientation = .horizontal
        codeRow.alignment = .centerY
        codeRow.spacing = 12
        codeRow.addArrangedSubview(codeField)
        codeRow.addArrangedSubview(joinButton)
        codeRow.addArrangedSubview(Self.spacer())
        NSLayoutConstraint.activate([
            codeField.widthAnchor.constraint(equalToConstant: 220),
            codeField.heightAnchor.constraint(equalToConstant: 32),
        ])

        // The unconfigured message: the only thing in the card when this Mac
        // has no server URL or no client id (managed-preference slice,
        // 2026-09-11). Warn rather than danger — nothing is broken, this Mac
        // just has not been set up yet — and word-wrapped inside the card.
        setupLabel.stringValue = "This Mac isn't set up for Secure Test yet. Ask your teacher or IT for help."
        setupLabel.textColor = PSDColor.warn
        setupLabel.font = .systemFont(ofSize: 14, weight: .medium)
        setupLabel.maximumNumberOfLines = 3
        setupLabel.lineBreakMode = .byWordWrapping
        setupLabel.setAccessibilityRole(.staticText)
        setupLabel.setAccessibilityLabel("This Mac isn't set up for Secure Test yet. Ask your teacher or IT for help.")
        setupLabel.isHidden = true

        statusLabel.textColor = PSDColor.inkSoft
        statusLabel.maximumNumberOfLines = 3
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.setAccessibilityLabel("Status")
        // 4.1.3 / 1.4.1: a status here is words, never a colour change, and
        // VoiceOver is told when they change.
        statusLabel.setAccessibilityRole(.staticText)

        let body = NSStackView(views: [
            setupLabel, accountRow, testsRow, listScroll, listStatusLabel,
            separator, codeHeader, codeRow, statusLabel,
        ])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 14
        body.translatesAutoresizingMaskIntoConstraints = false
        body.setHuggingPriority(.defaultLow, for: .horizontal)

        card.addSubview(header)
        card.addSubview(body)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: card.topAnchor),
            header.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            body.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 20),
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
            body.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
        ])
        for row in [accountRow, testsRow, codeRow] {
            row.translatesAutoresizingMaskIntoConstraints = false
            row.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        for full in [setupLabel, listScroll, listStatusLabel, separator, statusLabel] as [NSView] {
            full.translatesAutoresizingMaskIntoConstraints = false
            full.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
    }

    /// Centred, capped at `cardWidth`, and allowed to shrink with the window
    /// so the card never runs off the edge at the minimum size.
    private func layOut(in ground: NSView) {
        ground.addSubview(card)
        let width = card.widthAnchor.constraint(equalToConstant: Self.cardWidth)
        width.priority = .defaultHigh
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: ground.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: ground.centerYAnchor),
            width,
            card.widthAnchor.constraint(lessThanOrEqualTo: ground.widthAnchor, constant: -48),
            card.topAnchor.constraint(greaterThanOrEqualTo: ground.topAnchor, constant: 24),
            card.bottomAnchor.constraint(lessThanOrEqualTo: ground.bottomAnchor, constant: -24),
        ])
    }

    /// Four states: not set up (no server URL and/or no client id, and no
    /// token — one sentence and nothing else), no sign-in configured (token
    /// from the launch arguments, nothing to show), signed out (button),
    /// signed in (who, the tests list, and sign out).
    private func refreshSignInState() async {
        let signedIn = await client.isSignedIn()
        // After a relaunch there is no exchange response to remember the email
        // from; the stored session JWT's own claims carry it (slice 80 fix,
        // MANUAL-CHECKS "Still open" 2026-08-27).
        if signedIn, signedInAs == nil {
            signedInAs = await client.signedInEmail()
        }
        let signInConfigured = signIn != nil
        // Managed-preference slice: with the server URL or the client id
        // missing there is nothing to sign into, so the card carries one
        // sentence and nothing else. A `--token` session reports as signed in
        // and keeps the dev/CI posture exactly as it was — no message.
        let needsSetup = !configured && !signedIn
        setupLabel.isHidden = !needsSetup
        signInButton.isHidden = !signInConfigured || signedIn || needsSetup
        signOutButton.isHidden = !signInConfigured || !signedIn
        signedInLabel.isHidden = !signedIn
        signedInLabel.stringValue = signedIn
            ? "Signed in\(signedInAs.map { " as \($0)" } ?? "")"
            : ""
        for control in [testsHeader, refreshButton, listStatusLabel] as [NSView] {
            control.isHidden = !signedIn
        }
        testsRow.isHidden = !signedIn
        listScroll.isHidden = !signedIn
        // Fix slice S-2 (2026-09-08 sitting): a signed-out student saw an empty
        // code box above the sign-in button and typed into it, so the first
        // thing the app asked for was the wrong thing. The code path is a
        // signed-in path — the redeem call carries the session token — so the
        // whole block, its heading and the rule above it are hidden until then.
        // The launch-argument token (`--token` / SECURE_TEST_TOKEN) reports as
        // signed in, exactly as it already does for the tests list.
        for control in [separator, codeHeader, codeRow] as [NSView] {
            control.isHidden = !signedIn
        }
        joinButton.isEnabled = signedIn
        codeField.isEnabled = signedIn
        if needsSetup {
            statusLabel.stringValue = ""
            log("entry: not configured — no server URL and/or no google client id")
        } else if signInConfigured && !signedIn {
            statusLabel.stringValue = "Sign in with your school Google account first."
        }
        if signedIn {
            await loadSittings()
        } else {
            render(rows: [])
        }
    }

    // MARK: your tests (slice 84)

    @objc private func refreshSittings() {
        Task { @MainActor in
            await loadSittings()
        }
    }

    private func loadSittings() async {
        guard !loadingSittings else { return }
        loadingSittings = true
        defer { loadingSittings = false }
        listStatusLabel.stringValue = "Loading…"
        do {
            let mine = try await client.mySittings()
            rows = mine.sittings.map(SittingRowModel.init)
            render(rows: rows)
            if rows.isEmpty {
                // A reason means the empty list is about the account, and the
                // codes are the redeem codes, so the words come from the same
                // place.
                listStatusLabel.stringValue = mine.reason
                    .map { JoinErrorCopy.message(forCode: $0) }
                    ?? "No tests assigned right now."
            } else {
                listStatusLabel.stringValue = ""
            }
            log("my-sittings: \(rows.count) row(s)\(mine.reason.map { ", reason \($0)" } ?? "")")
        } catch {
            rows = []
            render(rows: [])
            // A staff session gets a 403 here by contract; the code field
            // still works (and will explain itself at join, as before).
            listStatusLabel.stringValue = "No test list for this account."
            log("my-sittings failed: \(error)")
            AppDelegate.logError(kind: "sittings_failed", message: "\(error)")
        }
    }

    private func render(rows: [SittingRowModel]) {
        for view in listStack.arrangedSubviews {
            listStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        rowButtons = []
        for (index, row) in rows.enumerated() {
            let view = rowView(for: row, index: index)
            listStack.addArrangedSubview(view)
            // Only now do the two share an ancestor (see rowView).
            view.widthAnchor.constraint(equalTo: listStack.widthAnchor).isActive = true
        }
        listStack.layoutSubtreeIfNeeded()
    }

    /// One sitting, on two lines: the assessment on top, "<code · where —
    /// teacher> · closes <time>" underneath, both across the card's full
    /// width. The single 250-px line was the truncation finding.
    private func rowView(for row: SittingRowModel, index: Int) -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.wantsLayer = true
        container.layer?.backgroundColor = PSDColor.seaFoam.cgColor
        container.layer?.cornerRadius = 8
        container.layer?.borderWidth = 1
        container.layer?.borderColor = PSDColor.driftwood.cgColor

        let title = NSTextField(labelWithString: row.title)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = PSDColor.pacific
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detailText = [row.detail, row.expiryLabel()]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        let detail = NSTextField(labelWithString: detailText)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = PSDColor.inkSoft
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        text.translatesAutoresizingMaskIntoConstraints = false

        let trailing: NSView
        switch row.state {
        case .done:
            // Text AND a symbol, never the tick alone: state is not carried by
            // a glyph or a colour on its own (WCAG 1.4.1).
            let label = NSTextField(labelWithString: "Done")
            label.font = .systemFont(ofSize: 12, weight: .semibold)
            label.textColor = PSDColor.cedar
            let tick = NSImageView()
            tick.image = NSImage(
                systemSymbolName: "checkmark.circle.fill",
                accessibilityDescription: "Handed in"
            )
            tick.contentTintColor = PSDColor.cedar
            tick.imageScaling = .scaleProportionallyUpOrDown
            tick.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                tick.widthAnchor.constraint(equalToConstant: 16),
                tick.heightAnchor.constraint(equalToConstant: 16),
            ])
            let done = NSStackView(views: [label, tick])
            done.orientation = .horizontal
            done.alignment = .centerY
            done.spacing = 6
            done.setAccessibilityLabel("\(row.title): handed in")
            trailing = done
        case .join, .resume:
            let button = PSDPrimaryButton(
                title: row.state == .resume ? "Resume" : "Join",
                target: self,
                action: #selector(joinListedSitting(_:))
            )
            button.tag = index
            button.setAccessibilityLabel(
                "\(row.state == .resume ? "Resume" : "Join") \(row.title)"
            )
            rowButtons.append(button)
            trailing = button
        }
        trailing.translatesAutoresizingMaskIntoConstraints = false
        trailing.setContentHuggingPriority(.required, for: .horizontal)
        trailing.setContentCompressionResistancePriority(.required, for: .horizontal)

        container.addSubview(text)
        container.addSubview(trailing)
        // The width constraint against `listStack` is activated in `render`,
        // AFTER `addArrangedSubview`: activating it here, while `container`
        // has no superview, raises NSGenericException ("no common ancestor").
        // That exception unwound through the sign-in Task on 2026-09-08 and
        // left the main actor marked busy for the life of the process — the
        // "Loading…" / "Joining…" hang (client/MANUAL-CHECKS.md, slice D).
        NSLayoutConstraint.activate([
            container.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
            text.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            text.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            text.trailingAnchor.constraint(equalTo: trailing.leadingAnchor, constant: -12),
            trailing.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            trailing.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        container.setAccessibilityRole(.group)
        container.setAccessibilityLabel("\(row.title). \(detailText)")
        return container
    }

    @objc private func joinListedSitting(_ sender: NSButton) {
        guard rows.indices.contains(sender.tag) else { return }
        let row = rows[sender.tag]
        for button in rowButtons { button.isEnabled = false }
        statusLabel.stringValue = "Joining…"

        Task { @MainActor in
            do {
                let attempt = try await client.startAttempt(testSessionID: row.testSessionID)
                switch JoinOutcome(attempt) {
                case .open(let attemptID):
                    log("joined listed sitting \(row.testSessionID), attempt \(attemptID)\(attempt.resumed ? " (resumed)" : "")")
                    onJoined(row.assessmentID, attemptID)
                case .alreadyHandedIn(let attemptID):
                    // Finding 10.1: nothing to answer, so nothing is rendered
                    // and no session begins. The list re-reads so the row
                    // says "Done ✓" (finding 10.2).
                    log("join declined: attempt \(attemptID) at sitting \(row.testSessionID) is already submitted — staying on the entry screen")
                    for button in rowButtons { button.isEnabled = true }
                    statusLabel.stringValue = JoinOutcome.handedInMessage
                    await loadSittings()
                }
            } catch {
                for button in rowButtons { button.isEnabled = true }
                statusLabel.stringValue = Self.message(for: error)
                log("join failed: \(error)")
                AppDelegate.logError(
                    kind: "join_failed",
                    message: "\(error)",
                    context: ["via": "list", "test_session_id": row.testSessionID]
                )
                if case APIError.notAuthenticated = error {
                    await refreshSignInState()
                }
            }
        }
    }

    // MARK: sign-in

    @objc private func startSignIn() {
        guard let signIn else { return }
        signInButton.isEnabled = false
        statusLabel.stringValue = "Opening Google sign-in…"
        Task { @MainActor in
            defer { signInButton.isEnabled = true }
            do {
                let session = try await signIn()
                signedInAs = session.email
                statusLabel.stringValue = ""
                log("signed in as role \(session.role)")
                // Slice 4: the drain's trigger — this is the first moment the
                // process has a token for errors recorded without one.
                onSignedIn?()
            } catch let error as SignInError {
                statusLabel.stringValue = Self.message(for: error)
                log("sign-in failed: \(error)")
                AppDelegate.logError(kind: "signin_failed", message: "\(error)")
            } catch {
                statusLabel.stringValue = "Could not sign in. Tell your teacher."
                log("sign-in failed: \(error)")
                AppDelegate.logError(kind: "signin_failed", message: "\(error)")
            }
            await refreshSignInState()
        }
    }

    @objc private func signOut() {
        Task { @MainActor in
            do {
                try await client.signOut()
                signedInAs = nil
                statusLabel.stringValue = ""
                log("signed out")
            } catch {
                log("sign-out failed: \(error)")
            }
            await refreshSignInState()
        }
    }

    // MARK: join by code

    @objc private func join() {
        let code = codeField.stringValue
        guard !code.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        joinButton.isEnabled = false
        statusLabel.stringValue = "Joining…"

        Task { @MainActor in
            do {
                let session = try await client.redeem(code: code)
                let attempt = try await client.startAttempt(testSessionID: session.testSessionID)
                switch JoinOutcome(attempt) {
                case .open(let attemptID):
                    log("joined sitting \(session.testSessionID), attempt \(attemptID)")
                    onJoined(session.assessmentID, attemptID)
                case .alreadyHandedIn(let attemptID):
                    // Finding 10.1, code path: same rule as the list.
                    log("join declined: attempt \(attemptID) at sitting \(session.testSessionID) is already submitted — staying on the entry screen")
                    joinButton.isEnabled = true
                    statusLabel.stringValue = JoinOutcome.handedInMessage
                    await loadSittings()
                }
            } catch {
                joinButton.isEnabled = true
                statusLabel.stringValue = Self.message(for: error)
                log("join failed: \(error)")
                AppDelegate.logError(
                    kind: "join_failed",
                    message: "\(error)",
                    context: ["via": "code"]
                )
                if case APIError.notAuthenticated = error {
                    await refreshSignInState()
                }
            }
        }
    }

    static func message(for error: Error) -> String {
        JoinErrorCopy.message(for: error)
    }

    /// Sign-in failures, in a student's words. The one they can act on alone
    /// is picking the right Google account; everything else is the teacher's.
    static func message(for error: SignInError) -> String {
        switch error {
        case .cancelled:
            return "Sign-in was cancelled."
        case .exchangeRefused(_, let code):
            return JoinErrorCopy.message(forCode: code)
        case .providerError(let name):
            return "Google would not sign you in (\(name)). Tell your teacher."
        case .stateMismatch, .nonceMismatch:
            return "That sign-in reply was not for this app. Try again."
        case .callbackMissingCode, .tokenEndpoint, .tokenResponseMissingIdToken, .malformedIdToken:
            return "Could not finish signing in. Tell your teacher."
        }
    }
}
