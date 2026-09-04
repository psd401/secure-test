import XCTest
@testable import SecureTestCore

/// Slice 84: the student's pre-assigned sittings — wire decoding and the row
/// presentation the entry screen lays out. The wire shape is the phase-7
/// contract as of slice 83 (`docs/phase-7-slices.md`).
final class MySittingsTests: XCTestCase {
    static let contractJSON = #"""
    { "sittings": [ {
        "test_session_id": "ts-1",
        "assessment_id": "a-1",
        "assessment_name": "Algebra quiz",
        "teacher_email": "teacher@psd401.net",
        "scope": "section",
        "section_label": "Algebra 1 · 3(A)",
        "expires_at": "2026-08-27T22:08:54.000Z",
        "created_at": "2026-08-27T20:08:54.000Z",
        "attempt": null
    } ] }
    """#

    func testDecodesTheContractExample() throws {
        let mine = try JSONDecoder().decode(MySittings.self, from: Data(Self.contractJSON.utf8))
        XCTAssertNil(mine.reason)
        XCTAssertEqual(mine.sittings.count, 1)
        let sitting = try XCTUnwrap(mine.sittings.first)
        XCTAssertEqual(sitting.testSessionID, "ts-1")
        XCTAssertEqual(sitting.assessmentID, "a-1")
        XCTAssertEqual(sitting.assessmentName, "Algebra quiz")
        XCTAssertEqual(sitting.teacherEmail, "teacher@psd401.net")
        XCTAssertEqual(sitting.sectionLabel, "Algebra 1 · 3(A)")
        XCTAssertNil(sitting.attempt)
        XCTAssertEqual(
            sitting.expiryDate,
            Date(timeIntervalSince1970: 1_787_868_534), // 2026-08-27T22:08:54Z
        )
    }

    func testDecodesAnAccountReason() throws {
        let mine = try JSONDecoder().decode(
            MySittings.self,
            from: Data(#"{ "sittings": [], "reason": "not_on_roster" }"#.utf8),
        )
        XCTAssertEqual(mine.reason, "not_on_roster")
        XCTAssertTrue(mine.sittings.isEmpty)
        // The reason codes are the redeem codes; the same words apply.
        XCTAssertEqual(
            JoinErrorCopy.message(forCode: mine.reason),
            "You are not on the list for this test. Tell your teacher.",
        )
    }

    func testExpiryParsesWithAndWithoutFractionalSeconds() {
        XCTAssertNotNil(ISO8601.parse("2026-08-27T22:08:54.000Z"))
        XCTAssertNotNil(ISO8601.parse("2026-08-27T22:08:54Z"))
        XCTAssertNil(ISO8601.parse("not a date"))
    }

    private func sitting(
        scope: String = "section",
        sectionLabel: String? = "Algebra 1 · 3(A)",
        teacher: String? = "teacher@psd401.net",
        expiresAt: String? = "2026-08-27T22:08:54.000Z",
        attemptStatus: String? = nil,
        code: String? = nil,
    ) throws -> MySittings.Sitting {
        var object: [String: Any] = [
            "test_session_id": "ts-1",
            "assessment_id": "a-1",
            "assessment_name": "Algebra quiz",
            "scope": scope,
        ]
        object["section_label"] = sectionLabel
        object["teacher_email"] = teacher
        object["expires_at"] = expiresAt
        object["code"] = code
        if let attemptStatus {
            object["attempt"] = ["id": "at-1", "status": attemptStatus]
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MySittings.Sitting.self, from: data)
    }

    func testRowStates() throws {
        XCTAssertEqual(SittingRowModel(try sitting(attemptStatus: nil)).state, .join)
        XCTAssertEqual(SittingRowModel(try sitting(attemptStatus: "in_progress")).state, .resume)
        XCTAssertEqual(SittingRowModel(try sitting(attemptStatus: "submitted")).state, .done)
    }

    func testDetailPrefersTheSectionLabelAndNamesTheTeacher() throws {
        let row = SittingRowModel(try sitting())
        XCTAssertEqual(row.detail, "Algebra 1 · 3(A) — teacher@psd401.net")
    }

    func testDetailLeadsWithTheSittingCodeWhenTheServerSendsOne() throws {
        // Finding 10.5: the code is what the teacher reads out.
        let row = SittingRowModel(try sitting(scope: "section", sectionLabel: "Algebra 1 · 3(A)", code: "NBVC8P"))
        XCTAssertEqual(row.detail, "NBVC8P · Algebra 1 · 3(A) — teacher@psd401.net")
        XCTAssertEqual(
            SittingRowModel(try sitting(scope: "students", sectionLabel: nil, teacher: nil, code: "NBVC8P")).detail,
            "NBVC8P · Assigned to you"
        )
    }

    func testDetailWordsTheScopeWhenThereIsNoLabel() throws {
        XCTAssertEqual(
            SittingRowModel(try sitting(scope: "sections", sectionLabel: nil)).detail,
            "All sections — teacher@psd401.net",
        )
        XCTAssertEqual(
            SittingRowModel(try sitting(scope: "students", sectionLabel: nil, teacher: nil)).detail,
            "Assigned to you",
        )
    }

    func testExpiryLabelIsTimeOnlyOnTheSameDayAndDatedOtherwise() throws {
        let row = SittingRowModel(try sitting())
        let locale = Locale(identifier: "en_US_POSIX")
        let utc = TimeZone(identifier: "UTC")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc

        let sameDay = row.expiryLabel(
            now: Date(timeIntervalSince1970: 1_787_868_534 - 7_200), // two hours before
            calendar: calendar, locale: locale, timeZone: utc,
        )
        // The formatter separates AM/PM with U+202F; normalize before comparing.
        func plainSpaces(_ s: String?) -> String? {
            s?.replacingOccurrences(of: "\u{202F}", with: " ")
        }
        XCTAssertEqual(plainSpaces(sameDay), "closes 10:08 PM")

        let dayBefore = row.expiryLabel(
            now: Date(timeIntervalSince1970: 1_787_868_534 - 86_400),
            calendar: calendar, locale: locale, timeZone: utc,
        )
        XCTAssertEqual(plainSpaces(dayBefore), "closes Aug 27, 2026 at 10:08 PM")

        XCTAssertNil(SittingRowModel(try sitting(expiresAt: nil)).expiryLabel())
    }
}

final class APIClientMySittingsTests: XCTestCase {
    func testMySittingsIsAnAuthenticatedGet() async throws {
        let transport = RecordingTransport(body: MySittingsTests.contractJSON)
        let client = APIClient(
            baseURL: URL(string: "https://d.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "t"),
        )
        let mine = try await client.mySittings()
        XCTAssertEqual(mine.sittings.first?.assessmentName, "Algebra quiz")
        let request = try XCTUnwrap(transport.sent.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/me/sittings")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        XCTAssertNil(request.httpBody)
    }

    func testAStaffSessionsRefusalSurfacesAsRefused() async {
        let transport = RecordingTransport(status: 403, body: #"{"ok":false,"error":"staff_session"}"#)
        let client = APIClient(
            baseURL: URL(string: "https://d.example")!,
            transport: transport,
            tokens: InMemoryTokenStore(token: "t"),
        )
        do {
            _ = try await client.mySittings()
            XCTFail("expected refused")
        } catch {
            XCTAssertEqual(error as? APIError, .refused(status: 403, code: "staff_session"))
        }
    }
}
