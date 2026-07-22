import {
  Cancel01Icon,
  ComputerSettingsIcon,
  Logout01Icon,
  Moon01Icon,
  Sun01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";

import { useTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { UserAvatar } from "./user-avatar";

const themeOptions = [
  { label: "Dark", value: "dark", icon: Moon01Icon },
  { label: "Light", value: "light", icon: Sun01Icon },
  { label: "Device", value: "system", icon: ComputerSettingsIcon },
] as const;

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { data: session } = authClient.useSession();
  const { theme, setTheme } = useTheme();
  const user = session?.user;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <UserAvatar className="size-9" />
        <div className="min-w-0 flex-1">
          {user?.name && <p className="truncate text-sm font-medium">{user.name}</p>}
          <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
      </div>
      <div className="space-y-1.5">
        <p className="px-2 text-xs font-medium text-muted-foreground">Theme</p>
        <div
          role="group"
          aria-label="Theme"
          className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1"
        >
          {themeOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={theme === option.value}
              className="rounded-xl px-2 text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm hover:bg-background/60"
              onClick={() => setTheme(option.value)}
            >
              <HugeiconsIcon icon={option.icon} strokeWidth={2} className="size-4" />
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="justify-start"
        onClick={() => void authClient.signOut()}
      >
        <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} className="size-4" />
        Sign out
      </Button>
    </div>
  );
}
