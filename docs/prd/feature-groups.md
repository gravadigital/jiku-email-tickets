---
created: 2026-08-26
last_updated: 2026-08-26
status: Pending Formalization
---

# PRD — Feature Groups

> Derivado del discovery: [análisis funcional](../discovery/analisis-funcional.md) · [análisis de dominio](../discovery/analisis-dominio.md) · [análisis técnico](../discovery/analisis-tecnico.md)

## Overview

Este documento contiene los feature groups identificados durante la inicialización del producto
**jiku-mail-connector**.

**Los feature groups son agrupaciones de funcionalidad relacionada** que deben ser capturadas como
requests, diseñadas técnicamente y formalizadas en stories antes de iniciar la implementación.

**Proceso para formalizar cada feature group:**

1. `/product-new-request` — Capturar requerimiento y clarificar alcance
2. `/product-design-request REQ-XXX` — Diseñar solución técnica y proponer story split
3. `/product-create-stories REQ-XXX` — Crear stories implementables

**Status actual:** 4 feature groups pendientes de formalización (21-28 stories estimadas).

### Nota sobre el orden elegido

El mapa funcional del discovery propone como FG-1 la *Ingesta IMAP*, pero se declara
explícitamente **"Borrador"** y delega la formalización a este documento. Ese orden se cambió a
propósito, y la razón es dónde está el riesgo de este producto:

**El dominio del mail se conserva casi intacto del servicio existente y funciona en producción. Lo
que nunca se ejerció es la conexión al bus de Jiku** — y el discovery documenta que sus tres
trampas (el prefijo de inbox, un token sin el claim de roles, y el token en un reconnect)
**fallan sin señalar su causa**. Empezar por IMAP dejaría toda la incertidumbre para el final.

Hay además un hecho específico de este conector que sólo se descubre conectando: **la fila del
conector en `users` la crea Jiku sola en su primera autenticación**, y hasta que exista, todo
comando falla con `caller_not_authorized`. Eso no se verifica leyendo documentación.

Por eso FG-1 es un walking skeleton que atraviesa el bus con un payload de mentira, y la ingesta
real pasa a FG-2.

---

## Feature Group 1: Walking skeleton — del arranque al bus

**Status:** Pending

**Descripción:**

Toda la base técnica del worker más la travesía completa del plano de escritura de Jiku, con datos
fijos y **sin IMAP**. Incluye el repositorio y el toolchain (Node.js ≥ 22.12, TypeScript 5.x con
`strict: true`, ESM), el módulo único de configuración tipada con validación fail-fast, el logging
estructurado a stdout, y la construcción de la identidad en el bus con
`ServiceUser.fromKeyFile()` y un único `connect()` conservado por toda la vida del proceso.

Cierra publicando un `requirements.new` real con un payload armado a mano: un requisito de prueba
en un proyecto de prueba. No hay casilla de mail, no hay slug, no hay adjuntos — hay un proceso
que arranca, se autentica, publica un comando y traduce la respuesta.

Este feature group es foundational en el sentido estricto: sin él no se sabe si el conector puede
escribir en Jiku, que es la única cosa que el conector hace.

**Por qué es importante?:**

- **Resuelve el riesgo arquitectónico del proyecto entero, y de la única forma en que se puede
  resolver: atravesándolo.** Al terminarlo se sabe que el machine user está bien creado, que el rol
  `internal-app` está asignado, que la fila en `users` existe, y que el plano de escritura está
  abierto para esta identidad.
- **Los tres errores que no señalan su causa se descubren acá**, con un payload trivial, en vez de
  en FG-3 mezclados con un bug de parseo de mail. Sin prefijo de inbox *todas* las requests dan
  timeout y la violación queda en el log del servidor NATS, no del cliente; un token sin el claim
  de roles no conecta a nada y el error dice sólo `Authorization Violation`.
- **Establece la observabilidad desde la primera línea**, que en este conector no es un accesorio:
  es el único rastro de un ticket perdido (G-05).
- Valida las precondiciones de despliegue que nadie verifica automáticamente: el rol en Zitadel, el
  creds del sentinel, el project id, y la red al bus.

**Capabilities que implementa:**

- C-27: Validar la configuración al arrancar (from F-05)
- C-28: Emitir logs estructurados a stdout (from F-05)
- C-29: No filtrar datos sensibles al log (from F-05)
- C-14: Construir la identidad y conectar al bus (from F-03)
- C-15: Mantener el token fresco (from F-03)
- C-17: Publicar `requirements.new` y esperar la respuesta (from F-03)
- C-19: Traducir el error distinguiendo qué sistema rechazó (from F-03)
- NFR-S02 a NFR-S07, NFR-O01, NFR-O02, NFR-O06, NFR-O07, NFR-R04, NFR-R07, NFR-P03, NFR-P05:
  baseline de identidad, secretos, logging y runtime

