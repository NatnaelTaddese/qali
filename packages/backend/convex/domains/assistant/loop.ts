/**
 * The agent loop.
 *
 * Actions only, on purpose: a Convex file that runs in the Node runtime cannot
 * export queries or mutations, so keeping this file free of them means adding
 * `"use node";` later is a one-line change if the bundler ever objects to the
 * `openai` package. Everything reactive lives in `assistantData.ts`.
 *
 * DeepSeek speaks the OpenAI wire format, which means no SDK-supplied tool
 * runner — the request → execute → feed-back cycle below is ours to drive.
 */

import { ConvexError, v } from "convex/values";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import { env } from "@qali/env/server";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { action, type ActionCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  ExternalWriteCommittedError,
  isDefinitiveGoogleFailure,
} from "../calendar/service";
import { getGoogleAccessToken } from "../../lib/googleCredentials";
import {
  ASSISTANT_TOOLS,
  TOOLS_BY_NAME,
  applyProposal,
  type ToolContext,
  type ToolOutcome,
} from "./tools";
import {
  applyToolCallDeltas,
  orderedCalls,
  type PendingCall,
  type StoredTurn,
  toWireMessages,
} from "./history";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Fast tier. `deepseek-v4-pro` is the same API if this proves not smart
 * enough, but a dock assistant is latency-sensitive and these tasks are small. */
const MODEL = "deepseek-v4-flash";
/** The model's ceiling is 384K. A chat panel has no use for it, and a large cap
 * only widens the blast radius of a runaway generation. */
const MAX_TOKENS = 8000;
/** Enough for a look-up-then-propose turn several times over; low enough that a
 * confused loop can't burn the whole action runtime. */
const MAX_STEPS = 12;
/** How often the in-flight reply is written back for the client to render.
 * Patching per delta would hammer the transaction log. */
const FLUSH_INTERVAL_MS = 250;
const MAX_USER_MESSAGE_LENGTH = 4_000;

/**
 * Frozen. Nothing derived from the clock, the user, or the request may appear
 * here: this is the front of the prefix DeepSeek's automatic context cache
 * matches on, so a single varying byte costs a cache miss on every request of
 * every conversation. The current time and zone ride on the user turn instead.
 */
const SYSTEM_PROMPT = `You are the scheduling assistant inside qali, a keyboard-driven Google Calendar client.

You help with one calendar: the signed-in user's own. Be brief and concrete — this is a small panel, not a chat window. Answer in prose, not bullet lists, unless you are genuinely listing more than three things.

The panel renders markdown, so **bold**, bullet lists, \`code\` and links all display properly. Use them where they earn their place — a bulleted list of meetings genuinely reads better than the same thing in a paragraph. Skip headings; the panel is a few inches wide and a reply is never long enough to need sections.

## Time

Every user message opens with a bracketed line giving the server's current instant rendered in the user's IANA zone. That line is your only clock — you have none of your own, and your training cutoff tells you nothing about today's date.

Read the date off that line directly. Do not re-derive it from the epoch value or convert between zones to get it: the local date and the UTC date routinely disagree, and the local one is the one the user means. Resolve "today", "tomorrow", "next Tuesday" and "in an hour" against it.

Send timed instants to tools as epoch milliseconds. For an all-day event, send the literal YYYY-MM-DD calendar dates requested, with Google's exclusive end date; never convert those dates through a timezone. When you state a time back to the user, use their zone and ordinary words ("Thursday at 2pm"), never a raw timestamp and never a UTC offset.

## Looking things up

You cannot see the calendar unless you look. Call list_events before answering any question about what is scheduled, and before changing or cancelling anything — you need an eventId, and you must not guess one. Call find_free_time rather than reasoning about gaps yourself. Call search_contacts before adding a guest the user named but did not spell out; never invent an email address.

## Making changes

The tools that change things — create_event, update_event, move_event, delete_event, decide_booking_request — do not change anything. They put a proposal in front of the user with a confirm button, and nothing reaches Google or any guest's inbox until the user presses it.

So when a proposal tool returns, say what you proposed and that it is waiting for them. Never say an event was created, moved, or cancelled — it wasn't yet. Do not call the same proposal tool twice for one request; if the user asks again, the card is already there. If a proposal tool returns an error, tell the user plainly why the change isn't possible instead of trying a different tool to get around it.

Propose one change per thing the user asked for. If a request is ambiguous in a way that changes what you would propose — which of two meetings they meant, whether "the standup" means this week's or the whole series — ask before proposing rather than guessing.

## Repeating events

Words such as "every", "each", "daily", "weekly", "monthly", and sets of weekdays express repetition. Use the structured repeat field; never write an RRULE yourself. Several named weekdays belong in one weekly series, not separate events.

For a new repeating event with no clock time, propose an all-day event with no repeat end. Its start date is the first matching local date on or after today. For monthly and yearly repetition, the start date anchors the day of the month and month of the year. If the user asks to make an existing one-off event repeat, look it up and use update_event; preserve its current time and duration unless they explicitly change them.

Before deleting a recurring event, establish whether the user means this occurrence, this and following occurrences, or the whole series. Never assume a scope. Guests can remove one occurrence or their whole series copy, but cannot remove this and following because that would change the organizer's recurrence rule.

Examples: "make Tuesday and Wednesday Domino's discount days" is one all-day weekly event whose weekdays are Tuesday and Wednesday. "make every start of the month a pay salary day" is an all-day monthly event starting on the next first day of a month.`;

