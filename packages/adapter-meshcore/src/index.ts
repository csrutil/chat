import { ValidationError } from "@chat-adapter/shared";
import type * as ChatTypes from "chat";
// biome-ignore lint/style/noExportedImports: Konsistent requires importing the Adapter type from "chat" in this entry point. Re-exporting from "chat" doesn't satisfy the rule, so we import + re-export here.
import type { Adapter } from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";
import { MeshCoreFormatConverter } from "./markdown";
import {
  DEFAULT_BAUD_RATE,
  isHex,
  MESHCORE_ADAPTER_NAME,
  shortMessageHash,
} from "./protocol";
import { MeshCoreSerialConnection } from "./serial-connection";
import type {
  MeshCoreAdapterConfig,
  MeshCoreChannelMessage,
  MeshCoreConnection,
  MeshCoreContactMessage,
  MeshCoreRawMessage,
  MeshCoreThreadId,
  MeshCoreWaitingMessage,
} from "./types";

export { MeshCoreFormatConverter } from "./markdown";
export {
  BufferReader,
  BufferWriter,
  MeshCoreFrameCodec,
  parseFrame,
} from "./protocol";
export { MeshCoreSerialConnection } from "./serial-connection";
export type {
  MeshCoreAdapterConfig,
  MeshCoreChannel,
  MeshCoreChannelMessage,
  MeshCoreConnection,
  MeshCoreContact,
  MeshCoreContactMessage,
  MeshCoreDeviceInfo,
  MeshCoreRawMessage,
  MeshCoreSentResponse,
  MeshCoreSerialPortLike,
  MeshCoreThreadId,
  MeshCoreWaitingMessage,
} from "./types";
export type { Adapter };

const CONTACT_THREAD_PATTERN = /^meshcore:contact:([0-9a-f]+)$/i;
const CHANNEL_THREAD_PATTERN = /^meshcore:channel:(\d+)$/;

