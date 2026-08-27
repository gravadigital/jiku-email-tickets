import {
  Client,
  DEFAULT_TIMEOUT_MS,
  JikuInvalidRequest,
} from '@gravadigital/jiku';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from './helpers.js';

describe('the bus SDK', () => {
  it('resolves and types when imported from an ESM module', () => {
    expect(typeof Client).toBe('function');
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });
});

describe('Client.fromConnection against the real NATS container', () => {
  let bus: TestBusContext;

  beforeAll(async () => {
    bus = await setupTestBus(inject('natsUrl'));
  });

  afterAll(async () => {
    await bus.cleanup();
  });

  it('builds a usable client carrying the caller identity', () => {
    expect(bus.client.userId).toBe(TEST_USER_ID);
    expect(bus.client.instance).toBe(TEST_INSTANCE);
    expect(bus.client.closed).toBe(false);
  });

  it('keeps the SDK default timeout, which ADR-002 forbids lowering', () => {
    expect(bus.client.timeoutMs).toBe(15_000);
  });

  it('rejects an empty userId with JikuInvalidRequest', () => {
    expect(() =>
      Client.fromConnection(bus.connection, { instance: TEST_INSTANCE, userId: '' }),
    ).toThrow(JikuInvalidRequest);
  });
});
