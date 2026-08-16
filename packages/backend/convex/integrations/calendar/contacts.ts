import type { PageCursor, SyncCursor, SyncPage } from "./types";

export type ContactFeed = "contacts" | "other";

export interface ProviderContact {
  readonly id: string;
  readonly deleted: boolean;
  readonly displayName?: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly photoUrl?: string;
  readonly version?: string;
}

/** Optional provider capability kept separate from calendar operations. */
export interface ContactsProviderAdapter {
  listContacts(args: {
    readonly feed: ContactFeed;
    readonly syncCursor: SyncCursor | null;
    readonly pageCursor?: PageCursor | null;
  }): Promise<SyncPage<ProviderContact>>;
}
