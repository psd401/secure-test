import Foundation

/// Instant feedback slice 3 (`docs/instant-feedback-design.md`, D-2): the page
/// a student sees after their own hand-in, once the secure session has ended
/// (`DID END`) and the window is back to normal.
///
/// Built with the same shell as the test (`PageShell.document`): the same
/// tokens, so every `color_contrast` set, the optional font and the `zoom`
/// level apply unchanged; the same CSP, so nothing on the page can reach the
/// network; the same KaTeX and the same `$…$` rule
/// (`AssessmentPage.mathPassFunctions`, shared verbatim, not copied).
///
/// Every string the server sent is HTML-escaped here in Swift before it is
/// placed in the markup — the answers are student- and teacher-authored text
/// — and only THEN does the page's math pass turn `$…$` runs in text nodes
/// into KaTeX. Nothing authored is ever parsed as markup. Line breaks in an
/// answer (`\n`, the builder's line joiner) are kept by `white-space:
/// pre-line`, as the test's stems keep theirs.
///
/// Semantics for VoiceOver (heading, then the score line, the pending line,
/// the note, then one list item per question with its result as words): the
/// ✓ / ✗ marks are decoration (`aria-hidden`) — the result is always the
/// row's text, never only its colour or glyph.
public enum InstantFeedbackPage {
    /// - Parameters:
    ///   - feedback: the decoded submit-response object.
    ///   - accommodations: the attempt's effective map (the delivery bundle's).
    ///     Drives the contrast / font / zoom attributes exactly as on the test,
    ///     and whether the page carries a Read aloud button (any read-aloud
    ///     grant — the host refuses to speak without one regardless).
    ///   - katex: the vendored bundle by default; tests pass an empty one.
    public static func html(
        _ feedback: InstantFeedback,
        accommodations: [String: String] = [:],
        katex: KatexBundle.Assets = KatexBundle.shared
    ) -> String {
        let readAloud = TextToSpeechScope(accommodations: accommodations).isEnabled
        return PageShell.document(
            title: InstantFeedbackPresentation.heading,
            styles: [katex.css, styles],
            scripts: [
                katex.js,
                KatexBundle.macrosScript,
                AssessmentPage.mathPassFunctions,
                script,
            ],
            body: body(InstantFeedbackPresentation(feedback), readAloud: readAloud),
            accommodations: accommodations
        )
    }

    static func body(_ presentation: InstantFeedbackPresentation, readAloud: Bool) -> String {
        var html = """
        <main id="feedback" class="feedback">
        <h1 id="feedback-heading" tabindex="-1">\(HTMLEscape.text(InstantFeedbackPresentation.heading))</h1>
        <p class="feedback-score">\(HTMLEscape.text(presentation.scoreLine))</p>
        """
        if let pending = presentation.pendingLine {
            html += "\n<p class=\"feedback-pending\">\(HTMLEscape.text(pending))</p>"
        }
        if let note = presentation.answersNote {
            html += "\n<p class=\"feedback-note\">\(HTMLEscape.text(note))</p>"
        }
        if !presentation.rows.isEmpty {
            // `role="list"`: WebKit drops list semantics from a list styled
            // `list-style: none`, and VoiceOver's "list, N items" is how a
            // student knows how many questions follow.
            html += "\n<ol class=\"feedback-items\" role=\"list\">"
            for row in presentation.rows {
                html += "\n<li class=\"feedback-item result-\(row.result.rawValue)\">"
                html += "<p class=\"feedback-result\"><span class=\"feedback-mark\" aria-hidden=\"true\">\(mark(row.result))</span>"
                html += "\(HTMLEscape.text(row.heading))</p>"
                html += answerLine(
                    label: InstantFeedbackPresentation.yourAnswerLabel,
                    text: row.yourAnswer ?? InstantFeedbackPresentation.noAnswer,
                    className: "feedback-yours"
                )
                if let key = row.correctAnswer {
                    html += answerLine(
                        label: InstantFeedbackPresentation.correctAnswerLabel,
                        text: key,
                        className: "feedback-key"
                    )
                }
                html += "</li>"
            }
            html += "\n</ol>"
        }
        // `tabindex="0"` on both buttons: with macOS Keyboard navigation OFF
        // (the fleet default) WebKit's Tab skips buttons otherwise — HS-1 /
        // ME-1, the same rule the test page applies.
        html += "\n<div class=\"feedback-actions\">"
        if readAloud {
            html += "<button type=\"button\" id=\"feedback-read\" class=\"feedback-read\" tabindex=\"0\">Read aloud</button>"
        }
        html += "<button type=\"button\" id=\"feedback-done\" class=\"feedback-done\" tabindex=\"0\">"
        html += "\(HTMLEscape.text(InstantFeedbackPresentation.doneTitle))</button>"
        html += "</div>\n</main>"
        return html
    }

