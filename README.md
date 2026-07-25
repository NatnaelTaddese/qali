# qali

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, Convex, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **Convex** - Reactive backend-as-a-service platform
- **Authentication** - Better-Auth
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

## Convex Setup

This project uses Convex as a backend. You'll need to set up Convex before running the app:

```bash
bun run dev:setup
```

Follow the prompts to create a new Convex project and connect it to your application.

Copy environment variables from `packages/backend/.env.local` to `apps/*/.env`.

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
Your app will connect to the Convex cloud backend automatically.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@qali/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Project Structure

```
qali/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── backend/     # Convex backend functions and schema
```

## Contributing

Contributions are welcome. Follow these steps to set up the project and submit a change.

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun 1.3.14](https://bun.sh/docs/installation)
- A [Convex account](https://dashboard.convex.dev/)
- A Google Cloud project for OAuth, Calendar, and Contacts access

### 1. Fork and clone the repository

Fork the repository on GitHub, then clone your fork and add the original repository as `upstream`:

```bash
git clone https://github.com/<your-github-username>/qali.git
cd qali
git remote add upstream https://github.com/NatnaelTaddese/qali.git
```

### 2. Create a branch

Start from the latest version of `main` and create a focused branch for your change:

```bash
git checkout main
git pull upstream main
git checkout -b feature/short-description
```

Use a descriptive prefix such as `feature/`, `fix/`, or `docs/`.

### 3. Install dependencies

Install all workspace dependencies from the repository root:

```bash
bun install
```

### 4. Configure Convex and environment variables

Connect a development Convex deployment:

```bash
bun run dev:setup
```

Follow the prompts to create or select a Convex project. The command creates `packages/backend/.env.local` with the deployment details.

Create the web app's local environment file:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Replace the placeholder values in `apps/web/.env.local` with your deployment's `.convex.cloud` and `.convex.site` URLs. You can find the deployment name in `packages/backend/.env.local` or the URLs in the Convex dashboard. Never commit `.env` or `.env.local` files.

### 5. Configure Better Auth and Google OAuth

This project uses Better Auth with Google OAuth. Google access is also used to synchronize calendars and contacts, so a basic Google sign-in client without the additional APIs and scopes is not sufficient.

#### Enable the Google APIs

In the [Google Cloud Console](https://console.cloud.google.com/), create or select a project. Open **APIs & Services > Library** and enable:

- **Google Calendar API**
- **People API**

#### Configure the OAuth consent screen

Open **Google Auth Platform > Data Access** and add the scopes requested by the application:

| Scope | Purpose |
| --- | --- |
| `openid` | Identify the signed-in user |
| `https://www.googleapis.com/auth/userinfo.email` | Read the user's email address |
| `https://www.googleapis.com/auth/userinfo.profile` | Read the user's basic profile |
| `https://www.googleapis.com/auth/calendar` | Read and manage calendars and events |
| `https://www.googleapis.com/auth/contacts.readonly` | Read contacts for contact and guest suggestions |

Complete the app information and audience settings. If the app's publishing status is **Testing**, add every Google account that will sign in under **Audience > Test users**. Publishing the app for general use may require Google verification because the application requests access to Calendar and Contacts data.

#### Create the Google OAuth client

Open **APIs & Services > Credentials**, create an **OAuth client ID**, and select **Web application**. Add this authorized redirect URI, replacing `<deployment-name>` with your Convex deployment name:

```text
https://<deployment-name>.convex.site/api/auth/callback/google
```

The callback uses the Convex site URL, not `localhost`, because Better Auth's HTTP routes are hosted by Convex. Copy the generated client ID and client secret.

#### Set the Better Auth deployment variables

From `packages/backend`, set the authentication variables on your Convex development deployment:

```bash
cd packages/backend
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
bunx convex env set SITE_URL "http://localhost:3001"
bunx convex env set CONVEX_SITE_URL "https://<deployment-name>.convex.site"
bunx convex env set GOOGLE_CLIENT_ID "<google-client-id>"
bunx convex env set GOOGLE_CLIENT_SECRET "<google-client-secret>"
cd ../..
```

`BETTER_AUTH_SECRET` encrypts and signs authentication data, `SITE_URL` is the trusted frontend origin, and `CONVEX_SITE_URL` is Better Auth's public base URL. Keep the secret and Google credentials out of Git.

Better Auth requests offline access and displays the consent screen on sign-in so Google returns a refresh token. This allows the Convex backend to continue synchronizing Calendar and Contacts data after the short-lived access token expires.

### 6. Start the development environment

Run the frontend and Convex backend together:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) and verify the app loads. You can also run `bun run dev:web` or `bun run dev:server` when you only need one part of the project.

### 7. Make and verify your changes

Keep each contribution focused and follow the existing TypeScript and project patterns. Before opening a pull request, run:

```bash
bun run check-types
bun run build
```

Also test the affected behavior manually in the development app.

### 8. Commit and push

Write a concise commit message that explains the change, then push your branch to your fork:

```bash
git add .
git commit -m "Add a concise description of the change"
git push origin feature/short-description
```

### 9. Open a pull request

Open a pull request from your branch to this repository's `main` branch. Include:

- A clear summary of what changed and why
- The checks and manual testing you completed
- Screenshots or recordings for visible UI changes
- Links to any related issues

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the Convex backend
- `bun run dev:setup`: Setup and configure your Convex project
- `bun run check-types`: Check TypeScript types across all apps
