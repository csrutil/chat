import type { Logger } from "chat";
import { MeshCoreFramedConnection } from "./connection";
import type { MeshCoreTcpSocketLike } from "./types";

export const DEFAULT_TCP_PORT = 5000;

interface MeshCoreTcpConnectionOptions {
  commandTimeoutMs?: number;
  host: string;
  logger?: Logger;
  port?: number;
  socket?: MeshCoreTcpSocketLike;
}

export class MeshCoreTcpConnection extends MeshCoreFramedConnection {
  private readonly host: string;
  private readonly port: number;
  private socket: MeshCoreTcpSocketLike | null;

  constructor(options: MeshCoreTcpConnectionOptions) {
    super(options);
    this.host = options.host;
    this.port = options.port ?? DEFAULT_TCP_PORT;
    this.socket = options.socket ?? null;
  }

  async connect(): Promise<void> {
    if (!this.socket) {
      const { Socket } = await import("node:net");
      this.socket = new Socket();
    }

    const socket = this.socket;
    socket.on("data", (data) => this.onDataReceived(data));
    socket.on("close", () => {
      this.logger?.info("MeshCore TCP connection closed");
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off("error", onConnectError);
        socket.on("error", (error) => {
          this.logger?.error("MeshCore TCP connection error", { error });
        });
        resolve();
      };
      const onConnectError = (error: Error): void => {
        socket.off("connect", onConnect);
        reject(error);
      };

      socket.once("connect", onConnect);
      socket.once("error", onConnectError);
      socket.connect(this.port, this.host);
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }

  protected async writeFrame(frame: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      throw new Error("MeshCore TCP socket is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        resolve();
      });
    });
  }
}
