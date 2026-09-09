# ADR-006: Observabilidad por logs estructurados a stdout, con el origen del rechazo explícito

**Status:** Accepted (matizada el 2026-09-08 por REQ-005 / S-026)
**Date:** 2026-08-26
**Amended:** 2026-09-08 — el catálogo de motivos de descarte pasa de **cinco a seis** literales, y la
línea de métricas del tick pasa de **cinco a seis** contadores. Lo que la ADR decide —que cada mail
deje rastro, que el motivo sea un literal exacto y que el tick emita una línea de métricas— no cambia:
lo que cambia es la enumeración de dos catálogos que la ADR fija por extensión. Ver la nota al pie de
las Implementation Rules.
**Deciders:** Technical Leader
**Tags:** observabilidad, logging, manejo-de-errores, operabilidad

## Context

**En Jiku, cuando una escritura falla, hay un usuario mirando una pantalla que recibe un error. Acá no
hay nadie.** El cliente mandó un mail y se fue; no hay request que responder ni interfaz donde mostrar
un problema. **Un ticket perdido no tiene síntoma.**

Eso convierte a la observabilidad en la preocupación transversal más importante de este producto, y no
por su valor de diagnóstico: **el log es el único lugar donde un mail perdido deja rastro.** Y la
pérdida es un estado esperado del diseño, no un accidente
([ADR-001](ADR-001-worker-unico-sin-persistencia.md)).

**Dos antecedentes concretos que condicionan la decisión:**

1. **Jiku tiene los transports de archivo de sus dos backends con `filename: undefined` en
   producción**, porque las variables no están en el compose. Es decir: sus logs a archivo no existen
   y nadie se dio cuenta. El conector no puede repetir ese error, porque acá el log no es un
   accesorio.
2. **Tres sistemas distintos pueden rechazar un comando, por razones distintas y con arreglos
   distintos**: el bus (por subject), `core` por rol, y `core` por forma. Un log que diga "falló el
   comando" no sirve: los tres arreglos están en lugares diferentes (Zitadel, la fila en `users`, el
   payload del conector).

**Restricción de alcance:** healthchecks, métricas exportadas y alertas están fuera del alcance v1.
Jiku no tiene healthcheck en ninguno de sus cuatro servicios; es el mismo hueco y ninguno de los dos
lo resuelve acá.

## Decision

**Logs estructurados a stdout, JSON en producción, nunca a archivo. Y el log distingue explícitamente
qué sistema rechazó cada comando.**

### Transporte

| Pieza | Definición |
|---|---|
| Destino | **stdout**, siempre. Nunca archivo |
| Formato | Estructurado; **JSON en producción** |
| Nivel default | `info` |
| A quién le reporta un fallo | **A nadie.** No hay usuario esperando ni request que responder |
| Métricas por tick | `ingestados`, `parseados`, `creados`, `descartados`, `fallidos`, `comentados` (S-026) |
| Healthcheck | **Fuera de alcance v1** |

### Qué nunca se loguea

Credenciales, tráfico IMAP crudo, **el cuerpo del mail** y el contenido de un adjunto. El cuerpo es
contenido de negocio y puede traer datos del cliente: el log es el único rastro de un ticket perdido,
**pero sigue siendo un log, no un depósito de datos del cliente**.

### El origen del rechazo, explícito

Cada fallo de comando se loguea con la clase de error del SDK, porque **es la diferencia entre "no
puedo escribir" y saber dónde mirar**:

| Clase del SDK | Quién rechazó | Dónde está el arreglo |
|---|---|---|
| `JikuPermissionDenied` | **El bus**, por subject, antes de que `core` viera nada | El rol en Zitadel. **No implica nada sobre `core`** |
| `JikuFailure` / `caller_not_authorized` | El bus dejó pasar; **`core` rechazó por rol** | Típicamente sin fila en `users`. **Reconectar lo corrige solo** |
| `JikuFailure` / `invalid_fields` | `core` aceptó el caller y rechazó **la forma** | El payload. **Es prueba de que el plano de escritura está abierto** |
| `JikuFailure` / `project_not_found` | `core`: el proyecto no existe | El Mapa de Tickets |
| `JikuTimeout` | Nada respondió: `core` caído o lento | **El mail se perdió** (ya está `\Seen`), sin reintento |
| `JikuNoEndpoint` | El bus dice **de inmediato** que nada está suscripto | Sin esperar el timeout |
| `JikuInvalidRequest` | Rechazado **localmente**: nada llegó a la red | Error de armado del conector |

