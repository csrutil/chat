import type { Logger } from "chat";
import { MeshCoreFramedConnection } from "./connection";
import { DEFAULT_BAUD_RATE } from "./protocol";
import type { MeshCoreSerialPortLike } from "./types";

interface MeshCoreSerialConnectionOptions {
  baudRate?: number;
  commandTimeoutMs?: number;
  logger?: Logger;
  port?: MeshCoreSerialPortLike;
  serialPort: string;
}

export class MeshCoreSerialConnection extends MeshCoreFramedConnection {
  private readonly baudRate: number;
  private port: MeshCoreSerialPortLike | null;
  private readonly serialPort: string;

  constructor(options: MeshCoreSerialConnectionOptions) {
    super(options);
    this.serialPort = options.serialPort;
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.port = options.port ?? null;
  }

  async connect(): Promise<void> {
    if (!this.port) {
      const { SerialPort } = await import("serialport");
      this.port = new SerialPort({
        autoOpen: false,
        baudRate: this.baudRate,
        path: this.serialPort,
      });
    }

    const port = this.port;
    port.on("data", (data) => this.onDataReceived(data));
    port.on("error", (error) => {
      this.logger?.error("MeshCore serial port error", { error });
    });

    if (port.isOpen) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        port.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        port.off("open", onOpen);
        reject(error);
      };
      port.on("open", onOpen);
      port.on("error", onError);
      port.open((error) => {
        if (error) {
          reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      port.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  protected async writeFrame(frame: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port) {
      throw new Error("MeshCore serial port is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      port.write(frame, (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        if (!port.drain) {
          resolve();
          return;
        }
        port.drain((drainError) => {
          if (drainError) {
            reject(drainError);
            return;
          }
          resolve();
        });
      });
    });
  }
}
