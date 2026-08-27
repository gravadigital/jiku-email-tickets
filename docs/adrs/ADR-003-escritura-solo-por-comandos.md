# ADR-003: Toda escritura por comandos del bus, con el byte fuera de banda

**Status:** Accepted
**Date:** 2026-08-26
**Deciders:** Technical Leader
**Tags:** integracion, escritura, bus, storage, adjuntos

## Context

El conector tiene que crear requisitos con adjuntos en Jiku. El servicio predecesor lo hace de la
forma directa: `INSERT` en PostgreSQL con Sequelize, y `PutObject` a S3 con credenciales propias.
**En Jiku no puede hacer ninguna de las dos cosas**, y no por preferencia de diseño:

- **La base tiene un solo escritor.** ADR-001 de Jiku: la api conecta con un rol de PostgreSQL sin
  `INSERT`/`UPDATE`/`DELETE`, y `core` es el único escritor. Su Implementation Rule es explícita:
  *"Toda escritura de dominio nueva DEBE implementarse como comando en `core`"*.
- **El storage tiene un solo dueño**, y también es `core`: *"la api no guarda credenciales de S3"*.

Hay una restricción de transporte que condiciona cómo viajan los adjuntos: **el `max_payload` de NATS
es 1 MB** y los adjuntos llegan a **10 MB** (el tope que declara `system_settings` de Jiku).

Y una restricción de alcance: **no modificar el producto Jiku** (G-03). Ni un comando nuevo, ni un
endpoint, ni una migración.

## Decision

**Toda escritura es un comando del bus. Dos comandos, y ninguno nuevo:**

| Comando | Para qué |
|---|---|
| `files.request-upload` | Pedir permiso de subida: devuelve un `fileId` y una URL prefirmada de `PutObject` |
| `requirements.new` | Crear el requisito, con los `fileIds` de los archivos ya subidos |

**El byte del adjunto NO viaja por el bus: va por `PUT` directo a la URL prefirmada**, con `fetch`
nativo y **sin credenciales de S3**. Dado el `max_payload` de 1 MB contra adjuntos de 10 MB, no es
una optimización — **es la única forma posible**.

La escritura de un adjunto queda entonces en **dos planos separados: el permiso y el byte.** El
permiso viaja por el bus; el byte va directo al storage.

**El conector no usa el plano de lectura del bus.** Sólo escribe. Ver
[ADR-004](ADR-004-mapa-tickets-kv-local.md) para por qué no consulta antes de crear.

**Tres cosas que el conector deliberadamente no decide, porque son de `core`:**

1. **La clave de storage.** `core` la construye (`{prefix}/f/{uuid}{ext}`). Un conector que armara su
   propia clave rompería la garantía de que el storage tiene un solo dueño.
2. **La política de archivos.** `core` valida la doble lista blanca —extensión **y** MIME— leyéndola
   **en caliente** de `system_settings`. El filtro local del conector es una **conveniencia** para no
   gastar un round-trip en un `.exe`, y **puede quedar desalineado**: si lo está, `core` rechaza y el
   conector anota el aviso.
3. **La titularidad.** `core` resuelve el actor por canal: como el caller del conector no es el service
   user de la api, el actor es **su propio `sub` del subject** —infalsificable, avalado por el
   auth-callout— y *lo que el conector declare en el cuerpo se ignora*. Sube con su identidad y vincula
   con la misma, así que `uploaded_by == actor` **se satisface sin que el conector haga nada**.

**Se acepta una ventana de inconsistencia que no se cierra:** los archivos existen antes que el
requisito, y si el alta falla quedan **huérfanos** para siempre. El orden inverso es imposible —los
`fileIds` son argumento del alta— y Jiku ya declara el archivo sin vínculo como **estado válido**,
con el barrido de abandonados fuera del alcance del producto entero.

## Implementation Rules

- Toda escritura de dominio MUST hacerse publicando un comando por el bus. MUST NOT haber ninguna
  escritura directa a PostgreSQL ni a storage con credenciales propias
- Los únicos comandos permitidos son **`files.request-upload`** y **`requirements.new`**. MUST NOT
  publicarse ningún otro
- El conector MUST NOT publicar en el plano de consultas (`jiku-queries.*`) ni suscribirse a subjects
  de otros servicios
