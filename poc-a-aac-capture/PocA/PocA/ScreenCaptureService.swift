import Foundation
import CoreGraphics
import ScreenCaptureKit
import AppKit

// Single-shot capture via ScreenCaptureKit. Writes a JPEG to ~/Library/Containers/.../poc-frames/
// or, since this is unsandboxed for PoC, to ~/Library/Application Support/PocA/poc-frames/.

final class ScreenCaptureService {
    var onLog: ((String) -> Void)?

    func captureOnce() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            guard let display = content.displays.first else {
                onLog?("Capture: no displays returned by SCShareableContent.")
                return
            }
            onLog?("Capture: targeting display \(display.displayID) \(display.width)x\(display.height)")

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = display.width
            config.height = display.height
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            try writeJPEG(image)
            onLog?("Capture: SUCCESS — frame written.")
        } catch {
            onLog?("Capture: FAILED — \(error.localizedDescription)")
        }
    }

    /// In-process render of the app's own view tree — `NSView.cacheDisplay`,
    /// no ScreenCaptureKit, no window server capture. Added 2026-08-27 after
    /// finding #13: SCK frames come back with this app's window replaced by a
    /// flat grey box inside a session. If this path survives, live monitoring
    /// has an image mechanism that AAC's capture redaction does not touch
    /// (plan 6.16). Must run on the main thread.
    @MainActor
    func snapshot(view: NSView) {
        let bounds = view.bounds
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            onLog?("Snapshot: FAILED — bitmapImageRepForCachingDisplay returned nil.")
            return
        }
        view.cacheDisplay(in: bounds, to: rep)
        do {
            let dir = try framesDirectory()
            let url = dir.appendingPathComponent("snapshot-\(Int(Date().timeIntervalSince1970)).jpg")
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
                throw NSError(domain: "PocA.Snapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: "JPEG encoding failed."])
            }
            try data.write(to: url)
            onLog?("Snapshot: wrote \(url.path) (\(data.count) bytes, \(rep.pixelsWide)x\(rep.pixelsHigh))")
            onLog?("Snapshot: SUCCESS — in-process render written.")
        } catch {
            onLog?("Snapshot: FAILED — \(error.localizedDescription)")
        }
    }

    private func writeJPEG(_ cgImage: CGImage) throws {
        let dir = try framesDirectory()
        let filename = "frame-\(Int(Date().timeIntervalSince1970)).jpg"
        let url = dir.appendingPathComponent(filename)

        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            throw NSError(domain: "PocA.Capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "JPEG encoding failed."])
        }
        try data.write(to: url)
        onLog?("Capture: wrote \(url.path) (\(data.count) bytes)")
    }

    private func framesDirectory() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = support.appendingPathComponent("PocA/poc-frames", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
