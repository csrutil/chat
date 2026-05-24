import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BufferWriter,
  commandDeviceQuery,
  ResponseCodes,
  SerialFrameTypes,
} from "./protocol";
import { DEFAULT_TCP_PORT, MeshCoreTcpConnection } from "./tcp-connection";

const FRAME_HEADER_LENGTH = 3;

describe("MeshCoreTcpConnection", () => {
  it("connects over TCP and exchanges MeshCore serial frames", async () => {
    const receivedFrames: number[][] = [];
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      let readBuffer = Buffer.alloc(0);

      socket.on("data", (data) => {
        readBuffer = Buffer.concat([readBuffer, data]);

        while (readBuffer.length >= FRAME_HEADER_LENGTH) {
          const frameType = readBuffer.readUInt8(0);
          const frameLength = readBuffer.readUInt16LE(1);
          const requiredLength = FRAME_HEADER_LENGTH + frameLength;
          if (readBuffer.length < requiredLength) {
            break;
          }

          expect(frameType).toBe(SerialFrameTypes.Outgoing);
          receivedFrames.push([
            ...readBuffer.subarray(FRAME_HEADER_LENGTH, requiredLength),
          ]);
          readBuffer = readBuffer.subarray(requiredLength);
          socket.write(createDeviceInfoFrame());
        }
      });
    });

    await listen(server);
    const address = server.address();
    if (!(address && typeof address === "object")) {
      throw new Error("Expected TCP test server to have an address");
    }

    const connection = new MeshCoreTcpConnection({
      host: "127.0.0.1",
      port: address.port,
    });

    try {
      await connection.connect();

      await expect(connection.deviceQuery()).resolves.toMatchObject({
        firmwareBuildDate: "24-May-2026",
        firmwareVer: 7,
        firmwareVersion: "1.2.3",
        manufacturerModel: "meshcore-tcp",
      });

      expect(receivedFrames).toEqual([[...commandDeviceQuery()]]);
    } finally {
      await connection.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("defaults to the MeshCore TCP port", () => {
    expect(DEFAULT_TCP_PORT).toBe(5000);
  });
});

function createDeviceInfoFrame(): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(ResponseCodes.DeviceInfo);
  writer.writeByte(7);
  writer.writeBytes([0, 0, 0, 0, 0, 0]);
  writer.writeBytes(fixedStringBytes("24-May-2026", 12));
  writer.writeBytes(fixedStringBytes("meshcore-tcp", 40));
  writer.writeBytes(fixedStringBytes("1.2.3", 20));
  return createFrame(SerialFrameTypes.Incoming, writer.toBytes());
}

function createFrame(frameType: number, frameData: Uint8Array): Uint8Array {
  const writer = new BufferWriter();
  writer.writeByte(frameType);
  writer.writeUInt16LE(frameData.length);
  writer.writeBytes(frameData);
  return writer.toBytes();
}

function fixedStringBytes(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
