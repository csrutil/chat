import type { Logger } from "chat";

export interface MeshCoreContact {
  advLat: number;
  advLon: number;
  advName: string;
  flags: number;
  lastAdvert: number;
  lastMod: number;
  outPath: Uint8Array;
  outPathLen: number;
  publicKey: Uint8Array;
  type: number;
}

export interface MeshCoreChannel {
  channelIdx: number;
  name: string;
  secret: Uint8Array;
}

export interface MeshCoreDeviceInfo {
  firmwareBuildDate: string;
  firmwareVer: number;
  firmwareVersion: string;
  manufacturerModel: string;
  reserved: Uint8Array;
}

export interface MeshCoreSentResponse {
  estTimeout: number;
  expectedAckCrc: number;
  result: number;
}

export interface MeshCoreContactMessage {
  kind: "contact";
  pathLen: number;
  pubKeyPrefix: Uint8Array;
  pubKeyPrefixHex: string;
  senderTimestamp: number;
  text: string;
  threadId: string;
  txtType: number;
}

export interface MeshCoreChannelMessage {
  channelIdx: number;
  kind: "channel";
  pathLen: number;
  senderTimestamp: number;
  text: string;
  threadId: string;
  txtType: number;
}

export type MeshCoreRawMessage =
  | MeshCoreContactMessage
  | MeshCoreChannelMessage;

export type MeshCoreThreadId =
  | { publicKeyPrefixHex: string; type: "contact" }
  | { channelIdx: number; type: "channel" };

export type MeshCoreWaitingMessage =
  | { contactMessage: Omit<MeshCoreContactMessage, "threadId"> }
  | { channelMessage: Omit<MeshCoreChannelMessage, "threadId"> }
  | { channelData: unknown };

export interface MeshCoreConnection {
  close(): Promise<void>;
  connect(): Promise<void>;
  deviceQuery(): Promise<MeshCoreDeviceInfo>;
  findContactByPublicKeyPrefix(
    publicKeyPrefixHex: string
  ): Promise<MeshCoreContact | null>;
  getChannel(channelIdx: number): Promise<MeshCoreChannel | null>;
  getWaitingMessages(): Promise<MeshCoreWaitingMessage[]>;
  offMsgWaiting(handler: () => void): void;
  onMsgWaiting(handler: () => void): void;
  sendChannelTextMessage(channelIdx: number, text: string): Promise<void>;
  sendFloodAdvert(): Promise<void>;
  sendTextMessage(
    contactPublicKey: Uint8Array,
    text: string
  ): Promise<MeshCoreSentResponse>;
  syncDeviceTime(): Promise<void>;
}

export interface MeshCoreAdapterConfig {
  /**
   * Auto-open the serial connection during Chat initialization.
   *
   * Default: true.
   */
  autoConnect?: boolean;
  /**
   * Serial baud rate.
   *
   * Default: 115200.
   */
  baudRate?: number;
  /**
   * Primarily for tests or custom transports. When supplied, `serialPort` is not
   * required and the adapter delegates all MeshCore operations to this object.
   */
  connection?: MeshCoreConnection;
  /** Optional logger override. */
  logger?: Logger;
  /**
   * Send a flood advert after connecting.
   *
   * Default: true.
   */
  sendFloodAdvertOnConnect?: boolean;
  /**
   * Serial port path. Falls back to MESHCORE_SERIAL_PORT.
   */
  serialPort?: string;
  /**
   * Set the MeshCore device time to the host clock after connecting.
   *
   * Default: true.
   */
  syncDeviceTime?: boolean;
  /**
   * Bot username override. Falls back to the Chat userName.
   */
  userName?: string;
}

export interface MeshCoreSerialPortLike {
  close(callback?: (error?: Error | null) => void): void;
  drain?(callback?: (error?: Error | null) => void): void;
  isOpen?: boolean;
  on(event: "close" | "open", listener: () => void): this;
  on(event: "data", listener: (data: Uint8Array) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  open(callback?: (error?: Error | null) => void): void;
  write(
    data: Uint8Array,
    callback?: (error?: Error | null) => void
  ): boolean | undefined;
}