export class MeshCoreAdapter
  implements Adapter<MeshCoreThreadId, MeshCoreRawMessage>
{
  readonly name = MESHCORE_ADAPTER_NAME;
  readonly persistThreadHistory = true;
  readonly lockScope = "thread" as const;

  protected chat: ChatTypes.ChatInstance | null = null;
  protected readonly connection: MeshCoreConnection;
  protected readonly formatConverter = new MeshCoreFormatConverter();
  protected readonly logger: ChatTypes.Logger;
  protected readonly hasExplicitUserName: boolean;
  protected readonly autoConnect: boolean;
  protected readonly shouldSyncDeviceTime: boolean;
  protected readonly shouldSendFloodAdvertOnConnect: boolean;
  protected _userName: string;
  private drainingMessages = false;

  get userName(): string {
    return this._userName;
  }

  constructor(config: MeshCoreAdapterConfig = {}) {
    this.autoConnect = config.autoConnect ?? true;
    this.shouldSyncDeviceTime = config.syncDeviceTime ?? true;
    this.shouldSendFloodAdvertOnConnect =
      config.sendFloodAdvertOnConnect ?? true;
    this.logger =
      config.logger ?? new ConsoleLogger("info").child(MESHCORE_ADAPTER_NAME);
    this._userName = config.userName ?? "bot";
    this.hasExplicitUserName = Boolean(config.userName);

    if (config.connection) {
      this.connection = config.connection;
      return;
    }

    const serialPort = config.serialPort ?? process.env.MESHCORE_SERIAL_PORT;
    if (!serialPort) {
      throw new ValidationError(
        MESHCORE_ADAPTER_NAME,
        "serialPort is required. Set MESHCORE_SERIAL_PORT or provide it in config."
      );
    }

    this.connection = new MeshCoreSerialConnection({
      baudRate: config.baudRate ?? DEFAULT_BAUD_RATE,
      logger: this.logger,
      serialPort,
    });
  }

  async initialize(chat: ChatTypes.ChatInstance): Promise<void> {
    this.chat = chat;
    if (!this.hasExplicitUserName) {
      this._userName = chat.getUserName();
    }

    this.connection.onMsgWaiting(this.handleMsgWaiting);

    if (!this.autoConnect) {
      this.logger.info("MeshCore adapter initialized without auto-connect");
      return;
    }

    await this.connection.connect();

    try {
      const deviceInfo = await this.connection.deviceQuery();
      this.logger.info("MeshCore device connected", {
        firmwareBuildDate: deviceInfo.firmwareBuildDate,
        firmwareVer: deviceInfo.firmwareVer,
        firmwareVersion: deviceInfo.firmwareVersion,
        manufacturerModel: deviceInfo.manufacturerModel,
      });
    } catch (error) {
      this.logger.warn("MeshCore device query failed", { error });
    }

    if (this.shouldSyncDeviceTime) {
      await this.connection.syncDeviceTime();
    }

    if (this.shouldSendFloodAdvertOnConnect) {
      await this.connection.sendFloodAdvert();
    }

    await this.drainWaitingMessages();
  }

  async disconnect(): Promise<void> {
    this.connection.offMsgWaiting(this.handleMsgWaiting);
    await this.connection.close();
  }

  handleWebhook(
    _request: Request,
    _options?: ChatTypes.WebhookOptions
  ): Promise<Response> {
    return Promise.resolve(
      new Response("MeshCore adapter does not support webhooks", {
        status: 404,
      })
    );
  }

  encodeThreadId(platformData: MeshCoreThreadId): string {
    if (platformData.type === "contact") {
      const prefix = platformData.publicKeyPrefixHex.toLowerCase();
      if (!isHex(prefix)) {
        throw new ValidationError(
          MESHCORE_ADAPTER_NAME,
          `Invalid MeshCore contact public key prefix: ${prefix}`
        );
      }
      return `${MESHCORE_ADAPTER_NAME}:contact:${prefix}`;
    }

    if (
      !Number.isInteger(platformData.channelIdx) ||
      platformData.channelIdx < 0
    ) {
      throw new ValidationError(
        MESHCORE_ADAPTER_NAME,
        `Invalid MeshCore channel index: ${platformData.channelIdx}`
      );
    }
    return `${MESHCORE_ADAPTER_NAME}:channel:${platformData.channelIdx}`;
  }

  decodeThreadId(threadId: string): MeshCoreThreadId {
    const contactMatch = threadId.match(CONTACT_THREAD_PATTERN);
    if (contactMatch?.[1]) {
      return {
        type: "contact",
        publicKeyPrefixHex: contactMatch[1].toLowerCase(),
      };
    }

    const channelMatch = threadId.match(CHANNEL_THREAD_PATTERN);
    if (channelMatch?.[1]) {
      return { type: "channel", channelIdx: Number(channelMatch[1]) };
    }

    throw new ValidationError(
      MESHCORE_ADAPTER_NAME,
      `Invalid MeshCore thread id: ${threadId}`
    );
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).type === "contact";
  }

  renderFormatted(content: ChatTypes.FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  parseMessage(raw: MeshCoreRawMessage): Message<MeshCoreRawMessage> {
    return this.messageFromRaw(raw);
  }

  async postMessage(
    threadId: string,
    message: ChatTypes.AdapterPostableMessage
  ): Promise<ChatTypes.RawMessage<MeshCoreRawMessage>> {
    const text = this.formatConverter.renderPostable(message);
    if (!text) {
      throw new ValidationError(
        MESHCORE_ADAPTER_NAME,
        "MeshCore messages cannot be empty"
      );
    }

    const thread = this.decodeThreadId(threadId);
    const senderTimestamp = Math.floor(Date.now() / 1000);

    if (thread.type === "contact") {
      const contact = await this.connection.findContactByPublicKeyPrefix(
        thread.publicKeyPrefixHex
      );
      if (!contact) {
        throw new ValidationError(
          MESHCORE_ADAPTER_NAME,
          `MeshCore contact not found for public key prefix: ${thread.publicKeyPrefixHex}`
        );
      }

      await this.connection.sendTextMessage(contact.publicKey, text);
      const raw: MeshCoreContactMessage = {
        kind: "contact",
        pathLen: 0,
        pubKeyPrefix: contact.publicKey.slice(0, 6),
        pubKeyPrefixHex: thread.publicKeyPrefixHex,
        senderTimestamp,
        text,
        threadId,
        txtType: 0,
      };
      return { id: messageIdFor(raw), raw, threadId };
    }

    await this.connection.sendChannelTextMessage(thread.channelIdx, text);
    const raw: MeshCoreChannelMessage = {
      kind: "channel",
      channelIdx: thread.channelIdx,
      pathLen: 0,
      senderTimestamp,
      text,
      threadId,
      txtType: 0,
    };
    return { id: messageIdFor(raw), raw, threadId };
  }

  fetchMessages(
    _threadId: string,
    _options?: ChatTypes.FetchOptions
  ): Promise<ChatTypes.FetchResult<MeshCoreRawMessage>> {
    return Promise.resolve({ messages: [] });
  }

  async fetchThread(threadId: string): Promise<ChatTypes.ThreadInfo> {
    const decoded = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: decoded.type === "contact",
      metadata: decoded,
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChatTypes.ChannelInfo> {
    const decoded = this.decodeThreadId(channelId);
    if (decoded.type === "contact") {
      return {
        id: channelId,
        isDM: true,
        metadata: decoded,
        name: decoded.publicKeyPrefixHex,
      };
    }

    const channel = await this.connection.getChannel(decoded.channelIdx);
    return {
      id: channelId,
      isDM: false,
      metadata: {
        channelIdx: decoded.channelIdx,
      },
      name: channel?.name || `channel-${decoded.channelIdx}`,
    };
  }

  async getUser(userId: string): Promise<ChatTypes.UserInfo | null> {
    if (!isHex(userId)) {
      return null;
    }

    const contact = await this.connection.findContactByPublicKeyPrefix(userId);
    if (!contact) {
      return null;
    }

    const userName = contact.advName || userId;
    return {
      email: undefined,
      fullName: userName,
      isBot: false,
      userId,
      userName,
    };
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: ChatTypes.AdapterPostableMessage
  ): Promise<ChatTypes.RawMessage<MeshCoreRawMessage>> {
    throw new NotImplementedError(
      "MeshCoreAdapter.editMessage is not supported."
    );
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "MeshCoreAdapter.deleteMessage is not supported."
    );
  }

  addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: ChatTypes.EmojiValue | string
  ): Promise<void> {
    throw new NotImplementedError(
      "MeshCoreAdapter.addReaction is not supported."
    );
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: ChatTypes.EmojiValue | string
  ): Promise<void> {
    throw new NotImplementedError(
      "MeshCoreAdapter.removeReaction is not supported."
    );
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    return Promise.resolve();
  }

  private readonly handleMsgWaiting = (): void => {
    this.drainWaitingMessages().catch((error) => {
      this.logger.warn("Failed to drain MeshCore waiting messages", { error });
    });
  };

  private async drainWaitingMessages(): Promise<void> {
    if (!(this.chat && !this.drainingMessages)) {
      return;
    }

    this.drainingMessages = true;
    try {
      const waitingMessages = await this.connection.getWaitingMessages();
      for (const waitingMessage of waitingMessages) {
        const raw = this.rawMessageFromWaiting(waitingMessage);
        if (!raw) {
          continue;
        }
        const parsedMessage = this.messageFromRaw(raw);
        await this.chat.processMessage(this, raw.threadId, parsedMessage);
      }
    } finally {
      this.drainingMessages = false;
    }
  }

  private rawMessageFromWaiting(
    waitingMessage: MeshCoreWaitingMessage
  ): MeshCoreRawMessage | null {
    if ("contactMessage" in waitingMessage) {
      const threadId = this.encodeThreadId({
        type: "contact",
        publicKeyPrefixHex: waitingMessage.contactMessage.pubKeyPrefixHex,
      });
      return { ...waitingMessage.contactMessage, threadId };
    }

    if ("channelMessage" in waitingMessage) {
      const threadId = this.encodeThreadId({
        type: "channel",
        channelIdx: waitingMessage.channelMessage.channelIdx,
      });
      return { ...waitingMessage.channelMessage, threadId };
    }

    return null;
  }

  private messageFromRaw(raw: MeshCoreRawMessage): Message<MeshCoreRawMessage> {
    return new Message<MeshCoreRawMessage>({
      id: messageIdFor(raw),
      threadId: raw.threadId,
      text: raw.text,
      formatted: this.formatConverter.toAst(raw.text),
      raw,
      author: authorForRaw(raw),
      metadata: {
        dateSent: new Date(raw.senderTimestamp * 1000),
        edited: false,
      },
      attachments: [],
    });
  }
}

export function createMeshCoreAdapter(
  config: MeshCoreAdapterConfig = {}
): MeshCoreAdapter {
  return new MeshCoreAdapter(config);
}

function messageIdFor(raw: MeshCoreRawMessage): string {
  if (raw.kind === "contact") {
    return `contact:${raw.senderTimestamp}:${raw.pubKeyPrefixHex}:${shortMessageHash(raw.text)}`;
  }
  return `channel:${raw.senderTimestamp}:${raw.channelIdx}:${shortMessageHash(raw.text)}`;
}

function authorForRaw(raw: MeshCoreRawMessage): {
  fullName: string;
  isBot: false;
  isMe: false;
  userId: string;
  userName: string;
} {
  if (raw.kind === "contact") {
    return {
      userId: raw.pubKeyPrefixHex,
      userName: raw.pubKeyPrefixHex,
      fullName: raw.pubKeyPrefixHex,
      isBot: false,
      isMe: false,
    };
  }

  const channelAuthor = `channel-${raw.channelIdx}`;
  return {
    userId: channelAuthor,
    userName: channelAuthor,
    fullName: channelAuthor,
    isBot: false,
    isMe: false,
  };
}