**Precondiciones:**

- Machine user creado en Zitadel con Access Token Type = **JWT** y el rol `internal-app` asignado en
  el project de gestión. **Sin el rol, la conexión al bus se rechaza** — no hay catch-all en
  `rules.yaml` — y el síntoma es `Authorization Violation`, no un fallo por mail.
- **Key JSON del machine user descargada y guardada.** Zitadel la entrega una sola vez: no se puede
  volver a bajar, sólo reemplazar por una nueva.
- Creds del sentinel del bus montado y alcanzable (`JIKU_CREDS`), y el project id de Zitadel
  configurado (`JIKU_PROJECT_ID`) — sin él el token no lleva roles y no conecta a nada.
- Una instancia de Jiku desplegada y alcanzable, con al menos un `projectId` real para la prueba.
- Red al bus: el conector va **dentro** de la red del bus, que no está expuesta al ingress.

**Postcondiciones:**

- Repositorio con el toolchain configurado (Node ≥ 22.12, TS strict, ESM) y el SDK
  `@gravadigital/jiku` ^1.0.0 como dependencia.
- El worker arranca correctamente, o **no arranca informando la lista completa** de lo que falta.
- Módulo único de configuración tipado: `process.env` no se lee en ningún otro lugar del código.
- Logs estructurados a stdout (JSON en producción), sin credenciales ni datos sensibles.
- Una única conexión al bus por proceso, con el `user-id` del subject derivado de la key y el token
  refrescándose en background.
- **Hay un requisito visible en Jiku creado por el conector.**
- **El conector tiene fila en `users`** (`identity_type: service`, `email` en `NULL`), creada por
  Jiku en la primera autenticación.
- Los errores de los tres sistemas —bus por subject, `core` por rol, `core` por forma— quedan
  distinguidos en el log por clase del SDK.

**Valor entregado:**

Ningún actor externo puede hacer nada todavía: no hay ingesta de mail. El valor es interno y es el
más alto del proyecto — **el riesgo arquitectónico queda resuelto y todo lo que sigue es dominio
conocido**. U-02 obtiene además la validación de que las precondiciones de despliegue están bien
hechas, que es lo que de otro modo se descubre tarde y con un síntoma opaco.

*Stories estimadas: 5-6*

---

## Feature Group 2: Ingesta y normalización del mail

**Status:** Pending

**Descripción:**

El poll IMAP completo y la normalización del mail a la forma de trabajo. El cron dispara el tick
sin solaparse con el anterior; el tick conecta por TLS, toma el lock de `INBOX`, busca los
`\Unseen`, ordena los UIDs de más nuevo a más viejo y toma los primeros N según el cap, marcando
cada mensaje `\Seen` a medida que lo descarga.

La normalización deja cada mail en la forma que el resto del conector consume: `messageId`
obligatorio, `referenceIds` como unión deduplicada de `In-Reply-To` y `References`, `recipient`
desde `Delivered-To` con `To` como fallback, asunto sin los prefijos `Re:`/`Fwd:`/`RV:` quitados
iterativamente, cuerpo en texto plano sin el texto citado del hilo (convirtiendo desde HTML si el
mail es sólo HTML), y los adjuntos parseados con su `Content-Disposition` y `Content-ID`.

Es el feature group que **se conserva casi intacto** del servicio existente: el dominio del mail no
cambia porque cambie la arquitectura de escritura.

**Por qué es importante?:**

- Es la única entrada del sistema. Sin ella el conector no tiene de dónde sacar un pedido.
- Es **dominio ya probado en producción** por `grava-gestion/mail-integration`: el riesgo es bajo y
  el trabajo es conocido, que es exactamente por qué conviene hacerlo después del skeleton y no
  antes.
- Al terminarlo, U-02 puede ver en los logs qué está llegando realmente a la casilla y con qué
  forma — información que hasta ahora no existe en ningún lado.
- Establece las tres reglas de resiliencia del tick que sostienen todo lo demás: un mail que falla
  no aborta el lote, un fallo del tick no tumba el worker, y dos ticks no se solapan.

**Capabilities que implementa:**

