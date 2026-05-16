# @chat-adapter/meshcore

MeshCore Companion Radio adapter for Chat SDK.

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
