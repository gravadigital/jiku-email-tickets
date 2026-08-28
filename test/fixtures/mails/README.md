# Fixtures de mail (`.eml`)

Bytes RFC 822 reales, con headers CRLF, usados por los tests de `src/domain/ingesta/` (S-008).
Ningún fixture contiene datos reales de clientes ni credenciales reales — los adjuntos son
contenido sintético (un PDF y un PNG mínimo válido, generados para este propósito).

## Los diez que enumera la convención `testing`

- `plain-text.eml` — mail simple, sólo `text/plain`, con `From` en formato `Nombre <mail>`.
- `html-only.eml` — sólo `text/html`, con un `<img src="logo.png">` y un
  `<a href="http://x">acá</a>`: ejercita `html-to-text` (CA-11) y el hallazgo del `text`
  sintetizado de `mailparser`.
- `quoted-reply.eml` — respuesta con el separador español `escribió:` seguido de líneas citadas
  (`>`), para el recorte de CA-14.
- `re-re-fwd-subject.eml` — asunto con tres prefijos apilados (`Re: Re: Fwd:`), para CA-2.
- `no-message-id.eml` — sin header `Message-Id`: el único descarte de la story (CA-1).
- `no-body.eml` — sólo un adjunto PDF, sin ninguna parte de texto ni HTML (CA-13).
- `with-attachments.eml` — texto plano más un adjunto PDF (CA-15).
- `duplicate-attachments.eml` — dos adjuntos idénticos (mismo `filename`, mismo contenido). Su
  semántica de colapso por checksum es de FG-4; acá sólo se usa para confirmar que los dos salen
  **sin** colapsar.
- `inline-image.eml` — un PDF `attachment` y un PNG `inline` con `Content-ID`, para probar que en
  v1 el adjunto inline se trata como uno normal (CA-15).
- `in-reply-to.eml` — trae `In-Reply-To` y `References`, para `referenceIds` (CA-5).

## Los casos de borde que agrega esta story

- `delivered-to-multiple.eml` — **dos** headers `Delivered-To`: `pickRecipient` tiene que devolver
  sólo el primero (CA-8), no unirlos con `', '` como el servicio existente.
- `to-fallback.eml` — sin `Delivered-To`, con `To` como único candidato (CA-7).
- `no-recipient.eml` — sin `Delivered-To` ni `To`: `recipient` vacío es válido (CA-9).
- `both-text-and-html.eml` — `multipart/alternative` con parte `text/plain` **y** `text/html`: gana
  el texto plano (CA-12).
- `single-reference.eml` — un solo `References` sin `In-Reply-To`, para probar que
  `mailparser` devuelve `string` (no array) con un solo valor (TS-11).
- `no-subject.eml` — sin header `Subject`: `subject` tiene que quedar `''`, no `undefined` (CA-4).
- `subject-only-prefixes.eml` — el asunto es exactamente `Re: Fwd:`: queda vacío y es válido
  (CA-4).
- `declared-mime-mismatch.eml` — un adjunto declarado `application/pdf` cuyo contenido real es
  texto plano: `mimeType` se conserva el declarado, sin verificar (CA-17).
- `oversized-and-exe.eml` — un adjunto de ~300 KB y otro `.exe`. **No pesa 50 MB a propósito**: lo
  que CA-16 exige es que no se valide nada, no que se procese un archivo gigante. No "arreglar"
  esto subiendo un binario enorme al repo.
- `attachment-without-filename.eml` — un adjunto sin `filename` en su `Content-Disposition`: tiene
  que caer al fallback `'unnamed'` (CA-15/TS-41).
- `sensitive-body.eml` — el cuerpo dice `mi tarjeta es 4111 1111 1111 1111`: es el valor
  distintivo que los tests de redacción (CA-18) buscan para confirmar que nunca llega al log.
- `html-only-quoted-reply.eml` — sólo HTML, y el HTML convertido contiene el separador español
  `escribió:` en su propia línea. Prueba que el recorte del citado (CA-14) se aplica **después**
  de convertir el HTML, en el mismo punto para las dos ramas (TS-36).
