import XCTest
@testable import SecureTestCore

/// Finding C-1 (`docs/multi-source-stimulus-design.md`): the page build waits
/// for the lockdown session before it reads the viewport width.
///
/// Security slice 1 (2026-09-15 end-state audit): and it waits for `.active`
/// specifically — a session that failed to begin `refuse()`s the gate, and a
/// session that never answers times it out. Neither may build the test.
///
/// The view controller and the AppKit host cannot be exercised in this package
/// (ADR 0013), so the gate is where the rules live.
final class PageLoadGateTests: XCTestCase {
    func testAWaitResolvesWhenTheGateOpens() async throws {
        let gate = PageLoadGate()
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.open()
        }
        // A generous backstop that must not be waited out.
        let started = ContinuousClock.now
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(outcome, .opened)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testOpeningBeforeTheWaitReturnsAtOnce() async throws {
        let gate = PageLoadGate()
        await gate.open()
        let isOpen = await gate.opened
        XCTAssertTrue(isOpen)
        let started = ContinuousClock.now
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(
            outcome, .opened,
            "a session that became active before the fetch returned must not stall the build"
        )
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testARefusalWakesAWaiterWithoutOpening() async throws {
        let gate = PageLoadGate()
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.refuse()
        }
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(outcome, .refused, "a failed begin() must never hand over the test")
        let isOpen = await gate.opened
        XCTAssertFalse(isOpen)
    }

    func testRefusingBeforeTheWaitReturnsAtOnce() async throws {
        let gate = PageLoadGate()
        await gate.refuse()
        let started = ContinuousClock.now
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(outcome, .refused)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
    }

    func testRefusingAfterOpeningIsANoOp() async throws {
        let gate = PageLoadGate()
        await gate.open()
        // Every session reaches `.idle` eventually — the end of a legitimate
        // one must not read as a failure to start.
        await gate.refuse()
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(outcome, .opened)
    }

    func testOpeningAfterRefusingIsANoOp() async throws {
        let gate = PageLoadGate()
        await gate.refuse()
        await gate.open()
        let outcome = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(outcome, .refused)
    }

    func testTheBackstopGivesUpAndTheGateStillWorksAfterwards() async throws {
        let gate = PageLoadGate()
        let outcome = await gate.wait(timeout: .milliseconds(50))
        XCTAssertEqual(
            outcome, .timedOut,
            "the caller is told it timed out, so it refuses the build rather than guessing"
        )
        let settled = await gate.outcome
        XCTAssertNil(settled, "a backstop that ran out is the waiter's answer, not the gate's state")
        // Giving up on one wait does not break the next.
        await gate.open()
        let second = await gate.wait(timeout: .seconds(30))
        XCTAssertEqual(second, .opened)
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
        XCTAssertEqual(results, [.opened, .opened])
    }

    func testRefuseWakesEveryWaiterOnce() async throws {
        let gate = PageLoadGate()
        async let first = gate.wait(timeout: .seconds(30))
        async let second = gate.wait(timeout: .seconds(30))
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await gate.refuse()
            await gate.refuse()
        }
        let results = await [first, second]
        XCTAssertEqual(results, [.refused, .refused])
    }
}
