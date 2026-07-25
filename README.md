# qali

A fast, keyboard-friendly calendar client for Google Calendar. qali syncs your
Google calendars and contacts, then gives you a focused day and month view for
creating, editing, and rescheduling events with recurring events, guests,
free/busy, and Google Meet links handled the way Google does.

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

Contributions are welcome.

**Prerequisites:** [Git](https://git-scm.com/), [Bun 1.3.14](https://bun.sh/docs/installation),
a [Convex account](https://dashboard.convex.dev/), and a Google Cloud project.

### 1. Fork, clone, and branch

```bash
git clone https://github.com/<your-github-username>/qali.git
cd qali
git remote add upstream https://github.com/NatnaelTaddese/qali.git
git checkout -b feature/short-description   # use feature/, fix/, or docs/
```

### 2. Install and connect Convex

```bash
bun install
bun run dev:setup   # creates packages/backend/.env.local with your deployment
```

Create the web app's env file and fill in your deployment's `.convex.cloud` and
`.convex.site` URLs (found in `packages/backend/.env.local` or the Convex
dashboard):

```bash
cp apps/web/.env.example apps/web/.env.local
```

Never commit `.env` or `.env.local` files.

### 3. Configure Google OAuth

qali signs in with Google and syncs Calendar and Contacts, so a plain sign-in
client isn't enough — you need the APIs and scopes below.

**Enable APIs** — in the [Google Cloud Console](https://console.cloud.google.com/),
open **APIs & Services > Library** and enable the **Google Calendar API** and
the **People API**.

**Add scopes** — under **Google Auth Platform > Data Access**, add:

| Scope | Purpose |
| --- | --- |
| `openid` | Identify the signed-in user |
| `.../auth/userinfo.email` | Read the user's email |
| `.../auth/userinfo.profile` | Read the user's basic profile |
| `.../auth/calendar` | Read and manage calendars and events |
| `.../auth/contacts.readonly` | Read contacts for guest suggestions |

While publishing status is **Testing**, add every account that will sign in
under **Audience > Test users**.

**Create the OAuth client** — under **APIs & Services > Credentials**, create an
**OAuth client ID** of type **Web application** and add this redirect URI
(the callback lives on Convex, not localhost, because Better Auth's HTTP routes
are hosted by Convex):

```text
https://<deployment-name>.convex.site/api/auth/callback/google
```

**Set the deployment variables** — from `packages/backend`:

```bash
cd packages/backend
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
bunx convex env set SITE_URL "http://localhost:3001"
bunx convex env set CONVEX_SITE_URL "https://<deployment-name>.convex.site"
bunx convex env set GOOGLE_CLIENT_ID "<google-client-id>"
bunx convex env set GOOGLE_CLIENT_SECRET "<google-client-secret>"
cd ../..
```

### 4. Run, verify, and open a PR

```bash
bun run dev          # start everything; open http://localhost:3001
bun run check-types  # before every PR
bun run build        # before every PR
```

Keep each change focused and follow the existing TypeScript patterns. Then push
your branch and open a pull request against `main` describing what changed and
why, the checks you ran, and screenshots for any visible UI change.
