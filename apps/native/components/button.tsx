import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Button as HeroButton, useThemeColor, type ButtonRootProps } from "heroui-native";
import { Platform, type PressableStateCallbackType, StyleSheet } from "react-native";

type Variant = NonNullable<ButtonRootProps["variant"]>;
type Size = NonNullable<ButtonRootProps["size"]>;

export type ButtonProps = ButtonRootProps & {
  /**
   * Corner radius of the glass surface. Native glass shapes itself, so this
   * must match the button's `rounded-*` class when one is set; by default it
   * follows heroui's per-size radius on the web scale (sm/md 22, lg 26).
   */
  radius?: number;
  /** Override the variant's glass tint; `null` for untinted glass. */
  tintColor?: string | null;
};

const hasLiquidGlass = Platform.OS === "ios" && isLiquidGlassAvailable();

const RADIUS_BY_SIZE: Record<Size, number> = { sm: 22, md: 22, lg: 26 };

/** Theme colour (heroui token name) each variant tints its glass with. */
const TINT_BY_VARIANT: Record<Variant, "accent" | "default" | "danger" | "danger-soft" | null> = {
  primary: "accent",
  secondary: "default",
  tertiary: "default",
  outline: null,
  ghost: null,
  danger: "danger",
  "danger-soft": "danger-soft",
};

// Glass never paints the variant's flat fill; the `style` prop beats the
// variant class in uniwind, unlike a `bg-transparent` utility would.
const clearFill = { backgroundColor: "transparent" } as const;

/**
 * The app's button: heroui's Button (same variants, sizes and `Button.Label`)
 * with an iOS 26 Liquid Glass surface tinted by variant — primary glass is
 * the theme's primary colour, danger-soft a translucent danger, outline and
 * ghost untinted. The glass fills heroui's `background` slot, so sizing,
 * label colours and press feedback are unchanged. Anywhere Liquid Glass is
 * unavailable (Android, iOS before 26) it is the plain heroui Button.
 */
function ButtonRoot({
  variant = "primary",
  size = "md",
  radius,
  tintColor,
  style,
  children,
  ...props
}: ButtonProps) {
  const [accent, defaultColor, danger, dangerSoft] = useThemeColor([
    "accent",
    "default",
    "danger",
    "danger-soft",
  ]);

  if (!hasLiquidGlass) {
    return (
      <HeroButton variant={variant} size={size} style={style} {...props}>
        {children}
      </HeroButton>
    );
  }

  const tintToken = TINT_BY_VARIANT[variant];
  const variantTint =
    tintToken === "accent"
      ? accent
      : tintToken === "default"
        ? defaultColor
        : tintToken === "danger"
          ? danger
          : tintToken === "danger-soft"
            ? dangerSoft
            : undefined;
  const tint = tintColor === null ? undefined : (tintColor ?? variantTint);

  return (
    <HeroButton
      variant={variant}
      size={size}
      style={
        typeof style === "function"
          ? (state: PressableStateCallbackType) => [clearFill, style(state)]
          : [clearFill, style]
      }
      background={
        <GlassView
          style={[StyleSheet.absoluteFill, { borderRadius: radius ?? RADIUS_BY_SIZE[size] }]}
          glassEffectStyle="clear"
          tintColor={tint}
          isInteractive
        />
      }
      {...props}
    >
      {children}
    </HeroButton>
  );
}

export const Button = Object.assign(ButtonRoot, {
  Label: HeroButton.Label,
  Background: HeroButton.Background,
});
