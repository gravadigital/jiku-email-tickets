# ADR-001: Worker único sin persistencia propia

**Status:** Accepted (matizada el 2026-09-08 por REQ-005 / S-025)
**Date:** 2026-08-26
**Amended:** 2026-09-08 — el conector pasa a usar dos buckets KV de NATS como su mecanismo de
estado. **El título ya decía lo correcto y no cambia: "sin persistencia PROPIA".** El matiz exacto
es que el conector no administra un almacén propio —sigue sin base de datos, sin migraciones, sin
cliente de PostgreSQL y sin nada en `docs/db-schemas/`—, sino que usa un almacén **del bus**, que ya
era su dependencia. Lo que se deroga es la lectura absoluta de *"no persiste NADA"*.
**Deciders:** Technical Leader, Product Owner
**Tags:** arquitectura, servicios, persistencia, idempotencia, kv

## Context

El conector convierte mails en requisitos de Jiku. Su predecesor,
`grava-gestion/mail-integration` v1.0.0, es un servicio con base de datos propia: escribe directo en
PostgreSQL con Sequelize (6 modelos, 6 repositorios) y sube a S3 con credenciales propias. Al portarlo
a la arquitectura de Jiku hay que decidir dos cosas independientes: **en cuántos servicios se parte**
y **si conserva persistencia propia**.

**Sobre la partición.** El dominio tiene tres bounded contexts naturales —Ingesta, Ruteo,
Publicación— y la tentación es un servicio por cada uno.

**Sobre la persistencia.** El servicio actual usa la base para dos cosas: resolver
`ticket_slug → proyecto`, y mapear `Message-Id → requisito` para rutear las respuestas de un hilo a
comentarios. La segunda función queda fuera del alcance v1; la primera se resuelve de otra forma
(ver [ADR-004](ADR-004-mapa-tickets-kv-local.md)).

**Restricciones que condicionan la decisión:**

- **`core` es el único escritor de la base de Jiku** (ADR-001 de Jiku). La api conecta con un rol de
  PostgreSQL sin `INSERT`/`UPDATE`/`DELETE`. El conector se somete a la misma regla.
- **El `max_payload` del bus NATS es 1 MB** y los adjuntos llegan a 10 MB.
- **Jiku no tiene idempotencia en su plano de escritura** (ADR-002 de Jiku): sin JetStream, *"un
  comando perdido es un comando perdido"* — sin cola, reintento, persistencia ni idempotencia.
- Alcance v1: **no modificar el producto Jiku** (G-03).

## Decision

**Un solo servicio propio, sin base de datos, sin estado persistido de ninguna clase.**

Los tres bounded contexts son **módulos internos** del mismo proceso, comunicados por llamada de
función, secuencialmente, un mail a la vez.

El **único mecanismo de idempotencia es el flag `\Seen` de IMAP**, que vive en el servidor de mail.
El conector no persiste nada: los mails normalizados viven en memoria durante un tick y se descartan
al terminar.

> **Matizado por REQ-005 (2026-09-08).** *"No persiste nada"* pasa a ser **"no tiene persistencia
> propia"**. Desde S-025 el conector mantiene estado en **dos buckets KV del bus de Jiku**: el Mapa
> de Tickets (`slug → projectId`, que administra un operador) y el Mapa de Hilos
> (`sha256(Message-Id) → requirementId`, que el conector escribe en cada mail). Sigue sin haber base
> de datos, migraciones, cliente de base ni documento en `docs/db-schemas/`: un bucket KV no es
> ninguna de esas cosas, y el almacén es una dependencia que el conector ya tenía.
>
> **Lo que NO cambia, y es lo que esta ADR realmente decide:** el `\Seen` de IMAP sigue siendo el
> **único** mecanismo de idempotencia, y las dos pérdidas de abajo siguen aceptadas tal cual. El KV
> **no debe** aprovecharse para idempotencia — sería otra decisión, con su propio análisis, y no la
> tomó REQ-005. Los mails normalizados siguen viviendo en memoria durante un tick y descartándose al
> terminar.

