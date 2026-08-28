import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedConfig } from '@gravadigital/jiku/node';

import { ConfigValidationError } from '#config/errors.js';

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));

vi.mock('@gravadigital/jiku/node', () => ({ loadConfig: loadConfigMock }));

const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
  // Las tres credenciales de la casilla son requeridas desde S-007.
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'tickets@ejemplo.com',
  IMAP_PASSWORD: 'app-password-de-prueba',
};

/** Lo que devuelve loadConfig() en un contenedor sin ~/.config/jiku/config.yaml. */
function sdkResult(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    instance: 'dev',
    credsFile: VALID_ENV.JIKU_CREDS,
    zitadel: {
      keyFile: VALID_ENV.JIKU_KEY_FILE,
      projectId: VALID_ENV.JIKU_PROJECT_ID,
    },
    path: undefined,
    ...overrides,
  };
}

/**
 * Corre loadAppConfig con un entorno controlado. El unico punto del repo donde process.env se
 * escribe es acá y en build-runtime.test.ts: loadEnvFromProcess() lee process.env por diseño
 * (CA-1), asi que probar el compositor obliga a montar el entorno del proceso y restaurarlo.
 */
async function withEnv(
  source: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  // Las diecisiete declaradas. La lista se limpia ANTES de correr para que una IMAP_HOST exportada
  // en la shell del desarrollador no se filtre al test y lo vuelva dependiente del host — el fallo
  // intermitente que la convencion `testing` prohibe. NODE_ENV queda deliberadamente afuera: vitest
  // la setea y borrarla cambiaria el comportamiento del logger bajo test.
  const keys = [
    'JIKU_CREDS',
    'JIKU_KEY_FILE',
    'JIKU_PROJECT_ID',
    'JIKU_VERIFY_PROJECT_ID',
    'JIKU_INSTANCE',
    'JIKU_SERVERS',
    'JIKU_ISSUER',
    'JIKU_TIMEOUT',
    'LOG_LEVEL',
    'IMAP_HOST',
    'IMAP_PORT',
    'IMAP_USER',
    'IMAP_PASSWORD',
    'POLL_CRON',
    'POLL_ENABLED',
    'POLL_MAX_PER_TICK',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadAppConfig', () => {
  it('calls the SDK loadConfig exactly once', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      await loadAppConfig();
    });

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
  });

  it('takes credsFile, keyFile and zitadelProjectId from the SDK result', async () => {
    loadConfigMock.mockResolvedValue(
      sdkResult({
        credsFile: '/home/svc/expanded/sentinel.creds',
        zitadel: { keyFile: '/home/svc/expanded/key.json', projectId: 'sdk-project' },
      }),
    );
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      // El valor del SDK manda porque expande `~`, que el schema no hace.
      expect(config.credsFile).toBe('/home/svc/expanded/sentinel.creds');
      expect(config.keyFile).toBe('/home/svc/expanded/key.json');
      expect(config.zitadelProjectId).toBe('sdk-project');
    });
  });

  it('takes instance from the SDK, which already defaults it', async () => {
    loadConfigMock.mockResolvedValue(sdkResult({ instance: 'prod' }));
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.instance).toBe('prod');
    });
  });

  it('falls back to the schema default for the issuer the SDK never defaults', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.issuer).toBe('https://id.grava.io');
    });
  });

  it('prefers a configured issuer over the schema default', async () => {
    loadConfigMock.mockResolvedValue(sdkResult({ zitadel: { issuer: 'https://id.otra.io' } }));
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ ...VALID_ENV, JIKU_ISSUER: 'https://id.otra.io' }, async () => {
      const config = await loadAppConfig();

      expect(config.issuer).toBe('https://id.otra.io');
    });
  });

  it('keeps the schema value for servers, which the SDK does not default', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.servers).toBe('nats://localhost:4222');
    });
  });

  it('applies the connector timeout floor, which the SDK does not', async () => {
    // El SDK solo reemplaza valores <= 0; un JIKU_TIMEOUT=5000 pasaria tal cual por loadConfig().
    loadConfigMock.mockResolvedValue(sdkResult({ timeoutMs: 5000 }));
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ ...VALID_ENV, JIKU_TIMEOUT: '5000' }, async () => {
      const config = await loadAppConfig();

      expect(config.timeoutMs).toBe(15_000);
    });
  });

  it('exposes the verify project id as a number', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '42' }, async () => {
      const config = await loadAppConfig();

      expect(config.verifyProjectId).toBe(42);
      expect(typeof config.verifyProjectId).toBe('number');
    });
  });

  it('exposes exactly the twelve documented fields', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(Object.keys(config).sort()).toEqual([
        'credsFile',
        // Los dos bloques anidados los agrega S-007: el adaptador IMAP (S-009) y el tick (S-011)
        // reciben cada uno su configuracion ENTERA, no campos sueltos.
        'imap',
        'instance',
        'issuer',
        'keyFile',
        'logLevel',
        // nodeEnv lo agrega S-003: lo consume el logger para elegir formato (JSON vs pino-pretty).
        'nodeEnv',
        'poll',
        'servers',
        'timeoutMs',
        'verifyProjectId',
        'zitadelProjectId',
      ]);
    });
  });

  it('validates the environment before touching the filesystem the SDK reads', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ JIKU_INSTANCE: 'dev' }, async () => {
      await expect(loadAppConfig()).rejects.toBeInstanceOf(ConfigValidationError);
    });

    // CA-2: "no intenta conectar a nada antes de fallar".
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  // TS-31. Los diez campos existentes conservan exactamente los valores que producian antes de
  // S-007: agregar los dos bloques no desplaza nada.
  it('keeps the ten pre-existing fields unchanged', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.servers).toBe('nats://localhost:4222');
      expect(config.instance).toBe('dev');
      expect(config.credsFile).toBe('/run/secrets/sentinel.creds');
      expect(config.keyFile).toBe('/run/secrets/machine-user.json');
      expect(config.zitadelProjectId).toBe('307f1f77bcf86cd799439011');
      expect(config.issuer).toBe('https://id.grava.io');
      expect(config.timeoutMs).toBe(15_000);
      expect(config.verifyProjectId).toBe(42);
      expect(config.logLevel).toBe('info');
      // NODE_ENV queda deliberadamente fuera de la lista que withEnv() limpia (vitest la setea en
      // 'test'), asi que aca se afirma lo que el entorno del runner produce, no el default.
      expect(config.nodeEnv).toBe(process.env.NODE_ENV ?? 'production');
    });
  });
});

