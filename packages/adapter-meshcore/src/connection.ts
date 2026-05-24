import { EventEmitter } from "node:events";
import type { Logger } from "chat";
import {
  commandDeviceQuery,
  commandGetChannel,
  commandGetContacts,
  commandSendChannelTextMessage,
  commandSendFloodAdvert,
  commandSendTextMessage,
  commandSetDeviceTime,
  commandSyncNextMessage,
  DEFAULT_COMMAND_TIMEOUT_MS,
  hexToBytes,
  MeshCoreFrameCodec,
  type MeshCoreParsedFrame,
  parseFrame,
  ResponseCodes,
} from "./protocol";
import type {
  MeshCoreChannel,
  MeshCoreConnection,
  MeshCoreContact,
  MeshCoreDeviceInfo,
  MeshCoreSentResponse,
  MeshCoreWaitingMessage,
} from "./types";

const RESPONSE_EVENT = (code: number): string => `response:${code}`;
const PUSH_MSG_WAITING_EVENT = "push:msgWaiting";

interface MeshCoreFramedConnectionOptions {
  commandTimeoutMs?: number;
  logger?: Logger;
}

export abstract class MeshCoreFramedConnection implements MeshCoreConnection {
  private readonly codec = new MeshCoreFrameCodec();
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly commandTimeoutMs: number;
  private readonly emitter = new EventEmitter();
  protected readonly logger?: Logger;

  protected constructor(options: MeshCoreFramedConnectionOptions = {}) {
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logger = options.logger;
  }

  abstract close(): Promise<void>;
  abstract connect(): Promise<void>;
  protected abstract writeFrame(frame: Uint8Array): Promise<void>;

  onMsgWaiting(handler: () => void): void {
    this.emitter.on(PUSH_MSG_WAITING_EVENT, handler);
  }

  offMsgWaiting(handler: () => void): void {
    this.emitter.off(PUSH_MSG_WAITING_EVENT, handler);
  }

