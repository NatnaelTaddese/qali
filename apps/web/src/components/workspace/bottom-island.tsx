import {
  Calendar03Icon,
  Menu01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@qali/ui/components/tooltip";
import { cn } from "@qali/ui/lib/utils";

import { authClient } from "@/lib/auth-client";

export function BottomIsland() {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const initial = (user?.name ?? user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <nav className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-4xl border border-border bg-popover/90 px-2 py-1.5 shadow-lg backdrop-blur">
      <NavButton icon={Calendar03Icon} label="Calendar" active />
      <NavButton icon={Menu01Icon} label="Agenda" />
      <NavButton icon={Search01Icon} label="Search" />
      <NavButton icon={PlusSignIcon} label="Create" />

      <div className="mx-1 h-6 w-px bg-border" />

      <Popover>
        <PopoverTrigger
          aria-label="Account"
          className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {user?.image ? (
            <img
              src={user.image}
              alt=""
              className="size-full rounded-full object-cover"
            />
          ) : (
            initial
          )}
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={8} className="w-56">
          <div className="flex flex-col gap-3">
            {user && (
              <div className="min-w-0">
                {user.name && (
                  <p className="truncate text-sm font-medium">{user.name}</p>
                )}
                <p className="truncate text-xs text-muted-foreground">
                  {user.email}
                </p>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => void authClient.signOut()}
            >
              Sign out
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </nav>
  );
}

function NavButton({
  icon,
  label,
  active,
}: {
  icon: IconSvgElement;
  label: string;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground",
          active && "bg-accent text-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
