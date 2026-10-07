import Foundation

// RT slice 3 (docs/rich-text-essay-design.md): the page's half of a formatted
// essay, and the undo stack every text field shares (D-6).
//
// Spliced into `AssessmentPage.rendererScript` the way `mathPassFunctions` is,
// and kept in its own string so the JSC harness can evaluate it ON ITS OWN and
// call the pure functions directly — the shared html / text table with the
// server's `design-tool/test/rich-text-essay-html.test.ts` runs against this
// exact code.
extension AssessmentPage {
    /// The formatted box, its toolbar, and the shared undo buttons' pressed /
    /// disabled treatment. Tokens and rem only, so the eight contrast sets and
    /// the nine zoom levels reach it (client UI pass slice A / B).
    static let richTextStyles = """
    /* RT slice 3: the formatted essay box. The page turns selection off outside
       fields (PageShell); a contenteditable is not a field to that rule, and
       WebKit will not place a caret where nothing can be selected, so the box
       and everything inside it opt back in. */
    .essay-rich, .essay-rich * { -webkit-user-select: text; user-select: text; }
    .essay-rich {
      position: relative; overflow-y: auto; resize: vertical; line-height: 1.5;
      background: var(--paper); color: var(--ink); cursor: text; white-space: normal;
    }
    .essay-rich:focus-visible, .essay-rich:focus { outline: 3px solid var(--accent); outline-offset: 2px; }
    /* Every Enter is a paragraph (defaultParagraphSeparator p), so paragraphs
       carry no margin — the same keys space the answer as they would in a
       textarea, and as the teacher's renderer shows it (slice 2). */
    .essay-rich p { margin: 0; }
    .essay-rich p[data-indent="first"] { text-indent: 2em; }
    .essay-rich ul, .essay-rich ol { margin: 0; padding-left: 1.75em; }
    .essay-rich ul { list-style: disc; }
    .essay-rich ol { list-style: decimal; }
    .essay-rich[data-empty="true"]::before {
      content: attr(data-placeholder); position: absolute; top: 8px; left: 10px;
      color: var(--ink-soft); pointer-events: none;
    }
    .essay-toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; margin: 0.5rem 0;
    }
    .essay-toolbar button {
      font: inherit; font-size: 0.8125rem; padding: 0.3rem 0.6rem; min-width: 2rem;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: var(--paper); color: var(--ink); cursor: pointer;
    }
    .essay-toolbar button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .essay-toolbar button[aria-pressed="true"] {
      background: var(--accent); color: var(--accent-ink); border-color: var(--accent);
    }
    .essay-toolbar button[aria-disabled="true"] { opacity: .4; cursor: default; }
    .essay-toolbar .essay-tool-bold { font-weight: 700; }
    .essay-toolbar .essay-tool-italic { font-style: italic; }
    .essay-toolbar .essay-tool-underline { text-decoration: underline; }
    .essay-toolbar-gap { width: 0.5rem; }
    """

    /// Pure functions (no page state): the server's sanitiser and text rules,
    /// ported; the DOM reader and builder; the caret's linear position; and
    /// the undo history. Every helper is prefixed `rich` / `undo` so nothing
    /// collides with the renderer it is spliced into.
    static let richTextFunctions = #"""
      // ---- RT slice 3: formatted essays (docs/rich-text-essay-design.md) ----
      //
      // A PORT of design-tool/lib/richText/essayHtml.ts — tokenizer, tree,
      // normalise, tidy, serialise and the D-7 text — so the html the page
      // posts and the text it derives are what the server would make of the
      // same markup, and a restored answer is rebuilt from the same subset.
      // The server re-cleans and re-derives anyway (slice 1); this keeps the
      // page honest for an older server and for the word count the student
      // sees. Change one, change both: the shared table of cases lives in
      // RendererRichTextTests and design-tool/test/rich-text-essay-html.test.ts.

      var RICH_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

