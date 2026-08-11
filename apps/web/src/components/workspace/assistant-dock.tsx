import { api } from "@qali/backend/convex/_generated/api";
import type { Id } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import {
  GooDropdown,
  type GooDropdownHandle,
} from "@qali/ui/components/ui/goo-dropdown";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useStableQuery } from "@/components/calendar/use-stable-query";
import {
  isEditableAssistantShortcutTarget,
  shouldOpenAssistantShortcut,
} from "./assistant-interactions";
import { MascotGlyph } from "./mascot-glyph";

type Threads = FunctionReturnType<typeof api.assistantData.listThreads>;
type Messages = FunctionReturnType<typeof api.assistantData.listMessages>;
type Actions = FunctionReturnType<typeof api.assistantData.listPendingActions>;
type Quota = FunctionReturnType<typeof api.assistantData.monthlyQuota>;

/**
 * The assistant is its own dock, pinned bottom-right, opening with the gooey
 * clip-path morph (the same `GooDropdown` primitive the notification panel and
 * time picker use). It expands to a fixed height and the conversation scrolls
 * inside — no dock resizing as replies stream in.
 *
 * The panel brings a markdown renderer with it — ~47 kB gzipped — for a feature
 * that is optional and, on a deployment with no API key, never reachable at
 * all. It only mounts when the dock opens it, so it can arrive then too.
 */
const loadAssistantPanel = () =>
  import("./assistant-panel").then((m) => ({ default: m.AssistantPanel }));

// Created once at module scope so React keeps its resolved value: reopening the
// dock reuses it instead of re-suspending on a fresh lazy each time. A retry
// (after a load failure) swaps in a new one to re-run the import.
const AssistantPanelLazy = lazy(loadAssistantPanel);

const PANEL_WIDTH = 400;

/** A fixed panel height: comfortable but always within the viewport, matching
 * the 80vh ceiling the panel used to grow toward inside the old dock. */
function panelHeight(): number {
  if (typeof window === "undefined") return 520;
  return Math.min(Math.round(window.innerHeight * 0.6), 560);
}

