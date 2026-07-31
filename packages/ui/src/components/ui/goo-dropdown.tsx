import React, {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
} from 'motion/react'

import { cn } from '@qali/ui/lib/utils'
import { playClickSound, playHoverSound } from '@qali/ui/lib/sound'

export type DropdownItem = {
  label: string
  onClick?: () => void
}

type SpringConfig = {
  type: 'spring'
  stiffness?: number
  damping?: number
  mass?: number
  bounce?: number
  visualDuration?: number
}

export type GooDropdownProps = {
  trigger?: ReactNode
  items?: DropdownItem[]
  disabled?: boolean
  menuLabel?: string
  width?: number
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
  gap?: number
  itemHeight?: number
  buttonRadius?: number
  panelRadius?: number
  fill?: string
  foreground?: string
  hoverFill?: string
  gooStrength?: number
  spring?: SpringConfig
  className?: string
  /** Extra classes for the trigger button, e.g. to make it fill its row. */
  triggerClassName?: string
  /** Cap the panel height and scroll the list past it. Omit for a list that
   * always renders at full height (the original behaviour). */
  maxHeight?: number
  /** Open with this item focused and scrolled into view instead of the first. */
  selectedIndex?: number
  /** Accessible name for the trigger button (its text is otherwise the name). */
  triggerLabel?: string
  /** Render arbitrary content in the morphing panel instead of `items` (e.g. a
   * picker). Requires `contentHeight` to size the panel. */
  panelContent?: ReactNode
  /** Body height in px for `panelContent` mode (padding is added on top). */
  contentHeight?: number
  /** Play a tick when the pointer enters the trigger. Default true. */
  triggerSound?: boolean
}

type Geometry = {
  left: number
  top: number
  width: number
  height: number
  panelTop: number
  panelHeight: number
  closed: Shape
  opened: Shape
}

