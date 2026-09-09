---
date: 2026-09-09
story: S-028
request: REQ-005
service: jiku-mail-connector
---

# S-028 — Propiedades del sistema y verificación E2E del KV

## Qué cambió

**Ningún comportamiento nuevo.** Esta story cierra REQ-005 afirmando por tests las propiedades del
sistema completo con el KV, sobre `runTick()` cableado de punta a punta y contra un NATS real con
JetStream — no sobre módulos puros.

El único cambio en `src/` es un **docstring**: el de `comentados` decía todavía *"S-027 es quien lo
empieza a incrementar"*, en futuro, cuando S-027 ya lo incrementa.

### Lo que se agregó

- `test/ingesta/tick-propiedades-kv.test.ts` — las propiedades sobre el tick completo: la redacción
  con el KV en juego, la memoria de un mail a la vez extendida al comentario, los seis contadores sin
  contaminarse, y los dos writes.
- `test/infra/kv/e2e-kv.test.ts` — el ciclo de la respuesta de punta a punta y el fail-fast del
  bucket ausente.
- `test/infra/kv/e2e-watch-tick.test.ts` — el `watch()` en caliente: un slug nuevo rutea sin
  redeploy, y la degradación conserva el mapa.
- `test/infra/kv/preservacion-req-005.test.ts` — las propiedades que REQ-005 **no** debía romper: una
  sola conexión al bus, el `AppConfig` fuera del log, el `\Seen` como única marca de idempotencia, y
  el dedup intra-mail.
- `test/story-028-docs.test.ts` — que la documentación del alcance nuevo no se pudra.

## Decisiones de la planificación que evitaron inflar la suite

**Gran parte de S-028 ya estaba cubierta.** El plan abrió con una tabla de *"cobertura ya existente —
qué NO reescribir"* sobre 17 archivos de test: `tick-hilos.test.ts` solo ya afirmaba 25 escenarios
contra un KV real. Cada tarea declaró qué **extiende** y qué **no debe duplicar**, porque el modo de
falla típico de una story de cierre es agregar tests sin agregar confianza.

**CA-16 ya estaba satisfecho:** el README ya traía la precondición 8 con sus cuatro ítems y el
`--ttl=90d`, y `deployment-docs.test.ts` ya afirmaba las ocho precondiciones. La tarea se replanteó
como auditoría y delta, no reescritura — el riesgo real ahí era romper una aserción que ya cubría.

**Las referencias por número de línea de CA-5 estaban vencidas.** La story citaba
`test/bus/source-properties.test.ts:57-77`, pero el archivo creció y esas líneas ya no apuntan a los
tests que nombraba. Se anclaron **por nombre de test**, y el plan prohíbe explícitamente volver a
aserciones por número de línea.

**Ningún contenedor NATS nuevo.** Todos los tests reusan `startJetStreamNats()`, así que la carrera
del conteo de `shared-container.test.ts` no puede reaparecer.

## Verificación manual

`verificacion-e2e-manual.md` gana su **Parte 2** con los pasos del alcance del KV, todos con comandos
exactos: crear los dos buckets, sembrar el Mapa de Tickets, comprobar que **un slug nuevo rutea sin
redesplegar** (y el inverso, que borrarlo lo saca), y la respuesta que produce un comentario público
visible en Opus.

Existe porque `Client.fromConnection()` saltea el handshake de auth: hay cosas que **sólo** se
verifican contra un despliegue real, y ninguna suite puede afirmarlas.

## Estado de REQ-005

**Completo.** Las seis stories implementadas y mergeadas:

| Story | Qué cerró |
|---|---|
| S-023 | El SDK re-exporta el KV por su subpath `./nats` (otro repositorio) |
| S-024 | Apertura y verificación de los dos buckets sobre la conexión única |
| S-025 | El Mapa de Tickets se muda al KV con `watch()` — **fin del redeploy por proyecto nuevo** |
| S-026 | El Mapa de Hilos: la clave hasheada, el write y el lookup |
| S-027 | La publicación del comentario — **la respuesta del cliente deja de perderse** |
| S-028 | Las propiedades del sistema y la verificación E2E |

**Suite completa: 80 archivos, 1117 tests en verde.**

**Pendiente, y es una decisión del equipo:** publicar el minor `1.1.0` del SDK
`@gravadigital/jiku` (S-023, ya implementado y commiteado en su repo). Mientras no esté en el
registry, el conector lo consume por un tarball local (`vendor/`) y el `Dockerfile` lo copia; al
publicarlo, el rango vuelve a `^1.1.0` y `vendor/` se elimina.
