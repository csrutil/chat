import type { ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  createMeshCoreAdapter,
  MeshCoreAdapter,
  MeshCoreTcpConnection,
} from "./index";
import type {
  MeshCoreChannel,
  MeshCoreConnection,
  MeshCoreContact,
  MeshCoreSentResponse,
  MeshCoreWaitingMessage,
} from "./types";

const CONTACT_PUBLIC_KEY = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
]);

class FakeConnection implements MeshCoreConnection {
  channel: MeshCoreChannel | null = {
    channelIdx: 0,
    name: "public",
    secret: new Uint8Array(16),
  };
  contact: MeshCoreContact | null = {
    publicKey: CONTACT_PUBLIC_KEY,
    type: 1,
    flags: 0,
    outPathLen: 0,
    outPath: new Uint8Array(64),
    advName: "Alice",
    lastAdvert: 0,
    advLat: 0,
    advLon: 0,
    lastMod: 0,
  };
  waitingMessages: MeshCoreWaitingMessage[] = [];
  channelPosts: Array<{ channelIdx: number; text: string }> = [];
  contactPosts: Array<{ publicKey: Uint8Array; text: string }> = [];
  private msgWaitingHandler: (() => void) | null = null;

  close = vi.fn(async () => undefined);
  connect = vi.fn(async () => undefined);
  deviceQuery = vi.fn(async () => ({
    firmwareBuildDate: "01 Jan 2026",
    firmwareVer: 1,
    firmwareVersion: "test-version",
    manufacturerModel: "test",
    reserved: new Uint8Array(6),
  }));
  syncDeviceTime = vi.fn(async () => undefined);
  sendFloodAdvert = vi.fn(async () => undefined);

  async findContactByPublicKeyPrefix(
    _publicKeyPrefixHex: string
  ): Promise<MeshCoreContact | null> {
    return this.contact;
  }

  async getChannel(_channelIdx: number): Promise<MeshCoreChannel | null> {
    return this.channel;
  }

  async getWaitingMessages(): Promise<MeshCoreWaitingMessage[]> {
    return this.waitingMessages;
  }

  offMsgWaiting(handler: () => void): void {
    if (this.msgWaitingHandler === handler) {
      this.msgWaitingHandler = null;
    }
  }

  onMsgWaiting(handler: () => void): void {
    this.msgWaitingHandler = handler;
  }

  async sendChannelTextMessage(
    channelIdx: number,
    text: string
  ): Promise<void> {
    this.channelPosts.push({ channelIdx, text });
  }

  async sendTextMessage(
    publicKey: Uint8Array,
    text: string
  ): Promise<MeshCoreSentResponse> {
    this.contactPosts.push({ publicKey, text });
    return { result: 0, expectedAckCrc: 1, estTimeout: 2 };
  }

  emitMsgWaiting(): void {
    this.msgWaitingHandler?.();
  }
}

describe("createMeshCoreAdapter", () => {
  it("constructs with an injected connection", () => {
    const adapter = createMeshCoreAdapter({
      autoConnect: false,
      connection: new FakeConnection(),
    });

    expect(adapter).toBeInstanceOf(MeshCoreAdapter);
    expect(adapter.name).toBe("meshcore");
    expect(adapter.persistThreadHistory).toBe(true);
  });

  it("constructs with TCP config", () => {
    const adapter = createMeshCoreAdapter({
      autoConnect: false,
      tcpHost: "127.0.0.1",
      tcpPort: 5000,
    });

    expect(adapter).toBeInstanceOf(MeshCoreAdapter);
    expect(
      (adapter as unknown as { connection: unknown }).connection
    ).toBeInstanceOf(MeshCoreTcpConnection);
  });
});

