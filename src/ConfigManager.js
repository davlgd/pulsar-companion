import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { input, password } from '@inquirer/prompts';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

/** Environment variables holding a complete connection, used as a whole */
const ENV_VARS = {
  serviceUrl: 'PULSAR_SERVICE_URL',
  token: 'PULSAR_TOKEN',
  namespace: 'PULSAR_NAMESPACE'
};

const REQUIRED_FIELDS = ['serviceUrl', 'token', 'namespace'];

/**
 * Describes where a file stops being valid JSON, without quoting any of it.
 * The parser's message is only mined for its offset, never reused: it quotes
 * the surrounding text, which here could be the token itself.
 * @param {string} contents - The file contents
 * @param {Error} err - The error JSON.parse threw
 * @returns {string} A line suffix, or an empty string
 */
function describePosition(contents, err) {
  const position = Number(/position (\d+)/.exec(err.message)?.[1]);
  if (!Number.isInteger(position)) return '';
  return ` (line ${contents.slice(0, position).split('\n').length})`;
}

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
    this.configDir = dirname(this.configPath);
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
   * Reads a connection from the environment.
   * All three variables are required together: mixing them with a file could
   * pair one cluster's URL with another cluster's token.
   * @returns {object|null} The configuration, or null when none is set
   */
  fromEnvironment() {
    const present = Object.entries(ENV_VARS).filter(([, name]) => process.env[name]);
    if (present.length === 0) return null;

    if (present.length !== REQUIRED_FIELDS.length) {
      const missing = Object.entries(ENV_VARS)
        .filter(([, name]) => !process.env[name])
        .map(([, name]) => name);
      throw new Error(
        `Incomplete configuration in the environment: ${missing.join(', ')} not set\n` +
        `Set ${Object.values(ENV_VARS).join(', ')} together, or unset them all to use a configuration file`
      );
    }

    return Object.fromEntries(
      Object.entries(ENV_VARS).map(([field, name]) => [field, process.env[name]])
    );
  }

  /**
   * Loads the user configuration from the environment or the config file
   * @returns {Promise<object>} The configuration object
   */
  async loadUserConfig() {
    if (this.userConfig) {
      return this.userConfig;
    }

    // Precedence is --config, then the environment, then the default file.
    // An explicitly chosen file is never overridden, and its presence also
    // means an incomplete environment is none of our business.
    if (!this.explicitPath) {
      const fromEnv = this.fromEnvironment();
      if (fromEnv) {
        return this.cache(fromEnv, 'the environment');
      }
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
        `${this.configPath} is not valid JSON${describePosition(configContent, err)}\n` +
        `Expected an object with ${REQUIRED_FIELDS.join(', ')}`
      );
    }

    this.validate(config, this.configPath);

    // The file holds an auth token: keep it readable by its owner only,
    // self-healing configs written by earlier versions.
    await chmod(this.configPath, 0o600).catch(() => {});

    return this.cache(config);
  }

  /**
   * Checks a configuration holds the three fields, as non-empty strings
   * @param {unknown} config - The parsed configuration
   * @param {string} source - Where it came from, for the error message
   * @returns {void}
   */
  validate(config, source) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`${source} does not contain a configuration object`);
    }

    for (const field of REQUIRED_FIELDS) {
      const value = config[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${field} is missing or not a string in ${source}`);
      }
    }
  }

  /**
   * Normalizes and caches a configuration
   * @param {object} config - The raw configuration
   * @param {string} [source=this.configPath] - Where it came from
   * @returns {object} The cached configuration
   */
  cache(config, source = this.configPath) {
    this.validate(config, source);
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
        `Set ${Object.values(ENV_VARS).join(', ')}, or pass --config <path>`
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
