# ADR-004: Resolver el proyecto con un KV local y no usar el plano de lectura

**Status:** Accepted
**Date:** 2026-08-26
**Deciders:** Technical Leader, Product Owner
**Tags:** ruteo, configuracion, plano-de-lectura

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

**El proyecto se resuelve contra un KV local —el Mapa de Tickets— cargado a mano, con el `projectId`
como valor. El conector no consulta el bus: sólo escribe.**

| Aspecto | Definición |
|---|---|
| Estructura | `slug` (string, único, minúsculas) → `projectId` (int) |
| Fuente | Variable de entorno o archivo montado |
| Momento de carga | **Al arrancar.** Sin recarga en caliente en v1 |
| Mapa vacío | **Estado válido**: el worker arranca y descarta todo con log |
| Mapa mal formado | **Fail-fast**: el worker no arranca |
| Validación del `projectId` | **Ninguna.** No se verifica que el proyecto exista |

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

- El Mapa de Tickets MUST cargarse desde variable de entorno o archivo montado, **al arrancar**
- El mapa MUST validarse al arrancar. Un mapa mal formado (JSON inválido, `projectId` no entero, dos
  entradas con el mismo `slug`) MUST provocar **fail-fast**: el proceso no arranca
- Un mapa **vacío** MUST ser aceptado como estado válido: el worker arranca y descarta todo con log
- Las claves del mapa MUST normalizarse **a minúsculas** al cargarlo
- El slug extraído del mail MUST normalizarse **a minúsculas** antes de buscarlo (comparación en
  minúsculas **en las dos puntas**)
- El valor de cada entrada MUST ser el `projectId` entero de Jiku. MUST NOT ser el nombre del proyecto
  ni su slug
- El conector MUST NOT verificar contra Jiku que el `projectId` exista antes de publicar
- El conector MUST NOT publicar en el plano de consultas del bus (`jiku-queries.*`)
- El slug MUST extraerse del `recipient` con la regex `^<prefijo>\+([^@]+)@`, case-insensitive, con el
  prefijo configurable (default: `tickets`)
- El `recipient` MUST tomarse de `Delivered-To`, con `To` como **único** fallback
- Un mail sin match de slug MUST descartarse con log, sin crear nada
- Un slug sin entrada en el mapa MUST descartarse con log que **nombre el slug buscado**
- El mapa MUST vivir sólo en memoria: MUST NOT escribirse a disco ni cachearse fuera del proceso

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
- **Fail-fast donde importa:** un mapa mal formado se detecta al arrancar, no en el primer mail.

### Negative

- **Agregar o cambiar un slug exige reiniciar el proceso.** No hay recarga en caliente en v1.
- **El mapa es configuración a mano**, así que puede quedar desactualizado sin que nadie lo note. El
  síntoma es un mail descartado con log, que nadie mira.
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