- El byte de un adjunto MUST viajar por `PUT` HTTPS a la `uploadUrl` devuelta por
  `files.request-upload`. MUST NOT incluirse en el payload de ningún comando
- El `PUT` MUST hacerse con `fetch` nativo y un timeout de **30000 ms**
- El conector MUST NOT construir la clave de storage: la devuelve `core` implícitamente en la URL
  firmada
- El payload de `files.request-upload` MUST incluir `fileName`, `mimeType`, `fileSize` y `checksum`
  (sha256 calculado con `node:crypto` sobre el contenido)
- El payload de `requirements.new` MUST incluir `title`, `description`, `projectId`, `type`,
  `priority`, `visibilityLevel`, y `fileIds` **sólo si hay al menos uno**
- `fileIds` MUST tener a lo sumo **10** elementos (el `maxItems` del contrato). Los adjuntos aceptables
  que exceden el tope MUST anotarse como aviso en la descripción
- El conector MUST NOT enviar `state` en `requirements.new`: el requisito nace en `analisis`, que es el
  default de Jiku
- El conector MUST NOT enviar la clave `actor` en ningún payload: es la única clave de identidad que el
  plano de escritura rechaza de plano
- `title` MUST truncarse a **255** caracteres antes de publicar (el contrato no declara `maxLength` y
  la columna es `varchar(255)`)
- `title` y `description` MUST NOT quedar vacíos: si el mail los trae vacíos, MUST usarse los
  placeholders configurados (defaults: `Ticket recibido por mail` y `(mail sin contenido)`)
- El filtro local de archivos MUST tratarse como conveniencia, no como autoridad: un rechazo de `core`
  (`file_type_not_allowed`, `file_too_large`) MUST manejarse como caso esperado, con aviso en la
  descripción
- Dos adjuntos con el mismo `checksum` en el mismo mail MUST colapsarse a uno. Un colapsado MUST NOT
  generar aviso ni placeholder
- El fallo de un adjunto (permiso o `PUT`) MUST NOT cancelar el requisito: se anota el aviso y se sigue
- La descripción MUST componerse en este orden exacto: cuerpo base → avisos de rechazo → avisos de
  fallo de subida → **placeholders al final**
- Los placeholders MUST ser `![attach:{id}]` para `image/*` y `[attach:{id}]` para el resto
- Un requisito creado MUST NOT modificarse: no hay comando de compensación

## Consequences

### Positive

- **Cero credenciales de base y de storage** en el conector. Es la reducción de superficie de ataque
  más concreta del diseño.
- **La titularidad se cumple por construcción**, sin código: `core` la resuelve del subject
  infalsificable. El conector no puede equivocarse en algo que no decide.
- **Cero cambios en el producto Jiku** (G-03): los dos comandos ya existen, el rol ya existe, y la
  plantilla del callout ya cubre los subjects con comodín.
- **La política de archivos se actualiza sin redesplegar el conector**, porque la autoritativa vive en
  `system_settings` y `core` la lee en caliente.
- **El byte no pasa por el bus ni por la api**: un `PUT` directo es el camino más corto y no consume
  capacidad del bus.
- **Consistencia transaccional donde importa:** `core` crea el requisito y todos sus vínculos en una
  sola transacción.

### Negative

- **Archivos huérfanos son un estado permanente.** Si el alta falla después de subir tres archivos, las
  tres filas de `files` quedan sin vínculo y **nadie las limpia**. El barrido está fuera de alcance del
  producto entero.
- **El filtro local puede desalinearse** de la política de `core` y rechazar algo que Jiku aceptaría (o
  gastar un round-trip en algo que Jiku va a rechazar).
- **Nadie verifica el byte.** Ni `core` ni el conector: el `checksum` se declara y no se comprueba, y
  `core` no hace `headObject` para no arriesgar el timeout del comando. Un `PUT` que falló en silencio
  **se descubre al descargar**.
- **El tope de 10 adjuntos es del contrato y no es configurable.** Un mail con 15 adjuntos legítimos
  pierde 5.
- **No hay compensación.** Si el alta salió bien y el vínculo de un adjunto falló, el requisito queda
  con el aviso en la descripción y así se queda.
