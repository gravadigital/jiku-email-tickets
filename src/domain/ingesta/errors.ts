import { AppError } from '#shared/errors/index.js';

/**
 * El mail no tiene header `Message-Id`: se descarta (CA-1).
 *
 * Es un DESCARTE, no un fallo de parseo: el tick (S-010) los cuenta distinto
 * (`descartados` vs. `fallidos`), y distinguirlos por CLASE de error -- en vez de por mensaje -- es
 * lo que le permite hacerlo sin parsear texto.
 *
 * `code: 'SIN_MESSAGE_ID'` es el literal exacto de uno de los cinco motivos que ADR-006 enumera
 * (`sin_message_id`, en minuscula, es el que se loguea; este `code` de la clase es el contrato
 * publico de la jerarquia `AppError`, en SCREAMING_SNAKE_CASE por convencion).
 */
export class MissingMessageIdError extends AppError {
  readonly code = 'SIN_MESSAGE_ID';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. Mismo criterio que KeyLoadError, BusConnectError y
  // PublishError: 500 porque es un fallo interno del procesamiento, no el input de un cliente.
  readonly httpStatus = 500;

  constructor() {
    super('El mail no tiene header Message-Id: se descarta.');
  }
}
