# @chat-adapter/meshcore

MeshCore Companion Radio adapter for Chat SDK.

## Serial

```ts
import { Chat } from "chat";
import { createMeshCoreAdapter } from "@chat-adapter/meshcore";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    meshcore: createMeshCoreAdapter({
      serialPort: "/dev/ttyACM0",
    }),
  },
  state,
});
```

Set `MESHCORE_SERIAL_PORT` to omit `serialPort` from configuration.

## TCP

```ts
import { Chat } from "chat";
import { createMeshCoreAdapter } from "@chat-adapter/meshcore";

const bot = new Chat({
  userName: "mybot",
  adapters: {
    meshcore: createMeshCoreAdapter({
      tcpHost: "10.1.0.226",
      tcpPort: 5000,
    }),
  },
  state,
});
```

Set `MESHCORE_TCP_HOST` and optionally `MESHCORE_TCP_PORT` to omit TCP config.
