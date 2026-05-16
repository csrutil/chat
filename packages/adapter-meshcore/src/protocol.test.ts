import { describe, expect, it } from "vitest";
import {
  BufferWriter,
  commandSendChannelTextMessage,
  commandSendTextMessage,
  MeshCoreFrameCodec,
  parseFrame,
  ResponseCodes,
  SerialFrameTypes,
} from "./protocol";

describe("MeshCoreFrameCodec", () => {
  it("encodes outgoing frames", () => {
    const frame = MeshCoreFrameCodec.encodeOutgoingFrame(
      new Uint8Array([1, 2, 3])
    );
    expect([...frame]).toEqual([SerialFrameTypes.Outgoing, 3, 0, 1, 2, 3]);
  });

  it("decodes split frames and skips junk bytes", () => {
    const codec = new MeshCoreFrameCodec();
    expect(
      codec.push(new Uint8Array([0xff, SerialFrameTypes.Incoming, 2]))
    ).toEqual([]);
    expect(codec.push(new Uint8Array([0, ResponseCodes.Ok, 9]))).toEqual([
      new Uint8Array([ResponseCodes.Ok, 9]),
    ]);
  });

  it("decodes multiple frames from one chunk", () => {
    const codec = new MeshCoreFrameCodec();
    const frames = codec.push(
      new Uint8Array([
        SerialFrameTypes.Incoming,
        1,
        0,
        ResponseCodes.Ok,
        SerialFrameTypes.Incoming,
        1,
        0,
        ResponseCodes.NoMoreMessages,
      ])
    );
    expect(frames).toEqual([
      new Uint8Array([ResponseCodes.Ok]),
      new Uint8Array([ResponseCodes.NoMoreMessages]),
    ]);
  });
});

describe("MeshCore command encoding", () => {
  it("encodes contact text messages", () => {
    const command = commandSendTextMessage(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      "hello",
      1_700_000_000_000
    );
    expect([...command]).toEqual([
      2, 0, 0, 0, 241, 83, 101, 1, 2, 3, 4, 5, 6, 104, 101, 108, 108, 111,
    ]);
  });

  it("encodes channel text messages", () => {
    const command = commandSendChannelTextMessage(2, "hi", 1_700_000_000_000);
    expect([...command]).toEqual([3, 0, 2, 0, 241, 83, 101, 104, 105]);
  });
});

describe("parseFrame", () => {
  it("parses NUL-padded device info fields", () => {
    const writer = new BufferWriter();
    writer.writeByte(ResponseCodes.DeviceInfo);
    writer.writeByte(11);
    writer.writeBytes([10, 8, 1, 2, 3, 4]);
    writer.writeBytes(fixedStringBytes("15-May-2026", 12));
    writer.writeBytes(fixedStringBytes("Heltec Tracker V2", 40));
    writer.writeBytes(fixedStringBytes("1.4", 20));
    writer.writeBytes([1, 0]);

    const parsed = parseFrame(writer.toBytes());

    expect(parsed).toMatchObject({
      type: "deviceInfo",
      deviceInfo: {
        firmwareBuildDate: "15-May-2026",
        firmwareVer: 11,
        firmwareVersion: "1.4",
        manufacturerModel: "Heltec Tracker V2",
      },
    });
  });

  it("parses contact messages", () => {
    const writer = new BufferWriter();
    writer.writeByte(ResponseCodes.ContactMsgRecv);
    writer.writeBytes([1, 2, 3, 4, 5, 6]);
    writer.writeByte(2);
    writer.writeByte(0);
    writer.writeUInt32LE(123);
    writer.writeString("hello");

    const parsed = parseFrame(writer.toBytes());

    expect(parsed).toMatchObject({
      type: "contactMessage",
      message: {
        pubKeyPrefixHex: "010203040506",
        pathLen: 2,
        txtType: 0,
        senderTimestamp: 123,
        text: "hello",
      },
    });
  });

  it("parses channel messages", () => {
    const writer = new BufferWriter();
    writer.writeByte(ResponseCodes.ChannelMsgRecv);
    writer.writeByte(3);
    writer.writeByte(255);
    writer.writeByte(0);
    writer.writeUInt32LE(456);
    writer.writeString("public");

    const parsed = parseFrame(writer.toBytes());

    expect(parsed).toMatchObject({
      type: "channelMessage",
      message: {
        channelIdx: 3,
        pathLen: 255,
        txtType: 0,
        senderTimestamp: 456,
        text: "public",
      },
    });
  });
});

function fixedStringBytes(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}
