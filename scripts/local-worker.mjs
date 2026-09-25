/**
 * El worker, corriendo en LOCAL contra el NATS local y el `fake-core.mjs`, SIN machine user.
 *
 * Reutiliza TODO el arranque real —configuracion, logger, apertura y verificacion de los dos
 * buckets del KV, `watch()` del Mapa de Tickets, scheduler y tick— y cambia EXACTAMENTE DOS COSAS:
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
 * PRECONDICIONES: NATS con JetStream (`-js`) y los dos buckets creados:
 *   nats kv add TICKETS --history=1
 *   nats kv add MAIL_THREADS --ttl=90d --history=1
 *   nats kv put TICKETS <slug> <projectId>
 *
 *   node scripts/local-worker.mjs
 */
import { staticToken } from '@gravadigital/jiku/auth';

import { loadDotenvUnlessTest } from '../dist/config/dotenv.js';

loadDotenvUnlessTest();

const { loadAppConfig, withTicketMap } = await import('../dist/config/index.js');
const { initLogger } = await import('../dist/shared/logger.js');
const { connectToBus, closeBus } = await import('../dist/infra/bus/connection.js');
const { openKvStores } = await import('../dist/infra/kv/stores.js');
const { startTicketMapWatch } = await import('../dist/infra/kv/ticket-map.js');
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

const baseConfig = await loadAppConfig();
const logger = initLogger(baseConfig);

logger.info(
  { instance: baseConfig.instance, servers: baseConfig.servers, sub: LOCAL_SUB },
  'MODO LOCAL: identidad falsa, NATS sin operador, sin auth-callout',
);

const auth = staticToken(fakeJwt(LOCAL_SUB));

// `creds: null` es la unica diferencia con produccion en esta llamada. El resto —timeoutMs,
// onTokenError, el no pasar userId ni inboxPrefix— sale del connectToBus() real.
const client = await connectToBus({ config: baseConfig, auth, logger, creds: null });

logger.info(
  { instance: client.instance, userId: client.userId, inboxPrefix: client.inboxPrefix },
  'conectado al bus local',
);

// Los dos buckets, sobre la conexion que ya existe. Falla si no estan creados: es el fail-fast
// que S-024 puso a proposito, y en local sirve igual para no arrancar contra un KV vacio.
const kv = await openKvStores({ client, config: baseConfig, logger });

// El watch del Mapa de Tickets: espera la carga inicial antes de devolver, asi que el primer tick
// nunca corre con el mapa a medio llenar.
const ticketMapWatch = await startTicketMapWatch({ tickets: kv.tickets, config: baseConfig, logger });

const config = withTicketMap(baseConfig, ticketMapWatch.ticketMap);

logger.info(
  { slugs: [...config.ruteo.ticketMap.keys()] },
  'Mapa de Tickets cargado desde el KV',
);

const scheduledTask = scheduleTick(config, logger, client, kv.threads);

const shutdown = async () => {
  logger.info('apagando');
  await scheduledTask?.stop();
  await waitForCurrentTick();
  ticketMapWatch.stop?.();
  await closeBus();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
