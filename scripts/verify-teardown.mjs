// TS-22: verifica, DESPUES de que la suite termino, que el contenedor NATS que levanto el
// globalSetup ya no esta corriendo. No puede ser un test: el teardown corre cuando todos los
// archivos de test ya terminaron, asi que ningun `it` puede observarlo.
//
// Uso: npm run test:teardown  (corre la suite y despues esta verificacion)

import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CONTAINER_ID_FILE = 'node_modules/.jiku-nats-container-id';

let containerId;
try {
  containerId = (await readFile(CONTAINER_ID_FILE, 'utf8')).trim();
} catch {
  console.error(
    `No se encontro ${CONTAINER_ID_FILE}. Correr la suite (npm test) antes de esta verificacion.`,
  );
  process.exit(1);
}

const { stdout } = await execFileAsync('docker', [
  'ps',
  '--filter',
  `id=${containerId}`,
  '--format',
  '{{.ID}} {{.Status}}',
]);

const stillRunning = stdout.trim();

if (stillRunning !== '') {
  console.error(
    `El contenedor NATS de la suite quedo corriendo tras el teardown: ${stillRunning}\n` +
      'El teardown() del globalSetup no lo detuvo.',
  );
  process.exit(1);
}

await rm(CONTAINER_ID_FILE, { force: true });

console.log(
  `Teardown verificado: el contenedor ${containerId.slice(0, 12)} de la suite no esta corriendo.`,
);