- C-01: Disparar el tick del poll (from F-01)
- C-02: Conectar a IMAP y tomar el lock de la carpeta (from F-01)
- C-03: Buscar los mails no vistos y aplicar el cap (from F-01)
- C-04: Descargar el mensaje crudo y marcarlo `\Seen` (from F-01)
- C-05: Normalizar el mail a la forma de trabajo (from F-01)
- C-06: Convertir un mail sólo-HTML a texto plano (from F-01)
- C-07: Parsear los adjuntos de las partes MIME (from F-01)
- C-08: Contabilizar y loguear el resultado del tick (from F-01)
- C-30: Emitir las métricas del tick (from F-05)
- NFR-S01, NFR-S06, NFR-P01, NFR-P02, NFR-R04, NFR-R05, NFR-R06, NFR-O03: TLS, no filtrar el cuerpo
  del mail, latencia y cap, aislamiento de fallos, no solapamiento, trazabilidad

**Precondiciones:**

- Feature Group 1 completo (config, logging y worker que arranca).
- **La casilla de tickets acepta subaddress (`+slug`) y tiene IMAP habilitado.** Con Gmail hace
  falta App Password, no la contraseña de la cuenta.
- Credenciales IMAP disponibles como secretos del entorno.

**Postcondiciones:**

- El worker drena la casilla en ticks sucesivos, sin solaparse, procesando **los más nuevos
  primero** y difiriendo el resto con un warn que dice cuántos quedaron.
- Cada mensaje procesado queda marcado `\Seen`; un mensaje que no se pudo descargar **no** se marca
  y lo reintenta el próximo tick.
- Cada mail queda normalizado en memoria y **se descarta al terminar el tick** — el conector no
  persiste nada.
- Cada tick emite una línea con los cinco contadores (ingestados, parseados, creados, descartados,
  fallidos).
- Un mail sin `Message-Id`, o que no se puede parsear, se descarta con warn sin abortar el lote.
- Las credenciales, el tráfico IMAP crudo y **el cuerpo del mail** no aparecen en ningún log.

**Valor entregado:**

Observable, pero todavía no útil para U-01 ni U-03: los mails se leen y se descartan sin crear
nada. Para **U-02** el valor es concreto y nuevo — es la primera visibilidad real de qué llega a la
casilla, con qué volumen y con qué forma, que es justamente el dato que falta para validar las
suposiciones de volumen (NFR-P06) y para cargar el Mapa de Tickets del próximo feature group.

*Stories estimadas: 5-7*

---

## Feature Group 3: Ruteo y alta del requisito — el primer mail que se vuelve ticket

**Status:** Pending

**Descripción:**

Une las dos mitades del conector. Carga el Mapa de Tickets desde variable de entorno o archivo
montado con fail-fast si está mal formado; extrae el `<slug>` del subaddress del `recipient`,
normalizándolo a minúsculas; lo resuelve a un `projectId` contra el KV; y aplica los cinco motivos
de descarte —sin slug, slug no mapeado, **es una respuesta**, sin `Message-Id`, no parseable— cada
uno con su línea de log.

Con el proyecto resuelto, arma el payload real desde el mail: título limpio truncado a 255 antes de
publicar, placeholders cuando el asunto o el cuerpo vienen vacíos, `type: incidencia`,
`priority: sin_prioridad`, `visibilityLevel: public`, **sin `state`** (nace en `analisis`) y **sin
`actor`**. Publica, y loguea el `Message-Id`, el `projectId` y el `id` del requisito creado.

El descarte activo de las respuestas al hilo es parte del alcance de este grupo y no un detalle:
sin esa regla, la respuesta de un cliente crearía un requisito nuevo duplicado en vez de un
comentario.

**Por qué es importante?:**

- **Es el feature group que cumple G-01.** Al terminarlo el producto existe: el último canal de
  pedido sin trazabilidad queda cerrado.
- Cumple G-02 sin pedirle nada al cliente: U-01 sigue mandando un mail como siempre.
- Materializa G-04 (degradar hacia el descarte). Es donde se implementa la falla segura: un mail que
  no resuelve **no crea nada**, porque un requisito en el proyecto equivocado sería visible a un
  cliente que no debía verlo.
- Es el primer feature group **desplegable y útil tal cual**, sin esperar el siguiente.

**Capabilities que implementa:**

- C-09: Cargar el Mapa de Tickets al arrancar (from F-02)
- C-10: Extraer el slug del subaddress (from F-02)
- C-11: Resolver el slug a un `projectId` (from F-02)
- C-12: Descartar una respuesta a un hilo (from F-02)
- C-13: Descartar en silencio lo que no resuelve (from F-02)
- C-16: Armar el payload del alta (from F-03)
- C-18: Registrar el alta exitosa (from F-03)
- NFR-R01, NFR-R03, NFR-SC03, NFR-SC04, NFR-O03, NFR-O04: garantía de entrega asumida, sin
  reintento, una sola instancia, trazabilidad y diagnóstico del rechazo

