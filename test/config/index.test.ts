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

  it('exposes exactly the ten documented fields', async () => {
    loadConfigMock.mockResolvedValue(sdkResult());
    const { loadAppConfig } = await import('#config/index.js');

    await withEnv(VALID_ENV, async () => {
      const config = await loadAppConfig();

      expect(Object.keys(config).sort()).toEqual([
        'credsFile',
        'instance',
        'issuer',
        'keyFile',
        'logLevel',
        // nodeEnv lo agrega S-003: lo consume el logger para elegir formato (JSON vs pino-pretty).
        'nodeEnv',
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
});
