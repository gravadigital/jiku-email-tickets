# ADR-005: Identidad de machine user con el rol `internal-app`

**Status:** Accepted
**Date:** 2026-08-26
**Deciders:** Technical Leader, Product Owner
**Tags:** seguridad, identidad, autenticacion, autorizacion, zitadel

## Context

Para publicar comandos en el bus de Jiku, el conector necesita una identidad que el auth-callout
autorice. Hay que decidir **qué clase de identidad** y **con qué rol**.

**El servicio predecesor lo resuelve con un `MAIL_BOT_USER_ID` seedeado a mano**: una fila en la
tabla de usuarios, creada por una migración, cuyo id se pasa por variable de entorno. Eso no
funciona en Jiku: el conector no puede correr migraciones ni escribir en la base
([ADR-003](ADR-003-escritura-solo-por-comandos.md)).

**Lo que Jiku ya tiene definido para este caso exacto.** El `rules.yaml` del auth-callout es
explícito: *"Para habilitar un conector: crear un machine user en Zitadel con Access Token Type =
JWT y asignarle el rol `internal-app` en `GESTION_ZITADEL_PROJECT_ID`. **No hace falta tocar nada de
este archivo**"*. Y `templates/api.yaml` ya publica sobre
`{{instance}}.{{user_id}}.jiku-commands.v1.>` con comodín, que cubre los dos comandos que el conector
necesita.

**Dos hechos del modelo de Jiku que condicionan la decisión:**

- **El conector necesita fila en `users`**, por dos motivos independientes: la compuerta de
  autorización de `core` lee `users.roles` y **sólo exime al service user de la api**; y
  `requirements.created_by` / `files.uploaded_by` tienen **FK real** contra `users.id`.
- **Esa fila la crea Jiku sola.** El auth-callout publica un evento en cada autenticación contra el
  bus, y `core` lo consume y espeja la identidad. La **primera conexión** del conector la crea, con
  `identity_type: service` y `email` en `NULL` — un machine user no tiene dirección de correo, y Jiku
  lo contempla explícitamente.

**Restricción de alcance:** no modificar el producto (G-03), lo que incluye no editar `rules.yaml` ni
las plantillas del auth-callout.

## Decision

**Un machine user de Zitadel con Access Token Type = JWT y el rol `internal-app`, construido con
`ServiceUser.fromKeyFile()` del SDK. Sin cambios en `rules.yaml` ni en las plantillas del callout.**

El conector se declara como **un caller más del bus**, usando el rol que Jiku ya tiene definido
exactamente para esto.

| Pieza | Definición |
|---|---|
| Tipo de identidad | Machine user de Zitadel, Access Token Type = **JWT** |
| Construcción | `ServiceUser.fromKeyFile()` (RFC 7523) |
| Rol | **`internal-app`**, asignado en el project de gestión de Zitadel |
| Token | JWT con claim de roles, ~1 h, **refrescado en background por el SDK** |
| `user-id` del subject | El `sub`, **derivado de la key** (`auth.userId`), nunca de una variable |
| Fila en `users` | **La crea Jiku sola** en la primera autenticación |
| Cambios en el auth-callout | **Ninguno** |

**La identidad del autor de un requisito es el machine user, y la resuelve `core`.** No hay persona
detrás de un mail entrante, y `resolveActor` de Jiku ya hace exactamente esto para un publicador
externo: el actor es el `sub` del subject —infalsificable, avalado por el callout— y **lo que el
conector declare en el cuerpo se ignora**. El `MAIL_BOT_USER_ID` del servicio actual desaparece.

### El costo del rol, declarado sin minimizar

`internal-app` concede **los dos planos completos** —`{ commands: ALL, queries: ALL }` en
`core/src/authorize-caller.ts`— y ubica al caller en la clase `connector`, **que no recorta ninguna
fila en las consultas**. **El conector va a poder mucho más de lo que necesita** (usa 2 comandos de 20
y ninguna consulta).

`rules.yaml` ya anticipa la pregunta: *"Un conector con permiso acotado es un ROL NUEVO —con su
plantilla y su entrada en ese mapa—, no una variante de este"*. **Se acepta el rol amplio en v1 porque
acotarlo modifica el producto** (G-03), y queda registrado como fuera de alcance.

### Lo que el conector deliberadamente NO autentica

