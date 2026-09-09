---
date: 2026-09-08
story: S-025
request: REQ-005
service: jiku-mail-connector
---

# S-025 — El Mapa de Tickets se muda al KV con `watch()`

## Qué cambió

El Mapa de Tickets deja de ser configuración inline y pasa a ser un bucket KV del bus, seguido con
`watch()` sobre una copia en memoria. **Agregar un proyecto ya no necesita un redeploy:** un
`nats kv put` aparece en el ruteo en segundos, con el worker corriendo.

Cierra la Parte 1 de REQ-005.

### Lo que se eliminó

`TICKET_MAP`, `TICKET_MAP_FILE`, `parseTicketMap()` y la regla cross-field de las dos fuentes. Con
ella se fue **`createFinalSchema` entero**, que existía sólo para hospedarla: el schema vuelve a ser
un diccionario de claves independientes y su validación vuelve a ser **pura** — ya no lee el
filesystem, que era la excepción que había que justificar.

### Lo que se agregó

`src/infra/kv/ticket-map.ts` con `startTicketMapWatch()`, cableado como paso 5.6 del arranque, y
`stopTicketMapWatch` en el apagado ordenado — **antes** de cerrar el bus, porque el watch corre sobre
esa conexión.

## Los cinco hallazgos verificados

Se sondeó `@nats-io/kv@3.4.0` contra un NATS real en vez de deducir de la documentación. Tres de los
cinco son bugs silenciosos que la implementación intuitiva tendría:

1. **Un bucket vacío no emite NUNCA ningún entry.** Esperar la carga inicial como "el primer entry
   con `isUpdate: true`" **cuelga `runStartup()` para siempre** contra un bucket vacío — que es el
   estado del **primer arranque de todo despliegue nuevo**. El proceso queda vivo, sin log, sin
   schedular el tick y sin morirse: **cero síntoma**. Se resuelve leyendo `status().values` antes de
   arrancar el watch.
2. **El último entry de la carga inicial ya trae `isUpdate: true`**, así que hay que aplicar la
   entrada *antes* de resolver la espera o se pierde.
3. **Cuando el watch se cae, el `for await` termina NORMALMENTE, no lanza.** Un `try/catch` no
   detecta la caída más común: el loop sale por la puerta de adelante y nadie reintenta. La detección
   va después del loop.
4. **Un `delete` llega como `operation: 'DEL'` con el valor vacío.** Aplicar todo como `set()` deja
   un slug borrado ruteando para siempre; parsear el valor antes de mirar la operación da `NaN`.
5. **`entry.json()` lanza** con un valor cargado a mano que no sea JSON válido, así que el parseo es
   propio y tolerante: la entrada mala se ignora con un `warn` que nombra la clave, y el watch sigue.

## Decisiones que conviene conocer

- **El arranque espera la carga inicial completa.** Schedular el primer tick con el mapa a medio
  llenar descartaría como `slug_no_mapeado` mails de slugs que sí están cargados, y un descarte es
  definitivo (el mail queda `\Seen`).
- **Si el watch se cae, el mapa NO se vacía.** Se conserva la última copia buena y se reintenta cada
  `KV_WATCH_RETRY_MS`. Vaciarlo convertiría una caída del bus en pérdida de tickets.
- **Una entrada inválida se ignora, no tumba el arranque.** Es una **inversión** respecto de S-012,
  donde un mapa mal formado era fail-fast: un dato malo cargado a mano no debe dejar sin ruteo a los
  demás proyectos, y con el mapa en el KV ya no hay un "momento de carga" en el que fallar.
- **El `Map` es el mismo objeto durante toda la vida del proceso.** El watch lo muta y nunca lo
  reemplaza; una copia defensiva rompería la vivacidad **sin fallar en compilación** — el conector
  rutearía los slugs iniciales y no vería ninguno nuevo jamás.

## Documentación

**ADR-004 reformulada** (el mapa vive en el bus, la consecuencia negativa "exige reiniciar el
proceso" queda **derogada**) y **ADR-001 matizada** ("no persiste nada" → "no tiene persistencia
propia"; el `\Seen` sigue siendo el único mecanismo de idempotencia y el KV **no** debe aprovecharse
para eso). El flujo de arranque gana el Paso 5.6 con los cinco hallazgos y pierde la regla
cross-field del Paso 1. README, `.env.example` y overview actualizados.

## Tests

**Suite completa: 70 archivos, 943 tests en verde.** Diez casos de otros archivos afirmaban la
existencia de lo eliminado; cada uno se **invirtió** (documentando el cambio) o se **eliminó** cuando
probaba un mecanismo que ya no existe — ninguno se borró para hacer pasar la suite. Las listas de
variables requeridas de `build-runtime` y `docker-image` **encogieron por segunda vez** en la
historia del proyecto.
