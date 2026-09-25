---
date: 2026-09-09
story: S-027
request: REQ-005
service: jiku-email-tickets
---

# S-027 — Publicación del comentario y cierre del ciclo del hilo

## Qué cambió

**La respuesta de un cliente al hilo de su ticket deja de perderse.** Con el hilo conocido, se
publica como un **Comentario público** del Requisito, con sus adjuntos vinculados, y su `Message-Id`
se escribe al Mapa de Hilos para que la conversación pueda seguir.

Cierra la Parte 2 de REQ-005, y con ella el REQ completo.

Hasta S-026 el conector descartaba activamente toda respuesta. El servicio predecesor sí las
procesaba con una tabla propia; el bloqueo era dónde guardar el mapa `Message-Id → requirementId`, y
el KV del bus lo resolvió.

### Lo que se agregó

- `src/domain/publicacion/publish-comment.ts` — el **tercer** y último comando de escritura,
  `requirements.{id}.comment`.
- `src/domain/publicacion/comment.schema.ts` / `comment.types.ts` — el schema del payload con sus
  tipos **inferidos**.
- `routeMail()` devuelve `{ ok: false, intencion: 'comentario' }` para una respuesta. **No es un
  descarte**, y por eso esa variante no lleva `motivo`: el lookup del tick decide.
- La rama de la respuesta en el tick, de punta a punta: lookup → adjuntos → composición →
  comentario → write.
- `REDACT_PATHS` cubre `comment` y `*.comment`.

## Las decisiones que cuestan si se hacen mal

**`visibilityLevel: 'public'` explícito, y el schema lo declara REQUERIDO** aunque el contrato lo
haga opcional. El default del contrato es `internal`, que es **el opuesto** del que hace falta: un
comentario interno **no lo vería el cliente en Opus**, y `core` respondería `success` igual. Falla en
silencio, con el peor síntoma posible — el cliente cree que nadie leyó su respuesta. Declararlo
requerido convierte el olvido en un error de compilación.

**El write al Mapa de Hilos va estrictamente DESPUÉS del `success`**, dentro del mismo `try`, después
de `comentados += 1`. Es el único fallo de esta story que corrompe estado: un write anticipado
dejaría el bucket apuntando a un Comentario **que no existe**, y la próxima respuesta rutearía a un
hilo cuyo último eslabón se perdió.

**Se escribe el `Message-Id` de LA RESPUESTA**, no el de la referencia que matcheó. Es lo que hace
que una respuesta a la respuesta rutee aunque el cliente recorte `References`.

**La traducción de errores se reusa sin agregarle ramas.** `requirement_not_found` y `file_not_owned`
caen en `core_rechazo_desconocido`, y es correcto: un segundo catálogo de códigos de `core` —que
crece— sería el que queda viejo.

**`creados` y `comentados` no se contaminan.** Un comentario no es un alta, y sumarlos borraría la
distinción en la única línea de métricas que el tick emite (ADR-006: no hay healthcheck ni
exportador).

## Dos hallazgos de la planificación que evitaron rojos

1. **ADR-003 enumeraba los comandos permitidos como lista CERRADA** en dos, y esta story agrega el
   tercero. REQ-005 decía que ADR-003 "se reutiliza sin cambios" — cierto de su decisión de fondo y
   **falso de esa regla puntual**. La regla se **reescribió** con su nota de derogación, en vez de
   ajustar los tests dejando la ADR contradiciendo al código.

2. **El escáner de nombres de comando dejaba de escanear en silencio.** Su regex fue escrita para
   nombres estáticos, y el del comentario es **dinámico** (`COMMAND_PREFIX = 'requirements.'` +
   `COMMAND_SUFFIX = '.comment'`): ninguna de las dos mitades matchea, así que el test **pasaba sin
   ver el comando nuevo** — el falso negativo que su propia cabecera advierte que importa más.
   Verificado, corregido, y además ahora prohíbe explícitamente los sufijos de edición (`.update`,
   `.delete`, `.close`).

## Lo que NO hace, y hay que resistir activamente

- **No deduplica adjuntos contra el hilo** (serían N+1 consultas y `attachments.list` no expone
  `checksum`; además obligaría a tocar el plano de consultas, que ADR-003 prohíbe). Gmail arrastra
  los adjuntos del original en la respuesta y se aceptan resubidos.
- **No consulta el Requisito antes de comentar.** Si se borró, `core` contesta
  `requirement_not_found` y **ese** es el diagnóstico.
- **No modifica el Requisito.** El Comentario es una entidad aparte, y ningún sufijo de comando
  dinámico puede ser de edición.
- **El `\Seen` no cambia.** El KV **no participa** de la idempotencia.

## Documentación

**Flujo nuevo** `publicacion-requirements-comment`, hermano del de `requirements.new` (que **no
cambia** su contenido: sólo gana la referencia cruzada). `ruteo-y-alta-del-requisito` reescrito — la
rama 1 devuelve la intención, y `es_respuesta` queda significando **únicamente** "no pude consultar
el Mapa de Hilos". `mapa-de-hilos-en-kv` completa su segundo trigger. **ADR-003** con el tercer
comando.

**Tres derogaciones registradas como anotación histórica, no como borrado:** la decisión 9 del
análisis funcional (los comentarios estaban fuera de alcance) y su **pregunta abierta 1** (*"¿dónde
guardar el mapa `Message-Id → requisito`?"*), que encontró una **cuarta** salida que aquella lista no
contemplaba: un bucket KV del bus, que no es estado propio ni una tabla de Jiku.

## Tests

**Suite completa: 75 archivos, 1047 tests en verde.** Tres tests de S-026 que afirmaban el estado
intermedio ("una respuesta con match se sigue descartando") se **invirtieron** para afirmar lo
contrario — eran, literalmente, el valor que esta story construye. Cuatro allowlists de escáneres se
**ampliaron** una entrada (nunca se relajaron a un patrón, que dejaría entrar cualquier publicador
nuevo en silencio).
