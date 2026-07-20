import type { Variants } from "motion/react";

export const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const pressTransition = {
  type: "spring",
  stiffness: 500,
  damping: 32,
} as const;

export const press = {
  whileTap: { scale: 0.97 },
  transition: pressTransition,
} as const;

// The dock morphs between shapes. Firm enough to feel physical, not bouncy.
export const SPRING_DOCK = {
  type: "spring",
  stiffness: 380,
  damping: 34,
  mass: 0.9,
} as const;

const DOCK_ENTER = { duration: 0.24, ease: EASE_OUT_EXPO };
const DOCK_EXIT = { duration: 0.16, ease: EASE_OUT_EXPO };
const SLIDE_PX = 28;

/** Content swapping inside the dock while the shell resizes around it.
 *
 * `custom` is the travel direction: 0 swaps kind (nav ↔ detail) and moves on y,
 * ±1 steps between two events in time and slides on x — later events come in
 * from the right, earlier from the left. */
export const dockVariants: Variants = {
  initial: (direction: number) =>
    direction === 0
      ? { opacity: 0, y: 8, filter: "blur(4px)" }
      : { opacity: 0, x: direction * SLIDE_PX, filter: "blur(4px)" },
  animate: {
    opacity: 1,
    x: 0,
    y: 0,
    filter: "blur(0px)",
    transition: DOCK_ENTER,
  },
  exit: (direction: number) =>
    direction === 0
      ? { opacity: 0, y: -8, filter: "blur(4px)", transition: DOCK_EXIT }
      : {
          opacity: 0,
          x: direction * -SLIDE_PX,
          filter: "blur(4px)",
          transition: DOCK_EXIT,
        },
};

export const dockVariantsReduced: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT_EXPO } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT_EXPO } },
};

// Shape moves first. Text follows.
export const expand = {
  collapsedWidth: 44,
  expandedWidth: 136,
  label: {
    expanded: { opacity: 1, transition: { delay: 0.06 } },
    collapsed: { opacity: 0, transition: { delay: 0 } },
  },
} as const;
