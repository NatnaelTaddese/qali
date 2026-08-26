import type {
  ContactFeed,
  ContactsProviderAdapter,
  ProviderContact,
} from "../calendar/contacts";
import type {
  PageCursor,
  SyncCursor,
  SyncPage,
} from "../calendar/types";
import {
  fetchContactsPage,
  fetchOtherContactsPage,
  type MappedContact,
} from "./client";
import {
  decodePageCursor,
  decodeSyncCursor,
  encodePageCursor,
  encodeSyncCursor,
  toProviderError,
} from "./mappers";

function toContact(contact: MappedContact): ProviderContact {
  return {
    id: contact.resourceName,
    deleted: contact.deleted,
    displayName: contact.displayName,
    emails: contact.emails,
    phones: contact.phones,
    photoUrl: contact.photoUrl,
    version: contact.googleEtag,
  };
}

export class GoogleContactsAdapter implements ContactsProviderAdapter {
  constructor(private readonly accessToken: string) {}

  async listContacts(args: {
    feed: ContactFeed;
    syncCursor: SyncCursor | null;
    pageCursor?: PageCursor | null;
  }): Promise<SyncPage<ProviderContact>> {
    try {
      const fetchPage =
        args.feed === "contacts" ? fetchContactsPage : fetchOtherContactsPage;
      const page = await fetchPage(this.accessToken, {
        syncToken: args.syncCursor
          ? decodeSyncCursor(args.syncCursor)
          : undefined,
        pageToken: args.pageCursor
          ? decodePageCursor(args.pageCursor)
          : undefined,
        requestSyncToken: args.syncCursor ? undefined : true,
      });
      return {
        items: page.contacts.map(toContact),
        nextPageCursor: page.nextPageToken
          ? encodePageCursor(page.nextPageToken)
          : null,
        commitCursor: page.nextSyncToken
          ? encodeSyncCursor(page.nextSyncToken)
          : null,
      };
    } catch (error) {
      throw toProviderError(error, "sync");
    }
  }
}
