import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// El cliente NATS crudo sale del subpath del SDK, nunca de `@nats-io/*` ni de `nats` (ADR-002).
import { Empty, headers, type NatsConnection } from '@gravadigital/jiku/nats';

/**
 * Lo que hace U-02 con el CLI de NATS sobre el Espacio KV del conector: `nats kv put`, `nats kv
 * del`, y la clave COMPLETA que arma copiando el `kvPrefix` de la linea de arranque en la plantilla
 * que documenta el README.
 *
 * # POR QUE EL SUBJECT SE ARMA A MANO ACA, Y EN NINGUN OTRO LADO
 *
 * ADR-002 prohibe armar subjects a mano, y la regla es del CODIGO DE PRODUCCION: el conector nunca
 * escribe `$KV.JIKU_KV.…` — lo arma el `KV` del SDK, que agrega el prefijo `{instance}.{userId}.`
 * por su cuenta. Este archivo representa a OTRA cosa: al operador, que no tiene el SDK sino el CLI,
 * y escribe la clave entera (`<instance>.<sub>.tickets.<slug>`) en el bucket `JIKU_KV`. Eso es
 * exactamente un publish a `$KV.JIKU_KV.<clave completa>`, que es lo que hace `nats kv put`.
 *
 * Y es justo lo que CA-1 de S-033 quiere probar: que la clave que escribe un operador siguiendo el
 * README es la que lee el conector. Si el test escribiera por el `KV` del SDK, el prefijo lo
 * pondria el SDK y la prueba no diria nada sobre la plantilla documentada.
 *
 * # POR QUE LA PLANTILLA SE LEE DEL README
 *
 * `readmeTicketTemplate()` extrae la plantilla del `nats kv put` de la seccion del Mapa de Tickets
 * del README, y el E2E del operador la consume. Asi el comando documentado y el que usa el test NO
 * PUEDEN divergir: si alguien cambia la plantilla del README a una clave que el conector no lee, el
 * E2E falla; si cambia la forma de la clave en el codigo, tambien.
 */

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** El prefijo que la plantilla documentada tiene que tener: lo que el operador copia del log. */
export const TEMPLATE_PREFIX = '<instance>.<sub>.';

/** El subject de una clave del bucket `JIKU_KV`: lo que `nats kv put JIKU_KV <clave>` publica. */
const KV_SUBJECT_PREFIX = '$KV.JIKU_KV.';

/**
 * La plantilla de clave del primer `nats kv put JIKU_KV <plantilla> <projectId>` de `text`.
 * Lanza con un mensaje que nombra el documento si no la encuentra.
 */
export function ticketTemplateIn(text: string, where: string): string {
  const match = /nats kv put JIKU_KV (\S+) <projectId>/.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(
      `No se encontro la plantilla "nats kv put JIKU_KV <clave> <projectId>" en ${where}. La ` +
        'plantilla de la clave del Mapa de Tickets es contrato: la usa el E2E del operador.',
    );
  }
  return match[1];
}

/** La subseccion `#### El Mapa de Tickets…` del README, hasta el siguiente `####`. */
export function readmeTicketMapSection(): string {
  const readme = readFileSync(`${PROJECT_ROOT}README.md`, 'utf8');
  const start = readme.indexOf('#### El Mapa de Tickets');
  if (start === -1) {
    throw new Error('El README no tiene la subseccion "#### El Mapa de Tickets…".');
  }
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n#### ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** La plantilla de clave del Mapa de Tickets que documenta el README (`<instance>.<sub>.tickets.<slug>`). */
export function readmeTicketTemplate(): string {
  return ticketTemplateIn(readmeTicketMapSection(), 'la seccion del Mapa de Tickets del README');
}

/**
 * Llena una plantilla de clave como lo haria el operador: `<instance>.<sub>.` por el `kvPrefix` de
 * la linea de arranque, y cada `<placeholder>` restante por su valor.
 */
export function fillTemplate(template: string, values: { kvPrefix: string } & Record<string, string>): string {
  if (!template.startsWith(TEMPLATE_PREFIX)) {
    throw new Error(`La plantilla "${template}" no empieza con "${TEMPLATE_PREFIX}".`);
  }
  let filled = values.kvPrefix + template.slice(TEMPLATE_PREFIX.length);
  for (const [name, value] of Object.entries(values)) {
    if (name === 'kvPrefix') continue;
    filled = filled.replaceAll(`<${name}>`, value);
  }
  if (/<[^>]+>/.test(filled)) {
    throw new Error(`La plantilla "${template}" quedo con placeholders sin llenar: ${filled}`);
  }
  return filled;
}

/** La clave completa de un slug, armada con la plantilla del README y el `kvPrefix` del log. */
export function operatorTicketKey({ kvPrefix, slug }: { kvPrefix: string; slug: string }): string {
  return fillTemplate(readmeTicketTemplate(), { kvPrefix, slug });
}

/** El PubAck de JetStream a un publish sobre el stream del bucket. */
export interface PubAck {
  readonly stream: string;
  readonly seq: number;
}

function parseAck(reply: { string(): string }, fullKey: string): PubAck {
  const ack = JSON.parse(reply.string()) as Partial<PubAck> & { error?: unknown };
  if (ack.error !== undefined || typeof ack.stream !== 'string' || typeof ack.seq !== 'number') {
    // Un ack con error es un fallo del HELPER, no un estado a afirmar: el escenario seguiria
    // probando contra una clave que nunca se escribio.
    throw new Error(`JetStream rechazo la escritura de ${fullKey}: ${reply.string()}`);
  }
  return { stream: ack.stream, seq: ack.seq };
}

/** `nats kv put JIKU_KV <fullKey> <value>`: un publish con ack al subject de la clave completa. */
export async function operatorPut(
  connection: NatsConnection,
  fullKey: string,
  value: string,
): Promise<PubAck> {
  const reply = await connection.request(KV_SUBJECT_PREFIX + fullKey, value);
  return parseAck(reply, fullKey);
}

/**
 * `nats kv del JIKU_KV <fullKey>`: un mensaje vacio en el MISMO subject con el header
 * `KV-Operation: DEL` (lo mismo que hace el `delete()` del SDK). Con `deny_delete: true` el stream
 * lo admite: es una escritura, no el borrado de un mensaje.
 */
export async function operatorDel(connection: NatsConnection, fullKey: string): Promise<PubAck> {
  const h = headers();
  h.set('KV-Operation', 'DEL');
  const reply = await connection.request(KV_SUBJECT_PREFIX + fullKey, Empty, { headers: h, timeout: 5_000 });
  return parseAck(reply, fullKey);
}
