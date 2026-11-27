# qali

**One place to plan your time.**

qali brings everything that decides your day into one planner: your calendars
from every Google account, the people you meet with, the time others book with
you, the reminders that keep you on track, and the time zones you work across.
It runs on the web and as a native Mac app, and both stay in sync with Google
Calendar.

- **Web:** [calendar.myqali.com](https://calendar.myqali.com)
- **Mac:** [download the latest release](https://github.com/NatnaelTaddese/qali/releases/latest) (macOS 26.2 or later; updates itself)
- **Site:** [myqali.com](https://myqali.com)

## What you can do with it

**See and shape your week.** Day, week and month views over every calendar
you connect, from one or more Google accounts. Create events by dragging,
reschedule by dragging, and edit everything Google can: recurring series,
guests and their responses, free/busy, locations and Google Meet links. Find
any event with search (⌘K).

**Plan across time zones.** Set the zone you work in and keep events in the zone
they were set in. On the Mac, show extra zones beside the hours and get offered
a switch when you travel.

**Let people book you.** A public booking page at
`calendar.myqali.com/<you>` with your weekly hours, one-off day changes, a
minimum notice and how far ahead people can book. Open slots respect your real
calendar, and requests wait for you to accept or decline them.

**Know who's coming.** A people directory built from your saved contacts,
Google's "Other contacts" and everyone you meet with, so guests show a real
name and photo even when you never saved them.

**Stay on time.** Event reminders arrive as notifications, in the browser or in
Notification Center on the Mac. On the Mac, a menu bar companion shows the event
you're in and what's next, with a world clock.

**Hand off the busywork.** Qali, the built-in assistant, looks up your
schedule, finds free time and drafts changes in plain language. Nothing reaches
your calendar or anyone's inbox until you confirm it.

**On the way:** tasks, so your to-dos sit on the same plan as your time.

## How it's built

A TypeScript monorepo with a native Swift app beside it.

| Path | What it is |
| --- | --- |
| `apps/web` | The planner on the web: React, TanStack Router and Vite |
| `apps/macos` | Qali for Mac: SwiftUI in an AppKit shell, drawn with Liquid Glass ([README](apps/macos/README.md)) |
| `apps/www` | The marketing site, [myqali.com](https://myqali.com) |
| `packages/backend` | The reactive [Convex](https://convex.dev) backend: Google sync, booking, reminders, the assistant, and [Better Auth](https://better-auth.com) for Google sign-in |
| `packages/domain` | Scheduling rules shared across apps: availability, permissions, reminders, search |
| `packages/ui` | Shared [shadcn/ui](https://ui.shadcn.com) components and design tokens |
| `packages/env`, `packages/config` | Typed environment variables and shared TypeScript config |

## Run it locally

You need [Bun](https://bun.sh), a [Convex account](https://dashboard.convex.dev/)
and a Google Cloud project with the Calendar and People APIs.

```bash
bun install
bun run dev:setup    # connect a Convex deployment
bun run dev          # web app on http://localhost:3001
```

[CONTRIBUTING.md](CONTRIBUTING.md) walks through Google OAuth, the optional
assistant and push-notification keys, and the checks to run before a pull
request. For the Mac app, see [apps/macos/README.md](apps/macos/README.md).

## UI components

Shared shadcn/ui primitives live in `packages/ui`: design tokens and global
styles in `packages/ui/src/styles/globals.css`, components in
`packages/ui/src/components/*`. Add more from the project root and import them
with the `@qali/ui` alias:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

```tsx
import { Button } from "@qali/ui/components/button";
```

For app-specific blocks, run the shadcn CLI from `apps/web` instead.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the pull request workflow.

## License

[GNU AGPL v3](LICENSE)
