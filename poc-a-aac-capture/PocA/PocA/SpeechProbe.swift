// Speech spikes S-1 / S-2 (docs/speech-tools-design.md, 2026-10-01).
//
// S-1: does AVSpeechSynthesizer produce audio — and its word-range callbacks
//      — inside a real AEAssessmentSession?
// S-2: can the app get the microphone and run ON-DEVICE recognition inside a
//      session? Two engines: SpeechAnalyzer / SpeechTranscriber (macOS 26)
//      and SFSpeechRecognizer with requiresOnDeviceRecognition.
//
// Procedure: Prepare Speech BEFORE Enter Assessment (permission prompts +
// any model download happen unlocked), then inside the session press Speak
// and each Listen button. A second run that skips Prepare measures what a
// first-time prompt does while locked. Every result line goes to the log
// and stderr, prefixed "speech:".

import AVFoundation
import Foundation
import Speech

final class SpeechProbe: NSObject, AVSpeechSynthesizerDelegate {
    var onLog: ((String) -> Void)?

    private let synth = AVSpeechSynthesizer()
    private let locale = Locale(identifier: "en-US")
    private static let listenSeconds: Double = 8

    override init() {
        super.init()
        synth.delegate = self
    }

    private func log(_ s: String) { onLog?("speech: \(s)") }

    // MARK: - Prepare (permissions + model)

    func prepare() {
        log("mic status before: \(Self.describe(AVCaptureDevice.authorizationStatus(for: .audio)))")
        log("speech-recognition status before: \(Self.describe(SFSpeechRecognizer.authorizationStatus()))")
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            self?.log("mic requestAccess → \(granted ? "GRANTED" : "DENIED")")
            SFSpeechRecognizer.requestAuthorization { status in
                self?.log("speech-recognition requestAuthorization → \(Self.describe(status))")
                Task { await self?.ensureTranscriberAssets() }
            }
        }
        logVoices()
    }

    private func ensureTranscriberAssets() async {
        guard SpeechTranscriber.isAvailable else {
            log("SpeechTranscriber.isAvailable = false on this Mac")
            return
        }
        let supported = await SpeechTranscriber.supportedLocales.contains { $0.identifier(.bcp47) == "en-US" }
        let installed = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == "en-US" }
        log("SpeechTranscriber en-US supported=\(supported) installed=\(installed)")
        do {
            let transcriber = Self.makeTranscriber(locale: locale)
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                log("transcriber assets: download needed — downloading…")
                try await request.downloadAndInstall()
                log("transcriber assets: installed")
            } else {
                log("transcriber assets: already installed (no download needed)")
            }
        } catch {
            log("transcriber assets: FAILED — \(error)")
        }
    }

    // MARK: - S-1 text-to-speech

    func speak() {
        let text = "The quick brown fox jumps over the lazy dog. Two plus two equals four."
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        log("speak: voice=\(u.voice?.name ?? "nil") (\(u.voice?.identifier ?? "-"))")
        synth.stopSpeaking(at: .immediate)
        synth.speak(u)
    }

    private func logVoices() {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix("en") || $0.language.hasPrefix("es")
        }
        log("voices (en/es): \(voices.count)")
        for v in voices {
            log("  voice \(v.language) \(v.name) quality=\(v.quality.rawValue)")
        }
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        log("TTS didStart")
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString r: NSRange, utterance u: AVSpeechUtterance) {
        let word = (u.speechString as NSString).substring(with: r)
        log("TTS word range \(r.location)+\(r.length) \"\(word)\"")
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        log("TTS didFinish")
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        log("TTS didCancel")
    }

    // MARK: - S-2a SpeechAnalyzer / SpeechTranscriber

    private static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
    }

    func listenWithAnalyzer() {
        Task { await runAnalyzer() }
    }

    private func runAnalyzer() async {
        log("analyzer: start (\(Int(Self.listenSeconds))s) — speak now")
        let transcriber = Self.makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            log("analyzer: FAILED — no compatible audio format")
            return
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

        let resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    self?.log("analyzer \(result.isFinal ? "FINAL" : "partial"): \"\(text)\"")
                }
            } catch {
                self?.log("analyzer results: FAILED — \(error)")
            }
        }

        let engine = AVAudioEngine()
        do {
            try await analyzer.start(inputSequence: stream)
            let input = engine.inputNode
            let inFormat = input.outputFormat(forBus: 0)
            log("analyzer: mic format \(inFormat.sampleRate) Hz × \(inFormat.channelCount); analyzer wants \(format.sampleRate) Hz")
            guard let converter = AVAudioConverter(from: inFormat, to: format) else {
                log("analyzer: FAILED — no converter")
                return
            }
            var buffers = 0
            input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
                let ratio = format.sampleRate / inFormat.sampleRate
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
                guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
                var fed = false
                var err: NSError?
                converter.convert(to: out, error: &err) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return buffer
                }
                if err == nil, out.frameLength > 0 {
                    buffers += 1
                    continuation.yield(AnalyzerInput(buffer: out))
                }
            }
            engine.prepare()
            try engine.start()
            try await Task.sleep(for: .seconds(Self.listenSeconds))
            engine.stop()
            input.removeTap(onBus: 0)
            log("analyzer: mic delivered \(buffers) buffers")
            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            engine.stop()
            continuation.finish()
            log("analyzer: FAILED — \(error)")
        }
        _ = await resultsTask.result
        log("analyzer: done")
    }

    // MARK: - S-2b SFSpeechRecognizer, on-device only

    private var sfTask: SFSpeechRecognitionTask?

    func listenWithSFSpeech() {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            log("sfspeech: FAILED — no recognizer for en-US")
            return
        }
        log("sfspeech: available=\(recognizer.isAvailable) supportsOnDevice=\(recognizer.supportsOnDeviceRecognition)")
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true

        let engine = AVAudioEngine()
        let input = engine.inputNode
        var buffers = 0
        input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { buffer, _ in
            buffers += 1
            request.append(buffer)
        }
        sfTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result {
                self?.log("sfspeech \(result.isFinal ? "FINAL" : "partial"): \"\(result.bestTranscription.formattedString)\"")
            }
            if let error { self?.log("sfspeech: error — \(error)") }
        }
        do {
            engine.prepare()
            try engine.start()
            log("sfspeech: start (\(Int(Self.listenSeconds))s) — speak now")
        } catch {
            log("sfspeech: FAILED to start the mic — \(error)")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.listenSeconds) { [weak self] in
            engine.stop()
            input.removeTap(onBus: 0)
            request.endAudio()
            self?.log("sfspeech: mic delivered \(buffers) buffers; stopped")
        }
    }

    // MARK: - Helpers

    private static func describe(_ s: AVAuthorizationStatus) -> String {
        switch s {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        @unknown default: "unknown(\(s.rawValue))"
        }
    }

    private static func describe(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        @unknown default: "unknown(\(s.rawValue))"
        }
    }
}
