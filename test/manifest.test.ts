import { readFile } from 'node:fs/promises';
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
    expect(manifest.dependencies?.['@gravadigital/jiku']).toBe('^1.0.0');
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
