import { useThemeColor } from "heroui-native";
import { StyleSheet, useWindowDimensions } from "react-native";
import Svg, { Defs, Line, Mask, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";

/** Grid cell size, as on the web (apps/web/src/components/booking/calendar-backdrop.tsx). */
const COL = 200; // one "day" column
const ROW = 64; // one "hour" row

/**
 * The faint calendar time-grid behind qali's account-less surfaces, ported
 * from the web `CalendarBackdrop`: hour rows from the top, day columns
 * anchored to screen centre so a centred card lands between two of them, in
 * the calendar's border colour at 55%, faded toward the edges by a radial
 * mask. The web's ghost event cards only show from the `sm` breakpoint up,
 * so a phone gets the bare grid, as it does there.
 *
 * Render as the first child of a `relative` container; content goes above it.
 */
export function CalendarBackdrop() {
  const { width, height } = useWindowDimensions();
  const border = useThemeColor("border");
  // Day lines are anchored to screen centre: shift the pattern so a line
  // falls exactly on `width / 2`.
  const patternX = (width / 2) % COL;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={width}
      height={height}
      accessibilityElementsHidden
    >
      <Defs>
        <Pattern
          id="calendar-grid"
          x={patternX}
          y={0}
          width={COL}
          height={ROW}
          patternUnits="userSpaceOnUse"
        >
          <Line x1={0} y1={0.5} x2={COL} y2={0.5} stroke={border} strokeOpacity={0.55} />
          <Line x1={0.5} y1={0} x2={0.5} y2={ROW} stroke={border} strokeOpacity={0.55} />
        </Pattern>
        {/* radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%) */}
        <RadialGradient
          id="calendar-fade"
          cx="50%"
          cy="45%"
          rx="60%"
          ry="50%"
          gradientUnits="objectBoundingBox"
        >
          <Stop offset={0.35} stopColor="#fff" stopOpacity={1} />
          <Stop offset={0.92} stopColor="#fff" stopOpacity={0} />
        </RadialGradient>
        <Mask
          id="calendar-mask"
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={width}
          height={height}
        >
          <Rect x={0} y={0} width={width} height={height} fill="url(#calendar-fade)" />
        </Mask>
      </Defs>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="url(#calendar-grid)"
        mask="url(#calendar-mask)"
      />
    </Svg>
  );
}