**No verifica quién mandó el mail.** Cualquiera que conozca `tickets+<slug>@` puede crear un requisito
en ese proyecto. El servicio actual tampoco lo valida. Es una superficie de abuso real, acotada por lo
poco adivinable del slug, y queda como pregunta abierta (NFR-S09).

## Implementation Rules

- La identidad MUST ser un machine user de Zitadel con Access Token Type = **JWT**
- El rol asignado MUST ser **`internal-app`** en el project de gestión de Zitadel
- La identidad MUST construirse con `ServiceUser.fromKeyFile(keyFile, { issuer, projectId })`
- El `user-id` del subject MUST salir de `auth.userId` (derivado de la key). MUST NOT leerse de una
  variable de entorno: tiene que coincidir exactamente con el `sub` que el auth-callout lee para
  autorizar el subject
- `JIKU_PROJECT_ID` MUST estar configurado y MUST validarse al arrancar. Sin él el token no lleva el
  claim de roles y **no conecta a nada** (el error dice sólo `Authorization Violation`)
- La key JSON MUST leerse de un **archivo montado read-only**. MUST NOT estar horneada en la imagen ni
  pasarse por variable de entorno
- El access token MUST vivir **sólo en memoria**. MUST NOT escribirse a disco ni loguearse
- El creds del sentinel de NATS MUST montarse como archivo read-only
- El conector MUST NOT enviar la clave `actor` en el payload de ningún comando: es la única clave de
  identidad que el plano de escritura rechaza de plano
- Lo que el conector declare en `creator` / `uploader` MUST tratarse como informativo: `core` lo ignora
  y resuelve el actor del subject
- El conector MUST NOT crear ni intentar crear su fila en `users`: la crea Jiku en la primera
  autenticación
- El conector MUST NOT modificar `rules.yaml` ni las plantillas del auth-callout
- El conector MUST NOT verificar la identidad del remitente del mail (fuera de alcance v1, declarado)
- Un fallo del refresh del token MUST loguearse como `error` vía `onTokenError` y MUST NOT terminar el
  proceso

## Consequences

### Positive

- **Cero cambios en el producto** (G-03): el rol existe, la plantilla del callout ya cubre los subjects
  con comodín, y la fila en `users` se crea sola.
- **La titularidad de los archivos se cumple por construcción**, sin código del conector: `core`
  resuelve el actor del subject infalsificable, así que `uploaded_by == actor` se satisface siempre.
- **El `MAIL_BOT_USER_ID` seedeado a mano desaparece**, y con él la migración que lo creaba y el riesgo
  de que la variable y la fila se desincronicen.
- **Sin sesiones y sin usuarios:** una sola identidad para todo lo que el conector hace. No hay
  gestión de sesión, ni refresh tokens de usuario, ni logout.
- **El token no toca el disco.** La única credencial persistida es la key, y es read-only.
- **Es el canal que Jiku diseñó para un publicador externo**, no un atajo: `resolveActor` tiene una
  rama específica para este caso.

### Negative

- **El rol concede mucho más de lo necesario:** los dos planos completos y sin recorte de filas, para
  un conector que usa 2 comandos y ninguna consulta. Es la concesión de seguridad más grande del
  diseño.
- **La fila en `users` aparece después de la primera conexión, no antes.** Los primeros comandos de un
  conector recién desplegado pueden fallar con `caller_not_authorized`.
- **La entrega del evento que crea esa fila no es durable** (NATS sin JetStream). Si se pierde, el
  conector queda sin fila y sus comandos fallan hasta su próxima autenticación, que con un token
  renovado en caliente puede tardar.
- **La key JSON se descarga una sola vez** de Zitadel: no se puede volver a bajar, sólo reemplazar por
  una nueva. Le pone un requisito propio al almacenamiento del secreto.
- **Sin procedimiento de rotación** definido para la key.
- **Cualquiera que conozca la dirección puede crear requisitos** en ese proyecto. No hay verificación
  del remitente.

### Risks

- **Riesgo: el evento de autenticación se pierde y el conector queda sin fila en `users`**, con todos
  sus comandos fallando con `caller_not_authorized`.
  - **Mitigación:** reconectar lo resuelve, y el log distingue este caso de un problema de payload (ver
    [ADR-006](ADR-006-observabilidad-por-logs.md)), así que el diagnóstico es directo. **Es una
    dependencia declarada del producto, no un bug del conector.**
