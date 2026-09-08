import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const DATABASE_CLIENTS = [
  'pg',
  'sequelize',
  'sequelize-typescript',
  'typeorm',
  'prisma',
  'knex',
] as const;

const STORAGE_CLIENTS = [
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  'aws-sdk',
  'minio',
  '@google-cloud/storage',
  '@azure/storage-blob',
] as const;

type PackageManifest = {
  type?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  imports?: Record<string, string>;
};

describe('package.json', () => {
  let manifest: PackageManifest;
  let allDependencies: Record<string, string>;

  beforeAll(async () => {
    const raw = await readFile(new URL('package.json', `file://${PROJECT_ROOT}`), 'utf8');
    manifest = JSON.parse(raw) as PackageManifest;
    allDependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  });

  it('declares the package as ESM', () => {
    expect(manifest.type).toBe('module');
  });

  it('declares the node engines floor imposed by the SDK', () => {
    expect(manifest.engines?.node).toBe('>=22.12');
  });

  it('pins typescript to a 5.x range', () => {
    expect(manifest.devDependencies?.typescript).toMatch(/^[~^]?5\./);
  });

  it('declares the bus SDK in the exact required range', () => {
    // S-024 necesita el KV que el SDK re-exporta por su subpath ./nats, y eso es el minor 1.1.0
    // de S-023. Mientras ese minor no este publicado en el registry, el rango apunta al tarball
    // local (`npm pack` del repo del SDK) para no bloquear las stories del conector.
    //
    // El `file:` es TEMPORAL y esta anotado en el plan de S-024: cuando 1.1.0 se publique, esto
    // vuelve a un rango del registry ('^1.1.0'). El test acepta las dos formas a proposito —
    // fallar aca durante REQ-005 no protegeria nada y solo esconderia las fallas reales.
    const declared = manifest.dependencies?.['@gravadigital/jiku'];

    expect(declared).toMatch(/^(\^1\.[1-9]\d*\.\d+|file:vendor\/gravadigital-jiku-1\.1\.0\.tgz)$/);
  });

  it('resuelve un SDK que realmente re-exporta el KV', () => {
    // El contrapeso del caso de arriba: aceptar el `file:` sin verificar QUE resolvio dejaria pasar
    // un tarball viejo, y el sintoma seria un `Kvm` undefined en el arranque. Se afirma sobre lo
    // que hay INSTALADO, que es lo que el codigo va a importar, y no sobre lo que el manifest pide.
    const installed = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'node_modules', '@gravadigital', 'jiku', 'package.json'), 'utf8'),
    ) as { version: string; dependencies?: Record<string, string> };

    const [major, minor] = installed.version.split('.').map(Number);
    expect(major).toBe(1);
    // 1.1.0 es el minor de S-023: el primero que re-exporta @nats-io/kv por el subpath ./nats.
    expect(minor).toBeGreaterThanOrEqual(1);

    // Y el KV viaja pinneado EXACTO en el SDK, que es lo que mantiene una sola copia de nats-core
    // en este arbol (S-023 / ADR-002). Un rango aca reintroduciria la doble copia.
    expect(installed.dependencies?.['@nats-io/kv']).toBe('3.4.0');
  });

  it('declares NEITHER @nats-io/kv NOR @nats-io/jetstream as a direct dependency', () => {
    // La Implementation Rule de ADR-002 que S-023 existe para no tener que reescribir: el KV entra
    // por el subpath del SDK, no por aca. Declararlo directamente traeria una SEGUNDA copia de
    // @nats-io/nats-core al arbol, y entonces `instanceof` contra las clases de error del SDK
    // empieza a dar false contra la copia que lanzo — que es de lo que depende la traduccion de
    // errores de diagnosePublishFailure().
    for (const forbidden of ['@nats-io/kv', '@nats-io/jetstream', '@nats-io/nats-core', 'nats']) {
      expect(
        allDependencies,
        `${forbidden} must come from the SDK subpath, not from this package.json`,
      ).not.toHaveProperty(forbidden);
    }
  });

  it('declares no database client, direct or dev', () => {
    for (const client of DATABASE_CLIENTS) {
      expect(allDependencies, `${client} must not be a dependency`).not.toHaveProperty(client);
    }
  });

  it('declares no storage client, direct or dev', () => {
    for (const client of STORAGE_CLIENTS) {
      expect(allDependencies, `${client} must not be a dependency`).not.toHaveProperty(client);
    }
  });

  it('does not declare nats as a direct dependency', () => {
    expect(allDependencies).not.toHaveProperty('nats');
  });

  // TS-38 (S-007). node-cron entra como dependencia de PRODUCCION y no de desarrollo porque
  // cron.validate() se necesita EN EL ARRANQUE, dentro del schema de configuracion: un POLL_CRON
  // mal formado tiene que impedir el arranque, no explotar despues en cron.schedule().
  it('declares node-cron as a production dependency and brings its own types', () => {
    expect(manifest.dependencies?.['node-cron']).toMatch(/^\^4\./);
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('node-cron');
    expect(allDependencies).not.toHaveProperty('@types/node-cron');
  });

  // TS-48 (S-008). Las dos librerias de normalizacion son de PRODUCCION (viajan en la imagen); sus
  // tipos van aparte como devDependency porque NINGUNO DE LOS DOS PAQUETES TRAE `.d.ts` PROPIOS
  // (verificado desempaquetando los tarballs de mailparser@3.9.17 y html-to-text@10.0.1). No es una
  // eleccion de estilo: sin el `@types/*` correspondiente el proyecto no tipa. Y ninguna quinta
  // dependencia entra con ellas — en particular, ninguna libreria de recorte de texto citado
  // (Riesgo 3 del REQ-002: esa heuristica se porta del servicio existente, no se reinventa).
  it('declares mailparser and html-to-text as production deps with separate type packages', () => {
    expect(manifest.dependencies?.mailparser).toMatch(/^\^3\./);
    expect(manifest.dependencies?.['html-to-text']).toMatch(/^\^10\./);
    expect(manifest.devDependencies?.['@types/mailparser']).toBeDefined();
    expect(manifest.devDependencies?.['@types/html-to-text']).toBeDefined();
  });

  it('declares the build, test and start scripts', () => {
    expect(manifest.scripts).toHaveProperty('build');
    expect(manifest.scripts).toHaveProperty('test');
    expect(manifest.scripts).toHaveProperty('start');
  });

  it('keeps the verification mode in a script that start never invokes', () => {
    expect(manifest.scripts).toHaveProperty('verify');
    expect(manifest.scripts?.start).not.toMatch(/verify/);
  });

  it('maps the four subpath import prefixes to the build output', () => {
    expect(manifest.imports).toEqual({
      '#config/*': './dist/config/*',
      '#domain/*': './dist/domain/*',
      '#infra/*': './dist/infra/*',
      '#shared/*': './dist/shared/*',
    });
  });
});
