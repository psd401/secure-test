import Foundation

/// Observability slice 4, D-11: crash capture, best effort.
///
/// No symbolication, no third-party reporter. What a classroom Mac can
/// honestly give is one line saying which signal killed the app, which build
/// it was, and which attempt was open — plus the error lines already in
/// `errors.log` above it.
///
/// The hard constraint is what a signal handler may do: `write(2)` to an
/// already-open descriptor and essentially nothing else. No allocation, no
/// Swift `String`, no locks, no Foundation. So every line this can ever write
/// is built ahead of time, in normal code, and parked in C memory; the handler
/// picks one by scanning a small array and writes it.
public enum CrashReporter {
    /// The signals worth catching, with the names that go in the line. A
    /// static table because the handler cannot call `strsignal`.
    public static let watchedSignals: [(signal: Int32, name: String)] = [
        (SIGABRT, "SIGABRT"),
        (SIGSEGV, "SIGSEGV"),
        (SIGBUS, "SIGBUS"),
        (SIGILL, "SIGILL"),
        (SIGTRAP, "SIGTRAP"),
    ]

    /// The slot id for the line `exit(70)` writes. Not a real signal number.
    static let unrecoverableSlot: Int32 = -70

    /// The kind written for a fatal signal. Matches the server's free-form
    /// `kind` column; nothing parses it but a human.
    public static let crashKind = "crash"
    public static let unrecoverableKind = "lockdown_unrecoverable"
    public static let uncaughtExceptionKind = "uncaught_exception"

    /// One pre-formatted JSON line.
    ///
    /// Deliberately missing `occurred_at`: the handler cannot read a clock, so
    /// claiming a time here would mean stamping install time on a crash that
    /// happened an hour later. The drain fills in its own time and says so.
    public static func line(
        kind: String,
        message: String,
        stamp: AppBuildStamp,
        attemptID: String?
    ) -> String {
        var object: [String: Any] = [
            "kind": kind,
            "message": message,
            "app_version": stamp.version,
            "app_commit": stamp.commit,
        ]
        if let attemptID { object["attempt_id"] = attemptID }
        guard
            let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else {
            return "{\"kind\":\"\(kind)\",\"message\":\"line could not be encoded\"}\n"
        }
        return text + "\n"
    }

    /// Every line this reporter can write, for the build and attempt given.
    /// Exposed so a test can assert the shape without installing anything.
    public static func lines(stamp: AppBuildStamp, attemptID: String?) -> [(Int32, String)] {
        var out = watchedSignals.map { entry in
            (
                entry.signal,
                line(
                    kind: crashKind,
                    message: "fatal signal \(entry.name)",
                    stamp: stamp,
                    attemptID: attemptID
                )
            )
        }
        out.append((
            unrecoverableSlot,
            line(
                kind: unrecoverableKind,
                message: "lockdown unrecoverable — exit(70)",
                stamp: stamp,
                attemptID: attemptID
            )
        ))
        return out
    }

    // MARK: install

    /// Install the handlers against an already-open sink.
    ///
    /// Idempotent in effect: calling it again re-registers the same handlers
    /// and rebuilds the buffers.
    public static func install(log: ClientErrorLog, stamp: AppBuildStamp, attemptID: String? = nil) {
        crashDescriptor = log.rawDescriptor
        crashLog = log
        prepare(stamp: stamp, attemptID: attemptID)
        for entry in watchedSignals {
            signal(entry.signal, secureTestCrashSignalHandler)
        }
        NSSetUncaughtExceptionHandler(secureTestUncaughtExceptionHandler)
    }

    /// Re-prepare the parked lines — called when an attempt starts or ends so
    /// a crash line names the attempt the student was in.
    ///
    /// The previous buffers are deliberately LEAKED rather than freed: a
    /// signal could be mid-`write` on one, and a handful of ~200-byte
    /// allocations over an app's lifetime is a better trade than a use-after-
    /// free inside a crash handler.
    public static func prepare(stamp: AppBuildStamp, attemptID: String?) {
        let prepared = lines(stamp: stamp, attemptID: attemptID)
        let slots = UnsafeMutablePointer<CrashSlot>.allocate(capacity: prepared.count)
        for (index, item) in prepared.enumerated() {
            let bytes = Array(item.1.utf8)
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
            buffer.update(from: bytes, count: bytes.count)
            slots[index] = CrashSlot(signal: item.0, bytes: buffer, length: bytes.count)
        }
        // Count first, then the pointer: a handler that reads the new count
        // against the old table would scan past its end.
        crashSlotCount = 0
        crashSlots = slots
        crashSlotCount = prepared.count
    }

    /// The `exit(70)` path (`lockdown.onUnrecoverable`). Same mechanism as the
    /// signal handler because the situation is the same one: the main thread
    /// is presumed gone and only a synchronous write can survive.
    public static func writeUnrecoverableLine() {
        writeSlot(unrecoverableSlot)
    }

    /// Raise SIGABRT deliberately — the hand-run's crash trigger, gated by the
    /// caller on `SECURE_TEST_DEBUG_CRASH=1`.
    public static func triggerDebugCrash() -> Never {
        raise(SIGABRT)
        // If SIGABRT was somehow ignored, do not return to a caller that
        // declared Never.
        exit(134)
    }
}

// MARK: - the async-signal-safe half

/// C-layout on purpose: the handler indexes this without touching the Swift
/// runtime.
struct CrashSlot {
    var signal: Int32
    var bytes: UnsafeMutablePointer<UInt8>?
    var length: Int
}

nonisolated(unsafe) var crashSlots: UnsafeMutablePointer<CrashSlot>?
nonisolated(unsafe) var crashSlotCount: Int = 0
nonisolated(unsafe) var crashDescriptor: Int32 = -1
/// Only the uncaught-exception handler uses this; it runs in ordinary code,
/// before `abort()`, so it may build strings.
nonisolated(unsafe) var crashLog: ClientErrorLog?

/// Write one parked line. Nothing here allocates, locks, or builds a String.
func writeSlot(_ slot: Int32) {
    guard crashDescriptor >= 0, let slots = crashSlots else { return }
    var index = 0
    while index < crashSlotCount {
        if slots[index].signal == slot, let bytes = slots[index].bytes {
            var offset = 0
            while offset < slots[index].length {
                let written = Darwin.write(
                    crashDescriptor,
                    bytes + offset,
                    slots[index].length - offset
                )
                if written <= 0 { return }
                offset += written
            }
            return
        }
        index += 1
    }
}

/// A C function pointer: no captures, no context.
func secureTestCrashSignalHandler(_ sig: Int32) {
    writeSlot(sig)
    // Re-raise with the default disposition so the crash still looks like a
    // crash to the OS — a report, a non-zero exit, and nothing swallowed.
    signal(sig, SIG_DFL)
    raise(sig)
}

/// Not a signal context: an uncaught ObjC exception unwinds normally and calls
/// this before `abort()`, so the ordinary sink is usable and the reason and
/// class name are worth having.
func secureTestUncaughtExceptionHandler(_ exception: NSException) {
    crashLog?.record(
        kind: CrashReporter.uncaughtExceptionKind,
        message: "\(exception.name.rawValue): \(exception.reason ?? "no reason")",
        context: ["frames": String(exception.callStackReturnAddresses.count)]
    )
}
