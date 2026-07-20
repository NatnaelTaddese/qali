import { cn } from "@qali/ui/lib/utils";
import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth-client";

/**
 * Google serves avatars from lh3.googleusercontent.com and rejects some requests
 * outright (rate limits, and it honours Referer). A rejected load leaves an empty
 * <img> sitting on the circle, so track the failure and fall back to the initial.
 */
export function UserAvatar({ className }: { className?: string }) {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [user?.image]);

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-medium text-secondary-foreground ring-1 ring-border",
        className,
      )}
    >
      {user?.image && !failed ? (
        <img
          src={user.image}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        initial
      )}
    </span>
  );
}
