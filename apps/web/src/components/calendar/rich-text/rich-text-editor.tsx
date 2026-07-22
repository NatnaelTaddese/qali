import {
  Link02Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import { Input } from "@qali/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";

import { isEmptyDescriptionHtml } from "./sanitize";
import { toEditorHtml } from "./text";

/** Constrain TipTap to Google Calendar's description subset: bold, italic,
 * underline, links, and bullet/numbered lists. Everything StarterKit bundles
 * beyond that (headings, blockquotes, code, strike, rules) is turned off so the
 * authored HTML can only ever be what the sanitizer and Google both accept. */
function extensions(placeholder?: string) {
  return [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      codeBlock: false,
      code: false,
      strike: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noreferrer nofollow noopener", target: "_blank" },
      },
    }),
    Placeholder.configure({ placeholder: placeholder ?? "" }),
  ];
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
}: {
  /** HTML in. */
  value: string;
  /** HTML out — already collapsed to "" when the document is empty. */
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const editor = useEditor({
    extensions: extensions(placeholder),
    content: toEditorHtml(value),
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        // The prose styles mirror rich-text-view so authoring and reading match.
        class: cn(
          "min-h-24 outline-none text-base text-foreground",
          "[&_p]:my-0 [&_p+p]:mt-1",
          "[&_a]:font-medium [&_a]:text-link [&_a]:underline [&_a]:decoration-link/40 [&_a]:underline-offset-2",
          "[&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-4",
          "[&_ol]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4",
          "[&_li]:my-0.5",
        ),
        "aria-label": "Description",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange(isEmptyDescriptionHtml(html) ? "" : html);
    },
  });

  // Keep the editor in sync when the value is replaced from outside (e.g. loading
  // an existing event into the edit form). Compare against the normalized form so
  // ordinary typing — which already emits block-per-line HTML — isn't clobbered
  // mid-keystroke; only a genuinely different external value resets the content.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const incoming = toEditorHtml(value || "");
    const normalizedCurrent = isEmptyDescriptionHtml(current) ? "" : current;
    if (incoming !== normalizedCurrent) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {editor && (
        <div className="flex flex-col gap-2">
          <Toolbar editor={editor} />
          <EditorContent
            editor={editor}
            className="min-h-0 flex-1 overflow-y-auto [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
          />
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border pb-2">
      <ToolbarButton
        icon={TextBoldIcon}
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        icon={TextItalicIcon}
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        icon={TextUnderlineIcon}
        label="Underline"
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <div className="mx-1 h-5 w-px bg-border" />
      <LinkButton editor={editor} />
      <div className="mx-1 h-5 w-px bg-border" />
      <ToolbarButton
        icon={LeftToRightListBulletIcon}
        label="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        icon={LeftToRightListNumberIcon}
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
    </div>
  );
}

/** Normalize a user-typed URL: bare hosts get https://, mailto/http(s) are kept.
 * The link extension re-validates on apply, so this is only for convenience. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** The link control: an inline popover (not window.prompt) anchored to the
 * toolbar button. Opening seeds the field with the link under the cursor; an
 * empty value removes the link. With no selection, the URL is inserted as its
 * own linked text. */
function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const active = editor.isActive("link");

  const onOpenChange = (next: boolean) => {
    if (next) {
      setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    }
    setOpen(next);
  };

  const apply = () => {
    const href = normalizeUrl(url);
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setOpen(false);
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to && !active) {
      // No selection: drop the URL in as its own linked text.
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text: href,
          marks: [{ type: "link", attrs: { href } }],
        })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Link"
            aria-pressed={active}
            // Keep the editor selection intact while the popover opens.
            onMouseDown={(e) => e.preventDefault()}
            className={cn(
              "flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={Link02Icon} strokeWidth={2} className="size-4.5" />
          </button>
        }
      />
      <PopoverContent side="top" align="start" className="w-64 rounded-lg p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
          className="flex items-center gap-1.5"
        >
          <Input
            autoFocus
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            aria-label="Link URL"
            className="h-8 flex-1 rounded-md"
          />
          <Button type="submit" size="sm" className="shrink-0 rounded-md">
            {active && !url.trim() ? "Remove" : "Apply"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ToolbarButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // Keep focus in the document so the command applies to the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4.5" />
    </button>
  );
}
