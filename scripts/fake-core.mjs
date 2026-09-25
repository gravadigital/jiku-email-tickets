/**
 * Un `core` de mentira, para probar el conector en local SIN Jiku.
 *
 * Se suscribe a los dos subjects que el conector publica y responde envelopes validos del
 * protocolo. Ademas levanta un HTTP local que hace de storage para el `PUT` del byte, asi que el
 * camino de adjuntos tambien se ejercita completo.
 *
 * LO QUE ESTO **NO** PRUEBA, y conviene tenerlo presente: el auth-callout, los permisos por
 * subject y la fila en `users`. Un NATS pelado deja publicar cualquier cosa, asi que un error de
 * rol o de subject NO aparece aca — eso solo se ve contra el bus real con la key.
 *
 *   node scripts/fake-core.mjs
 */
import { createServer } from 'node:http';

import { connect } from '@gravadigital/jiku/nats';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const STORAGE_PORT = Number(process.env.FAKE_STORAGE_PORT ?? 4599);

// Que el `PUT` del byte falle, para ejercitar la rama de aviso de fallo de subida sin tener que
// romper nada: FAKE_STORAGE_FAIL=true
const STORAGE_FAILS = process.env.FAKE_STORAGE_FAIL === 'true';

let nextFileId = 1000;
let nextRequirementId = 5000;
let nextCommentId = 9000;

const received = [];

// ---------------------------------------------------------------- el storage de mentira
const storage = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bytes = Buffer.concat(chunks).length;
    if (STORAGE_FAILS) {
      console.log(`  [storage] ${req.method} ${req.url} -> 500 (FAKE_STORAGE_FAIL=true)`);
      res.writeHead(500).end('fallo simulado');
      return;
    }
    console.log(`  [storage] ${req.method} ${req.url} -> 200  (${bytes} bytes recibidos)`);
    res.writeHead(200).end();
  });
});
await new Promise((resolve) => storage.listen(STORAGE_PORT, resolve));
console.log(`[storage] escuchando en http://localhost:${STORAGE_PORT}`);

// ---------------------------------------------------------------- el core de mentira
const nc = await connect({ servers: NATS_URL, name: 'fake-core' });
console.log(`[core]    conectado a ${NATS_URL}`);

// `*` matchea UN token completo, no un prefijo. Esto cubre `{instance}.{userId}.jiku-commands.v1.>`
// para cualquier instancia y cualquier caller.
const sub = nc.subscribe('*.*.*.v1.>');
console.log('[core]    suscripto a *.*.*.v1.>  — esperando comandos\n');

for await (const msg of sub) {
  const method = msg.subject.split('.v1.')[1] ?? '(sin metodo)';
  let payload = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(msg.data));
  } catch {
    // Un cuerpo que no es JSON igual se responde: el conector nunca se queda sin reply.
  }

  received.push({ method, payload });
  console.log(`[core]    <- ${method}`);

  let reply;

  if (method === 'files.request-upload') {
    const fileId = nextFileId++;
    reply = {
      status: 'success',
      data: {
        fileId,
        uploadUrl: `http://localhost:${STORAGE_PORT}/f/${fileId}-${payload.fileName ?? 'sin-nombre'}`,
      },
    };
    console.log(`             fileName=${payload.fileName}  mimeType=${payload.mimeType}  fileSize=${payload.fileSize}`);
    console.log(`             -> fileId ${fileId}`);
  } else if (/^requirements\.\d+\.comment$/.test(method)) {
    const requirementId = Number(method.split('.')[1]);
    const id = nextCommentId++;
    reply = { status: 'success', data: { id } };
    console.log(`             requirementId=${requirementId}  visibilityLevel=${payload.visibilityLevel}`);
    console.log(`             fileIds=${JSON.stringify(payload.fileIds ?? null)}`);
    console.log(`             --- comment ---`);
    for (const line of String(payload.comment ?? '').split('\n')) {
      console.log(`             | ${line}`);
    }
    console.log(`             -> comment ${id} en requisito ${requirementId}`);
  } else if (method === 'requirements.new') {
    const id = nextRequirementId++;
    reply = { status: 'success', data: { id } };
    console.log(`             projectId=${payload.projectId}  type=${payload.type}  priority=${payload.priority}`);
    console.log(`             title="${payload.title}"`);
    console.log(`             fileIds=${JSON.stringify(payload.fileIds ?? null)}`);
    console.log(`             --- description ---`);
    for (const line of String(payload.description ?? '').split('\n')) {
      console.log(`             | ${line}`);
    }
    console.log(`             -> requirement ${id}`);
  } else {
    // Deny-by-default, igual que el registry real: un metodo que no esta, no esta.
    reply = {
      status: 'failure',
      errorCode: 'unknown_command',
      errorMessage: `el fake-core no implementa ${method}`,
    };
    console.log(`             -> unknown_command`);
  }

  console.log('');
  msg.respond(new TextEncoder().encode(JSON.stringify(reply)));
}
