---
date: 2026-08-27
type: technical-change
service: jiku-email-tickets
---

# Cambio Técnico: jiku-email-tickets — import del cliente NATS y mecanismo de imports absolutos

## Requerimiento Original

> jiku-email-tickets convention testing — corregir el import de `connect` en el ejemplo de
> setupTestBus: debe venir de `@gravadigital/jiku/nats`, no de `nats`. Además registrar el
> mecanismo de resolución de imports absolutos en runtime (campo `imports` nativo de Node con
> prefijo `#`), decidido en S-001.

Origen: las dos acciones de seguimiento que el Story Plan de S-001 dejó explícitamente fuera de
su alcance, por tratarse de documentos de producto que merecen su propio changelog.

## Resumen

Dos correcciones de documentación que la implementación de S-001 destapó. La primera arregla un
ejemplo de la convención `testing` que, seguido al pie de la letra, violaba el criterio de
aceptación CA-6 de la propia story que lo consumía. La segunda registra en una convención
custom el mecanismo de resolución de imports absolutos en runtime, que `_base` no documentaba y
que S-001 tuvo que decidir sobre la marcha.

Ninguno de los dos cambia una decisión arquitectónica: alinean los documentos con lo que ya
estaba decidido en los ADRs y verificado en código. No requieren stories correctivas — se
verificó que el código de S-001 ya cumple las ocho reglas de la convención nueva.

## Cambios de Convenciones

| Convención | Cambio |
|---|---|
| Testing (Vitest + NATS de Testcontainers, sin base de datos) | custom editada |
| Imports absolutos de módulos (subpath `#` nativo de Node) | nueva custom |

### Testing — detalle

El ejemplo de `setupTestBus()` importaba el cliente NATS con
`import { connect as natsConnect } from 'nats'`, anotado como "test-only direct use". Seguirlo
obliga a declarar `nats` como dependencia directa, que
[ADR-002](../adrs/ADR-002-sdk-oficial-del-bus.md) prohíbe y que CA-6 de S-001 verifica por
ausencia. El comentario agravaba el error, sugiriendo que en código de test la prohibición no
aplicaba.

Correcciones aplicadas:

- El import pasa a `from '@gravadigital/jiku/nats'`, con el comentario `// NOT from 'nats'`.
- Se agregó el párrafo que explica la razón: el SDK re-exporta el cliente para que haya **una
  sola copia** de la librería en el árbol de dependencias; con dos copias,
  `error instanceof PermissionViolationError` falla contra la copia que lanzó.
- Se agregó una **regla explícita** en la sección Rules, para que la prohibición no viva
  solamente como comentario dentro de un ejemplo.

### Imports absolutos de módulos — detalle

`_base` escribe los imports absolutos como `@/domain/users/...` "usando tsconfig paths", sin
decir cómo resuelven fuera de `tsc`. Pero `tsc` **no reescribe los especificadores al emitir**,
así que `paths` por sí solo produce un `dist/` que muere al arrancar con
`ERR_MODULE_NOT_FOUND`. S-001 tuvo que elegir un mecanismo y eligió el campo `imports` nativo de
Node (sin dependencias), aceptando el costo de que la notación pase de `@/shared/...` a
`#shared/...` — Node exige el prefijo `#`.

La convención nueva registra esa decisión con sus ocho reglas, incluyendo la razón de descartar
`tsc-alias` y la insistencia en verificar **los dos lados** del mapeo (compilación y runtime),
porque el modo de falla que previene es el que pasa el typecheck y falla al arrancar.

**Alcance:** la convención es local a este servicio. `_base`, que vive en el catálogo global
(`.claude/conventions/`), sigue mostrando la notación `@/`. Si el prefijo `#` conviene como
default para todo servicio Node, eso es un cambio al repo del workflow y va por otro canal.

## Documentos Modificados

| Documento | Cambio |
|-----------|--------|
| `docs/architectures/jiku-email-tickets/conventions/testing.md` | Import corregido a `@gravadigital/jiku/nats`, párrafo con la razón, regla nueva en Rules |
| `docs/architectures/jiku-email-tickets/conventions/module-imports.md` | Nuevo — mecanismo de imports absolutos con 8 reglas |
| `docs/architectures/jiku-email-tickets/manifest.yaml` | Agregada `module-imports` a la lista de convenciones |
| `docs/architectures/jiku-email-tickets/index.md` | Regenerado — 8 convenciones activas, 2 custom |

## Nuevos ADRs

Ninguno. [ADR-002](../adrs/ADR-002-sdk-oficial-del-bus.md) ya prohibía `nats` como dependencia
directa; el ejemplo de la convención lo contradecía, y era el ejemplo el que estaba mal.

## Stories Correctivas Creadas

Ninguna. S-001 está implementada y se verificó que su código ya cumple las reglas de la
convención nueva: el import viene del subpath del SDK, los dos lados del mapeo apuntan a árboles
distintos (`paths` → `src/`, `imports` → `dist/`), los especificadores llevan extensión `.js` y
no hay paquetes de reescritura de paths declarados.
