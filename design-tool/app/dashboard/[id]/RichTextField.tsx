"use client";

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { parse } from "@secure-test/markup";
import { useAssessmentId } from "@/components/app/AssessmentIdContext";
import { docToMarkup, markupToDoc, MARKUP_MARK, MARKUP_NODE } from "@/lib/authoring/markupDoc";
import { insertBlankTr, selectedBlankKey } from "@/lib/authoring/blankInsert";
import { markupExtensions, renderTex } from "@/lib/authoring/markupExtensions";
import {
  cleanForeignSlice,
  joinLines,
  plainTextToContent,
  rememberCopied,
  runsToHtml,
  sanitizePastedHtml,
} from "@/lib/authoring/pasteSanitize";
import { ImagePicker } from "./ImagePicker";
import { MathPreview } from "./MathPreview";
import { MathTranslator } from "./MathTranslator";

interface Props {
  /** The stored markup string (R-1). */
  value: string;
  onChange: (markup: string) => void;
  /** The field's accessible name, e.g. "Question" or "Choice A text". */
  label: string;
  disabled?: boolean;
  /** A choice: Enter inserts nothing and pasted lines join with spaces. */
  singleLine?: boolean;
  /** For tests / hand-checks that need to find the field. */
  id?: string;
  /** R-6 (UX3-1): shown while the field is empty; never saved. */
  placeholder?: string;
  /**
   * Fill-in-the-blank stems only (Phase 4 slice C): the item's blank ids, so
   * their `[[id]]` markers load as blank chips, and "Insert blank". `onInsert`
   * records the new blank (with `key`, the selected text, as its first
   * accepted answer) and returns its id; the field then puts the chip in.
   */
  blanks?: { ids: readonly string[]; canInsert: boolean; limitTitle?: string; onInsert: (key: string) => string };
}

const btn = "rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40 aria-pressed:bg-accent";

/**
 * R-4 (docs/editor-redesign-design.md, Phase 3 slice B), behind the R-12 flag:
 * a WYSIWYG field that never shows formatting markers. It loads the stored
 * markup into a ProseMirror document (lib/authoring/markupDoc.ts) and hands
 * back the markup string on every edit, so the item's `stem` / choice `text`
 * — and everything downstream — is unchanged in shape.
 *
 * Text it cannot hold exactly opens read-only with "Show source" (Risks:
 * round-trip loss); opening an item never rewrites it.
 */
