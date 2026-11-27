import { cn } from "@qali/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

/**
 * `lead` over a drum of `phrases` that spins once and settles on `final` in
 * the chroma gradient. With `preview`, the next line shows below while it
 * spins, fading out (it needs the room below); without, the lines roll
 * through a single line's window. Reduced motion shows `final` at once.
 * `settledClassName` styles `final` once it locks (the chroma gradient by
 * default).
 */
export function DrumHeadline({
  lead,
  phrases,
  final,
  className,
  delay = 0.5,
  preview = true,
  settledClassName = "concept-link",
}: {
  lead: string;
  phrases: string[];
  final: string;
  className?: string;
  delay?: number;
  preview?: boolean;
  settledClassName?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const [settled, setSettled] = useState(reduce);
  const lines = [...phrases, final];
  const end = `-${(lines.length - 1) * 1.15}em`;

  return (
    <h1 className={cn("leading-[1.15]", className)}>
      <span className="block">{lead}</span>
      <span className="relative block h-[1.15em]">
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-0 overflow-hidden",
            preview ? "h-[2.3em]" : "h-[1.15em]",
            settled
              ? preview && "[mask-image:linear-gradient(to_bottom,black_50%,transparent_50%)]"
              : preview
                ? "[mask-image:linear-gradient(to_bottom,black_45%,transparent)]"
                : "[mask-image:linear-gradient(to_bottom,transparent,black_25%,black_75%,transparent)]",
          )}
        >
          <motion.span
            className="block"
            initial={{ y: reduce ? end : "0em" }}
            animate={{ y: end }}
            transition={{ duration: reduce ? 0 : 2.4, delay, ease: [0.7, 0, 0.25, 1] }}
            onAnimationComplete={() => setSettled(true)}
          >
            {lines.map((line, index) => (
              <span
                key={line}
                className={cn(
                  "block h-[1.15em] whitespace-nowrap",
                  index < lines.length - 1 && "opacity-45",
                  index === lines.length - 1 && settled && settledClassName,
                )}
              >
                {line}
              </span>
            ))}
          </motion.span>
        </span>
        <span className="sr-only">{final}</span>
      </span>
    </h1>
  );
}