export function AssistantDock() {
  // The assistant is optional: with no API key configured its dock is not
  // rendered at all. `undefined` (still loading) counts as unavailable so the
  // button doesn't pop into the corner a beat after first paint.
  const assistantAvailable = useQuery(api.assistantData.isAvailable) === true;

  // The thread id is local to the dock so creating a thread on the first message
  // never remounts the panel mid-conversation.
  const [threadId, setThreadId] = useState<Id<"assistantThreads"> | null>(null);
  const [startingFresh, setStartingFresh] = useState(false);
  const [contentHeight, setContentHeight] = useState(panelHeight);
  const dropdownRef = useRef<GooDropdownHandle>(null);

  // The dock — always mounted — owns the conversation subscriptions, so the
  // panel opens onto warm data instead of reloading each time (the panel itself
  // only mounts while open). Thread-specific queries deliberately do not retain
  // results across argument changes: an old conversation is worse than a brief
  // loading state while a newly created thread subscribes.
  const threads = useStableQuery(
    api.assistantData.listThreads,
    assistantAvailable ? {} : "skip",
  );
  const messages = useQuery(
    api.assistantData.listMessages,
    assistantAvailable && threadId ? { threadId } : "skip",
  );
  const actions = useQuery(
    api.assistantData.listPendingActions,
    assistantAvailable && threadId ? { threadId } : "skip",
  );
  // The rolling-30-day message allowance, so the composer can show what's left
  // and block sending once it's spent. Cheap enough to keep warm with the rest.
  const quota = useQuery(
    api.assistantData.monthlyQuota,
    assistantAvailable ? {} : "skip",
  );
  // Tracks whether the panel is open so ⌘J can always close it — even from the
  // composer, where the editable-target guard would otherwise swallow the key.
  const menuOpenRef = useRef(false);
  // A rendered mirror of the same flag: the trigger glyph fills in (from its
  // resting outline) while the dock is open.
  const [menuOpen, setMenuOpen] = useState(false);

  // Warm the lazy panel as soon as the assistant exists, so opening it never
  // flashes the Suspense spinner.
  useEffect(() => {
    if (assistantAvailable) void loadAssistantPanel();
  }, [assistantAvailable]);

  // Keep the fixed panel within the viewport as the window resizes. GooDropdown
  // live-resizes smoothly when `contentHeight` changes.
  useEffect(() => {
    const onResize = () => setContentHeight(panelHeight());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ⌘J toggles the assistant from anywhere in the workspace. Registered only
  // when there is an assistant to open, so on a deployment without an API key
  // the shortcut stays free for whatever the app wants next.
  useEffect(() => {
    if (!assistantAvailable) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        shouldOpenAssistantShortcut(e, {
          blocked: false,
          // Only guard against hijacking ⌘J from a text field while the panel is
          // closed; once open, ⌘J closes it from anywhere, its composer included.
          editableTarget:
            !menuOpenRef.current && isEditableAssistantShortcutTarget(e.target),
        })
      ) {
        e.preventDefault();
        dropdownRef.current?.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assistantAvailable]);

  const selectThread = useCallback((id: Id<"assistantThreads">) => {
    setThreadId(id);
    setStartingFresh(false);
  }, []);

  const deleteThread = useMutation(api.assistantMaintenance.deleteThread);
  const startNewChat = useCallback(() => {
    // Starting fresh discards the conversation just left: at most a handful of
    // threads ever accumulate, and the 30-day cron mops up any stragglers.
    const prior = threadId;
    setThreadId(null);
    setStartingFresh(true);
    if (prior) {
      void deleteThread({ threadId: prior });
    }
  }, [threadId, deleteThread]);

  if (!assistantAvailable) return null;

  const trigger = <MascotGlyph className="size-6" active={menuOpen} />;

  return (
    // Named as its own layer only while a calendar view transition runs, so the
    // fixed dock doesn't flicker with the root snapshot (see globals.css).
    <div
      className="fixed right-6 bottom-6 z-50"
      data-dock-view-transition="assistant-dock"
    >
      <GooDropdown
        ref={dropdownRef}
        className="pointer-events-auto !h-12"
        trigger={trigger}
        triggerLabel="Assistant · ⌘J"
        menuLabel="Assistant"
        panelContent={(close) => (
          // The notification panel inherits the goo surface's resolved colour.
          // Bridge that same palette into semantic tokens for the assistant's
          // bubbles, cards and composer instead of relying on the page theme.
          <div className="goo-panel-theme h-full">
            <AssistantPanelLoader
              threadId={threadId}
              onThreadChange={selectThread}
              startFresh={startingFresh}
              onNewChat={startNewChat}
              onClose={close}
              threads={threads}
              messages={messages}
              actions={actions}
              quota={quota}
            />
          </div>
        )}
        contentHeight={contentHeight}
        onOpenChange={(o) => {
          menuOpenRef.current = o;
          setMenuOpen(o);
        }}
        // Auto-closes on an outside click, Escape, ⌘J or the header close — but
        // scrolling the calendar underneath it must not dismiss it.
        dismissOnScroll={false}
        triggerSound={false}
        align="end"
        side="top"
        gap={8}
        width={PANEL_WIDTH}
        buttonRadius={24}
        panelRadius={20}
        // Resting: a neutral FAB on the app surface. Open: it morphs into the
        // inverted primary surface, matching the notification panel's flip.
        fill="var(--popover)"
        foreground="var(--popover-foreground)"
        hoverFill="var(--accent)"
        activeFill="var(--primary)"
        activeForeground="var(--primary-foreground)"
        activeHoverFill="color-mix(in oklch, var(--primary-foreground) 14%, var(--primary))"
        triggerClassName="mascot-trigger !size-12 !px-0 rounded-full border border-border shadow-lg"
      />
    </div>
  );
}

function AssistantPanelLoader({
  threadId,
  onThreadChange,
  startFresh,
  onNewChat,
  onClose,
  threads,
  messages,
  actions,
  quota,
}: {
  threadId: Id<"assistantThreads"> | null;
  onThreadChange: (threadId: Id<"assistantThreads">) => void;
  startFresh: boolean;
  onNewChat: () => void;
  onClose: () => void;
  threads: Threads | undefined;
  messages: Messages | undefined;
  actions: Actions | undefined;
  quota: Quota | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const Panel = useMemo(
    () => (attempt === 0 ? AssistantPanelLazy : lazy(loadAssistantPanel)),
    [attempt],
  );

  return (
    <AssistantPanelErrorBoundary
      key={attempt}
      onRetry={() => setAttempt((current) => current + 1)}
      onClose={onClose}
    >
      <Suspense
        fallback={
          <div
            role="status"
            aria-label="Loading assistant"
            className="flex h-full items-center justify-center"
          >
            <Spinner />
          </div>
        }
      >
        <Panel
          threadId={threadId}
          onThreadChange={onThreadChange}
          startFresh={startFresh}
          onNewChat={onNewChat}
          onClose={onClose}
          threads={threads}
          messages={messages}
          actions={actions}
          quota={quota}
        />
      </Suspense>
    </AssistantPanelErrorBoundary>
  );
}

class AssistantPanelErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void; onClose: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col gap-3 py-2">
        <div>
          <p className="text-sm font-medium">Assistant failed to load</p>
          <p className="text-xs text-muted-foreground">
            Check your connection and try again.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" onClick={this.props.onRetry}>
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={this.props.onClose}
          >
            Close
          </Button>
        </div>
      </div>
    );
  }
}
