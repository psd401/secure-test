import XCTest
@testable import SecureTestCore

/// C-4 / D-7: the clamp and the step behind pinch-to-zoom and the Session
/// menu's three zoom items. The gesture and the menu themselves need a window
/// server (ADR 0013); this is the arithmetic under both.
final class ZoomLevelTests: XCTestCase {
    func testTheRangeIsOneToThree() {
        XCTAssertEqual(ZoomLevel.minimum, 1.0)
        XCTAssertEqual(ZoomLevel.maximum, 3.0)
    }

    func testClampHoldsTheEnds() {
        XCTAssertEqual(ZoomLevel.clamp(0.25), 1.0)
        XCTAssertEqual(ZoomLevel.clamp(1.0), 1.0)
        XCTAssertEqual(ZoomLevel.clamp(2.0), 2.0)
        XCTAssertEqual(ZoomLevel.clamp(3.0), 3.0)
        XCTAssertEqual(ZoomLevel.clamp(12.0), 3.0)
        XCTAssertEqual(ZoomLevel.clamp(-4.0), 1.0)
    }

    /// A pinch that produced garbage must not reach AppKit as garbage.
    func testClampTreatsNonFiniteAsNoZoom() {
        XCTAssertEqual(ZoomLevel.clamp(.nan), 1.0)
        XCTAssertEqual(ZoomLevel.clamp(.infinity), 1.0)
        XCTAssertEqual(ZoomLevel.clamp(-.infinity), 1.0)
    }

    func testZoomingInSteps() {
        XCTAssertEqual(ZoomLevel.zoomedIn(from: 1.0), 1.25, accuracy: 0.0001)
        XCTAssertEqual(ZoomLevel.zoomedIn(from: 1.25), 1.5625, accuracy: 0.0001)
        // Four presses from 1x pass 2.44x; the fifth is capped.
        XCTAssertEqual(ZoomLevel.zoomedIn(from: 2.5), 3.0, accuracy: 0.0001)
        XCTAssertEqual(ZoomLevel.zoomedIn(from: 3.0), 3.0, accuracy: 0.0001)
    }

    func testZoomingOutStepsAndStopsAtActualSize() {
        XCTAssertEqual(ZoomLevel.zoomedOut(from: 2.0), 1.6, accuracy: 0.0001)
        XCTAssertEqual(ZoomLevel.zoomedOut(from: 1.25), 1.0, accuracy: 0.0001)
        XCTAssertEqual(ZoomLevel.zoomedOut(from: 1.0), 1.0, accuracy: 0.0001)
        XCTAssertEqual(ZoomLevel.zoomedOut(from: 0.5), 1.0, accuracy: 0.0001)
    }

    /// A step out undoes a step in exactly, so the student can get back to the
    /// size they had.
    func testAStepOutUndoesAStepIn() {
        let stepped = ZoomLevel.zoomedIn(from: 1.6)
        XCTAssertEqual(ZoomLevel.zoomedOut(from: stepped), 1.6, accuracy: 0.0001)
    }

    /// Whatever a trackpad pinch settles on lands inside the range.
    func testEveryPinchResultClampsIntoTheRange() {
        for raw in stride(from: -2.0, through: 12.0, by: 0.37) {
            let clamped = ZoomLevel.clamp(raw)
            XCTAssertGreaterThanOrEqual(clamped, ZoomLevel.minimum)
            XCTAssertLessThanOrEqual(clamped, ZoomLevel.maximum)
        }
    }
}