describe("MeshCoreAdapter thread ids", () => {
  const adapter = createMeshCoreAdapter({
    autoConnect: false,
    connection: new FakeConnection(),
  });

  it("encodes and decodes contact thread ids", () => {
    const threadId = adapter.encodeThreadId({
      type: "contact",
      publicKeyPrefixHex: "010203040506",
    });
    expect(threadId).toBe("meshcore:contact:010203040506");
    expect(adapter.decodeThreadId(threadId)).toEqual({
      type: "contact",
      publicKeyPrefixHex: "010203040506",
    });
  });

  it("encodes and decodes channel thread ids", () => {
    const threadId = adapter.encodeThreadId({ type: "channel", channelIdx: 2 });
    expect(threadId).toBe("meshcore:channel:2");
    expect(adapter.decodeThreadId(threadId)).toEqual({
      type: "channel",
      channelIdx: 2,
    });
  });

  it("rejects malformed thread ids", () => {
    expect(() => adapter.decodeThreadId("meshcore:bad")).toThrow();
    expect(() =>
      adapter.encodeThreadId({
        type: "contact",
        publicKeyPrefixHex: "not hex",
      })
    ).toThrow();
  });
});

describe("MeshCoreAdapter posting", () => {
  it("posts channel messages", async () => {
    const connection = new FakeConnection();
    const adapter = createMeshCoreAdapter({ autoConnect: false, connection });
    const threadId = "meshcore:channel:4";

    const posted = await adapter.postMessage(threadId, "hello channel");

    expect(connection.channelPosts).toEqual([
      { channelIdx: 4, text: "hello channel" },
    ]);
    expect(posted.threadId).toBe(threadId);
    expect(posted.raw).toMatchObject({
      kind: "channel",
      channelIdx: 4,
      text: "hello channel",
    });
  });

  it("posts contact messages", async () => {
    const connection = new FakeConnection();
    const adapter = createMeshCoreAdapter({ autoConnect: false, connection });
    const threadId = "meshcore:contact:010203040506";

    const posted = await adapter.postMessage(threadId, { markdown: "**hi**" });

    expect(connection.contactPosts).toEqual([
      { publicKey: CONTACT_PUBLIC_KEY, text: "**hi**" },
    ]);
    expect(posted.threadId).toBe(threadId);
    expect(posted.raw).toMatchObject({
      kind: "contact",
      pubKeyPrefixHex: "010203040506",
      text: "**hi**",
    });
  });
});

describe("MeshCoreAdapter inbound messages", () => {
  it("normalizes contact messages", () => {
    const adapter = createMeshCoreAdapter({
      autoConnect: false,
      connection: new FakeConnection(),
    });
    const raw = {
      kind: "contact" as const,
      pathLen: 1,
      pubKeyPrefix: CONTACT_PUBLIC_KEY.slice(0, 6),
      pubKeyPrefixHex: "010203040506",
      senderTimestamp: 123,
      text: "hello",
      threadId: "meshcore:contact:010203040506",
      txtType: 0,
    };

    const message = adapter.parseMessage(raw);

    expect(message.id).toContain("contact:123:010203040506");
    expect(message.threadId).toBe(raw.threadId);
    expect(message.author.userId).toBe("010203040506");
    expect(message.metadata.dateSent.toISOString()).toBe(
      "1970-01-01T00:02:03.000Z"
    );
  });

  it("drains waiting messages through ChatInstance", async () => {
    const connection = new FakeConnection();
    connection.waitingMessages = [
      {
        channelMessage: {
          kind: "channel",
          channelIdx: 1,
          pathLen: 0,
          senderTimestamp: 456,
          text: "public",
          txtType: 0,
        },
      },
    ];
    const adapter = createMeshCoreAdapter({ autoConnect: false, connection });
    const processMessage = vi.fn(async () => undefined);
    await adapter.initialize({
      getUserName: () => "meshbot",
      processMessage,
    } as unknown as ChatInstance);

    connection.emitMsgWaiting();
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledOnce());

    expect(processMessage.mock.calls[0]?.[1]).toBe("meshcore:channel:1");
    expect(processMessage.mock.calls[0]?.[2]).toMatchObject({
      text: "public",
      threadId: "meshcore:channel:1",
    });
  });
});
