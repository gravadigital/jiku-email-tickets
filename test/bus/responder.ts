// El cliente NATS se importa del subpath del SDK, NUNCA del paquete `nats`: `nats` no es
// dependencia de este proyecto (ADR-002) y el subpath garantiza una sola copia de la libreria en el
// arbol, sin la cual `error instanceof X` falla contra la copia que lanzo. Vale en test igual que en
// produccion.
import type { NatsConnection, Subscription } from '@gravadigital/jiku/nats';

/**
 * El doble de `core`: un responder que atiende un comando SOBRE EL BUS REAL.
 *
 * La convencion `testing` lo prescribe y prohibe la alternativa: el bus NO se mockea. Los tests de
 * integracion usan el NATS del contenedor con `Client.fromConnection()`, y `core` se dobla con un
 * responder EN EL PROPIO TEST. Es lo que hace testeables las ocho situaciones de error sin `core`.
 *
 * LA REGLA QUE HACE O ROMPE ESTE HELPER: se suscribe con COMODIN
 * (`*.*.jiku-commands.v1.{command}`), nunca reconstruyendo el subject. Verificado en la suite: el
 * subject que el SDK publica es `test.test-machine-user.jiku-commands.v1.requirements.new`, y el
 * comodin cubre `instance` y `userId` mientras los tokens `jiku-commands`, `v1` y el metodo van
 * literales. Un responder que reconstruyera el subject y se equivocara IGUAL que el codigo de
 * produccion pasaria en verde con las dos mitades rotas — el test afirmaria la reconstruccion del
 * test en vez de la del SDK.
 */

/** Un envelope de exito, con lo que `core` devolveria en `data`. */
export interface SuccessReply {
  readonly status: 'success';
  readonly data?: unknown;
}

/** Un envelope de fallo, con lo que `core` diria del rechazo. */
export interface FailureReply {
  readonly status: 'failure';
  readonly errorCode: string;
  readonly errorMessage?: string;
  readonly errorDetails?: Record<string, unknown>;
}

/**
 * El envelope que el responder emite. Es la forma exacta del `Reply` del SDK, y en un fallio viaja
 * en el BODY (los headers `Nats-Service-Error` se agregan al lado, nunca en reemplazo).
 */
export type ResponderReply = SuccessReply | FailureReply;

/**
 * `'mute'` = recibe y NO responde.
 *
 * Es como se provoca `JikuTimeout` sin apagar nada: el mensaje llega —asi que el contador lo
 * cuenta, que es lo que prueba que la publicacion SI llego a la red— y nadie contesta. Distinto de
 * no tener responder, que produce `JikuNoEndpoint` de inmediato (verificado: 11 ms).
 */
export const MUTE = 'mute' as const;

export interface CoreResponder {
  /** El subject de cada mensaje recibido, EN EL ORDEN en que llegaron. */
  subjects(): string[];
  /** El cuerpo decodificado de cada mensaje recibido. */
  payloads(): unknown[];
  /**
   * Cuantos mensajes recibio.
   *
   * Es lo que prueba "no hay reintento" (exactamente 1 por publicacion) y "el error local no llego
   * a la red" (exactamente 0 en `JikuInvalidRequest`). Sin este contador, un reintento silencioso
   * pasaria desapercibido: el resultado observable de la funcion seria el mismo.
   */
  count(): number;
  /** Da de baja la suscripcion. */
  stop(): Promise<void>;
}

/**
 * Suscribe un responder al comando y contesta con lo que se le indique.
 *
 * `replies` acepta UNA respuesta o UNA SECUENCIA. La secuencia es lo que hace directo el test de
 * repetibilidad (dos corridas con `id: 1` e `id: 2`) sin re-suscribir a mitad del test. Agotada la
 * secuencia, se repite la ultima — asi un test que publica de mas obtiene una respuesta coherente
 * en vez de un timeout que se diagnosticaria como otra cosa.
 */
export async function respondTo(
  nc: NatsConnection,
  command: string,
  replies: ResponderReply | ResponderReply[] | typeof MUTE,
): Promise<CoreResponder> {
  // COMODIN en instance y userId. Ver el comentario de arriba: reconstruir el subject es el error
  // que hace pasar el test con las dos mitades rotas.
  const subscription: Subscription = nc.subscribe(`*.*.jiku-commands.v1.${command}`);

  const subjects: string[] = [];
  const payloads: unknown[] = [];
  const sequence = replies === MUTE ? MUTE : Array.isArray(replies) ? replies : [replies];

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // El bucle de atencion es el patron del cliente NATS y NO se le hace `await`: terminaria solo al
  // darse de baja la suscripcion, que es despues de que el test termino de usarla.
  void (async () => {
    for await (const message of subscription) {
      subjects.push(message.subject);

      // El cuerpo se decodifica para poder afirmar que lo que llego al bus es el payload validado y
      // nada mas. Un cuerpo que no sea JSON se guarda como el string crudo en vez de tirar el
      // mensaje: si eso pasara, lo que hay que ver en el test es QUE llego.
      const raw = decoder.decode(message.data);
      try {
        payloads.push(JSON.parse(raw));
      } catch {
        payloads.push(raw);
      }

      if (sequence === MUTE) continue;

      // Agotada la secuencia se repite la ultima. `at(-1)` no puede ser undefined con una secuencia
      // no vacia, pero `noUncheckedIndexedAccess` obliga a la guarda.
      const index = Math.min(subjects.length - 1, sequence.length - 1);
      const reply = sequence[index] ?? sequence.at(-1);
      if (reply === undefined) continue;

      message.respond(encoder.encode(JSON.stringify(reply)));
    }
  })();

  // Espera DETERMINISTICA a que la suscripcion este activa, sin sleeps de reloj (la convencion los
  // prohibe para esperar una condicion). `flush()` vuelve cuando el servidor ya proceso el SUB.
  await nc.flush();

  return {
    subjects: () => [...subjects],
    payloads: () => [...payloads],
    count: () => subjects.length,
    // Se da de baja para que un caso no le contieste al siguiente. Con `fileParallelism: false` y
    // un bus compartido, una suscripcion viva de un test anterior es exactamente la clase de
    // contaminacion cruzada que la ejecucion secuencial busca evitar.
    stop: async () => {
      await subscription.drain();
    },
  };
}