Un `errorCode` que el conector no conoce se loguea con su `code` y su `hint()`, **sin mapearlo a
nada**: el conector no tiene a quién responderle.

### El timeout, que es una decisión de observabilidad

**No bajar el timeout por debajo del default del SDK (15 s).** Son 15 s a propósito, **por encima** de
los 10 s del servidor: PostgreSQL corta a los 8 s y la respuesta llega como un error que se explica
solo. **Un timeout más corto del lado del cliente convierte esa explicación en silencio**, que es el
peor resultado posible en un servicio sin nadie mirando.

## Implementation Rules

- Los logs MUST ir a **stdout**. MUST NOT configurarse ningún transport de archivo, en ningún entorno
- El formato MUST ser **JSON en producción**
- El nivel por defecto MUST ser `info`, configurable por variable de entorno
- MUST NOT loguearse nunca: credenciales (IMAP, key JSON, token, creds de NATS), tráfico IMAP crudo, el
  cuerpo del mail (`body`), el contenido de un adjunto
- El cliente IMAP MUST configurarse con `logger: false`
- **Cada mail procesado MUST dejar al menos una línea de log** con su `messageId` y su resultado.
  Ningún mail termina sin rastro
- Un alta exitosa MUST loguear `messageId`, `projectId` y el `id` del requisito creado, juntos
- Un descarte MUST loguear `messageId` y el **motivo** (`sin_slug`, `slug_no_mapeado`, `es_respuesta`,
  `sin_message_id`, `no_parseable`, `hilo_desconocido`)
- Un descarte por slug no mapeado MUST incluir **el slug buscado** (es el dato que hace falta para
  cargarlo)
- Un fallo de comando MUST loguear la **clase de error del SDK** y, cuando exista, el `code` y el
  `hint()`. MUST NOT reducirse a un mensaje genérico de "falló el comando"
- Un `errorCode` desconocido MUST loguearse con su `code` y su `hint()` sin mapearse a otro error
- Cada tick MUST emitir una línea con los seis contadores: `ingestados`, `parseados`, `creados`,
  `descartados`, `fallidos`, `comentados`
- Un tick que difiere mails por el cap MUST loguear un `warn` con **cuántos** quedaron diferidos
- Un fallo del refresh del token MUST loguearse como `error` (vía `onTokenError`) sin terminar el
  proceso
- El timeout del comando MUST quedar en **15000 ms** (el default del SDK). **MUST NOT bajarse**
- Un tick salteado por solapamiento MUST loguear un `warn`
- MUST NOT implementarse endpoint de healthcheck ni exportador de métricas en v1

