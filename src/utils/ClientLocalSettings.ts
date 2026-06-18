/**
 * A wrapper around localStorage for client-side settings
 * Provides type-safe access to localStorage with fallback values
 */
export class ClientLocalSettings {
  // Resolve `localStorage` lazily (on first method call), not at
  // construction — so the module-level `clientLocalSettings` singleton can
  // be imported in a non-browser context (Node-env data tests; the
  // `pluginDataExtensions` glob pulls settings-plugin data modules, which
  // transitively reach this, into that path) without throwing at
  // module-eval. Real reads/writes still require a browser/jsdom env.
  constructor(private readonly storageOverride?: Storage) {}
  private get storage(): Storage {
    return this.storageOverride ?? localStorage
  }
  /**
   * Get a value from localStorage
   * @param key The key to retrieve
   * @param defaultValue The default value to return if the key doesn't exist
   * @returns The stored value or the default value
   */
  get<T>(key: string, defaultValue: T): T {
    try {
      const item = this.storage.getItem(key);
      if (item === null) return defaultValue;
      return JSON.parse(item) as T;
    } catch (error) {
      console.error(`Error retrieving ${key} from localStorage:`, error);
      return defaultValue;
    }
  }

  /**
   * Get a string value from localStorage
   * @param key The key to retrieve
   * @param defaultValue The default value to return if the key doesn't exist
   * @returns The stored string or the default value
   */
  getString(key: string, defaultValue: string = ''): string {
    try {
      const item = this.storage.getItem(key);
      return item === null ? defaultValue : item;
    } catch (error) {
      console.error(`Error retrieving ${key} from localStorage:`, error);
      return defaultValue;
    }
  }

  /**
   * Set a value in localStorage
   * @param key The key to set
   * @param value The value to store
   */
  set<T>(key: string, value: T): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error setting ${key} in localStorage:`, error);
    }
  }

  /**
   * Set a string value in localStorage
   * @param key The key to set
   * @param value The string value to store
   */
  setString(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch (error) {
      console.error(`Error setting ${key} in localStorage:`, error);
    }
  }

  /**
   * Remove a value from localStorage
   * @param key The key to remove
   */
  remove(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch (error) {
      console.error(`Error removing ${key} from localStorage:`, error);
    }
  }

  /**
   * Check if a key exists in localStorage
   * @param key The key to check
   * @returns True if the key exists, false otherwise
   */
  has(key: string): boolean {
    try {
      return this.storage.getItem(key) !== null;
    } catch (error) {
      console.error(`Error checking if ${key} exists in localStorage:`, error);
      return false;
    }
  }
}

export const clientLocalSettings = new ClientLocalSettings();
