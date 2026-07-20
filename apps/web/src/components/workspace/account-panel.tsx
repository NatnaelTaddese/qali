import { Cancel01Icon, Logout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";

import { authClient } from "@/lib/auth-client";
import { UserAvatar } from "./user-avatar";

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { data: session } = authClient.useSession();
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