export function RichTextField({ value, onChange, label, disabled = false, singleLine = false, id, placeholder, blanks }: Props) {
  const assessmentId = useAssessmentId();
  const lastEmitted = useRef(value);
  const pastedSliceHtml = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The blank ids as a parse option ({} for every other field). A ref, so the
  // editor's callbacks always read the item's current list.
  const blankOpts = useRef<{ blanks?: string[] }>({});
  blankOpts.current = blanks ? { blanks: [...blanks.ids] } : {};
  const [loaded, setLoaded] = useState(() => markupToDoc(value, blankOpts.current));
  const [exact, setExact] = useState(true);
  const [droppedImages, setDroppedImages] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [mathEdit, setMathEdit] = useState<{ pos: number; tex: string; display: boolean } | null>(null);

  const editor = useEditor({
    extensions: markupExtensions({
      assetUrl: (assetId) =>
        assessmentId
          ? `/api/assessments/${encodeURIComponent(assessmentId)}/assets/${encodeURIComponent(assetId)}`
          : `/api/assets/${encodeURIComponent(assetId)}`,
      singleLine,
    }),
    content: loaded.doc,
    editable: !disabled && loaded.representable,
    // Next renders client components on the server first; the editor mounts after hydration.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        "aria-label": label,
        role: "textbox",
        "aria-multiline": String(!singleLine),
        ...(placeholder ? { "aria-placeholder": placeholder } : {}),
        class:
          "min-h-[2.25rem] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      },
      // Clean paste (Word / Google Docs): only text, bold, italic, breaks.
      // HTML with ProseMirror's own slice marker is parsed through the
      // schema, then kept only if it is this tab's own copy out of a field
      // (transformPasted; lib/authoring/pasteSanitize.ts says why).
      transformCopied: (slice) => rememberCopied(slice),
      transformPastedHTML(html) {
        pastedSliceHtml.current = null;
        if (html.includes("data-pm-slice")) {
          pastedSliceHtml.current = html;
          return html;
        }
        const out = sanitizePastedHtml(html);
        setDroppedImages(out.droppedImages);
        return runsToHtml(singleLine ? joinLines(out.runs) : out.runs);
      },
      transformPasted(slice, view) {
        const html = pastedSliceHtml.current;
        pastedSliceHtml.current = null;
        if (html === null) return slice;
        const cleaned = cleanForeignSlice(slice, html, view.state.schema, singleLine);
        if (cleaned === null) return slice;
        setDroppedImages(cleaned.droppedImages);
        return cleaned.slice;
      },
      clipboardTextParser(text, _context, _plain, view) {
        return new Slice(Fragment.fromJSON(view.state.schema, plainTextToContent(text, singleLine)), 0, 0);
      },
    },
    onUpdate({ editor: ed }) {
      const saved = docToMarkup(ed.getJSON(), blankOpts.current);
      setExact(saved.exact);
      if (saved.markup !== lastEmitted.current) {
        lastEmitted.current = saved.markup;
        onChangeRef.current(saved.markup);
      }
    },
    onSelectionUpdate({ editor: ed }) {
      const sel = ed.state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === MARKUP_NODE.math) {
        setMathEdit({ pos: sel.from, tex: String(sel.node.attrs.tex), display: sel.node.attrs.display === true });
      } else {
        setMathEdit(null);
      }
    },
  });

  const marks = useEditorState({
    editor,
    selector: (ctx) => ({
      strong: ctx.editor?.isActive(MARKUP_MARK.strong) ?? false,
      em: ctx.editor?.isActive(MARKUP_MARK.em) ?? false,
    }),
  });

  // The value changed outside the field (save response, AI rewrite, undo of a
  // card): reload. Our own edits come back equal to lastEmitted and are skipped.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const next = markupToDoc(value, blankOpts.current);
    setLoaded(next);
    setExact(true);
    if (editor && !editor.isDestroyed) editor.commands.setContent(next.doc, { emitUpdate: false });
  }, [value, editor]);

  const editable = !disabled && loaded.representable;
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable, false);
  }, [editor, editable]);

  function insertMath(wrapped: string, mode: "inline" | "display") {
    const tex = mode === "display" ? wrapped.slice(2, -2) : wrapped.slice(1, -1);
    if (!editor || !tex.trim()) return;
    editor.chain().focus().insertContent({ type: MARKUP_NODE.math, attrs: { tex, display: mode === "display" } }).run();
  }

  function insertImage(md: string) {
    const node = parse(md)[0];
    if (!editor || node?.type !== "image") return;
    editor
      .chain()
      .focus()
      .insertContent({ type: MARKUP_NODE.image, attrs: { alt: node.alt, id: node.id, scheme: node.scheme ?? null } })
      .run();
  }

  function insertBlank() {
    if (!editor || !blanks?.canInsert) return;
    // Not focused: at the end of the sentence, as the current editor does.
    if (!editor.isFocused) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    }
    const id = blanks.onInsert(selectedBlankKey(editor.state));
    editor.view.dispatch(insertBlankTr(editor.state, id));
    editor.commands.focus();
  }

  function saveMath() {
    if (!editor || !mathEdit) return;
    const { pos, tex, display } = mathEdit;
    if (!tex.trim()) {
      editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
    } else {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { tex, display });
          return true;
        })
        .run();
    }
    setMathEdit(null);
  }

  return (
    <div className="rt-field mt-1">
      <div className="relative">
        <EditorContent editor={editor} />
        {placeholder && value === "" ? (
          <span aria-hidden className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
            {placeholder}
          </span>
        ) : null}
      </div>

      {!loaded.representable ? (
        <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p>
            {loaded.reason === "blank_in_math_or_alt"
              ? "A blank sits inside a formula or a picture's description here. "
              : "This text uses formatting the new editor can't show exactly. "}
            It is shown read-only so it isn&rsquo;t changed. To edit it, switch back to the current editor.
          </p>
          <button type="button" className={`${btn} mt-1`} onClick={() => setShowSource((v) => !v)}>
            {showSource ? "Hide source" : "Show source"}
          </button>
          {showSource ? (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs text-foreground">
              {value}
            </pre>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className="mt-1 flex flex-wrap items-start gap-1">
          <button
            type="button"
            className={btn}
            aria-pressed={marks?.strong ?? false}
            title="Bold (⌘B)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleMark(MARKUP_MARK.strong).run()}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={btn}
            aria-pressed={marks?.em ?? false}
            title="Italic (⌘I)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor?.chain().focus().toggleMark(MARKUP_MARK.em).run()}
          >
            <em>I</em>
          </button>
          <ImagePicker onInsert={insertImage} />
          <MathTranslator onInsert={insertMath} />
          {blanks ? (
            <button
              type="button"
              className={btn}
              disabled={!blanks.canInsert}
              title={blanks.canInsert ? "Add a blank at the cursor" : blanks.limitTitle}
              onMouseDown={(e) => e.preventDefault()}
              onClick={insertBlank}
            >
              Insert blank
            </button>
          ) : null}
        </div>
      ) : null}

      {editable && mathEdit ? (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-muted p-3 text-xs">
          <label className="block">
            Formula (LaTeX)
            <textarea
              value={mathEdit.tex}
              onChange={(e) => setMathEdit({ ...mathEdit, tex: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={mathEdit.display}
              onChange={(e) => setMathEdit({ ...mathEdit, display: e.target.checked })}
            />
            On its own line
          </label>
          {mathEdit.tex.trim() ? (
            // renderTex is KaTeX with trust off: escaped output, no injection.
            <div
              className="rounded bg-background px-2 py-1"
              dangerouslySetInnerHTML={{ __html: renderTex(mathEdit.tex, mathEdit.display) }}
            />
          ) : null}
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={saveMath}>
              {mathEdit.tex.trim() ? "Done" : "Remove formula"}
            </button>
            <button type="button" className={btn} onClick={() => setMathEdit(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {droppedImages > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {droppedImages === 1 ? "A picture" : `${droppedImages} pictures`} in the pasted text {droppedImages === 1 ? "was" : "were"} left
          out. Add pictures with Image….
        </p>
      ) : null}

      {!exact ? (
        <div className="mt-1">
          <p className="text-xs text-amber-800">
            Some characters here (such as ** or _ around a word) are formatting marks in the saved text, so students
            will see this differently. The preview shows what they will see.
          </p>
          <MathPreview text={value} />
        </div>
      ) : null}
    </div>
  );
}
