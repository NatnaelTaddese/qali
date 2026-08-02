/**
 * Streaming fragments are deliberately passed through unchanged. CommonMark
 * already renders incomplete constructs as text; attempting to repair them
 * cannot reliably distinguish a partial token from valid escaped, nested, or
 * variable-length backtick/tilde syntax and has corrupted completed replies.
 */
export function completeMarkdown(text: string): string {
  return text;
}
