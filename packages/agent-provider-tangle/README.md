# @tangle-network/agent-provider-tangle

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.

```ts
import { Sandbox } from '@tangle-network/sandbox'
import { createTangleProvider } from '@tangle-network/agent-provider-tangle'

const provider = createTangleProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
})
```
