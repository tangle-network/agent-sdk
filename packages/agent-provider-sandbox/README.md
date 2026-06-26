# @tangle-network/agent-provider-sandbox

Wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.

```ts
import { Sandbox } from '@tangle-network/sandbox'
import { createTangleSandboxProvider } from '@tangle-network/agent-provider-sandbox'

const provider = createTangleSandboxProvider({
  client: new Sandbox({ apiKey: process.env.TANGLE_API_KEY }),
})
```
