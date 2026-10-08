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
