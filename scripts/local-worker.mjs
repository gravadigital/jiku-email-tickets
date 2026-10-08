/**
 * El worker, corriendo en LOCAL contra el NATS local y el `fake-core.mjs`, SIN machine user.
 *
 * Reutiliza TODO el arranque real —configuracion, logger, apertura del Espacio KV, scheduler y
 * tick— y cambia EXACTAMENTE DOS COSAS:
 *
 *   1. La identidad: un `staticToken()` con un JWT no firmado en vez de `ServiceUser.fromKeyFile()`.
 *      El SDK solo necesita leer el `sub` del token para armar los subjects y el inbox; no lo
 *      verifica (verificarlo es trabajo del auth-callout, que aca no existe).
 *   2. Las creds: `creds: null`, que es como el SDK documenta "este bus no necesita sentinel".
 *
 * LO QUE ESTO NO PRUEBA: el auth-callout, los permisos por subject, la fila en `users` y el
 * refresh del token. Un NATS local sin operador deja publicar cualquier cosa. Todo eso solo se
 * verifica contra el bus real con la key — es la diferencia entre probar el CONECTOR y probar el
 * DESPLIEGUE.
 *
 * PRECONDICIONES: NATS con JetStream (`-js`) y `JIKU_KV` creado con `allow_direct` (lo que hace
 * `nats kv add`), sin TTL, y los slugs cargados en el espacio de la identidad local. La clave
 * completa lleva el prefijo `<instance>.<sub>.` que agrega el SDK, y es el `kvPrefix` que el worker
 * loguea en la linea 'espacio KV abierto':
 *   nats kv add JIKU_KV --history 1
 *   nats kv put JIKU_KV <instance>.<sub>.tickets.<slug> <projectId>
 *
 *   node scripts/local-worker.mjs
 */
import { staticToken } from '@gravadigital/jiku/auth';

import { loadDotenvUnlessTest } from '../dist/config/dotenv.js';

loadDotenvUnlessTest();

const { loadAppConfig } = await import('../dist/config/index.js');
const { initLogger } = await import('../dist/shared/logger.js');
const { connectToBus, closeBus } = await import('../dist/infra/bus/connection.js');
const { openKvSpace } = await import('../dist/infra/kv/space.js');
const { scheduleTick, waitForCurrentTick } = await import('../dist/domain/ingesta/scheduler.js');

/** Un JWT sin firmar cuyo unico contenido que importa es el `sub`. */
function fakeJwt(sub) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'none', typ: 'JWT' });
  // `exp` bien lejos: `staticToken` no refresca, y un token vencido haria que el proximo
  // reconnect sea rechazado.
  const body = b64({ sub, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 });
  return `${header}.${body}.local`;
}

const LOCAL_SUB = process.env.LOCAL_SUB ?? 'local-machine-user';

const config = await loadAppConfig();
const logger = initLogger(config);

logger.info(
  { instance: config.instance, servers: config.servers, sub: LOCAL_SUB },
  'MODO LOCAL: identidad falsa, NATS sin operador, sin auth-callout',
);

const auth = staticToken(fakeJwt(LOCAL_SUB));

// `creds: null` es la unica diferencia con produccion en esta llamada. El resto —timeoutMs,
// onTokenError, el no pasar userId ni inboxPrefix— sale del connectToBus() real.
const client = await connectToBus({ config, auth, logger, creds: null });

logger.info(
  { instance: client.instance, userId: client.userId, inboxPrefix: client.inboxPrefix },
  'conectado al bus local',
);

// El Espacio KV, sobre la conexion que ya existe. Falla si `JIKU_KV` no esta usable: es el
// fail-fast del arranque real, y en local sirve igual para no arrancar contra un KV que no existe.
// No hay nada que cargar: el slug se consulta una vez por mail (S-032).
const space = await openKvSpace({ client, logger });

const scheduledTask = scheduleTick(config, logger, client, space);

const shutdown = async () => {
  logger.info('apagando');
  await scheduledTask?.stop();
  await waitForCurrentTick();
  await closeBus();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