> **Matizado por REQ-005 / S-026 (2026-09-08).** Dos de las reglas de arriba enumeran un catálogo por
> extensión, y S-026 agrega un miembro a cada uno. Las dos reglas ya están escritas con el catálogo
> ampliado; esta nota registra **qué** cambió y **por qué**, para que no se lea como un error.
>
> **1. El catálogo de motivos de descarte pasa de cinco a seis: se agrega `hilo_desconocido`.**
>
> El literal es exacto, en minúscula con guión bajo, y se loguea tal cual — como los otros cinco.
> `es_respuesta` **se conserva**: no se reemplaza ni se depreca, y los dos conviven a propósito
> porque cubren situaciones distintas cuyo arreglo está en lugares distintos:
>
> - `hilo_desconocido` — *"esta respuesta apunta a un hilo que no conozco"*. El lookup al Mapa de
>   Hilos **sí se pudo hacer** y ninguna referencia matcheó. Cubre, indistinguibles a propósito, el
>   reenvío de un hilo interno con slug mapeado, una entrada expirada por el TTL de 90 días, y un
>   hilo anterior al despliegue. El arreglo, si lo hay, es del lado del hilo.
> - `es_respuesta` — pasa a cubrir, **además** de su significado original, *"no pude averiguar a qué
>   hilo apunta"*: el bucket de hilos estaba inaccesible y el lookup no se pudo hacer. El arreglo es
>   del lado de la infraestructura.
>
> Colapsarlos en un literal borraría exactamente la señal que distingue *cargar el hilo* de
> *arreglar el bucket*, que es la clase de distinción que esta ADR existe para preservar en el plano
> de los rechazos de comando.
>
> **2. La línea del tick pasa de cinco contadores a seis: se agrega `comentados`.**
>
> Cuenta los comentarios publicados sobre un Requisito existente desde una respuesta con match en el
> Mapa de Hilos. En S-026 queda **siempre en 0** —todavía no hay salida por comentario— y S-027 es
> quien lo empieza a incrementar; se emite desde ya para que la **forma** de la línea de métricas no
> cambie cuando eso pase.
>
> **Por qué es un contador separado y no se suma a `creados`:** `creados` cuenta **solo altas de
> Requisito**. Sumarlos borraría la distinción entre *"se creó un ticket nuevo"* y *"se comentó uno
> existente"* en la **única línea de métricas que el tick emite** — y esta ADR ya decidió que no hay
> healthcheck ni exportador de métricas en v1, así que esa línea es todo lo que hay. Es además la
> métrica que S-027 va a mirar para verificar que el comentario empezó a funcionar de verdad.

## Consequences

### Positive

- **Ningún mail termina sin rastro.** Es la propiedad central: cada mail deja una línea con su
  resultado, así que un ticket perdido es reconstruible a mano desde la casilla.
- **El diagnóstico apunta al lugar correcto.** Distinguir los tres sistemas que rechazan evita el peor
  caso real: mirar el payload cuando el problema está en Zitadel, o revisar Zitadel cuando falta una
  fila en `users`.
- **`invalid_fields` es información positiva:** confirma que el plano de escritura está abierto para
  esta identidad, que es exactamente lo que uno quiere saber al desplegar por primera vez.
- **Logs que existen.** stdout no depende de que una variable de entorno esté en el compose, que es
  precisamente cómo Jiku perdió los suyos.
- **Sin datos del cliente en los logs**, así que el log puede compartirse para diagnóstico sin
  revisar qué contiene.
- **El timeout largo preserva el mensaje de error** que PostgreSQL genera al cortar, en vez de
  convertirlo en un timeout mudo.

### Negative

- **No hay alertas.** Nadie se enterará de un fallo salvo que mire los logs. Es el hueco más grande y
  está declarado, no resuelto.
- **Sin healthcheck**, así que un orquestador no puede saber si el worker está sano — sólo si el proceso
  vive.
- **Sin métricas exportadas:** las seis métricas de éxito del PRD son propuestas, no medidas. No se
  puede saber si "tickets creados sobre mails con slug válido > 99%" se cumple.
- **El cuerpo del mail no está en el log**, así que reconstruir qué pedía un ticket perdido exige ir a
  la casilla. Es el intercambio correcto, pero es un costo real de diagnóstico.
- **Los ocho eventos de dominio son sólo líneas de log.** `PublicacionRechazada` es el más valioso del
  conjunto y su único destino es stdout.
- **El timeout de 15 s hace que un `core` caído tarde 15 s por mail** en fallar. Con el cap de 50 por
  tick, un tick completo contra un `core` muerto puede tardar más de 12 minutos.

### Risks

- **Riesgo: nadie mira los logs y una pérdida sistemática pasa inadvertida** durante semanas —el
  escenario que este ADR mitiga sólo a medias.
  - **Mitigación:** ninguna real en v1. Es el argumento más fuerte para que las métricas exportadas
    salgan de "fuera de alcance". El lugar de resolución está identificado: el feature group de
    Durabilidad y Observabilidad de la Escritura del producto Jiku.
