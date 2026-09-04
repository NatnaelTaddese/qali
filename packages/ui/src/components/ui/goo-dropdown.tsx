import React, {
  forwardRef,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
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
  /** Colours applied while the panel is open, so a trigger can morph from a
   * quiet closed state into an accented one. Each falls back to its resting
   * counterpart (`fill` / `foreground` / `hoverFill`) when omitted. */
  activeFill?: string
  activeForeground?: string
  activeHoverFill?: string
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
   * picker). The panel sizes itself to the rendered content and follows it
   * live; pass `contentHeight` for a fixed body instead. Pass a function to
   * receive a `close` callback, so an action inside the panel can dismiss it. */
  panelContent?: ReactNode | ((close: () => void) => ReactNode)
  /** Fixed body height in px for `panelContent` mode (padding is added on
   * top). Omit to size the panel from the measured content — hand-computed
   * pixel estimates drift from rem-based rows (the root font size is 14px). */
  contentHeight?: number
  /** Play a tick when the pointer enters the trigger. Default true. */
  triggerSound?: boolean
  /** Notified when the panel opens or closes, e.g. to hide a trigger badge that
   * the morphing panel would otherwise clip. */
  onOpenChange?: (open: boolean) => void
  /** When false, a page scroll no longer dismisses the panel, so scrolling the
   * content behind it (e.g. a calendar) leaves it open. Outside pointer, Escape
   * and resize still close it. Default true. */
  dismissOnScroll?: boolean
}

/** Imperative controls for opening the panel from outside its trigger — e.g. a
 * global keyboard shortcut. The panel still owns its open state; this just lets
 * a parent request a change. */
export type GooDropdownHandle = {
  open: () => void
  close: () => void
  toggle: () => void
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

const lerpShape = (a: Shape, b: Shape, t: number): Shape => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
  radius: lerp(a.radius, b.radius, t),
})

