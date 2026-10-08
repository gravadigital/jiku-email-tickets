# Verificación manual de extremo a extremo

**Última actualización:** 2026-10-08
**Story:** S-033 (rehace la Parte 2 sobre el Espacio KV del SDK; la Parte 2 la escribió S-028, que
extendió el procedimiento del adjunto escrito por S-022)

Este documento es el procedimiento que **U-02** ejecuta contra un **entorno real** para confirmar,
con mails reales, lo que la suite automatizada **no puede** confirmar. Tiene dos partes, cada una de
la story que la escribió:

| Parte | Story | Qué cubre |
|---|---|---|
| [El camino del adjunto](#parte-1-el-camino-del-adjunto-s-022-ca-14) | S-022 | El camino completo con adjunto: ingesta → ruteo → partición/dedup/tope → permiso → `PUT` → descripción → alta del Requisito |
| [El alcance del KV](#parte-2-el-alcance-del-kv-s-028-ca-15) | S-028 · rehecha por S-033 | La verificación de `JIKU_KV` y la siembra del Mapa de Tickets con la clave completa, el slug nuevo que rutea **sin redesplegar** (y el borrado que deja de rutear), y la respuesta que produce un **comentario público visible en Opus** |

**Por qué este documento existe y no es burocracia.** `Client.fromConnection()` **saltea el
handshake de auth**, así que los tests de integración —por reales que sean el bus y el KV— **no
prueban nada** sobre Zitadel, sobre el rol `internal-app`, sobre el `inboxPrefix`, ni sobre cómo
Jiku y el portal Opus **renderizan** lo que el conector publicó. Eso sólo falla contra un despliegue
real, y este procedimiento es la única cosa que lo mira.

No es un procedimiento que el agente implementador pueda ejecutar por sí mismo — requiere una
instancia real de Jiku, del portal Opus, del storage S3-compatible y de un bus con JetStream
desplegados.

---

# Parte 1: el camino del adjunto (S-022, CA-14)

Confirma, con un mail real, el camino completo con adjunto —el mismo camino que
`test/ingesta/tick-adjuntos-propiedades.test.ts` (CA-13) ya verifica de forma automatizada contra un
doble de `core` y de storage. Exige S-017 a S-021 terminadas e integradas.

## Precondición

Las **ocho** precondiciones del `README.md` deben estar satisfechas. Eran cinco originalmente, S-022
sumó la #7 (storage alcanzable) y **S-024 a S-027 sumaron la #8**, que REQ-008 reformuló: `JIKU_KV`
creado por el deploy de Jiku en un bus con JetStream, con `allow_direct` y sin TTL, y los tres grants
del Espacio KV en la plantilla de `internal-app`. Para esta parte importan en particular:

- Instancia de Jiku alcanzable, con `tickets+alfa@grava.io` (o el slug equivalente) mapeado a un
  `projectId` real **en el Mapa de Tickets del Espacio KV del conector** (ver la
  [Parte 2](#paso-2-sembrar-el-mapa-de-tickets-con-nats-kv-put-y-la-clave-completa); hasta S-024
  esto era la variable `TICKET_MAP`, que **ya no existe**).
- Storage S3-compatible alcanzable por red desde donde corre el conector.
- Casilla IMAP real con subaddress habilitado.

## Procedimiento

### 1. Preparar el mail real de prueba

Componer un mail real (no sintético) desde una cuenta de correo externa, dirigido a
`tickets+alfa@grava.io` (o el slug real mapeado en el entorno de prueba), con:

- **Asunto:** un texto que describa un problema concreto (p. ej. *"No puedo ingresar al sistema"*).
- **Cuerpo:** una o dos oraciones describiendo el problema.
- **Un adjunto:** una captura de pantalla real (`.png` o `.jpg`), de tamaño y contenido reales — no un
  archivo vacío ni un placeholder.

### 2. Enviar el mail

Enviarlo contra la casilla real configurada en el `IMAP_*` del entorno de prueba. Esperar al próximo
disparo del cron (`POLL_CRON`) o, si el entorno lo permite, disparar el tick manualmente.

### 3. Qué debe ver U-03 en Jiku

- Un requisito nuevo, **en el proyecto correcto** (el que el slug del subaddress resuelve).
- **Estado:** `analisis` (el default de creación — el conector nunca envía `state`).
- **Título:** el asunto del mail (truncado a 255 si hiciera falta).
- **Cuerpo:** el texto del mail, con el placeholder de la captura (`![attach:<fileId>]`) al final.
- **La captura adjunta y visible** — no un link roto ni un ícono de archivo genérico: la imagen debe
  renderizar en la vista del requisito.

### 4. Qué debe ver U-01 en el portal Opus

- Su archivo (la captura), visible en el requisito correspondiente, **sin haber entrado nunca al
  portal Opus** — la vinculación del archivo al requisito ocurre del lado de `core`, no requiere
  ninguna acción de U-01 más allá de haber mandado el mail original.

### 5. Qué línea de log debe encontrar U-02

Una línea de log (`'requisito creado en Jiku'`) que indique:

- El `messageId` del mail original.
- El `projectId` del proyecto donde se creó el requisito.
- El `id` del requisito creado.
- Los dos conteos de archivos: `archivosVinculados` (cuántos adjuntos subieron con éxito —debería ser
  `1` en este escenario de un único adjunto exitoso) y `archivosConAviso` (cuántos tuvieron algún
  problema — debería ser `0` si la captura subió sin inconvenientes).

Esta única línea es lo que permite reconstruir, sin acceder a Jiku ni al storage, **qué mail se volvió
qué requisito, con cuántos archivos**.

### 6. Verificación de propiedades adicionales (opcional, recomendado)

Si el entorno lo permite, repetir el envío con variantes para confirmar en producción lo que los tests
automatizados (CA-5 a CA-11) ya afirman contra dobles:

- Un mail con dos adjuntos `.exe` (o cualquier extensión no permitida) idénticos → el requisito se crea
  igual, con los avisos de rechazo correspondientes, sin adjuntos vinculados.
- Un mail con más de 10 adjuntos aceptables → sólo los primeros 10 se vinculan; el resto queda anotado
  como aviso de exceso, sin cancelar el requisito.

## Resultado esperado de la Parte 1

El camino completo —ingesta, ruteo, procesamiento de adjuntos (partición → dedup → tope → permiso →
`PUT`), composición de la descripción, y publicación del requisito— funciona de punta a punta contra
un entorno real, cerrando el mismo contrato que la suite automatizada (CA-13) verifica contra dobles de
`core` y del storage.

---

# Parte 2: el alcance del KV (S-028, CA-15)

**Rehecha por S-033 (CA-13)** sobre el **Espacio KV** del SDK (REQ-008): el estado del conector ya no
vive en dos buckets propios que crea el operador sino en su porción del bucket `JIKU_KV`, que crea el
deploy de Jiku. Lo que la Parte 2 verifica sigue siendo lo mismo —el slug nuevo que rutea sin
redesplegar y la respuesta que produce un comentario público visible en Opus—; cambia cómo se prepara
y cómo se inspecciona.

Los pasos manuales del alcance del KV. **Sólo U-02 puede ejecutarlos** contra un entorno real (bus con
JetStream + `core` + portal Opus): la suite automatizada corre contra un NATS real de Testcontainers y
un KV real, pero con `Client.fromConnection()` y permisos estáticos, así que no prueba nada del auth
handshake, de la plantilla real de `internal-app` ni del renderizado en Opus.

## Precondición de esta parte

La **precondición 8 del `README.md`**: `JIKU_KV` creado por el deploy de Jiku con `allow_direct` y
**sin TTL**, y los **tres grants** del Espacio KV en la plantilla de `internal-app`. Ni U-02 ni el
conector la crean: U-02 la **verifica** (Paso 1) y, si falta, la pide al deploy de Jiku.

Y el CLI de NATS (`nats`) configurado contra el bus, con una **credencial que pueda escribir bajo el
prefijo del conector** (`$KV.JIKU_KV.<instance>.<sub>.>`). **No puede ser la de un usuario común**:
los grants confinan a cada rol a su propio `{{user_id}}`, así que un usuario común sólo escribe en su
propio espacio, nunca en el del conector.

## Paso 1: verificar que `JIKU_KV` existe, con `allow_direct` y sin TTL

Nada que crear: el bucket lo crea el deploy de Jiku. Lo que hace U-02 es **verificarlo** antes de
arrancar el conector:

```bash
nats kv info JIKU_KV                 # o: nats stream info KV_JIKU_KV
# Allows Direct: true                -> allow_direct activo (el SDK lo exige para leer)
# Maximum Age: unlimited             -> sin TTL (max_age 0): los hilos no expiran
```

Ni U-02 ni el conector crean `JIKU_KV`, y es a propósito: un bucket creado por error —con otro nombre
o con otra configuración— queda **vacío** en silencio, y el síntoma sería un conector aparentemente
sano que descarta **todos** los mails sin decir por qué. Un arranque que falla nombrando el bucket es
mucho mejor.

**Un TTL no impide el arranque y el conector no puede detectarlo** (el SDK sólo exige `allow_direct`):
por eso se mira acá. Con TTL, los slugs cargados empezarían a descartarse como `slug_no_mapeado` sin
que nadie los haya borrado.

**Verificación del paso:** arrancar el conector. Debe emitir la línea `'espacio KV abierto'` con
`{ bucket: 'JIKU_KV', kvPrefix: '<instance>.<sub>.' }`. **Anotar el `kvPrefix`**: es el prefijo de
todas las claves de los pasos siguientes. Si no arranca, la línea `fatal` trae
`code: KV_SPACE_UNAVAILABLE_ERROR` y uno de tres `diagnosis`:

- `bucket_no_usable`: `JIKU_KV` no existe, no tiene `allow_direct` o JetStream está apagado. Lo
  arregla el **deploy de Jiku**; la causa exacta va en `causes`. No es un problema de grants.
- `kv_sin_permisos`: al rol le faltan los grants. La línea trae el `subject` rechazado y los grants
  que faltan; se arregla en la **plantilla de `internal-app`**.
- `desconocido`: no encaja en ninguno; la clase y la cadena de causas van en la línea.

## Paso 2: sembrar el Mapa de Tickets con `nats kv put` y la clave completa

La plantilla de las tres operaciones, la misma del README:

```bash
nats kv put JIKU_KV <instance>.<sub>.tickets.<slug> <projectId>   # cargar o cambiar
nats kv get JIKU_KV <instance>.<sub>.tickets.<slug>               # verificar
nats kv del JIKU_KV <instance>.<sub>.tickets.<slug>               # borrar
```

`<instance>.<sub>.` es el `kvPrefix` del Paso 1, **copiado tal cual** (con el punto final). Con el
ejemplo `prod.387842544790142978.`:

```bash
nats kv put JIKU_KV <instance>.<sub>.tickets.alfa 42     # tickets+alfa@grava.io -> projectId 42
nats kv get JIKU_KV <instance>.<sub>.tickets.alfa        # -> 42
# es decir: nats kv put JIKU_KV prod.387842544790142978.tickets.alfa 42
```

El slug se normaliza a **minúsculas** en los dos lados del lookup, así que una clave `…tickets.Alfa`
se guarda tal cual pero **no** rutea un mail a `tickets+alfa@`: usar minúsculas siempre. Y el espacio
es **por instancia**: `dev` y `prod` tienen `kvPrefix` distintos y se siembran por separado.

**Verificación del paso:** mandar un mail a `tickets+alfa@grava.io` y confirmar que crea el requisito
en el proyecto `42`.

## Paso 3: un slug nuevo rutea SIN redesplegar, y uno borrado deja de rutear

Es la propiedad que REQ-005 compró y REQ-008 conserva sin el `watch()`: el conector no guarda ninguna
copia del mapa, consulta la clave del slug con un `get` puntual **por cada mail nuevo**.

Con el conector **corriendo** —sin reiniciarlo, sin redesplegarlo, sin tocar el contenedor:

1. Mandar un mail a `tickets+gamma@grava.io`, con `gamma` **no** cargado todavía.
   → Se descarta. La línea de log dice `motivo: 'slug_no_mapeado'` y **`slug: 'gamma'`** — el slug
   viaja en la línea justamente porque es el dato que hace falta para cargarlo.
2. Cargar el slug, con el proceso vivo:
   ```bash
   nats kv put JIKU_KV <instance>.<sub>.tickets.gamma 99
   ```
3. Mandar **otro** mail a `tickets+gamma@grava.io`.
   → **Crea el requisito en el proyecto 99** desde ese mail, sin haber reiniciado nada.

El primer mail **no se recupera**: quedó `\Seen` y el `\Seen` es la única marca de idempotencia
(ADR-001). Cargar el slug arregla los mails **siguientes**, no los anteriores.

**El mismo paso al revés** (recomendado): `nats kv del JIKU_KV <instance>.<sub>.tickets.gamma` y
confirmar que el mail **siguiente** a ese slug vuelve a caer en `slug_no_mapeado`, también sin
redesplegar.

**Y la degradación** (opcional): si el KV no responde, los mails nuevos se descartan como
**`slug_no_consultable`** —no como `slug_no_mapeado`: el arreglo es el bus, no cargar el slug— y
quedan `\Seen`. Cada descarte nombra el slug y el `messageId`, para reconstruirlos desde la casilla.
Cuando el KV vuelve, el mail siguiente rutea sin reiniciar el conector: no hay estado que
reconstruir.

## Paso 4: la respuesta que produce un comentario público visible en Opus

Es el camino que cierra el ciclo, y el que **sólo se puede verificar contra Opus real**: los tests
afirman que `visibilityLevel: 'public'` viaja en el payload, pero no que el cliente lo **vea**.

1. **Crear el ticket:** mandar un mail desde la cuenta del cliente (U-01) a
   `tickets+alfa@grava.io`. Confirmar que crea el requisito, y **anotar su `id`** de la línea
   `'requisito creado en Jiku'`.
2. **Responder al hilo:** desde **la misma cuenta del cliente**, responder a ese mail (Responder, no
   un mail nuevo: hace falta que el cliente ponga `In-Reply-To` o `References` apuntando al
   `Message-Id` original).
3. **Qué debe ver U-03 en Jiku:** un **comentario** nuevo en **ese** requisito (el `id` del paso 1),
   con el texto de la respuesta y los adjuntos que traiga vinculados. **No** un requisito nuevo: si
   apareciera un segundo requisito, el lookup del hilo no encontró la entrada y el mail cayó por
   otro camino.
4. **Qué debe ver U-01 en el portal Opus** — *es el punto entero del paso*: el comentario **visible
   para el cliente**. El default del contrato de `core` es `visibilityLevel: 'internal'`, que es **el
   opuesto** del que hace falta: un comentario interno **no lo vería el cliente**, y `core`
   responde `success` igual. La falla sería **silenciosa**, con el peor síntoma posible — el cliente
   cree que nadie leyó su respuesta.
5. **Qué línea de log debe encontrar U-02:** la del comentario publicado, con el `messageId` de la
   **respuesta**, el `requirementId` que el lookup resolvió, y los conteos de archivos. Y en la línea
   `'tick completado'`: **`comentados: 1` y `creados: 0`**. Los dos contadores **no se suman**: un
   comentario no es un alta, y la línea de métricas es la única señal operativa del tick.
6. **La respuesta a la respuesta** (recomendado): responder otra vez, ahora al mail de la respuesta.
   Debe comentar en **el mismo requisito**. Es lo que verifica que el **segundo** write ocurrió: el
   conector escribe la entrada del `Message-Id` de **la respuesta**, no el de la referencia que
   matcheó, y eso es lo que hace que la conversación siga aunque el cliente **recorte**
   `References`.

**Y el caso que debe descartar:** responder desde una cuenta cualquiera a un hilo que el conector
**no** conoce (un reenvío interno, o un hilo anterior al despliegue del KV) tiene que descartarse con
`motivo: 'hilo_desconocido'`, **sin crear un requisito duplicado ni un comentario**. Los dos casos
que producen ese motivo —reenvío interno e hilo anterior al despliegue— son **indistinguibles a
propósito**: significan lo mismo operativamente y el arreglo es el mismo. (Desde REQ-008 los hilos
**no expiran**: una respuesta a un hilo de cualquier antigüedad comenta.)

## Paso 5: cómo inspeccionar una entrada del Mapa de Hilos (la clave es un hash hex)

La entrada de un hilo vive en la clave `hilos.<sha256 del Message-Id>` del espacio del conector. El
`KV` no lista claves por identidad, y la clave no se lee —son 64 chars de hex, ilegibles—, así que se
inspecciona **una entrada concreta**, armando la clave completa con el hash que el log ya emite:

```bash
# 1. Del log, tomar el messageIdHash de la línea que interesa:
#    { "messageId": "<abc@cliente.com>", "messageIdHash": "9f86d0...", "requirementId": 700, ... }

# 2. Consultar esa clave en el espacio del conector (el kvPrefix del Paso 1 + hilos. + el hash):
nats kv get JIKU_KV <instance>.<sub>.hilos.<messageIdHash>
# -> 700
```

**Por qué la clave es un hash, y por qué no se va a "arreglar":**

- Las reglas de clave de NATS —las que aplica `assertValidKVKey()` del SDK— **rechazan `<`, `>` y
  `@`**, los tres presentes en un `Message-Id` real (`<abc@cliente.com>`). Una clave inválida no se
  puede escribir, así que la defensa es **no producirla nunca**.
- La alternativa obvia —normalizar y escapar el `Message-Id` para que entre en las reglas— **no se
  implementa a propósito**: permitiría que dos `Message-Id` distintos **colapsen a la misma clave** y
  **ruteen un comentario al requisito equivocado**, violando G-04. La legibilidad de la clave no vale
  un comentario en el ticket de otro cliente.
- Por eso el hash va sobre el `Message-Id` **crudo**, con sus brackets, **sin `trim()`, sin
  `toLowerCase()` y sin normalización de ninguna clase**.

**Cómo cruzar una línea de log con el espacio.** Toda línea del Mapa de Hilos lleva el campo
**`messageIdHash`** —el mismo hash que es la clave— junto al `messageId` **en claro**. El hash **no
reemplaza** al `Message-Id` en el log, sólo en la clave.

El campo se llama `messageIdHash` y **no `key`**: la lista de redacción incluye `'key'` y `'*.key'`
para cubrir la clave privada del machine user, así que un campo llamado `key` saldría `[REDACTED]`
**sin fallar y sin avisar**, y el hash se perdería del log justo cuando hace falta.

Que el hash **sí** se loguee no es una violación de la política de redacción: es un hash, **no
contenido del cliente**. Lo que nunca viaja al log es el **cuerpo del mail**, el **texto del
comentario** y el **contenido de un adjunto**.

**El valor es un entero en TEXTO**, no JSON (`nats kv get` muestra `700`, no `{"id":700}`): una
entrada que no parsea como entero positivo se saltea con un `warn`, y el dato malo de una sola clave
no puede ser un modo de falla.

## Resultado esperado de la Parte 2

`JIKU_KV` verificado (existe, con `allow_direct`, sin TTL) y el espacio del conector abierto al
arrancar, con su `kvPrefix`; el Mapa de Tickets sembrado con la clave completa y actualizable **sin
redesplegar**, desde el mail siguiente, en las dos direcciones (alta y baja); la respuesta de un
cliente convertida en un **comentario público que el cliente ve en Opus**; la conversación siguiendo
en la respuesta a la respuesta; y una entrada del Mapa de Hilos **inspeccionable** con
`nats kv get` cruzando el `messageIdHash` del log.

---

# Parte 3: el reuso de adjuntos contra el hilo (S-029)

**Por qué esta parte existe, y no es opcional.** La suite de integración corre contra un NATS de
Testcontainers con `core` doblado por un responder del propio test, y `Client.fromConnection()`
**saltea el handshake de auth**. Eso significa que la suite **no prueba nada** sobre: el
auth-callout, el rol `internal-app` autorizando `pub` sobre `jiku-queries.v1.>`, el **whitelist
real** del recurso `attachments` en la instancia, ni la existencia de una fila real en
`attachments`. Los cuatro sólo fallan contra un despliegue de verdad, y los cuatro tienen que estar
bien para que el reuso funcione. **Este procedimiento es el único instrumento que los verifica.**

Y como ADR-006 declara que **el log es la única salida del servicio** —no hay healthcheck, ni
métricas exportadas, ni nadie mirando— la verificación es, entera, una lectura de log.

## Precondición de esta parte

Un requisito creado por el conector que **ya tenga un adjunto vinculado por el conector mismo**.
La forma más simple de conseguirlo es hacer la [Parte 1](#parte-1-el-camino-del-adjunto-s-022-ca-14)
primero: deja exactamente eso. Anotar de su log:

- el `requirementId` del alta (ej. `700`),
- el `checksum` del adjunto subido (aparece en la línea de `files.request-upload`),
- el `fileId` que devolvió `core`.

## Rama 1: el reuso (el caso que motiva REQ-006)

**Qué mandar:** responder al hilo de ese requisito desde el mismo cliente, **con Gmail**, dejando que
arrastre el adjunto del original (es el comportamiento por default de Gmail al responder: copia los
adjuntos del mail citado). El archivo tiene que ser **byte a byte el mismo**.

**Qué confirma el log** — dos líneas y una **ausencia**:

```jsonc
// 1. La consulta encontró el vínculo y devolvió el fileId existente:
{ "level": "info", "checksum": "<el mismo checksum de la Parte 1>", "requirementId": 700,
  "fileId": 1000, "resultado": "reusado", "msg": "adjunto reusado del hilo" }

// 2. El comentario se publicó con ESE fileId, indistinguible de uno nuevo:
{ "level": "info", "requirementId": 700, "commentId": 9001, "msg": "comentario publicado" }
```

**Y LA AUSENCIA, que es la mitad más importante de la verificación:** para ese adjunto **no hay
ninguna línea de `files.request-upload`** y **ninguna del `PUT`**. Si aparecen, el reuso no ocurrió
—buscar entonces el `warn` de la Rama 3, o un `resultado: 'sin_match'` inesperado—.

En Opus: el comentario muestra el adjunto normalmente, y **no** hay un archivo duplicado en el
requisito.

## Rama 2: sin match (el comportamiento de siempre)

**Qué mandar:** responder al **mismo** hilo con un archivo **nuevo**, que el conector nunca subió a
ese requisito.

**Qué confirma el log** — la línea del `sin_match` seguida del **ciclo de subida completo**:

```jsonc
{ "level": "info", "checksum": "<el checksum del archivo nuevo>", "requirementId": 700,
  "resultado": "sin_match", "msg": "sin reuso: el adjunto no esta vinculado al requisito del hilo" }
// ... y a continuación, para ESE adjunto, la línea de `files.request-upload` y la del `PUT`.
```

Notar que esta línea **no lleva `fileId`**: no hay ninguno que reportar. Es la degradación normal, y
es también lo que se ve cuando el vínculo del original **se borró** o su archivo **no está
retenido**: las dos exclusiones permanentes del predicado fijo del recurso llegan como una colección
vacía, indistinguibles de "nunca estuvo". El conector no puede reusar un vínculo borrado **ni
equivocándose**.

## Rama 3: la degradación, y por qué se verifica por AUSENCIA

Provocar un fallo de la consulta a mano es difícil (habría que tirar abajo el plano de lectura). Lo
que **sí** se verifica —y es lo que de verdad importa— es que **el filtro esté alineado con el
whitelist real del recurso**. Si no lo estuviera, el síntoma sería inconfundible: **cada** adjunto de
**cada** respuesta dejaría este `warn`:

```jsonc
{ "level": "warn", "checksum": "...", "requirementId": 700,
  "diagnosis": "core_rechazo_por_forma", "sdkErrorClass": "JikuFailure",
  "code": "invalid_fields", "resultado": "consulta_fallida",
  "msg": "fallo la consulta de reuso de adjuntos" }
```

**La AUSENCIA de ese `warn` en una corrida normal es la confirmación de que el filtro está bien
armado.** Es mucho log y cero pérdida: la degradación convierte el fallo en el comportamiento
anterior, así que ni un adjunto ni un ticket se pierden — sólo se paga el duplicado que ya existía.

Los otros diagnósticos que pueden aparecer en este `warn`, y qué arregla cada uno:

| `diagnosis` | `code` | Qué pasó y qué se arregla |
|---|---|---|
| `core_rechazo_por_forma` | `invalid_fields` | **Bug del conector:** el filtro se desalineó del whitelist. Se arregla en el código |
| `core_rechazo_por_rol` | `caller_not_authorized` / `unknown_caller` | La fila del machine user ausente en `users`. **Se corrige sola al reconectar** |
| `core_rechazo_desconocido` | `query_timeout` / `internal_error` | Del lado de `core`. `query_timeout` es un código nuevo para este conector y cae acá **correctamente** |
| `nada_respondio` | *(sin `code`)* | Nadie contestó la consulta: el plano de lectura no está atendiendo |
| `bus_sin_endpoint` | *(sin `code`)* | No hay endpoint para `attachments.list` en esta instancia |
| `desconocido` | *(sin `code`)* | Un `success` ilegible: la respuesta no era una colección |

## Cross-check mecánico del whitelist, contra la instancia

Para confirmar los cuatro `filterable` y el `includable` **sin adivinar**, el SDK expone
`client.describe()` (*"lists the reads core serves"*) y `client.contract()` (*"Fetches one
resource's whitelists"*). Correrlos **a mano, como paso del operador** —por ejemplo desde un REPL de
Node con el cliente ya conectado— y confirmar que el recurso `attachments` declara:

- `filterable` incluyendo `entityType`, `entityId`, `checksum` y `uploadedBy` (los cuatro del filtro),
- `includable` incluyendo `checksum`,
- `entityType` con `requirement` entre sus valores de enum.

> **Deliberadamente NO se agrega una llamada a `describe()` en el arranque del servicio.** Sería un
> **segundo** consumo del plano de lectura, y S-029 autoriza exactamente uno: `attachments.list`
> desde `lookup-attachment.ts`. Es un paso manual del operador, no código.

## Resultado esperado de la Parte 3

El arrastre de Gmail **reusando** el `fileId` existente, sin permiso y sin `PUT`; un archivo nuevo
siguiendo el ciclo completo con su línea de `sin_match`; **ninguna** línea de
`diagnosis: core_rechazo_por_forma` en una corrida normal; y el whitelist del recurso confirmado
contra la instancia con `contract()`.

---

# Contraste de capabilities del PRD (S-022, CA-15 · revisado por S-028, CA-15)

Las **30 capabilities** del PRD (`docs/prd/requirements.md`, C-01 a C-30) contrastadas contra el estado
real del código, al cierre de esta story.

**Revisión de S-028:** REQ-005 **no agregó ninguna capability al PRD** —no agrega comportamiento de
producto: muda el Mapa de Tickets a un bucket KV, agrega el Mapa de Hilos y le da salida a la
respuesta de un cliente—, así que las **30 siguen siendo 30 y siguen cubiertas**. Lo que cambió son
las filas de C-09, C-12 y C-29, que apuntaban a implementaciones o tests que REQ-005 reemplazó, y
las columnas de tests, que ganan las suites nuevas. Están actualizadas abajo.

**Revisión de S-034:** REQ-008 **tampoco agregó capabilities** —muda el estado del conector a su
Espacio KV en `JIKU_KV` y resuelve el slug con un `get` por mail—, así que las **30 siguen siendo 30**.
Las filas de C-09, C-11 y C-13 apuntaban a `ticket-map.ts` y a tests que S-032 borró: se re-apuntaron
al código de S-032 y a las suites de S-032 y S-033.

| Capability | Descripción | Implementada en | Test que la cubre |
|---|---|---|---|
| C-01 | Disparar el tick del poll | `src/domain/ingesta/scheduler.ts` | `test/ingesta/scheduler.test.ts` |
| C-02 | Conectar a IMAP y tomar el lock de INBOX | `src/infra/imap/client.ts` | `test/infra/imap/client.test.ts` |
| C-03 | Buscar los mails no vistos y aplicar el cap | `src/domain/ingesta/tick.ts` | `test/ingesta/tick.test.ts` |
| C-04 | Descargar el mensaje crudo y marcarlo `\Seen` | `src/domain/ingesta/tick.ts` | `test/ingesta/tick.test.ts` |
| C-05 | Normalizar el mail a la forma de trabajo | `src/domain/ingesta/normalize.ts` | `test/ingesta/normalize.test.ts` |
| C-06 | Convertir un mail sólo-HTML a texto plano | `src/domain/ingesta/normalize.ts` | `test/ingesta/normalize.test.ts` |
| C-07 | Parsear los adjuntos de las partes MIME | `src/domain/ingesta/normalize.ts` | `test/ingesta/normalize.test.ts` |
| C-08 | Contabilizar y loguear el resultado del tick | `src/domain/ingesta/tick.ts` | `test/ingesta/tick.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-9) |
| C-09 | Cargar el Mapa de Tickets en el Espacio KV | **`src/infra/kv/tickets.ts`** (`lookupTicket()`) + `src/infra/kv/keys.ts` (`ticketKey()`) (S-032: el mapa vive en las claves `tickets.<slug>` del Espacio KV y se consulta por mail; hasta S-032, un módulo propio con `watch()`, y hasta S-024, `config/schema.ts`) | `test/infra/kv/tickets.test.ts` (TS-27 a TS-29), `test/ingesta/tick-mapa-tickets.test.ts` (TS-54, TS-63), `test/infra/kv/e2e-operador.test.ts` (S-033, TS-1 a TS-6: el slug que el operador carga con la clave completa rutea desde el mail siguiente, sin reabrir el espacio) |
| C-10 | Extraer el slug del subaddress | `src/domain/ruteo/route-mail.ts` | `test/ruteo/route-mail.test.ts` |
| C-11 | Resolver el slug a un `projectId` | `src/domain/ruteo/route-mail.ts` (el slug en minúsculas, la intención de alta) + `src/infra/kv/tickets.ts` (`lookupTicket()`, resuelto en `src/domain/ingesta/tick.ts`) | `test/ruteo/route-mail.test.ts` (TS-44), `test/ingesta/tick-mapa-tickets.test.ts` (TS-55, TS-61), `test/infra/kv/e2e-operador.test.ts` (TS-5: mayúsculas no matchean; TS-7/TS-8: cada instancia ve sólo su espacio) |
| C-12 | Descartar una respuesta a un hilo | `src/domain/ruteo/route-mail.ts` + **`src/infra/kv/threads.ts`** (S-026/S-027: `routeMail()` ya no decide el descarte, devuelve la **intención**; el lookup del Mapa de Hilos decide, y con match la respuesta se **comenta** en vez de descartarse) | `test/ruteo/route-mail.test.ts`, `test/ingesta/tick-hilos.test.ts`, `test/ingesta/tick-propiedades-kv.test.ts` (S-028, TS-16 a TS-20: los **tres** casos de `hilo_desconocido` sin crear nada) |
| C-13 | Descartar en silencio lo que no resuelve | `src/domain/ruteo/route-mail.ts` (`sin_slug`) + `lookupTicket()` en el tick (`slug_no_mapeado`, `slug_no_consultable`) + `src/shared/motivo-descarte.ts` (los siete motivos) | `test/ruteo/route-mail.test.ts`, `test/ingesta/tick-mapa-tickets.test.ts` (TS-56 a TS-59), `test/shared/motivo-descarte.test.ts` (TS-17/TS-48), `test/ingesta/tick-propiedades-espacio.test.ts` (S-033, TS-17 a TS-19: la caída del KV en caliente) |
| C-14 | Construir la identidad y conectar al bus | `src/infra/bus/connection.ts`, `src/infra/bus/identity.ts` | `test/bus/connection.test.ts` |
| C-15 | Mantener el token fresco | `src/infra/bus/connection.ts` (`onTokenError`) | `test/bus/connection.test.ts` |
| C-16 | Armar el payload del alta | `src/domain/publicacion/mail-payload.ts` | `test/publicacion/mail-payload.test.ts` |
| C-17 | Publicar `requirements.new` y esperar la respuesta | `src/domain/publicacion/publish-requirement.ts` | `test/publicacion/publish-from-mail.test.ts`, `test/publicacion/publish.test.ts` |
| C-18 | Registrar el alta exitosa | `src/domain/publicacion/publish-requirement.ts` | `test/publicacion/publish-from-mail.test.ts` |
| C-19 | Traducir el error distinguiendo qué sistema rechazó | `src/domain/publicacion/publish-errors.ts` | `test/publicacion/publish-errors.test.ts` |
| **C-20** | Particionar los adjuntos por la política local | `src/domain/adjuntos/particionar.ts` | `test/adjuntos/particionar.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-1) |
| **C-21** | Deduplicar por checksum dentro del mail | `src/domain/adjuntos/dedup.ts` | `test/adjuntos/dedup.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-2) |
| **C-22** | Pedir permiso de subida | `src/domain/publicacion/upload-file.ts` | `test/publicacion/upload-file.test.ts` |
| **C-23** | Subir el byte a la URL prefirmada | `src/domain/publicacion/upload-byte.ts` | `test/publicacion/upload-byte.test.ts` |
| **C-24** | Aplicar el tope de 10 archivos | `src/domain/adjuntos/tope.ts` | `test/adjuntos/tope.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-3) |
| **C-25** | Vincular los archivos al requisito | `src/domain/publicacion/mail-payload.ts` (`fileIds` condicional) | `test/ingesta/tick.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-10) |
| **C-26** | Componer la descripción final | `src/domain/publicacion/description.ts` | `test/publicacion/description.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-8) |
| C-27 | Validar la configuración al arrancar | `src/config/index.ts`, `src/config/schema.ts` | `test/config/schema.test.ts` |
| C-28 | Emitir logs estructurados a stdout | `src/shared/logger.ts` | `test/shared/logger.test.ts` |
| C-29 | No filtrar datos sensibles al log | `src/shared/log-redaction.ts` (S-027 sumó `comment` y `*.comment`) | `test/ingesta/tick-redaction.test.ts` (S-022, TS-5), `test/ingesta/tick-propiedades-kv.test.ts` (S-028, TS-1 a TS-8: el lote **mixto** con KV real, la aserción contra el **texto del comentario que viajó al bus**, y el `messageIdHash` que **sí** se loguea) |
| C-30 | Emitir las métricas del tick | `src/domain/ingesta/tick.ts` (S-026/S-027: **SEIS** contadores, con `comentados`) | `test/ingesta/tick.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-9), `test/ingesta/tick-propiedades-kv.test.ts` (S-028, TS-27 a TS-30: `creados` y `comentados` **no se suman**, las seis claves exactas, y la línea emitida **también cuando el tick falla**) |

**Las 30 capabilities (C-01 a C-30) están cubiertas.** F-04 (C-20 a C-26, adjuntos) queda **completa**:
las siete estaban implementadas desde S-017 a S-021, y S-022 sumó la verificación de propiedad sobre
el **sistema completo** (disparadas desde `runTick()`, no sólo desde el módulo puro o el orquestador
invocado directo) más el escenario de extremo a extremo automatizado (CA-13).

**Ninguna capability quedó sin cubrir.** El alcance v1 del producto está completo.

## Cierre de REQ-005 (S-028)

> **Nota de S-033 (REQ-008).** Esta tabla se conserva tal como la cerró S-028, como historia. REQ-008
> reemplazó dos de sus filas: la del **watch en caliente** y su degradación
> (`test/infra/kv/e2e-watch-tick.test.ts`, borrado en S-032 junto con el `watch()`: un slug vale
> desde el mail siguiente porque se consulta por mail, y una caída descarta como
> `slug_no_consultable`), y la de la **expiración por TTL** como uno de los tres casos de
> `hilo_desconocido` (desde REQ-008 los hilos no expiran: quedan dos casos). El fail-fast "para los
> dos buckets" es hoy el de `JIKU_KV`. Lo vigente está en el
> [Cierre de REQ-008](#cierre-de-req-008-s-033).

REQ-005 **no agregó capabilities** y **no deja nada pendiente**. Lo que S-028 agrega es la
verificación de las propiedades del sistema **sobre el tick cableado de punta a punta** —no sobre
módulos puros— y la verificación E2E contra un NATS real con JetStream:

| Propiedad verificada | Suite |
|---|---|
| Ningún log filtra el cuerpo del mail, el texto del comentario ni el contenido de un adjunto, sobre el tick completo con KV real | `test/ingesta/tick-propiedades-kv.test.ts` (TS-1 a TS-4) |
| El `messageIdHash` **sí** se loguea y el `Message-Id` sigue **en claro** | `test/ingesta/tick-propiedades-kv.test.ts` (TS-6, TS-7) |
| El pico de memoria sigue siendo de **un mail a la vez**, extendido a la rama del comentario y al KV | `test/ingesta/tick-propiedades-kv.test.ts` (TS-10 a TS-15) + `test/ingesta/tick-memory.test.ts` (línea de base de S-016/S-022, **sin modificar**) |
| `hilo_desconocido` no crea nada, en los **tres** casos que lo producen, y los tres son **indistinguibles** | `test/ingesta/tick-propiedades-kv.test.ts` (TS-16 a TS-20) |
| El write que falla **no cancela el alta**; el write del comentario está condicionado al `success` | `test/ingesta/tick-propiedades-kv.test.ts` (TS-21 a TS-26) |
| Los seis contadores distinguen altas de comentarios | `test/ingesta/tick-propiedades-kv.test.ts` (TS-27 a TS-30) |
| El ciclo alta → respuesta → respuesta a la respuesta, contra el **KV real** | `test/infra/kv/e2e-kv.test.ts` (TS-31 a TS-33) |
| El fail-fast del bucket faltante, **encadenado** con `reportStartupFailure()`, para los dos buckets | `test/infra/kv/e2e-kv.test.ts` (TS-34 a TS-38) |
| El watch en caliente y su degradación, medidos **sobre el tick** | `test/infra/kv/e2e-watch-tick.test.ts` (TS-40 a TS-46) |
| Las propiedades **preservadas**: el `connect()` único, `nats` prohibido, el `AppConfig` no logueado | `test/infra/kv/preservacion-req-005.test.ts` (TS-47 a TS-50) |
| La idempotencia **no cambia** (el `\Seen` es la única marca, el KV **no participa**) | `test/ingesta/tick-propiedades-kv.test.ts` (TS-51 a TS-53) |
| El dedup **contra el hilo** sigue **sin existir**, y es deliberado; el **intra-mail** sigue vigente | `test/ingesta/tick-propiedades-kv.test.ts` (TS-54 a TS-56) |
| Los pasos manuales del alcance del KV | **este documento**, [Parte 2](#parte-2-el-alcance-del-kv-s-028-ca-15) (`test/story-028-docs.test.ts`) |
| Las precondiciones de despliegue completas y consistentes | `README.md` precondición 8 (`test/deployment-docs.test.ts`) |

Lo que **ninguna suite puede** verificar, y por eso la [Parte 2](#parte-2-el-alcance-del-kv-s-028-ca-15)
de este documento existe: el handshake de auth de Zitadel, el rol, el `inboxPrefix`, y que el
comentario `public` **se vea en Opus**.

## Cierre de REQ-008 (S-033)

REQ-008 **no agregó capabilities**: muda el estado del conector a su **Espacio KV** dentro de
`JIKU_KV` —el Mapa de Tickets consultado por mail, sin `watch()` ni copia en memoria, y el Mapa de
Hilos sin TTL— sin cambiar ningún comportamiento de producto. Lo que S-033 agrega es la verificación,
**contra un JetStream real y sobre el `runTick()` cableado**, de lo que S-032 sólo conservó: la clave
completa que escribe un operador siguiendo el README, el aislamiento por instancia e identidad, el
arranque que falla por cada una de sus tres causas reales, la caída del KV con recuperación sin
reiniciar, el hilo viejo que comenta, la redacción y la memoria. Y reescribe la documentación de
operación, con un test que ata la plantilla de clave documentada a la que arma el código.

| Propiedad verificada | Suite |
|---|---|
| Un slug cargado por el operador con la **clave completa** de la plantilla del README (y el `kvPrefix` leído de la línea de arranque) rutea desde el mail siguiente, sin reabrir el espacio; cambiarlo vale desde el mail siguiente; una clave en mayúsculas no matchea; un valor malo se ignora con un `warn` que nombra el slug y no el valor (CA-1) | `test/infra/kv/e2e-operador.test.ts` (TS-1/TS-2, TS-4, TS-5, TS-6) |
| Un slug borrado con `nats kv del` deja de rutear desde el mail siguiente (CA-2) | `test/infra/kv/e2e-operador.test.ts` (TS-3) |
| Cada instancia e identidad ve **sólo** su espacio: lo cargado en `dev` no rutea en `prod`, y cada conector escribe sólo bajo su prefijo, mirado desde el **stream** (CA-3) | `test/infra/kv/e2e-operador.test.ts` (TS-7/TS-8) |
| Una respuesta a un hilo de 91 días —o de 10 días, o de 10 años— comenta (CA-4) | `test/ingesta/tick-propiedades-espacio.test.ts` (TS-15, TS-16) |
| El ciclo alta → respuesta → respuesta a la respuesta contra el espacio real (CA-5) | `test/infra/kv/e2e-kv.test.ts` (TS-31/TS-32/TS-33, conservado) |
| El arranque falla por la causa real: sin `JIKU_KV` (`bucket_no_usable`, y no lo crea), sin `allow_direct` (`bucket_no_usable`, sin `subject` ni grants, y no lo arregla), y sin grants (`kv_sin_permisos` con el `subject` rechazado y los grants que faltan, **contra un `nats-server` real con permisos**), encadenado con `reportStartupFailure()` (CA-6) | `test/infra/kv/e2e-kv.test.ts` (TS-34, TS-37, TS-38, TS-11) + `test/infra/kv/e2e-permisos.test.ts` (TS-12, TS-13, TS-14) |
| Una caída del KV en caliente descarta los nuevos como `slug_no_consultable`, las respuestas como `es_respuesta`, todo queda `\Seen`, sin un séptimo contador; y el tick siguiente crea sobre el **mismo** handle, sin reiniciar (CA-7) | `test/ingesta/tick-propiedades-espacio.test.ts` (TS-17/TS-18/TS-19) + `test/infra/kv/e2e-permisos.test.ts` (TS-14: el rechazo de permisos en caliente) |
| Ninguna línea del log completo del proceso —arranque y ticks— filtra el cuerpo, el comentario, un adjunto ni un **valor crudo** del KV; `messageIdHash` sólo en los `warn` del Mapa de Hilos y `kvPrefix` como único dato nuevo del espacio (CA-8) | `test/ingesta/tick-propiedades-espacio.test.ts` (TS-20, TS-21) + `test/ingesta/tick-propiedades-kv.test.ts` (TS-1 a TS-7, conservados) |
| El tick lee sólo las claves de sus mails: el costo no crece con los slugs cargados, y nada del camino del slug guarda estado entre mails (CA-9) | `test/ingesta/tick-propiedades-espacio.test.ts` (TS-23, TS-24) + `test/ingesta/tick-memory.test.ts` (línea de base, **sin modificar**) |
| `hilo_desconocido` tiene **dos** orígenes (reenvío interno, hilo anterior al despliegue) y la expiración ya no es uno; contadores, idempotencia y dedup se conservan (CA-10) | `test/ingesta/tick-propiedades-espacio.test.ts` (TS-25) + `test/ingesta/tick-propiedades-kv.test.ts` (TS-16, TS-18 a TS-20, TS-27 a TS-30, TS-51 a TS-56, conservados) |
| El README documenta la operación del Espacio KV: la precondición 8, los tres grants **cruzados con el SDK**, el síntoma de un bucket con TTL, los tres comandos con la clave completa y la credencial de U-02 (CA-11); el `.env.example` deja de explicar el mecanismo viejo (CA-12) | `test/story-033-docs.test.ts` (TS-27 a TS-34) + `test/deployment-docs.test.ts` (TS-43, invertidos en S-033) |
| La Parte 2 de este documento, rehecha (CA-13), y la plantilla de clave documentada **cruzada con el código**, idéntica en el README y acá (CA-14) | `test/story-033-docs.test.ts` (TS-35 a TS-42) + `test/story-028-docs.test.ts` (TS-44, re-apuntados en S-033) |

Lo que **ninguna suite puede** verificar, y por eso la [Parte 2](#parte-2-el-alcance-del-kv-s-028-ca-15)
de este documento sigue existiendo: el auth-callout real y el `{{user_id}}` reemplazado por el `sub`
del token, que la **plantilla real de `internal-app`** tenga los tres grants (la suite usa permisos
estáticos en la configuración del servidor de test), el handshake de Zitadel, y que el comentario
`public` **se vea en Opus**.
