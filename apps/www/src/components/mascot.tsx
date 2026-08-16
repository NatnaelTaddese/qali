import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "@qali/ui/lib/utils";

export type MascotProps = {
  className?: string;
  proximity?: number;
};

export type MascotBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type MascotPointerTarget = {
  x: number;
  y: number;
  strength: number;
};

const POINTER_SPRING = {
  visualDuration: 0.3,
  bounce: 0.15,
} as const;

/** Snappy spring for the gaze — real eyes dart fast, so this tracks the cursor
 * almost immediately and gives the autonomous idle glances a lively flick. */
const GAZE_SPRING = {
  visualDuration: 0.18,
  bounce: 0.22,
} as const;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(value, maximum));

/** Maps a viewport pointer to the mascot's local -1..1 movement space. */
export function mascotPointerTarget(
  clientX: number,
  clientY: number,
  bounds: MascotBounds,
  proximity: number,
): MascotPointerTarget | null {
  const halo = Math.max(0, proximity);
  const outsideX = Math.max(bounds.left - clientX, 0, clientX - bounds.right);
  const outsideY = Math.max(bounds.top - clientY, 0, clientY - bounds.bottom);
  const outsideDistance = Math.hypot(outsideX, outsideY);

  if (outsideDistance > halo) return null;

  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const strength = halo === 0 ? 1 : 1 - outsideDistance / halo;

  return {
    x:
      clamp(
        (clientX - centerX) / Math.max(bounds.width / 2 + halo, 1),
        -1,
        1,
      ) * strength,
    y:
      clamp(
        (clientY - centerY) / Math.max(bounds.height / 2 + halo, 1),
        -1,
        1,
      ) * strength,
    strength,
  };
}

function safeSvgId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * The melty ghost body. A plump, slightly-tilted blob with an irregular
 * two-curl tail — the bold outline and organic edge take their cue from the
 * reference character, while the fill/stroke use theme tokens so it reads in
 * both light and dark.
 */
const BODY_PATH =
  "M40 118 C36 66 74 30 122 32 C172 34 202 74 196 122 C193 147 181 158 176 176 C171 195 176 214 156 216 C141 217 137 201 128 199 C119 197 113 208 101 209 C86 210 80 197 73 180 C67 165 51 158 45 141 C41 129 40 124 40 118 Z";