/** The system prompt plus the tool array, which serialize ahead of the
 * conversation. Built once per module load so the bytes are identical between
 * requests. */
const TOOL_DEFINITIONS = ASSISTANT_TOOLS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

/**
 * The clock, stated the way the model has to reason about it.
 *
 * An ISO instant alone is not enough. In Asia/Shanghai at 04:26 the instant is
 * still the *previous* calendar day in UTC, so a model handed `2026-08-02T20:26Z`
 * concludes today is the 2nd and resolves "tomorrow" to the 3rd — which is
 * actually today. Leading with the local wall clock removes the conversion
 * step; the epoch value follows for the arithmetic the tools need.
 */
function temporalContext(nowMs: number, timeZone: string): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(nowMs));
  return `[Right now, where the user is, it is ${local} (${timeZone}). That instant as Unix epoch milliseconds is ${nowMs}. Today is the date in this line — resolve "today", "tomorrow" and every other relative date against it.]`;
}

function requireApiKey(): string {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) {
    // A typed code rather than prose: the panel is supposed to be hidden when
    // the key is absent, so reaching this means the UI got out of step and
    // should say so precisely.
    throw new ConvexError({ code: "ASSISTANT_UNCONFIGURED" });
  }
  return key;
}

// --- History ---------------------------------------------------------------

/** What became of a proposal, in the words the model should read. */
function outcomeOf(action: Doc<"assistantActions">): string {
  switch (action.status) {
    case "pending":
      return action.resultSummary
        ? `The last attempt did not complete and can be retried: ${action.resultSummary}`
        : "This is still on screen waiting for the user to confirm it.";
    case "applying":
      return "The user confirmed this and it is being carried out now.";
    case "applied":
      return `The user confirmed this. ${action.resultSummary ?? "Done."}`;
    case "rejected":
      return "The user declined this. Do not propose it again unless they ask.";
    case "failed":
      return `The user confirmed this but it failed: ${action.resultSummary ?? "unknown error"}`;
  }
}

// --- The loop --------------------------------------------------------------

