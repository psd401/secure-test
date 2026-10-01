import AVFoundation
import SecureTestCore

/// Text-to-speech slice 1 (`docs/speech-tools-design.md`, D-1 = A): the voice
/// behind the page's Speak controls.
///
/// `AVSpeechSynthesizer` in the app — native, offline, and proven inside a real
/// `AEAssessmentSession` (PoC-A RESULTS finding #16: didStart, a word-range
/// callback per word, didFinish, while locked). English only (D-6 holds
/// Spanish): the default en-US voice, whatever compact voice the Mac has.
///
/// Everything with a decision in it — what is read, how a formula is said, how
/// a word range maps back to the page — is `SpeechScript` / `MathSpeech` in
/// Core, under `swift test`. This class only owns the synthesizer: one
/// utterance at a time, its id, and turning each delegate callback into the
/// one-line script `SpeechCallback` builds. No microphone, nothing persisted.
final class SpeechReader: NSObject, AVSpeechSynthesizerDelegate {
    /// Touched only on the main actor (every call site is); the delegate
    /// protocol makes this class Sendable, which the synthesizer type is not.
    nonisolated(unsafe) private let synthesizer = AVSpeechSynthesizer()
    private let log: (String) -> Void
    /// Runs a script in the page (`evaluateJavaScript`), owned by the caller.
    private let send: (String) -> Void
    /// The utterance being read, and the page's id for it. Replaced on every
    /// Speak; nil when nothing is.
    private var current: (id: String, script: SpeechScript, utterance: AVSpeechUtterance)?

    init(log: @escaping (String) -> Void, send: @escaping (String) -> Void) {
        self.log = log
        self.send = send
        super.init()
        synthesizer.delegate = self
    }

    func handle(_ command: SpeechCommand) {
        switch command {
        case .speak(let id, let segments, let rate):
            speak(id: id, script: SpeechScript(segments: segments), rate: rate)
        case .pause:
            guard current != nil else { return }
            synthesizer.pauseSpeaking(at: .word)
        case .resume:
            guard current != nil else { return }
            synthesizer.continueSpeaking()
        case .stop:
            stop(reason: "stop pressed")
        }
    }

    /// Silences whatever is being read. Every session end path, the hand-in
    /// and the teardown call this; the page is told through `cancelled`.
    func stop(reason: String) {
        guard current != nil || synthesizer.isSpeaking else { return }
        log("tts: stopped (\(reason))")
        synthesizer.stopSpeaking(at: .immediate)
    }

    private func speak(id: String, script: SpeechScript, rate: SpeechRate) {
        // One at a time: the previous utterance's `didCancel` arrives with its
        // OWN id, which the page no longer recognises and ignores.
        synthesizer.stopSpeaking(at: .immediate)
        guard !script.isEmpty else {
            current = nil
            send(SpeechCallback.script(.finished, id: id))
            return
        }
        let utterance = AVSpeechUtterance(string: script.string)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = rate.utteranceRate
        current = (id, script, utterance)
        // Lengths only — never the text, which is test content.
        log("tts: speak \(rate.rawValue), \((script.string as NSString).length) chars, voice=\(utterance.voice?.identifier ?? "default")")
        synthesizer.speak(utterance)
    }

    // MARK: AVSpeechSynthesizerDelegate
    //
    // The callbacks arrive on the main thread in practice (PoC-A logged them
    // there), but the API does not promise it; each hops to main and is
    // matched to the CURRENT utterance by identity before anything is sent.

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.event(.started, for: key, ends: false) } }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didPause u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.event(.paused, for: key, ends: false) } }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didContinue u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.event(.resumed, for: key, ends: false) } }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.event(.finished, for: key, ends: true) } }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async { MainActor.assumeIsolated { self.event(.cancelled, for: key, ends: true) } }
    }

    nonisolated func speechSynthesizer(
        _ s: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString range: NSRange,
        utterance u: AVSpeechUtterance
    ) {
        let key = ObjectIdentifier(u)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard let current = self.current, ObjectIdentifier(current.utterance) == key,
                      let mark = current.script.mark(for: range)
                else { return }
                self.send(SpeechCallback.word(id: current.id, mark: mark))
            }
        }
    }

    private func event(_ event: SpeechCallback.Event, for key: ObjectIdentifier, ends: Bool) {
        guard let current, ObjectIdentifier(current.utterance) == key else { return }
        if ends { self.current = nil }
        send(SpeechCallback.script(event, id: current.id))
    }
}