export function Mascot({ className, proximity = 220 }: MascotProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;
  const [documentHidden, setDocumentHidden] = useState(false);
  const paused = reduceMotion || documentHidden;

  const id = `mascot-${safeSvgId(useId())}`;
  const eyeChromaId = `${id}-eye-chroma`;
  const edgeChromaId = `${id}-edge-chroma`;
  const faceShadowId = `${id}-face-shadow`;
  const eyeShadowId = `${id}-eye-shadow`;
  const eyeGlossId = `${id}-eye-gloss`;
  const bodyClipId = `${id}-body-clip`;
  const holoId = `${id}-holo`;
  const curlId = `${id}-curl`;
  const creaseId = `${id}-crease`;

  const targetX = useMotionValue(0);
  const targetY = useMotionValue(0);
  const targetRotate = useMotionValue(0);
  const targetScaleX = useMotionValue(1);
  const targetScaleY = useMotionValue(1);
  const pupilTargetX = useMotionValue(0);
  const pupilTargetY = useMotionValue(0);

  const x = useSpring(targetX, POINTER_SPRING);
  const y = useSpring(targetY, POINTER_SPRING);
  const rotate = useSpring(targetRotate, POINTER_SPRING);
  const scaleX = useSpring(targetScaleX, POINTER_SPRING);
  const scaleY = useSpring(targetScaleY, POINTER_SPRING);
  const pupilX = useSpring(pupilTargetX, GAZE_SPRING);
  const pupilY = useSpring(pupilTargetY, GAZE_SPRING);

  const tapScaleX = useMotionValue(1);
  const tapScaleY = useMotionValue(1);
  const tapAnimations = useRef<Array<{ stop: () => void }>>([]);

  const pointerActiveRef = useRef(false);

  const resetPointer = useCallback(() => {
    pointerActiveRef.current = false;
    targetX.set(0);
    targetY.set(0);
    targetRotate.set(0);
    targetScaleX.set(1);
    targetScaleY.set(1);
    pupilTargetX.set(0);
    pupilTargetY.set(0);
  }, [
    pupilTargetX,
    pupilTargetY,
    targetRotate,
    targetScaleX,
    targetScaleY,
    targetX,
    targetY,
  ]);

  useEffect(() => {
    const onVisibilityChange = () => setDocumentHidden(document.hidden);
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!paused) return;
    resetPointer();
    tapAnimations.current.forEach((animation) => animation.stop());
    tapAnimations.current = [];
    tapScaleX.set(1);
    tapScaleY.set(1);
  }, [paused, resetPointer, tapScaleX, tapScaleY]);

  useEffect(() => {
    const root = rootRef.current;
    const hero = root?.parentElement;
    if (!root || !hero || paused) return;

    let bounds = root.getBoundingClientRect();
    let measureFrame = 0;

    const measure = () => {
      bounds = root.getBoundingClientRect();
      measureFrame = 0;
    };
    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(measure);
    };
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch") {
        resetPointer();
        return;
      }
      const target = mascotPointerTarget(
        event.clientX,
        event.clientY,
        bounds,
        proximity,
      );
      if (!target) {
        resetPointer();
        return;
      }

      pointerActiveRef.current = true;
      const horizontalStretch = Math.abs(target.x) * 0.03;
      const verticalStretch = Math.abs(target.y) * 0.02;
      targetX.set(target.x * 10);
      targetY.set(target.y * 10);
      targetRotate.set(target.x * 4);
      targetScaleX.set(1 + horizontalStretch - verticalStretch * 0.35);
      targetScaleY.set(1 + verticalStretch - horizontalStretch * 0.35);
      pupilTargetX.set(target.x * 14);
      pupilTargetY.set(target.y * 12);
    };

    hero.addEventListener("pointerenter", measure);
    hero.addEventListener("pointermove", onPointerMove);
    hero.addEventListener("pointerleave", resetPointer);
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(root);

    return () => {
      hero.removeEventListener("pointerenter", measure);
      hero.removeEventListener("pointermove", onPointerMove);
      hero.removeEventListener("pointerleave", resetPointer);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      observer.disconnect();
      if (measureFrame) cancelAnimationFrame(measureFrame);
    };
  }, [
    paused,
    proximity,
    pupilTargetX,
    pupilTargetY,
    resetPointer,
    targetRotate,
    targetScaleX,
    targetScaleY,
    targetX,
    targetY,
  ]);

  // Idle look-around: while nothing is steering the gaze, the eyes drift to a
  // new spot every few seconds, then settle back to centre. Small, curious,
  // and enough to keep the character feeling awake.
  useEffect(() => {
    if (paused) return;
    let timeout: ReturnType<typeof setTimeout>;

    const scheduleGaze = (delay: number) => {
      timeout = setTimeout(() => {
        if (!pointerActiveRef.current) {
          const angle = Math.random() * Math.PI * 2;
          const reach = 3 + Math.random() * 4;
          pupilTargetX.set(Math.cos(angle) * reach);
          pupilTargetY.set(Math.sin(angle) * reach * 0.7);
          setTimeout(() => {
            if (!pointerActiveRef.current) {
              pupilTargetX.set(0);
              pupilTargetY.set(0);
            }
          }, 900);
        }
        scheduleGaze(2600 + Math.random() * 2600);
      }, delay);
    };

    scheduleGaze(1800 + Math.random() * 1500);
    return () => clearTimeout(timeout);
  }, [paused, pupilTargetX, pupilTargetY]);

  useEffect(
    () => () => {
      tapAnimations.current.forEach((animation) => animation.stop());
    },
    [],
  );

  const reactToTap = useCallback(() => {
    if (paused) return;
    tapAnimations.current.forEach((animation) => animation.stop());
    tapAnimations.current = [
      animate(tapScaleX, [tapScaleX.get(), 1.085, 0.98, 1], {
        duration: 0.5,
        times: [0, 0.28, 0.7, 1],
        ease: "easeInOut",
      }),
      animate(tapScaleY, [tapScaleY.get(), 0.9, 1.03, 1], {
        duration: 0.5,
        times: [0, 0.28, 0.7, 1],
        ease: "easeInOut",
      }),
    ];
  }, [paused, tapScaleX, tapScaleY]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-mascot=""
      data-paused={paused ? "true" : "false"}
      className={cn("mascot select-none", className)}
      onPointerDown={reactToTap}
    >
      <div className="mascot__idle h-full w-full">
        <div className="mascot__peel h-full w-full">
        <motion.div
          className="h-full w-full"
          style={{ x, y, rotate, scaleX, scaleY }}
        >
            <motion.div
              className="h-full w-full"
              style={{ scaleX: tapScaleX, scaleY: tapScaleY }}
            >
              <svg
                viewBox="0 0 236 236"
                role="presentation"
                focusable="false"
                className="h-full w-full overflow-visible"
              >
                <defs>
                  <linearGradient
                    id={eyeChromaId}
                    gradientUnits="userSpaceOnUse"
                    x1="78"
                    y1="150"
                    x2="158"
                    y2="72"
                  >
                    <stop offset="0" stopColor="var(--chroma-1)" />
                    <stop offset="0.23" stopColor="var(--chroma-2)" />
                    <stop offset="0.46" stopColor="var(--chroma-3)" />
                    <stop offset="0.69" stopColor="var(--chroma-4)" />
                    <stop offset="1" stopColor="var(--chroma-5)" />
                  </linearGradient>
                  <linearGradient
                    id={edgeChromaId}
                    gradientUnits="userSpaceOnUse"
                    x1="40"
                    y1="210"
                    x2="196"
                    y2="40"
                  >
                    <stop offset="0" stopColor="var(--chroma-1)" />
                    <stop offset="0.23" stopColor="var(--chroma-2)" />
                    <stop offset="0.46" stopColor="var(--chroma-3)" />
                    <stop offset="0.69" stopColor="var(--chroma-4)" />
                    <stop offset="1" stopColor="var(--chroma-5)" />
                  </linearGradient>
                  <filter
                    id={faceShadowId}
                    x="-35%"
                    y="-35%"
                    width="170%"
                    height="180%"
                  >
                    <feDropShadow
                      dx="0"
                      dy="10"
                      stdDeviation="14"
                      floodColor="#211b32"
                      floodOpacity="0.22"
                    />
                  </filter>
                  <filter
                    id={eyeShadowId}
                    x="-60%"
                    y="-60%"
                    width="220%"
                    height="240%"
                  >
                    <feDropShadow
                      dx="0"
                      dy="4"
                      stdDeviation="4"
                      floodColor="#1a1330"
                      floodOpacity="0.28"
                    />
                  </filter>
                  <linearGradient id={eyeGlossId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="white" stopOpacity="0.85" />
                    <stop offset="0.55" stopColor="white" stopOpacity="0.12" />
                    <stop offset="1" stopColor="white" stopOpacity="0" />
                  </linearGradient>
                  {/* Holographic sweep band: a translucent rainbow with a bright
                      specular core, swept across the body silhouette once on
                      entry so the sticker settles with a foil-like shimmer. */}
                  <linearGradient id={holoId} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="var(--chroma-5)" stopOpacity="0" />
                    <stop offset="0.18" stopColor="var(--chroma-5)" stopOpacity="0.5" />
                    <stop offset="0.34" stopColor="var(--chroma-1)" stopOpacity="0.55" />
                    <stop offset="0.5" stopColor="white" stopOpacity="0.9" />
                    <stop offset="0.66" stopColor="var(--chroma-3)" stopOpacity="0.55" />
                    <stop offset="0.82" stopColor="var(--chroma-2)" stopOpacity="0.5" />
                    <stop offset="1" stopColor="var(--chroma-2)" stopOpacity="0" />
                  </linearGradient>
                  {/* Curl light: a shaded underside (the paper bending away
                      from the light) immediately followed by a bright crest (the
                      lit ridge of the bend). Swept across, this pair reads as a
                      rolling curl. Horizontal here; the rect's rotation angles
                      it to the peel's diagonal. */}
                  <linearGradient id={curlId} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#181126" stopOpacity="0" />
                    <stop offset="0.32" stopColor="#181126" stopOpacity="0.34" />
                    <stop offset="0.47" stopColor="white" stopOpacity="0.96" />
                    <stop offset="0.55" stopColor="white" stopOpacity="0.4" />
                    <stop offset="0.68" stopColor="white" stopOpacity="0" />
                  </linearGradient>
                  {/* Contact crease: a low shade that deepens along the lower
                      edge at the moment the paper presses onto the page. */}
                  <linearGradient id={creaseId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0.5" stopColor="#1e1630" stopOpacity="0" />
                    <stop offset="1" stopColor="#1e1630" stopOpacity="0.24" />
                  </linearGradient>
                  <clipPath id={bodyClipId}>
                    <path d={BODY_PATH} />
                  </clipPath>
                </defs>

                {/* Soft chroma halo bleeding out from behind the bold edge. */}
                <path
                  d={BODY_PATH}
                  fill="none"
                  stroke={`url(#${edgeChromaId})`}
                  strokeOpacity="0.34"
                  strokeWidth="14"
                  strokeLinejoin="round"
                />
                <g filter={`url(#${faceShadowId})`}>
                  <path
                    d={BODY_PATH}
                    fill="var(--background)"
                    stroke="var(--foreground)"
                    strokeWidth="9"
                    strokeLinejoin="round"
                  />
                </g>
                {/* Inner top-left sheen, like light catching the crown. */}
                <path
                  d="M62 96 C74 60 104 46 140 50"
                  fill="none"
                  stroke="white"
                  strokeOpacity="0.7"
                  strokeWidth="4"
                  strokeLinecap="round"
                />

                {/* Capsule eyes: raised lozenges with a soft drop shadow and a
                    glossy top highlight, gaze steered by the pupil springs. */}
                <g className="mascot__blink">
                  <motion.g
                    style={{ x: pupilX, y: pupilY }}
                    filter={`url(#${eyeShadowId})`}
                  >
                    {/* Resting capsule eyes. */}
                    <g>
                      <g>
                        <rect
                          x="79"
                          y="86"
                          width="30"
                          height="56"
                          rx="15"
                          fill={`url(#${eyeChromaId})`}
                        />
                        <rect
                          x="84"
                          y="91"
                          width="20"
                          height="34"
                          rx="10"
                          fill={`url(#${eyeGlossId})`}
                        />
                      </g>
                      <g>
                        <rect
                          x="127"
                          y="90"
                          width="30"
                          height="56"
                          rx="15"
                          fill={`url(#${eyeChromaId})`}
                        />
                        <rect
                          x="132"
                          y="95"
                          width="20"
                          height="34"
                          rx="10"
                          fill={`url(#${eyeGlossId})`}
                        />
                      </g>
                    </g>
                  </motion.g>
                </g>

                {/* Foil shimmer, clipped to the body and swept once on entry. */}
                <g clipPath={`url(#${bodyClipId})`}>
                  <rect
                    className="mascot__holo"
                    x="-20"
                    y="-40"
                    width="150"
                    height="320"
                    fill={`url(#${holoId})`}
                  />
                </g>

                {/* Paper-surface light: a curl of shadow-then-highlight sweeping
                    diagonally across the face as the sheet unrolls, plus a
                    contact crease that pulses along the lower edge as it presses
                    onto the page. */}
                <g clipPath={`url(#${bodyClipId})`}>
                  <rect
                    className="mascot__curl"
                    x="70"
                    y="-72"
                    width="96"
                    height="380"
                    fill={`url(#${curlId})`}
                  />
                  <rect
                    className="mascot__crease"
                    x="0"
                    y="0"
                    width="236"
                    height="236"
                    fill={`url(#${creaseId})`}
                  />
                </g>
              </svg>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