**Precondiciones:**

- Feature Groups 1 y 2 completos.
- **Mapa de Tickets cargado con al menos una entrada.** Un mapa vacío es un estado válido pero el
  conector descarta todo, así que no permite verificar nada.
- **Los `projectId` del mapa existen** en la instancia de Jiku a la que apunta. Nadie lo verifica
  antes: el síntoma de un id equivocado es `project_not_found` por mail.

**Postcondiciones:**

- Un mail a `tickets+<slug>@` con slug mapeado **crea un requisito en su proyecto**, en estado
  `analisis`, con `type: incidencia` y `visibilityLevel: public`.
- Un asunto de más de 255 caracteres se trunca **antes de publicar**, sin fallar en la base con un
  error genérico.
- Un asunto o un cuerpo vacíos producen un requisito con los placeholders configurados, nunca con
  campos vacíos.
- Todo lo que no resuelve se descarta con **una** línea de log que nombra el motivo, y el slug
  buscado cuando el motivo es que no está mapeado.
- **Una respuesta a un hilo no crea un requisito duplicado**: se descarta con log explícito.
- El mapa mal formado o con slugs duplicados hace que el worker **no arranque**.

**Valor entregado:**

**El valor completo del producto, sin adjuntos.** U-01 manda un mail a `tickets+<slug>@grava.io` y
su pedido aparece en el portal Opus, con la misma trazabilidad que uno cargado a mano; U-03 lo ve
en Jiku, en el proyecto correcto, y trabaja sobre él como sobre cualquier otro requisito — sin
enterarse de que entró por mail. U-02 tiene el log que dice, mail por mail, qué se creó y qué se
descartó y por qué.

*Stories estimadas: 6-8*

---

## Feature Group 4: Adjuntos

**Status:** Pending

**Descripción:**

Los tres planos separados de la subida, que es donde la arquitectura de Jiku cambia más el **cómo**
sin cambiar el **qué**. Antes de publicar el alta: partición de los adjuntos por la política local
(doble lista blanca de extensión y MIME, más el tope de tamaño), deduplicación por checksum sha256
dentro del mismo mail, y por cada aceptado hasta el tope de 10 un `files.request-upload` seguido
del **`PUT` directo del byte a la URL prefirmada** — no por el bus, porque el `max_payload` de NATS
es 1 MB y los adjuntos llegan a 10 MB.

Los `fileIds` acumulados van en el alta del requisito, y `core` crea el requisito y sus vínculos en
la misma transacción, validando la titularidad de cada archivo. Cierra con la composición
determinística de la descripción: cuerpo base, avisos de rechazo, avisos de fallo de subida, y los
placeholders **siempre al final**.

Ningún fallo de un archivo cancela el requisito, en ningún punto del flujo.

**Por qué es importante?:**

- **La captura de pantalla es el adjunto más frecuente de un ticket.** Un pedido que llega sin ella
  obliga al equipo a pedirla por otro canal, que es exactamente la fricción que el producto vino a
  eliminar (G-02).
- Es lo que hace que el ticket llegue **completo** y no como un texto que hay que completar después.
- Ejercita la parte de la arquitectura de Jiku que ningún feature group anterior toca: el segundo
  comando, el storage con URL prefirmada, y la titularidad resuelta por construcción.
- Cierra el alcance v1.

**Capabilities que implementa:**

- C-20: Particionar los adjuntos por la política local (from F-04)
- C-21: Deduplicar por checksum dentro del mail (from F-04)
- C-22: Pedir permiso de subida (from F-04)
- C-23: Subir el byte a la URL prefirmada (from F-04)
- C-24: Aplicar el tope de 10 archivos (from F-04)
- C-25: Vincular los archivos al requisito (from F-04)
- C-26: Componer la descripción final (from F-04)
- NFR-S04, NFR-P04, NFR-R08, NFR-SC01, NFR-SC02: cero credenciales de storage, timeout del `PUT`,
  fallo de archivo que no cancela, tope de 10 y tamaño máximo

**Precondiciones:**

- Feature Group 3 completo (el alta del requisito tiene que funcionar antes de agregarle archivos).
- Política de archivos configurada en `system_settings` de Jiku (extensiones aceptadas, MIME
  aceptados, tamaño máximo, TTL de la URL prefirmada).
