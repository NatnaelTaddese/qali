# Contributing to qali

Contributions are welcome.

**Prerequisites:** [Git](https://git-scm.com/), [Bun 1.3.14](https://bun.sh/docs/installation),
a [Convex account](https://dashboard.convex.dev/), and a Google Cloud project.

## 1. Fork, clone, and branch

```bash
git clone https://github.com/<your-github-username>/qali.git
cd qali
git remote add upstream https://github.com/NatnaelTaddese/qali.git
git checkout -b feature/short-description   # use feature/, fix/, or docs/
```

## 2. Install and connect Convex

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

## 3. Configure Google OAuth

qali signs in with Google and syncs Calendar and Contacts, so a plain sign-in
client isn't enough — you need the APIs and scopes below. Beyond your saved
contacts, qali also enriches guests from Google's auto-collected "Other contacts"
(for avatars) and from the attendees on your own calendar events.

**Enable APIs** — in the [Google Cloud Console](https://console.cloud.google.com/),
open **APIs & Services > Library** and enable the **Google Calendar API** and
the **People API** (the People API also serves Other Contacts — nothing extra to
enable).

**Add scopes** — under **Google Auth Platform > Data Access**, add:

| Scope | Purpose |
| --- | --- |
| `openid` | Identify the signed-in user |
| `.../auth/userinfo.email` | Read the user's email |
| `.../auth/userinfo.profile` | Read the user's basic profile |
| `.../auth/calendar` | Read and manage calendars and events |
| `.../auth/contacts.readonly` | Read saved contacts for guest suggestions |
| `.../auth/contacts.other.readonly` | Read auto-saved "Other contacts" for names + avatars |

While publishing status is **Testing**, add every account that will sign in
under **Audience > Test users**. Existing users must sign out and back in after a
scope change to re-consent, or the new Other Contacts sync returns a 403.

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

## 4. Configure the AI assistant (optional)

qali's calendar assistant runs on [DeepSeek](https://platform.deepseek.com/).
It is entirely optional: with no key set, the assistant's entry point is hidden
and every other feature works exactly as it does without it.

```bash
cd packages/backend
bunx convex env set DEEPSEEK_API_KEY "<deepseek-api-key>"
cd ../..
```

The assistant never writes to your calendar on its own — it proposes a change
and waits for you to confirm it in the dock.

## 5. Run, verify, and open a PR

```bash
bun run dev          # start everything; open http://localhost:3001
bun run check-types  # before every PR
bun run build        # before every PR
```

Keep each change focused and follow the existing TypeScript patterns. Then push
your branch and open a pull request against `main` describing what changed and
why, the checks you ran, and screenshots for any visible UI change.