    private static func answerLine(label: String, text: String, className: String) -> String {
        "<p class=\"feedback-answer \(className)\"><span class=\"feedback-label\">\(HTMLEscape.text(label))</span> "
            + "<span class=\"feedback-text\">\(HTMLEscape.text(text))</span></p>"
    }

    /// Decoration only (`aria-hidden`); the row's words carry the result.
    private static func mark(_ result: InstantFeedback.Result) -> String {
        switch result {
        case .correct: return "✓"
        case .incorrect: return "✗"
        case .partial: return "◐"
        case .pending: return "…"
        }
    }

    /// Every colour reads a token, so each contrast set re-colours the page
    /// the way it re-colours the test; type sizes are `rem`, so `zoom` scales
    /// them.
    static let styles = """
    body { padding: 2rem 2.5rem 3rem; }
    .feedback { max-width: 44rem; margin: 0 auto; }
    .feedback h1 { font-size: 1.75rem; margin: 0 0 1rem; outline: none; }
    .feedback-score { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; line-height: 1.4; }
    .feedback-pending, .feedback-note { margin: 0 0 0.5rem; line-height: 1.5; color: var(--ink-soft); }
    .feedback-items { list-style: none; margin: 1.5rem 0 0; padding: 0; }
    .feedback-item {
      border: 1px solid var(--line-strong); border-left-width: 6px; border-radius: 6px;
      padding: 0.75rem 1rem; margin: 0 0 0.75rem; background: var(--paper);
    }
    .feedback-item.result-correct { border-left-color: var(--ok); }
    .feedback-item.result-partial { border-left-color: var(--warn); }
    .feedback-item.result-incorrect { border-left-color: var(--danger); }
    .feedback-item.result-pending { border-left-color: var(--line-strong); }
    .feedback-result { margin: 0 0 0.375rem; font-weight: 600; }
    .feedback-mark { display: inline-block; min-width: 1.5rem; }
    .result-correct .feedback-mark { color: var(--ok); }
    .result-partial .feedback-mark { color: var(--warn); }
    .result-incorrect .feedback-mark { color: var(--danger); }
    .result-pending .feedback-mark { color: var(--ink-soft); }
    .feedback-answer { margin: 0.25rem 0 0; line-height: 1.5; }
    .feedback-label { color: var(--ink-soft); }
    .feedback-text { white-space: pre-line; }
    .feedback-actions { margin: 2rem 0 0; display: flex; gap: 0.75rem; justify-content: flex-end; }
    .feedback-actions button {
      font: inherit; font-size: 1rem; padding: 0.5rem 1.25rem; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--line-strong); background: var(--paper); color: var(--ink);
    }
    .feedback-actions .feedback-done { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .feedback-actions button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    """

