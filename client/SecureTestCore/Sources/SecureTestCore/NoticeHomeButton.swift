import Foundation

/// Client release queue item 3 (2026-11-26, from the review of PR #260): the
/// in-page "Back to your tests" on the attempt screen's failure notices that
/// come BEFORE any secure session — "This test could not be opened." and the
/// rejoin give-up ("Your teacher hasn't let you back in yet."). Those pages
/// had no way out: the titlebar "Back to your tests" is installed only after
/// a hand-in, so a student was left to quit the app.
///
/// The press posts on the page's `home` channel, the one the results page's
/// Done uses; the host's `BackToTests.decide` still refuses to leave while a
/// secure session is active, so the button cannot strand a locked Mac.
///
/// Not for notices shown while a session is starting or ending ("Still
/// starting the secure session…", "Finishing your secure session…").
public enum NoticeHomeButton {
    public static let title = "Back to your tests"
    public static let elementID = "notice-home"

    public static var markup: String {
        """
        <div class="notice-actions"><button type="button" id="\(elementID)" class="notice-home">\(HTMLEscape.text(title))</button></div>
        """
    }

    public static let styles = """
    .notice-actions { margin: 20px 0 0; display: flex; justify-content: flex-end; }
    .notice-home {
      font: inherit; font-size: 15px; padding: 8px 18px; border-radius: 6px; cursor: pointer;
      background: var(--accent, #346780); border: 1px solid var(--accent, #346780);
      color: var(--accent-ink, #fffaec);
    }
    .notice-home:focus-visible { outline: 3px solid var(--accent, #346780); outline-offset: 2px; }
    """

    /// Click → `home`, once (a double press would otherwise post twice), and
    /// the button takes focus so Return or Space presses it.
    public static let script = #"""
    (function () {
      var button = document.getElementById('notice-home');
      if (!button) return;
      var sent = false;
      button.onclick = function () {
        if (sent) return;
        sent = true;
        try { window.webkit.messageHandlers.home.postMessage({}); } catch (e) {}
      };
      try { button.focus(); } catch (e) {}
    })();
    """#
}