      function richDecodeEntities(s) {
        if (s.indexOf('&') === -1) return s;
        return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, function (whole, body) {
          if (body.charAt(0) === '#') {
            var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
            var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
              return '�';
            }
            return String.fromCodePoint(code);
          }
          var key = body.toLowerCase();
          return Object.prototype.hasOwnProperty.call(RICH_NAMED_ENTITIES, key) ? RICH_NAMED_ENTITIES[key] : whole;
        });
      }

      function richParseAttributes(src) {
        var attrs = {};
        var re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        var m;
        while ((m = re.exec(src)) !== null) {
          var name = m[1].toLowerCase();
          if (Object.prototype.hasOwnProperty.call(attrs, name)) continue;
          var raw = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
          attrs[name] = richDecodeEntities(raw);
        }
        return attrs;
      }

      function richTagEnd(html, from) {
        var quote = null;
        for (var k = from; k < html.length; k++) {
          var c = html.charAt(k);
          if (quote) {
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === '>') {
            return k;
          }
        }
        return -1;
      }

      var RICH_RAW_TEXT = {
        script: true, style: true, textarea: true, title: true, xmp: true, iframe: true,
        noembed: true, noframes: true, noscript: true, plaintext: true
      };

      function richTokenize(html) {
        var tokens = [];
        var text = '';
        var k = 0;
        function flush() {
          if (text) tokens.push({ kind: 'text', text: richDecodeEntities(text) });
          text = '';
        }
        while (k < html.length) {
          var lt = html.indexOf('<', k);
          if (lt === -1) { text += html.slice(k); break; }
          text += html.slice(k, lt);
          var next = html.charAt(lt + 1);
          if (html.substr(lt, 4) === '<' + '!--') {
            flush();
            var closeComment = html.indexOf('-->', lt + 4);
            k = closeComment === -1 ? html.length : closeComment + 3;
            continue;
          }
          if (next === '!' || next === '?') {
            flush();
            var closeDecl = html.indexOf('>', lt + 2);
            k = closeDecl === -1 ? html.length : closeDecl + 1;
            continue;
          }
          if (next === '/' && /[a-zA-Z]/.test(html.charAt(lt + 2))) {
            flush();
            var closeEnd = richTagEnd(html, lt + 2);
            var stop = closeEnd === -1 ? html.length : closeEnd;
            var endName = /^[a-zA-Z][^\s\/>]*/.exec(html.slice(lt + 2, stop))[0].toLowerCase();
            tokens.push({ kind: 'end', name: endName });
            k = closeEnd === -1 ? html.length : closeEnd + 1;
            continue;
          }
          if (next !== '' && /[a-zA-Z]/.test(next)) {
            flush();
            var close = richTagEnd(html, lt + 1);
            var inner = html.slice(lt + 1, close === -1 ? html.length : close);
            var name = /^[a-zA-Z][^\s\/>]*/.exec(inner)[0].toLowerCase();
            var rest = inner.slice(name.length);
            var selfClosing = /\/\s*$/.test(rest);
            tokens.push({ kind: 'start', name: name, attrs: richParseAttributes(rest), selfClosing: selfClosing });
            k = close === -1 ? html.length : close + 1;
            if (RICH_RAW_TEXT[name] === true && !selfClosing) {
              var endAt = html.toLowerCase().indexOf('<' + '/' + name, k);
              if (endAt === -1) {
                k = html.length;
                tokens.push({ kind: 'end', name: name });
              } else {
                k = endAt;
              }
            }
            continue;
          }
          text += '<';
          k = lt + 1;
        }
        flush();
        return tokens;
      }

      var RICH_VOID = {
        br: true, hr: true, img: true, input: true, wbr: true, meta: true, link: true, area: true,
        base: true, col: true, embed: true, source: true, track: true, param: true
      };
      var RICH_MAX_DEPTH = 64;

      function richBuildTree(tokens) {
        var root = { kind: 'element', name: '#root', attrs: {}, children: [] };
        var stack = [root];
        tokens.forEach(function (t) {
          var top = stack[stack.length - 1];
          if (t.kind === 'text') {
            top.children.push({ kind: 'text', text: t.text });
          } else if (t.kind === 'start') {
            var el = { kind: 'element', name: t.name, attrs: t.attrs, children: [] };
            if (RICH_VOID[t.name] === true) {
              top.children.push(el);
            } else if (stack.length > RICH_MAX_DEPTH) {
              // unwrapped: children land in `top`
            } else {
              top.children.push(el);
              if (!t.selfClosing) stack.push(el);
            }
          } else {
            for (var d = stack.length - 1; d > 0; d--) {
              if (stack[d].name === t.name) { stack.length = d; break; }
            }
          }
        });
        return root;
      }

      // The live box read as the same tree, so a keystroke never needs the
      // markup re-parsed (and the harness, which has no markup parser, can
      // read it). Only the two attributes the normaliser looks at are carried.
      function richTreeFromDom(node) {
        function kids(of, depth) {
          var out = [];
          var list = of.childNodes || of.children || [];
          for (var i = 0; i < list.length; i++) {
            var n = list[i];
            if (!n) continue;
            if (n.nodeType === 3) {
              var value = (n.nodeValue !== undefined && n.nodeValue !== null) ? n.nodeValue : n.textContent;
              out.push({ kind: 'text', text: String(value === undefined || value === null ? '' : value) });
            } else if (n.nodeType === 1) {
              var name = String(n.localName || n.nodeName || n.tagName || '').toLowerCase();
              var attrs = {};
              if (typeof n.getAttribute === 'function') {
                var indent = n.getAttribute('data-indent');
                if (indent !== null && indent !== undefined) attrs['data-indent'] = String(indent);
                var style = n.getAttribute('style');
                if (style !== null && style !== undefined) attrs.style = String(style);
              }
              var children = kids(n, depth + 1);
              if (depth > RICH_MAX_DEPTH) out = out.concat(children);
              else out.push({ kind: 'element', name: name, attrs: attrs, children: children });
            }
          }
          return out;
        }
        return { kind: 'element', name: '#root', attrs: {}, children: kids(node, 0) };
      }

      var RICH_DROP_WITH_CONTENT = {
        script: true, style: true, textarea: true, title: true, xmp: true, iframe: true,
        noembed: true, noframes: true, noscript: true, plaintext: true,
        object: true, embed: true, template: true, svg: true, math: true, head: true,
        select: true, option: true, video: true, audio: true, canvas: true, img: true,
        input: true, button: true, map: true, picture: true, meta: true, link: true, base: true
      };

      var RICH_BLOCKS = {
        p: true, div: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
        blockquote: true, pre: true, section: true, article: true, header: true, footer: true,
        aside: true, nav: true, main: true, figure: true, figcaption: true, address: true,
        dl: true, dt: true, dd: true, table: true, tr: true, td: true, th: true, caption: true,
        hr: true, body: true, html: true
      };

      function richMarksFromStyle(style, marks) {
        if (!style) return marks;
        var out = { b: marks.b, i: marks.i, u: marks.u };
        var s = String(style).toLowerCase();
        var w = /font-weight\s*:\s*([a-z0-9]+)/.exec(s);
        var weight = w ? w[1] : null;
        if (weight === 'bold' || weight === 'bolder' || (weight && /^\d+$/.test(weight) && Number(weight) >= 600)) {
          out.b = true;
        }
        var f = /font-style\s*:\s*([a-z]+)/.exec(s);
        if (f && (f[1] === 'italic' || f[1] === 'oblique')) out.i = true;
        if (/text-decoration(?:-line)?\s*:[^;]*underline/.test(s)) out.u = true;
        return out;
      }

      var RICH_WS_ONLY = /^[ \t\n\r\f]*$/;

      function richNormalise(root) {
        var blocks = [];
        var para = null;
        var list = null;
        var item = null;

        function endParagraph() { para = null; }
        function openParagraph(indent) {
          para = { kind: 'p', indent: indent, inlines: [] };
          blocks.push(para);
          return para.inlines;
        }
        function sink() {
          if (list) {
            if (!item) { item = []; list.items.push(item); }
            return item;
          }
          return para ? para.inlines : openParagraph(false);
        }
        function emitText(text, marks) {
          var open = list ? item !== null : para !== null;
          if (!open && RICH_WS_ONLY.test(text)) return;
          sink().push({ kind: 'text', text: text, b: marks.b, i: marks.i, u: marks.u });
        }
        function emitBr() { sink().push({ kind: 'br' }); }
        function withMark(marks, key) {
          var m = { b: marks.b, i: marks.i, u: marks.u };
          m[key] = true;
          return m;
        }

        function walk(node, marks) {
          if (node.kind === 'text') { emitText(node.text, marks); return; }
          var name = node.name;
          if (RICH_DROP_WITH_CONTENT[name] === true) return;
          function children(m) {
            for (var c = 0; c < node.children.length; c++) walk(node.children[c], m);
          }
          if (name === 'br') { emitBr(); return; }
          if (name === 'strong' || name === 'b') { children(withMark(marks, 'b')); return; }
          if (name === 'em' || name === 'i') { children(withMark(marks, 'i')); return; }
          if (name === 'u') { children(withMark(marks, 'u')); return; }
          if (name === 'ul' || name === 'ol') {
            if (list) {
              // D-9: one level. A nested list's items join the outer list.
              item = null;
              children(marks);
              item = null;
              return;
            }
            endParagraph();
            list = { kind: 'list', ordered: name === 'ol', items: [] };
            blocks.push(list);
            item = null;
            children(marks);
            list = null;
            item = null;
            return;
          }
          if (name === 'li') {
            if (list) {
              item = [];
              list.items.push(item);
              children(marks);
              item = null;
              return;
            }
            endParagraph();
            openParagraph(false);
            children(marks);
            endParagraph();
            return;
          }
          if (RICH_BLOCKS[name] === true) {
            if (list) {
              if (item && item.length > 0) emitBr();
              children(marks);
              return;
            }
            endParagraph();
            if (name !== 'hr') {
              var indented = (name === 'p' || name === 'div') && node.attrs['data-indent'] === 'first';
              openParagraph(indented);
              children(marks);
            }
            endParagraph();
            return;
          }
          if (name === 'span' || name === 'font') { children(richMarksFromStyle(node.attrs.style, marks)); return; }
          children(marks);
        }

        for (var r = 0; r < root.children.length; r++) walk(root.children[r], { b: false, i: false, u: false });
        return richTidy(blocks);
      }

      function richHasText(inlines) {
        return inlines.some(function (x) {
          return x.kind === 'text' && x.text.replace(/[ \t\n\r\f ]/g, '') !== '';
        });
      }

      function richTidy(blocks) {
        function merge(inlines) {
          var out = [];
          inlines.forEach(function (x) {
            var prev = out[out.length - 1];
            if (x.kind === 'text') {
              if (x.text === '') return;
              if (prev && prev.kind === 'text' && prev.b === x.b && prev.i === x.i && prev.u === x.u) {
                out[out.length - 1] = { kind: 'text', text: prev.text + x.text, b: prev.b, i: prev.i, u: prev.u };
                return;
              }
            }
            out.push(x);
          });
          return out;
        }
        var kept = [];
        blocks.forEach(function (b) {
          if (b.kind === 'list') {
            var items = b.items.map(merge).filter(richHasText);
            if (items.length > 0) kept.push({ kind: 'list', ordered: b.ordered, items: items });
          } else {
            kept.push({ kind: 'p', indent: b.indent, inlines: merge(b.inlines) });
          }
        });
        function blank(b) { return b.kind === 'p' && !richHasText(b.inlines); }
        var start = 0;
        var end = kept.length;
        while (start < end && blank(kept[start])) start++;
        while (end > start && blank(kept[end - 1])) end--;
        return kept.slice(start, end);
      }

      function richEscape(s) {
        return s.replace(/&/g, '&amp;').replace(/[<]/g, '&lt;').replace(/>/g, '&gt;');
      }

      function richSerializeInlines(inlines) {
        var out = '';
        inlines.forEach(function (x) {
          if (x.kind === 'br') { out += '<br>'; return; }
          var s = richEscape(x.text);
          if (x.u) s = '<u>' + s + '<' + '/u>';
          if (x.i) s = '<em>' + s + '<' + '/em>';
          if (x.b) s = '<strong>' + s + '<' + '/strong>';
          out += s;
        });
        return out;
      }

      // Canonical markup: strong > em > u, an empty <p> holding a <br> for an inner blank
      // line, nothing else. "" when nothing readable is left.
      function richSerialize(blocks) {
        return blocks.map(function (b) {
          if (b.kind === 'list') {
            var tag = b.ordered ? 'ol' : 'ul';
            return '<' + tag + '>' + b.items.map(function (it) {
              return '<li>' + richSerializeInlines(it) + '<' + '/li>';
            }).join('') + '<' + '/' + tag + '>';
          }
          var open = b.indent ? '<p data-indent="first">' : '<p>';
          return open + (richHasText(b.inlines) ? richSerializeInlines(b.inlines) : '<br>') + '<' + '/p>';
        }).join('');
      }

      function richInlinesToText(inlines) {
        var trimmed = inlines.length > 0 && inlines[inlines.length - 1].kind === 'br'
          ? inlines.slice(0, -1) : inlines;
        var s = '';
        trimmed.forEach(function (x) {
          s += x.kind === 'br' ? '\n' : x.text.replace(/[ \t\n\r\f]+/g, ' ');
        });
        return s.replace(/ /g, ' ').split('\n').map(function (line) { return line.trim(); }).join('\n');
      }

      // D-7 / D-9: one line per paragraph, "• " / "1. " per list item. With
      // `bare`, list items carry no marker — the student's word counter, so a
      // bullet or "1." is never counted as a word they wrote.
      function richText(blocks, bare) {
        var lines = [];
        blocks.forEach(function (b) {
          if (b.kind === 'p') {
            lines.push(richInlinesToText(b.inlines));
          } else {
            b.items.forEach(function (it, n) {
              var prefix = bare ? '' : (b.ordered ? (n + 1) + '. ' : '• ');
              lines.push(prefix + richInlinesToText(it));
            });
          }
        });
        return lines.join('\n').replace(/^\n+|\n+$/g, '');
      }

      function richBlocksFromHtml(html) {
        return richNormalise(richBuildTree(richTokenize(String(html === undefined || html === null ? '' : html))));
      }
      function richBlocksFromDom(node) { return richNormalise(richTreeFromDom(node)); }
      function richSanitize(html) { return richSerialize(richBlocksFromHtml(html)); }
      function richTextFromHtml(html) { return richText(richBlocksFromHtml(html)); }

      // A plain essay saved before the teacher turned formatting on (or by a
      // client older than v1.6.0): each line becomes a paragraph, a blank line
      // a blank paragraph — the reverse of the text rule.
      function richBlocksFromText(text) {
        var lines = String(text === undefined || text === null ? '' : text).split(/\r\n|\r|\n/);
        return richTidy(lines.map(function (line) {
          return {
            kind: 'p', indent: false,
            inlines: line ? [{ kind: 'text', text: line, b: false, i: false, u: false }] : []
          };
        }));
      }

      // Replaces `into`'s content with `blocks`, built as DOM (never parsed
      // markup): text nodes inside strong / em / u, `<p>` with the one
      // attribute, `<br>` placeholders. An empty answer is one empty
      // paragraph, so the caret always has a paragraph to type into.
      function richBuildDom(blocks, into) {
        while (into.firstChild) into.removeChild(into.firstChild);
        function inlinesInto(inlines, el) {
          inlines.forEach(function (x) {
            if (x.kind === 'br') { el.appendChild(document.createElement('br')); return; }
            var node = document.createTextNode(x.text);
            if (x.u) { var u = document.createElement('u'); u.appendChild(node); node = u; }
            if (x.i) { var em = document.createElement('em'); em.appendChild(node); node = em; }
            if (x.b) { var strong = document.createElement('strong'); strong.appendChild(node); node = strong; }
            el.appendChild(node);
          });
        }
        var list = blocks.length ? blocks : [{ kind: 'p', indent: false, inlines: [] }];
        list.forEach(function (b) {
          if (b.kind === 'list') {
            var l = document.createElement(b.ordered ? 'ol' : 'ul');
            b.items.forEach(function (it) {
              var li = document.createElement('li');
              inlinesInto(it, li);
              l.appendChild(li);
            });
            into.appendChild(l);
            return;
          }
          var p = document.createElement('p');
          if (b.indent) p.setAttribute('data-indent', 'first');
          if (richHasText(b.inlines)) inlinesInto(b.inlines, p);
          else p.appendChild(document.createElement('br'));
          into.appendChild(p);
        });
      }

      // ---- the caret as one number ----
      // Undo puts the caret back, and a rebuilt box (undo, restore, the
      // one-level list repair) has new nodes, so a position is kept as a
      // character count: text characters, 1 per <br>, 1 per paragraph / item
      // boundary. Whitespace-only text straight inside the box or a list is
      // pretty-printing and counts as nothing, which is what the rebuild drops.
      var RICH_LINE_TAGS = { p: true, div: true, li: true };

      function richNodeName(n) { return String((n && (n.localName || n.nodeName || n.tagName)) || '').toLowerCase(); }

      function richWalk(box, onBoundary, onText) {
        var pos = 0;
        var seenLine = false;
        var done = false;
        function ignorable(k, parent) {
          var pn = richNodeName(parent);
          if (parent !== box && pn !== 'ul' && pn !== 'ol') return false;
          var v = (k.nodeValue !== undefined && k.nodeValue !== null) ? k.nodeValue : k.textContent;
          return RICH_WS_ONLY.test(String(v || ''));
        }
        function walk(node) {
          var kids = node.childNodes || node.children || [];
          for (var i = 0; i < kids.length; i++) {
            if (onBoundary(node, i, pos)) { done = true; return; }
            var k = kids[i];
            if (k.nodeType === 3) {
              if (ignorable(k, node)) continue;
              var v = (k.nodeValue !== undefined && k.nodeValue !== null) ? k.nodeValue : k.textContent;
              var len = String(v || '').length;
              if (onText(k, pos, len)) { done = true; return; }
              pos += len;
            } else if (k.nodeType === 1) {
              var name = richNodeName(k);
              if (name === 'br') { pos += 1; continue; }
              if (RICH_LINE_TAGS[name] === true) {
                if (seenLine) pos += 1;
                seenLine = true;
              }
              walk(k);
              if (done) return;
            }
          }
          if (onBoundary(node, kids.length, pos)) done = true;
        }
        walk(box);
        return pos;
      }

      // (container, offset) — a DOM boundary point — as a position, or null
      // when the point is not inside `box`.
      function richPositionOf(box, container, offset) {
        var found = null;
        richWalk(box, function (node, index, pos) {
          if (node === container && index === offset) { found = pos; return true; }
          return false;
        }, function (node, pos, len) {
          if (node === container) { found = pos + Math.min(offset, len); return true; }
          return false;
        });
        return found;
      }

      // The boundary point for a position: inside the first text node that
      // holds it, else the last boundary at or before it (an empty
      // paragraph's start).
      function richPointAt(box, target) {
        var hit = null;
        var best = { node: box, offset: 0 };
        richWalk(box, function (node, index, pos) {
          if (pos <= target) best = { node: node, offset: index };
          return pos > target;
        }, function (node, pos, len) {
          if (pos <= target && target <= pos + len) { hit = { node: node, offset: target - pos }; return true; }
          return false;
        });
        return hit || best;
      }

      // ---- the undo history (D-6) ----
      // One per field. `capture()` returns `{ key, sel }` — the value (plain)
      // or the canonical html (formatted) and the caret — and `apply(state)`
      // puts a state back. Keystrokes COALESCE into one step: a new step opens
      // after a pause of UNDO_COALESCE_MS or a word boundary (`record(true)`
      // closes the step it records), and a formatting command or a keypad key
      // is a step of its own. Capped at UNDO_DEPTH; the oldest falls off.
      var UNDO_COALESCE_MS = 1000;
      var UNDO_DEPTH = 200;

      function undoNow() { return Date.now(); }

      function undoHistory(capture, apply) {
        var stack = [capture()];
        var index = 0;
        var open = false;
        var lastAt = 0;
        var applying = false;
        var history = {
          record: function (closeAfter) {
            if (applying) return;
            var state = capture();
            var t = undoNow();
            if (state.key === stack[index].key) {
              stack[index].sel = state.sel;
              if (closeAfter) open = false;
              return;
            }
            if (open && t - lastAt <= UNDO_COALESCE_MS) {
              stack[index] = state;
            } else {
              stack.length = index + 1;
              stack.push(state);
              index += 1;
              if (stack.length > UNDO_DEPTH) { stack.shift(); index -= 1; }
            }
            open = !closeAfter;
            lastAt = t;
          },
          close: function () { open = false; },
          step: function (delta) {
            // Anything typed since the last record is a step of its own first.
            history.record(true);
            var target = index + delta;
            if (target < 0 || target >= stack.length) return false;
            index = target;
            open = false;
            applying = true;
            try { apply(stack[index]); } finally { applying = false; }
            return true;
          },
          undo: function () { return history.step(-1); },
          redo: function () { return history.step(1); },
          canUndo: function () { return index > 0; },
          canRedo: function () { return index < stack.length - 1; },
          isApplying: function () { return applying; },
          depth: function () { return stack.length; }
        };
        return history;
      }

      // A typed character that ends a word closes the step it is part of, so
      // Cmd-Z takes back a word at a time rather than a whole paragraph.
      function undoBoundary(event) {
        if (!event) return false;
        if (typeof event.data === 'string' && /[\s.,;:!?]/.test(event.data)) return true;
        var type = typeof event.inputType === 'string' ? event.inputType : '';
        return type === 'insertParagraph' || type === 'insertLineBreak' || type.indexOf('insertFrom') === 0;
      }

      // Cmd-Z / Shift-Cmd-Z: 'undo', 'redo' or null. Control and Option are
      // not undo on a Mac.
      function undoChord(event) {
        if (!event || !event.metaKey || event.ctrlKey || event.altKey) return null;
        var key = String(event.key || '').toLowerCase();
        if (key !== 'z' && event.code !== 'KeyZ') return null;
        return event.shiftKey ? 'redo' : 'undo';
      }

      // Paste and drop are plain text only ("Paste is cleaned"): the lines of
      // text/plain, never text/html, so no foreign formatting can arrive.
      function richPlainLines(data) {
        var text = '';
        try {
          if (data && typeof data.getData === 'function') text = data.getData('text/plain') || '';
        } catch (e) {
          text = '';
        }
        return String(text).split(/\r\n|\r|\n/);
      }
    """#
}
