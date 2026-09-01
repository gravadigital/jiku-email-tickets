import { describe, expect, it } from 'vitest';

import { fileUploadReplySchema, fileUploadRequestSchema } from '#domain/publicacion/files.schema.js';
import { FileUploadValidationError, parseFileUploadRequest } from '#domain/publicacion/files.types.js';

/**
 * El schema del contrato de `files.request-upload` (Task 1). Unit tests sin contenedor: el schema
 * es una funcion pura sobre un objeto, mismo criterio que `test/publicacion/schema.test.ts`
 * (`requirements.new`, S-005) — los tests de integracion de Task 3/5 (`upload-file.test.ts`) lo
 * ejercitan indirectamente contra el bus real.
 */

const VALID = {
  fileName: 'captura.png',
  mimeType: 'image/png',
  fileSize: 2_000_000,
  checksum: 'abc123...',
};

describe('fileUploadRequestSchema', () => {
  it('accepts a valid payload with exactly the 4 contract fields', () => {
    expect(fileUploadRequestSchema.safeParse(VALID).success).toBe(true);
  });

  it('rejects an uploader key instead of silently dropping it', () => {
    // El punto del `.strict()` (CA-1): un `z.object` normal lo removeria en silencio.
    expect(fileUploadRequestSchema.safeParse({ ...VALID, uploader: 'alguien' }).success).toBe(false);
  });

  it('rejects an actor key too', () => {
    expect(fileUploadRequestSchema.safeParse({ ...VALID, actor: 'alguien' }).success).toBe(false);
  });

  it('rejects an empty fileName', () => {
    expect(fileUploadRequestSchema.safeParse({ ...VALID, fileName: '' }).success).toBe(false);
  });

  it('rejects an empty mimeType', () => {
    expect(fileUploadRequestSchema.safeParse({ ...VALID, mimeType: '' }).success).toBe(false);
  });

  it('rejects a fileSize of 0 or negative or non-integer', () => {
    for (const fileSize of [0, -1, 1.5]) {
      expect(
        fileUploadRequestSchema.safeParse({ ...VALID, fileSize }).success,
        `fileSize ${fileSize} must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects an empty checksum', () => {
    expect(fileUploadRequestSchema.safeParse({ ...VALID, checksum: '' }).success).toBe(false);
  });

  it('produces no valid payload out of an empty object', () => {
    expect(fileUploadRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('parseFileUploadRequest', () => {
  it('returns the parsed payload when it is valid', () => {
    expect(parseFileUploadRequest(VALID)).toEqual(VALID);
  });

  it('throws a domain error naming the invalid field paths', () => {
    try {
      parseFileUploadRequest({ ...VALID, fileSize: 0 });
      expect.unreachable('parseFileUploadRequest must throw on an invalid payload');
    } catch (error) {
      expect(error).toBeInstanceOf(FileUploadValidationError);
      expect((error as FileUploadValidationError).code).toBe('FILE_UPLOAD_VALIDATION_ERROR');
      expect((error as FileUploadValidationError).invalidFields).toContain('fileSize');
    }
  });

  it('never carries the rejected values, only their paths', () => {
    const secret = 'dato-de-cliente-que-no-debe-salir';

    try {
      parseFileUploadRequest({ ...VALID, mimeType: secret, fileSize: -1 });
      expect.unreachable('parseFileUploadRequest must throw on an invalid payload');
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as Error).message,
        details: (error as FileUploadValidationError).details,
      });
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('fileUploadReplySchema', () => {
  it('accepts a success reply carrying a positive fileId and a non-empty uploadUrl', () => {
    expect(
      fileUploadReplySchema.safeParse({ fileId: 99, uploadUrl: 'https://storage.example/put/xyz' })
        .success,
    ).toBe(true);
  });

  it('rejects a success reply with no fileId or uploadUrl at all', () => {
    expect(fileUploadReplySchema.safeParse({}).success).toBe(false);
    expect(fileUploadReplySchema.safeParse({ fileId: 1 }).success).toBe(false);
    expect(fileUploadReplySchema.safeParse({ uploadUrl: 'https://x' }).success).toBe(false);
  });

  it('rejects a fileId that is not a positive integer, without coercing it', () => {
    for (const fileId of ['no-es-numero', 0, -1, 1.5]) {
      expect(
        fileUploadReplySchema.safeParse({ fileId, uploadUrl: 'https://x' }).success,
        `fileId ${String(fileId)} must be rejected`,
      ).toBe(false);
    }
  });

  it('rejects an empty uploadUrl', () => {
    expect(fileUploadReplySchema.safeParse({ fileId: 1, uploadUrl: '' }).success).toBe(false);
  });

  it('accepts an uploadUrl with signature query params, using plain string validation', () => {
    // No z.string().url(): una URL prefirmada de S3 puede tener query params largos que algunos
    // validadores de URL rechazan. Solo se exige no-vacio.
    const signedUrl =
      'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc&X-Amz-Expires=900&X-Amz-SignedHeaders=host';
    expect(fileUploadReplySchema.safeParse({ fileId: 1, uploadUrl: signedUrl }).success).toBe(true);
  });

  it('tolerates extra fields core might start sending', () => {
    // Inversa deliberada del `.strict()` del payload: la respuesta la manda `core`.
    expect(
      fileUploadReplySchema.safeParse({ fileId: 1, uploadUrl: 'https://x', extra: 'algo' }).success,
    ).toBe(true);
  });
});
