import { data, type Transport } from "../http";
import type {
  GetApiContactsContactPhoneNumberResponse,
  GetApiContactsResponse,
  GetApiGroupsGroupJidMetadataResponse,
  GetApiGroupsGroupJidParticipantsResponse,
  GetApiGroupsResponse,
  GetApiLidFromPnPnResponse,
  GetApiOnWhatsappContactIdentifierResponse,
  GetApiPnFromLidLidResponse,
  PostApiGroupsBody,
  PostApiGroupsGroupJidParticipantsAddResponse,
  PostApiGroupsResponse,
} from "../types.gen";

/**
 * `?paginated=true` returns a different shape from the default flat array, so the two are
 * separate methods rather than one with a flag. A caller cannot then read `data` and silently
 * get `undefined`.
 */
export type Page<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

/** Resolving between phone numbers and LIDs. */
class LidResolver {
  constructor(private readonly http: Transport) {}

  /**
   * The LID for a phone number.
   *
   * WhatsApp increasingly addresses users by LID rather than number, and the two are **not**
   * derivable from one another — never guess one from the other.
   */
  async fromPhone(phoneNumber: string): Promise<string> {
    const body = await this.http.request<GetApiLidFromPnPnResponse>(
      "GET",
      `/api/lid-from-pn/${encodeURIComponent(phoneNumber)}`,
    );
    return body.data.lid;
  }

  /**
   * The phone number behind a LID, where known.
   *
   * Returns `null` on a `404`, which is a normal outcome rather than an error to retry: not
   * every LID has a mapping we have seen.
   */
  async toPhone(lid: string): Promise<string | null> {
    try {
      const body = await this.http.request<GetApiPnFromLidLidResponse>(
        "GET",
        `/api/pn-from-lid/${encodeURIComponent(lid)}`,
      );
      return body.data.pn;
    } catch (err) {
      if (err instanceof Error && "status" in err && err.status === 404) return null;
      throw err;
    }
  }
}

/** Contacts known to this session. */
export class ContactsResource {
  readonly lid: LidResolver;

  constructor(private readonly http: Transport) {
    this.lid = new LidResolver(http);
  }

  /**
   * Every contact, as a flat array.
   *
   * `imgUrl` and `status` are always null in a list — a picture and an "about" string are
   * per-contact fetches against WhatsApp, and a list call does not make N of them.
   */
  async list() {
    const body = await this.http.request<GetApiContactsResponse>("GET", "/api/contacts");
    return (body as { data: unknown }).data as Extract<
      GetApiContactsResponse["data"],
      unknown[]
    >;
  }

  /** One page of contacts. `limit` defaults to 20 server-side and caps at 500. */
  async page(options: { page?: number; limit?: number } = {}) {
    const body = await this.http.request<{ data: Page<Awaited<ReturnType<ContactsResource["list"]>>[number]> }>(
      "GET",
      "/api/contacts",
      { query: { limit: options.limit ?? 20, page: options.page ?? 1, paginated: true } },
    );
    return data(body);
  }

  /** One contact. Note this shape is keyed on `id`, where the list is keyed on `jid`. */
  async get(phoneNumber: string) {
    return data(
      await this.http.request<GetApiContactsContactPhoneNumberResponse>(
        "GET",
        `/api/contacts/${encodeURIComponent(phoneNumber)}`,
      ),
    );
  }

  /** Whether a number is registered on WhatsApp. */
  async onWhatsApp(identifier: string) {
    return data(
      await this.http.request<GetApiOnWhatsappContactIdentifierResponse>(
        "GET",
        `/api/on-whatsapp/${encodeURIComponent(identifier)}`,
      ),
    );
  }
}

/**
 * Adding and removing group participants.
 *
 * These act on real people in a real chat and are not undoable — a removal is visible to
 * everyone in the group.
 */
class GroupParticipants {
  constructor(private readonly http: Transport) {}

  /** Add participants. Returns a per-JID result; some may fail while others succeed. */
  async add(groupJid: string, participants: string[]) {
    return data(
      await this.http.request<PostApiGroupsGroupJidParticipantsAddResponse>(
        "POST",
        `/api/groups/${encodeURIComponent(groupJid)}/participants/add`,
        { body: { participants } },
      ),
    );
  }

  /** Remove participants. Same per-JID result shape as `add`. */
  async remove(groupJid: string, participants: string[]) {
    return data(
      await this.http.request<PostApiGroupsGroupJidParticipantsAddResponse>(
        "POST",
        `/api/groups/${encodeURIComponent(groupJid)}/participants/remove`,
        { body: { participants } },
      ),
    );
  }

  /** The participants of a group. This shape is keyed on `id`, unlike the metadata route. */
  async list(groupJid: string) {
    return data(
      await this.http.request<GetApiGroupsGroupJidParticipantsResponse>(
        "GET",
        `/api/groups/${encodeURIComponent(groupJid)}/participants`,
      ),
    );
  }
}

/** Groups this session belongs to. */
export class GroupsResource {
  readonly participants: GroupParticipants;

  constructor(private readonly http: Transport) {
    this.participants = new GroupParticipants(http);
  }

  /** Every group, as a flat array. */
  async list() {
    const body = await this.http.request<GetApiGroupsResponse>("GET", "/api/groups");
    return (body as { data: unknown }).data as Extract<GetApiGroupsResponse["data"], unknown[]>;
  }

  /** One page of groups. */
  async page(options: { page?: number; limit?: number } = {}) {
    const body = await this.http.request<{ data: Page<Awaited<ReturnType<GroupsResource["list"]>>[number]> }>(
      "GET",
      "/api/groups",
      { query: { limit: options.limit ?? 20, page: options.page ?? 1, paginated: true } },
    );
    return data(body);
  }

  /** Create a group. */
  async create(input: PostApiGroupsBody) {
    return data(
      await this.http.request<PostApiGroupsResponse>("POST", "/api/groups", { body: input }),
    );
  }

  /** Subject, description, owner and participants. Keyed on `jid`. */
  async metadata(groupJid: string) {
    return data(
      await this.http.request<GetApiGroupsGroupJidMetadataResponse>(
        "GET",
        `/api/groups/${encodeURIComponent(groupJid)}/metadata`,
      ),
    );
  }
}
