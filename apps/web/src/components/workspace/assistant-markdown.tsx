import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { completeMarkdown } from "./streaming-markdown";

/**
 * The assistant's prose, rendered as markdown.
 *
 * Two things this deliberately does not do. It never renders raw HTML —
 * `react-markdown` ignores it unless `rehype-raw` is added, and model output is
 * not trusted enough to add it. And it uses no typography plugin: the panel is
 * a narrow dock card, so every element is sized down by hand rather than
 * inheriting prose defaults built for an article column.
 *
 * `completeMarkdown` runs first because this renders mid-stream, on text that
 * is routinely cut in the middle of a token.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className="min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5 leading-5">{children}</p>,
          // Headings would be oversized here, and a scheduling reply has no
          // real use for document structure — render them as emphasis.
          h1: ({ children }) => (
            <p className="my-1.5 font-semibold leading-5">{children}</p>
          ),
          h2: ({ children }) => (
            <p className="my-1.5 font-semibold leading-5">{children}</p>
          ),
          h3: ({ children }) => (
            <p className="my-1.5 font-semibold leading-5">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          code: ({ children }) => (
            <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded-lg bg-foreground/10 p-2 text-xs [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          // Anything the model links to is outside the app, and the model is
          // not a trusted source of URLs — open detached from this window.
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-border pl-2.5 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-border" />,
          table: ({ children }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-1.5 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-1.5 py-1">{children}</td>
          ),
        }}
      >
        {completeMarkdown(text)}
      </Markdown>
    </div>
  );
});