    /// The page's behaviour: the math pass, Done (button, Return, Escape) →
    /// the `home` channel, and the optional Read aloud over the existing `tts`
    /// channel. Runs after `mathPassFunctions` and KaTeX in document order.
    static let script = #"""
    (function () {
      var root = document.getElementById('feedback');
      if (!root) return;

      // The test's own `$…$` rule over every text node — the answers, the
      // keys, the score line — after the markup (already escaped in Swift) is
      // built. No KaTeX (the test harness, a stripped build): the source text
      // stays as written.
      if (typeof katex === 'object' && katex && typeof katex.render === 'function') {
        try {
          renderMathIn(root);
        } catch (e) {
          console.log('KaTeX math pass failed: ' + (e && e.message));
        }
      }

      // Done → "Your tests". Once: Return on the focused Done button would
      // otherwise post twice (the native click and the key handler).
      var homeSent = false;
      function done() {
        if (homeSent) return;
        homeSent = true;
        try { window.webkit.messageHandlers.home.postMessage({}); } catch (e) {}
      }
      var doneButton = document.getElementById('feedback-done');
      if (doneButton) doneButton.onclick = done;

      var readButton = document.getElementById('feedback-read');

      // Return and Escape anywhere on the page are Done, except Return on the
      // Read aloud button, which is that button's own activation.
      document.addEventListener('keydown', function (event) {
        var key = event && event.key;
        if (key === 'Escape') {
          if (event.preventDefault) event.preventDefault();
          done();
        } else if (key === 'Enter' && !(readButton && document.activeElement === readButton)) {
          if (event.preventDefault) event.preventDefault();
          done();
        }
      });

      // Read aloud: the page's text as segments — each text node verbatim and
      // each rendered formula as its TeX (`__tex`, set by `mathFragment`) —
      // the shape the host's `SpeechCommand` takes. A full stop between
      // blocks so a question's heading and its answer are read as two
      // sentences. No per-word highlight on this page (the test's highlight
      // machinery is not carried over); `word` is accepted and ignored.
      var BLOCKS = { h1: true, p: true, li: true };
      function collect(node, out) {
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
          var child = kids[i];
          if (child.nodeType === 3) {
            if (child.textContent) out.push({ kind: 'text', text: child.textContent });
          } else if (child.nodeType === 1) {
            if (child.getAttribute && child.getAttribute('aria-hidden') === 'true') continue;
            if (child.__tex) { out.push({ kind: 'math', tex: child.__tex }); continue; }
            var tag = String(child.localName || child.nodeName || '').toLowerCase();
            if (tag === 'button') continue;
            collect(child, out);
            if (BLOCKS[tag] === true) {
              var last = out.length ? out[out.length - 1] : null;
              var ends = last && last.kind === 'text' && /[.!?:]\s*$/.test(last.text);
              out.push({ kind: 'text', text: ends ? ' ' : '. ' });
            }
          }
        }
        return out;
      }
      window.__secureTestFeedbackSegments = function () { return collect(root, []); };

      var reading = false;
      function setReading(on) {
        reading = on;
        if (readButton) readButton.textContent = on ? 'Stop reading' : 'Read aloud';
      }
      function post(message) {
        try { window.webkit.messageHandlers.tts.postMessage(message); } catch (e) {}
      }
      if (readButton) {
        readButton.onclick = function () {
          if (reading) {
            post({ action: 'stop' });
            setReading(false);
          } else {
            post({ action: 'speak', id: 'feedback', rate: 'normal', segments: collect(root, []) });
            setReading(true);
          }
        };
      }
      window.__secureTestSpeech = {
        started: function () { setReading(true); },
        paused: function () {},
        resumed: function () {},
        finished: function () { setReading(false); },
        cancelled: function () { setReading(false); },
        word: function () {}
      };

      // Start VoiceOver and the keyboard at the heading rather than on a
      // button, so the results are read before the way out.
      var heading = document.getElementById('feedback-heading');
      try { if (heading && heading.focus) heading.focus(); } catch (e) {}
    })();
    """#
}