**Se acepta explícitamente que no hay garantía de entrega en ninguna de las dos direcciones:**

- **Se pierde un ticket.** El mail se marca `\Seen` y el comando falla después. El mail queda leído y
  el requisito no existe. No hay reintento y no hay rastro más que el log.
- **Se duplica un ticket.** El comando escribe y el proceso muere antes de marcar `\Seen`. El próximo
  tick lo reprocesa y crea un segundo requisito idéntico.

La razón de aceptarlo: **un conector con idempotencia real sería más fuerte que el producto al que le
escribe.** La alternativa —estado propio persistido— le agrega al conector un volumen que hay que
respaldar, para cubrir un caso que el resto del sistema no cubre.

**Queda registrado como el candidato número uno a revisar** si la pérdida silenciosa resulta
intolerable en la práctica. El lugar donde el producto lo resolvería no es este repositorio: es su
feature group de Durabilidad y Observabilidad de la Escritura.

## Implementation Rules

- El proyecto MUST ser un único proceso Node.js sin servidor HTTP: no expone puerto, no tiene
  framework web, no define rutas
- El proyecto MUST NOT declarar dependencias de acceso a base de datos: `pg`, `sequelize`,
  `sequelize-typescript`, `typeorm`, `prisma`, `knex` o equivalentes
- El proyecto MUST NOT declarar `@aws-sdk/client-s3` ni ningún cliente de storage con credenciales
- El proyecto MUST NOT persistir estado en disco: sin archivos de estado, sin SQLite, sin caché en
  disco, sin volumen montado de escritura
- El único mecanismo de deduplicación MUST ser el flag `\Seen` de IMAP, aplicado con
  `messageFlagsAdd` por UID
- Un mensaje MUST marcarse `\Seen` en el mismo paso en que se descarga y parsea, antes de publicar el
  comando
- Un mensaje que no se pudo descargar MUST NOT marcarse `\Seen` (así el próximo tick lo reintenta)
- Un comando fallido MUST NOT reintentarse: se loguea y se descarta el mail
- El procesamiento MUST ser secuencial: un mail a la vez, un tick a la vez, sin `Promise.all` sobre
  mails ni sobre ticks
- Los tres módulos internos (Ingesta, Ruteo, Publicación) MUST comunicarse por llamada de función
  dentro del proceso, sin transporte intermedio
- El despliegue MUST correr **exactamente 1 instancia** por casilla de mail

## Consequences

### Positive

- **Cero infraestructura de datos:** sin migraciones, sin backup, sin volumen que respaldar, sin un
  segundo esquema que mantener. Es la ventaja operativa más concreta del diseño.
- **Cinco dependencias menos y dos capas enteras que desaparecen** respecto del servicio actual: los
  6 modelos y los 6 repositorios de Sequelize dejan de existir.
- **Coherente con el producto al que le escribe.** No introduce una garantía que Jiku no tiene, así
  que no crea la expectativa de que el sistema completo la tenga.
- **Testeable sin base:** desaparece la necesidad de testcontainers de PostgreSQL. Lo que hay que
  doblar es el bus y el IMAP.
- **Log legible:** el procesamiento secuencial hace que el log se lea en orden, que en un servicio sin
  nadie mirando es lo único que queda.
- **No se puede partir mal:** un solo proceso no tiene consistencia distribuida que romper.

### Negative

- **Se pierden tickets, en silencio.** Es la consecuencia más grave y no está mitigada: un comando
  fallido deja el mail leído y el requisito inexistente, y el único rastro es una línea de log.
- **Se duplican tickets** si el proceso muere entre el comando exitoso y el marcado `\Seen`.
- **No escala horizontalmente.** Dos instancias sobre la misma casilla duplicarían tickets: el cap
  por tick y el intervalo del cron son el único control de caudal.
- **Agregar un slug al Mapa de Tickets exige reiniciar** el proceso.
- **El throughput está acotado** por el procesamiento secuencial. Con el volumen esperado (decenas de
  mails por día) no es un problema, pero es un techo real.

### Risks

