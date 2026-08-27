# Types - jiku-mail-connector

## TestBusContext

**Location:** `test/bus/helpers.ts`

**Description:** Return type of `setupTestBus()`. Declared explicitly rather than inferred, because
S-004 and S-005 consume this helper and a silently changing inferred type would break their tests.

**Interface:**

```ts
type TestBusContext = {
  connection: NatsConnection;
  client: Client;
  cleanup: () => Promise<void>;
};
```

**Usage example:**

```ts
import { setupTestBus, type TestBusContext } from './helpers.js';

let bus: TestBusContext;
bus = await setupTestBus(inject('natsUrl'));
```
