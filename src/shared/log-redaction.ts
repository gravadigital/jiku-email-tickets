/**
 * Las rutas que el logger censura, y el censor.
 *
 * Vive separada de `logger.ts` a proposito: la pregunta "que esta protegido hoy?" tiene que tener
 * una respuesta de un archivo, legible de un vistazo por quien audita, y afirmable por un test
 * directo. Enterrada dentro del objeto de opciones de Pino no lo seria.
 *
 * SINTAXIS DE `redact.paths`, VERIFICADA CONTRA pino@10.3.1 — leer antes de tocar la lista:
 *
 * - El comodin `*` matchea EXACTAMENTE UN nivel. `'*.token'` cubre `{ auth: { token } }`, pero NO
 *   cubre `{ token }` en la raiz ni `{ a: { b: { token } } }` a dos niveles.
 * - NO existe comodin profundo. `'**.token'` no redacta nada: no falla, no avisa, simplemente deja
 *   el secreto en claro. Es la clase de detalle donde una suposicion razonable produce una lista
 *   que parece proteger y no protege.
 * - Por eso cada campo va DUPLICADO: la forma en raiz (`'token'`) y la forma con comodin
 *   (`'*.token'`). La duplicacion es el precio de la sintaxis, no descuido. NO "limpiarla".
 * - Los contextos a tres niveles o mas quedan fuera de alcance. Se acepta porque los puntos de log
 *   del conector son planos o de un nivel; si alguna story futura anida mas, tiene que agregar la
 *   ruta explicita.
 * - El indice con comodin (`'attachments[*].content'`) SI esta soportado, en las dos formas.
 * - Una ruta que apunta a un objeto censura el NODO COMPLETO: `'key'` sobre
 *   `{ key: { keyId, key, userId } }` deja `key: '[REDACTED]'` entero.
 */
export const REDACT_CENSOR = '[REDACTED]';

export const REDACT_PATHS = [
  // --- Tokens (CA-3) ---
  // El access token vive solo en memoria y no deberia llegar nunca a un contexto de log (ADR-005),
  // pero `redact` es la defensa estructural: cubre tambien el log que agregue codigo futuro sin
  // acordarse de la regla.
  'accessToken',
  '*.accessToken',
  'token',
  '*.token',
  'access_token',
  '*.access_token',

  // --- Credenciales genericas (CA-3) ---
  'credentials',
  '*.credentials',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',

  // --- Contenido de la key del machine user (CA-4) ---
  // Los nombres son los EXACTOS del SDK instalado:
  // `ServiceAccountKey = { type?, keyId, key, userId, expirationDate? }`. El campo `key` a secas ES
  // la clave privada RSA en PEM: un volcado accidental de ese objeto es la filtracion mas grave
  // posible de este servicio.
  //
  // RIESGO ACEPTADO, no re-litigar cuando aparezca el primer falso positivo: `key` es un nombre
  // generico y puede colisionar con un campo legitimo llamado `key` (la clave de un mapa, un
  // identificador). La consecuencia de la colision es que un campo inocuo salga como [REDACTED]
  // — molesto, y recuperable renombrando el campo del contexto. La consecuencia de NO cubrirlo es
  // una clave privada RSA en claro en el log. La asimetria es total, asi que se cubre.
  'key',
  '*.key',
  'keyId',
  '*.keyId',

  // --- Contenido del creds de NATS (CA-3) ---
  'creds',
  '*.creds',

  // --- Rutas a archivos de secretos (CA-3, via TS-19) ---
  // No son el secreto, son DONDE ESTA el secreto, y eso tambien es informacion que no va al log: es
  // el mismo criterio por el que la linea de arranque excluye credsFile y keyFile deliberadamente
  // (ADR-006). La diferencia con la linea de arranque es que alla se resuelve por omision —no se
  // incluye el campo— y aca por redaccion, que cubre el log que los incluya por error.
  'keyFile',
  '*.keyFile',
  'credsFile',
  '*.credsFile',

  // --- Cuerpo del mail y contenido de adjunto: DECLARADAS ANTES DE QUE EXISTAN LOS DATOS (CA-7) ---
  // En este alcance no hay cuerpos de mail ni adjuntos. Las rutas se declaran igual para que FG-2 y
  // FG-3 HEREDEN la regla en vez de tener que acordarse de agregarla: es lo que hace verificable
  // NFR-S06 desde el principio. El cuerpo es contenido de negocio y puede traer datos del cliente
  // — el log es el unico rastro de un ticket perdido, pero sigue siendo un log, no un deposito de
  // datos del cliente (ADR-006).
  'body',
  '*.body',
  'text',
  '*.text',
  'html',
  '*.html',
  'content',
  '*.content',
  'attachments[*].content',
  '*.attachments[*].content',

  // --- Texto del comentario publicado desde una respuesta (S-027, REQ-005 RF-24) ---
  //
  // Misma clase de dato que `body`: CONTENIDO DEL CLIENTE. La regla de ADR-006 nombraba el cuerpo
  // del mail y el contenido de un adjunto; el texto del comentario se agrega EXPLICITAMENTE porque
  // es exactamente lo mismo y el nombre del campo es otro.
  //
  // Es una defensa de SEGUNDA linea, no la primera. La primera es estructural: ningun punto de log
  // del publicador incluye el texto, y hay un test de propiedad que lo afirma escaneando `src/`.
  // Esta entrada existe para cubrir el log que agregue codigo FUTURO sin acordarse de la regla —
  // exactamente el mismo motivo por el que `body` y `content` se declararon antes de que existieran
  // los datos que nombran.
  //
  // LAS DOS FORMAS, y no es redundancia: pino NO tiene comodin profundo, asi que `'comment'` sola
  // dejaria `{ payload: { comment } }` en claro, y `'*.comment'` sola dejaria `{ comment }` en
  // claro. Cualquiera de las dos por separado falla EN SILENCIO, sin error y sin aviso.
  'comment',
  '*.comment',
] as const satisfies readonly string[];

// NO se agrega a la lista: `messageId`, `projectId`, `requirementId`, `slug`, `instance`, `id`.
// ADR-006 exige explicitamente que esos campos SI se logueen — son el rastro que hace reconstruible
// un ticket perdido. Redactarlos convierte el log en inutil, que es el fallo opuesto y no menos grave.
//
// NO se copian del catalogo: `req.headers.authorization`, `req.headers.cookie`. El servicio no
// expone HTTP (ADR-001), asi que esas rutas no pueden ocurrir jamas y solo agregan ruido a una
// lista que se lee para auditar que esta protegido.
