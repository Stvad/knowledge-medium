(function() {
	// src/sw/assets.ts
	/**
	* Which same-origin runtime assets the service worker serves cache-first from
	* the generation cache. Kept globals-free (primitives in, boolean out — no
	* `Request`/`URL`/worker types) so it imports cleanly into BOTH the WebWorker
	* tsconfig (the worker, src/sw/sw.ts) and the Node scripts tsconfig
	* (scripts/precache-assets.ts), and unit-tests without mocking `Request`.
	*
	* `ASSET_EXTENSION` is the load-bearing shared constant. The build precaches by
	* extension; the SW ALSO serves cache-first by `request.destination` (below), so
	* strictly the served set is a superset of the precached set. That superset is
	* empty in practice — every emitted dist asset carries a recognized extension,
	* so a destination-matched request always also matches by extension and was
	* precached. Importing the ONE extension definition here (instead of duplicating
	* the literal in the build script and diffing it in a test) keeps the two in
	* lockstep on the axis the precache is actually built from; the invariant that
	* closes the gap is "every served asset has a recognized extension", which holds
	* for our own emitted output.
	*/
	var ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/;
	var ASSET_DESTINATIONS = /* @__PURE__ */ new Set([
		"script",
		"style",
		"worker",
		"font",
		"image"
	]);
	/**
	* True for a same-origin request the SW serves cache-first within the
	* generation. Match by `request.destination` first (covers the common cases a
	* browser labels) with an extension fallback for anything left as an empty
	* destination.
	*/
	var isCacheableAsset = (destination, pathname, sameOrigin) => sameOrigin && (ASSET_DESTINATIONS.has(destination) || ASSET_EXTENSION.test(pathname));
	/**
	* The fingerprint the build stamps for each precached file and the worker
	* recomputes over the bytes it fetched: hex SHA-256 cut to 64 bits, enough to
	* tell two builds' bytes apart. The one definition both sides use.
	*/
	var contentDigest = async (bytes) => {
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	};
	// src/data/dbFileSiblings.ts
	/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
	var WRITE_AHEAD_SIDECAR_SUFFIXES = ["-wa0", "-wa1"];
	/**
	* SQLite's own crash-recovery files. These must be removed BEFORE the main
	* `.db`: left beside a fresh database of the same name, SQLite replays them.
	*
	* Wider than what this app produces, deliberately: deletion should clear
	* anything SQLite could replay, whoever wrote it. Restoring is the opposite and
	* uses a narrower whitelist — see `exportSqliteDb`.
	*/
	var SQLITE_JOURNAL_SUFFIXES = [
		"-journal",
		"-wal",
		"-shm"
	];
	[...SQLITE_JOURNAL_SUFFIXES, ...WRITE_AHEAD_SIDECAR_SUFFIXES];
	// src/sw/preview.ts
	/**
	* PR-preview subtree gating. github.io is ONE origin for production
	* (…/knowledge-medium/) AND every PR preview (…/pr-preview/pr-<n>/…). A
	* production/root SW's scope is a PREFIX of every preview path, and since we
	* never `clients.claim()`, the production SW controls a freshly-opened preview
	* page until it reloads — and would otherwise cache the preview's shell +
	* assets under production's OWN keys, poisoning the offline production shell
	* with an unmerged build. So a SW refuses to serve/cache a preview subtree it
	* doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt.
	*
	* Globals-free (a regex + a pure predicate over primitives) so it's unit-tested
	* directly and shared without dragging worker types.
	*/
	var PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//;
	/**
	* True when this SW must NOT touch a request: the request targets a preview
	* subtree that this scope does not own. A preview-scoped SW (its own scope is
	* under /pr-preview/) owns its subtree, so it's never "foreign" to itself.
	*/
	var isForeignPreviewRequest = (ownScopeIsPreview, pathname) => !ownScopeIsPreview && PREVIEW_SUBTREE.test(pathname);
	// src/sw/ledger.ts
	/**
	* Pure decisions over the generation ledger — an install-ordered list of
	* BUILD_IDs (newest last). The worker (src/sw/worker.ts) owns the impure I/O
	* (reading/writing the ledger Response in the meta cache); the retention math
	* lives here so it unit-tests without a cache.
	*
	* Each deploy is an immutable generation with its own km-shell-<id> /
	* km-assets-<id> caches. On activate we keep the most recent `keep`
	* generations (so a tab still on a prior build has a consistent cache to read
	* from) and GC the rest.
	*/
	/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
	var computeKeepIds = (ledger, keep) => ledger.slice(Math.max(0, ledger.length - keep));
	/**
	* The ids that have aged out of the keep-window and whose caches should be
	* GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
	*/
	var computeExpiredIds = (ledger, keep) => ledger.slice(0, Math.max(0, ledger.length - keep));
	/**
	* Normalize a stored ledger value into {ids, updatedAt}. Tolerates the two
	* on-disk shapes: the current {ids, updatedAt} object and the LEGACY bare array
	* (written before timestamps existed) — the latter has no timestamp, which the
	* sweeper reads as "staleness unprovable → never reap". Anything else (null,
	* garbage, non-array ids) degrades to an empty ledger.
	*/
	var normalizeLedger = (raw) => {
		if (Array.isArray(raw)) return {
			ids: raw,
			updatedAt: void 0
		};
		if (raw && typeof raw === "object" && Array.isArray(raw.ids)) {
			const { ids, updatedAt } = raw;
			return {
				ids,
				updatedAt: typeof updatedAt === "number" ? updatedAt : void 0
			};
		}
		return {
			ids: [],
			updatedAt: void 0
		};
	};
	/**
	* Decide which OTHER-scope generation caches a sweep should reclaim. Cache
	* Storage is shared per-origin, so a client accumulates the caches of every PR
	* preview it ever visited; once a PR is merged/closed its preview SW never runs
	* again to GC them, so they leak forever. This sweep (run from any active SW's
	* activate) reclaims them — but ONLY:
	*   - preview scopes (PREVIEW_SUBTREE matches the ledger key's path). Production
	*     is NEVER a preview scope, so it can never be reaped here — the sweep is
	*     structurally incapable of touching prod caches.
	*   - that are STALE: a numeric updatedAt older than staleMs. A legacy
	*     untimestamped ledger (updatedAt undefined) is never reaped — we can't
	*     prove it's abandoned. The current scope's own ledger was just re-stamped
	*     on install, so it's fresh and self-excluded.
	* A generation id still referenced by any KEPT (non-reaped) ledger is spared —
	* two deploys can in principle share a build sha, and we must not delete a cache
	* a live scope depends on. The stale ledger ENTRY is removed regardless (the
	* scope is gone), even when its cache was shared-protected.
	*/
	var computeReapableCaches = ({ ledgers, now, staleMs, selfScopeUrl }) => {
		const isPreviewScope = (scopeUrl) => {
			try {
				return PREVIEW_SUBTREE.test(new URL(scopeUrl).pathname);
			} catch {
				return false;
			}
		};
		const isStale = (l) => typeof l.updatedAt === "number" && now - l.updatedAt > staleMs;
		const reapable = ledgers.filter((l) => l.scopeUrl !== selfScopeUrl && isPreviewScope(l.scopeUrl) && isStale(l));
		const reapableSet = new Set(reapable);
		const keptIds = new Set(ledgers.filter((l) => !reapableSet.has(l)).flatMap((l) => l.ids));
		const reapIds = /* @__PURE__ */ new Set();
		for (const l of reapable) for (const id of l.ids) if (!keptIds.has(id)) reapIds.add(id);
		return {
			reapIds: [...reapIds],
			ledgerScopeUrls: reapable.map((l) => l.scopeUrl)
		};
	};
	// src/utils/idbKeyedStore.ts
	/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
	var promisifyRequest = (request) => new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
	*  A readwrite write is only durable once the tx commits — `onsuccess` fires
	*  earlier, while the tx is still open — so a caller that navigates/reloads
	*  right after a write can have an un-committed tx rolled back. Handlers are
	*  registered synchronously by the caller (before any await) so an `oncomplete`
	*  that fires before we start awaiting can't be missed. */
	var txCommitted = (transaction) => new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction aborted"));
		transaction.onerror = () => reject(transaction.error ?? /* @__PURE__ */ new Error("IndexedDB transaction error"));
	});
	/** Record-id prefix for all of an owner's records. The trailing `:` plus
	*  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
	*  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
	*  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
	var idbKeyPrefix = (owner) => `${encodeURIComponent(owner)}:`;
	/** Composite record id. Each segment is encoded so a delimiter inside an id
	*  can't make two distinct `(owner, id)` pairs collide. */
	var idbRecordId = (owner, id) => `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`;
	/**
	* A cached connection to one named DB + one object store, with commit-durable
	* transactions. Each instance owns its own connection handle, so constructing a
	* fresh instance against the same DB models a page reload (a new tab/handle
	* reopening persisted data) — which is exactly how the consumers' tests verify
	* durability.
	*/
	var IdbKeyedStore = class {
		dbName;
		storeName;
		version;
		dbPromise = null;
		constructor(dbName, storeName, version = 1) {
			this.dbName = dbName;
			this.storeName = storeName;
			this.version = version;
		}
		openDb() {
			if (!this.dbPromise) {
				const opened = new Promise((resolve, reject) => {
					const request = indexedDB.open(this.dbName, this.version);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
					};
					request.onsuccess = () => {
						const db = request.result;
						db.onclose = () => {
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						db.onversionchange = () => {
							db.close();
							if (this.dbPromise === opened) this.dbPromise = null;
						};
						resolve(db);
					};
					request.onerror = () => reject(request.error);
				}).catch((err) => {
					if (this.dbPromise === opened) this.dbPromise = null;
					throw err;
				});
				this.dbPromise = opened;
			}
			return this.dbPromise;
		}
		/**
		* Open a transaction and return its object store plus a commit fence. PRIVATE
		* and footgun-laden by design — the caller must issue its first request
		* synchronously and observe `committed` on EVERY path (await it, or `.catch` it
		* on an error path) or a tx abort surfaces as an unhandled rejection. The public
		* ops ({@link runTransaction}, {@link tx}, {@link scanByPrefix}) wrap exactly
		* that contract so callers never have to.
		*/
		async openTransaction(mode) {
			const transaction = (await this.openDb()).transaction(this.storeName, mode);
			const committed = txCommitted(transaction);
			return {
				store: transaction.objectStore(this.storeName),
				committed
			};
		}
		/**
		* Run `body` against the store within one transaction and resolve on the
		* transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
		* issue its first request synchronously — it is invoked in the same task that
		* created the tx (see the file header on activeness). If `body` rejects (or the
		* commit fence does), the fence's rejection is observed here so it can't surface
		* as an unhandled rejection, and the original error propagates. Use for cursor
		* scans / read-modify-write; single-request ops use {@link tx}.
		*/
		async runTransaction(mode, body) {
			const { store, committed } = await this.openTransaction(mode);
			try {
				const result = await body(store);
				await committed;
				return result;
			} catch (err) {
				committed.catch(() => {});
				throw err;
			}
		}
		/**
		* Run a single request against the store, resolving on the transaction COMMIT
		* (durability). The common case; multi-request / cursor work uses
		* {@link runTransaction}.
		*/
		async tx(mode, run) {
			return this.runTransaction(mode, (store) => promisifyRequest(run(store)));
		}
		/**
		* Walk every record whose key starts with `prefix` (the per-owner namespace
		* from {@link idbKeyPrefix}), calling `visit` with each matching cursor, in one
		* commit-durable transaction. A value cursor, because `visit` reads
		* `cursor.value`; the `:`-delimited prefix is collision-free across owners, so
		* a scan never reaches a sibling owner. `visit` is synchronous
		* (it runs in the cursor's `onsuccess`, while the tx is active) and may read
		* `cursor.value` or, in a `'readwrite'` scan, `cursor.delete()`; accumulate into
		* a variable it closes over. If `visit` throws, the scan aborts (rolling back a
		* readwrite scan's partial writes) and rejects with that error.
		*/
		async scanByPrefix(mode, prefix, visit) {
			await this.runTransaction(mode, (store) => new Promise((resolve, reject) => {
				const request = store.openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve();
						return;
					}
					try {
						if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) visit(cursor);
						cursor.continue();
					} catch (err) {
						try {
							store.transaction.abort();
						} catch {}
						reject(err);
					}
				};
				request.onerror = () => reject(request.error);
			}));
		}
		/**
		* Delete every record whose key starts with `prefix`, in one commit-durable
		* readwrite transaction. One ranged delete rather than a value cursor: a
		* cursor deserialises every record in the store to test its key, and some
		* stores hold multi-MB records. The range is exactly "starts with": every
		* key from `prefix` up to, excluding, the prefix with its last code unit
		* incremented.
		*/
		async deleteByPrefix(prefix) {
			const last = prefix.charCodeAt(prefix.length - 1);
			if (last === 65535) throw new Error("deleteByPrefix: the prefix has no successor");
			const upper = prefix.slice(0, -1) + String.fromCharCode(last + 1);
			await this.tx("readwrite", (store) => store.delete(IDBKeyRange.bound(prefix, upper, false, true)));
		}
	};
	// src/sw/bootStore.ts
	/**
	* The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
	* a cold launch answers them without touching Cache Storage. On iOS the first
	* Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
	* which cache or how many entries (measured against an IndexedDB open in the
	* same worker: 17 ms); Cache Storage stays the store for everything lazy.
	*
	* Entries are keyed by build id, so a worker only ever serves its own
	* generation's bytes and the activate GC reaps a generation by prefix.
	*/
	var bootKeyPrefix = (buildId) => idbKeyPrefix(buildId);
	var bootKey = (buildId, url) => idbRecordId(buildId, url);
	var idbBootStore = () => {
		const store = new IdbKeyedStore("km-boot", "entries");
		return {
			get: (key) => store.tx("readonly", (s) => s.get(key)),
			putAll: (entries) => store.runTransaction("readwrite", async (s) => {
				for (const [key, entry] of entries) s.put(entry, key);
			}),
			deletePrefix: (prefix) => store.deleteByPrefix(prefix)
		};
	};
	// src/sw/previewDatabases.ts
	var SERVICE_WORKER_META_CACHE = "km-meta";
	var PREVIEW_DATABASE_RECORD_BASENAME = "__km_database__";
	var previewDatabaseRecordInfo = (recordUrl, ledgerBasename) => {
		try {
			const url = new URL(recordUrl);
			const marker = `/${PREVIEW_DATABASE_RECORD_BASENAME}/`;
			const markerIndex = url.pathname.indexOf(marker);
			if (markerIndex < 0) return null;
			const encodedName = url.pathname.slice(markerIndex + marker.length);
			if (!encodedName || encodedName.includes("/")) return null;
			const scopePath = url.pathname.slice(0, markerIndex + 1);
			return {
				scopeUrl: `${`${url.origin}${scopePath}`}${ledgerBasename}`,
				name: decodeURIComponent(encodedName)
			};
		} catch {
			return null;
		}
	};
	// src/sw/worker.ts
	/**
	* The service worker's orchestration — ledger I/O, install precache, activate
	* GC, and fetch routing — as a factory parameterized by its globals
	* (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
	* entry (src/sw/sw.ts) constructs one of these with the real globals + injected
	* build config and wires it to the SW events; tests construct one with an
	* in-memory CacheStorage and a stub fetch and drive install/activate/fetch
	* directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
	* makes it importable + unit-testable outside a worker.
	*
	* The versioning model this implements is documented in the sw.ts header.
	*/
	var CACHE_PREFIX = "km-";
	var VENDOR_HOSTS = /* @__PURE__ */ new Set(["esm.sh"]);
	var createServiceWorker = (config, env) => {
		const { buildId, scopeURL, keepGenerations } = config;
		const { caches, fetch, now } = env;
		const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`;
		const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`;
		const VENDOR_CACHE = `${CACHE_PREFIX}vendor`;
		const META_CACHE = SERVICE_WORKER_META_CACHE;
		const toScopeUrl = (p) => new URL(p, scopeURL).toString();
		const resolveManifest = (manifest) => Object.entries(manifest).map(([path, digest]) => [toScopeUrl(path), digest]);
		const SHELL_ENTRIES = resolveManifest(config.precacheShell);
		const PRECACHE_ENTRIES = resolveManifest(config.precacheAssets);
		const PRECACHE_REST_ENTRIES = resolveManifest(config.precacheRestAssets);
		const PRECACHE_ASSETS = PRECACHE_ENTRIES.map(([url]) => url);
		const SHELL_URL = toScopeUrl("./index.html");
		const BOOT_SET = [[SHELL_CACHE, [SHELL_URL]], [ASSET_CACHE, PRECACHE_ASSETS]];
		const BOOT_URLS = new Set(BOOT_SET.flatMap(([, urls]) => urls));
		const deleteGeneration = (id) => [
			caches.delete(`${CACHE_PREFIX}shell-${id}`),
			caches.delete(`${CACHE_PREFIX}assets-${id}`),
			env.bootStore?.deletePrefix(bootKeyPrefix(id)).catch(() => void 0)
		];
		const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname);
		const LEDGER_BASENAME = "__km_generations__";
		const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`);
		const readLedgerEntry = async () => {
			try {
				const res = await (await caches.open(META_CACHE)).match(LEDGER_KEY);
				if (!res) return {
					ids: [],
					updatedAt: void 0
				};
				return normalizeLedger(await res.json());
			} catch {
				return {
					ids: [],
					updatedAt: void 0
				};
			}
		};
		const readLedger = async () => (await readLedgerEntry()).ids;
		const writeLedgerEntry = async (entry) => {
			const cache = await caches.open(META_CACHE);
			const nextEntry = {
				...entry,
				updatedAt: now()
			};
			await cache.put(LEDGER_KEY, new Response(JSON.stringify(nextEntry), { headers: { "content-type": "application/json" } }));
		};
		let ledgerMutationChain = Promise.resolve();
		const mutateLedgerEntry = async (mutate) => {
			const run = ledgerMutationChain.then(async () => {
				const entry = await readLedgerEntry();
				await writeLedgerEntry(await mutate(entry));
			});
			ledgerMutationChain = run.catch(() => {});
			await run;
		};
		const recordGeneration = async (id) => {
			await mutateLedgerEntry((entry) => {
				const ids = entry.ids.filter((x) => x !== id);
				ids.push(id);
				return {
					...entry,
					ids
				};
			});
		};
		const forgetGeneration = async (id) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: entry.ids.filter((x) => x !== id)
			}));
		};
		const writeLedger = async (ids) => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids
			}));
		};
		const trimLedger = async () => {
			await mutateLedgerEntry((entry) => ({
				...entry,
				ids: computeKeepIds(entry.ids, keepGenerations)
			}));
		};
		let lastTouchAt = 0;
		const maybeTouchOwnLedger = (waitUntil) => {
			if (!OWN_SCOPE_IS_PREVIEW) return;
			const t = now();
			if (t - lastTouchAt <= config.touchIntervalMs) return;
			lastTouchAt = t;
			const touch = (async () => {
				try {
					await mutateLedgerEntry((entry) => entry);
				} catch {}
			})();
			if (waitUntil) waitUntil(touch);
		};
		const install = async () => {
			try {
				await precache();
			} catch (err) {
				await Promise.allSettled(deleteGeneration(buildId));
				await forgetGeneration(buildId).catch(() => {});
				throw err;
			}
		};
		const precache = async () => {
			await recordGeneration(buildId);
			const [shell, assets] = await Promise.all([caches.open(SHELL_CACHE), caches.open(ASSET_CACHE)]);
			const fetchInto = async (cache, url, digest, mode) => {
				const res = await fetch(new Request(url, { cache: mode })).catch(() => null);
				if (!res || !res.ok) return;
				const body = await res.clone().arrayBuffer().catch(() => null);
				if (!body) return;
				if (await contentDigest(body) !== digest) throw new Error(`[sw] ${url} differs from build ${buildId}'s copy; another deploy is being served`);
				await cache.put(url, res).catch(() => {});
			};
			const runPooled = async (entries, limit, task) => {
				let next = 0;
				let failure;
				const worker = async () => {
					while (!failure && next < entries.length) {
						const [url, digest] = entries[next++];
						try {
							await task(url, digest);
						} catch (err) {
							failure ??= { err };
						}
					}
				};
				await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
				if (failure) throw failure.err;
			};
			await runPooled(SHELL_ENTRIES, SHELL_ENTRIES.length, (u, d) => fetchInto(shell, u, d, "reload"));
			await runPooled(PRECACHE_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
			await seedBootStore();
			await runPooled(PRECACHE_REST_ENTRIES, 16, (u, d) => fetchInto(assets, u, d, "no-cache"));
		};
		const seedBootStore = async () => {
			const store = env.bootStore;
			if (!store) return;
			try {
				for (const [cacheName, urls] of BOOT_SET) {
					const cache = await caches.open(cacheName);
					const entries = [];
					for (const url of urls) {
						const cached = await cache.match(url);
						if (!cached) continue;
						entries.push([bootKey(buildId, url), {
							status: cached.status,
							contentType: cached.headers.get("content-type") ?? "application/octet-stream",
							body: await cached.arrayBuffer()
						}]);
					}
					await store.putAll(entries);
				}
			} catch {}
		};
		const bootStoreFirst = async (url, fallback) => {
			const store = env.bootStore;
			if (store && BOOT_URLS.has(url)) try {
				const entry = await store.get(bootKey(buildId, url));
				if (entry) {
					env.mark?.("bootStoreHitAt");
					return new Response(entry.body, {
						status: entry.status,
						headers: { "content-type": entry.contentType }
					});
				}
			} catch {}
			return fallback();
		};
		const activate = async () => {
			const ledger = await readLedger();
			const keepIds = new Set(computeKeepIds(ledger, keepGenerations));
			const expiredIds = computeExpiredIds(ledger, keepGenerations);
			await Promise.all(expiredIds.flatMap(deleteGeneration));
			if (ledger.length > keepIds.size) try {
				await trimLedger();
			} catch {}
			try {
				await sweepStalePreviewGenerations();
			} catch {}
		};
		const sweepStalePreviewGenerations = async () => {
			const meta = await caches.open(META_CACHE);
			const ledgers = [];
			const databaseRecords = [];
			for (const req of await meta.keys()) {
				if (req.url.endsWith(`/${LEDGER_BASENAME}`)) {
					const res = await meta.match(req);
					if (!res) continue;
					const { ids, updatedAt } = normalizeLedger(await res.json().catch(() => null));
					ledgers.push({
						scopeUrl: req.url,
						ids,
						updatedAt
					});
					continue;
				}
				const recordInfo = previewDatabaseRecordInfo(req.url, LEDGER_BASENAME);
				if (recordInfo) {
					const res = await meta.match(req);
					const raw = res ? await res.json().catch(() => null) : null;
					databaseRecords.push({
						...recordInfo,
						recordUrl: req.url,
						updatedAt: databaseRecordUpdatedAt(raw)
					});
				}
			}
			const sweepNow = now();
			const plan = computeReapableCaches({
				ledgers,
				now: sweepNow,
				staleMs: config.staleScopeMs,
				selfScopeUrl: LEDGER_KEY
			});
			await Promise.all([
				sweepStalePreviewDatabases(meta, {
					ledgerScopeUrls: plan.ledgerScopeUrls,
					knownLedgerScopeUrls: ledgers.map(({ scopeUrl }) => scopeUrl),
					databaseRecords,
					sweepNow,
					staleMs: config.staleScopeMs
				}),
				...plan.reapIds.flatMap(deleteGeneration),
				...plan.ledgerScopeUrls.map((url) => meta.delete(url))
			]);
		};
		const databaseRecordUpdatedAt = (raw) => {
			if (!raw || typeof raw !== "object") return void 0;
			const { updatedAt } = raw;
			return typeof updatedAt === "number" ? updatedAt : void 0;
		};
		const previewIdForScopeUrl = (scopeUrl) => {
			try {
				return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null;
			} catch {
				return null;
			}
		};
		const isDatabaseNameForPreviewScope = (databaseName, scopeUrl) => {
			const previewId = previewIdForScopeUrl(scopeUrl);
			if (!previewId) return false;
			const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`^kmp-v\\d+~${escapedPreviewId}~[A-Za-z0-9_-]*\\.db$`).test(databaseName);
		};
		const databaseRecordsToSweep = (ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs) => {
			const reapedScopes = new Set(ledgerScopeUrls);
			const knownScopes = new Set(knownLedgerScopeUrls);
			const records = [];
			const seen = /* @__PURE__ */ new Set();
			for (const record of databaseRecords) {
				const orphanedStaleRecord = typeof record.updatedAt === "number" && sweepNow - record.updatedAt > staleMs && !knownScopes.has(record.scopeUrl);
				if (!reapedScopes.has(record.scopeUrl) && !orphanedStaleRecord) continue;
				if (!isDatabaseNameForPreviewScope(record.name, record.scopeUrl)) continue;
				const key = `${record.scopeUrl}\n${record.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
			return records;
		};
		const sweepStalePreviewDatabases = async (meta, { ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs }) => {
			const databases = databaseRecordsToSweep(ledgerScopeUrls, knownLedgerScopeUrls, databaseRecords, sweepNow, staleMs);
			await Promise.all(databases.map(async ({ name, recordUrl }) => {
				try {
					await deleteOpfsSqliteDatabase(name);
					await deleteIndexedDatabase(name).catch(() => {});
				} catch {
					return;
				}
				await meta.delete(recordUrl).catch(() => false);
			}));
		};
		const deleteOpfsSqliteDatabase = async (databaseName) => {
			if (typeof env.storage?.getDirectory !== "function") return;
			const root = await env.storage.getDirectory();
			const journalFailure = (await Promise.allSettled(SQLITE_JOURNAL_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)))).find((result) => result.status === "rejected");
			if (journalFailure) throw journalFailure.reason;
			await removeOpfsEntryIfExists(root, databaseName);
			await Promise.allSettled(WRITE_AHEAD_SIDECAR_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)));
		};
		const removeOpfsEntryIfExists = async (root, name) => {
			try {
				await root.removeEntry(name);
			} catch (err) {
				if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
			}
		};
		const deleteIndexedDatabase = async (databaseName) => {
			const idb = env.indexedDB;
			if (typeof idb?.deleteDatabase !== "function") return;
			if (typeof idb.databases === "function") {
				const existing = await idb.databases().catch(() => null);
				if (existing && !existing.some((db) => db.name === databaseName)) return;
			}
			await new Promise((resolve, reject) => {
				const request = idb.deleteDatabase(databaseName);
				let settled = false;
				const settle = (fn) => {
					if (settled) return;
					settled = true;
					fn();
				};
				request.onsuccess = () => settle(resolve);
				request.onerror = () => settle(() => reject(request.error));
				request.onblocked = () => settle(() => reject(/* @__PURE__ */ new Error(`IndexedDB delete blocked for ${databaseName}`)));
			});
		};
		const isNavigationRequest = (request) => request.mode === "navigate" || request.method === "GET" && (request.headers.get("accept")?.includes("text/html") ?? false);
		const isSameOrigin = (url) => url.origin === env.origin;
		const isVendor = (url) => VENDOR_HOSTS.has(url.hostname);
		const shellCacheFirst = async (request, shellURL) => {
			const cache = await caches.open(SHELL_CACHE);
			env.mark?.("shellCacheOpenedAt");
			const cached = await cache.match(shellURL);
			env.mark?.("shellCacheMatchedAt");
			if (cached) return cached;
			const fresh = await fetch(request);
			if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {});
			return fresh;
		};
		const assetCacheFirst = async (request) => {
			const assets = await caches.open(ASSET_CACHE);
			const cached = await assets.match(request) || await (await caches.open(SHELL_CACHE)).match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		const cacheFirst = async (request, cacheName) => {
			const cache = await caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			try {
				const fresh = await fetch(request);
				if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
				return fresh;
			} catch {
				return Response.error();
			}
		};
		/**
		* Route a GET request. Returns a Response promise for the entry to
		* `respondWith`, or undefined to NOT intercept (let the browser handle it —
		* non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
		* like version.json that must stay fresh).
		*/
		const handleFetch = (request, waitUntil) => {
			if (request.method !== "GET") return void 0;
			const url = new URL(request.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
			maybeTouchOwnLedger(waitUntil);
			if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return void 0;
			if (isNavigationRequest(request) && isSameOrigin(url)) {
				if (url.pathname === scopeURL.pathname || url.href.split(/[?#]/)[0] === SHELL_URL) return bootStoreFirst(SHELL_URL, () => shellCacheFirst(request, SHELL_URL));
				return shellCacheFirst(request, SHELL_URL);
			}
			if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) return bootStoreFirst(request.url, () => assetCacheFirst(request));
			if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE);
		};
		return {
			install,
			activate,
			handleFetch,
			readLedger,
			writeLedger,
			recordGeneration
		};
	};
	// src/sw/sw.ts
	var bootMarks = {
		timeOrigin: performance.timeOrigin,
		evaluatedAt: 0,
		firstNavReceivedAt: 0,
		firstNavAnsweredAt: 0
	};
	var mark = (name) => {
		if (!bootMarks[name]) bootMarks[name] = performance.now();
	};
	var sw = createServiceWorker({
		buildId: "99b78293f3b8-e746568c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a15fd4e286ad1149\",\"/knowledge-medium/index.html\":\"a15fd4e286ad1149\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CCfXGceC.js\":\"7392c1be2dac17a2\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0ef8068b4c9d4472\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CI0YzFGH.js\":\"65519f896d9ff429\",\"/knowledge-medium/chunks/FacadeVFS-UuQj55a8.js\":\"db3fc661c3f67e91\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DIK7ijWM.js\":\"bd98e0b8b2995cf3\",\"/knowledge-medium/chunks/MemoryVFS-69xMMoft.js\":\"3dbd1abe9c8b405e\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DnfpL8Mr.js\":\"1f490c6460f1223a\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DCvqghsN.js\":\"5acda562c1a0c1ce\",\"/knowledge-medium/chunks/Preview-BEoD-9Rf.js\":\"2ad93c1616a6a98c\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BxP_VRU3.js\":\"7c6dacf8c4e893a1\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BbCTbQCx.js\":\"245786d5bc0b4831\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react--gLvhtmp.js\":\"9d41d5f8b7f92882\",\"/knowledge-medium/chunks/react-BeZ8BvRY.js\":\"70d218ce05c39778\",\"/knowledge-medium/chunks/react-CPHXWeKS.js\":\"a615d8febd83b5fe\",\"/knowledge-medium/chunks/react-CzbYnqag.js\":\"14be810ebe551d7c\",\"/knowledge-medium/chunks/react-DPrvJlYN.js\":\"bc789fb6fe10ab81\",\"/knowledge-medium/chunks/react-DbT5HChM.js\":\"316fc5c4c8bdff3a\",\"/knowledge-medium/chunks/react-DoisQipC.js\":\"7050fffc952ca07f\",\"/knowledge-medium/chunks/react-DrrbZiXX.js\":\"90d75276c67c7608\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C3xEdnJz.js\":\"3e8c91392a61b74d\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BWCiO4gc.js\":\"2e7a08e0c213fdc5\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BSNRtYjt.js\":\"c8379c552069c05d\",\"/knowledge-medium/chunks/server.browser-DQyyOrhp.js\":\"25507dec9c03e005\",\"/knowledge-medium/chunks/textarea-D3-NBtYr.js\":\"d98427d28fb6028d\",\"/knowledge-medium/chunks/ui-mTaXut5o.js\":\"949ef86cd0e3e6cd\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"c0ca92fe05638d9e\",\"/knowledge-medium/src/appUpdate.js\":\"1eefa890f18c4a0a\",\"/knowledge-medium/src/appVersion.js\":\"a47b4c2de05073a1\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"0b85cb187a9a122c\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"815b15baf6b0e15e\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"1c8f7fb0227fbee1\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"2052df9feac953a3\",\"/knowledge-medium/src/components/BlockComponent.js\":\"ce66171469b441e3\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"4f68c99c9b34350c\",\"/knowledge-medium/src/components/BlockEditor.js\":\"88aebb8ead9e58e5\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"348d7641b6be84c6\",\"/knowledge-medium/src/components/BlockProperties.js\":\"90ad447aa0608fbf\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a23c58b329fc09d9\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"8c8fcd3e5003680a\",\"/knowledge-medium/src/components/DividerHandle.js\":\"f5c47f7796e6ee65\",\"/knowledge-medium/src/components/DraftEditor.js\":\"745b46cd1f1bf52e\",\"/knowledge-medium/src/components/GutterPill.js\":\"29ca5f92e99e8597\",\"/knowledge-medium/src/components/Header.js\":\"a9444249977eb05f\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"2f8a101ae26c0051\",\"/knowledge-medium/src/components/Login.js\":\"91b48713a6e782a7\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"9a2d104c8b73bb1f\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"fc3a6929d66c8476\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"457616e441286b4c\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2358c465148e66b3\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"5d1cc7c064e03433\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3736944e860efd5c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"50ee9a6107e98244\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"aa6baf58a6d708f0\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"1dfaab1f7498ca0e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"a93a1113eb6c12aa\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"c8b5056ad568f591\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"75894485fbe7cd93\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"14892b2b5ce80d57\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"e6a3eaf210e87d9d\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e6313aae735178af\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"5cfac3c19dd50cec\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"34ea1c96c2d37939\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"62b702dbda59483a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"291e76690e2c769c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f86a83fe65329ed7\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"c390cdef82ab9d33\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"89e88878026ddd9a\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f2b512870821bef4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"43bc0f1c82462d8f\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"5ec4c0a1a2cbabc7\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"831ed5352e853038\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"18750a45ba443ecb\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"c6892d817dfab1b6\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"b9f411fc00373cda\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"8591de0ddcdb00ae\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"6814f5aae5291b7d\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"e35f0e25857c9cbe\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"c43370f3f6284a71\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"2deebbdcac2c46e8\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"e089284cea8e3e6d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"46a0d749ddcc86ef\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"3bfae8a4278ba4f7\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"81fdea580b280fe4\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"47ff7d919bdce21a\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"315afa0eaa8d88a1\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"5190f2579ba3d794\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4d5b1dfc7772eb75\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"49438be62215ba0d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"e3200e4c8fc36a22\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"65fa3a67a1f1c232\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"c246c51bb91e6846\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"d5027aee18b24388\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"371fed0f144362b9\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"379f86ddcd7dce38\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ef12efc0c343b254\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"df69afdd12a09b6e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"b962b83448fa3eea\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"702090e00b681169\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"95a37b294582f95c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"38d689e69ec7d272\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"dfb991729a21e477\",\"/knowledge-medium/src/components/ui/button.js\":\"eb2b61a8b319829a\",\"/knowledge-medium/src/components/ui/card.js\":\"6b2f9c8f3f5db579\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"c6cc99cf278eb531\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"58f0a5b7d7f6916c\",\"/knowledge-medium/src/components/ui/command.js\":\"c19dd8a4adaed913\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6effdfe038dc598a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"83df3fb1daee0858\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c5f99aa87eaf1b2f\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"6997848cb08e6502\",\"/knowledge-medium/src/components/ui/index.js\":\"1197af5e54c2543a\",\"/knowledge-medium/src/components/ui/input.js\":\"9f2d82d2690d4c29\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a893e8f5bb2a6ab4\",\"/knowledge-medium/src/components/ui/label.js\":\"2727f97db6ad9778\",\"/knowledge-medium/src/components/ui/textarea.js\":\"cf5e2904f02e9c48\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"2eb02912ccf41376\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"49b71ed2852a3087\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"3c7b1a3cb12caf1a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"822407f76ddbefb9\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"475c20780ba21b30\",\"/knowledge-medium/src/components/util/error.js\":\"579d85df867c1069\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"1132025a8f8f153e\",\"/knowledge-medium/src/components/util/suspense.js\":\"fd1aa41e6c218fc3\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"978ffd4985f4a554\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"62d76ca72b66954c\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c6f2a991dcd17ff8\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"11a45cd9f6e47499\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"1c8b819836249104\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"5bee494457c16866\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"29f229334755a388\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"f4036ad1b8bf60b0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"78628c6646d2237a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"750571a34cfd85d3\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"78755ea08505a5a8\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7aee450c069607ce\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fa12936dea0c15c2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"18758d190090c61a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"43e3cc35fca32e89\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"1ddcb577c7352192\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"5f403b59c900c37d\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"1aef031e332fabee\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6d44ae9fc71dffba\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"2d2a7d8c687c7195\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"79f4ff8793282fa4\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"b6bc5aa6ed20a962\",\"/knowledge-medium/src/context/block.js\":\"cad65641ea767a39\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"6ce89da773bf836e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"9a9189156d3f503d\",\"/knowledge-medium/src/context/repo.js\":\"887cf737feeb102d\",\"/knowledge-medium/src/data/aliasClaim.js\":\"e601895841793156\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"cde79e15293bd69b\",\"/knowledge-medium/src/data/api/blockData.js\":\"0c77c9acc64122b9\",\"/knowledge-medium/src/data/api/blockType.js\":\"8cc7d81f3daf5e92\",\"/knowledge-medium/src/data/api/changeScope.js\":\"24f3f5d84c064d53\",\"/knowledge-medium/src/data/api/codecs.js\":\"ec0bed36e82d51a9\",\"/knowledge-medium/src/data/api/derivedData.js\":\"45c2f9d279463066\",\"/knowledge-medium/src/data/api/errors.js\":\"f9fee6b2b315ebb8\",\"/knowledge-medium/src/data/api/events.js\":\"b7670050b8260a67\",\"/knowledge-medium/src/data/api/handle.js\":\"1351a1dba4096aa7\",\"/knowledge-medium/src/data/api/index.js\":\"03d13437b13fa8e7\",\"/knowledge-medium/src/data/api/mutator.js\":\"57812d91d4bccc59\",\"/knowledge-medium/src/data/api/processor.js\":\"53de553044996363\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"0f8db2bf663de805\",\"/knowledge-medium/src/data/api/query.js\":\"f166bf8f9751e278\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"9958bea2f221418f\",\"/knowledge-medium/src/data/api/schema.js\":\"1351a1dba4096aa7\",\"/knowledge-medium/src/data/api/tx.js\":\"1351a1dba4096aa7\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2181c97d8bbf26a4\",\"/knowledge-medium/src/data/api/user.js\":\"1d0396bb6ab10fb1\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"113f4394e538221e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"4c02687c98e2d0c5\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"c177c6d762312b2b\",\"/knowledge-medium/src/data/block.js\":\"2c7130586f9a8d19\",\"/knowledge-medium/src/data/blockCache.js\":\"522495f45362373f\",\"/knowledge-medium/src/data/blockId.js\":\"0bad43d481ec8f7a\",\"/knowledge-medium/src/data/blockLiveness.js\":\"3efbff2ff3d58bf6\",\"/knowledge-medium/src/data/blockMerge.js\":\"18e46e272a4ae8a7\",\"/knowledge-medium/src/data/blockSchema.js\":\"c0bef5a8ad25ec04\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"7dd55ecc520d46f5\",\"/knowledge-medium/src/data/blockTypes.js\":\"cb5cd2d0deeceed2\",\"/knowledge-medium/src/data/childrenView.js\":\"ad76cb6ccc34a3ac\",\"/knowledge-medium/src/data/clientContext.js\":\"2ed189498d594efe\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"d2de9e1a88fd5409\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"0b86511b654aea98\",\"/knowledge-medium/src/data/derivedIds.js\":\"8b13511b42390d6e\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"d1f2b349273de4b7\",\"/knowledge-medium/src/data/facetBridge.js\":\"50976e5b58031543\",\"/knowledge-medium/src/data/facets.js\":\"a5f9d4a06e2417d9\",\"/knowledge-medium/src/data/globalState.js\":\"73ade7acd9423da0\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"38a265b68b08e6c7\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8ea09deb5b6a5e02\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"53595a85bd56bfff\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"439d67433c4620b4\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"7cf78f90bfbb7f14\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"6226ef417b74594a\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"33a48d8a16354e5c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"018f898abb18fb31\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"b8b90efafacc031c\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"faf05687abe8ae21\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"f97b1cd4815db3b2\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"f4bc9a5ed6740367\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"a4ad54d2731a89df\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"9e712e434abef2d2\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"41dda35d6b92986e\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"dabffb65b93c195d\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"45b09db1f081c335\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"649ef016b435fec2\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"3eb5ca2a26401bb1\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"2ddd7065e760429f\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"726dd04518bdcfbb\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"64b12a6ef32bf363\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"54d39f301499df26\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"efc52ecf2fb3dd0a\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c58eb46c900873b9\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"4118099135fcef97\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"9dd396380e8dbf9b\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"c014ae4c970c3cc8\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"d0a9495355e80c71\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"8c4409214d851d7d\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"906b276009b38185\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"22417995b1100a4f\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"1bc82837c17e1259\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"8f98f7c85a442b46\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"cfb4dd2550b79b58\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"d0bcc7ba17f0b3e8\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2c18185170bdfc04\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"676421a5f9e31129\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"de5c485d77127555\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d4cbbe896e5a0c87\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"2f266cbb4f07202d\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"bccdb08da2098c24\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"86ddea20f7abadb0\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"cd9e4bb184f61c48\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"edb43a76d71bf7d5\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"b53d4485a79c72e5\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"64126d52c612936e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"080cea5af8543443\",\"/knowledge-medium/src/data/invalidation.js\":\"3cb2f9a42f54d1b6\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"8c10bd86677aae1c\",\"/knowledge-medium/src/data/kernelPage.js\":\"5f44eca28b62944b\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"762ac426fc6537c8\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"ed58a1b8109bfe92\",\"/knowledge-medium/src/data/localDbStorage.js\":\"6339bf64df4b6f04\",\"/knowledge-medium/src/data/localDbVfs.js\":\"9e4b316b8a18f09f\",\"/knowledge-medium/src/data/localSchema.js\":\"8526dfb371464f62\",\"/knowledge-medium/src/data/maintenance.js\":\"7de31199077d12c8\",\"/knowledge-medium/src/data/mergeProperties.js\":\"938a98f1fc390e15\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"2c858df04c9ffd16\",\"/knowledge-medium/src/data/migrationsPage.js\":\"116553e15d537c69\",\"/knowledge-medium/src/data/mutators.js\":\"ff8280e835624f90\",\"/knowledge-medium/src/data/orderKey.js\":\"43b7cbcf0953565c\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"7efbf86ce832e493\",\"/knowledge-medium/src/data/outlineSurface.js\":\"43654b2f6ac5dcbc\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"57b5887e796a7853\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"d170bd4f3be3fb2d\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"422185b9bcd1d69a\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"4de79132d3c5b139\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"de72a6a99ef2fed8\",\"/knowledge-medium/src/data/properties.js\":\"4334724037ce7c2c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"8a2a2514b7df4eb8\",\"/knowledge-medium/src/data/propertyChildren.js\":\"456e81b9d7b75477\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"1d949057b57fcd0f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"afef47b944ba4ed2\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"60e64193ae48acae\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"a6c80849a0dabe68\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"7e4d6726e893d9b5\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"0d6d995b98eb1caf\",\"/knowledge-medium/src/data/propertySeeds.js\":\"002360c4e008b9f0\",\"/knowledge-medium/src/data/recentsPage.js\":\"91eb1b4a91b19ccd\",\"/knowledge-medium/src/data/referenceBlock.js\":\"a03dec51900ca61c\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"cada99240e4eea52\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"e58d0cb9d6862209\",\"/knowledge-medium/src/data/repo.js\":\"8af799d6d7c04d90\",\"/knowledge-medium/src/data/repoProvider.js\":\"c9d6d7b1891f6674\",\"/knowledge-medium/src/data/rowProperty.js\":\"c1aa2e4b1579f94b\",\"/knowledge-medium/src/data/searchFilter.js\":\"7ca9a5e17dda97c7\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"0b5756aeb54e8353\",\"/knowledge-medium/src/data/stateBlocks.js\":\"32fb9eeff6b74b40\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"8f03a385417ce91a\",\"/knowledge-medium/src/data/structuralInsert.js\":\"d2e6ca70696ed038\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"0dc3a3533a29783d\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"bab6441cb85db8e9\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"6606be814a62d8cb\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"56b49011df8365a4\",\"/knowledge-medium/src/data/targets.js\":\"4fa7e2078230541f\",\"/knowledge-medium/src/data/typeColors.js\":\"7340bee7d75cd202\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"d1a5165074953d08\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"eda5f711b699be5e\",\"/knowledge-medium/src/data/typeExtraction.js\":\"826203a36cadd69f\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"380b41c9ca670a37\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"cd02b981431d450c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"261054e3761921d4\",\"/knowledge-medium/src/data/typeTagger.js\":\"5078b783a3166b25\",\"/knowledge-medium/src/data/typedRecords.js\":\"a5fed83c1ede82e4\",\"/knowledge-medium/src/data/typesPage.js\":\"b682234f4b952285\",\"/knowledge-medium/src/data/userPrefs.js\":\"12d23bb2058b1fec\",\"/knowledge-medium/src/data/userSchemasService.js\":\"bfd633b1b80ed26a\",\"/knowledge-medium/src/data/userTypesService.js\":\"acba73626eeba045\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"23667f09f1b4f14b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"7c1e147dc3c7abdb\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"275a4b821ff0a569\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"4836158e3e9dd744\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"80a0ba9f7f02b266\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"7abd87996fe2bcc8\",\"/knowledge-medium/src/data/workspaces.js\":\"37bb6c443f255b81\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"ba5a94c803e47d38\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"2685f1b72ce6d966\",\"/knowledge-medium/src/editor/atTrigger.js\":\"13f3e865c892ad2a\",\"/knowledge-medium/src/editor/autocomplete.js\":\"408c16d1a105cbb1\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"476d293c69487cb2\",\"/knowledge-medium/src/editor/contentFlush.js\":\"dff013a6713ee59f\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"2175f7e0c3a3dfec\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"ee6452d76b578389\",\"/knowledge-medium/src/editor/insertImage.js\":\"1c1470f8bd0b51d4\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"848b2fe5991dab2a\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"e393b1ba13b7b5ee\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"62884b3618087f32\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"f46fa2e432576eb0\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"29277985e5890aff\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"d963d929a26b8c72\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"324a61e9096bc7a6\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"5adc64236e2a1c51\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"d760cbbb92869436\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"0c2c25e7aba64513\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"4be83b5904c955e4\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"72827d039be5af91\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"a97b9b27e60498b9\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"f0757157d23236e8\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"ae3a17f7fa97ddea\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"7d1c8ab7339443a7\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"ab4894d730f06091\",\"/knowledge-medium/src/extensions/core.js\":\"6610c4af64f1a085\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"3abae32713000c52\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"cd34eb093d497742\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"1c3d6960d509e3e2\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"aa0b89c78bad6ffb\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"a2cd403a36ed1057\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"7146d0f2667182e4\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"406fff1c79e25a16\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ff3dc4ed1c754171\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"b5f884f5251ced29\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"09531f5f4738149c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ec581e29f3d3ebfa\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"85d6a1be45025dfd\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"079f0d5f51173cfe\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"34165f915fb8f21d\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"0e5093cb2d3f3fa6\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"a862dbf9fdbf77e9\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"7f54c76f1c04b498\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"b43267f969412bed\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"a5fab8a2012a7ff7\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"f9e29f3b636cf533\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"f1774b5513f2b209\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"549f9bf9b7676993\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"c27eea2383765259\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"0d482f1180ae88fc\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"0ee82e05fa3593a2\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"1bc8e8dc934d9adc\",\"/knowledge-medium/src/facets/facet.js\":\"aa2a3a279c68c9fb\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"67d638d4ae2c91fb\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"6d4fc46ec3f23888\",\"/knowledge-medium/src/facets/togglable.js\":\"79f3b543366eba02\",\"/knowledge-medium/src/facets/variantFacet.js\":\"8961d779f3ec1285\",\"/knowledge-medium/src/facets/verbFacet.js\":\"a968956306fa8ad1\",\"/knowledge-medium/src/hooks/block.js\":\"0cc479a90df7954e\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"b852eb9fb1f31b57\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"d6dbf4bb9ebb917e\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"44e90dbc93678f23\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"13c20f03c0af41e2\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"58c7899e0827a035\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"f5c833036e4a9f70\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"4daeaa8ce1c44285\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"4ead42af177caa81\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"8840a4361500e655\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"b650d2e2d28dc36d\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"fc4c991402813e7c\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"aefbf91253c3a53a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4afbe3ede25bd6a8\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"af0d544b6f4fa542\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"81cecfa8e0c647e1\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a7470b4ff50df74b\",\"/knowledge-medium/src/lib/utils.js\":\"e1f2b2515c57c2fa\",\"/knowledge-medium/src/main.js\":\"3f710dda3632feab\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"537ea6d5dd15336f\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"9849e67e54656bc0\",\"/knowledge-medium/src/markdown/context.js\":\"311b7c689dc29953\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"86ddcc75a000805a\",\"/knowledge-medium/src/markdown/extensions.js\":\"e146259f988980df\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"cc246686e98177e9\",\"/knowledge-medium/src/minimal-editor.js\":\"631eddf0d3528a45\",\"/knowledge-medium/src/paste/armedCut.js\":\"f624a34722dc731e\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ba7c459973bd79b4\",\"/knowledge-medium/src/paste/clipboard.js\":\"570e9713a5338af9\",\"/knowledge-medium/src/paste/decision.js\":\"c6d1679e8cf0e312\",\"/knowledge-medium/src/paste/operations.js\":\"94a89a261c667ab7\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"c1f100a5abeded50\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"925a03f16b75d618\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"fb7776d1831bad7c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"cd9a9ba6033971fa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3e87547a70004fb3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"36e69fa84460166c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"1463de9af8efe0a3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3eacdba49977d477\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"5476d24d9d22d9b4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2972c319224a152a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"17edb73f2ff66f7a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"304175c311597b4b\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bdf358bbefa31266\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"72eca81649ea117b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"17fc99a9c9e65293\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"c9731cad41b2905c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"573e451a658ed0c7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d6cc527d069f398c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b183cab6c59f0c09\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"eefbe781e7839cc9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"91c5033c35ceded7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"46a7c824ee1fcd1f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cd4f3aae5c45f255\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"333a7e643a3bd4ea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"dfdd7f488791a0e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2004802d924fe3f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"74bc49a6f2e45fda\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"6c684f74316695a2\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"095841c0e8d99500\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"d78291d6028c28f2\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"95751bc455a1d972\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"e1a1dd64a12af774\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"f06be0d731e24c27\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"abd2bd76d42ecd74\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"c490da6d78d19c49\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"2f3ff26110b12fad\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"10553c1ab910dba4\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"9b8aa7dd4783c705\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"c16e933ce608321d\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"fc95b9189bb11035\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"16e2f773c0344a0e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"5cccee1fea881b52\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f203ff9f07353621\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6dfc8cb85e10395b\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"4a551e2a29c414a8\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"5ff46144a68dc06d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"56878fee7005270f\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"7b901c97b99ccd0b\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8f0db9404717b8c2\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"66596724538f5baa\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"1be4534c394a8cb9\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"d1e239ef1c29f266\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"2800ab478a13f0a4\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"accaee8c941aced6\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"7c01610872455e61\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"e722e9543c4293d6\",\"/knowledge-medium/src/plugins/alias/index.js\":\"bd4c55ba474baadb\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"9b6b71a1ae035a6c\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"8e17b620b995a569\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d573dd143a11e217\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"9828eee69e73d365\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"44493ab56b4b1f1b\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"6c2e701c9651a394\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"335b46586bf85e53\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"519cd26e20eb9d61\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"bc45ce7e245fb06e\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"6e88395624e0284b\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"7b5766dbd3fde3a5\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"d4d3b4bcdc3e9550\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"9c58a6d1097a9385\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"73e9771a75810a79\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"88651e7434c4d9e3\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"9ad79a1beee49a69\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"19b3b1869993cf1c\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"99d5beb6ed7d400e\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ed51d84df1c43d49\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"f7012e4dd4551cb8\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"f0f8fa13ed0f753c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"db99e1a71718bfd4\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"08ab5707497f4296\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"781cfc2197fd8612\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"7c8562e72638da21\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"76c9a123eb43f073\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"e69b632d115aa6e0\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"0c32e8263be09666\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"429cbe5002afc9b8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"204b6159e6fea5e8\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8d1aa635925c7983\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"5c5b816ea17ff1b4\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"0d779b75ac325839\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"902ef58defe14c61\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"d862e213de6d72ba\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"395483d7f5178d9a\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"afe59cd533b01558\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"eea29985e9d01470\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"d081aa1dd313f495\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"708c6f58e9a095cc\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"8a6d667334970d53\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"0b6a0b7587a6d24f\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d064dc0626a6466d\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"89066123e5c9c95a\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"a22fd8925dd711cc\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"74c9f06da0189325\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"35cfb13893d91698\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b46533385347b793\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"c59dca3b0e9dfd25\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"080f2c21229e2b49\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"03b75039e9eb9455\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"def13cdcc97cf4c0\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f43035c008e721b4\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"455d7c45ed0e6f76\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"a1bb80edf69ed1ae\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"7888d97e4baa3e9a\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"a253279f437e0769\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"d361d971707e034e\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4473f307c996fb9f\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"adeab719ed7bf2a3\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"7abf39153bfcb33f\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"9421c58f637c5606\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"43fdf84c5a78bacd\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"efa51078c614fa27\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"1f75c2641e77f713\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"880403edbf7fe055\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4d9b9e75db22eb87\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ef6e358741bfba67\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"246c77aabd43693e\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"2f557bb46ae12296\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3ab3af88692dd837\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"8e0770ec6c204e19\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"fe33f5503d8f2033\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"c1e58e3cecdbe048\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"3dbdddd99be586cf\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a45e53145f55c5d3\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"fbf0d4a834f96fe0\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"10a5560d67eb1da0\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"d0362134b9a4cb2a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"6510716e8e1c6952\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"2389e111a82795c9\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"ae7ed8b11c8ac4b0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"100d17ad299e415f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dcd75799953801dc\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"0d0c22a3d0d58641\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a6076d4642a244cd\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"73b208f632319cac\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"d644978487eb67f9\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"41b2ce7a51bc38a4\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"2bb1f13cc1fe3671\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"157d01fbef8351db\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"da2cc54bc8a2da52\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"79e2a4f1216b1165\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"405d461cd2c4f8c6\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"2d3e3912b24a9f10\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"da0e4f362077138e\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"15a9d20184dea9e6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"47e9c23ec955558f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"e3a2a59121849e16\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"885c154996b815d6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f0b32abd3836fe9c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"5ecf6b52973880f9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"06ae3f2b8a2ba3fb\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"0e225eb626fee1fe\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"1872892d760a6e0e\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"cf1901e16adcf6b9\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9856993e43f79600\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"655a17d1f7c31d2b\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"fceec2f7da96310b\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f5fcc8635139c357\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"8dcd49b7ab34f6e0\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6bed7f3bfe583cdc\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"dc17d530ff958543\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"665e84adcc483be5\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c7c199f258647fe9\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"9592b52c32c8d66e\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"dbbd211fbc745a31\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"73fe1519d8186dec\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"b45e1ce938fb9589\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"8e76e4617fbb77aa\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"f3f3e052fb8bfeb5\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"1d497fe8e8fdb0b9\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"9c1dd696866f7e84\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"ad44f9086290d0db\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ae5487a871a33ea4\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"39ad69923e84e720\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"11bc0fc867344b68\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"4d118cb8f7cf38c6\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"6940f5ae6116826b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7d192e39d67caf91\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"85f8286d91b8b9b1\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"1cb752ba2a8123e9\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"ad852d9581cdd0ee\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a5dc3cdfc68f5576\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"54767cc92aa00946\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f8cbb98653d5b370\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b668875c90052197\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ee80d7def3ca8806\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a493a2a1e4855657\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9877b39cd7fc788a\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"7513b34a501e40f3\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f5b59f885b6a1609\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c02fa3bc7cf89cbd\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"cf23192e44a3e50b\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"02a89716da9ff0dd\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"27aae17b9d7bb1cb\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9754a8771bb7d6ea\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"a99cc0bbe1042fc5\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"45c851fcf991d488\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"0c00dc2e7060db3a\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"a000e19402a26945\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"40ffd1d5cf8e8c8e\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"9b14303ae24ddb48\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b5eb7b6dbee4045a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"a412b58f4ca74dbc\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"d21e728ddcfa64e7\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"9be1814f81579dda\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"3325446cbbdd0cb8\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0e6f3c8bd0d304d0\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"c0e8d44ed131db40\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"5e53074e8a4e6b25\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"64fa0c54f146deb7\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"2f36596b039308fc\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"4b0e4bdc2c7bbf7f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"f72c4a74a7bb0492\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"9d1da3b08c47b9a4\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"7bcf4e8ed801eb62\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"45f1b181becb22bb\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6d7fb0484bd04a35\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f9a9afcb7c710e05\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0b046133905c1666\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"09ff30a92a66d114\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e9155a4f556349aa\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"d6419069fa83af55\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"cf27b45d28ea364c\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a080144fcb2c622e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"32077162997d2d59\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"cccc33b13cf64032\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"6b8f74b23ce258ee\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"63e4c2ad4e27f4d6\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"dcb5a718149d7419\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"f6796bad7c8ae745\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"58e7af4caed10264\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"63eb82af30565ec0\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"5f7ae4ad2fd5153e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"71f657d33ccadf29\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d74ffcde57362a17\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"601811c2a0fc680f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"15d3ee725b60a96d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e16bcc3130799dfa\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"686159a3ef3d9c30\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"8bb1517e9020c210\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"fc6d5be949e5536c\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"f6ac299eef0f7a8a\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"ea02f1dda89fed71\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"99212139aabaed6d\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c920d4a81ae88b26\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8628e17dcb7998f0\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"6eae6361495ac6e3\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"cb970dd100a1521b\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8a4cb5d38d353c26\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4c5ba739123bd281\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f16e221394c00f30\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e66323b2b74d7f37\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"73188d1da840dfaa\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"bef5660693371951\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"fc35d078eebdac70\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d159238b87a19850\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"84ffd53c05e805df\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0f63bd00ba4cf85e\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"362265c11a246b10\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ae5864f47bc86bd2\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"45185604e67229c0\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"261738cbcd072e3b\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"ed0bb021abdfd4fa\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"4bf88294a60ee369\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"ff502c6642930546\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"34e7423d1f13e96d\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"cf65ecb7d39b53c4\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"37dea057026e3720\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"da1a0a65b5c05e63\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"b79f18e66bf0125a\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"cbf2b9fdb9332ae9\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"87ddbe0498324902\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"13369379faef1320\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"9ea7d017eb8d063c\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"44377f68b75e62dc\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b1b03cf203b5539c\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"c4e47f2535c41c49\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"c04a2717611b4377\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"aca45d4246126fce\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"b2801419d6c7a2c8\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"bdfa7f25b0179431\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e8b9c383f387c252\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"130d6fb4a4023e18\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"3d6e301cb07e64f8\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"dcf4a603743c27fc\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a3298b7a7a5d4aab\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"85d7db6e2f898e87\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"4cc3ffa06b754722\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"a6d4606a26bdc0ce\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"15b7770f65045a95\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e7f922bd05c8c63f\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"b1749e8aaa497448\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"556701315a8d4f5e\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"6deb391b704da275\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"c70df99fc5d03cd4\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d54ffc270243630b\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"26b14a75fa65925c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"4ac565d7e91bd314\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"91d57a9dc385107f\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"528db5fec3c93da5\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"c1ce2b3f9766d84c\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"227ee656d0770009\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"29d0854c8511e54c\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"2a9b2f0142b9f8f5\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"f2b75b06fec3caff\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"3599e768b2b6c53f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"5215cf2dd2f1a2f9\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"6fac7e47bda6e777\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"1f0921d7125d850b\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"7f0faf8f75037813\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"56c2d592faa5ddb9\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"eedb84c7d4d245d4\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"b2fcadd3644cd71f\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e4c283ce9bec1022\",\"/knowledge-medium/src/plugins/geo/index.js\":\"82c45d2f66a36b89\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"048f95d90473ae74\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"efa83ce440d7257d\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"82bd8e10e4441974\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"060f1a321967fbae\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"63730a63a4aaf78a\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"e60c4b25405ea847\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"444781b4f8bae741\",\"/knowledge-medium/src/plugins/geo/query.js\":\"fc21817775a6a9c8\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"c69ec2846a9ef561\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c7d71049e801f1da\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5f3cf336fef3d91d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ef72e20260282501\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"11f91714a408a476\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6491e524e2994678\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"8950e8bb511feef4\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2f5d068c9c73e447\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"7a26aa03a87a714f\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c65603aea39f8d94\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"88f0746bf6292712\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"4c1ad87715fec950\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"780c228d597719e5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"55a786e74eee8aca\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"8d8278f406cb0280\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"d7352b0062ea47d2\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"9713037527cb9641\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"85481f44ec633ecb\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"b2cdd19702cf6d62\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"8db47a8fd40d2274\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"6f4beeb44dd9b0c6\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"48d18f9db1445b74\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"eaa9649aa397078e\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"c2fcd21dd0303143\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"0fd08dbc008a4556\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"7a0d45a2ccec3a6a\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3d8c8d6c2a0b7bbd\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"00829a40f35a0564\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"1cd4693856f3d45b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"228894bf7a4f8de0\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"5d4debe3bb945e64\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"c2e2e522e79ec00c\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"15ce9afd2124c163\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5ecc0c8a9f85dec1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9692e7d61aa0f59b\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"53f779fdc2aa500f\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"34c39e51d09b5aab\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"d7861d56a2f6fcf0\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"504c2569c9eb60cd\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"b24ed0a5f589b916\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6be95d8a9a88ec79\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"adcf02f27b89a688\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c6cbf7977bfb0844\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"71c798c0c81a7864\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"89358c88704439b6\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"6bdda9d8ca1d6175\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"b0427c489aaef9b0\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"319b18456ea298b6\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"d7d5642735c10a34\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"ab1c49e9681af547\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"ba28a17a0cbc47c0\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"30b57f64fcab22d4\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"bf7132a5e0609099\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"cd3c499250a5247d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"2b6b3feceb6583c5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0b4cf1a4b2e51ab9\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0ee16b88f743b8f3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"15acb7bc6b66bdcb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"2cf60a8ffd81f040\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1c3f9c1b5ee440fb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6e0861f5927dad37\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"23da3a84b7c5cbab\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"0c0897d297acd1ad\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"0e34411508749bf9\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a6ddfc09f7eae00d\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c31f66b6d2af6202\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e955216587664b4d\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"51b1e23563699e11\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"3463d18f23298ea2\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"908f0b8d0ae3c219\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"669b888a714cee36\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"8beed0f61bcfb6f8\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"a36683659c82d1ce\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"134ba5af82746bce\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"946108d47954993d\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"6feab963ecc16e11\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"46a0e74bc9081488\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"8251aee3a5a74ef3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"7a5ed6643c5f4566\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"757d89a4edc07aad\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d6141366f224e066\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"bad87c984b637c32\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"9763182f5b19a712\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"97c56ef30d28a4e8\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"a8062cc2c87b9bf8\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f6367bfae05b0b1c\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"eaa96edb0ecf367b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"bff96116d22c0b5e\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"a68de438ccd69588\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"be9c8dd894d317a6\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e57475ea3440b91a\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"1ed5eca317014443\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f4c8d339fb930fd4\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"44558795741e53f2\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2a0df68b22b6b578\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"216d04bb4bba32e6\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"3a5e073d1f2526ac\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b3e4be8fec29de28\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"d549aa6673cc54f3\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"4c569c50a76f1137\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"db2aa551021bca81\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"fc4556c2aa77d1d3\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"6c716e75aa002f51\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9200e9b5b3d4aec6\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"c9214ea4949949a2\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"b9c29f813d407b85\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"d81690517e39bec1\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"63e0339b5d267c36\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"4e1a1aa81a551f6a\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"40e7d048030efc17\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"31ae9b257a1b3819\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"8acde28a784b9651\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"281e9970df663a7b\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"0417fe490b60596f\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"ddaf51b8ebbc7a20\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"1e7a03e957d1e5cb\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"84985cc611328a6a\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"9251e40a67fa9c0f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"eaee8907e9db0802\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"38037d59dbfbee18\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"07fd579ed8758a83\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"aaf60f99916fa3a3\",\"/knowledge-medium/src/plugins/recents/index.js\":\"52f558b114cbe43f\",\"/knowledge-medium/src/plugins/recents/target.js\":\"ce2b7958119b837a\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"59c69e9d005258c0\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"f96fd1e782e77bb0\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"ca5274c13cf5252e\",\"/knowledge-medium/src/plugins/references/index.js\":\"bcfd6714c13eb113\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6030342dd916939c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"f140b65189a29ef6\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"165c1c3e5a383745\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"6c814eecfebec3fb\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"55193da2ae13d292\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"6bfc50a4e7f33f4b\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"76765195edff8043\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"72772dd913695b20\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7c482e022eccc66b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"e76ccd90e403780e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3a162e8ed3eebb57\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bb0ce795230bbaa9\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"7b5262353a5c789e\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"7cd3ab0ff9f2c366\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"326493b48cfe4044\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"0252ae80d715ca70\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"18f396e5b31d3e61\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"05531d54c954f823\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"5e7e671a83f7eaff\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"090c763660b145db\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"c584c1e126e69991\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"96c32983e73cc248\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"55e26b1905d3a39e\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"3f141ad6ac619a78\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"a181c4df9ff4257e\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"4ac7195e08a02551\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"d35b7bd2c9e80377\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"d2a05afa83c5dff4\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"fba60139991d2ed5\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"71e52ad02b438d62\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"ceb10803bfa1eac9\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"a992417a230c3c3f\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"e3839a8ac49ee44b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"7f7cdcb012250566\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"d3785cce228ea5a6\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"12b67a6391eb00d3\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"affd71908527461b\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"a4adf0f8a930ee1a\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"34c96a5ec1d3a9ae\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"8ed72b23f06f0378\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"00eda99c7d9391fe\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"184d1068927a31aa\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"194cdf206a1d96b6\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"2cc65cacbf183a96\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ac566aa1487d968b\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"30649234199d1ef1\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0b519fe9368a484f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"6492a1f50541aa18\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a01d821169abf1c0\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"a4d1bedaf7c2b225\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"55a2a473cb2ba9a2\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c145938497e33e52\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"0d56f038fbf64839\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c4e88de8c25de166\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0bf3265071e9d983\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"76a19318f297c4a8\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"c6b517ebc5c11865\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"55f5b943a8ce647b\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"19b49aeaf38ad0ec\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"74a39b08c95b24eb\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"b282fc09454b6f75\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"8032327c6a9a4ef1\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"23aee50baa204d67\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"2f7a4ba87906660b\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9d1312a9b22b5a61\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8a11b3831b116d91\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"bc2c018ebe8591a3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e4a44ceeb84a922d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b4e4ea44374140b6\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"54ddf59cf71a45c3\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fde512b0bd42c143\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"2b87b60cf08a0350\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"2b72d3d5c6fe3ca5\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"53a5c5d447b488b1\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"d8bcce861d744034\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"ba77cc488f02447d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"49e6bfca4e8e6fa0\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"92544f7783b89b94\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"d5e792d6b393315a\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"1c646d3d13262851\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"ebb4b399116f6623\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"d1e0fb3180c46b10\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"2fd598f77666a7bf\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"1c0caf2e9f1fb8b0\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"a65124d049922452\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"6c44f8a924cf8329\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"a45b257221e98ab3\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"7e0fd7d992bff608\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5595ab6f1e81be5c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"ca457ea6b0d08e17\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"333c1a8c752a6b4a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"caae684c0e0d767b\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"08792d734609ac66\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a70a032b855a80d4\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"7a4e247d741c5212\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"d6de3b129947c830\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"94bfafc1a567b130\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ebde6cc58be95022\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"c647c329b4534aee\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"a979bf18fe9e7118\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e8b13c34d5b66372\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"1f1e9277a37ba601\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f47e5bba5ce5f6d7\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d59520c3fb6718cb\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"c9dec279f17c7eb1\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"1cfe2f883bc63c40\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e46be67c7eb9141e\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"40db59f2bc5b2410\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"99eb07f4e7446698\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"87d1f56f94caac81\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"082d910116fbade2\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"ff8ee5998f637d0a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"126af741e35d0e37\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"4a128c5a0737facc\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"f8f153b1f2b03a3a\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"e28a258b0f4da0ba\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"002652ff1bee9aca\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"a2ba03d35f45bf9c\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"421bce78f15368c7\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"9164298f45150008\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"b1be26a81cf0e52f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"393755e877573a02\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"252bbc9ef49848af\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"0c94f4a0603409b2\",\"/knowledge-medium/src/plugins/tables/index.js\":\"a1d43c15b629d109\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"8bdf77b0a35bfcc5\",\"/knowledge-medium/src/plugins/tables/model.js\":\"5892edb1d022d910\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"e3918ad1d1b01093\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"e446e5bc6d64026f\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"ea2738fea3fd11d5\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ae7863d41f4fe551\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"c54d01783cfe0b56\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"cc6b6b23903fc1c9\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"f7ea134c49146c10\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"7de6b46a1f8ac033\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"91bd57e64516f53d\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"69b57a47145aa929\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"345a5a4f3a3080b0\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"efe9e06753ccd280\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"60d97c386382a8fb\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"728750da3a316e31\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"4caf548b0c82c2ef\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5a8c78d2822c7eaf\",\"/knowledge-medium/src/plugins/todo/index.js\":\"37ac48d26988230b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"884571b4455b80fb\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c9cbb45ea5a6aca7\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"c1b87597303727c7\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e3ad8b674b8fdd98\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"9d52ea67f0ea95ab\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"dfc53283c7e8eebf\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b56ba3d58071fc17\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"4c6049303e7c54fd\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"8370ef303dd1ea71\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"bd09fba7a887de2c\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"17701bfb4d4838c1\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"9b31966c41e6a6ac\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"e691dd849ea0bc98\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"0a5c14cffac3d6df\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"9d7d4c5957b5e87e\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"ee905dc5e255c3e5\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"6031262759b1eec9\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e5c6915e2f21100d\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"7e94ef1867762151\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f830677ba964e01c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"de5a4f19437b4e61\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"46e7e967d2e3ccd5\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"f13ad51fc4e1af96\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"b24a9a36779ede1d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"270a33308ed07d49\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"94383e0147145c16\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"e2b0127367560adf\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"594565064553115b\",\"/knowledge-medium/src/registerServiceWorker.js\":\"d9cda0ea59ee221f\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"d525ebbd40f676bd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"e225c2a97fa5de7c\",\"/knowledge-medium/src/services/authStorage.js\":\"965166724bba378c\",\"/knowledge-medium/src/services/powersync.js\":\"a459d6b8dc44f2be\",\"/knowledge-medium/src/services/supabase.js\":\"90a5794ddaef9e8e\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"1e2671b08b636faf\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"309b80a374d5553c\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"7a8de2925e6c6f33\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"a934fda52bee6efe\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"813f2e927ab664fd\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"85ea0191c0aa9b7f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"06286924cb57370f\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"9b4284329ed3f50b\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"991e955bd192f2b7\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"85922ec1f80542f7\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"7ae50e738df58c6f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"d5dad1855f6c2757\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"ea8b9e466a9239c8\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"01c0fcfb44ee2b72\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"7450f83d3364b2a0\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"c782cb53865febe4\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"556212f85f8caa14\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"adb248cfb8379093\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"35f2bddd0dcc450e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"ee26de2aeee934f8\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"9f858fe3c7a933cf\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"c32ec485fabec50a\",\"/knowledge-medium/src/shortcuts/types.js\":\"528f604a7f6479b4\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"626c6261b88000f2\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"ae9284228445121d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"dab950d0293462b3\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"8a99875c0ba7bfae\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"0bb3398e4930e551\",\"/knowledge-medium/src/sync/byteTransform.js\":\"081cf88eb42ca5ee\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"598c868c39b0be17\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"76cfdcf8e335720f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"8f6dd4fdbb57e1af\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"f3f0eaf4c443d0ae\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"80f774051889ec63\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"b62ba4d0235ae09e\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"e8344f0d9ffdfe01\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"e4a9a924bec069b8\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9b2f7ca51b052773\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"7d90aeda0a108211\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"5ce6f2d81f59bf18\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"89ca07fba5b1c3f9\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"ab58132638cc1eb7\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"dee2d9f306babba7\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"b097a216eb7c4d33\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"0fdc73c8f046bad3\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"3c1de21524dcb7ef\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"2d7e61db58dcf260\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"dda401068b96aa4a\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"125339a8cfa4c0f8\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"6f40fb9cef30dc10\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"6ddcd049491ee7d8\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"13bd263c52c1c434\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"50a61f4f1b82e252\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"3b174c66495fb3a5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"eb06529ab3325048\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"878f88aafb901056\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"92ae5bb250011be2\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"2ca7143dba778e4d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"9d9ee603b1e14fbf\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"ec2f9e2f722fae22\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1fd176d89a488444\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"6013d317947f765d\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"b9844031f5e19a38\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"f1987b0dc0860074\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"b1577f10f5f18552\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"20a42cd5560558f8\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"20eb63fe3fd67ab4\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"69feb09694cd5881\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5fdd20eec5bd2fac\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"6a7549fcb883af75\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"3e12cabee920e5e9\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"9c8bee09dc0540b4\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"0babe5c0b551ba5a\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"fcbfa2a77b49e3dc\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"22dd967baa4527f8\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"554b94a8dbd9f0e5\",\"/knowledge-medium/src/sync/transform.js\":\"8577be88c1f3e449\",\"/knowledge-medium/src/themeBootDefaults.js\":\"5d143b679d21eab1\",\"/knowledge-medium/src/types.js\":\"1a3b0bba1c9d7f26\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"359f024b8096b582\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"6e1f3ab744a19a96\",\"/knowledge-medium/src/utils/array.js\":\"c5c87247a2d7d8da\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"d0998dbe80c038f7\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"9251ca132069f78f\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"11371f7cfaf5a66f\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"fe385a976ded3f35\",\"/knowledge-medium/src/utils/callbackSet.js\":\"4d3f75ac71b263f9\",\"/knowledge-medium/src/utils/clientId.js\":\"ca269b7dd53cf58b\",\"/knowledge-medium/src/utils/codemirror.js\":\"71be244f7a3ee0cf\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"ec30401d39b51c5c\",\"/knowledge-medium/src/utils/copy.js\":\"ce0291e3e33e2e65\",\"/knowledge-medium/src/utils/dailyPage.js\":\"6769d8215575906a\",\"/knowledge-medium/src/utils/dbForensics.js\":\"4caf4e963fb65104\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"b6f55eeab23403bc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"eacca0146b65fccc\",\"/knowledge-medium/src/utils/dialogs.js\":\"58f01e7c536e3633\",\"/knowledge-medium/src/utils/dom.js\":\"1b81616ada4ab868\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"9993fed3f3b6bc10\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"548d8372b285ff3f\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"f3e6242162d254d8\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"4a5e08b5bb953391\",\"/knowledge-medium/src/utils/flipSlide.js\":\"ed505c3b4c15c9ae\",\"/knowledge-medium/src/utils/fnv1a.js\":\"29ce385ba8160cf4\",\"/knowledge-medium/src/utils/formatBytes.js\":\"173245432cfebc2a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"c3c928c80ab72e0c\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"2c70210179cb28a5\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"235ca214cfbff1a5\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f61ec9edab27b7ab\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"296cd3d57ae9135d\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"fd8358289253c9aa\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"2530af36f0b5fa50\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"429f5f03f5d0fec3\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"98a9ae417dd32dfa\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f87d4ef873b1ec66\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"7e7d16c61cadf9a6\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"300672642668077c\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"5f4d16ebeff8ee45\",\"/knowledge-medium/src/utils/markdownParser.js\":\"4e4b54c98b9a0fdf\",\"/knowledge-medium/src/utils/memoize.js\":\"0a881ee7fe2d97b7\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3482be591473bc1d\",\"/knowledge-medium/src/utils/nameList.js\":\"b0b5cf490a355365\",\"/knowledge-medium/src/utils/navigation.js\":\"4042a8ffd5d43569\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"36757e0053b82988\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"b0686a790aaa3ba6\",\"/knowledge-medium/src/utils/panelClearance.js\":\"d027a27cd1db34e2\",\"/knowledge-medium/src/utils/panelHistory.js\":\"67e18d1dee2408ba\",\"/knowledge-medium/src/utils/panelLanes.js\":\"49bfbf917912b57d\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"3ab2bcc8a6a735c0\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d8aaa7578ef2fe3d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"caaa0198cdfd75ae\",\"/knowledge-medium/src/utils/platform.js\":\"7752d8b35842aaf2\",\"/knowledge-medium/src/utils/pluralize.js\":\"daaf818a1623ffa2\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"34dad3596335a613\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"93db88539b49dfee\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"310e5cc1ebeb1c89\",\"/knowledge-medium/src/utils/react.js\":\"b79d76b793fe935e\",\"/knowledge-medium/src/utils/relativeDate.js\":\"34d7f260c348c8ba\",\"/knowledge-medium/src/utils/relativeTime.js\":\"f94030dcd9a41bd5\",\"/knowledge-medium/src/utils/renderScope.js\":\"eac52f0b96755eda\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"3bac0afc0ff912a0\",\"/knowledge-medium/src/utils/routing.js\":\"640803759cfcc530\",\"/knowledge-medium/src/utils/safeMode.js\":\"0485f3df1d5fd181\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"5073ae5f04304ec6\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"113a190bbb1d04cd\",\"/knowledge-medium/src/utils/selection.js\":\"a46efe983b7f89a6\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"5abeec0305135585\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"85b69a5e0f167009\",\"/knowledge-medium/src/utils/state.js\":\"f5a9331cc79d59c4\",\"/knowledge-medium/src/utils/string.js\":\"6365aa7d77c10adf\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"e6af003ef2d9bdfe\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"b59860bf15847028\",\"/knowledge-medium/src/utils/toast.js\":\"0a0b4a16ce785622\",\"/knowledge-medium/src/utils/toggleStore.js\":\"495801162c6ca3df\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"cb7e822f706b5fa2\",\"/knowledge-medium/src/utils/userActivity.js\":\"92889ed07fbd2f0b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"26417a116a4f228b\",\"/knowledge-medium/src/utils/viewport.js\":\"faf3612054084d1d\",\"/knowledge-medium/src/utils/webLock.js\":\"56eb3816d28fedff\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"ecf1594310427b0e\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"4b18afe630c7eaab\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"44be59316f11dfdc\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"311f789ddace4e48\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"bee1cd7092a5d000\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"ca7c5db2e81fb3e6\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2209453b97bbd6c0\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"2394614ecab4d511\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"0dce2d88e68c2223\",\"/knowledge-medium/src/vendor/react-dom.js\":\"9439930e16ad6d44\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4e27e45927c924cc\",\"/knowledge-medium/src/vendor/react.js\":\"0c97bcecb6cde64d\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
	}, {
		caches,
		fetch,
		origin: self.location.origin,
		now: () => Date.now(),
		storage: navigator.storage,
		indexedDB,
		mark,
		bootStore: /AppleWebKit/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent) ? idbBootStore() : void 0
	});
	self.addEventListener("install", (event) => {
		event.waitUntil(sw.install());
		self.skipWaiting();
	});
	self.addEventListener("activate", (event) => {
		event.waitUntil(sw.activate());
	});
	self.addEventListener("message", (event) => {
		if (event.data === "SKIP_WAITING") self.skipWaiting();
		if (event.data === "BOOT_MARKS") event.ports[0]?.postMessage(bootMarks);
	});
	self.addEventListener("fetch", (event) => {
		const response = sw.handleFetch(event.request, (p) => event.waitUntil(p));
		if (response && event.request.mode === "navigate" && !bootMarks.firstNavReceivedAt) {
			mark("firstNavReceivedAt");
			response.then(() => mark("firstNavAnsweredAt"), () => {});
		}
		if (response) event.respondWith(response);
	});
	mark("evaluatedAt");
})();