- **Riesgo: el volumen de logs crece y se rota/descarta antes de que alguien investigue** un ticket
  perdido.
  - **Mitigación parcial:** el volumen es bajo (decenas de mails por día, una línea por mail más una
    por tick). La retención depende de quien recoja stdout — pendiente de operaciones.
- **Riesgo: alguien agrega un log de debug que imprime el mail completo** y los datos del cliente
  terminan en los logs.
  - **Mitigación:** la regla está en Implementation Rules, verificable en code review. No hay guard
    técnico.
- **Riesgo: alguien "optimiza" el timeout a 5 s** para que los ticks sean más rápidos, y convierte
  todos los errores explicados de PostgreSQL en timeouts mudos.
  - **Mitigación:** está como regla explícita con su razón. Es el tipo de cambio que parece una mejora
    y empeora exactamente lo que este ADR protege.

## Alternatives Considered

### Alternativa 1: Logs a archivo (como los dos backends de Jiku)

**Pros:**
- Persistencia local sin depender de quien recoja stdout
- Retención controlada por el propio servicio

**Cons:**
- **Es el error documentado de Jiku:** sus dos backends tienen `filename: undefined` en producción
  porque las variables no están en el compose. Los logs simplemente no existen y nadie lo notó
- Requiere volumen montado de escritura, que [ADR-001](ADR-001-worker-unico-sin-persistencia.md)
  elimina
- Rotación, permisos y espacio en disco como preocupaciones nuevas
- En un contenedor, el estándar es stdout: cualquier orquestador lo recoge sin configuración

**Why rejected:** Reintroduce el modo de falla exacto que este ADR existe para evitar, y contradice la
ausencia de volumen de escritura.

---

### Alternativa 2: Enviar los fallos a un canal externo (Mattermost, email, Sentry)

**Pros:**
- **Resuelve el problema real:** alguien se enteraría de un ticket perdido sin mirar logs
- `PublicacionRechazada` tendría un destino con lector

**Cons:**
- **Las notificaciones son un feature group del producto Jiku**, y decidir el canal acá lo prejuzgaría
- Agrega una integración de salida, con su credencial, su modo de falla y su ruido
- Un canal que se cae en silencio es peor que un log: da falsa confianza

**Why rejected:** Está fuera de alcance funcional por decisión de producto, no técnica. **Es la mejora
más valiosa pendiente**, y su lugar es el producto, donde se decide el canal para todo Jiku.

---

### Alternativa 3: Healthcheck y métricas Prometheus en v1

**Pros:**
- Permitiría alertar sobre `comandos fallidos > 0`, que es la métrica que importa
- Un orquestador podría reiniciar un worker enfermo

**Cons:**
- **Obligaría a exponer un puerto HTTP** en un servicio que deliberadamente no expone nada
  ([ADR-001](ADR-001-worker-unico-sin-persistencia.md))
- **Jiku no lo tiene en ninguno de sus cuatro servicios:** el conector tendría observabilidad que el
  producto al que le escribe no tiene, y no habría dónde agregarla
- Requiere infraestructura de scraping y alerting que hoy no existe

**Why rejected:** El hueco es del sistema completo, no de este conector, y resolverlo sólo acá crearía
una asimetría sin un consumidor de las métricas. Declarado fuera de alcance v1, no descartado.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-11, Arq-12, Arq-13; Flujo 4
  (los tres rechazos de un comando)
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 14; Transversales →
  Observabilidad
- [Análisis de dominio del discovery](../discovery/analisis-dominio.md) — invariante 22; sección
  "Eventos de Dominio" (los ocho son líneas de log)
- [PRD — Requerimientos](../prd/requirements.md) — C-19, C-28, C-29, C-30; NFR-P03, NFR-S06, NFR-O01 a
  NFR-O05
- [ADR-001](ADR-001-worker-unico-sin-persistencia.md) — la pérdida silenciosa que estos logs registran
- [ADR-002](ADR-002-sdk-oficial-del-bus.md) — las clases de error que hacen posible distinguir el origen
