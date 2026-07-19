export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export const reveal = {
  initial: { opacity: 0, y: 12, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { duration: 0.52, ease: EASE_OUT_EXPO },
} as const;

export const pressTransition = {
  type: "spring",
  stiffness: 500,
  damping: 32,
} as const;

export const press = {
  whileTap: { scale: 0.97 },
  transition: pressTransition,
} as const;

// Shape moves first. Text follows.
export const expand = {
  collapsedWidth: 44,
  expandedWidth: 136,
  label: {
    expanded: { opacity: 1, transition: { delay: 0.06 } },
    collapsed: { opacity: 0, transition: { delay: 0 } },
  },
} as const;
