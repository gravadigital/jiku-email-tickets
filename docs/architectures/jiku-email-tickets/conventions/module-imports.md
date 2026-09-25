---
id: module-imports
display_name: Imports absolutos de módulos (subpath `#` nativo de Node)
language: node
description: How absolute intra-project imports are declared and resolved, on both the compilation and the runtime side, using Node's native subpath imports
applies_to: [worker]
required_by: []
package: null
---

# Module Imports (Node, native subpath imports)

How absolute intra-project imports are declared so they resolve **both** when TypeScript
compiles and when Node runs the emitted output. The base Node convention writes these imports
as `@/domain/users/...` "using tsconfig paths" without stating how they resolve outside `tsc`;
this convention fills that gap for this service and picks the mechanism: Node's native
`imports` field, with the `#` prefix Node requires.

## When to use

- Always, in this service. Every intra-project import goes through it.
- Applies to `src/` and `test/` alike: tests import production modules the same way.
- Does not apply to imports of external packages, which use their published specifier.

## Package

**None.** The mechanism is Node's native `imports` field in `package.json`, supported since
Node 12 and stable well below this service's floor of Node 22.12.

Path-rewriting packages (`tsc-alias`, `module-alias`) and custom ESM loaders are deliberately
**not** used: they solve the same problem at the cost of a dependency and an extra build step,
in a service whose dependency discipline is an acceptance criterion.

## Configuration

The mapping is declared **twice**, once per side, pointing at **different trees**.

Runtime side — `package.json`. Node reads this when executing the emitted output, so it points
at `dist/`:

```jsonc
// package.json
{
  "imports": {
    "#config/*": "./dist/config/*",
    "#domain/*": "./dist/domain/*",
    "#infra/*":  "./dist/infra/*",
    "#shared/*": "./dist/shared/*"
  }
}
```

Compilation side — `tsconfig.json`. TypeScript reads this to typecheck the sources, so it
points at `src/`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "#config/*": ["./src/config/*"],
      "#domain/*": ["./src/domain/*"],
      "#infra/*":  ["./src/infra/*"],
      "#shared/*": ["./src/shared/*"]
    }
  }
}
```

The two point at different trees on purpose: one describes sources, the other describes build
output. **If both pointed at the same place, one of them would be wrong.**

## How to use

Import with the prefix and an explicit `.js` extension, even from a `.ts` file — ESM does not
infer it:

```ts
import { SERVICE_NAME } from '#shared/service-info.js';
```

Ordering follows the base convention: external libraries first, then absolute project imports,
then relative imports from the same module, separated by blank lines.

```ts
import { readFile } from 'node:fs/promises';

import { connect } from '@gravadigital/jiku/nats';

import { SERVICE_NAME } from '#shared/service-info.js';

import { normalize } from './normalize.js';
```

Adding a new top-level folder under `src/` means adding its prefix to **both** files in the
same change.

## Why not `@/`

The base Node convention writes absolute imports as `@/domain/users/...`. This service uses
`#shared/...` instead, and the difference is not cosmetic: Node requires subpath imports to
begin with `#`. An `@/` prefix is not a valid subpath import, so making `@/` resolve at runtime
requires something other than the native mechanism — a rewriting package or a loader.

The trade was made explicitly when this service was bootstrapped: keep the native mechanism and
accept a different notation from the base convention's examples, rather than add a dependency to
preserve the notation. This is a **recorded deviation from `_base`**, scoped to this service.

## Verifying both sides

`tsc` does **not** rewrite module specifiers when it emits. A mapping configured only in
`tsconfig.paths` therefore produces output that passes the typecheck and dies at startup. That
failure mode is the reason this convention exists, and it dictates how it is tested:

- **Compilation:** `tsc --noEmit` reports no unresolved-module diagnostics (`TS2307`).
- **Runtime:** the emitted `dist/` is executed as a real process and starts cleanly.

Two checks, not one — and **the runtime one is the one that matters**, because it is the only
one that fails when the `imports` field is missing or misaimed. A missing `imports` field fails
with `ERR_PACKAGE_IMPORT_NOT_DEFINED`; a misaimed one with `ERR_MODULE_NOT_FOUND`. Assert clean
startup rather than the absence of one specific error code, so both regressions are caught.

## Rules

- Intra-project imports MUST use a subpath prefix declared in `package.json#imports`. Never
  relative paths that climb directories (`../../`).
- Every prefix in `package.json#imports` MUST have a counterpart in
  `tsconfig.json#compilerOptions.paths`, and vice versa.
- The two sides MUST point at different trees: `paths` at `./src/*`, `imports` at `./dist/*`. If
  they point at the same place, one of them is wrong.
- The specifier MUST carry an explicit `.js` extension, including from `.ts` files. ESM does not
  infer it.
- A new prefix MUST be added to both files in the same change, never to one alone.
- Runtime resolution MUST be verified by executing the compiled `dist/`, not by `tsc --noEmit`
  alone: a broken mapping passes the typecheck and fails at startup.
- Path-rewriting packages (`tsc-alias`, `module-alias`) and custom ESM loaders MUST NOT be
  added. The native mechanism covers this service's needs.
- The `#` prefix is MANDATORY, imposed by Node: subpath imports that do not begin with `#` are
  invalid. It is not a stylistic choice.

## Integration with other conventions

- **`_base`**: this convention overrides the `@/` notation `_base` shows in its Imports section,
  for this service only. The import *ordering* rules from `_base` still apply unchanged.
- **testing**: test files import production modules through the same prefixes, so the `paths`
  side must cover whatever `test/` imports.
- **dockerfile**: the runtime stage ships `dist/` plus `package.json`. The `imports` field lives
  in `package.json`, so **that file must be present in the final image** or every subpath import
  fails at startup.
