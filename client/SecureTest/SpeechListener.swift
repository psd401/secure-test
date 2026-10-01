import AVFoundation
import SecureTestCore
import Speech

/// Speech-to-text slice 3 (`docs/speech-tools-design.md`, D-2 = B): the
/// microphone and the on-device recognizer behind the page's "Speak my answer".
///
/// The approach is PoC-A's `SpeechProbe`, proven inside a real
/// `AEAssessmentSession` (RESULTS finding #16): `SpeechAnalyzer` with a
/// `SpeechTranscriber` (en-US, volatile results on), fed from an
/// `AVAudioEngine` input tap converted to the analyzer's format. English only
/// (D-6 holds Spanish; `speech_to_text_language` is not read).
///
/// Everything with a decision in it — who is granted, what the pre-flight
/// means, how a phrase is spaced, when listening stops on its own — is
/// `SpeechToText` in Core. This class owns the audio. Audio is never stored and
/// never leaves the Mac; the log carries lengths and reasons, never words.
final class SpeechListener {
    private let log: (String) -> Void
    private let send: (String) -> Void

    private final class Session {
        let id: String
        var transcript: DictationTranscript
        let startedAt = Date()
        var lastHeardAt: Date?
        var engine: AVAudioEngine?
        var continuation: AsyncStream<AnalyzerInput>.Continuation?
        var analyzer: SpeechAnalyzer?
        var results: Task<Void, Never>?
        var insertedCharacters = 0
        /// Set by `finish`; `run` checks it after every suspension so a stop
        /// that lands while the analyzer is still starting never leaves a
        /// microphone open behind it.
        var finished = false

        init(id: String, transcript: DictationTranscript) {
            self.id = id
            self.transcript = transcript
        }
    }

    /// The field listening now. A session that has been stopped is detached
    /// from here at once but keeps delivering the phrases the recognizer
    /// finalizes until it ends; the page takes those for the id it stopped.
    private var current: Session?
    private var timeoutTimer: Timer?

    init(log: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        self.log = log
        self.send = send
    }

    func handle(_ command: DictationCommand) {
        switch command {
        case .listen(let id, let before, let after, let singleLine):
            listen(id: id, transcript: DictationTranscript(before: before, after: after, singleLine: singleLine))
        case .stop:
            stop(reason: "pressed")
        }
    }

    /// Ends the listening, if any. Every session end path, the hand-in, the
    /// teardown, a quit and read-aloud starting call this.
    func stop(reason: String) {
        guard let session = current else { return }
        current = nil
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        finish(session, reason: reason)
    }

    // MARK: Listening

    private func listen(id: String, transcript: DictationTranscript) {
        stop(reason: "replaced")
        // Finding #16, rule 2: never start the engine on a permission that is
        // not ALREADY granted — a prompt inside the session is invisible and
        // the call hangs behind it. The pre-flight settled both before
        // begin(); this re-reads them in case either changed since.
        guard Self.permissionsGranted() else {
            log("stt: not started — permission no longer granted")
            send(DictationCallback.stopped(id: id, reason: "unavailable"))
            return
        }
        let session = Session(id: id, transcript: transcript)
        current = session
        log("stt: listening")
        send(DictationCallback.started(id: id))
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkTimeout() }
        }
        Task { [weak self] in await self?.run(session) }
    }

    private func run(_ session: Session) async {
        let transcriber = SpeechTranscriber(
            locale: Locale(identifier: "en-US"),
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        guard !session.finished else { return }
        guard let format else {
            log("stt: FAILED — no compatible audio format")
            fail(session)
            return
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        session.continuation = continuation
        session.analyzer = analyzer
        session.results = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    self?.heard(session, text: String(result.text.characters), isFinal: result.isFinal)
                }
            } catch {
                self?.log("stt: results ended with \(type(of: error))")
            }
        }
        do {
            try await analyzer.start(inputSequence: stream)
            // Stopped while the analyzer was starting: no microphone at all.
            guard !session.finished else { return }
            let engine = AVAudioEngine()
            try Self.startMicrophone(engine, format: format, into: continuation)
            session.engine = engine
        } catch {
            log("stt: FAILED to start — \(type(of: error))")
            fail(session)
        }
    }

    /// The tap and its converter, built off the main actor: the tap block runs
    /// on the audio thread and must not be inferred main-actor-isolated.
    private nonisolated static func startMicrophone(
        _ engine: AVAudioEngine,
        format: AVAudioFormat,
        into continuation: AsyncStream<AnalyzerInput>.Continuation
    ) throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inFormat, to: format) else {
            throw NSError(domain: "SpeechListener", code: 1)
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
            let ratio = format.sampleRate / inFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil, out.frameLength > 0 {
                continuation.yield(AnalyzerInput(buffer: out))
            }
        }
        engine.prepare()
        try engine.start()
    }

    private func heard(_ session: Session, text: String, isFinal: Bool) {
        session.lastHeardAt = Date()
        guard let event = session.transcript.apply(text: text, isFinal: isFinal) else { return }
        switch event {
        case .hearing(let volatile):
            // Only the field still listening shows a live line.
            guard current === session else { return }
            send(DictationCallback.hearing(id: session.id, text: volatile))
        case .insert(let phrase):
            session.insertedCharacters += phrase.count
            send(DictationCallback.insert(id: session.id, text: phrase))
        }
    }

    private func checkTimeout() {
        guard let session = current,
              let timeout = DictationTimeout.check(
                  startedAt: session.startedAt, lastHeardAt: session.lastHeardAt, now: Date())
        else { return }
        stop(reason: timeout == .maxListen ? "max" : "silence")
    }

    private func fail(_ session: Session) {
        if current === session {
            current = nil
            timeoutTimer?.invalidate()
            timeoutTimer = nil
        }
        finish(session, reason: "error")
    }

    /// Microphone off, then the recognizer finalizes what it already heard —
    /// those last phrases still reach the field — then the page is told.
    private func finish(_ session: Session, reason: String) {
        guard !session.finished else { return }
        session.finished = true
        session.engine?.stop()
        session.engine?.inputNode.removeTap(onBus: 0)
        session.engine = nil
        let continuation = session.continuation
        session.continuation = nil
        continuation?.finish()
        Task { [weak self] in
            if continuation != nil {
                try? await session.analyzer?.finalizeAndFinishThroughEndOfInput()
                _ = await session.results?.value
            } else {
                session.results?.cancel()
            }
            self?.log("stt: stopped (\(reason)), \(session.insertedCharacters) chars inserted")
            self?.send(DictationCallback.stopped(id: session.id, reason: reason))
        }
    }

    // MARK: Permissions

    static func permissionsGranted() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            && SFSpeechRecognizer.authorizationStatus() == .authorized
    }
}

