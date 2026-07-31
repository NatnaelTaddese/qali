"use client"

import { cn } from "@qali/ui/lib/utils"

/** A pill switch. Base UI has no Switch primitive yet, so this is a hand-rolled
 * `role="switch"` button matching the Checkbox's tokens (primary track, ring). */
function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  )
}

export { Switch }
