import { createHash } from "node:crypto";
import type {
  MeshCoreChannel,
  MeshCoreChannelMessage,
  MeshCoreContact,
  MeshCoreContactMessage,
  MeshCoreDeviceInfo,
  MeshCoreSentResponse,
} from "./types";

export const MESHCORE_ADAPTER_NAME = "meshcore";
export const DEFAULT_BAUD_RATE = 115_200;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SUPPORTED_COMPANION_PROTOCOL_VERSION = 1;

export const SerialFrameTypes = {
  Incoming: 0x3e,
  Outgoing: 0x3c,
} as const;

const CommandCodes = {
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
  SyncNextMessage: 10,
  DeviceQuery: 22,
  GetChannel: 31,
} as const;

export const ResponseCodes = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  NoMoreMessages: 10,
  DeviceInfo: 13,
  ChannelInfo: 18,
} as const;

const PushCodes = {
  MsgWaiting: 0x83,
} as const;

const SelfAdvertTypes = {
  Flood: 1,
} as const;

const TxtTypes = {
  Plain: 0,
} as const;

const FRAME_HEADER_LENGTH = 3;
const HEX_PATTERN = /^[0-9a-f]+$/i;

export type MeshCoreParsedFrame =
  | { code: typeof ResponseCodes.Ok; type: "ok" }
  | { code: typeof ResponseCodes.Err; errCode: number | null; type: "err" }
  | {
      code: typeof ResponseCodes.Contact;
      contact: MeshCoreContact;
      type: "contact";
    }
  | {
      code: typeof ResponseCodes.EndOfContacts;
      mostRecentLastmod: number;
      type: "endOfContacts";
    }
  | {
      code: typeof ResponseCodes.Sent;
      sent: MeshCoreSentResponse;
      type: "sent";
    }
  | {
      code: typeof ResponseCodes.ContactMsgRecv;
      message: Omit<MeshCoreContactMessage, "threadId">;
      type: "contactMessage";
    }
  | {
      code: typeof ResponseCodes.ChannelMsgRecv;
      message: Omit<MeshCoreChannelMessage, "threadId">;
      type: "channelMessage";
    }
  | { code: typeof ResponseCodes.NoMoreMessages; type: "noMoreMessages" }
  | {
      code: typeof ResponseCodes.DeviceInfo;
      deviceInfo: MeshCoreDeviceInfo;
      type: "deviceInfo";
    }
  | {
      channel: MeshCoreChannel;
      code: typeof ResponseCodes.ChannelInfo;
      type: "channelInfo";
    }
  | { code: typeof PushCodes.MsgWaiting; type: "msgWaiting" }
  | { code: number; raw: Uint8Array; type: "unknown" };

export class BufferReader {
  private pointer = 0;
  private readonly buffer: Uint8Array;

  constructor(data: Uint8Array | number[]) {
    this.buffer = new Uint8Array(data);
  }

  getRemainingBytesCount(): number {
    return this.buffer.length - this.pointer;
  }

  readByte(): number {
    return this.readBytes(1)[0] ?? 0;
  }

  readBytes(count: number): Uint8Array {
    const data = this.buffer.slice(this.pointer, this.pointer + count);
    this.pointer += count;
    return data;
  }

  readRemainingBytes(): Uint8Array {
    return this.readBytes(this.getRemainingBytesCount());
  }

  readString(): string {
    return new TextDecoder().decode(this.readRemainingBytes());
  }

  readCString(maxLength: number): string {
    const bytes = this.readBytes(maxLength);
    const terminator = bytes.indexOf(0);
    return new TextDecoder().decode(
      terminator === -1 ? bytes : bytes.slice(0, terminator)
    );
  }

  readInt8(): number {
    return new DataView(this.readBytes(1).buffer).getInt8(0);
  }

  readUInt8(): number {
    return new DataView(this.readBytes(1).buffer).getUint8(0);
  }

  readUInt16LE(): number {
    return new DataView(this.readBytes(2).buffer).getUint16(0, true);
  }

  readUInt32LE(): number {
    return new DataView(this.readBytes(4).buffer).getUint32(0, true);
  }

  readInt32LE(): number {
    return new DataView(this.readBytes(4).buffer).getInt32(0, true);
  }
}

export class BufferWriter {
  private readonly buffer: number[] = [];

  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  writeByte(byte: number): void {
    this.buffer.push(((byte % 256) + 256) % 256);
  }

  writeBytes(bytes: Uint8Array | number[]): void {
    for (const byte of bytes) {
      this.writeByte(byte);
    }
  }

  writeUInt16LE(num: number): void {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, num, true);
    this.writeBytes(bytes);
  }

  writeUInt32LE(num: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, num, true);
    this.writeBytes(bytes);
  }

  writeString(value: string): void {
    this.writeBytes(new TextEncoder().encode(value));
  }
}

export class MeshCoreFrameCodec {
  private readBuffer: number[] = [];

  static encodeOutgoingFrame(frameData: Uint8Array): Uint8Array {
    const writer = new BufferWriter();
    writer.writeByte(SerialFrameTypes.Outgoing);
    writer.writeUInt16LE(frameData.length);
    writer.writeBytes(frameData);
    return writer.toBytes();
  }