  async deviceQuery(): Promise<MeshCoreDeviceInfo> {
    return this.runCommand(async () => {
      const response = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.DeviceInfo
      );
      await this.writeCommand(commandDeviceQuery());
      const frame = await response;
      if (frame.type !== "deviceInfo") {
        throw new Error("Unexpected MeshCore device query response");
      }
      return frame.deviceInfo;
    });
  }

  async syncDeviceTime(): Promise<void> {
    return this.expectOk(commandSetDeviceTime(Math.floor(Date.now() / 1000)));
  }

  async sendFloodAdvert(): Promise<void> {
    return this.expectOk(commandSendFloodAdvert());
  }

  async getWaitingMessages(): Promise<MeshCoreWaitingMessage[]> {
    const messages: MeshCoreWaitingMessage[] = [];
    while (true) {
      const message = await this.syncNextMessage();
      if (!message) {
        break;
      }
      messages.push(message);
    }
    return messages;
  }

  async findContactByPublicKeyPrefix(
    publicKeyPrefixHex: string
  ): Promise<MeshCoreContact | null> {
    const prefix = hexToBytes(publicKeyPrefixHex);
    const contacts = await this.getContacts();
    return (
      contacts.find((contact) => startsWithBytes(contact.publicKey, prefix)) ??
      null
    );
  }

  async getChannel(channelIdx: number): Promise<MeshCoreChannel | null> {
    return this.runCommand(async () => {
      const channelInfo = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.ChannelInfo
      );
      const error = this.waitForError();
      await this.writeCommand(commandGetChannel(channelIdx));
      const frame = await Promise.race([channelInfo, error]);
      if (frame.type === "err") {
        return null;
      }
      if (frame.type !== "channelInfo") {
        throw new Error("Unexpected MeshCore channel response");
      }
      return frame.channel;
    });
  }

  async sendTextMessage(
    contactPublicKey: Uint8Array,
    text: string
  ): Promise<MeshCoreSentResponse> {
    return this.runCommand(async () => {
      const sent = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.Sent
      );
      const error = this.waitForError();
      await this.writeCommand(commandSendTextMessage(contactPublicKey, text));
      const frame = await Promise.race([sent, error]);
      if (frame.type === "err") {
        throw new Error(`MeshCore send failed: ${frame.errCode ?? "unknown"}`);
      }
      if (frame.type !== "sent") {
        throw new Error("Unexpected MeshCore sent response");
      }
      return frame.sent;
    });
  }

  async sendChannelTextMessage(
    channelIdx: number,
    text: string
  ): Promise<void> {
    return this.expectOk(commandSendChannelTextMessage(channelIdx, text));
  }

  protected onDataReceived(data: Uint8Array): void {
    for (const frame of this.codec.push(data)) {
      const parsed = parseFrame(frame);
      this.emitParsedFrame(parsed);
    }
  }

  private async getContacts(): Promise<MeshCoreContact[]> {
    return this.runCommand(async () => {
      const contacts: MeshCoreContact[] = [];
      const onContact = (frame: MeshCoreParsedFrame): void => {
        if (frame.type === "contact") {
          contacts.push(frame.contact);
        }
      };

      this.emitter.on(RESPONSE_EVENT(ResponseCodes.Contact), onContact);
      try {
        const done = this.waitForResponse<MeshCoreParsedFrame>(
          ResponseCodes.EndOfContacts
        );
        const error = this.waitForError();
        await this.writeCommand(commandGetContacts());
        const frame = await Promise.race([done, error]);
        if (frame.type === "err") {
          throw new Error(
            `MeshCore contacts request failed: ${frame.errCode ?? "unknown"}`
          );
        }
        return contacts;
      } finally {
        this.emitter.off(RESPONSE_EVENT(ResponseCodes.Contact), onContact);
      }
    });
  }

  private async syncNextMessage(): Promise<MeshCoreWaitingMessage | null> {
    return this.runCommand(async () => {
      const contact = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.ContactMsgRecv
      );
      const channel = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.ChannelMsgRecv
      );
      const done = this.waitForResponse<MeshCoreParsedFrame>(
        ResponseCodes.NoMoreMessages
      );
      const error = this.waitForError();

      await this.writeCommand(commandSyncNextMessage());
      const frame = await Promise.race([contact, channel, done, error]);

      if (frame.type === "err") {
        throw new Error(
          `MeshCore message sync failed: ${frame.errCode ?? "unknown"}`
        );
      }
      if (frame.type === "noMoreMessages") {
        return null;
      }
      if (frame.type === "contactMessage") {
        return { contactMessage: frame.message };
      }
      if (frame.type === "channelMessage") {
        return { channelMessage: frame.message };
      }

      throw new Error("Unexpected MeshCore message sync response");
    });
  }

  private async expectOk(command: Uint8Array): Promise<void> {
    return this.runCommand(async () => {
      const ok = this.waitForResponse<MeshCoreParsedFrame>(ResponseCodes.Ok);
      const error = this.waitForError();
      await this.writeCommand(command);
      const frame = await Promise.race([ok, error]);
      if (frame.type === "err") {
        throw new Error(
          `MeshCore command failed: ${frame.errCode ?? "unknown"}`
        );
      }
    });
  }

  private async writeCommand(command: Uint8Array): Promise<void> {
    await this.writeFrame(MeshCoreFrameCodec.encodeOutgoingFrame(command));
  }

  private waitForResponse<T extends MeshCoreParsedFrame>(
    code: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const eventName = RESPONSE_EVENT(code);
      const timer = setTimeout(() => {
        this.emitter.off(eventName, onResponse);
        reject(new Error(`Timed out waiting for MeshCore response ${code}`));
      }, this.commandTimeoutMs);

      const onResponse = (frame: T): void => {
        clearTimeout(timer);
        this.emitter.off(eventName, onResponse);
        resolve(frame);
      };

      this.emitter.on(eventName, onResponse);
    });
  }

  private waitForError(): Promise<MeshCoreParsedFrame & { type: "err" }> {
    return this.waitForResponse<MeshCoreParsedFrame & { type: "err" }>(
      ResponseCodes.Err
    );
  }

  private runCommand<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.commandQueue;
    let release: () => void = () => {};
    this.commandQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(release);
  }

  private emitParsedFrame(frame: MeshCoreParsedFrame): void {
    if (frame.type === "msgWaiting") {
      this.emitter.emit(PUSH_MSG_WAITING_EVENT);
      return;
    }

    this.emitter.emit(RESPONSE_EVENT(frame.code), frame);

    if (frame.type === "unknown") {
      this.logger?.debug("Ignoring unsupported MeshCore frame", {
        code: frame.code,
      });
    }
  }
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  for (const [index, byte] of prefix.entries()) {
    if (value[index] !== byte) {
      return false;
    }
  }
  return true;
}
