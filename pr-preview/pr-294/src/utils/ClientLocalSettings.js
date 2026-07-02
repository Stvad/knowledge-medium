//#region src/utils/ClientLocalSettings.ts
/**
* A wrapper around localStorage for client-side settings
* Provides type-safe access to localStorage with fallback values
*/
var ClientLocalSettings = class {
	constructor(storage = localStorage) {
		this.storage = storage;
	}
	/**
	* Get a value from localStorage
	* @param key The key to retrieve
	* @param defaultValue The default value to return if the key doesn't exist
	* @returns The stored value or the default value
	*/
	get(key, defaultValue) {
		try {
			const item = this.storage.getItem(key);
			if (item === null) return defaultValue;
			return JSON.parse(item);
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
	getString(key, defaultValue = "") {
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
	set(key, value) {
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
	setString(key, value) {
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
	remove(key) {
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
	has(key) {
		try {
			return this.storage.getItem(key) !== null;
		} catch (error) {
			console.error(`Error checking if ${key} exists in localStorage:`, error);
			return false;
		}
	}
};
var clientLocalSettings = new ClientLocalSettings();
//#endregion
export { ClientLocalSettings, clientLocalSettings };

//# sourceMappingURL=ClientLocalSettings.js.map