import { writeFile } from 'node:fs/promises';

import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    natsUrl: string;
    natsContainerId: string;
  }
}

// El id del contenedor se deja en disco para que la verificacion de teardown (TS-22) pueda
// preguntarle a Docker por ESTE contenedor despues de que la suite termino, cuando ya no hay
// proceso de Vitest al que preguntarle.
export const CONTAINER_ID_FILE = 'node_modules/.jiku-nats-container-id';

let nats: Awaited<ReturnType<GenericContainer['start']>> | undefined;

// Vitest 4 le pasa al globalSetup el TestProject; el `GlobalSetupContext` que usan los
// ejemplos de la convencion es de Vitest 3 y ya no se exporta.
export async function setup({ provide }: TestProject): Promise<void> {
  try {
    nats = await new GenericContainer('nats:2.10-alpine')
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage('Server is ready'))
      .start();
  } catch (cause) {
    // Sin este envoltorio, un Docker ausente degrada en un error de socket que no nombra la
    // precondicion: se diagnostica como "el test cuelga" en lugar de "falta Docker".
    throw new Error(
      'No se pudo levantar el contenedor NATS de la suite. Docker es una precondicion de los ' +
        'tests de este servicio: verifica que el daemon este corriendo y accesible.',
      { cause },
    );
  }

  const containerId = nats.getId();

  provide('natsUrl', `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`);
  provide('natsContainerId', containerId);

  await writeFile(CONTAINER_ID_FILE, containerId, 'utf8');
}

export async function teardown(): Promise<void> {
  // Optional chaining a proposito: si setup() fallo a mitad de camino, el teardown corre igual
  // y no debe explotar encima del error original, que es el que hay que leer.
  await nats?.stop();
}