- **La escritura es síncrona y sin cola:** si `core` está caído, la operación no ocurrió (ver
  [ADR-001](ADR-001-worker-unico-sin-persistencia.md)).

### Risks

- **Riesgo: la ventana entre subir los archivos y crear el requisito produce huérfanos con frecuencia**
  si `core` es inestable.
  - **Mitigación:** ninguna posible en el conector — el orden es forzado por el contrato (`fileIds` es
    argumento del alta). Está declarado como estado válido en Jiku, y lo que queda es el log.
- **Riesgo: el `PUT` falla en silencio** (responde 200 pero el byte no queda íntegro) y el requisito se
  crea con un adjunto ilegible.
  - **Mitigación:** ninguna en v1. Verificar el byte sería más estricto que el producto, que tampoco lo
    hace. Se descubre al descargar.
- **Riesgo: `core` cambia la política de archivos y el filtro local queda rechazando cosas válidas**
  durante meses, sin que nadie lo note.
  - **Mitigación:** el rechazo local deja aviso en la descripción del requisito, así que es **visible al
    cliente en Opus** — es el lugar más probable donde alguien lo detecte.
- **Riesgo: la URL prefirmada expira antes del `PUT`.**
  - **Mitigación:** improbable por construcción — el TTL sale de `system_settings` y el `PUT` es
    inmediato al pedido de permiso. Si ocurre, se trata como un fallo de subida normal (aviso y sigue).

## Alternatives Considered

### Alternativa 1: Escritura directa a PostgreSQL y S3 (como el servicio actual)

**Pros:**
- Es lo que ya funciona hoy en `grava-gestion/mail-integration`
- Sin dependencia del bus ni de `core` para escribir
- Sin ventana de huérfanos: un `INSERT` transaccional cubre requisito y adjuntos

**Cons:**
- **Estructuralmente imposible en Jiku:** el rol de PostgreSQL no tiene `INSERT` y el storage tiene un
  solo dueño. No es una regla de estilo, es la configuración de la infraestructura
- Requeriría credenciales de base y de S3 en el conector
- Rompería la garantía de único escritor sobre la que se apoya todo el modelo de autorización de Jiku

**Why rejected:** No es una opción disponible. Es la razón por la que este proyecto no es una migración
de código sino una reescritura de la mitad de la escritura.

---

### Alternativa 2: El byte por el bus, en el payload del comando

**Pros:**
- Un solo plano: todo viaja por el mismo canal, sin `PUT` fuera de banda
- Sin ventana de huérfanos: el archivo y el requisito llegarían juntos

**Cons:**
- **Imposible: el `max_payload` de NATS es 1 MB y los adjuntos llegan a 10 MB.** Un adjunto típico de
  ticket (una captura de pantalla) ya lo excede
- Aun si cupiera, saturaría el bus con bytes que no son mensajes de dominio

**Why rejected:** Excluida por el transporte, no por diseño. Es exactamente por esto que Jiku diseñó el
flujo de permiso + URL prefirmada.

---

### Alternativa 3: Un comando nuevo en `core` que reciba el mail completo

Mover toda la lógica de adjuntos a `core` con un comando `requirements.new-from-mail`.

**Pros:**
- Cerraría la ventana de huérfanos con una sola transacción
- El conector quedaría reducido a un lector de mails

**Cons:**
- **Modifica el producto Jiku** (G-03): un comando nuevo, su validación, su contrato y su despliegue
- Seguiría sin resolver el transporte del byte (el `max_payload` no cambia)
- Mete dominio del mail dentro de `core`, que no tiene por qué conocerlo

**Why rejected:** Viola la restricción de alcance más fuerte de v1. Si el conector necesitara un comando
nuevo, sería un requerimiento del producto y no de este repositorio.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-4, Arq-7; Flujo 3 (el camino
  completo con adjuntos)
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 2, decisión 12,
  decisión 13; FG-4 completo
- [Análisis de dominio del discovery](../discovery/analisis-dominio.md) — invariantes 10 a 16
- [PRD — Requerimientos](../prd/requirements.md) — C-16, C-17, C-20 a C-26; NFR-S04, NFR-SC01, NFR-SC02
- ADR-001 de Jiku (`core` único escritor y dueño del storage)
