import XCTest
@testable import SecureTestCore

final class ExitConfirmationTests: XCTestCase {
    /// Field report 2026-10-08: ask before an exit only while a test is open
    /// in a live session and not handed in; never for a system quit.
    func testExitConfirmationRule() {
        XCTAssertTrue(ExitConfirmation.shouldConfirm(lockdownActive: true, onAttemptScreen: true, handedIn: false))
        XCTAssertFalse(ExitConfirmation.shouldConfirm(lockdownActive: false, onAttemptScreen: true, handedIn: false))
        XCTAssertFalse(ExitConfirmation.shouldConfirm(lockdownActive: true, onAttemptScreen: false, handedIn: false))
        XCTAssertFalse(ExitConfirmation.shouldConfirm(lockdownActive: true, onAttemptScreen: true, handedIn: true))
        XCTAssertFalse(ExitConfirmation.shouldConfirm(
            lockdownActive: true, onAttemptScreen: true, handedIn: false, systemInitiatedQuit: true))
        XCTAssertEqual(ExitConfirmation.keepWorkingTitle, "Keep working")
        XCTAssertEqual(ExitConfirmation.confirmTitle(.endSession), "End session")
        XCTAssertEqual(ExitConfirmation.confirmTitle(.quit), "Quit")
    }
}
