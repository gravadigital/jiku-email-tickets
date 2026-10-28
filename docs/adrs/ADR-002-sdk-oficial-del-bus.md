# ADR-002: Consumir el SDK oficial `@gravadigital/jiku` como cliente del bus

**Status:** Accepted
**Date:** 2026-08-26
**Deciders:** Technical Leader
**Tags:** integracion, bus, nats, sdk, dependencias

## Context

Toda la escritura del conector va por el bus NATS de Jiku (ver
[ADR-003](ADR-003-escritura-solo-por-comandos.md)). Hay que decidir **cómo se habla con ese bus**: un
cliente NATS a mano (`nats` + la gramática de subjects implementada en el conector) o el SDK oficial
`@gravadigital/jiku` v1.0.0, un paquete publicado y estable.

**El bus de Jiku tiene tres trampas, y lo que las hace peligrosas no es su dificultad: es que
ninguna de las tres falla señalando su causa.**

1. **El prefijo de inbox.** Una conexión puede suscribirse a exactamente un inbox: el callout mintea
   el permiso sobre `_INBOX.{hash(sub)}.>`. Cualquier otro prefijo —incluido **el aleatorio que
   genera todo cliente NATS por default**— hace que la reply se publique donde nadie escucha. La
   request **expira sin ningún error visible**, y la violación de permisos queda en el log del
   *servidor* NATS, no del cliente. El síntoma apunta a que `core` está caído. No lo está.
2. **Las dos credenciales.** Se necesitan el creds del sentinel *y* el token de Zitadel, y ninguna
   alcanza sola: el creds se niega permisos a sí mismo, y lo que mintea los permisos reales es el
   token. Un token sin el claim de roles **no conecta a nada**, y el error dice sólo
   `Authorization Violation`.
3. **El token en un reconnect.** El auth-callout evalúa el token **al conectar**, y NATS no revalida
   después. Un reconnect vuelve a correr el callout, así que un token vencido hace que **el reconnect**
   sea rechazado — no la operación en curso. El cliente tiene que entregarle al bus **una función, no
   un string**.

