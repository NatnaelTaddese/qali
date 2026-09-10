import { cn } from "heroui-native";
import { Text as RNText, type TextProps } from "react-native";

/**
 * Text with the web defaults baked in (`body { font-sans text-foreground }`).
 * React Native text inherits nothing, so use this instead of the core Text
 * wherever a screen writes copy; pass `font-display` / colour classes to
 * override.
 */
export function Text({ className, ...props }: TextProps & { className?: string }) {
  return <RNText className={cn("font-sans text-foreground", className)} {...props} />;
}