- **Riesgo: la key se filtra** y alguien obtiene un token con `internal-app`, que concede los dos
  planos completos sobre toda la instancia.
  - **Mitigación:** archivo read-only, nunca en la imagen, nunca logueada. **No está mitigado el
    alcance del daño**, que es la consecuencia directa del rol amplio. Acotar el rol es la salida y
    está fuera del alcance v1.
- **Riesgo: la key se pierde** (no hay backup y Zitadel no la re-emite).
  - **Mitigación:** generar una nueva y reemplazarla. Es un procedimiento manual sin documentar —
    pendiente.
- **Riesgo: alguien descubre un slug y crea requisitos falsos** en el proyecto de un cliente.
  - **Mitigación parcial:** el slug es poco adivinable. Queda registrado como pregunta abierta; la
    salida sería una lista de remitentes autorizados por slug, que hoy no existe.

## Alternatives Considered

### Alternativa 1: Un rol nuevo acotado (`mail-connector`)

Crear un rol en Zitadel que conceda sólo los dos comandos que el conector usa.

**Pros:**
- **Principio de mínimo privilegio:** el conector no podría hacer nada más que lo que necesita
- Reduce el daño de una key filtrada a dos comandos de escritura
- Podría recortar filas en el plano de lectura, si algún día lo usara

**Cons:**
- **Modifica el producto Jiku** (G-03): exige una plantilla nueva en el auth-callout y una entrada
  nueva en el mapa rol→método de `core`. `rules.yaml` lo dice literalmente: *"un ROL NUEVO —con su
  plantilla y su entrada en ese mapa—, no una variante de este"*
- Acopla el despliegue del conector a un cambio en el producto

**Why rejected:** Es la alternativa **correcta a mediano plazo** y está registrada como fuera de
alcance, no descartada. Queda fuera de v1 sólo por G-03.

---

### Alternativa 2: Reusar el service user de la api

**Pros:**
- Ya existe y ya tiene fila en `users`
- Está **eximido de la compuerta de roles** de `core`, así que no dependería del evento de
  autenticación

**Cons:**
- **Rompería la resolución de titularidad:** `core` resuelve el actor *por canal*, y para el service
  user de la api toma el actor **del cuerpo del mensaje**. El conector podría entonces declarar
  cualquier actor, y la garantía infalsificable desaparece
- Dos servicios compartiendo identidad: imposible auditar quién escribió qué
- Compartir la credencial de la api con un servicio externo amplía su superficie de exposición

**Why rejected:** Destruye exactamente la propiedad que hace segura esta integración. La rama externa
de `resolveActor` existe para que un publicador externo **no** pueda declarar su actor.

---

### Alternativa 3: Fila seedeada a mano en `users` (como el servicio actual)

Mantener el patrón `MAIL_BOT_USER_ID` con una fila creada por migración.

**Pros:**
- La fila existe **antes** de la primera conexión: sin ventana de `caller_not_authorized`
- No depende de la entrega no durable del evento de autenticación

**Cons:**
- **El conector no puede correr migraciones** ni escribir en la base
- Requeriría que alguien de Jiku la cree, acoplando el despliegue del conector al del producto
- La variable de entorno y la fila pueden desincronizarse
- No resuelve la identidad **en el bus**: el auth-callout autoriza por token, no por una fila

**Why rejected:** No es implementable desde este repositorio, y aun si lo fuera resolvería la mitad
menos importante del problema (la FK) sin tocar la autorización en el bus, que es la que realmente
habilita a escribir.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-6; sección "Tokens y
  Autenticación"; Flujo 1 (arranque y el efecto lateral que crea la fila en `users`)
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 6; Transversales →
  Identidad en el bus
- [PRD — Requerimientos](../prd/requirements.md) — C-14, C-15; NFR-S02, NFR-S03, NFR-S05, NFR-S07,
  NFR-S08, NFR-S09; invariantes 17 y 18
- [PRD — Objetivos y Contexto](../prd/goals-and-context.md) — "El costo aceptado del rol `internal-app`"
- `rules.yaml` y `templates/api.yaml` del auth-callout de Jiku; `core/src/authorize-caller.ts`
