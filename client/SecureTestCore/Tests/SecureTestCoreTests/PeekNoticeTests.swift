import XCTest
@testable import SecureTestCore

/// Hand-run finding 8.1: the student can close the peek notice, and every
/// later peek is disclosed again regardless.
final class PeekNoticeTests: XCTestCase {

    func testNothingIsShownUntilAPeek() {
        let notice = PeekNotice()
        XCTAssertFalse(notice.isShown)
        XCTAssertNil(notice.text)
    }

    func testAPeekShowsTheNoticeAndTheViewedAtFlipUpdatesItInPlace() {
        var notice = PeekNotice()
        notice.show("Your teacher is viewing your screen")
        XCTAssertTrue(notice.isShown)
        XCTAssertEqual(notice.text, "Your teacher is viewing your screen")

        notice.show("Your teacher viewed your screen at 9:41 AM")
        XCTAssertTrue(notice.isShown)
        XCTAssertEqual(notice.text, "Your teacher viewed your screen at 9:41 AM")
    }

    func testDismissHidesItAndIsIdempotent() {
        var notice = PeekNotice()
        notice.show("Your teacher viewed your screen at 9:41 AM")
        notice.dismiss()
        XCTAssertFalse(notice.isShown)
        XCTAssertNil(notice.text)

        notice.dismiss()
        XCTAssertFalse(notice.isShown)
        XCTAssertEqual(notice, PeekNotice())
    }

    func testALaterPeekShowsAgainAfterADismissal() {
        var notice = PeekNotice()
        notice.show("Your teacher viewed your screen at 9:41 AM")
        notice.dismiss()
        XCTAssertFalse(notice.isShown)

        // The second peek's request-time banner: disclosed afresh, the
        // dismissal did not outlive it.
        notice.show("Your teacher is viewing your screen")
        XCTAssertTrue(notice.isShown)
        XCTAssertEqual(notice.text, "Your teacher is viewing your screen")

        notice.show("Your teacher viewed your screen at 9:52 AM")
        XCTAssertEqual(notice.text, "Your teacher viewed your screen at 9:52 AM")
    }

    /// A close between the request-time banner and the "viewed at" flip
    /// (milliseconds apart in the app, but the button is live) must not
    /// swallow the disclosure of that peek.
    func testDismissBetweenRequestAndViewedAtDoesNotSwallowTheFlip() {
        var notice = PeekNotice()
        notice.show("Your teacher is viewing your screen")
        notice.dismiss()
        notice.show("Your teacher viewed your screen at 9:41 AM")
        XCTAssertTrue(notice.isShown)
        XCTAssertEqual(notice.text, "Your teacher viewed your screen at 9:41 AM")
    }
}
