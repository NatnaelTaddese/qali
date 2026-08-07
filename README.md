# qali

A fast, keyboard-friendly calendar client for Google Calendar. qali syncs your
Google calendars and builds a unified people directory from your saved contacts,
Google's auto-collected "Other contacts", and everyone you meet with on your
calendar — so guests show a real name and avatar even when you never saved them.
It then gives you a focused day and month view for creating, editing, and
rescheduling events with recurring events, guests, free/busy, and Google Meet
links handled the way Google does.

Built as a TypeScript monorepo: a React + TanStack Router frontend, a reactive
Convex backend, Better Auth for Google OAuth, and a shared shadcn/ui package.


## UI Customization

Shared shadcn/ui primitives live in `packages/ui`.

- Design tokens and global styles: `packages/ui/src/styles/globals.css`
- Shared primitives: `packages/ui/src/components/*`

Add more shared primitives from the project root:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import them with the `@qali/ui` alias:

```tsx
import { Button } from "@qali/ui/components/button";
```

For app-specific blocks, run the shadcn CLI from `apps/web` instead.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
Google OAuth configuration, and the pull request workflow.
