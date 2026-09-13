import { join } from 'node:path';
import { homedir } from 'node:os';
import { input, password } from '@inquirer/prompts';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

const REQUIRED_FIELDS = ['serviceUrl', 'token', 'namespace'];

/**
 * Manages the user configuration
 * @class
 * @property {string} configPath - The path to the configuration file
 * @property {string} configDir - The path to the configuration directory
 * @property {boolean} explicitPath - Whether the path came from --config
 * @property {object|null} userConfig - The cached user configuration
 * @exports ConfigManager
 */
export class ConfigManager {
  /**
   * Creates an instance of ConfigManager
   * @param {string|null} [configPath=null] - An explicit configuration file path
   */
  constructor(configPath = null) {
    this.explicitPath = Boolean(configPath);
    this.configPath = configPath ?? join(homedir(), '.config', 'pulsar-companion', 'config.json');
    this.configDir = join(this.configPath, '..');
    this.userConfig = null;
  }

  /**
   * Normalizes a namespace into a fully-qualified persistent topic prefix
   * @param {string} namespace - The raw namespace (e.g., tenant/namespace)
   * @returns {string} The normalized namespace (e.g., persistent://tenant/namespace/)
   */
  normalizeNamespace(namespace) {
    const withSlash = namespace.endsWith('/') ? namespace : `${namespace}/`;
    return withSlash.startsWith('persistent://') ? withSlash : `persistent://${withSlash}`;
  }

  /**
   * Loads the user configuration from the environment or the config file
   * @returns {Promise<object>} The configuration object
   */
  async loadUserConfig() {
    if (this.userConfig) {
      return this.userConfig;
    }

    let configContent;
    try {
      configContent = await readFile(this.configPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // An explicitly requested file that does not exist is a mistake,
        // not an invitation to start the setup prompts.
        if (this.explicitPath) {
          throw new Error(`Configuration file not found: ${this.configPath}`);
        }
        return await this.createUserConfig();
      }
      throw new Error(`Cannot read ${this.configPath}: ${err.message}`);
    }

    let config;
    try {
      config = JSON.parse(configContent);
    } catch (err) {
      throw new Error(
        `${this.configPath} is not valid JSON: ${err.message}\n` +
        'Fix it, or delete it to be prompted again'
      );
    }

    for (const field of REQUIRED_FIELDS) {
      if (!config[field]) {
        throw new Error(`Missing ${field} in ${this.configPath}`);
      }
    }

    // The file holds an auth token: keep it readable by its owner only,
    // self-healing configs written by earlier versions.
    await chmod(this.configPath, 0o600).catch(() => {});

    return this.cache(config);
  }

  /**
   * Normalizes and caches a configuration
   * @param {object} config - The raw configuration
   * @returns {object} The cached configuration
   */
  cache(config) {
    this.userConfig = { ...config, namespace: this.normalizeNamespace(config.namespace) };
    return this.userConfig;
  }

  /**
   * Prompts the user to create a configuration file
   * @returns {Promise<object>} The newly created configuration object
   */
  async createUserConfig() {
    // Prompting only makes sense on a terminal: in a pipe or a CI job the
    // prompt cannot be answered and would fail with a confusing message.
    if (!process.stdin.isTTY) {
      throw new Error(
        `No configuration found at ${this.configPath} and no terminal to ask on\n` +
        'Create the file, or pass --config <path>'
      );
    }

    console.log('No configuration file found. Please provide your Pulsar connection details:');

    const serviceUrl = await input({
      message: 'Enter Pulsar service URL (e.g., pulsar+ssl://host:port):',
      validate: (value) => {
        if (!value) return 'Service URL cannot be empty';
        if (!value.startsWith('pulsar')) return 'Service URL must start with "pulsar://" or "pulsar+ssl://"';
        return true;
      }
    });

    const token = await password({
      message: 'Enter your authentication token:',
      validate: (value) => value ? true : 'Token cannot be empty'
    });

    const namespace = await input({
      message: 'Enter your namespace (e.g., tenant/namespace):',
      validate: (value) => {
        if (!value) return 'Namespace cannot be empty';
        if (!value.includes('/')) return 'Namespace must be in format: tenant/namespace';
        return true;
      }
    });

    const config = { namespace, serviceUrl, token };

    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log(`Configuration saved to ${this.configPath}`);

    return this.cache(config);
  }
}
