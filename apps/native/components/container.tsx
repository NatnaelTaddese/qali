import { cn } from "heroui-native";
import { type PropsWithChildren } from "react";
import { ScrollView, View, type ScrollViewProps, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = ViewProps & {
  className?: string;
  isScrollable?: boolean;
  scrollViewProps?: Omit<ScrollViewProps, "contentContainerStyle">;
};

/**
 * Full-screen wrapper: fills the screen, paints the theme background and
 * pads the home-indicator inset. A plain View on purpose — uniwind only
 * resolves `className` on core components, so the scaffold's animated
 * wrapper silently dropped `flex-1` and collapsed every screen to its
 * content height.
 */
export function Container({
  children,
  className,
  isScrollable = true,
  scrollViewProps,
  style,
  ...props
}: PropsWithChildren<Props>) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className={cn("flex-1 bg-background", className)}
      style={[{ paddingBottom: insets.bottom }, style]}
      {...props}
    >
      {isScrollable ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          {...scrollViewProps}
        >
          {children}
        </ScrollView>
      ) : (
        <View className="flex-1">{children}</View>
      )}
    </View>
  );
}
