# Adding an IPC channel

The renderer is untrusted: assume a compromised page will call your channel with any payload, from any window, as often as it likes. A channel is safe when main would be fine with that.

## The pieces

| Where | What |
| --- | --- |
| `apps/desktop/src/main/ipc/<namespace>.ts` | The handler map: `'<namespace>:<verb>': h(Schema, fn)` |
| `apps/desktop/src/main/ipc/schemas.ts` (or the namespace file) | The zod schema of the input |
| `apps/desktop/src/main/index.ts` | Registers the map (`registerXxxIpc(...)` → `registerAll(map)`) |
| `apps/desktop/src/shared/types.ts` | The typed `HoplineApi` the renderer sees |
| `apps/desktop/src/preload/index.ts` | `inv('<namespace>:<verb>', arg)`, or `on('<namespace>:event', cb)` for events |
| `apps/desktop/test/ipc-shapes.test.ts` | Mounts the map and checks inputs and outputs |

Channels are request/response (`ipcRenderer.invoke` → `ipcMain.handle`). The preload exposes typed functions only, never `ipcRenderer`. Events from main to the renderer go to the one window that asked (`webContents.send`), never broadcast to every window.

## Steps

1. **Schema.** Every channel takes exactly one argument (or none), validated before the handler runs: `handle()` calls `schema.parse(arg)` and only then `fn`.
   - Use `z.object({...}).strict()`, so an extra field (a `password`, a `path`) is rejected, not ignored.
   - Bound everything: string lengths (`.max()`), array sizes, integer ranges, enums instead of free strings. Reuse the shared `id`, `name`, `ids` helpers in `schemas.ts`.
   - Take **ids, not data**. The renderer names a session, a proposal, a plan or a preview by id; main looks up what it stored. Never accept a host, a path, a command list or a device list where main can resolve one from an id. (For example `multi:start` takes a `previewId`; the targets and the command were fixed when main built the preview.)
   - A file path never comes from the renderer: main opens the native picker and keeps the choice under a short-lived token.
2. **Ownership.** If the channel names a tab, check that the asking window owns it: `owns(tabId, e.sender)` (`SessionHostClient.ownedBy`), and throw `This session is not open in this window` otherwise. See `ipc/agent.ts` (`mine`) for the pattern. Results and events go back to `e.sender` only.
3. **Handler.** Keep it thin: validate, check ownership, call a service. Anything that sends a command to a device goes through the guard (`GuardedRunner`, the agent's `DeviceTools`/`Proposals`, or the safety-net flow), never straight to the session host. Anything security-relevant writes an audit row.
4. **Return no secrets.** Results carry metadata (`hasSecret: true`), never a password, key, passphrase, token or unredacted device output. Errors are plain messages; don't put a secret into an error string.
5. **Register** the map in `src/main/index.ts`, add the method to `HoplineApi` in `src/shared/types.ts`, and expose it in `src/preload/index.ts`.
6. **Test** in `test/ipc-shapes.test.ts`:
   - add your handler map to the `handlers` object in `beforeAll`, with stub services where needed;
   - call the channel with valid input (through `call`, which records every result);
   - assert that a payload with an extra field (`password: 'CANARY-PASSWORD-7f3a'`) and out-of-range values throw at `schema.parse`;
   - the last test fails if any mounted channel was never called, or if any result or event contains a canary, a key body or a field named like a secret.
   Behaviour tests for the service go in their own test file.

## Example

```ts
// src/main/ipc/notes.ts
import { z } from 'zod'
import { handler as h } from './index'
import type { Owns } from './agent'

const Pin = z.object({ tabId: z.string().min(1).max(64), text: z.string().max(500) }).strict()

export function notesHandlers(notes: NotesService, owns: Owns) {
  return {
    'notes:pin': h(Pin, ({ tabId, text }, e) => {
      if (!owns(tabId, e.sender)) throw new Error('This session is not open in this window')
      return notes.pin(tabId, text) // returns { id, createdAt }: nothing secret
    })
  }
}
```

## Review checklist

- [ ] `.strict()` schema with bounds; ids instead of data; no paths from the renderer
- [ ] Ownership check for any tab or window-scoped resource; replies to `e.sender` only
- [ ] No route to a device that skips the guard; audit row where an action is taken for the user
- [ ] No secret in results, events or errors
- [ ] Mounted and exercised in `ipc-shapes.test.ts`, with a rejected extra-field payload