  push(data: Uint8Array): Uint8Array[] {
    this.readBuffer.push(...data);
    const frames: Uint8Array[] = [];

    while (this.readBuffer.length >= FRAME_HEADER_LENGTH) {
      const frameType = this.readBuffer[0];
      if (
        frameType !== SerialFrameTypes.Incoming &&
        frameType !== SerialFrameTypes.Outgoing
      ) {
        this.readBuffer = this.readBuffer.slice(1);
        continue;
      }

      const frameLength =
        (this.readBuffer[1] ?? 0) + (this.readBuffer[2] ?? 0) * 256;
      if (frameLength === 0) {
        this.readBuffer = this.readBuffer.slice(1);
        continue;
      }

      const requiredLength = FRAME_HEADER_LENGTH + frameLength;
      if (this.readBuffer.length < requiredLength) {
        break;
      }

      frames.push(
        new Uint8Array(
          this.readBuffer.slice(FRAME_HEADER_LENGTH, requiredLength)
        )
      );
      this.readBuffer = this.readBuffer.slice(requiredLength);
    }

    return frames;
  }
}

export function parseFrame(frame: Uint8Array): MeshCoreParsedFrame {
  const reader = new BufferReader(frame);
  const code = reader.readByte();

  switch (code) {
    case ResponseCodes.Ok:
      return { code, type: "ok" };
    case ResponseCodes.Err:
      return {
        code,
        errCode: reader.getRemainingBytesCount() > 0 ? reader.readByte() : null,
        type: "err",
      };
    case ResponseCodes.Contact:
      return { code, contact: readContact(reader), type: "contact" };
    case ResponseCodes.EndOfContacts:
      return {
        code,
        mostRecentLastmod: reader.readUInt32LE(),
        type: "endOfContacts",
      };
    case ResponseCodes.Sent:
      return {
        code,
        sent: {
          result: reader.readInt8(),
          expectedAckCrc: reader.readUInt32LE(),
          estTimeout: reader.readUInt32LE(),
        },
        type: "sent",
      };
    case ResponseCodes.ContactMsgRecv: {
      const pubKeyPrefix = reader.readBytes(6);
      return {
        code,
        message: {
          kind: "contact",
          pubKeyPrefix,
          pubKeyPrefixHex: bytesToHex(pubKeyPrefix),
          pathLen: reader.readByte(),
          txtType: reader.readByte(),
          senderTimestamp: reader.readUInt32LE(),
          text: reader.readString(),
        },
        type: "contactMessage",
      };
    }
    case ResponseCodes.ChannelMsgRecv:
      return {
        code,
        message: {
          kind: "channel",
          channelIdx: reader.readInt8(),
          pathLen: reader.readByte(),
          txtType: reader.readByte(),
          senderTimestamp: reader.readUInt32LE(),
          text: reader.readString(),
        },
        type: "channelMessage",
      };
    case ResponseCodes.NoMoreMessages:
      return { code, type: "noMoreMessages" };
    case ResponseCodes.DeviceInfo:
      return {
        code,
        deviceInfo: {
          firmwareVer: reader.readInt8(),
          reserved: reader.readBytes(6),
          firmwareBuildDate: reader.readCString(12),
          manufacturerModel: reader.readCString(40),
          firmwareVersion: reader.readCString(20),
        },
        type: "deviceInfo",
      };
    case ResponseCodes.ChannelInfo:
      return {
        channel: {
          channelIdx: reader.readUInt8(),
          name: reader.readCString(32),
          secret: reader.readRemainingBytes(),
        },
        code,
        type: "channelInfo",
      };
    case PushCodes.MsgWaiting:
      return { code, type: "msgWaiting" };
    default:
      return { code, raw: frame, type: "unknown" };
  }
}

export function commandDeviceQuery(): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.DeviceQuery);
  writer.writeByte(SUPPORTED_COMPANION_PROTOCOL_VERSION);
  return writer.toBytes();
}

export function commandSetDeviceTime(epochSecs: number): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.SetDeviceTime);
  writer.writeUInt32LE(epochSecs);
  return writer.toBytes();
}

export function commandSendFloodAdvert(): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.SendSelfAdvert);
  writer.writeByte(SelfAdvertTypes.Flood);
  return writer.toBytes();
}

export function commandGetContacts(): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.GetContacts);
  return writer.toBytes();
}

export function commandSyncNextMessage(): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.SyncNextMessage);
  return writer.toBytes();
}

export function commandGetChannel(channelIdx: number): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.GetChannel);
  writer.writeByte(channelIdx);
  return writer.toBytes();
}

export function commandSendTextMessage(
  contactPublicKey: Uint8Array,
  text: string,
  now = Date.now()
): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.SendTxtMsg);
  writer.writeByte(TxtTypes.Plain);
  writer.writeByte(0);
  writer.writeUInt32LE(Math.floor(now / 1000));
  writer.writeBytes(contactPublicKey.slice(0, 6));
  writer.writeString(text);
  return writer.toBytes();
}

export function commandSendChannelTextMessage(
  channelIdx: number,
  text: string,
  now = Date.now()
): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(CommandCodes.SendChannelTxtMsg);
  writer.writeByte(TxtTypes.Plain);
  writer.writeByte(channelIdx);
  writer.writeUInt32LE(Math.floor(now / 1000));
  writer.writeString(text);
  return writer.toBytes();
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase();
  if (normalized.length % 2 !== 0 || !HEX_PATTERN.test(normalized)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

export function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && HEX_PATTERN.test(value);
}

export function shortMessageHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function readContact(reader: BufferReader): MeshCoreContact {
  return {
    publicKey: reader.readBytes(32),
    type: reader.readByte(),
    flags: reader.readByte(),
    outPathLen: reader.readInt8(),
    outPath: reader.readBytes(64),
    advName: reader.readCString(32),
    lastAdvert: reader.readUInt32LE(),
    advLat: reader.readInt32LE(),
    advLon: reader.readInt32LE(),
    lastMod: reader.readUInt32LE(),
  };
}
