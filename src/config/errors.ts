import { SERVICE_NAME } from '#shared/service-info.js';
import { AppError } from '#shared/errors/index.js';

/**
 * Que se esperaba de cada variable, en palabras propias del conector.
 *
 * Esta tabla es lo que hace imposible filtrar un secreto (CA-10): el formateador toma solo
 * `issue.path` y describe la variable desde aca. El `message` de Zod no se interpola nunca, asi que
 * un valor no puede llegar al mensaje ni siquiera si una version futura de Zod empieza a incluir el
 * input en el issue.
 */
const EXPECTATIONS: Record<string, string> = {
  JIKU_CREDS: 'se esperaba una ruta no vacia al archivo creds del sentinel',
  JIKU_KEY_FILE: 'se esperaba una ruta no vacia a la key JSON del machine user',
  JIKU_PROJECT_ID: 'se esperaba el project id de Zitadel, no vacio',
  JIKU_VERIFY_PROJECT_ID: 'se esperaba un entero positivo (el proyecto de Jiku del modo de verificacion)',
  JIKU_INSTANCE: 'se esperaba un nombre de instancia no vacio',
  JIKU_SERVERS: 'se esperaba una URL de servidores no vacia',
  JIKU_ISSUER: 'se esperaba una URL valida del issuer de Zitadel',
  JIKU_TIMEOUT: 'se esperaba un entero positivo de milisegundos',
  LOG_LEVEL: 'se esperaba uno de: trace, debug, info, warn, error, fatal, silent',
};

const UNKNOWN_EXPECTATION = 'no paso la validacion declarada en el schema';

export class ConfigValidationError extends AppError {
  readonly code = 'CONFIG_VALIDATION_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. 500 porque una config invalida es un fallo del despliegue,
  // no del input de un cliente. Su valor no se consume en ningun lado.
  readonly httpStatus = 500;

  readonly variables: string[];

  constructor(message: string, variables: string[]) {
    super(message, { variables });
    this.variables = variables;
  }
}

/** Forma minima de un issue de Standard Schema: solo se lee `path`. */
interface ValidationIssueLike {
  readonly path?: PropertyKey[] | readonly unknown[] | undefined;
}

function variableNameOf(issue: ValidationIssueLike): string | undefined {
  const segment = issue.path?.[0];
  if (typeof segment === 'string') return segment;
  // Standard Schema permite segmentos como { key }.
  if (typeof segment === 'object' && segment !== null && 'key' in segment) {
    const { key } = segment as { key: unknown };
    if (typeof key === 'string') return key;
  }
  return undefined;
}

/**
 * Traduce los issues agregados de la validacion en un unico error con la lista completa.
 *
 * `@t3-oss/env-core` invoca `onValidationError` una sola vez con todos los issues, asi que este es
 * el unico lugar donde se construye el reporte que U-02 lee para arreglar el despliegue en una sola
 * pasada (CA-2).
 */
export function toConfigValidationError(issues: readonly ValidationIssueLike[]): ConfigValidationError {
  const variables = [...new Set(issues.map(variableNameOf).filter((name): name is string => name !== undefined))].sort();

  const count = variables.length;
  const subject = count === 1 ? '1 variable' : `${String(count)} variables`;
  const closing = count === 1 ? 'Corregila' : `Corregi las ${String(count)}`;
  const lines = [
    `${SERVICE_NAME}: la configuracion es invalida. Faltan o son invalidas ${subject}:`,
    ...variables.map((name) => `  - ${name}: ${EXPECTATIONS[name] ?? UNKNOWN_EXPECTATION}`),
    `El proceso no arranca. ${closing} y volve a intentar.`,
  ];

  return new ConfigValidationError(lines.join('\n'), variables);
}