/** DeepSeek adds two cache counters to the OpenAI usage object. */
type DeepSeekUsage = {
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/**
 * Send a message and run the agent loop until the model stops calling tools.
 *
 * The reply is not streamed to the browser — a Convex action can't do that.
 * Instead the assistant's row is patched as text arrives, and the panel's
 * subscription re-renders on every patch, which reads the same way.
 */
export const sendMessage = action({
  args: {
    threadId: v.optional(v.id("assistantThreads")),
    text: v.string(),
    /** The browser's IANA zone. The backend must never infer this. */
    timeZone: v.string(),
  },
  handler: async (ctx, args): Promise<{ threadId: Id<"assistantThreads"> }> => {
    const apiKey = requireApiKey();

    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    const text = args.text.trim();
    if (!text) {
      throw new Error("Message is empty");
    }
    if (text.length > MAX_USER_MESSAGE_LENGTH) {
      throw new ConvexError({ code: "ASSISTANT_MESSAGE_TOO_LONG" });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: args.timeZone }).format();
    } catch {
      throw new Error("Invalid time zone");
    }

    const { threadId, userMessageId, assistantMessageId, startedAt } =
      await ctx.runMutation(
        internal.assistantData.startTurn,
        {
          userId: user._id,
          threadId: args.threadId,
          text,
        },
      );

    try {
      const followUp = await runAgentLoop(ctx, {
        apiKey,
        userId: user._id,
        threadId,
        userMessageId,
        assistantMessageId,
        userText: text,
        timeZone: args.timeZone,
        nowMs: startedAt,
      });
      await ctx.runMutation(internal.assistantData.finishTurn, {
        messageId: assistantMessageId,
        threadId,
      });
      // After the composer is unblocked, not before: follow-ups are a nicety, so
      // they must never hold the turn open. Any failure just yields no chips.
      if (followUp) {
        try {
          const suggestions = await generateFollowUps(apiKey, followUp);
          if (suggestions.length > 0) {
            await ctx.runMutation(internal.assistantData.setSuggestions, {
              messageId: assistantMessageId,
              suggestions,
            });
          }
        } catch {
          // best-effort; ignore.
        }
      }
    } catch (error) {
      await ctx.runMutation(internal.assistantData.failTurn, {
        messageId: assistantMessageId,
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return { threadId };
  },
});

/** What a settled turn hands back so its follow-ups can be generated after the
 * composer is unblocked. `null` when follow-ups don't apply — a proposal is
 * awaiting confirmation, or the turn produced no answer to build on. */
type FollowUpContext = { userText: string; assistantText: string };

async function runAgentLoop(
  ctx: ActionCtx,
  run: {
    apiKey: string;
    userId: string;
    threadId: Id<"assistantThreads">;
    userMessageId: Id<"assistantMessages">;
    assistantMessageId: Id<"assistantMessages">;
    userText: string;
    timeZone: string;
    nowMs: number;
  },
): Promise<FollowUpContext | null> {
  const client = new OpenAI({
    apiKey: run.apiKey,
    baseURL: DEEPSEEK_BASE_URL,
  });

  const [history, actions] = await Promise.all([
    ctx.runQuery(internal.assistantData.getHistory, {
      threadId: run.threadId,
      userId: run.userId,
      userMessageId: run.userMessageId,
    }),
    ctx.runQuery(internal.assistantData.getThreadActions, {
      threadId: run.threadId,
      userId: run.userId,
    }),
  ]);
  // What each proposal actually became, so a stored "awaiting confirmation"
  // never outlives the confirmation it was waiting for.
  const resultOverrides = new Map(
    actions.map((action) => [action.toolCallId, outcomeOf(action)]),
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(toWireMessages(
      history as StoredTurn[],
      resultOverrides,
    ) as ChatCompletionMessageParam[]),
  ];
  // `getHistory` returns completed turns only, so the message just stored is
  // already the last entry — stamp it with the temporal context the prompt
  // promises will be there.
  const last = messages[messages.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    last.content = `${temporalContext(run.nowMs, run.timeZone)}\n\n${last.content}`;
  }

  const toolContext: ToolContext = {
    ctx,
    userId: run.userId,
    threadId: run.threadId,
    timeZone: run.timeZone,
    nowMs: run.nowMs,
  };

  // A turn that parks a proposal ends with a confirm card, so its natural next
  // action is confirm/decline — no follow-up prompts for those.
  let proposedThisTurn = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const body = {
      model: MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
      max_tokens: MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
      // DeepSeek's dual-mode models think by default. A scheduling panel is
      // latency-sensitive, so ask for the fast path. Not in the OpenAI schema,
      // hence the cast at the boundary rather than an `any` on the client.
      thinking: { type: "disabled" },
    };
    const stream = await client.chat.completions.create(
      body as unknown as ChatCompletionCreateParamsStreaming,
    );

    let text = "";
    let flushedText = "";
    let lastFlushAt = Date.now();
    const calls = new Map<number, PendingCall>();

    const flush = async (force: boolean) => {
      if (text === flushedText) return;
      if (!force && Date.now() - lastFlushAt < FLUSH_INTERVAL_MS) return;
      flushedText = text;
      lastFlushAt = Date.now();
      await ctx.runMutation(internal.assistantData.flushText, {
        messageId: run.assistantMessageId,
        text,
      });
    };

    // DeepSeek's context cache is automatic, so the usage counters are the only
    // way to tell whether the frozen system prompt and tool array are earning
    // their keep. Captured here and reported once the stream ends — including
    // when it never arrives, so a silent absence doesn't look like a cache miss.
    let usage: DeepSeekUsage | null = null;

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage as DeepSeekUsage;

      // The usage-carrying chunk has no choices.
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        text += choice.delta.content;
        await flush(false);
      }

      applyToolCallDeltas(calls, choice.delta?.tool_calls);
    }

    await flush(true);

    console.log(
      usage
        ? `[assistant] step=${step} cache_hit=${usage.prompt_cache_hit_tokens ?? "n/a"} ` +
            `cache_miss=${usage.prompt_cache_miss_tokens ?? "n/a"} out=${usage.completion_tokens ?? "n/a"}`
        : `[assistant] step=${step} no usage reported by the API`,
    );

    const pending = orderedCalls(calls);

    if (pending.length === 0) {
      // Natural end: the model answered instead of calling another tool. Offer
      // follow-ups only when it actually said something and left no proposal.
      return !proposedThisTurn && text.trim()
        ? { userText: run.userText, assistantText: text }
        : null;
    }

    // Record what the model asked for before running any of it, so a tool that
    // throws still leaves a transcript that explains itself.
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: pending.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args },
      })),
    });
    for (const call of pending) {
      await ctx.runMutation(internal.assistantData.appendBlock, {
        messageId: run.assistantMessageId,
        block: {
          type: "tool_call",
          toolCallId: call.id,
          name: call.name,
          arguments: call.args,
        },
      });
    }

    // Run them concurrently, then write the results back in the model's own
    // order so the transcript and the replayed history always agree.
    const outcomes = await Promise.all(
      pending.map((call) => runOneTool(toolContext, call)),
    );

    for (let i = 0; i < pending.length; i += 1) {
      const call = pending[i];
      const outcome = outcomes[i];
      await ctx.runMutation(internal.assistantData.appendBlock, {
        messageId: run.assistantMessageId,
        block: {
          type: "tool_result",
          toolCallId: call.id,
          content: outcome.content,
          isError: outcome.kind === "result" ? outcome.isError : undefined,
        },
      });
      if (outcome.kind === "proposal") {
        proposedThisTurn = true;
        await ctx.runMutation(internal.assistantData.appendBlock, {
          messageId: run.assistantMessageId,
          block: {
            type: "proposal",
            toolCallId: call.id,
            actionId: outcome.actionId,
          },
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.content,
      });
    }
  }

  // Out of steps with tools still pending. Say so rather than leaving the panel
  // showing a reply that just stops.
  await ctx.runMutation(internal.assistantData.appendBlock, {
    messageId: run.assistantMessageId,
    block: {
      type: "text",
      text: "I got stuck working on that. Could you try asking a smaller piece of it?",
    },
  });
  // A stuck turn is not something to suggest follow-ups from.
  return null;
}

