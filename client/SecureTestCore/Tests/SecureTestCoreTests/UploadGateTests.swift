import XCTest
@testable import SecureTestCore

/// The hand-in's half of drawing auto-save
/// (`docs/drawing-tools-design.md` §Auto-save, slice 2).
///
/// The counting and the waiting live in Core precisely so they can be checked
/// here: the view controller that uses the gate cannot be exercised at all in
/// this package (ADR 0013), so a bug in "does the submit wait" would otherwise
/// only ever show up as a lost drawing in a real sitting.
final class UploadGateTests: XCTestCase {
    func testAnIdleGateReturnsAtOnce() async throws {
        let gate = UploadGate()
        let inFlight = await gate.inFlight
        XCTAssertEqual(inFlight, 0)
        // A generous timeout that must not be waited out: the call returns
        // because the gate is idle, not because the clock ran down.
        let started = ContinuousClock.now
        let pending = await gate.waitForIdle(timeout: .seconds(30))
        XCTAssertEqual(pending, 0)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testBeginAndEndCountUpAndDown() async throws {
        let gate = UploadGate()
        await gate.begin()
        await gate.begin()
        var inFlight = await gate.inFlight
        XCTAssertEqual(inFlight, 2)
        await gate.end()
        inFlight = await gate.inFlight
        XCTAssertEqual(inFlight, 1)
        await gate.end()
        inFlight = await gate.inFlight
        XCTAssertEqual(inFlight, 0)
        // An unmatched end cannot push the count negative — a gate stuck below
        // zero would swallow the next real upload.
        await gate.end()
        inFlight = await gate.inFlight
        XCTAssertEqual(inFlight, 0)
    }

    func testWaitingReturnsZeroWhenTheUploadFinishesFirst() async throws {
        let gate = UploadGate()
        await gate.begin()
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.end()
        }
        let pending = await gate.waitForIdle(timeout: .seconds(30))
        XCTAssertEqual(pending, 0, "the wait ends the moment the upload lands")
    }

    func testWaitingReturnsWhatIsLeftWhenTheTimeoutWins() async throws {
        let gate = UploadGate()
        await gate.begin()
        await gate.begin()
        let pending = await gate.waitForIdle(timeout: .milliseconds(50))
        XCTAssertEqual(pending, 2, "the caller is told how many are stuck, not just that it gave up")
        // The gate is still usable afterwards: giving up on one wait does not
        // break the next.
        await gate.end()
        await gate.end()
        let after = await gate.waitForIdle(timeout: .seconds(30))
        XCTAssertEqual(after, 0)
    }

    func testEveryWaiterIsWokenByTheLastEnd() async throws {
        let gate = UploadGate()
        await gate.begin()
        async let first = gate.waitForIdle(timeout: .seconds(30))
        async let second = gate.waitForIdle(timeout: .seconds(30))
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.end()
        }
        let results = await [first, second]
        XCTAssertEqual(results, [0, 0])
    }
}
