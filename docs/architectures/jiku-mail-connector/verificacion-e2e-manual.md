# Verificación manual de extremo a extremo (S-022, CA-14)

**Última actualización:** 2026-09-01
**Story:** S-022

Este documento es el procedimiento que **U-02** ejecuta contra un **entorno real** (bus + `core` +
storage S3-compatible) para confirmar, con un mail real, el camino completo con adjunto —el mismo
camino que `test/ingesta/tick-adjuntos-propiedades.test.ts` (CA-13) ya verifica de forma automatizada
contra un doble de `core` y de storage. **Esta es la única story que puede verificar esto de punta a
punta**: exige S-017 a S-021 terminadas e integradas.

No es un procedimiento que el agente implementador pueda ejecutar por sí mismo — requiere una
instancia real de Jiku, del portal Opus y del storage S3-compatible desplegados.

## Precondición

Las siete precondiciones del `README.md` (sección "Las cinco precondiciones", extendida por S-022 con
la #7, storage alcanzable) deben estar satisfechas, en particular:

- Instancia de Jiku alcanzable, con `tickets+alfa@grava.io` (o el slug equivalente) mapeado en el
  `TICKET_MAP` a un `projectId` real.
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

## Resultado esperado

El camino completo —ingesta, ruteo, procesamiento de adjuntos (partición → dedup → tope → permiso →
`PUT`), composición de la descripción, y publicación del requisito— funciona de punta a punta contra
un entorno real, cerrando el mismo contrato que la suite automatizada (CA-13) verifica contra dobles de
`core` y del storage.

---

# Contraste de capabilities del PRD (S-022, CA-15)

Las **30 capabilities** del PRD (`docs/prd/requirements.md`, C-01 a C-30) contrastadas contra el estado
real del código, al cierre de esta story.

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
| C-09 | Cargar el Mapa de Tickets al arrancar | `src/config/schema.ts` | `test/config/schema.test.ts` |
| C-10 | Extraer el slug del subaddress | `src/domain/ruteo/route-mail.ts` | `test/ruteo/route-mail.test.ts` |
| C-11 | Resolver el slug a un `projectId` | `src/domain/ruteo/route-mail.ts` | `test/ruteo/route-mail.test.ts` |
| C-12 | Descartar una respuesta a un hilo | `src/domain/ruteo/route-mail.ts` | `test/ruteo/route-mail.test.ts` |
| C-13 | Descartar en silencio lo que no resuelve | `src/domain/ruteo/route-mail.ts` | `test/ruteo/route-mail.test.ts` |
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
| C-29 | No filtrar datos sensibles al log | `src/shared/log-redaction.ts` | `test/ingesta/tick-redaction.test.ts` (S-022, TS-5 amplía a los tres tipos de resultado combinados) |
| C-30 | Emitir las métricas del tick | `src/domain/ingesta/tick.ts` | `test/ingesta/tick.test.ts`, `test/ingesta/tick-adjuntos-propiedades.test.ts` (S-022, TS-9) |

**Las 30 capabilities (C-01 a C-30) están cubiertas.** F-04 (C-20 a C-26, adjuntos) queda **completa**:
las siete estaban implementadas desde S-017 a S-021, y esta story (S-022) suma la verificación de
propiedad sobre el **sistema completo** (disparadas desde `runTick()`, no sólo desde el módulo puro o
el orquestador invocado directo) más el escenario de extremo a extremo automatizado (CA-13).

**Ninguna capability quedó sin cubrir.** El alcance v1 del producto está completo.
