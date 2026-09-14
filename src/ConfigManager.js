import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { input, password } from '@inquirer/prompts';
import { open, mkdir } from 'node:fs/promises';

/** Environment variables holding a complete connection, used as a whole */
const ENV_VARS = {
  serviceUrl: 'PULSAR_SERVICE_URL',
  token: 'PULSAR_TOKEN',
  namespace: 'PULSAR_NAMESPACE'
};

const REQUIRED_FIELDS = ['serviceUrl', 'token', 'namespace'];

/**
 * Tightens a freshly opened configuration file to owner-only. The file holds
 * an auth token, and this runs before its contents are parsed, because a file
 * the parser or the validation rejects is exactly the one a user edits and
 * retries: it must not keep loose permissions meanwhile. Regular files only,
 * so a device or a FIFO handed to --config is left as it is; a symlink to a
 * regular file hardens that target, which is the file being read. Best
 * effort: a chmod that fails does not stop the load.
 * @param {FileHandle} handle - The handle the contents are read from
 * @returns {Promise<boolean>} Whether tightening was attempted
 */
export async function hardenIfRegularFile(handle) {
  const stats = await handle.stat();
  if (!stats.isFile()) return false;

  await handle.chmod(0o600).catch(() => {});
  return true;
}

/**
 * Describes where a file stops being valid JSON, without quoting any of it.
 * The parser's message is only mined for its offset, never reused: it quotes
 * the surrounding text, which here could be the token itself. Some inputs —
 * an empty file, a bare token — carry no offset at all, and that is reported
 * rather than silently dropped.
 * @param {string} contents - The file contents
 * @param {Error} err - The error JSON.parse threw
 * @returns {string} A parenthesised location, always non-empty
 */
function describeLocation(contents, err) {
  if (contents.trim() === '') return ' (the file is empty)';

  // Anchored on the engine's own suffix: the rest of the message quotes the
  // file, so a document containing "position 123" would otherwise have its
  // own text read as an offset and reported as a line.
  const position = Number(/in JSON at position (\d+)/.exec(err.message)?.[1]);
  if (!Number.isInteger(position)) return ' (the parser reported no location)';

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
    // Presence, not truthiness: a variable set to an empty string has been
    // set, so it must be rejected as invalid rather than silently ignored,
    // which would fall back to a file naming a different cluster.
    const present = Object.entries(ENV_VARS).filter(([, name]) => process.env[name] !== undefined);
    if (present.length === 0) return null;

    if (present.length !== REQUIRED_FIELDS.length) {
      const missing = Object.entries(ENV_VARS)
        .filter(([, name]) => process.env[name] === undefined)
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
    let handle;
    try {
      // One descriptor for the metadata, the tightening and the read, so all
      // three act on the same file rather than re-resolving the path.
      handle = await open(this.configPath, 'r');
      await hardenIfRegularFile(handle);
      configContent = await handle.readFile('utf8');
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
    } finally {
      await handle?.close().catch(() => {});
    }


    let config;
    try {
      config = JSON.parse(configContent);
    } catch (err) {
      throw new Error(
        `${this.configPath} is not valid JSON${describeLocation(configContent, err)}\n` +
        `Expected an object with ${REQUIRED_FIELDS.join(', ')}`
      );
    }

    this.validate(config, this.configPath);

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
      validate: (value) => value.trim() ? true : 'Token cannot be empty'
    });

    const namespace = await input({
      message: 'Enter your namespace (e.g., tenant/namespace):',
      validate: (value) => {
        if (!value) return 'Namespace cannot be empty';
        if (!value.includes('/')) return 'Namespace must be in format: tenant/namespace';
        return true;
      }
    });

    return this.persistConfig({ namespace, serviceUrl, token });
  }

  /**
   * Validates a set of answers and writes them, owner-only. Kept apart from
   * the prompts so the order — refuse before writing — is exercised directly.
   * @param {object} config - The answers to persist
   * @returns {Promise<object>} The cached configuration
   */
  async persistConfig(config) {
    // Check before writing: a file the loader would refuse must never reach
    // the disk, or every later run fails on a config we wrote ourselves.
    this.validate(config, 'the answers given');

    await mkdir(this.configDir, { recursive: true, mode: 0o700 });

    // Exclusive create, for two reasons. The mode given to a write only
    // applies when it creates the file, so a path that appeared between the
    // missing-file check and here would keep its own permissions while
    // receiving the token. And opening such a path for writing would empty it
    // at open(), before any chmod could run, destroying a configuration
    // someone else had just written. Refusing is the only safe answer: this
    // path runs only when no file was found.
    let handle;
    try {
      handle = await open(this.configPath, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new Error(
          `${this.configPath} appeared while the questions were being answered, and was left untouched\n` +
          'Run again to load that file, or use --config <path> to load another existing configuration'
        );
      }
      throw err;
    }

    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(config, null, 2));
    } finally {
      await handle.close();
    }
    console.log(`Configuration saved to ${this.configPath}`);

    return this.cache(config);
  }
}
