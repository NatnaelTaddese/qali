import { ArrowUp02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import { Bubble, BubbleContent } from "@qali/ui/components/bubble";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@qali/ui/components/input-group";
import { Message, MessageContent } from "@qali/ui/components/message";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
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

export function AssistantPanel({
  onClose,
  threadId,
  onThreadChange,
}: {
  onClose: () => void;
  threadId: Id<"assistantThreads"> | null;
  onThreadChange: (threadId: Id<"assistantThreads">) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [openingText, setOpeningText] = useState<string | null>(null);
  const sendMessage = useAction(api.assistant.sendMessage);

  // sendMessage currently returns only after the model loop, but startTurn has
  // already committed by then. The list subscription discovers that row so the
  // first reply is subscribable and a failed action cannot strand its thread.
  const threads = useQuery(api.assistantData.listThreads);
  const messages = useQuery(
    api.assistantData.listMessages,
    threadId ? { threadId } : "skip",
  );
  const actions = useQuery(
    api.assistantData.listPendingActions,
    threadId ? { threadId } : "skip",
  );
  const actionsById = new Map((actions ?? []).map((a) => [a._id, a]));

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shouldFollowRef = useRef(true);
  const restoreFocusAfterSendRef = useRef(false);

  useEffect(() => {
    if (!threadId && threads?.[0]) onThreadChange(threads[0]._id);
  }, [threadId, threads, onThreadChange]);

  // Keep following a stream only until the user deliberately scrolls away.
  useEffect(() => {
    const list = listRef.current;
    if (list && shouldFollowRef.current) list.scrollTop = list.scrollHeight;
  }, [messages, actions, openingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const turnInProgress = messages?.some(
    (message) => message.status === "streaming",
  );
  const conversationLoading =
    threads === undefined || (!threadId && (threads?.length ?? 0) > 0);
  const composerBusy = sending || turnInProgress || conversationLoading;
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
    if (!trimmed || composerBusy) return;
    shouldFollowRef.current = true;
    setDraft("");
    setSending(true);
    restoreFocusAfterSendRef.current = true;
    if (!threadId) setOpeningText(trimmed);
    try {
      const result = await sendMessage({
        threadId: threadId ?? undefined,
        text: trimmed,
        // The backend must never guess these — every relative date the model
        // resolves depends on them.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      onThreadChange(result.threadId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : undefined;
      toast.error("The assistant couldn't reply", {
        description: message?.includes("ASSISTANT_UNCONFIGURED")
          ? "No DeepSeek API key is configured on this deployment."
          : message,
      });
      setDraft(trimmed);
    } finally {
      setSending(false);
      setOpeningText(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (input && !input.disabled) {
          restoreFocusAfterSendRef.current = false;
          input.focus();
        }
      });
    }
  };

  const empty = !openingText && !threadId && threads?.length === 0;
  const loadingConversation =
    !openingText &&
    ((!threadId && threads === undefined) ||
      (!threadId && Boolean(threads?.length)) ||
      (Boolean(threadId) && messages === undefined));

  return (
    <div className="flex max-h-[26rem] flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Assistant</p>
          <p className="text-xs text-muted-foreground">
            Asks before it changes anything
          </p>
        </div>
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

      {empty ? (
        <div className="flex flex-col gap-1.5 py-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => send(suggestion)}
              className="rounded-2xl border border-border px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <div
          ref={listRef}
          role="log"
          aria-label="Assistant conversation"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={composerBusy || undefined}
          onScroll={(event) => {
            shouldFollowRef.current = isNearScrollBottom(event.currentTarget);
          }}
          className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 scrollbar-gutter-stable"
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
          {messages?.map((message) => (
            <TurnView
              key={message._id}
              message={message}
              actionsById={actionsById}
            />
          ))}

          {/* Stands in for the opening turn until the thread exists to
            * subscribe to. Once it does, the real rows render instead. */}
          {openingText && !threadId && (
            <>
              <Message align="end">
                <MessageContent>
                  <Bubble variant="default" align="end">
                    <BubbleContent className="whitespace-pre-wrap">
                      {openingText}
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
              <Message align="start">
                <MessageContent>
                  <p
                    role="status"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Spinner className="size-3" />
                    Thinking…
                  </p>
                </MessageContent>
              </Message>
            </>
          )}
        </div>
      )}

      <InputGroup>
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
          placeholder="Ask about your calendar…"
          rows={1}
          disabled={composerBusy}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            type="button"
            size="icon-xs"
            variant="default"
            aria-label="Send"
            disabled={composerBusy || draft.trim().length === 0}
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
  );
}

/**
 * One stored turn.
 *
 * A turn is a list of blocks rather than a string because a reply can
 * interleave prose, tool activity and proposals. Text becomes a bubble, a tool
 * call becomes a one-line status, a proposal becomes a confirm card, and the
 * raw tool results stay hidden — they are written for the model, not the user.
 */
function TurnView({
  message,
  actionsById,
}: {
  message: AssistantMessage;
  actionsById: Map<Id<"assistantActions">, AssistantAction>;
}) {
  const isUser = message.role === "user";
  // A trailing tool call with no result yet is what the panel is waiting on.
  const settled = new Set(
    message.blocks.flatMap((b) =>
      b.type === "tool_result" ? [b.toolCallId] : [],
    ),
  );

  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent className="gap-2">
        {message.blocks.map((block, index) => {
          if (block.type === "text") {
            if (!block.text.trim()) return null;
            return (
              <Bubble
                key={index}
                variant={isUser ? "default" : "muted"}
                align={isUser ? "end" : "start"}
              >
                {/* What the user typed is literal text — rendering it as
                  * markdown would reformat their own words back at them. Only
                  * the assistant's side is parsed. */}
                <BubbleContent
                  className={isUser ? "whitespace-pre-wrap" : undefined}
                >
                  {isUser ? (
                    block.text
                  ) : (
                    <AssistantMarkdown text={block.text} />
                  )}
                </BubbleContent>
              </Bubble>
            );
          }

          if (block.type === "tool_call") {
            const label = TOOL_LABELS[block.name] ?? "Working";
            const done = settled.has(block.toolCallId);
            return (
              <p
                key={index}
                role="status"
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                {!done && <Spinner className="size-3" />}
                {done ? label : `${label}…`}
              </p>
            );
          }

          if (block.type === "proposal") {
            const action = actionsById.get(block.actionId);
            return action ? (
              <AssistantProposalCard key={index} action={action} />
            ) : null;
          }

          // tool_result blocks are model-facing only.
          return null;
        })}

        {message.status === "streaming" && message.blocks.length === 0 && (
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Spinner className="size-3" />
            Thinking…
          </p>
        )}

        {message.status === "error" && (
          <p role="alert" className="text-xs text-destructive">
            {message.error ?? "Something went wrong."}
          </p>
        )}
      </MessageContent>
    </Message>
  );
}
