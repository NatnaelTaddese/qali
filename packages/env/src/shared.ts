import { z } from "zod";

/**
 * A Convex deployment URL that is not the `.env.example` placeholder, so a
 * copied-but-unedited env file fails at startup instead of at first request.
 */
export const convexUrlSchema = (exampleHost: string) =>
  z.url().refine((url) => new URL(url).hostname !== exampleHost, {
    message: `Replace the ${exampleHost} placeholder before running the app`,
  });
