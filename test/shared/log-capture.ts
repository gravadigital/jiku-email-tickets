import type pino from 'pino';

/**
 * Un destino en memoria para el logger.
 *
 * Existe como helper y no embebido en un archivo de test porque S-004 y S-005 lo necesitan: sus
 * lineas de diagnostico —el fallo de conexion, las siete clases de error del SDK— son
 * comportamiento afirmable, no decoracion, y esta es la infraestructura que las hace afirmables sin
 * escribir a la salida de CI.
 */
export interface LogCapture {
  /** El destino que se le pasa a `createLogger(config, destination)`. */
  readonly stream: pino.DestinationStream;
  /** Las lineas emitidas, ya parseadas. */
  lines(): Record<string, unknown>[];
  /**
   * Las lineas crudas, sin parsear.
   *
   * NO es un extra: la asercion que de verdad detecta una filtracion es "la linea serializada no
   * contiene la subcadena del secreto", y eso se afirma sobre el string. Sobre el objeto parseado no
   * se puede detectar un secreto que se filtro por un campo inesperado.
   */
  raw(): string[];
  /** Descarta lo capturado hasta ahora. */
  clear(): void;
}

export function createLogCapture(): LogCapture {
  const chunks: string[] = [];

  return {
    // Pino escribe a cualquier objeto con `write(str)`. Un sink sincronico como este no bufferiza:
    // la linea esta disponible en cuanto `logger.info()` retorna. Es lo que evita el peor modo de
    // falla de esta suite — leer `lines()` antes del flush, encontrar vacio, y pasar en verde.
    stream: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },

    raw(): string[] {
      return chunks.flatMap((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''));
    },

    lines(): Record<string, unknown>[] {
      return this.raw().map((line) => JSON.parse(line) as Record<string, unknown>);
    },

    clear(): void {
      chunks.length = 0;
    },
  };
}
