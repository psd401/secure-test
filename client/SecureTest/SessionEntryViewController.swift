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
/// Slice 84: the list is `GET /api/me/sittings` rendered from
/// `SittingRowModel` (in the package, tested); a row's Join/Resume calls
/// `startAttempt(testSessionID:)` directly — listed sittings never redeem.
final class SessionEntryViewController: NSObject {
    let view: NSView
    private let signInButton = NSButton()
    private let signOutButton = NSButton()
    private let signedInLabel = NSTextField(labelWithString: "")
    private let testsHeader = NSTextField(labelWithString: "Your tests")
    private let refreshButton = NSButton()
    private let listStatusLabel = NSTextField(labelWithString: "")
    private let listScroll = NSScrollView()
    private let listStack = NSStackView()
    private let codeHeader = NSTextField(labelWithString: "Or enter a code from your teacher")
    private let codeField = NSTextField()
    private let statusLabel = NSTextField(labelWithString: "")
    private let joinButton = NSButton()
    private let onJoined: (_ assessmentID: String, _ attemptID: String) -> Void
    private let client: APIClient
    private let signIn: (() async throws -> SignedInSession)?
    private let log: (String) -> Void
    private var signedInAs: String?
    private var rows: [SittingRowModel] = []
    private var rowButtons: [NSButton] = []
    private var loadingSittings = false

