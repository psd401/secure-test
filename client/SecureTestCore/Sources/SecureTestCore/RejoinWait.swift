import Foundation

/// Working-time clock slice 4 (`docs/working-time-clock-design.md`, D2).
///
/// On a working-time test, coming back into the same sitting after leaving it
/// waits for the teacher's "Let back in": the delivery route answers 409
/// `rejoin_needs_approval` until then. That refusal comes at the bundle fetch,
/// BEFORE begin(), so waiting here never holds a secure session open.
///
/// Instead of sending the student home to re-open the test by hand after the
/// teacher presses the button, the attempt screen says so and asks again every
/// `interval`, for `window` (the server's approval window, 10 minutes). A
/// refused retry writes nothing on the server — the request is recorded once.
public enum RejoinWait {
    public static let interval: Duration = .seconds(10)
    public static let window: Duration = .seconds(600)

    /// How many fetches fit the window: the first, then one per interval.
    public static func maxAttempts(interval: Duration = interval, window: Duration = window) -> Int {
        let steps = Int(window / interval)
        return max(1, steps + 1)
    }

    /// Runs `fetch`, retrying while it throws `rejoin_needs_approval`.
    /// `onWaiting` fires once, before the first wait. Any other error, the
    /// last refusal, or `shouldContinue()` turning false (the screen went
    /// away) is thrown to the caller.
    @MainActor
    public static func run<T>(
        maxAttempts: Int = maxAttempts(),
        interval: Duration = interval,
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        shouldContinue: () -> Bool = { true },
        onWaiting: () -> Void = {},
        _ fetch: () async throws -> T
    ) async throws -> T {
        var attempt = 1
        while true {
            do {
                return try await fetch()
            } catch let error as APIError where error.isRejoinNeedsApproval {
                guard attempt < maxAttempts, shouldContinue() else { throw error }
                if attempt == 1 { onWaiting() }
                attempt += 1
                await sleep(interval)
                guard shouldContinue() else { throw error }
            }
        }
    }
}
