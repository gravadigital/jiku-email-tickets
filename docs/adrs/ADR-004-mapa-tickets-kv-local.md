# ADR-004: Resolver el proyecto con un KV del bus y no usar el plano de lectura

**Status:** Accepted (reformulada el 2026-09-08 por REQ-005 / S-025)
**Date:** 2026-08-26
**Amended:** 2026-09-08 — el Mapa de Tickets deja de ser configuración inline y pasa a ser un
bucket KV de NATS seguido con `watch()`. **La decisión de fondo no cambió** —el proyecto se resuelve
contra un mapa `slug → projectId` que el conector tiene a mano, sin consultar el plano de lectura—;
lo que cambió es **dónde vive ese mapa** y, con eso, la consecuencia negativa principal: el redeploy
por proyecto nuevo desaparece.
**Deciders:** Technical Leader, Product Owner
**Tags:** ruteo, configuracion, plano-de-lectura, kv

## Context

El conector recibe un mail en `tickets+<slug>@grava.io` y tiene que decidir **a qué proyecto de Jiku
va**. Es el punto que más cambia respecto del servicio predecesor: hoy resuelve con un
`SELECT ... WHERE ticket_slug = ?` contra la base, y acá no hay base
([ADR-001](ADR-001-worker-unico-sin-persistencia.md)).

Las opciones son resolver **por consulta al bus** (el plano de lectura de Jiku) o **por configuración
local**.

**Lo que hace inviable la consulta al bus, y es un hecho verificado sobre el contrato, no una
preferencia:**

- `ticket_slug` **existe** en la base de Jiku, pero está **deliberadamente no expuesto ni filtrable**
  en el contrato de consultas del bus. Un conector que quisiera resolver por consulta **no tiene por
  dónde**: no hay query que acepte un slug como filtro.
- Además, ese campo **está marcado para eliminarse** en Jiku. Construir el ruteo sobre él sería
  construir sobre algo que se va.

**Dos consideraciones adicionales sobre el plano de lectura en general:**

- El plano de lectura **exige fila en `users`**, igual que el de escritura. Esa fila la crea Jiku sola
  en la primera autenticación, pero **aparece después de conectar, no antes**, y su entrega no es
  durable.
- Validar el proyecto antes de crear **duplicaría la validación** que `core` ya hace.

## Decision

**El proyecto se resuelve contra el Mapa de Tickets —un bucket KV del bus— con el `projectId` como
valor. El conector no consulta el plano de lectura para rutear.**

| Aspecto | Definición |
|---|---|
| Estructura | `slug` (string, único, minúsculas) → `projectId` (int) |
| Fuente | **Un bucket KV de NATS** (JetStream), que el operador carga con `nats kv put` |
| Momento de carga | **Al arrancar**, y después **en caliente**: el conector sigue el bucket con `watch()` sobre una copia en memoria |
| Quién lo crea | **El operador.** El conector abre y verifica, nunca crea (S-024) |
| Bucket vacío | **Estado válido**: el worker arranca y descarta todo con log |
| Bucket inexistente | **Fail-fast**: el worker no arranca, y el log nombra el bucket |
| Entrada mal formada | **Se ignora con `warn`** que nombra la clave. No tumba el watch ni el proceso |
| Validación del `projectId` | **Ninguna.** No se verifica que el proyecto exista |

**Lo que la mudanza al KV cambia, y es el motivo de REQ-005:** agregar un proyecto ya no exige
editar una variable de entorno y **redesplegar el contenedor**. Un `nats kv put` aparece en el ruteo
en segundos, con el worker corriendo.

**Lo que NO cambia, y conviene decirlo porque es lo que se podría "mejorar" por accidente:** el
conector sigue sin consultar el plano de lectura **para rutear**. El mapa es una copia local que el
servidor actualiza sola; el ruteo sigue siendo un `Map.get()` en memoria, sin round-trip por mail.

**Guardar el id y no el nombre del proyecto es la parte de la decisión que la hace autosuficiente:**
con el nombre habría que resolverlo por consulta, y volvería a hacer falta el plano de lectura que
esta decisión evita.

**Por qué no validar el proyecto antes de crear**, que es la objeción natural:

1. **No agregaría información.** `core` ya responde `project_not_found`, y ese código **nombra el
   problema real**: el KV apunta a un proyecto inexistente.
2. **Duplicaría la validación con la peor de las dos decidiendo** — el mismo argumento con el que Jiku
   eximió a la api de su propia compuerta de roles.
3. **Adelantaría el fallo con un código que no señala la causa.** El plano de lectura exige fila en
   `users`; si esa fila todavía no existe, la consulta previa fallaría con un error de autorización
   que no tiene nada que ver con el proyecto.

**El Mapa de Tickets es configuración del conector, no dato del producto.** Es deliberado: una
interfaz de administración implicaría que el mapa es dato de Jiku, y esa es una decisión del producto,
no de este repositorio.

## Implementation Rules

