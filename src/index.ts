import 'dotenv/config';

import { reportStartupFailure, runStartup } from './startup.js';

/**
 * El entry point del WORKER (`npm run start`).
 *
 * No publica NINGUN comando, y eso es una restriccion estructural y no una preferencia (CA-2): un
 * requisito creado no se modifica ni se borra nunca (invariante 9) y no hay comando de
 * compensacion, asi que si la publicacion ocurriera en cada arranque CADA REINICIO dejaria basura
 * permanente en el proyecto de Jiku. El modo de verificacion es un script SEPARADO
 * (`src/verify.ts`), y este archivo no importa nada de `#domain/publicacion/` — hay un test de
 * propiedad que escanea el codigo para afirmarlo.
 */
async function main(): Promise<void> {
  await runStartup();

  // El proceso queda VIVO con la conexion abierta: el worker no cierra el cliente ni sale con 0.
  // La asimetria con `verify` —que SI cierra— es correcta y deliberada: `verify` es un proceso de
  // vida corta que tiene que terminar, y este es un worker que espera trabajo.
  //
  // Tampoco se agrega manejo de senales ni apagado ordenado: el worker todavia no hace nada
  // periodico, y el apagado ordenado tiene sentido cuando haya un tick en vuelo que perder (FG-2).
  // Agregarlo ahora seria codigo sin ningun criterio que lo verifique.
}

main().catch((error: unknown) => {
  reportStartupFailure(error);

  // process.exitCode en vez de process.exit(1): deja que Node drene los streams antes de salir.
  // Con process.exit() el mensaje de stderr se puede perder si el stream esta bufferizado —
  // justamente el mensaje que el arranque existe para entregar.
  process.exitCode = 1;
});