type Shape = {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

const PANEL_PADDING = 6
const VIEWPORT_PADDING = 8
const FILL = 'var(--popover)'
const FOREGROUND = 'var(--popover-foreground)'
const HOVER_FILL = 'var(--accent)'

const DEFAULT_ITEMS: DropdownItem[] = [
  { label: 'Copy link', onClick: () => {} },
  { label: 'Share on X', onClick: () => {} },
  { label: 'Embed', onClick: () => {} },
]

const DEFAULT_SPRING: SpringConfig = {
  type: 'spring',
  visualDuration: 0.3,
  bounce: 0.15,
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function roundedRectShape({ x, y, width, height, radius }: Shape) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  const k = r * 0.5523
  const x2 = x + width
  const y2 = y + height
  const p = (value: number) => `${value.toFixed(3)}px`

  return (
    `shape(from ${p(x + r)} ${p(y)}, ` +
    `line to ${p(x2 - r)} ${p(y)}, ` +
    `curve to ${p(x2)} ${p(y + r)} with ${p(x2 - r + k)} ${p(y)} / ${p(x2)} ${p(y + r - k)}, ` +
    `line to ${p(x2)} ${p(y2 - r)}, ` +
    `curve to ${p(x2 - r)} ${p(y2)} with ${p(x2)} ${p(y2 - r + k)} / ${p(x2 - r + k)} ${p(y2)}, ` +
    `line to ${p(x + r)} ${p(y2)}, ` +
    `curve to ${p(x)} ${p(y2 - r)} with ${p(x + r - k)} ${p(y2)} / ${p(x)} ${p(y2 - r + k)}, ` +
    `line to ${p(x)} ${p(y + r)}, ` +
    `curve to ${p(x + r)} ${p(y)} with ${p(x)} ${p(y + r - k)} / ${p(x + r - k)} ${p(y)}, ` +
    `close)`
  )
}

function menuGeometry(
  trigger: DOMRect,
  bodyHeight: number,
  width: number,
  align: 'start' | 'end',
  requestedSide: 'top' | 'bottom',
  gap: number,
  buttonRadius: number,
  panelRadius: number,
  maxHeight: number | undefined,
): Geometry {
  const panelWidth = Math.min(width, window.innerWidth - VIEWPORT_PADDING * 2)
  const contentHeight = bodyHeight + PANEL_PADDING * 2
  // A capped panel shows a window onto the body; the content scrolls past it.
  const panelHeight = maxHeight
    ? Math.min(contentHeight, maxHeight)
    : contentHeight
  const topSpace = trigger.top - VIEWPORT_PADDING - gap
  const bottomSpace = window.innerHeight - trigger.bottom - VIEWPORT_PADDING - gap
  const side =
    requestedSide === 'top' && topSpace < panelHeight && bottomSpace >= panelHeight
      ? 'bottom'
      : requestedSide === 'bottom' && bottomSpace < panelHeight && topSpace >= panelHeight
        ? 'top'
        : requestedSide
  const desiredLeft = align === 'end' ? trigger.right - panelWidth : trigger.left
  const left = Math.min(
    Math.max(desiredLeft, VIEWPORT_PADDING),
    window.innerWidth - panelWidth - VIEWPORT_PADDING,
  )
  const triggerX = trigger.left - left

  if (side === 'top') {
    const top = Math.max(VIEWPORT_PADDING, trigger.top - gap - panelHeight)
    const triggerY = trigger.top - top
    return {
      left,
      top,
      width: panelWidth,
      height: Math.max(panelHeight, triggerY + trigger.height),
      panelTop: 0,
      panelHeight,
      closed: {
        x: triggerX,
        y: triggerY,
        width: trigger.width,
        height: trigger.height,
        radius: buttonRadius,
      },
      opened: {
        x: 0,
        y: 0,
        width: panelWidth,
        height: panelHeight,
        radius: panelRadius,
      },
    }
  }

  const panelTop = trigger.height + gap
  return {
    left,
    top: trigger.top,
    width: panelWidth,
    height: panelTop + panelHeight,
    panelTop,
    panelHeight,
    closed: {
      x: triggerX,
      y: 0,
      width: trigger.width,
      height: trigger.height,
      radius: buttonRadius,
    },
    opened: {
      x: 0,
      y: panelTop,
      width: panelWidth,
      height: panelHeight,
      radius: panelRadius,
    },
  }
}

export function GooDropdown({
  trigger = 'Share',
  items = DEFAULT_ITEMS,
  disabled = false,
  menuLabel = 'Actions',
  width = 240,
  align = 'end',
  side = 'bottom',
  gap = 18,
  itemHeight = 40,
  buttonRadius = 12,
  panelRadius = 20,
  fill = FILL,
  foreground = FOREGROUND,
  hoverFill = HOVER_FILL,
  gooStrength = 8,
  spring = DEFAULT_SPRING,
  className,
  triggerClassName,
  maxHeight,
  selectedIndex,
  triggerLabel,
  panelContent,
  contentHeight,
  triggerSound = true,
}: GooDropdownProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const shouldReduceMotion = useReducedMotion()
  const filterId = useId().replace(/[:]/g, '')
  const menuId = useId()

  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const shapeAt = useMemo(() => {
    if (!geometry) return null
    return (progress: number) =>
      roundedRectShape({
        x: lerp(geometry.closed.x, geometry.opened.x, progress),
        y: lerp(geometry.closed.y, geometry.opened.y, progress),
        width: lerp(geometry.closed.width, geometry.opened.width, progress),
        height: lerp(geometry.closed.height, geometry.opened.height, progress),
        radius: lerp(geometry.closed.radius, geometry.opened.radius, progress),
      })
  }, [geometry])

  const progress = useMotionValue(0)

  useMotionValueEvent(progress, 'change', (value) => {
    if (!shapeAt) return
    const shape = shapeAt(value)
    if (panelRef.current) panelRef.current.style.clipPath = shape
    if (contentRef.current) contentRef.current.style.clipPath = shape
  })

  useEffect(() => {
    if (!geometry) return
    if (shouldReduceMotion) {
      progress.set(open ? 1 : 0)
      if (!open) setGeometry(null)
      return
    }

    let cancelled = false
    const animation = animate(progress, open ? 1 : 0, {
      ...spring,
      visualDuration: open
        ? (spring.visualDuration ?? 0.3)
        : spring.visualDuration
          ? spring.visualDuration * 0.7
          : 0.2,
    })
    if (!open) {
      animation.then(() => {
        if (!cancelled) setGeometry(null)
      })
    }
    return () => {
      cancelled = true
      animation.stop()
    }
  }, [geometry, open, progress, shouldReduceMotion, spring])

  useEffect(() => {
    if (!open || !geometry || panelContent) return
    const index = selectedIndex ?? 0
    const frame = requestAnimationFrame(() => {
      const el = itemRefs.current[index]
      // Position the list before focusing so a long menu opens on the current
      // value; preventScroll keeps focus from yanking the page instead.
      if (index > 0 && menuRef.current) {
        menuRef.current.scrollTop =
          index * itemHeight - geometry.panelHeight / 2 + itemHeight / 2
      }
      el?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [geometry, open, selectedIndex, itemHeight, panelContent])

  const closeMenu = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeMenu()
    }
    const onViewportChange = (event: Event) => {
      // A scroll inside the menu's own list is expected — only page-level
      // scroll or resize should dismiss.
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node))
        return
      closeMenu(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open])

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect || disabled || (!panelContent && items.length === 0)) return
    const bodyHeight = panelContent
      ? (contentHeight ?? 0)
      : items.length * itemHeight
    progress.set(0)
    setActiveIndex(selectedIndex ?? 0)
    setGeometry(
      menuGeometry(
        rect,
        bodyHeight,
        width,
        align,
        side,
        gap,
        buttonRadius,
        panelRadius,
        maxHeight,
      ),
    )
    setOpen(true)
  }

  const select = (item: DropdownItem) => {
    playClickSound()
    closeMenu()
    item.onClick?.()
  }

  const onItemKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    if (next === null) return

    event.preventDefault()
    setActiveIndex(next)
    itemRefs.current[next]?.focus()
  }

  const closedShape = geometry ? roundedRectShape(geometry.closed) : undefined

  return (
    <div
      ref={rootRef}
      className={cn('relative inline-flex h-8 shrink-0 select-none', className)}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{ borderRadius: buttonRadius, background: fill }}
      />
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onMouseEnter={triggerSound ? () => playHoverSound() : undefined}
        onClick={() => {
          playClickSound()
          if (open) closeMenu()
          else openMenu()
        }}
        aria-label={triggerLabel}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "relative flex h-8 items-center justify-center gap-1 px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
          triggerClassName,
        )}
        style={{
          borderRadius: buttonRadius,
          color: foreground,
          opacity: open ? 0 : 1,
        }}
      >
        {trigger}
      </button>

      {geometry &&
        createPortal(
          <>
            <div
              aria-hidden
              className="pointer-events-none fixed z-[60]"
              style={{
                left: geometry.left,
                top: geometry.top,
                width: geometry.width,
                height: geometry.height,
                filter: shouldReduceMotion ? 'none' : `url(#${filterId})`,
              }}
            >
              <svg className="absolute h-0 w-0">
                <defs>
                  <filter id={filterId}>
                    <feGaussianBlur
                      in="SourceGraphic"
                      stdDeviation={gooStrength}
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
              <div
                className="absolute"
                style={{
                  left: geometry.closed.x,
                  top: geometry.closed.y,
                  width: geometry.closed.width,
                  height: geometry.closed.height,
                  borderRadius: buttonRadius,
                  background: fill,
                }}
              />
              <div
                ref={panelRef}
                className="absolute inset-0 will-change-[clip-path]"
                style={{ background: fill, clipPath: closedShape }}
              />
              <div
                className="absolute flex items-center justify-center gap-1 text-sm font-medium"
                style={{
                  left: geometry.closed.x,
                  top: geometry.closed.y,
                  width: geometry.closed.width,
                  height: geometry.closed.height,
                  borderRadius: buttonRadius,
                  color: foreground,
                }}
              >
                {trigger}
              </div>
            </div>

            <div
              ref={contentRef}
              className="pointer-events-none fixed z-[70] will-change-[clip-path]"
              style={{
                left: geometry.left,
                top: geometry.top,
                width: geometry.width,
                height: geometry.height,
                clipPath: closedShape,
              }}
            >
              <div
                id={menuId}
                ref={menuRef}
                data-slot="goo-dropdown-content"
                role={panelContent ? undefined : 'menu'}
                aria-label={menuLabel}
                className="pointer-events-auto absolute inset-x-0"
                style={
                  {
                    top: geometry.panelTop,
                    height: geometry.panelHeight,
                    padding: PANEL_PADDING,
                    color: foreground,
                    overflowY: !panelContent && maxHeight ? 'auto' : undefined,
                    scrollbarWidth: 'thin',
                    '--goo-hover-fill': hoverFill,
                  } as React.CSSProperties & { '--goo-hover-fill': string }
                }
              >
                {panelContent}
                {!panelContent &&
                  items.map((item, index) => (
                  <button
                    key={item.label}
                    ref={(element) => {
                      itemRefs.current[index] = element
                    }}
                    role="menuitem"
                    type="button"
                    tabIndex={open && activeIndex === index ? 0 : -1}
                    onMouseEnter={() => playHoverSound()}
                    onClick={() => select(item)}
                    onKeyDown={(event) => onItemKeyDown(event, index)}
                    style={{ height: itemHeight }}
                    className="flex w-full items-center rounded-[14px] px-3 text-left text-sm outline-none transition-colors duration-150 hover:bg-[var(--goo-hover-fill)] focus-visible:bg-[var(--goo-hover-fill)]"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}

export default GooDropdown