// Blend two panel geometries so a live height change (e.g. removing a list item)
// can animate from the current size to a freshly measured one.
const lerpGeometry = (a: Geometry, b: Geometry, t: number): Geometry => ({
  left: lerp(a.left, b.left, t),
  top: lerp(a.top, b.top, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
  panelTop: lerp(a.panelTop, b.panelTop, t),
  panelHeight: lerp(a.panelHeight, b.panelHeight, t),
  closed: lerpShape(a.closed, b.closed, t),
  opened: lerpShape(a.opened, b.opened, t),
})

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

export const GooDropdown = forwardRef<GooDropdownHandle, GooDropdownProps>(
  function GooDropdown({
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
  activeFill,
  activeForeground,
  activeHoverFill,
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
  onOpenChange,
  dismissOnScroll = true,
}: GooDropdownProps, ref) {
  const [open, setOpen] = useState(false)
  // Lags `open` by a frame so the active palette eases in via CSS transition
  // instead of snapping the moment the panel mounts.
  const [active, setActive] = useState(false)
  // True once the open morph has settled. While settled, geometry changes are a
  // live resize (not the open/close morph), so the panel clip is re-derived
  // imperatively instead of snapping to the closed shape on re-render.
  const [settled, setSettled] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const geometryRef = useRef<Geometry | null>(null)
  const resizeBodyRef = useRef<number | undefined>(undefined)
  // Rendered body height in measured `panelContent` mode. Kept across closes
  // so a re-open starts from the last known size instead of a zero-height
  // panel that snaps once the content mounts.
  const [measuredBody, setMeasuredBody] = useState<number | undefined>(undefined)
  const shouldReduceMotion = useReducedMotion()
  const filterId = useId().replace(/[:]/g, '')
  const menuId = useId()

  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
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
      setSettled(open)
      if (!open) setGeometry(null)
      return
    }

    let cancelled = false
    if (!open) setSettled(false)
    const animation = animate(progress, open ? 1 : 0, {
      ...spring,
      visualDuration: open
        ? (spring.visualDuration ?? 0.3)
        : spring.visualDuration
          ? spring.visualDuration * 0.7
          : 0.2,
    })
    animation.then(() => {
      if (cancelled) return
      if (open) setSettled(true)
      else setGeometry(null)
    })
    return () => {
      cancelled = true
      animation.stop()
    }
  }, [geometry, open, progress, shouldReduceMotion, spring])

  // Keep a ref of the current geometry so the resize effect can read it as its
  // starting point without depending on it (which would restart mid-animation).
  useEffect(() => {
    geometryRef.current = geometry
  }, [geometry])

  const panelContentMode = panelContent != null
  const measured = panelContentMode && contentHeight == null

  // Measured panels watch their rendered body and feed its height back into the
  // geometry: read synchronously on mount so the first frame is already right,
  // then via ResizeObserver so content that grows or shrinks (a dismissed
  // notification, a month with six weeks) resizes the panel live.
  const mounted = geometry !== null
  useLayoutEffect(() => {
    if (!measured || !mounted) return
    const node = bodyRef.current
    if (!node) return
    const read = () => setMeasuredBody(node.getBoundingClientRect().height)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measured, mounted])

  // A change to the body height after opening (a list item removed, or the
  // first measurement of a measured panel) resizes the panel from the geometry
  // it was built with (`resizeBodyRef`, seeded by `openMenu`) to the new one.
  useLayoutEffect(() => {
    const body = panelContentMode ? (contentHeight ?? measuredBody) : undefined
    if (!open || body === undefined || body === resizeBodyRef.current) return
    // A fixed height does not consume a change while the opening morph is
    // still using the previous geometry; once settled, the difference animates.
    // A measured panel only learns its true height once the content has
    // rendered, so it adopts that in place mid-morph — the clip is still near
    // the trigger shape, so the correction is invisible.
    if (!settled && !measured) return
    const rect = triggerRef.current?.getBoundingClientRect()
    const from = geometryRef.current
    if (!rect || !from) return
    resizeBodyRef.current = body
    const target = menuGeometry(
      rect,
      body,
      width,
      align,
      side,
      gap,
      buttonRadius,
      panelRadius,
      maxHeight,
    )
    if (shouldReduceMotion || !settled) {
      setGeometry(target)
      return
    }
    const animation = animate(0, 1, {
      duration: 0.26,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: (t) => setGeometry(lerpGeometry(from, target, t)),
    })
    animation.then(() => setGeometry(target))
    return () => animation.stop()
  }, [
    contentHeight,
    measuredBody,
    measured,
    open,
    settled,
    panelContentMode,
    width,
    align,
    side,
    gap,
    buttonRadius,
    panelRadius,
    maxHeight,
    shouldReduceMotion,
  ])

  // While settled, a re-render restamps the closed-shape clip from inline
  // styles; re-derive the open shape here (before paint) so a live resize —
  // which changes geometry every frame — never flashes back to the trigger box.
  useLayoutEffect(() => {
    if (!settled || !geometry) return
    const shape = roundedRectShape(geometry.opened)
    if (panelRef.current) panelRef.current.style.clipPath = shape
    if (contentRef.current) contentRef.current.style.clipPath = shape
  }, [settled, geometry])

  // Drive the active palette one frame behind `open`: on open the panel mounts
  // in its resting colour and then transitions in; on close it eases back out.
  // Reduced motion switches instantly, matching the shape animation.
  useEffect(() => {
    if (!open) {
      setActive(false)
      return
    }
    if (shouldReduceMotion) {
      setActive(true)
      return
    }
    const frame = requestAnimationFrame(() => setActive(true))
    return () => cancelAnimationFrame(frame)
  }, [open, shouldReduceMotion])

  useLayoutEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  // Clamp so an out-of-range `selectedIndex` can't leave the menu with nothing
  // focusable or send the scroll position off into space.
  const targetIndex =
    selectedIndex == null
      ? 0
      : Math.min(Math.max(selectedIndex, 0), Math.max(items.length - 1, 0))

  useEffect(() => {
    if (!open || !geometry || panelContent) return
    const frame = requestAnimationFrame(() => {
      const el = itemRefs.current[targetIndex]
      // Position the list before focusing so a long menu opens on the current
      // value; preventScroll keeps focus from yanking the page instead.
      if (targetIndex > 0 && menuRef.current) {
        menuRef.current.scrollTop =
          targetIndex * itemHeight - geometry.panelHeight / 2 + itemHeight / 2
      }
      el?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [geometry, open, targetIndex, itemHeight, panelContent])

  // Custom panels are dialogs rather than menus, so move focus into the portal
  // instead of leaving it on the trigger that becomes visually hidden. Wait for
  // the morph to settle so focus layout and ring painting do not compete with
  // the clip-path animation.
  useEffect(() => {
    if (!open || !settled || !panelContentMode) return
    const frame = requestAnimationFrame(() => {
      const firstControl = menuRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      const focusTarget = firstControl ?? menuRef.current
      focusTarget?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, settled, panelContentMode])

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
    // Page scroll dismissal is opt-out: a panel laid over scrollable content it
    // doesn't own (a calendar) shouldn't vanish the moment that content scrolls.
    if (dismissOnScroll)
      window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, dismissOnScroll])

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect || disabled || (!panelContent && items.length === 0)) return
    const bodyHeight = panelContent
      ? (contentHeight ?? measuredBody ?? 0)
      : items.length * itemHeight
    resizeBodyRef.current = panelContent ? bodyHeight : undefined
    progress.set(0)
    setActiveIndex(targetIndex)
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

  useImperativeHandle(
    ref,
    () => ({
      open: openMenu,
      close: () => closeMenu(),
      toggle: () => (open ? closeMenu() : openMenu()),
    }),
    // `openMenu`/`closeMenu` are re-created each render and close over the
    // current geometry props, so include them: a resize-while-closed followed
    // by an imperative `open()` must use the latest, not a stale, closure.
    [open, openMenu, closeMenu],
  )

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

  // While active, the trigger and panel take the active palette (if given), so
  // the morph carries the button from its resting colour into its open one.
  const effFill = active ? (activeFill ?? fill) : fill
  const effForeground = active ? (activeForeground ?? foreground) : foreground
  const effHoverFill = active ? (activeHoverFill ?? hoverFill) : hoverFill
  const colorTransition = shouldReduceMotion
    ? undefined
    : `background 0.3s ease, color 0.3s ease, --goo-fill 0.3s ease, --goo-foreground 0.3s ease, --goo-hover-fill 0.3s ease`

  return (
    <div
      ref={rootRef}
      className={cn('relative inline-flex h-8 shrink-0 select-none', className)}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          borderRadius: buttonRadius,
          background: effFill,
          transition: colorTransition,
        }}
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
        aria-haspopup={panelContent ? 'dialog' : 'menu'}
        className={cn(
          "relative flex h-8 items-center justify-center gap-1 px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
          triggerClassName,
        )}
        style={{
          borderRadius: buttonRadius,
          color: effForeground,
          opacity: open ? 0 : 1,
          transition: colorTransition,
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
                  background: effFill,
                  transition: colorTransition,
                }}
              />
              <div
                ref={panelRef}
                className="absolute inset-0 will-change-[clip-path]"
                style={{
                  background: effFill,
                  clipPath: closedShape,
                  transition: colorTransition,
                }}
              />
              <div
                className="absolute flex items-center justify-center gap-1 text-sm font-medium"
                style={{
                  left: geometry.closed.x,
                  top: geometry.closed.y,
                  width: geometry.closed.width,
                  height: geometry.closed.height,
                  borderRadius: buttonRadius,
                  color: effForeground,
                  transition: colorTransition,
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
                data-palette-settled={open && settled}
                role={panelContent ? 'dialog' : 'menu'}
                tabIndex={panelContent ? -1 : undefined}
                aria-label={menuLabel}
                className="pointer-events-auto absolute inset-x-0"
                style={
                  {
                    top: geometry.panelTop,
                    height: geometry.panelHeight,
                    padding: PANEL_PADDING,
                    color: effForeground,
                    transition: colorTransition,
                    // A capped list scrolls inside the panel; a fixed-height
                    // body owns its own scrolling instead.
                    overflowY: maxHeight && (!panelContent || measured) ? 'auto' : undefined,
                    scrollbarWidth: 'thin',
                    '--goo-fill': effFill,
                    '--goo-foreground': effForeground,
                    '--goo-hover-fill': effHoverFill,
                  } as React.CSSProperties & {
                    '--goo-fill': string
                    '--goo-foreground': string
                    '--goo-hover-fill': string
                  }
                }
              >
                {panelContent && (
                  <div ref={bodyRef} className={measured ? undefined : 'h-full'}>
                    {typeof panelContent === 'function'
                      ? panelContent(() => closeMenu())
                      : panelContent}
                  </div>
                )}
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
  },
)

export default GooDropdown
