import { describe, expect, it, vi } from 'vitest';

import { createShutdownHandler } from '#shared/shutdown.js';

/**
 * TS-11 a TS-15 (Tarea 3 del Story Plan de S-011): el apagado ordenado.
 *
 * El handler se invoca DIRECTAMENTE como funcion — nunca enviando una senal real de sistema
 * operativo al proceso de test (CA-13). `cron.stop()`, `closeBus()` y `process.exit` se doblan
 * por inyeccion de parametro, mismo criterio de inyectabilidad que el resto del servicio.
 */

function buildDeps(overrides: {
  waitForCurrentTick?: () => Promise<void>;
  scheduledTask?: { stop: ReturnType<typeof vi.fn<() => void>> } | undefined;
  // S-025: por default se inyecta un doble, para que los casos de abajo puedan afirmar el ORDEN
  // relativo al cierre del bus sin fabricarlo cada uno. Se pasa `null` para el caso de "no hay
  // watch", que es el del modo de verificacion.
  stopTicketMapWatch?: ReturnType<typeof vi.fn<() => void>> | null;
}) {
  const stop = overrides.scheduledTask?.stop ?? vi.fn<() => void>();
  const closeBus = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const exit = vi.fn<(code: number) => void>();
  const waitForCurrentTick =
    overrides.waitForCurrentTick ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const stopTicketMapWatch =
    overrides.stopTicketMapWatch === null
      ? undefined
      : (overrides.stopTicketMapWatch ?? vi.fn<() => void>());

  return {
    scheduledTask: overrides.scheduledTask === undefined ? undefined : { stop },
    waitForCurrentTick,
    stopTicketMapWatch,
    closeBus,
    exit,
  };
}

describe('createShutdownHandler()', () => {
  it('TS-11/TS-12: detiene el cron, espera el tick en vuelo, cierra el bus y sale con 0', async () => {
    let resolveTick!: () => void;
    const waitForCurrentTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const deps = buildDeps({ waitForCurrentTick, scheduledTask: { stop: vi.fn() } });
    const handler = createShutdownHandler(deps);

    const call = handler();

    // Todavia no debe haber cerrado el bus ni salido: el tick en vuelo sigue pendiente.
    await Promise.resolve();
    expect(deps.scheduledTask?.stop).toHaveBeenCalledTimes(1);
    expect(deps.closeBus).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();

    resolveTick();
    await call;

    expect(deps.closeBus).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('TS-13: durante la espera del tick en vuelo, stop() ya se llamo (no se disparan ticks nuevos)', async () => {
    let resolveTick!: () => void;
    const waitForCurrentTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const scheduledTask = { stop: vi.fn() };
    const deps = buildDeps({ waitForCurrentTick, scheduledTask });
    const handler = createShutdownHandler(deps);

    const call = handler();
    await Promise.resolve();

    expect(scheduledTask.stop).toHaveBeenCalledTimes(1);

    resolveTick();
    await call;
  });

  it('TS-14: sin tick en vuelo, no espera nada perceptible y sale igual con 0', async () => {
    const deps = buildDeps({ waitForCurrentTick: vi.fn().mockResolvedValue(undefined) });
    const handler = createShutdownHandler(deps);

    await handler();

    expect(deps.closeBus).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('TS-14b: funciona igual cuando POLL_ENABLED era false (no hay scheduledTask que detener)', async () => {
    const deps = buildDeps({ scheduledTask: undefined });
    const handler = createShutdownHandler(deps);

    await handler();

    expect(deps.closeBus).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('TS-15: un tick en vuelo no se cancela — el handler espera la promesa antes de closeBus()', async () => {
    let resolveTick!: () => void;
    let tickWasStillPending = true;
    const waitForCurrentTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = () => {
            tickWasStillPending = false;
            resolve();
          };
        }),
    );
    const deps = buildDeps({ waitForCurrentTick, scheduledTask: { stop: vi.fn() } });
    const handler = createShutdownHandler(deps);

    const call = handler();

    // closeBus no debe llamarse mientras el tick simulado sigue "en vuelo".
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.closeBus).not.toHaveBeenCalled();

    resolveTick();
    await call;

    expect(tickWasStillPending).toBe(false);
    expect(deps.closeBus).toHaveBeenCalledTimes(1);
  });

  // S-025: el watch del Mapa de Tickets se baja en el apagado, y ANTES de cerrar el bus.
  it('detiene el watch del Mapa de Tickets ANTES de cerrar el bus', async () => {
    const order: string[] = [];
    const stopTicketMapWatch = vi.fn<() => void>(() => {
      order.push('stopWatch');
    });
    const deps = buildDeps({ stopTicketMapWatch, scheduledTask: { stop: vi.fn() } });
    deps.closeBus.mockImplementation(async () => {
      order.push('closeBus');
    });

    await createShutdownHandler(deps)();

    expect(stopTicketMapWatch).toHaveBeenCalledTimes(1);
    // El orden NO es cosmetico: el watch corre SOBRE la conexion al bus, asi que bajarlo despues
    // del cierre le manifestaria el socket cerrado como una caida y programaria un reintento
    // contra una conexion que ya no existe.
    expect(order).toEqual(['stopWatch', 'closeBus']);
  });

  it('espera el tick en vuelo antes de detener el watch', async () => {
    const order: string[] = [];
    let resolveTick!: () => void;
    const waitForCurrentTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = (): void => {
            order.push('tick');
            resolve();
          };
        }),
    );
    const stopTicketMapWatch = vi.fn<() => void>(() => {
      order.push('stopWatch');
    });
    const deps = buildDeps({ waitForCurrentTick, stopTicketMapWatch });

    const call = createShutdownHandler(deps)();
    await Promise.resolve();
    expect(stopTicketMapWatch).not.toHaveBeenCalled();

    resolveTick();
    await call;

    expect(order).toEqual(['tick', 'stopWatch']);
  });

  it('no explota si no hay watch que detener', async () => {
    // El caso del modo de verificacion, que no queda vivo y por lo tanto no arranca ningun watch.
    const deps = buildDeps({ stopTicketMapWatch: null });

    await expect(createShutdownHandler(deps)()).resolves.toBeUndefined();

    expect(deps.closeBus).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
