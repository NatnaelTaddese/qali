import { Briefcase08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";

/** Free/Busy control: whether the event blocks the user's time (`busy`:
 * unset/true = busy, false = free). A briefcase +
 * "Busy"/"Free" label sized to sit alongside the colour and calendar controls;
 * it reads solid when Busy and muted when Free. Distinct from the privacy lock,
 * which controls a separate concern (who can see the event). */
export function FreeBusyToggle({
  busy,
  onChange,
  disabled,
}: {
  busy: boolean;
  onChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="switch"
            aria-checked={busy}
            aria-label={busy ? "Busy" : "Free"}
            disabled={disabled}
            onClick={() => onChange(!busy)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              busy ? "text-foreground" : "text-muted-foreground",
              disabled && "opacity-50 hover:bg-transparent",
            )}
          >
            <HugeiconsIcon
              icon={Briefcase08Icon}
              strokeWidth={2}
              className="size-4.5"
            />
            {busy ? "Busy" : "Free"}
          </button>
        }
      />
      <TooltipContent side="top">
        {disabled
          ? busy
            ? "Busy"
            : "Free"
          : busy
            ? "Busy · change to free"
            : "Free · change to busy"}
      </TooltipContent>
    </Tooltip>
  );
}