**Contexto adicional:** el SDK declara estabilidad por contrato (*"the API below is what 1.x will
keep"*), cubre los 20 comandos del plano de escritura con `client.command()`, y ofrece
`ServiceUser.fromKeyFile()` para exactamente esta clase de identidad desatendida. Su `engines` floor
es Node ≥ 22.12 y es ESM-only.

## Decision

**Se consume el SDK oficial `@gravadigital/jiku` ^1.0.0. El conector no implementa nada del
protocolo del bus.**

Concretamente, el conector delega al SDK: la construcción del subject, el armado y parseo del
envelope, el hash del prefijo de inbox, la obtención y el refresh del token, la entrega del token al
bus como getter, y la traducción de los errores a clases tipadas.

El conector usa:

- `ServiceUser.fromKeyFile(keyFile, { issuer, projectId })` — la identidad
- `connect({ servers, instance, credsFile, auth, onTokenError })` — **una sola vez, al arrancar**
- `client.command(name, payload)` — las dos formas de comando que necesita
- `loadConfig()` — para leer las `JIKU_*` del entorno con los defaults correctos
- Las clases de error del SDK — para distinguir qué sistema rechazó (ver
  [ADR-006](ADR-006-observabilidad-por-logs.md))

**Es la decisión que más código elimina y más riesgo evita.** La alternativa —reimplementar la
gramática, el envelope y el hash de inbox— eran **dos copias del contrato del bus sincronizadas a
mano**, justo lo que el monorepo de Jiku existe para evitar (ADR-012 de Jiku).

## Implementation Rules

- El cliente del bus MUST ser `@gravadigital/jiku` en rango `^1.0.0`
- El proyecto MUST NOT declarar `nats` como dependencia directa
- El conector MUST NOT construir subjects a mano: el subject se arma con `client.command()`, nunca con
  concatenación de strings
- El conector MUST NOT armar ni parsear envelopes del protocolo a mano
- El conector MUST NOT fijar `inboxPrefix` por su cuenta: lo fija el SDK siempre
- La identidad MUST construirse con `ServiceUser.fromKeyFile()` — no con un token obtenido a mano ni
  con un JWT armado en el conector
- `connect()` MUST llamarse **exactamente una vez** al arrancar el proceso, y el cliente resultante
  MUST conservarse por toda la vida del proceso. Prohibido conectar por mail o por tick
- El `user-id` del subject MUST salir de `auth.userId` (derivado de la key), **nunca** de una variable
  de entorno
- La configuración del bus MUST leerse con `loadConfig()` del SDK, no redeclarando los defaults a mano
- El timeout MUST quedar en el default del SDK (**15000 ms**). MUST NOT bajarse — ver
  [ADR-006](ADR-006-observabilidad-por-logs.md)
- `onTokenError` MUST estar registrado y MUST loguear el fallo del refresh como `error` sin terminar
  el proceso
- El runtime MUST ser Node.js **≥ 22.12** (el `engines` floor del SDK es parte de su superficie
  pública: subirlo es un major)
- El proyecto MUST usar **ESM** (`"type": "module"`): el SDK es ESM-only
- Los errores del bus MUST manejarse por las clases del SDK (`JikuPermissionDenied`, `JikuFailure`,
  `JikuTimeout`, `JikuNoEndpoint`, `JikuInvalidRequest`), no inspeccionando strings de mensaje

> **Nota de REQ-008 / S-034 (2026-10-08).** Desde S-032 el conector usa también el KV del bus, y las
> reglas de arriba lo cubren sin cambios:
>
> 1. **El KV entra por `client.kv()`**, sobre la misma conexión única. Sus errores (`JikuNoBucket`,
>    `JikuKVPermissionDenied`, `JikuBucketFull`) se manejan **por las clases del SDK**, exportadas
>    desde la entrada principal (`@gravadigital/jiku`), que es la regla que esta ADR ya fija: el
>    diagnóstico del arranque es por `instanceof`, nunca por el mensaje.
> 2. **El KV deja de existir como librería en el árbol** (`@nats-io/kv`, `@nats-io/jetstream`): el
>    conector no la declara ni la importa, así que *"MUST NOT declarar `nats`"* ahora también la cubre.
> 3. **El SDK se consume del registry, `^1.1.0`**: la primera versión publicada con el Espacio KV.
>    Entre S-032 y su publicación se consumió del `npm pack` de `jiku-ts@edd1064` en `vendor/`, que
>    declaraba `1.0.0`; un test sigue afirmando sobre lo instalado, no sobre el rango.
>
> **Historia:** entre S-023 y S-032 el KV entró por un re-export de `@nats-io/kv` en el subpath
> `./nats` de un build 1.1.0 vendoreado; `jiku-ts` nunca tuvo ese re-export. Ya no rige.

## Consequences

### Positive

- **Las tres trampas quedan resueltas sin que el conector las conozca.** Es el beneficio central: no
  se trata de escribir menos código, se trata de no tener tres fallas cuyo síntoma miente.
- **Cero duplicación del contrato del bus.** El conector no tiene una segunda copia de la gramática de
  subjects que sincronizar a mano cuando Jiku la cambie.
- **Errores tipados por origen**, que es lo que permite que el log diga *qué sistema* rechazó — la
  diferencia entre "no puedo escribir" y saber dónde mirar.
- **Refresh del token en background**, con la semántica correcta del getter, sin que el conector
  maneje relojes.
- **Estabilidad declarada por contrato** dentro de 1.x: las actualizaciones menores no rompen.
- **Una sola dependencia de integración.** El conector queda con el SDK más cuatro dependencias de
  dominio del mail.

### Negative

- **Acopla el conector al ciclo de vida del SDK.** Un bug del SDK es un bug del conector, y su arreglo
  no está en este repositorio.
- **El `engines` floor es impuesto, no elegido:** Node ≥ 22.12 es parte de la superficie pública del
  SDK. El conector no puede correr en un runtime más viejo aunque le alcanzara.
- **ESM-only es impuesto:** cierra la puerta a cualquier dependencia CJS que no tenga build ESM.
- **Superficie más amplia de la necesaria:** el SDK cubre los 20 comandos y el plano de consultas; el
  conector usa 2 comandos y ninguna consulta.
- **Menos control fino** sobre la conexión NATS (opciones de reconnect, backoff) que un cliente propio.

### Risks

- **Riesgo: el SDK publica un breaking change en un minor**, contra su propia declaración de
  estabilidad.
  - **Mitigación:** el rango es `^1.0.0` y el contrato declara *"the API below is what 1.x will
    keep"*. La superficie que el conector usa es mínima (5 símbolos), así que una migración sería
    acotada.
- **Riesgo: un bug del SDK en el manejo del token deja al conector sin conectar tras un reconnect**, y
  el síntoma es el mismo `Authorization Violation` opaco.
  - **Mitigación:** `onTokenError` registrado y logueado como `error`. No lo previene, pero deja el
    rastro.
- **Riesgo: el SDK queda sin mantenimiento** y el conector hereda una dependencia muerta sobre un
  protocolo que sí evoluciona.
  - **Mitigación:** es un paquete interno de la misma organización que el producto, así que su
    incentivo de mantenimiento coincide con el de Jiku. Si muriera, reimplementar el protocolo es la
    Alternativa 1, que sigue disponible con el costo ya documentado.

## Alternatives Considered

### Alternativa 1: Cliente NATS propio (`nats` + gramática implementada en el conector)

**Pros:**
- Control total sobre la conexión y sus opciones
- Sin acoplamiento al ciclo de vida de un paquete externo
- Superficie exactamente del tamaño necesario (2 comandos)

**Cons:**
- **Hay que resolver las tres trampas a mano**, y las tres fallan sin señalar su causa: el prefijo de
  inbox (síntoma: `core` parece caído), el token sin claim de roles (síntoma:
  `Authorization Violation`), y el token en el reconnect (síntoma: funciona hasta que se reconecta)
- **Dos copias del contrato del bus sincronizadas a mano**: la gramática de subjects y el formato del
  envelope vivirían acá y en Jiku
- Hay que implementar el hash del `sub` para el prefijo de inbox, y equivocarse es silencioso
- Hay que construir el refresh del token con la semántica de getter correcta

**Why rejected:** El costo no es la cantidad de código: es que las tres fallas más probables de esa
implementación **no señalan su causa**, en un servicio que además no tiene a nadie mirando. Duplicar
el contrato del bus es exactamente lo que el monorepo de Jiku existe para evitar.

---

### Alternativa 2: SDK sólo para la identidad, cliente propio para publicar

Usar `ServiceUser.fromKeyFile()` del SDK y publicar con `nats` directo.

**Pros:**
- Resuelve la trampa más difícil (el token y su refresh) sin heredar toda la superficie del SDK

**Cons:**
- **Deja las otras dos trampas sin resolver**: el prefijo de inbox y el envelope siguen siendo
  responsabilidad del conector, y son las dos que fallan en silencio
- Depende del SDK igual, así que no evita el acoplamiento — sólo reduce lo que obtiene a cambio
- La gramática de subjects seguiría duplicada

**Why rejected:** Paga el acoplamiento completo y se lleva un tercio del beneficio. La trampa del
inbox es la que produce el síntoma más engañoso, y esta alternativa la deja intacta.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-3, Arq-8, Arq-11; sección
  "Tokens y Autenticación" (los tres puntos que fallan sin señalar su causa)
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 8
- [PRD — Requerimientos](../prd/requirements.md) — C-14 a C-19, NFR-P03, NFR-P05, NFR-O06
- [PRD — Arquitectura](../prd/architecture.md) — sección "Subjects de mensajería"
- ADR-002 de Jiku (gramática de subjects), ADR-012 de Jiku (monorepo para evitar contratos duplicados)
