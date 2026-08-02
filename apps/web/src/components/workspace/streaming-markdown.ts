/**
 * Making half-arrived markdown safe to render.
 *
 * The assistant's reply is patched into the panel as it streams, so every
 * intermediate state gets parsed — including the ones cut mid-token. Markdown
 * degrades badly there: an unclosed ``` fence swallows the entire rest of the
 * message into a code block, and `**bol` shows its asterisks until the closer
 * lands. Both look like bugs rather than like typing.
 *
 * So the last incomplete construct is closed off before parsing. The repair is
 * deliberately narrow — only the markers whose absence is disruptive, and only
 * at the very end of the text. Guessing at more (single `*`, `_` inside
 * snake_case identifiers, half-typed link targets) mangles ordinary prose more
 * often than it helps, and the artifact it would fix lasts one frame.
 */

/** Where the scanner is when it reaches the end of the text so far. */
interface ScanState {
  inFence: boolean;
  inInlineCode: boolean;
  openBold: boolean;
  openStrike: boolean;
}

function scan(text: string): ScanState {
  const state: ScanState = {
    inFence: false,
    inInlineCode: false,
    openBold: false,
    openStrike: false,
  };

  let i = 0;
  while (i < text.length) {
    // A fence toggles everything: inside one, no inline marker means anything.
    if (text.startsWith("```", i)) {
      state.inFence = !state.inFence;
      // Inline state cannot survive a fence boundary.
      state.inInlineCode = false;
      state.openBold = false;
      state.openStrike = false;
      i += 3;
      continue;
    }
    if (state.inFence) {
      i += 1;
      continue;
    }

    if (text[i] === "`") {
      state.inInlineCode = !state.inInlineCode;
      i += 1;
      continue;
    }
    if (state.inInlineCode) {
      i += 1;
      continue;
    }

    if (text.startsWith("**", i)) {
      state.openBold = !state.openBold;
      i += 2;
      continue;
    }
    if (text.startsWith("~~", i)) {
      state.openStrike = !state.openStrike;
      i += 2;
      continue;
    }

    i += 1;
  }

  return state;
}

/**
 * Close whatever the stream left hanging.
 *
 * Order matters: the innermost construct closes first, so a bold run inside an
 * unterminated fence is left alone (the fence closes and the asterisks stay
 * literal, which is what they are inside code).
 */
export function completeMarkdown(text: string): string {
  if (!text) return text;
  const state = scan(text);

  let out = text;
  if (state.openStrike) out += "~~";
  if (state.openBold) out += "**";
  if (state.inInlineCode) out += "`";
  if (state.inFence) {
    // The fence needs its own line, and the text may not end with one.
    out += out.endsWith("\n") ? "```" : "\n```";
  }
  return out;
}
