import { convert } from 'html-to-text';

/**
 * El `body`: precedencia texto/HTML y recorte del citado.
 *
 * Es la parte de mayor riesgo de la story, por dos motivos independientes:
 *
 * 1. El hallazgo del `text` sintetizado (ver `normalize.ts`): con `skipHtmlToText: true` cableado en
 *    el parseo, `toPlainText` puede confiar en que `parsed.text` refleja UNICAMENTE una parte
 *    `text/plain` real, nunca una sintesis del HTML.
 * 2. El Riesgo 3 del REQ-002: el recorte del texto citado (`trimQuotedText`) es una heuristica
 *    BEST-EFFORT, sin estandar, y se PORTA del servicio existente (`grava-gestion/mail-integration`
 *    v1.0.0, Arq-9) en vez de reinventarse. No entra ninguna libreria de recorte de texto citado.
 */

/** La forma minima de `ParsedMail` que esta funcion necesita, para no acoplarse al tipo completo. */
interface PlainTextSource {
  readonly text?: string | undefined;
  readonly html: string | false;
}

/**
 * Devuelve el cuerpo en texto plano: la parte `text/plain` cuando tiene contenido, o el HTML
 * convertido cuando esa es la unica parte disponible. Vacio si no hay ninguna (CA-13, no es error).
 *
 * Con `skipHtmlToText: true` (cableado en `normalize.ts`), un mail solo-HTML deja `parsed.text`
 * como `''` (string vacio, FALSY) y uno sin ninguna parte lo deja `undefined`. Un `if (parsed.text)`
 * acertaria las cuatro combinaciones de la tabla verificada -- pero POR ACCIDENTE, apoyado en que
 * `''` y `undefined` son ambos falsy. El chequeo se escribe sobre el CONTENIDO no vacio del texto,
 * explicito, para que no se lea como un descuido:
 *
 * | Forma del mail      | `parsed.text`      | `parsed.html`   | Rama                     |
 * |----------------------|--------------------|-----------------|--------------------------|
 * | Solo texto           | `'plano'`          | `false`         | texto plano (CA-12)      |
 * | Solo HTML            | `''`               | `'<p>...</p>'`  | convertir con html-to-text (CA-11) |
 * | Texto y HTML         | `'plano'`          | `'<p>htm</p>'`  | gana el texto plano (CA-12) |
 * | Ninguno              | `undefined`        | `false`         | vacio (CA-13)            |
 */
export function toPlainText(parsed: PlainTextSource): string {
  const hasPlainText = parsed.text !== undefined && parsed.text.length > 0;
  if (hasPlainText) return parsed.text as string;

  if (parsed.html !== false) {
    // Opciones EXACTAS del servicio existente (verificadas): sin ellas, CA-11 no se cumple.
    return convert(parsed.html, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    });
  }

  return '';
}

/** Linea que empieza (tras whitespace opcional) con `>`: bloque citado clasico. */
const QUOTE_PREFIX = /^\s*>/;
/** Separador ingles `On <...> wrote:` (tolera contenido intermedio; case-insensitive). */
const ON_WROTE = /^\s*On\b.*\bwrote:\s*$/i;
/** Separador espanol `El <...> escribio:` (acepta `escribio` sin tilde; case-insensitive). */
const EL_ESCRIBIO = /^\s*El\b.*escribi[oó]:\s*$/i;
/** Separador `-----Original Message-----` (tolera cantidad de guiones/espacios). */
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
/** Separador Outlook: linea de solo guiones bajos (>=5) antes del `From:` citado. */
const OUTLOOK_UNDERSCORES = /^\s*_{5,}\s*$/;

const QUOTE_MARKERS = [QUOTE_PREFIX, ON_WROTE, EL_ESCRIBIO, ORIGINAL_MESSAGE, OUTLOOK_UNDERSCORES];

function isQuoteMarker(line: string): boolean {
  return QUOTE_MARKERS.some((re) => re.test(line));
}

/**
 * Recorta el texto citado del hilo anterior: heuristica BEST-EFFORT, NO UNA GARANTIA (Riesgo 3).
 *
 * Se conserva del servicio existente sin reinventarse. Corta desde la PRIMERA linea que sea
 * marcador; si ninguna matchea, PREFIERE CONSERVAR y devuelve el cuerpo entero -- un falso positivo
 * que recorta contenido legitimo del cliente es el fallo caro, no el que deja pasar una cita sin
 * recortar. El `.trim()` final (no `.trimEnd()`) es lo que deja `''` cuando el reply era solo cita.
 *
 * Pura y nunca lanza, incluido con `''`.
 */
export function trimQuotedText(body: string): string {
  if (!body) return '';
  const lines = body.split(/\r?\n/);
  const cutIndex = lines.findIndex((line) => isQuoteMarker(line));
  const kept = cutIndex === -1 ? lines : lines.slice(0, cutIndex);
  return kept.join('\n').trim();
}