/// STT slice 3: the pre-flight — finding #16's rule 1. Run after the bundle
/// arrives and BEFORE `AEAssessmentSession.begin()`, only for a student whose
/// bundle grants `speech_to_text`: the microphone prompt, the speech-recognition
/// prompt and the transcriber's asset install all happen while the Mac is
/// still unlocked. Capped by `SpeechToText.preflightBudget`; whatever the
/// outcome, the caller proceeds to begin() — without speech-to-text when it is
/// not `.ready`.
enum SpeechPreflight {
    static func run(log: @escaping (String) -> Void) async -> SpeechToTextPreflight {
        let once = Once()
        let result: SpeechToTextPreflight = await withCheckedContinuation { continuation in
            // Two racers; whichever finishes first answers. A prompt left on
            // screen by the timeout stays there, unlocked — the student can
            // still answer it, and the next attempt's pre-flight reads it.
            Task { @MainActor in
                let report = await steps(log: log)
                if once.claim() { continuation.resume(returning: report) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(SpeechToText.preflightBudget))
                if once.claim() { continuation.resume(returning: SpeechToTextPreflight(timedOut: true)) }
            }
        }
        log("stt: pre-flight \(result.logDescription)")
        return result
    }

    @MainActor
    private final class Once {
        private var done = false
        func claim() -> Bool {
            guard !done else { return false }
            done = true
            return true
        }
    }

    private static func steps(log: @escaping (String) -> Void) async -> SpeechToTextPreflight {
        var report = SpeechToTextPreflight()
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        report.microphone = map(AVCaptureDevice.authorizationStatus(for: .audio))
        guard report.microphone == .authorized else { return report }

        report.recognition = map(await requestRecognition())
        guard report.recognition == .authorized else { return report }

        guard SpeechTranscriber.isAvailable else {
            report.transcriberAvailable = false
            return report
        }
        let locale = Locale(identifier: "en-US")
        report.transcriberAvailable = await SpeechTranscriber.supportedLocales
            .contains { $0.identifier(.bcp47) == "en-US" }
        guard report.transcriberAvailable == true else { return report }

        let transcriber = SpeechTranscriber(
            locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        do {
            // PoC-A measured a request even with en-US "installed" (5 s); it
            // is cheap when nothing is missing.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                log("stt: transcriber assets downloading")
                try await request.downloadAndInstall()
            }
            report.assetsInstalled = true
        } catch {
            report.assetsInstalled = false
            report.failure = "assets_\(type(of: error))"
        }
        return report
    }

    /// The callback arrives on an arbitrary queue; a nonisolated helper so the
    /// closure is not inferred main-actor-isolated.
    private nonisolated static func requestRecognition() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
        }
    }

    private static func map(_ status: AVAuthorizationStatus) -> SpeechToTextPreflight.Authorization {
        switch status {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    private static func map(_ status: SFSpeechRecognizerAuthorizationStatus) -> SpeechToTextPreflight.Authorization {
        switch status {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }
}
