import { existsSync, readFileSync } from 'node:fs';
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

type PackageLock = {
  packages: Record<
    string,
    { dependencies?: Record<string, string>; resolved?: string; integrity?: string } | undefined
  >;
};

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

  // TS-1 (S-032)
  it('declares the bus SDK from the registry, at the first release with the KV space', () => {
    // El Espacio KV (`client.kv()`) se publico en `@gravadigital/jiku@1.1.0`. Hasta entonces el
    // rango apuntaba a un `npm pack` de jiku-ts@edd1064 en `vendor/`; ya no hay tarball local, y
    // `vendor/` no tiene que volver: un `file:` esconde del registry que version se consume.
    expect(manifest.dependencies?.['@gravadigital/jiku']).toBe('^1.1.0');
    expect(existsSync(join(PROJECT_ROOT, 'vendor'))).toBe(false);
  });

  // TS-2 (S-032)
  it('pins the SDK in the lockfile to the npm registry, with its integrity', () => {
    const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package-lock.json'), 'utf8')) as PackageLock;
    const sdk = lock.packages['node_modules/@gravadigital/jiku'];

    expect(lock.packages['']?.dependencies?.['@gravadigital/jiku']).toBe('^1.1.0');
    expect(sdk?.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\/@gravadigital\/jiku\/-\/jiku-1\./);
    expect(sdk?.integrity).toMatch(/^sha512-/);
  });

  // TS-3 (S-032)
  it('resolves an SDK that really brings the KV space, and whose ./nats does NOT re-export Kvm', async () => {
    // El contrapeso de TS-1: aceptar el `file:` sin verificar QUE resolvio dejaria pasar el 1.0.0
    // publicado (misma version, sin `client.kv()`) o el 1.1.0 viejo (con el re-export que esta
    // story elimina). Se afirma sobre lo que hay INSTALADO, que es lo que el codigo va a importar,
    // y no sobre lo que el manifest pide.
    const sdk = await import('@gravadigital/jiku');
    const nats = await import('@gravadigital/jiku/nats');

    expect(typeof sdk.Client.prototype.kv).toBe('function');
    expect(sdk.KV_BUCKET).toBe('JIKU_KV');
    expect(typeof sdk.assertValidKVKey).toBe('function');
    expect(typeof sdk.kvKey).toBe('function');
    expect(typeof sdk.JikuNoBucket).toBe('function');
    expect(typeof sdk.JikuKVPermissionDenied).toBe('function');
    expect(typeof sdk.JikuBucketFull).toBe('function');
    expect('Kvm' in nats).toBe(false);
  });

  // TS-4 (S-032)
  it('drops @nats-io/kv and @nats-io/jetstream from the tree and keeps ONE copy of nats-core', () => {
    // Se lee el lockfile y no `npm ls`: es deterministico y no depende de lo que haya quedado en
    // node_modules. Una sola copia de nats-core es lo que sostiene los `instanceof` contra las
    // clases de error del SDK (S-023, CA-4).
    const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package-lock.json'), 'utf8')) as PackageLock;
    const paths = Object.keys(lock.packages);

    expect(paths.filter((path) => path.endsWith('node_modules/@nats-io/kv'))).toEqual([]);
    expect(paths.filter((path) => path.endsWith('node_modules/@nats-io/jetstream'))).toEqual([]);
    expect(paths.filter((path) => path.endsWith('node_modules/@nats-io/nats-core'))).toHaveLength(1);

    const installed = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'node_modules', '@gravadigital', 'jiku', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(installed.dependencies ?? {}).not.toHaveProperty('@nats-io/kv');
  });

  // TS-5 (S-032)
  it('declares exactly the same production dependencies: none is new', () => {
    // ADR-002: "MUST NOT declarar `nats` como dependencia directa". Migrar al Espacio KV no agrega
    // nada: el KV viaja dentro del SDK.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@gravadigital/jiku',
      '@t3-oss/env-core',
      'dotenv',
      'html-to-text',
      'imapflow',
      'mailparser',
      'node-cron',
      'pino',
      'zod',
    ]);
  });

  it('declares NEITHER @nats-io/kv NOR @nats-io/jetstream as a direct dependency', () => {
    // La Implementation Rule de ADR-002: el KV es el Espacio KV del SDK (`client.kv()`, REQ-008), no
    // un cliente crudo declarado aca. Declararlo directamente traeria una SEGUNDA copia de
    // @nats-io/nats-core al arbol, y entonces `instanceof` contra las clases de error del SDK
    // empieza a dar false contra la copia que lanzo — que es de lo que depende la traduccion de
    // errores de diagnosePublishFailure().
    for (const forbidden of ['@nats-io/kv', '@nats-io/jetstream', '@nats-io/nats-core', 'nats']) {
      expect(
        allDependencies,
        `${forbidden} must come from the SDK, not from this package.json`,
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
