import JavaScriptCore
import XCTest
@testable import SecureTestCore

/// Client release queue item 3: the way home from a failure notice shown
/// before any secure session.
final class NoticeHomeButtonTests: XCTestCase {
    func testMarkupNamesTheButtonTheScriptLooksFor() {
        XCTAssertTrue(NoticeHomeButton.markup.contains(#"id="notice-home""#))
        XCTAssertTrue(NoticeHomeButton.markup.contains(">Back to your tests</button>"))
        XCTAssertTrue(NoticeHomeButton.markup.contains(#"type="button""#))
        XCTAssertTrue(NoticeHomeButton.script.contains("getElementById('\(NoticeHomeButton.elementID)')"))
    }

    func testTheButtonIsDrawnFromThemeTokens() {
        // Theme tokens, with the default theme as fallback.
        XCTAssertTrue(NoticeHomeButton.styles.contains("var(--accent"))
        XCTAssertTrue(NoticeHomeButton.styles.contains("var(--accent-ink"))
    }

    /// A stand-in for the page: one button, and the host's message handlers.
    private func runNotice(withButton: Bool = true) throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var __home = [], __focused = false;
        var __button = { onclick: null, focus: function () { __focused = true; } };
        var document = { getElementById: function (id) {
          return (\(withButton) && id === 'notice-home') ? __button : null;
        } };
        var window = { webkit: { messageHandlers: {
          home: { postMessage: function (m) { __home.push(m); } }
        } } };
        """)
        context.evaluateScript(NoticeHomeButton.script)
        XCTAssertNil(context.exception, "\(String(describing: context.exception))")
        return context
    }

    func testPressingItAsksTheHostToGoHomeOnce() throws {
        let c = try runNotice()
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 0, "nothing sent before a press")
        c.evaluateScript("__button.onclick()")
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 1)
        c.evaluateScript("__button.onclick()")
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 1, "once only")
    }

    func testTheButtonTakesFocusForTheKeyboard() throws {
        XCTAssertTrue(try runNotice().evaluateScript("__focused")?.toBool() ?? false)
    }

    func testAPageWithoutTheButtonIsLeftAlone() throws {
        let c = try runNotice(withButton: false)
        XCTAssertEqual(c.evaluateScript("__home.length")?.toInt32(), 0)
    }
}