- **Riesgo: la pérdida silenciosa resulta intolerable en producción** y nadie se da cuenta hasta que
  un cliente reclama por un pedido que nunca apareció.
  - **Mitigación parcial:** el log distingue cada motivo de fallo con su `Message-Id`, así que el
    ticket perdido es *reconstruible* a mano desde la casilla (el mail sigue ahí, leído). No está
    mitigado el hecho de que nadie mire.
  - **Mitigación real, pendiente:** métrica de comandos fallidos, que hoy está fuera de alcance.
- **Riesgo: el volumen crece más de lo esperado** y el procesamiento secuencial con cap de 50 por tick
  genera backlog permanente.
  - **Mitigación:** el cap y el cron son configurables, y el orden es *los más nuevos primero*, así
    que el pedido reciente no espera detrás del backlog. Si no alcanza, la salida es paralelizar
    dentro del tick antes que partir el servicio.
- **Riesgo: alguien despliega dos instancias** por error (un scale-up automático, un rolling deploy
  mal configurado) y se duplican todos los tickets.
  - **Mitigación:** queda documentado en la estrategia de deployment y en NFR-SC03. No hay guard
    técnico — es una restricción operativa.

## Alternatives Considered

### Alternativa 1: Tres servicios (Ingesta, Ruteo, Publicación)

**Pros:**
- Separación física de los bounded contexts
- Escalado independiente de la ingesta respecto de la publicación

**Cons:**
- Habría que **transportar el mail completo con sus adjuntos** entre los servicios, y el
  `max_payload` del bus es 1 MB contra adjuntos de hasta 10 MB
- Obligaría a un **storage intermedio** sólo para pasar el mail de un servicio al siguiente
- Tres despliegues, tres configuraciones y tres identidades en el bus para un worker que procesa
  decenas de mails por día

**Why rejected:** El transporte entre servicios es un problema que sólo existe si se parte. Resolverlo
con un storage intermedio es pagar infraestructura para crear una separación que nadie pidió.

---

### Alternativa 2: Base de datos propia con idempotencia real

**Pros:**
- **Elimina la doble falla:** ni se pierde ni se duplica un ticket
- Habilita el ruteo de respuestas a comentarios (el mapa `Message-Id → requisito`)
- Permite reintentar un comando fallido

**Cons:**
- **Sería más fuerte que el producto al que le escribe:** Jiku ya asume que un comando perdido es un
  comando perdido. La garantía se detendría en el borde del conector
- Agrega un volumen que hay que respaldar, migraciones que correr, y un segundo esquema que mantener
- Reintroduce las cinco dependencias que este diseño elimina

**Why rejected:** El costo es una infraestructura de datos completa; el beneficio es una garantía que
el resto del sistema no ofrece, así que no se propaga. **Es la alternativa a reconsiderar primero** si
la pérdida silenciosa resulta intolerable — y el lugar correcto para resolverla es el plano de
escritura de Jiku, no un parche en el conector.

---

### Alternativa 3: Idempotencia sin base, por búsqueda en Jiku

Consultar Jiku antes de crear, para ver si ya existe un requisito de ese `Message-Id`.

**Pros:**
- Evita el duplicado sin persistencia propia

**Cons:**
- **No hay dónde buscar:** el `Message-Id` no se guarda en ningún campo del Requisito
- Exigiría el plano de lectura del bus, que este diseño evita (ver
  [ADR-004](ADR-004-mapa-tickets-kv-local.md))
- No resuelve la otra mitad del problema: el ticket **perdido** seguiría perdiéndose

**Why rejected:** No es implementable sin modificar el producto (agregar el `Message-Id` al Requisito),
y resolvería sólo una de las dos fallas.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-1, Arq-2, Arq-10, Arq-14
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 1 (idempotencia),
  decisión 2 (escritura)
- [PRD — Requerimientos](../prd/requirements.md) — NFR-R01, NFR-R02, NFR-R03, NFR-SC03; invariantes
  19 y 20
- [PRD — Arquitectura](../prd/architecture.md)
- ADR-001 de Jiku (`core` como único escritor), ADR-002 de Jiku (sin JetStream)
