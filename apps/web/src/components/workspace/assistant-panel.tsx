import {
  ArrowUp02Icon,
  Cancel01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import LoadingState from "@qali/ui/components/ai/loading-state";
import ThinkingTrace, {
  type ThinkingRow,
} from "@qali/ui/components/ai/thinking";
import {
  FollowUps,
  StreamingText,
} from "@qali/ui/components/ai/text-streaming";
import { Bubble, BubbleContent } from "@qali/ui/components/bubble";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@qali/ui/components/input-group";
import { Message, MessageContent } from "@qali/ui/components/message";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import {
  acknowledgedAssistantUserMessageId,
  isNearScrollBottom,
  shouldSendAssistantMessage,
} from "./assistant-interactions";
import { AssistantMarkdown } from "./assistant-markdown";
import {
  AssistantProposalCard,
  type AssistantAction,
} from "./assistant-proposal-card";

type AssistantMessage = Doc<"assistantMessages">;

/** What each tool is doing, in the user's terms. Shown while a call is in
 * flight so the panel explains a pause instead of just sitting there. */
const TOOL_LABELS: Record<string, string> = {
  list_events: "Checking your calendar",
  find_free_time: "Looking for open time",
  search_contacts: "Looking up contacts",
  get_availability_settings: "Reading your booking settings",
  list_pending_booking_requests: "Checking booking requests",
  create_event: "Drafting an event",
  update_event: "Drafting a change",
  move_event: "Drafting a reschedule",
  delete_event: "Drafting a cancellation",
  decide_booking_request: "Drafting a reply",
};

const SUGGESTIONS = [
  "What's on my calendar tomorrow?",
  "Find 30 minutes for a call this week",
  "Move my next meeting an hour later",
];

const SEND_MORPH_TRANSITION = {
  type: "spring",
  visualDuration: 0.38,
  bounce: 0.18,
} as const;

type SendMorphSource = {
  left: number;
  top: number;
  width: number;
  height: number;
  backgroundColor: string;
  color: string;
  borderRadius: number;
};

type PendingSend = {
  key: string;
  text: string;
  previousUserMessageId: Id<"assistantMessages"> | null;
  morphSource: SendMorphSource | null;
  animateEntry: boolean;
};

export function AssistantPanel({
  onClose,
  threadId,
  onThreadChange,
  startFresh,
  onNewChat,
  threads,
  messages,
  actions,
  quota,
}: {
  onClose: () => void;
  threadId: Id<"assistantThreads"> | null;
  onThreadChange: (threadId: Id<"assistantThreads">) => void;
  startFresh: boolean;
  onNewChat: () => void;
  // The dock owns these subscriptions so the conversation stays warm between
  // opens instead of reloading each time the panel mounts.
  threads: FunctionReturnType<typeof api.domains.assistant.data.listThreads> | undefined;
  messages:
    | FunctionReturnType<typeof api.domains.assistant.data.listMessages>
    | undefined;
  actions:
    | FunctionReturnType<typeof api.domains.assistant.data.listPendingActions>
    | undefined;
  quota:
    | FunctionReturnType<typeof api.domains.assistant.data.monthlyQuota>
    | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const sendMessage = useAction(api.domains.assistant.loop.sendMessage);
  const reduceMotion = useReducedMotion();
  const sendGooFilterId = useId().replace(/[:]/g, "");

  const actionsById = new Map((actions ?? []).map((a) => [a._id, a]));

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const restoreFocusAfterSendRef = useRef(false);
  const openingPreviousThreadIdRef = useRef<Id<"assistantThreads"> | null>(
    null,
  );
  const pendingKeyRef = useRef(0);

  // Top/bottom fade over the scroll area — the same dynamic treatment the event
  // and booking panels use, shown only when there is more to scroll that way.
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = () => {
    const list = listRef.current;
    if (!list) return;
    const next = {
      top: list.scrollTop > 0,
      bottom: list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    };
    setScrollFade((current) =>
      current.top === next.top && current.bottom === next.bottom
        ? current
        : next,
    );
  };

  useEffect(() => {
    const latest = threads?.[0];
    if (!threadId && latest && !startFresh) {
      onThreadChange(latest._id);
    } else if (
      !threadId &&
      latest &&
      startFresh &&
      pendingSend &&
      latest._id !== openingPreviousThreadIdRef.current
    ) {
      // A fresh send creates its thread inside the action. Subscribe as soon as
      // that new row becomes the latest one, without mistaking the previous
      // latest conversation for the new turn before startTurn commits.
      onThreadChange(latest._id);
    }
  }, [startFresh, threadId, threads, pendingSend, onThreadChange]);

  // Keep following a stream only until the user deliberately scrolls away.
  useEffect(() => {
    const list = listRef.current;
    if (list && shouldFollowRef.current) list.scrollTop = list.scrollHeight;
    updateScrollFade();
  }, [messages, actions, pendingSend]);

  // Recompute the scroll fade whenever the conversation's own size changes, not
  // just on scroll — a reply streaming in lengthens the content under a still
  // scrollbar.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const syncScroll = () => {
      if (shouldFollowRef.current) list.scrollTop = list.scrollHeight;
      updateScrollFade();
    };
    syncScroll();
    const observer = new ResizeObserver(syncScroll);
    observer.observe(list);
    for (const child of list.children) observer.observe(child);
    return () => observer.disconnect();
  }, [messages, actions, pendingSend]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const turnInProgress = messages?.some(
    (message) => message.status === "streaming",
  );
  const conversationLoading =
    !startFresh &&
    (threads === undefined ||
      (!threadId && (threads?.length ?? 0) > 0) ||
      (Boolean(threadId) && messages === undefined));
  const composerBusy = sending || turnInProgress || conversationLoading;
  // Once the rolling-30-day allowance is spent, sending is blocked client-side
  // (the backend enforces it too). `undefined` means the quota hasn't loaded —
  // treat that as not-yet-blocked so the composer never flickers disabled.
  const limitReached = quota !== undefined && quota.remaining <= 0;
  const wasComposerBusyRef = useRef(composerBusy);

  useEffect(() => {
    if (
      !composerBusy &&
      (restoreFocusAfterSendRef.current || wasComposerBusyRef.current)
    ) {
      restoreFocusAfterSendRef.current = false;
      inputRef.current?.focus();
    }
    wasComposerBusyRef.current = composerBusy;
  }, [composerBusy]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || composerBusy || limitReached) return;
    let previousUserMessageId: Id<"assistantMessages"> | null = null;
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
      const message = messages?.[index];
      if (message?.role === "user") {
        previousUserMessageId = message._id;
        break;
      }
    }
    const nextPending: PendingSend = {
      key: `pending-${pendingKeyRef.current++}`,
      text: trimmed,
      previousUserMessageId,
      morphSource: null,
      animateEntry: !reduceMotion,
    };
    if (!reduceMotion && draft.trim() === trimmed && composerRef.current) {
      const rect = composerRef.current.getBoundingClientRect();
      const fill = composerRef.current.querySelector<HTMLElement>(
        "[data-assistant-composer-fill]",
      );
      const fillStyle = getComputedStyle(fill ?? composerRef.current);
      const inputStyle = inputRef.current
        ? getComputedStyle(inputRef.current)
        : fillStyle;
      nextPending.morphSource = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: fillStyle.backgroundColor,
        color: inputStyle.color,
        borderRadius: Number.parseFloat(fillStyle.borderRadius) || 18,
      };
    }
    shouldFollowRef.current = true;
    setDraft("");
    setPendingSend(nextPending);
    setSending(true);
    restoreFocusAfterSendRef.current = true;
    if (!threadId) {
      openingPreviousThreadIdRef.current = threads?.[0]?._id ?? null;
    }
    try {
      const result = await sendMessage({
        threadId: threadId ?? undefined,
        text: trimmed,
        // The backend must never guess these — every relative date the model
        // resolves depends on them. The browser zone, not the timezone
        // preference: "tomorrow" must mean tomorrow where the user is, on the
        // grid they're looking at (which renders browser-local).
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      onThreadChange(result.threadId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : undefined;
      if (message?.includes("ASSISTANT_MONTHLY_LIMIT")) {
        // A race (a second tab, or the quota refreshing mid-send) can slip past
        // the client-side block. Keep the draft so nothing is lost.
        toast.error("You've reached your 10 messages for this month.");
        setDraft(trimmed);
        setPendingSend(null);
        return;
      }
      toast.error("The assistant couldn't reply", {
        description: message?.includes("ASSISTANT_UNCONFIGURED")
          ? "No DeepSeek API key is configured on this deployment."
          : message,
      });
      setDraft(trimmed);
      setPendingSend(null);
    } finally {
      setSending(false);
      setPendingSend(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (input && !input.disabled) {
          restoreFocusAfterSendRef.current = false;
          input.focus();
        }
      });
    }
  };

  const beginNewChat = () => {
    if (composerBusy || !threadId) return;
    setDraft("");
    shouldFollowRef.current = true;
    openingPreviousThreadIdRef.current = threads?.[0]?._id ?? null;
    onNewChat();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const empty =
    !pendingSend &&
    !threadId &&
    (startFresh || threads?.length === 0);
  const loadingConversation =
    !pendingSend &&
    ((!startFresh && !threadId && threads === undefined) ||
      (!startFresh && !threadId && Boolean(threads?.length)) ||
      (Boolean(threadId) && messages === undefined));

  const acknowledgedPendingId = pendingSend
    ? acknowledgedAssistantUserMessageId(
        messages,
        pendingSend.previousUserMessageId,
        pendingSend.text,
      )
    : null;
  const acknowledgedPendingIndex = acknowledgedPendingId
    ? (messages?.findIndex(
        (message) => message._id === acknowledgedPendingId,
      ) ?? -1)
    : -1;
  const messagesBeforePending =
    pendingSend && acknowledgedPendingIndex >= 0
      ? (messages?.slice(0, acknowledgedPendingIndex) ?? [])
      : (messages ?? []);
  const messagesAfterPending =
    pendingSend && acknowledgedPendingIndex >= 0
      ? (messages?.slice(acknowledgedPendingIndex + 1) ?? [])
      : [];

  return (
    <div className="flex h-full flex-col gap-3">
      <svg aria-hidden className="absolute h-0 w-0">
        <defs>
          <filter
            id={sendGooFilterId}
            x="-35%"
            y="-35%"
            width="170%"
            height="170%"
          >
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation="6"
              result="blur"
            />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>
      {/* Fills the goo dock's fixed-height panel body; the conversation scrolls
        * inside rather than the container growing to fit. */}
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Assistant</p>
          <p className="text-xs text-muted-foreground">
            Asks before it changes anything
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={beginNewChat}
            disabled={composerBusy || !threadId}
            className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-3.5" />
            New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close assistant"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </button>
        </div>
      </div>

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 py-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => send(suggestion)}
              disabled={limitReached}
              className="rounded-2xl border border-border px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <div className="relative -mx-1 flex min-h-0 flex-1 flex-col">
        <motion.div
          layoutScroll
          ref={listRef}
          role="log"
          aria-label="Assistant conversation"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={composerBusy || undefined}
          onScroll={(event) => {
            shouldFollowRef.current = isNearScrollBottom(event.currentTarget);
            updateScrollFade();
          }}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-1 scrollbar-gutter-stable [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]"
        >
          {loadingConversation && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Spinner className="size-3" />
              Loading conversation…
            </p>
          )}
          {messagesBeforePending.map((message, index) => (
            <TurnView
              key={message._id}
              message={message}
              actionsById={actionsById}
              isLast={
                !pendingSend && index === messagesBeforePending.length - 1
              }
              onSend={send}
            />
          ))}

          {/* Receives the composer's measured goo morph. Once the subscription
            * acknowledges the user row, the same keyed view moves into that
            * row's place without duplicating the message. */}
          {pendingSend && (
            <PendingUserMessage
              key={pendingSend.key}
              pending={pendingSend}
              gooFilterId={sendGooFilterId}
            />
          )}
          {pendingSend && !acknowledgedPendingId && (
            <Message key={`${pendingSend.key}-loading`} align="start">
              <MessageContent>
                <LoadingState label="Thinking" />
              </MessageContent>
            </Message>
          )}
          {messagesAfterPending.map((message, index) => (
            <TurnView
              key={message._id}
              message={message}
              actionsById={actionsById}
              isLast={index === messagesAfterPending.length - 1}
              onSend={send}
            />
          ))}
        </motion.div>
          {scrollFade.top && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-linear-to-b from-popover to-transparent"
            />
          )}
          {scrollFade.bottom && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-popover to-transparent"
            />
          )}
        </div>
      )}

      {/* Monthly allowance: nothing while messages remain, a clear blocked
        * notice only once the allowance is spent. */}
      {limitReached && quota !== undefined && (
        <p
          role="status"
          className="px-1 pb-1.5 text-xs font-medium text-destructive"
        >
          You've used all {quota.limit} messages this month.
        </p>
      )}

      {/* The composer reads as one of the dock's own cards: same border and
        * radius as the panels around it, a muted fill that lifts on focus, and
        * a filled circular send that mirrors the nav's primary affordances. */}
      <div
        ref={composerRef}
        className="group/composer relative w-full"
      >
        <span
          aria-hidden
          data-assistant-composer-fill
          className="pointer-events-none absolute inset-0 rounded-2xl bg-muted/40 transition-colors in-data-[palette-settled=false]:transition-none group-has-[[data-slot=input-group-control]:focus-visible]/composer:bg-background"
          style={{
            borderRadius: 18,
          }}
        />
        <InputGroup className="items-end rounded-2xl border-border bg-transparent shadow-xs">
          <InputGroupTextarea
            ref={inputRef}
            value={draft}
            aria-label="Message the assistant"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. This is a one-line composer
              // most of the time, so the reverse would be the wrong default.
              if (
                shouldSendAssistantMessage({
                  key: e.key,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing,
                })
              ) {
                e.preventDefault();
                void send(draft);
              }
            }}
            placeholder={
              limitReached
                ? "You're out of messages for this month"
                : "Ask about your calendar…"
            }
            rows={1}
            disabled={composerBusy || limitReached}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              size="icon-xs"
              variant="default"
              aria-label="Send"
              className="rounded-full"
              disabled={composerBusy || limitReached || draft.trim().length === 0}
              onClick={() => void send(draft)}
            >
              {composerBusy ? (
                <Spinner />
              ) : (
                <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

function PendingUserMessage({
  pending,
  gooFilterId,
}: {
  pending: PendingSend;
  gooFilterId: string;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<SendMorphSource | null>(null);
  const [morphing, setMorphing] = useState(pending.morphSource !== null);

  useLayoutEffect(() => {
    if (!pending.morphSource) return;
    // Let the conversation's follow-to-bottom effect settle first. Until this
    // frame runs, the fixed overlay remains exactly over the old composer.
    const frame = requestAnimationFrame(() => {
      if (!targetRef.current) return;
      const rect = targetRef.current.getBoundingClientRect();
      const content = targetRef.current.querySelector<HTMLElement>(
        '[data-slot="bubble-content"]',
      );
      const style = getComputedStyle(content ?? targetRef.current);
      setTarget({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: Number.parseFloat(style.borderRadius) || 24,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pending.key, pending.morphSource]);

  const source = pending.morphSource;

  return (
    <Message align="end">
      <MessageContent>
        <motion.div
          ref={targetRef}
          initial={
            source || !pending.animateEntry
              ? false
              : { opacity: 0, scale: 0.94, y: 8 }
          }
          animate={{ opacity: morphing ? 0 : 1, scale: 1, y: 0 }}
          transition={source ? { duration: 0 } : SEND_MORPH_TRANSITION}
          className="relative w-fit max-w-[80%] self-end"
        >
          <Bubble
            variant="default"
            align="end"
            className="relative max-w-full"
          >
            <BubbleContent className="whitespace-pre-wrap">
              {pending.text}
            </BubbleContent>
          </Bubble>
        </motion.div>
        {source &&
          morphing &&
          typeof document !== "undefined" &&
          createPortal(
            <motion.div
              aria-hidden
              className="pointer-events-none fixed z-[90] overflow-visible"
              style={{
                left: source.left,
                top: source.top,
                width: source.width,
                height: source.height,
                willChange: "left, top, width, height",
              }}
              animate={
                target
                  ? {
                      left: target.left,
                      top: target.top,
                      width: target.width,
                      height: target.height,
                    }
                  : undefined
              }
              transition={SEND_MORPH_TRANSITION}
              onAnimationComplete={
                target ? () => setMorphing(false) : undefined
              }
            >
              <motion.div
                className="absolute inset-0"
                style={{
                  backgroundColor: source.backgroundColor,
                  borderRadius: source.borderRadius,
                  filter: `url(#${gooFilterId})`,
                }}
                animate={
                  target
                    ? {
                        backgroundColor: target.backgroundColor,
                        borderRadius: target.borderRadius,
                      }
                    : undefined
                }
                transition={SEND_MORPH_TRANSITION}
              />
              <motion.div
                className="relative flex h-full items-center overflow-hidden px-3 py-2.5 text-sm leading-5 whitespace-pre-wrap"
                style={{ color: source.color }}
                animate={target ? { color: target.color } : undefined}
                transition={SEND_MORPH_TRANSITION}
              >
                {pending.text}
              </motion.div>
            </motion.div>,
            document.body,
          )}
      </MessageContent>
    </Message>
  );
}

type Block = AssistantMessage["blocks"][number];

/**
 * One stored turn.
 *
 * A user turn is just their own words. An assistant turn interleaves prose,
 * tool activity and proposals, so it's assembled rather than printed:
 *
 *  - the tool_call/tool_result blocks drive one collapsible {@link ThinkingTrace}
 *    — live while the turn streams, then settled and expandable;
 *  - prose reveals word-by-word while the turn is live, then settles into the
 *    markdown renderer;
 *  - a proposal becomes a confirm card, and raw tool results stay hidden —
 *    they are written for the model, not the user;
 *  - a settled turn may end with suggested follow-ups, when the backend judged
 *    them useful.
 */
function TurnView({
  message,
  actionsById,
  isLast,
  onSend,
}: {
  message: AssistantMessage;
  actionsById: Map<Id<"assistantActions">, AssistantAction>;
  isLast: boolean;
  onSend: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent className="gap-2">
          {message.blocks.map((block, index) =>
            // What the user typed is literal text — rendering it as markdown
            // would reformat their own words back at them.
            block.type === "text" && block.text.trim() ? (
              <Bubble key={index} variant="default" align="end">
                <BubbleContent className="whitespace-pre-wrap">
                  {block.text}
                </BubbleContent>
              </Bubble>
            ) : null,
          )}
        </MessageContent>
      </Message>
    );
  }

  const streaming = message.status === "streaming";

  // A tool call with no result yet is what the panel is waiting on.
  const resultByCall = new Map<string, { isError?: boolean }>();
  for (const block of message.blocks) {
    if (block.type === "tool_result") {
      resultByCall.set(block.toolCallId, { isError: block.isError });
    }
  }
  const toolCalls = message.blocks.filter(
    (block): block is Extract<Block, { type: "tool_call" }> =>
      block.type === "tool_call",
  );

  // The live call, if any: the last one still waiting on its result — its label
  // is what the trace shimmers while the turn works.
  const activeTool = [...toolCalls]
    .reverse()
    .find((tc) => !resultByCall.has(tc.toolCallId));
  const activeLabel = activeTool
    ? (TOOL_LABELS[activeTool.name] ?? "Working")
    : "Working";

  const thinkingRows: ThinkingRow[] = toolCalls.map((tc) => ({
    primary: TOOL_LABELS[tc.name] ?? "Working",
    secondary: tc.name,
    done: resultByCall.has(tc.toolCallId),
    error: resultByCall.get(tc.toolCallId)?.isError,
  }));

  // Only the newest prose gets the streaming reveal; earlier text is settled.
  const lastTextIndex = message.blocks.reduce(
    (last, block, i) =>
      block.type === "text" && block.text.trim() ? i : last,
    -1,
  );

  const suggestions = message.suggestions ?? [];
  const showFollowUps =
    isLast && message.status === "complete" && suggestions.length > 0;

  return (
    <Message align="start">
      <MessageContent className="w-full gap-2">
        {streaming && message.blocks.length === 0 && (
          <LoadingState
            label={activeLabel === "Working" ? "Thinking" : activeLabel}
          />
        )}

        {toolCalls.length > 0 && (
          <ThinkingTrace
            rows={thinkingRows}
            working={streaming}
            activeLabel={activeLabel}
          />
        )}

        {message.blocks.map((block, index) => {
          if (block.type === "text") {
            if (!block.text.trim()) return null;
            // The assistant's reply uses the panel's full width — a scheduling
            // answer is denser than a chat message and shouldn't be boxed into
            // a narrow bubble.
            return (
              <Bubble
                key={index}
                variant="muted"
                align="start"
                className="w-full max-w-full"
              >
                <BubbleContent>
                  {streaming && index === lastTextIndex ? (
                    <StreamingText text={block.text} />
                  ) : (
                    <AssistantMarkdown text={block.text} />
                  )}
                </BubbleContent>
              </Bubble>
            );
          }

          if (block.type === "proposal") {
            const action = actionsById.get(block.actionId);
            return action ? (
              <AssistantProposalCard key={index} action={action} />
            ) : null;
          }

          // tool_call / tool_result are handled by the activity view above.
          return null;
        })}

        {message.status === "error" && (
          <p role="alert" className="text-xs text-destructive">
            {message.error ?? "Something went wrong."}
          </p>
        )}

        {showFollowUps && (
          <FollowUps suggestions={suggestions} onSelect={onSend} />
        )}
      </MessageContent>
    </Message>
  );
}
