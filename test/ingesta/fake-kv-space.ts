import type { KVEntry } from '@gravadigital/jiku';

import type { KvSpace } from '#infra/kv/space.js';

/**
 * Un doble EN MEMORIA del Espacio KV, para las suites del tick que NO son sobre el KV (S-032).
 *
 * Reemplaza a `fake-threads-kv.ts`: desde REQ-008 el espacio guarda los DOS mapas (el de tickets,
 * `tickets.<slug>`, y el de hilos, `hilos.<sha256>`), asi que un nombre con "threads" mentiria.
 *
 * La convencion `testing` prohibe mockear el bus, y esto no lo mockea: el espacio es una dependencia
 * que estas suites no afirman — lo unico que necesitan es que la consulta del slug resuelva el
 * proyecto y que el write del hilo no falle, sin levantar un contenedor con JetStream. Las suites
 * que SI son sobre el KV (`test/infra/kv/*.test.ts`, `tick-hilos.test.ts`,
 * `tick-propiedades-kv.test.ts`) corren contra el `JIKU_KV` REAL, que es donde la propiedad importa.
 *
 * Imita el `KV` del SDK en lo que el conector usa: `get()` devuelve `undefined` cuando la clave no
 * esta (NO lanza, NO devuelve `null`), y una entrada con `value: Uint8Array`. Las claves son la parte
 * DERECHA, la que maneja el conector: el prefijo `{instance}.{userId}.` lo agrega el SDK.
 *
 * Registra `puts` y `gets` para que una suite pueda afirmar la AUSENCIA de un round-trip (p. ej.
 * "un mail sin slug no consulta el Mapa de Tickets").
 */
export interface FakeKvSpace {
  readonly space: KvSpace;
  /** Las claves escritas, en orden, con su valor. */
  readonly puts: { key: string; value: string }[];
  /** Las claves consultadas, en orden. */
  readonly gets: string[];
  /**
   * Siembra una entrada, como si el operador (U-02) o un tick anterior la hubiera escrito. La clave
   * es la parte derecha COMPLETA: `'tickets.alfa'`, `threadKey(messageId)`.
   */
  seed(key: string, value: string): void;
}

export function fakeKvSpace(seed: Record<string, string> = {}): FakeKvSpace {
  // La revision imita la secuencia del bucket: cualquier write la mueve, y cada entrada recuerda la
  // del write que la dejo.
  const store = new Map<string, { value: string; revision: number }>();
  const puts: { key: string; value: string }[] = [];
  const gets: string[] = [];
  let revision = 0;
  const write = (key: string, value: string): number => {
    revision += 1;
    store.set(key, { value, revision });
    return revision;
  };
  for (const [key, value] of Object.entries(seed)) write(key, value);

  const space: KvSpace = {
    put(key: string, value: Uint8Array | string): Promise<number> {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      puts.push({ key, value: text });
      return Promise.resolve(write(key, text));
    },
    get(key: string): Promise<KVEntry | undefined> {
      gets.push(key);
      const entry = store.get(key);
      // `undefined` y no `null` ni un throw: es lo que devuelve el `KV` del SDK cuando la clave
      // nunca se escribio o se borro, y es el comportamiento del que dependen los dos lookups.
      if (entry === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        key,
        value: new TextEncoder().encode(entry.value),
        revision: entry.revision,
        created: new Date(0),
      });
    },
  };

  return {
    space,
    puts,
    gets,
    seed(key: string, value: string): void {
      write(key, value);
    },
  };
}