describe('loadAppConfig IMAP and poll blocks', () => {
  // TS-29
  it('exposes the whole IMAP block, typed, with the port as a number', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.imap).toEqual({
        host: 'imap.gmail.com',
        port: 993,
        user: 'tickets@ejemplo.com',
        password: 'app-password-de-prueba',
      });
      expect(typeof config.imap.port).toBe('number');
    });
  });

  it('carries a configured IMAP port through as a number', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ ...VALID_ENV, IMAP_PORT: '1143' }, async () => {
      const config = await loadAppConfig();

      expect(config.imap.port).toBe(1143);
    });
  });

  // TS-30
  it('exposes the whole poll block, with enabled as a real boolean', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv({ ...VALID_ENV, POLL_ENABLED: 'false', POLL_MAX_PER_TICK: '10' }, async () => {
      const config = await loadAppConfig();

      expect(config.poll).toEqual({ cron: '*/5 * * * *', enabled: false, maxPerTick: 10 });
      expect(typeof config.poll.enabled).toBe('boolean');
    });
  });

  it('applies the poll defaults when nothing is configured', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(config.poll).toEqual({ cron: '*/5 * * * *', enabled: true, maxPerTick: 50 });
    });
  });

  // CA-8 desde el compositor: el interruptor no cambia que se exige.
  it('still refuses to resolve without the IMAP credentials when the poll is disabled', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(
      {
        JIKU_CREDS: VALID_ENV.JIKU_CREDS,
        JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
        JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
        JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
        POLL_ENABLED: 'false',
      },
      async () => {
        await expect(loadAppConfig()).rejects.toMatchObject({
          variables: ['IMAP_HOST', 'IMAP_PASSWORD', 'IMAP_USER'],
        });
      },
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