/** The follow-up generator's frozen instruction. Kept lean and strict: the panel
 * only ever wants a short JSON array, and most turns should yield none. */
const FOLLOWUP_SYSTEM = `You suggest what the user of a calendar scheduling assistant might naturally ask next.

Return ONLY a JSON array of strings — nothing else, no prose, no code fences. 0 to 3 items. Each item is a short prompt written as the user would type it (imperative or question), at most 8 words, no trailing punctuation beyond a question mark.

Suggest only genuinely useful next steps that follow from the reply. If nothing useful follows — the reply already closed the thread, or was a simple acknowledgement — return []. Prefer [] over filler. Never restate what was just answered.`;

/** One cheap, non-streaming call for follow-up prompts. Isolated from the turn:
 * its own client, its own try/catch upstream, and it returns [] on anything it
 * can't cleanly parse. */
async function generateFollowUps(
  apiKey: string,
  context: FollowUpContext,
): Promise<string[]> {
  const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
  const body = {
    model: MODEL,
    max_tokens: 200,
    messages: [
      { role: "system", content: FOLLOWUP_SYSTEM },
      {
        role: "user",
        content: `The user asked:\n${context.userText}\n\nThe assistant replied:\n${context.assistantText}\n\nSuggested follow-ups as a JSON array:`,
      },
    ],
    thinking: { type: "disabled" },
  };
  const completion = await client.chat.completions.create(
    body as unknown as ChatCompletionCreateParamsNonStreaming,
  );
  return parseSuggestions(completion.choices[0]?.message?.content ?? "");
}

