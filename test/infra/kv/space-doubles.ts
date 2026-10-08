import { JikuError } from '@gravadigital/jiku';

import type { KvSpace } from '#infra/kv/space.js';

/**
 * Envolturas reutilizables de un `KvSpace` (real o fake) para los tests del KV y del tick.
 *
 * # POR QUE ENVOLVER Y NO MOCKEAR
 *
 * La convencion `testing` prohibe mockear el bus. "El KV falla en caliente" no se puede provocar
 * contra un contenedor sano sin tirarlo abajo (y tirarlo abajo se lleva a los demas tests del
 * archivo), asi que se envuelve el handle REAL con un `get()` o un `put()` que rechaza: el resto
 * del espacio sigue siendo el de verdad.
 *
 * # POR QUE OBJETOS PLANOS Y NO `Proxy`
 *
 * El `KV` del SDK es una clase con campos privados ES (`#host`, `#prefix`): un `Proxy` sobre la
 * instancia rompe en cuanto un metodo toca `this.#prefix` con el proxy como `this`. Un objeto plano
 * que DELEGA en el espacio envuelto (llamando al metodo sobre la instancia original) no tiene ese
 * problema, y satisface `KvSpace` (`Pick<KV, 'get' | 'put'>`) estructuralmente, sin casts.
 */

/** Lo que registra `spyOnSpace()`: las claves leidas y las escritas, en orden. */
export interface SpaceSpy {
  readonly space: KvSpace;
  /** Las claves consultadas con `get()`, en orden (la parte DERECHA: `tickets.alfa`, `hilos.<hash>`). */
  readonly gets: string[];
  /** Las claves escritas con `put()`, en orden, con su valor como texto. */
  readonly puts: { key: string; value: string }[];
}

/**
 * Un espia de `get()` y `put()`. El `KV` del SDK no lista claves, asi que "este mail no escribio
 * nada" o "este mail no leyo el Mapa de Hilos" se afirma sobre lo que el codigo PIDIO, no sobre lo
 * que quedo en el bucket.
 */
export function spyOnSpace(space: KvSpace): SpaceSpy {
  const gets: string[] = [];
  const puts: { key: string; value: string }[] = [];

  return {
    gets,
    puts,
    space: {
      get: (key, options) => {
        gets.push(key);
        return space.get(key, options);
      },
      put: (key, value, options) => {
        puts.push({ key, value: typeof value === 'string' ? value : new TextDecoder().decode(value) });
        return space.put(key, value, options);
      },
    },
  };
}

/**
 * El error por defecto de un `get()` que falla: el timeout del SDK. Es un `JikuError` (NO un
 * `JikuTimeout`, que es del plano de comandos), que es exactamente lo que el SDK lanza cuando
 * JetStream no contesta.
 */
function defaultTimeout(): JikuError {
  return new JikuError('jiku: kv: get: JetStream did not answer within 15000ms.');
}

/** El mismo espacio, con un `get()` que rechaza con `error` (por defecto, el timeout del SDK). */
export function withFailingGet(space: KvSpace, error: unknown = defaultTimeout()): KvSpace {
  return {
    get: () => Promise.reject(error),
    put: (key, value, options) => space.put(key, value, options),
  };
}

/** El mismo espacio, con un `put()` que rechaza con `error` (por defecto, el timeout del SDK). */
export function withFailingPut(space: KvSpace, error: unknown = defaultTimeout()): KvSpace {
  return {
    get: (key, options) => space.get(key, options),
    put: () => Promise.reject(error),
  };
}

/** Lo que devuelve `switchableSpace()`: el espacio y los dos interruptores. */
export interface SwitchableSpace {
  /** EL MISMO objeto antes, durante y despues de la caida. */
  readonly space: KvSpace;
  /** Desde aca, `get()` y `put()` rechazan con el error de la caida. */
  readonly down: () => void;
  /** Desde aca, `get()` y `put()` vuelven a delegar en el espacio envuelto. */
  readonly up: () => void;
}

/**
 * Una caida del KV en caliente, controlada: con `down()` el `get()` y el `put()` rechazan con
 * `error` (por defecto, el timeout del SDK); con `up()` vuelven a delegar.
 *
 * Es EL MISMO objeto antes y despues, y eso es lo que lo hace util (S-033, CA-7): el tick que sigue
 * a la caida usa el mismo handle, sin reabrir el espacio, y si crea su requisito es porque no habia
 * ningun estado que reconstruir. Un doble que devolviera un objeto nuevo al volver no probaria eso.
 */
export function switchableSpace(space: KvSpace, error: unknown = defaultTimeout()): SwitchableSpace {
  let isDown = false;
  return {
    space: {
      get: (key, options) => (isDown ? Promise.reject(error) : space.get(key, options)),
      put: (key, value, options) => (isDown ? Promise.reject(error) : space.put(key, value, options)),
    },
    down: () => {
      isDown = true;
    },
    up: () => {
      isDown = false;
    },
  };
}

/** Lo que devuelve `withEntryCreated()`: el espacio y el registro de lo que devolvio fechado. */
export interface AgedSpace {
  readonly space: KvSpace;
  /** Cada entrada que el doble devolvio con la fecha cambiada, en orden. */
  readonly reads: { key: string; created: Date }[];
}

/**
 * El mismo espacio, con cada entrada existente devuelta con `created` fijado en `created`. JetStream
 * no permite fechar una entrada hacia atras, y "una respuesta a un hilo de 91 dias" necesita una
 * entrada de 91 dias (S-033, CA-4).
 *
 * El registro `reads` existe para que el test afirme que el doble SE USO: un doble que nadie
 * consulto haria pasar el escenario sin probar nada sobre la antiguedad.
 */
export function withEntryCreated(space: KvSpace, created: Date): AgedSpace {
  const reads: { key: string; created: Date }[] = [];
  return {
    reads,
    space: {
      get: async (key, options) => {
        const entry = await space.get(key, options);
        if (entry === undefined) return undefined;
        reads.push({ key, created });
        return { ...entry, created };
      },
      put: (key, value, options) => space.put(key, value, options),
    },
  };
}
