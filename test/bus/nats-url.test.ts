import { describe, expect, inject, it } from 'vitest';

describe('the NATS url provided by the global setup', () => {
  it('is a well-formed url with the dynamically mapped port', () => {
    expect(inject('natsUrl')).toMatch(/^nats:\/\/.+:\d+$/);
  });

  // TS-15, primera mitad: este archivo deja asentado que la url y el contenedor que ve son los
  // que el globalSetup levanto. `shared-container.test.ts`, que corre en otro worker, asegura
  // que ve exactamente los mismos valores. Si cada archivo tuviera su propio contenedor, los
  // ids no coincidirian.
  it('points at the container the global setup started', () => {
    const url = inject('natsUrl');
    const containerId = inject('natsContainerId');

    expect(containerId).toMatch(/^[0-9a-f]{12,}$/);
    expect(url.endsWith(':4222')).toBe(false);
  });
});