- Storage S3-compatible alcanzable por el conector **sin credenciales**, sólo con la URL firmada.
  **No hace falta CORS**: el `PUT` lo hace un proceso de servidor, no un navegador.

**Postcondiciones:**

- Los adjuntos aceptables llegan **vinculados al requisito**, visibles en Jiku junto al pedido.
- Los rechazados por la política local y los rechazados por `core` dejan **aviso** en la
  descripción; los duplicados por checksum **no dejan nada**.
- Un mail con más de 10 adjuntos aceptables sube 10 y anota el resto como aviso.
- **Ningún fallo de archivo cancela un requisito**: un `PUT` fallido, un `files.request-upload` que
  responde `failure` o una política desalineada dejan el requisito creado con su aviso.
- Los archivos subidos cuyo alta de requisito falló quedan **huérfanos**, y eso es un estado válido
  que nadie limpia.
- La descripción se compone siempre en el mismo orden, con los placeholders al final.
- El conector sigue sin credenciales de S3 y sin elegir dónde se guarda un archivo.

**Valor entregado:**

**El ticket llega completo.** U-01 adjunta la captura de su error y el equipo la ve sin pedirla;
U-03 abre el requisito en Jiku con sus archivos ya vinculados. Cierra el alcance v1: a partir de
acá el conector hace todo lo que se propuso hacer.

*Stories estimadas: 5-7*

---

## Sequencing Notes

**FG-1 → FG-2 → FG-3 → FG-4 es estrictamente secuencial.** Ninguno de los cuatro puede empezar en
paralelo con el anterior, y cada dependencia tiene una razón concreta:

**Feature Group 1 (Walking skeleton)** va primero porque **todo el riesgo desconocido del proyecto
está del lado del bus, no del lado del mail**. El dominio del mail se conserva de un servicio que
funciona en producción; la conexión al bus nunca se ejerció, y sus tres trampas fallan sin señalar
su causa. Además hay una precondición que sólo se satisface conectando: la fila del conector en
`users` la crea Jiku en su primera autenticación, y hasta que exista todo comando falla con
`caller_not_authorized`. Es el único feature group que no entrega valor externo, y es el que más
incertidumbre elimina.

**Feature Group 2 (Ingesta)** depende de FG-1 por la configuración y el logging, pero la razón
principal para no adelantarlo es la inversa: es trabajo conocido y de bajo riesgo, así que
adelantarlo sólo posterga el descubrimiento de los problemas del bus. Su valor propio —ver qué
llega realmente a la casilla— es además el insumo para cargar el Mapa de Tickets de FG-3.

**Feature Group 3 (Ruteo y alta)** es el único que necesita **las dos mitades** —el mail
normalizado de FG-2 y el cliente del bus de FG-1— y por eso es el tercero y no el segundo. Es el
primero que entrega el valor del producto y el primero desplegable de forma útil.

**Feature Group 4 (Adjuntos)** va último, y el orden no es negociable: el `PUT` a la URL prefirmada
depende de que `files.request-upload` funcione bajo esta identidad, y eso sólo se puede verificar
con el bus ya ejercido y el alta del requisito ya funcionando. Vincular archivos a un requisito que
todavía no se crea no es testeable.

### Sobre F-05 (Configuración, identidad y observabilidad)

**F-05 no es un feature group propio, a propósito.** Sus capabilities se reparten: C-27, C-28 y
C-29 nacen en FG-1 como infraestructura del skeleton, y C-30 en FG-2, cuando por primera vez hay un
tick con contadores que emitir.

La razón es que la observabilidad de este conector es transversal y **tiene que existir desde la
primera línea de código, no agregarse al final**. En un worker sin usuario mirando una pantalla, un
ticket perdido no tiene síntoma: el log es su único rastro. Un feature group de "observabilidad"
al final del plan implicaría que los tres anteriores se construyeron sin ella, que es precisamente
el error que este diseño evita.

### Cobertura

Las 30 capabilities de `requirements.md` (C-01 a C-30) están asignadas a exactamente un feature
group, sin solapamientos y sin huérfanas:

| Feature Group | Capabilities | Cantidad |
|---|---|---|
| FG-1 | C-14, C-15, C-17, C-19, C-27, C-28, C-29 | 7 |
| FG-2 | C-01 a C-08, C-30 | 9 |
| FG-3 | C-09 a C-13, C-16, C-18 | 7 |
| FG-4 | C-20 a C-26 | 7 |

**Total estimado: 21-28 stories**, con los cuatro grupos dentro del rango de 3-8 stories.