**Reformuladas por S-025.** Las que cambiaron llevan la nota; las demás siguen vigentes verbatim.

- El Mapa de Tickets MUST vivir en un **bucket KV del bus**, y el conector MUST seguirlo con
  `watch()` sobre una copia en memoria *(S-025: antes era "desde variable de entorno o archivo
  montado, al arrancar")*
- El conector MUST NOT crear el bucket. Un bucket inexistente MUST provocar **fail-fast** con un
  error que **nombre el bucket** *(S-024)*
- Un bucket **vacío** MUST ser aceptado como estado válido: el worker arranca y descarta todo con log
- El conector MUST esperar la **carga inicial completa** antes de schedular el primer tick, para que
  ningún mail se rutee contra un mapa a medio llenar *(S-025)*
- Una entrada con valor mal formado MUST **ignorarse con `warn` que nombre la clave**, sin tumbar el
  watch ni el proceso *(S-025: antes un mapa mal formado era fail-fast. La inversión es deliberada —
  un dato malo cargado a mano no debe dejar sin ruteo a los demás proyectos, y con el mapa en el KV
  ya no hay un "momento de carga" en el que fallar)*
- Un `delete` en el bucket MUST **sacar la clave** de la copia en memoria *(S-025)*
- Si el `watch()` se cae, el conector MUST **conservar la última copia buena** y reintentar. MUST NOT
  vaciar el mapa *(S-025: vaciarlo dejaría de rutear mails que se pueden rutear perfectamente)*
- El slug extraído del mail MUST normalizarse **a minúsculas** antes de buscarlo (comparación en
  minúsculas **en las dos puntas**)
- El valor de cada entrada MUST ser el `projectId` entero de Jiku. MUST NOT ser el nombre del proyecto
  ni su slug
- El conector MUST NOT verificar contra Jiku que el `projectId` exista antes de publicar
- El conector MUST NOT publicar en el plano de consultas del bus (`jiku-queries.*`) **para rutear**
- El slug MUST extraerse del `recipient` con la regex `^<prefijo>\+([^@]+)@`, case-insensitive, con el
  prefijo configurable (default: `tickets`)
- El `recipient` MUST tomarse de `Delivered-To`, con `To` como **único** fallback
- Un mail sin match de slug MUST descartarse con log, sin crear nada
- Un slug sin entrada en el mapa MUST descartarse con log que **nombre el slug buscado**
- La copia del mapa MUST vivir sólo en memoria: MUST NOT escribirse a disco ni cachearse fuera del
  proceso. El bucket del bus **no** es "fuera del proceso" en este sentido: es la fuente, no una caché

## Consequences

### Positive

- **Autosuficiente:** el conector resuelve el destino sin consultar nada. No depende de la
  disponibilidad del plano de lectura ni de la sincronización de la fila en `users`.
- **Evita el plano de lectura por completo**, y con él: la clase `connector` sin recorte de filas, la
  dependencia de `users` para leer, y la duplicación de la validación de proyecto.
- **No se apoya en un campo que se va.** `ticket_slug` está marcado para eliminarse en Jiku; el KV es
  independiente de ese cambio.
- **El error señala su causa.** `project_not_found` nombra exactamente el problema (el KV apunta a un
  proyecto inexistente), en vez de un error de autorización que confundiría.
- **Arranque robusto:** un mapa vacío no impide arrancar, así que un despliegue nuevo no falla por
  configuración incompleta de negocio.
- **Fail-fast donde importa:** un bucket inexistente se detecta al arrancar —nombrándolo— y no en
  el primer mail.
- **Sin redeploy por proyecto nuevo** *(S-025)*: un `nats kv put` alcanza, y el conector lo ve en
  segundos. Tampoco paga un round-trip por mail: el `watch()` mantiene la copia, y el ruteo sigue
  siendo un `Map.get()` en memoria.
- **La unicidad del slug la garantiza el almacén** *(S-025)*, no una validación propia: en un KV una
  clave es una sola por definición, así que el modo de falla "dos entradas con el mismo slug"
  desaparece en vez de tener que detectarse.

### Negative

- ~~**Agregar o cambiar un slug exige reiniciar el proceso.**~~ **DEROGADA por S-025:** el `watch()`
  del bucket propaga el cambio en caliente, en segundos, sin redeploy. Era la consecuencia negativa
  principal de esta decisión y es el motivo por el que REQ-005 existe.
- **El mapa es configuración a mano**, así que puede quedar desactualizado sin que nadie lo note. El
  síntoma es un mail descartado con log, que nadie mira. *(Sigue vigente: cambió el medio de carga,
  no el hecho de que lo cargue una persona.)*
- **Aparece una precondición de despliegue nueva** *(S-024/S-025)*: JetStream habilitado, permisos de
  KV en el auth-callout, y el bucket creado. Sin eso el conector no arranca.
- **Un `projectId` equivocado se descubre por mail, no al configurar.** El síntoma es
  `project_not_found` y el mail **ya se perdió** (está `\Seen`).
- **El mapa no es visible en la interfaz de Jiku.** Un operador no puede consultar qué slug apunta a
  qué proyecto sin leer la configuración del conector.
- **Duplica conocimiento del producto** en configuración externa: los `projectId` de Jiku viven también
  acá.

### Risks

- **Riesgo: alguien renombra o borra un proyecto en Jiku** y el mapa queda apuntando a un id
  inexistente. Todos los mails de ese slug se pierden con `project_not_found`.
  - **Mitigación:** el log nombra el `projectId` fallido, así que el diagnóstico es directo. No está
    mitigada la pérdida de los mails que llegaron mientras tanto.
- **Riesgo: un cliente empieza a escribir a un slug que nadie cargó** y sus pedidos se descartan en
  silencio durante semanas.
  - **Mitigación:** el log de descarte **nombra el slug buscado**, que es precisamente el dato que hace
    falta para cargarlo. La métrica propuesta *"mails descartados por slug no mapeado, tendiendo a 0"*
    apunta a esto, pero hoy no está instrumentada.
- **Riesgo: el mapa crece y se vuelve difícil de mantener a mano** (decenas de proyectos).
  - **Mitigación:** ninguna en v1. Si ocurre, la salida está identificada como pregunta abierta: mover
    el slug a las propiedades extensibles por proyecto de Jiku, al precio de necesitar el plano de
    lectura.

## Alternatives Considered

### Alternativa 1: Resolver por consulta al bus (plano de lectura)

**Pros:**
- El mapa viviría en un solo lugar: la base de Jiku
- Cambios sin reiniciar el conector
- Visible en la interfaz del producto

**Cons:**
- **No es implementable:** `ticket_slug` está deliberadamente no expuesto ni filtrable en el contrato
  de consultas. **No hay query que acepte un slug**
- El campo **está marcado para eliminarse**
- Exigiría el plano de lectura, y con él la fila en `users` como precondición de arrancar
- Agregaría un round-trip por mail

**Why rejected:** No hay por dónde. Es la razón directa de que el KV local sea la decisión.

---

### Alternativa 2: KV local con el **nombre** del proyecto como valor

**Pros:**
- Más legible para un operador: `alfa → "Proyecto Alfa"` en vez de `alfa → 42`
- Sobrevive a una reasignación de ids

**Cons:**
- **Reintroduce el plano de lectura:** habría que resolver nombre → id por consulta, que es exactamente
  lo que esta decisión evita
- Los nombres cambian más que los ids, así que el mapa sería más frágil, no menos

**Why rejected:** Anula el beneficio principal (autosuficiencia) por una ganancia de legibilidad que un
comentario en la configuración resuelve igual.

---

### Alternativa 3: El slug como propiedad extensible del Proyecto en Jiku

Jiku ya guarda propiedades extensibles por proyecto; poner el slug ahí lo haría dato del producto.

**Pros:**
- **Un solo lugar de verdad**, visible en la interfaz de Jiku
- Se administra desde el producto, sin reiniciar el conector
- Escala a decenas de proyectos sin configuración a mano

**Cons:**
- Exige el plano de lectura en el conector, con todo lo que arrastra
- **Es una decisión del producto Jiku**, no de este repositorio: define que el slug de mail es dato de
  dominio de un proyecto
- Modificaría el producto (G-03)

**Why rejected:** Está fuera del alcance v1 por G-03. **Es la alternativa más prometedora a futuro** y
queda registrada como pregunta abierta 3 del PRD.

---

### Alternativa 4: Validar el proyecto antes de crear (consulta previa)

**Pros:**
- Detectaría un `projectId` equivocado antes de intentar el alta
- El mail no se marcaría `\Seen` en vano

**Cons:**
- **No agrega información:** `core` ya responde `project_not_found`, que nombra el problema real
- **Duplica la validación con la peor de las dos decidiendo** (el argumento con que Jiku eximió a la api
  de su compuerta de roles)
- **Adelantaría el fallo con un código que no señala la causa:** el plano de lectura exige fila en
  `users`, así que un conector recién desplegado fallaría con un error de autorización que no tiene
  nada que ver con el proyecto

**Why rejected:** Cambia un error que se explica por uno que no. Es el peor intercambio posible en un
servicio sin nadie mirando.

## References

- [Análisis técnico del discovery](../discovery/analisis-tecnico.md) — Arq-5
- [Análisis funcional del discovery](../discovery/analisis-funcional.md) — decisión 3, decisión 4; FG-2
  completo
- [Análisis de dominio del discovery](../discovery/analisis-dominio.md) — entidad "Entrada del Mapa de
  Tickets"; invariantes 4 y 5
- [PRD — Requerimientos](../prd/requirements.md) — C-09 a C-13; pregunta abierta 3
- [ADR-001](ADR-001-worker-unico-sin-persistencia.md) — sin persistencia propia (por qué no hay base
  donde guardar el mapa)