/** Pull a clean string array out of the model's reply, defending against code
 * fences, stray prose, empties and over-long items. Returns [] on any doubt. */
function parseSuggestions(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 3);
}

/** Dispatch one call. An unknown name or a thrown handler becomes an error
 * result, which the model can read and explain, rather than a dead turn. */
async function runOneTool(
  toolContext: ToolContext,
  call: PendingCall,
): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME.get(call.name);
  if (!tool) {
    return {
      kind: "result",
      content: `No such tool: ${call.name}`,
      isError: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = call.args.trim() ? JSON.parse(call.args) : {};
  } catch {
    return {
      kind: "result",
      content: "Arguments were not valid JSON. Send them again.",
      isError: true,
    };
  }
  try {
    return await tool.run(toolContext, call.id, parsed);
  } catch (error) {
    return {
      kind: "result",
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

// --- Confirming a proposal -------------------------------------------------

/**
 * Carry out — or discard — a change the assistant proposed.
 *
 * Deliberately independent of the model: this needs no API key, so a proposal
 * made while the assistant was configured can still be confirmed after the key
 * is removed. It is also the only path from the assistant to Google.
 */
export const confirmAction = action({
  args: {
    actionId: v.id("assistantActions"),
    decision: v.union(v.literal("confirm"), v.literal("discard")),
  },
  handler: async (ctx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    if (args.decision === "discard") {
      await ctx.runMutation(internal.assistantData.rejectAction, {
        actionId: args.actionId,
        userId: user._id,
      });
      return null;
    }

    // Claiming flips `pending` → `applying` inside one transaction. A second
    // click finds it already claimed and returns null, so the guest list is
    // never emailed twice.
    const action = await ctx.runMutation(internal.assistantData.claimAction, {
      actionId: args.actionId,
      userId: user._id,
    });
    if (!action) {
      return null;
    }

    try {
      const accessToken = proposalNeedsGoogleToken(action)
        ? await getGoogleAccessToken(ctx, user._id)
        : undefined;
      const summary = await applyProposal(ctx, user._id, accessToken, action);
      await ctx.runMutation(internal.assistantData.settleClaimedAction, {
        actionId: args.actionId,
        status: "applied",
        resultSummary: summary,
      });
    } catch (error) {
      if (error instanceof ExternalWriteCommittedError) {
        await ctx.runMutation(internal.assistantData.settleClaimedAction, {
          actionId: args.actionId,
          status: "applied",
          resultSummary: `${error.successSummary} Google accepted it; local sync is catching up.`,
        });
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitiveGoogleFailure(error)) {
        await ctx.runMutation(internal.assistantData.settleClaimedAction, {
          actionId: args.actionId,
          status: "failed",
          resultSummary: message,
        });
        throw error;
      }
      await ctx.runMutation(internal.assistantData.retryClaimedAction, {
        actionId: args.actionId,
        resultSummary: message,
      });
      throw error;
    }
    return null;
  },
});

function proposalNeedsGoogleToken(action: Doc<"assistantActions">): boolean {
  // Booking accept resolves its token inside the booking action; reject is a
  // local mutation. In particular, declining must work after OAuth disconnects.
  return action.tool !== "decide_booking_request";
}