    init(
        client: APIClient,
        signIn: (() async throws -> SignedInSession)?,
        log: @escaping (String) -> Void,
        onJoined: @escaping (_ assessmentID: String, _ attemptID: String) -> Void,
    ) {
        self.client = client
        self.signIn = signIn
        self.log = log
        self.onJoined = onJoined

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 560))
        self.view = container
        super.init()

        signInButton.frame = NSRect(x: 40, y: 510, width: 200, height: 36)
        signInButton.title = "Sign in with Google"
        signInButton.bezelStyle = .rounded
        signInButton.target = self
        signInButton.action = #selector(startSignIn)
        container.addSubview(signInButton)

        signedInLabel.frame = NSRect(x: 40, y: 516, width: 290, height: 20)
        signedInLabel.textColor = .secondaryLabelColor
        signedInLabel.font = .systemFont(ofSize: 12)
        signedInLabel.lineBreakMode = .byTruncatingMiddle
        container.addSubview(signedInLabel)

        signOutButton.frame = NSRect(x: 340, y: 510, width: 80, height: 30)
        signOutButton.title = "Sign out"
        signOutButton.bezelStyle = .rounded
        signOutButton.font = .systemFont(ofSize: 11)
        signOutButton.target = self
        signOutButton.action = #selector(signOut)
        container.addSubview(signOutButton)

        testsHeader.frame = NSRect(x: 40, y: 468, width: 200, height: 24)
        testsHeader.font = .systemFont(ofSize: 16, weight: .semibold)
        container.addSubview(testsHeader)

        refreshButton.frame = NSRect(x: 340, y: 466, width: 80, height: 28)
        refreshButton.title = "Refresh"
        refreshButton.bezelStyle = .rounded
        refreshButton.font = .systemFont(ofSize: 11)
        refreshButton.target = self
        refreshButton.action = #selector(refreshSittings)
        container.addSubview(refreshButton)

        // The list: a vertical stack in a scroll view. Rows are rebuilt whole
        // on every load — the list is small and diffing it buys nothing.
        listScroll.frame = NSRect(x: 40, y: 220, width: 380, height: 240)
        listScroll.hasVerticalScroller = true
        listScroll.drawsBackground = false
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
        ])
        container.addSubview(listScroll)

        listStatusLabel.frame = NSRect(x: 40, y: 428, width: 380, height: 24)
        listStatusLabel.textColor = .secondaryLabelColor
        listStatusLabel.font = .systemFont(ofSize: 12)
        container.addSubview(listStatusLabel)

        codeHeader.frame = NSRect(x: 40, y: 178, width: 340, height: 20)
        codeHeader.font = .systemFont(ofSize: 13, weight: .semibold)
        codeHeader.textColor = .secondaryLabelColor
        container.addSubview(codeHeader)

        codeField.frame = NSRect(x: 40, y: 130, width: 220, height: 32)
        codeField.font = .monospacedSystemFont(ofSize: 20, weight: .regular)
        codeField.placeholderString = "ABC234"
        codeField.alignment = .center
        container.addSubview(codeField)

        joinButton.frame = NSRect(x: 272, y: 128, width: 108, height: 36)
        joinButton.title = "Join"
        joinButton.bezelStyle = .rounded
        joinButton.target = self
        joinButton.action = #selector(join)
        joinButton.keyEquivalent = "\r"
        container.addSubview(joinButton)

        statusLabel.frame = NSRect(x: 40, y: 40, width: 380, height: 70)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.maximumNumberOfLines = 3
        container.addSubview(statusLabel)

        Task { @MainActor in
            await refreshSignInState()
        }
    }

    /// Three states: no sign-in configured (token from the launch arguments,
    /// nothing to show), signed out (button), signed in (who, the tests list,
    /// and sign out).
    private func refreshSignInState() async {
        let signedIn = await client.isSignedIn()
        // After a relaunch there is no exchange response to remember the email
        // from; the stored session JWT's own claims carry it (slice 80 fix,
        // MANUAL-CHECKS "Still open" 2026-08-27).
        if signedIn, signedInAs == nil {
            signedInAs = await client.signedInEmail()
        }
        let configured = signIn != nil
        signInButton.isHidden = !configured || signedIn
        signOutButton.isHidden = !configured || !signedIn
        signedInLabel.isHidden = !signedIn
        signedInLabel.stringValue = signedIn
            ? "Signed in\(signedInAs.map { " as \($0)" } ?? "")"
            : ""
        for control in [testsHeader, refreshButton, listStatusLabel] as [NSView] {
            control.isHidden = !signedIn
        }
        listScroll.isHidden = !signedIn
        joinButton.isEnabled = signedIn
        codeField.isEnabled = signedIn
        if configured && !signedIn {
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
        }
    }

    private func render(rows: [SittingRowModel]) {
        for view in listStack.arrangedSubviews {
            listStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        rowButtons = []
        for (index, row) in rows.enumerated() {
            listStack.addArrangedSubview(rowView(for: row, index: index))
        }
        listStack.layoutSubtreeIfNeeded()
    }

    private func rowView(for row: SittingRowModel, index: Int) -> NSView {
        let rowView = NSView()
        rowView.translatesAutoresizingMaskIntoConstraints = false
        rowView.widthAnchor.constraint(equalToConstant: 364).isActive = true
        rowView.heightAnchor.constraint(equalToConstant: 52).isActive = true

        let title = NSTextField(labelWithString: row.title)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: 0, y: 28, width: 250, height: 18)
        rowView.addSubview(title)

        let detailText = [row.detail, row.expiryLabel()]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        let detail = NSTextField(labelWithString: detailText)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        detail.frame = NSRect(x: 0, y: 6, width: 250, height: 16)
        rowView.addSubview(detail)

        switch row.state {
        case .done:
            let done = NSTextField(labelWithString: "Done ✓")
            done.font = .systemFont(ofSize: 12, weight: .semibold)
            done.textColor = .secondaryLabelColor
            done.alignment = .right
            done.frame = NSRect(x: 264, y: 16, width: 100, height: 18)
            rowView.addSubview(done)
        case .join, .resume:
            let button = NSButton()
            button.title = row.state == .resume ? "Resume" : "Join"
            button.bezelStyle = .rounded
            button.frame = NSRect(x: 264, y: 10, width: 100, height: 32)
            button.target = self
            button.action = #selector(joinListedSitting(_:))
            button.tag = index
            rowView.addSubview(button)
            rowButtons.append(button)
        }
        return rowView
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
            } catch let error as SignInError {
                statusLabel.stringValue = Self.message(for: error)
                log("sign-in failed: \(error)")
            } catch {
                statusLabel.stringValue = "Could not sign in. Tell your teacher."
                log("sign-in failed: \(error)")
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
