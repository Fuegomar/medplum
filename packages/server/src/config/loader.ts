import { splitN } from '@medplum/core';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadAwsConfig } from '../cloud/aws/config';
import { loadAzureConfig } from '../cloud/azure/config';
import { loadGcpConfig } from '../cloud/gcp/config';
import { MedplumServerConfig } from './types';
import {
  addDefaults,
  isBooleanConfig,
  isFloatConfig,
  isIntegerConfig,
  isObjectConfig,
  ServerConfig,
} from './utils';

let cachedConfig: ServerConfig | undefined;

/**
 * Returns the loaded and merged server configuration.
 */
export function getConfig(): ServerConfig {
  if (!cachedConfig) {
    throw new Error('Config not loaded');
  }
  return cachedConfig;
}

/**
 * Loads configuration settings based on the configName identifier.
 * Supports file:, env:, aws:, gcp:, azure: prefixes.
 */
export async function loadConfig(
  configName: string
): Promise<MedplumServerConfig> {
  const [configType, configPath] = splitN(configName, ':', 2);
  let config: MedplumServerConfig;

  switch (configType) {
    case 'env':
      config = loadEnvConfig();
      break;
    case 'file':
      config = await loadFileConfig(configPath);
      break;
    case 'aws':
      config = await loadAwsConfig(configPath);
      break;
    case 'gcp':
      config = await loadGcpConfig(configPath);
      break;
    case 'azure':
      config = await loadAzureConfig(configPath);
      break;
    default:
      throw new Error('Unrecognized config type: ' + configType);
  }

  // Validate required baseUrl
  if (!config.baseUrl || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw new Error(
      'Missing required config setting: baseUrl. Please set "baseUrl" in your configuration.'
    );
  }

  // Merge defaults
  cachedConfig = addDefaults(config);
  return cachedConfig;
}

/**
 * Loads configuration settings for tests.
 */
export async function loadTestConfig(): Promise<MedplumServerConfig> {
  const config = await loadConfig('file:medplum.config.json');

  // Configure binary storage as temp dir
  config.binaryStorage = 'file:' + mkdtempSync(join(tmpdir(), 'medplum-temp-storage'));
  config.allowedOrigins = undefined;

  // Override database for tests
  config.database.host = process.env['POSTGRES_HOST'] ?? 'localhost';
  config.database.port = process.env['POSTGRES_PORT']
    ? parseInt(process.env['POSTGRES_PORT'], 10)
    : 5432;
  config.database.dbname = 'medplum_test';
  config.database.runMigrations = false;
  config.database.disableRunPostDeployMigrations = true;

  // Readonly DB config
  config.readonlyDatabase = {
    ...config.database,
    username: 'medplum_test_readonly',
    password: 'medplum_test_readonly',
  };

  // Redis test DB
  config.redis.db = 7;
  config.redis.password =
    process.env['REDIS_PASSWORD_DISABLED_IN_TESTS'] === 'true'
      ? undefined
      : config.redis.password;

  config.approvedSenderEmails = 'no-reply@example.com';
  config.emailProvider = 'none';
  config.logLevel = 'error';
  config.defaultRateLimit = -1;

  return config;
}

/**
 * Loads overrides from environment variables prefixed with MEDPLUM_.
 */
function loadEnvConfig(): MedplumServerConfig {
  const config: Record<string, any> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('MEDPLUM_')) continue;

    let key = name.substring('MEDPLUM_'.length);
    let currConfig: any = config;

    if (key.startsWith('DATABASE_')) {
      key = key.substring('DATABASE_'.length);
      currConfig = config.database = config.database ?? {};
    } else if (key.startsWith('REDIS_')) {
      key = key.substring('REDIS_'.length);
      currConfig = config.redis = config.redis ?? {};
    } else if (key.startsWith('SMTP_')) {
      key = key.substring('SMTP_'.length);
      currConfig = config.smtp = config.smtp ?? {};
    } else if (key.startsWith('FISSION_')) {
      key = key.substring('FISSION_'.length);
      currConfig = config.fission = config.fission ?? {};
    } else {
      // Unknown MEDPLUM_ prefix skips
      continue;
    }

    // Convert to camelCase
    key = key.toLowerCase().replace(/_([a-z])/g, (_, g1) => g1.toUpperCase());

    // Parse types
    if (isIntegerConfig(key)) {
      currConfig[key] = parseInt(value ?? '', 10);
    } else if (isFloatConfig(key)) {
      currConfig[key] = parseFloat(value ?? '');
    } else if (isBooleanConfig(key)) {
      currConfig[key] = value === 'true';
    } else if (isObjectConfig(key)) {
      currConfig[key] = JSON.parse(value ?? '');
    } else {
      currConfig[key] = value;
    }
  }

  return config as MedplumServerConfig;
}

/**
 * Loads JSON config from file and applies MailHog workaround.
 */
async function loadFileConfig(
  pathStr: string
): Promise<MedplumServerConfig> {
  const filePath = resolve(__dirname, '../../', pathStr);
  let raw: string;
  try {
    raw = readFileSync(filePath, { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`Cannot read config file at ${filePath}: ${err}`);
  }

  let config: MedplumServerConfig;
  try {
    config = JSON.parse(raw) as MedplumServerConfig;
  } catch (err) {
    throw new Error(`Error parsing JSON in ${filePath}: ${err}`);
  }

  // Workaround: strip auth when using MailHog on localhost
  if (config.smtp && config.smtp.host === 'localhost') {
    delete (config.smtp as any).auth;
  }

  return config;
}
