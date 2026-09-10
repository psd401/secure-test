import XCTest
@testable import SecureTestCore

/// Finding C-1 (`docs/multi-source-stimulus-design.md`): the page build waits
/// for the lockdown session to settle before it reads the viewport width.
///
/// The view controller and the AppKit host cannot be exercised in this package
/// (ADR 0013), so the gate is where the rules live — opens once, wakes every
/// waiter, and gives up after the backstop rather than holding a test shut.
final class PageLoadGateTests: XCTestCase {
    func testAWaitResolvesWhenTheGateOpens() async throws {
        let gate = PageLoadGate()
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.open()
        }
        // A generous backstop that must not be waited out.
        let started = ContinuousClock.now
        let opened = await gate.wait(timeout: .seconds(30))
        XCTAssertTrue(opened)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testOpeningBeforeTheWaitReturnsAtOnce() async throws {
        let gate = PageLoadGate()
        await gate.open()
        let isOpen = await gate.opened
        XCTAssertTrue(isOpen)
        let started = ContinuousClock.now
        let opened = await gate.wait(timeout: .seconds(30))
        XCTAssertTrue(opened, "a session that settled before the fetch returned must not stall the build")
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testTheBackstopGivesUpAndTheGateStillWorksAfterwards() async throws {
        let gate = PageLoadGate()
        let opened = await gate.wait(timeout: .milliseconds(50))
        XCTAssertFalse(opened, "the caller is told it timed out, so it can say so in the log")
        // Giving up on one wait does not break the next.
        await gate.open()
        let second = await gate.wait(timeout: .seconds(30))
        XCTAssertTrue(second)
    }

    func testOpenIsIdempotentAndWakesEveryWaiter() async throws {
        let gate = PageLoadGate()
        async let first = gate.wait(timeout: .seconds(30))
        async let second = gate.wait(timeout: .seconds(30))
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.open()
            // A second open — `.active` then `.idle` on the same attempt — must
            // not double-resume a continuation.
            await gate.open()
        }
        let results = await [first, second]
        XCTAssertEqual(results, [true, true])
    }
}
