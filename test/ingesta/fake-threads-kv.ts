import type { KV } from '@gravadigital/jiku/nats';

/**
 * Un doble EN MEMORIA del bucket de hilos, para las suites del tick que NO son sobre el Mapa de
 * Hilos (S-026).
 *
 * La convencion `testing` prohibe mockear el bus, y esto no lo mockea: el bucket de hilos es una
 * dependencia que estas suites ni ejercitan ni afirman — lo unico que necesitan es que el write que
 * el tick hace despues de cada alta NO falle y no las obligue a levantar un contenedor con
 * JetStream. Las suites que SI son sobre el Mapa de Hilos (`test/infra/kv/threads.test.ts` y
 * `test/ingesta/tick-hilos.test.ts`) corren contra un KV REAL, que es donde la propiedad importa.
 *
 * Registra `puts` y `gets` para que una suite pueda afirmar la AUSENCIA de un round-trip (p. ej.
 * "un mail sin Message-Id no escribe nada").
 */
export interface FakeThreadsKv {
  readonly kv: KV;
  /** Las claves escritas, en orden, con su valor. */
  readonly puts: { key: string; value: string }[];
  /** Las claves consultadas, en orden. */
  readonly gets: string[];
  /** Siembra una entrada, como si el operador o un tick anterior la hubiera escrito. */
  seed(key: string, value: string): void;
}

export function fakeThreadsKv(): FakeThreadsKv {
  const store = new Map<string, string>();
  const puts: { key: string; value: string }[] = [];
  const gets: string[] = [];

  const kv = {
    put(key: string, value: string): Promise<number> {
      puts.push({ key, value });
      store.set(key, value);
      return Promise.resolve(puts.length);
    },
    get(key: string): Promise<{ string(): string } | null> {
      gets.push(key);
      const value = store.get(key);
      // `get()` devuelve `null` cuando la clave no existe — NO lanza. Reproducirlo es lo que hace
      // que el doble sea util: es el comportamiento del que depende `lookupThread()`.
      return Promise.resolve(value === undefined ? null : { string: (): string => value });
    },
  } as unknown as KV;

  return {
    kv,
    puts,
    gets,
    seed(key: string, value: string): void {
      store.set(key, value);
    },
  };
}
