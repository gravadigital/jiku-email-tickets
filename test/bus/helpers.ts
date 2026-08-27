import { Client } from '@gravadigital/jiku';
// El cliente NATS se importa del subpath del SDK, no del paquete `nats`: `nats` no es
// dependencia de este proyecto (ADR-002, CA-6) y el subpath garantiza una sola copia de la
// libreria en el arbol, sin la cual `error instanceof PermissionViolationError` falla contra la
// copia que lanzo.
import { connect, type NatsConnection } from '@gravadigital/jiku/nats';

export const TEST_USER_ID = 'test-machine-user';
export const TEST_INSTANCE = 'test';

// Tipo de retorno explicito a proposito: es el helper que S-004 y S-005 van a consumir, y un
// tipo inferido que cambie en silencio les rompe los tests.
export type TestBusContext = {
  connection: NatsConnection;
  client: Client;
  cleanup: () => Promise<void>;
};

export async function setupTestBus(natsUrl: string): Promise<TestBusContext> {
  const connection = await connect({ servers: natsUrl });

  const client = Client.fromConnection(connection, {
    instance: TEST_INSTANCE,
    userId: TEST_USER_ID,
  });

  return {
    connection,
    client,
    // drain() y no close(): con close() a secas una reply en vuelo se pierde. Irrelevante en
    // S-001 (no hay requests), pero S-005 hereda este helper y ahi si importa.
    cleanup: async () => {
      await connection.drain();
    },
  };
}
