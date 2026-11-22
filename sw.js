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
		buildId: "91b9768c3590-82f6a414",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d8caa6acbb46b20f\",\"/knowledge-medium/index.html\":\"d8caa6acbb46b20f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-PoOtsjvq.js\":\"b73d8846031137a0\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"ab634ecf62984b91\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CPVcf2v9.js\":\"97d0623ae40256a3\",\"/knowledge-medium/chunks/FacadeVFS-5PPYh45T.js\":\"e97225c3ae586950\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BCrY7IHp.js\":\"ea9ce79bc6e0154f\",\"/knowledge-medium/chunks/MemoryVFS-Drhdiv9n.js\":\"f3af17d02a9d9be3\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-D5vN4F_i.js\":\"3269851fa67c25a7\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CQev7YZw.js\":\"1f3c3e807b7ed1f7\",\"/knowledge-medium/chunks/Preview-N12Dkc33.js\":\"9dd9755039bfc785\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-1HpPbV7q.js\":\"6b7267920fcb50d4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DBMWIDOv.js\":\"c628c0968891a803\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BTIVYhBD.js\":\"33b85a687439027c\",\"/knowledge-medium/chunks/react-BZXvuCCc.js\":\"b8fd2fbd3db4abc6\",\"/knowledge-medium/chunks/react-CByckLcN.js\":\"d4f6668229d98d0b\",\"/knowledge-medium/chunks/react-DW_90taA.js\":\"a9210b4e02db112d\",\"/knowledge-medium/chunks/react-DuVkw_dq.js\":\"80d25e3f1fc1bc22\",\"/knowledge-medium/chunks/react-DvLi4if8.js\":\"de3f0bc124809715\",\"/knowledge-medium/chunks/react-Dz5qs5nT.js\":\"06f1bbdc82abc30a\",\"/knowledge-medium/chunks/react-P9xLQjXb.js\":\"7ad562581f4a9dd7\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-COz_C28j.js\":\"069b2040a221e6b4\",\"/knowledge-medium/chunks/react-dom-server.browser.production-D1U_2buW.js\":\"7c25e4d351f8fed5\",\"/knowledge-medium/chunks/react-dom-server.edge.production-LF4K2GH9.js\":\"2e335ed20dc07530\",\"/knowledge-medium/chunks/server.browser-CZ45yGQD.js\":\"2a3cb8911cebcfba\",\"/knowledge-medium/chunks/textarea-CqjVPxyf.js\":\"cfcfdef75b025dd8\",\"/knowledge-medium/chunks/ui-Cfh6uiKh.js\":\"7a7050f7bcc24183\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"4934085d8df68406\",\"/knowledge-medium/src/appUpdate.js\":\"d816dd276cfbfed1\",\"/knowledge-medium/src/appVersion.js\":\"e546173217072e1c\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"0b45398394a43a95\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"e65ef062ea379a64\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"df1d26d417c69a01\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"c1a597a5809e49b9\",\"/knowledge-medium/src/components/BlockComponent.js\":\"2687a7a767ca8c1d\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"13fb6146b742e488\",\"/knowledge-medium/src/components/BlockEditor.js\":\"cfdcbaf9c0a47d4e\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"fe14303a6b9a95d7\",\"/knowledge-medium/src/components/BlockProperties.js\":\"8e000b578fd97154\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"715e6c2696ea9c42\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"73e74eaf5f04aad3\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a2bb13ab0ad069ba\",\"/knowledge-medium/src/components/DraftEditor.js\":\"7c28d5fd14e8758c\",\"/knowledge-medium/src/components/GutterPill.js\":\"77b3a6e708619519\",\"/knowledge-medium/src/components/Header.js\":\"6d80e9ae74c93508\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"29b5c08e8fbbedf2\",\"/knowledge-medium/src/components/Login.js\":\"2e3f7443708960b1\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"cfb1d842d6c1dd4f\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"ca2abd606f27abb2\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fd34abe54872941a\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a70bee521665ef2d\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"0084ef75bdc515bb\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"a2573636092ec77a\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"fe3d5ad11ef3e674\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"1f90787b5f34e1d7\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"1623106daae9e964\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"ad3f5a35689b1d1f\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"8da10c210efb3855\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"3f95328f0264116e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"9fd06d89cebab813\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"f17daa4dff073a1d\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"92a5ad049b8d5619\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"1f3e0fa3318efde9\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"aa598ec7c9a45c7a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0f79e940c7e747f6\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"de826e3478f5d532\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"0a1470e7de4b65e4\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"38c7085de59c6f98\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"b32cd6a3910c527a\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e95bfa504bc4f32b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"87123660615610a6\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"08cd53da8696ae1d\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"f4d4a5fda90250bb\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"bbf5dfcb7f0d9f16\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"898792faf2ebc05c\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"7e7a50023c829b9e\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"8cf3eadac24c24ae\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"7fed3c290074133c\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"2f28fd122806681c\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"5ff9331b90bac5fd\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"79d9119210dc118a\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c3c0f1dcdcca98d3\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"657decf568004ddd\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"958439dc49763450\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"cb4343b4c5e21605\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"5e27c0febf16417e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fea78cd40183e507\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"a98c57b8e874daa6\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"195fb7e3ef333ccd\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"504f809efe54c30c\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"cba74e404cf7c8b6\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"624f8f9a435f3d4b\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"085f01c99ac13d0c\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"e3b2e91b97ce6fad\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f9f3bda5ccdda9b0\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"f3e1886f7a5c10c8\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"34536dd2fe7171af\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"f148f2f06c8332bd\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"c2e362f4067748c0\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"02f153e0f2a268c3\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"9a8eafd7e5e42723\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"dcf63e37d51ca8f1\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"a8bf5a6be98dd289\",\"/knowledge-medium/src/components/ui/button.js\":\"a9291c5d1203afb8\",\"/knowledge-medium/src/components/ui/card.js\":\"fb0688470f26b85a\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"defe3bbc5a316422\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"0e913303dbfb7eb6\",\"/knowledge-medium/src/components/ui/command.js\":\"579b371595012abc\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"edcc2f03d999e7d7\",\"/knowledge-medium/src/components/ui/dialog.js\":\"032d80f315f65ba3\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"98bd38bb7d2fb7b5\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"08974dbab5956d0b\",\"/knowledge-medium/src/components/ui/index.js\":\"433f91ffe59b515e\",\"/knowledge-medium/src/components/ui/input.js\":\"e9d65ba75025d645\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e3cbeee34618bd94\",\"/knowledge-medium/src/components/ui/label.js\":\"fb3a54df5e122c48\",\"/knowledge-medium/src/components/ui/textarea.js\":\"044bfb026b32aee0\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f84cd8909cf22f6b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"df82e35e7f37f6b4\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"dbded2c1444e05cc\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"61bc8880572381bf\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"ff6339c57c020994\",\"/knowledge-medium/src/components/util/error.js\":\"77beca8c70637f5b\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"8fd58f21aa18e893\",\"/knowledge-medium/src/components/util/suspense.js\":\"530a81b6430443be\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"b75dac308a70b710\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"4dbff8664a5773c3\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"c6783dde1ddca406\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"9022cc27d492ce39\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"e3a2044a28558cb4\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"2896c001d657223b\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"a17384365e4f8551\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"003eb1ec8305daf3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"1c67f25f6d266c2a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"0b341c04c188f2d4\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"2f2a1b17146815ce\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"6cc955790b3d9b36\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4eab080d1806d1ac\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"a10a9fcbc6e00135\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"76b05f804acb00d3\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"fea7d1bfb1de4630\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"a55d7c5a61eec8f6\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"7104aee3daa9a353\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"9bbd12ef2ff88cc3\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f32cd33ff604f721\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b2ed18351ffd6458\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"5048152c6d4d4ff7\",\"/knowledge-medium/src/context/block.js\":\"20e00357daa482e9\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"b6c5229a82386fca\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"592248532e9b76bb\",\"/knowledge-medium/src/context/repo.js\":\"6fb857ee136a296b\",\"/knowledge-medium/src/data/aliasClaim.js\":\"874d368e66a1490b\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"858cdc9bea6cb92b\",\"/knowledge-medium/src/data/api/blockData.js\":\"672618bfd844ed3f\",\"/knowledge-medium/src/data/api/blockType.js\":\"990d033f8aab616e\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d60aa5e2fa27532b\",\"/knowledge-medium/src/data/api/codecs.js\":\"1a5553646d203f7d\",\"/knowledge-medium/src/data/api/derivedData.js\":\"2bffccf579f1c4b0\",\"/knowledge-medium/src/data/api/errors.js\":\"28cf3c277b8e59b9\",\"/knowledge-medium/src/data/api/events.js\":\"d11da337eef3f944\",\"/knowledge-medium/src/data/api/handle.js\":\"52fb92346c7e8fb3\",\"/knowledge-medium/src/data/api/index.js\":\"04f75bfaea7c3359\",\"/knowledge-medium/src/data/api/mutator.js\":\"d9b9d61fc8a3763f\",\"/knowledge-medium/src/data/api/processor.js\":\"d5e660deb3c9afad\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"c488acf61f8148b0\",\"/knowledge-medium/src/data/api/query.js\":\"e102fd7215897e1d\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"7fd67aea1aebee14\",\"/knowledge-medium/src/data/api/schema.js\":\"52fb92346c7e8fb3\",\"/knowledge-medium/src/data/api/tx.js\":\"52fb92346c7e8fb3\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"a74979768cfef167\",\"/knowledge-medium/src/data/api/user.js\":\"9f174471d51463d9\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"6ba351b5f68c3f8e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e7a64108ac1a1610\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"163ea3606becde09\",\"/knowledge-medium/src/data/block.js\":\"41fa9aeb6c8c129c\",\"/knowledge-medium/src/data/blockCache.js\":\"ae65c6e4f359c69c\",\"/knowledge-medium/src/data/blockId.js\":\"6baa9482254ef836\",\"/knowledge-medium/src/data/blockLiveness.js\":\"8c460dee59b96e85\",\"/knowledge-medium/src/data/blockMerge.js\":\"d840bf712ec0f86c\",\"/knowledge-medium/src/data/blockSchema.js\":\"6ff0eed82d895c53\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"184a3736bc216bd4\",\"/knowledge-medium/src/data/blockTypes.js\":\"b8b906f9e14ee4ab\",\"/knowledge-medium/src/data/clientContext.js\":\"d5542477207d0525\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"991b216f5a661c66\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"ae438dc75e68f5c3\",\"/knowledge-medium/src/data/derivedIds.js\":\"13123c5744b8ec1d\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"917c39b65f643636\",\"/knowledge-medium/src/data/facetBridge.js\":\"5fed8939e2f2c3b6\",\"/knowledge-medium/src/data/facets.js\":\"96a8c38cc67dae4a\",\"/knowledge-medium/src/data/globalState.js\":\"87fe5214a5262079\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"306903767227d198\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"351a6f0375f04315\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"fbf77337d91c0470\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"7d5e55b592f371a8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"9c8c443cce667e38\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"1c7be5be810eca5c\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"f4c08387a75deb73\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"70a4c0e37cab6cb3\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"9d9a061094480aec\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"5aa06d1a5ee67041\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"cf849984fceb79ab\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"e4910595b797b9b9\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"3712df9c2470f6df\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"aa9b762c29b412bc\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"946ebcbd09973ad3\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"afa5df086718e836\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"d9a393c026cbd39d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"3b98460bf049acd3\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"82acc8071dcc7ecf\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"014ca4a782d0f395\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"f3118ea6ca090a27\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"58dd1f64b56af025\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"95c779399beb6bc5\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"4724891d02479107\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"aaa08647e7472b01\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"2710398f1a5e4845\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"84e11f3ff9e68626\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"4ef13204664944ca\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"0c0fa1801227afb7\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"4ab820f0c18f52f4\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"f1667ee33b0da903\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"741ac3d58a3b2e00\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"ea888797e768b729\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"8c1f38a9886be1e8\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d9ebbc10d976a42e\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"531ed93dfff7664c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"af2b116c7a66b6d6\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"548748528f055e35\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"7d2c649d8492a436\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"dd0b692d5c6c14fe\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f1748c0d2bcc3256\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"aa7b1925083a0b5c\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"2ba76ef579869aa9\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"858522138794b904\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"08ffd187ac201095\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"3490456933eb2042\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"3e9de44bf2a5203a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"7f3d0736ffe5a8e6\",\"/knowledge-medium/src/data/invalidation.js\":\"bdad011336a61bc1\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"297a3f35e2d23576\",\"/knowledge-medium/src/data/kernelPage.js\":\"af87dd5b5b4dc7cf\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"b0ae5a3ff58cfe9f\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"2024ad1647e6d3ff\",\"/knowledge-medium/src/data/localDbStorage.js\":\"e299ad2487c94d32\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6be3e6124c5920f7\",\"/knowledge-medium/src/data/localSchema.js\":\"c61cb0de829fbbec\",\"/knowledge-medium/src/data/maintenance.js\":\"57cf11c3c4958ac7\",\"/knowledge-medium/src/data/mergeProperties.js\":\"aeb1efa9c5c417f6\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"94022dbaa92c1148\",\"/knowledge-medium/src/data/migrationsPage.js\":\"a52add34edf60fb9\",\"/knowledge-medium/src/data/mutators.js\":\"a9c086a2ec92fe1d\",\"/knowledge-medium/src/data/orderKey.js\":\"e525a2fd5760012a\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"5dcc5ac84f3a8476\",\"/knowledge-medium/src/data/outlineSurface.js\":\"bcc40eff6dd9a6b0\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"fd49ebc49b752eb8\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"532c993d56fd8e10\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"dbf6fd9c9ae0012f\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"ccb395b985d8e2af\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"16e525d4c7cf5429\",\"/knowledge-medium/src/data/properties.js\":\"567b340cba958aee\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f48aea4adc16b09f\",\"/knowledge-medium/src/data/propertyChildren.js\":\"9b6aec2f8dc85a89\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"4d5e69fe6f18a6a3\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"08596e700d103562\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1bc9fe87b3d3c24d\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"50e0134648fa9dea\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"6e97f5ee1bac3df6\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"8342d61667fcdcc8\",\"/knowledge-medium/src/data/propertySeeds.js\":\"bc4a3d493264afda\",\"/knowledge-medium/src/data/recentsPage.js\":\"6a6962456aca67a3\",\"/knowledge-medium/src/data/referenceBlock.js\":\"ea5ae407ecc47f66\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"a7866cc60a5e7a19\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"8809711c9b31d218\",\"/knowledge-medium/src/data/repo.js\":\"e517cfc07301ff14\",\"/knowledge-medium/src/data/repoProvider.js\":\"29be7c21d6a9fd11\",\"/knowledge-medium/src/data/rowProperty.js\":\"54bbf73254c649b5\",\"/knowledge-medium/src/data/searchFilter.js\":\"f2d57b2f3cc54073\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d0a64c3c71b10244\",\"/knowledge-medium/src/data/stateBlocks.js\":\"949b53b94aa1ca84\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"f95e09aab07b6713\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ecce65dd12f650c4\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"7264747fffefe136\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"aff56b9b671cae94\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"ee3f9a3de89d2972\",\"/knowledge-medium/src/data/targets.js\":\"b03ed7f37c71690d\",\"/knowledge-medium/src/data/typeColors.js\":\"84202d981c5e0e18\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"40a7fa6f2ac1df21\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"1a2a390e51886cf6\",\"/knowledge-medium/src/data/typeExtraction.js\":\"7c8aa310b7bbcd9d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"4432c000f42157fb\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"01c5208dc5d40c90\",\"/knowledge-medium/src/data/typeSeeds.js\":\"7a0b973632949bce\",\"/knowledge-medium/src/data/typeTagger.js\":\"7534ba2429b46077\",\"/knowledge-medium/src/data/typedRecords.js\":\"51a3e671e88c8534\",\"/knowledge-medium/src/data/typesPage.js\":\"2aa0b9d9d2847bd7\",\"/knowledge-medium/src/data/userPrefs.js\":\"1a877d91655c85f8\",\"/knowledge-medium/src/data/userSchemasService.js\":\"63b566e645873983\",\"/knowledge-medium/src/data/userTypesService.js\":\"5e2bc4274e710693\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"bc5cb47a619f5274\",\"/knowledge-medium/src/data/visibleChildren.js\":\"abc32eb384996e8a\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"00b1ad19368e57b5\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"082aa9b4bda39e5d\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"42acbf086a4ae7ad\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"4ad4cbdb30a6852f\",\"/knowledge-medium/src/data/workspaces.js\":\"13a21d61c4181ae5\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"1bcef2e0e073fe9b\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"17fabf314be2943c\",\"/knowledge-medium/src/editor/atTrigger.js\":\"795148bd751835ce\",\"/knowledge-medium/src/editor/autocomplete.js\":\"0488ee575f878058\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a234cb43bceb0219\",\"/knowledge-medium/src/editor/contentFlush.js\":\"782596da4de1a755\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"2b7b3e76dee96bd5\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"bd8a7f1ee4a0c5c9\",\"/knowledge-medium/src/editor/insertImage.js\":\"ee9a5dc5d7c915a9\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"95e467aa5b8702dd\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"262aa2eb1b829c8a\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"70b730c6e2f23dd8\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"3d3e804c24fa512c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"d338c3af02190d35\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"ebec011bd1cdaaa4\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"5f8467efae755cf4\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"65003afeac0735fd\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6d80629225cb6b7b\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"7f91c2ec58db8cb5\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"f139227c9c3a65e6\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"32fba688a664727c\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"e3901190f1bf0aea\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"8b26a93e998f5524\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"be4b1bdfda51f859\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"99d621eaeea56050\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"386f56cfcb39c3ce\",\"/knowledge-medium/src/extensions/core.js\":\"73b03e932be4fdee\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"8700c7dffea5267f\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"1bae5ae3e861a1da\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d8edd6ac5b610207\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"df7fcf5b6900dc7d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"0a2d582143762641\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"b62e9ade5e4232b0\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"82a7bcec207ca4c0\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"051b3bab75aa63b6\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"62c0770889eb4b69\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"6d5a173588f501f8\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"082d20442adeceb3\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"903f1acdd63df3f1\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"84f4ec15dcbe11e9\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a5bec58b5db8a931\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"0fdef35c91aebf35\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"beca2959a02b6f9e\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"7fe5a74efee0eae6\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"4569fed19f1f39e8\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"2d8dd075ffdf73e7\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"417e20a127f32de5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3bac5f44fd5cb573\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"99b692f9757ea708\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"9a0279cd2c1bc449\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"f1c499477a77cf49\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a63d4f0feaa4345d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"afe1770a57fdd8ae\",\"/knowledge-medium/src/facets/facet.js\":\"1bc4edf6743b64ca\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"35dd3ad2ffcc762d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"e5e007d799f4eb10\",\"/knowledge-medium/src/facets/togglable.js\":\"fcef2069e23ac763\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3ecc99b8f153ee9e\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ae622b98fff4ac36\",\"/knowledge-medium/src/hooks/block.js\":\"5793873787a7b9c1\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1ccdc8de8766b1a9\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"d834336275f36e45\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"b1c28b10ec1b8d02\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"220e7f7fbe61728f\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e3083871ab0075d4\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"b40a9ca890b79538\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"cf477a50e95cb736\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"7e9d27968a2bafe6\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"edb67da4912d5957\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"f8c117425abcd847\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"0d1c1bae5531546d\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"cec66c90c058b75f\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4b549c626b2488a8\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"6bac08a4a7da57d6\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"bbee8002a569078f\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"97d61cb1ba966639\",\"/knowledge-medium/src/lib/utils.js\":\"5253ea04792d9680\",\"/knowledge-medium/src/main.js\":\"3766e0ff95b40b47\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c46e8e0ca46f67bc\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"7aaad208445f4c5d\",\"/knowledge-medium/src/markdown/context.js\":\"ac75f585a79cfd67\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"eb9d4422ea8b0d41\",\"/knowledge-medium/src/markdown/extensions.js\":\"ed66f7a6e88076ed\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"ea8deaf9a84630ba\",\"/knowledge-medium/src/minimal-editor.js\":\"7538ccdb582407cd\",\"/knowledge-medium/src/paste/armedCut.js\":\"1d53944c4d0c2b43\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"92164beeb556fd33\",\"/knowledge-medium/src/paste/clipboard.js\":\"c08d99fc1e07bd1b\",\"/knowledge-medium/src/paste/decision.js\":\"95af51a6909456c7\",\"/knowledge-medium/src/paste/operations.js\":\"b24c8a44d8abcc8e\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"d20dc13cff583642\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"e70d2f100541361f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c18411921347e0ac\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c15946ebc64861dc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3cd56b857beee316\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"354d7edc61c03307\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"ef5e3df1b80b3052\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"113b25cfbe713306\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"a40b60da8545d065\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d397e3cef4f78ad0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"d87f68392b76e809\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c417ed16ae488df2\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6c10d0c8b192e48a\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"db144b2fa51d5383\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ea0bf61b4eefa1df\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"8b8ac8e8c73e4b85\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"6a27af55d37ad441\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f7173a878baf3ea9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"3b5c268eefb0315a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"dcab8843994d1a2d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"55eaa92db92704b5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"11a5365b1e144869\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bee4768c7106a0f4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"9b3fe8df10e28260\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"99b1489fd2555300\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4b9dcdd078c9bfef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"897536c0a37ad50c\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e7d6edd1f89081c1\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"fd386bafbd40d8ae\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"ba7b187921de3316\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"1a3359d3ee316af9\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"9817ad5c22c090af\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"6c8fad3068f01f0b\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ccad6c7280da9a28\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"f26b30329419b8a3\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"f268e88eee45b5ca\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"a1774f0890eaf90a\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"346afdeddae76edf\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"cadff98f0bfad10d\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"2fa04e8fdb9d48ac\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"673b7863ca05c815\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"0948211e61aa8a29\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"64dab67806a8afd1\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"00b44d1c80b8f916\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"7b5f8e1e8d01043a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"1a85c9add66329e0\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"4f70f222422e1a5d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"1f39b353e2bc7062\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"3ce307c9f2275330\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"7e86c96b42015d2f\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"82c6525f958c24fe\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"eccfb32c6113ded0\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"c9c7a2d77b27895e\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"f9043a7dd29443c2\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"2f420d77c847a0be\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d5daab61d01ab4cb\",\"/knowledge-medium/src/plugins/alias/index.js\":\"52cc68ac065b0550\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"9fd768ad3ccbc0bf\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"fa9a5291a0a87208\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"508ab33fafd5c6d0\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"cacaa8219de7fe32\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"168b834cf6d7aba0\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"f76d35a9ece12e5b\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f3ea9020929dfe39\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"ccfa84ab72fdb4ba\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5d752fa480b52357\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"ad3cdc17222d505b\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"8459a3a256310e55\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"571982bea1479556\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"8d9c60a0104f0cea\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"1ea8dfe9b4f97b50\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"aa727b8bcb56e195\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"fa566c26081e9c05\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"0bf4b1f3a4abd598\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"4ff8456de8f0e072\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"e149ebad4168ef34\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"462ad197b4d43849\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"ff138f8f9145dc47\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"f8e491f84cfb9cc3\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b1756fb5bbad08e1\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e59b18626442577d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f28e0b697d0b0d40\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"7a93b99c3045c318\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"b5105139785a823b\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c07bb0cf8c0a3890\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"4c692ff699c6a6cc\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b8612a31dd9d35a7\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"9cec671e37b9f868\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"82971e21f4440638\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"98fe19f1e3ed7193\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0312577f2cdc4728\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"45245d8df8b73a3b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"e5c2edc5c7cb4156\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"b3f98e87f8b8d5d3\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"e97c4a8f74c91fdd\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"a78ae366d1232371\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"e5f74214c8805d1d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6b8118c629996344\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"80c495a5b8112b65\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d52eadd683f61362\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"c3aaafca9ec9bd92\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"88d2cd0127c51a58\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"e78e040a073b4cc1\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c9b5521468e4b146\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cfce494df84dabcb\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f7f74e2e249dfe59\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4dd9661de44f7cc0\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"ac458308256cdc2a\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"8ea7cd36021d06ed\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"69a3716b75be8ce9\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"5819c7d92d92c2b5\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"8d291f3d596f3833\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"03ca73ce2bb341cb\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"2f31ef37f342819d\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"ebcf61867044b784\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"656c675303435cb8\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"fb996fe1841c4c3a\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"e735a3786dd9d5d3\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"b74d0e4d475ea664\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"3b4798754d129a7b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"a804403eb71df288\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"bd74894865deee79\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"e643e7050f533471\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a0a7331ac7bcdcaa\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"8d2eebfc1b17ccb4\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"5384623ea9d7c986\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"cdc120eb21ccdac5\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"275b46fe03fbdfcf\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"1392c7e0547693d8\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"81484818c84c9336\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"8bf0f4312666dbb0\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"17902bd6ee8732de\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"8e34765bc9bfe1ed\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7ce3fb995d400eed\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2f3ba9acd032b2c1\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"3828c4b653c51451\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"75ad12ec88ee30ea\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bcde2e0cff581100\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5c79fea9a39b3093\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"15fc57bc2fe17a88\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"21d8a04c4b2b03f6\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"31543d9083197b92\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"229738983a53c42b\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a345a53a3646f356\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"30fce7819dd37339\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"f5d2da2fbe0ef1a8\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7ee2d061d90a9c27\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8b65c099e35548fd\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"93d07c33dcf259da\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"8c801fef688fcd18\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"a968bcb0c8b5bc2d\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"f9c40316ef9af271\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f9965da760d9cfa1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"5e157ffba095d70c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e17bea9c94daa854\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bb1e0ac301f2eb02\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f133c66fedc9f0af\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9453560941518411\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"75a61a8cf02ac99e\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"cf0d0a745bfb568d\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"e838e0168c96732c\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"d3ca3ff93cbd6e1b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"d5d8a6a9563e0396\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"059cf6261c5dc5cb\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"345cee45491461bf\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"71cb066418abdd9b\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f4c449fdeb7a85d2\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"9a2a279827ccce37\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"89a7b68831e66d05\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"b426ae5ccc539d85\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"4f0ab941ba93419a\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b4381005181ca0bc\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"7bb544996c6ff2d9\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"6f675e3dd642deba\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"87adf4aae65bd92f\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"d28b6467751288ba\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"ee6595cc40c1dd8f\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"2d8b88a5320c0600\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"82a50e0e9fcbed81\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"01c14b2d508ba8f5\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8895b89eedac4176\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"f61cc115dcee8bcd\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"5dd269bc94467e3f\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"2ec42a13d1f95a2a\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"51742ef8703f432a\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"0eed3d6b99f0d370\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"4327fda1f242b7ff\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"f5c961e5ffabe283\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5a69146bd2b4ea8e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d782ac8d4512dd43\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"30172aad433310fe\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e5e0498350f3272e\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ecc2c864d458cb2f\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"67d23bf7892a8f17\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"18fe589c26794cec\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"63175bdc3949373a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0643bd791bf5d972\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"261fd64b971aec3b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"33601d72f8f8417d\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"ecc7b1164c1e17ed\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"17a7d0492c6f7ac7\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"f385e9b8d09c7356\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"aaf03599f52341b3\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"055fed134bbfe974\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"f7aecdc3aa00619f\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"711d342645c0c0c1\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"c4cab3c6db8b72bb\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"81086742c2832c03\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"37288ace50d7bbe9\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ca2c7a8a9e6d603b\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"a1440edc55b50134\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"47e7b8aaf8cf48af\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"8d26740b00af58c7\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"00f9c93ec47ce001\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4ca9aa1e869ce7a4\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"8d00bfe618170a69\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"da6490ef61fd3c07\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"82469989c7c8d91a\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"ef89e4a34cb820e0\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"2d00f7ba730f2400\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7eac8a35479cc757\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"c0b85a7600e51f0e\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a37ca9bcb46280d3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9212f76a9cfc0604\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"fdacba06784831fe\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"6730506878fd984c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c76b5bf55d2e0b48\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a5aef075d3e3270c\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"0ca76b2807f1b6e1\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"b025ee6da5d53be2\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"811ec44c25d07299\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"7acb5533453b41f2\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"0f2088d96688155e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"dd1868ee0864643d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"bbe790a104124582\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d741e23b6791576c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b4ef97077796e5ba\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1f5f3cefbc225c2f\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"c58b1730636ffb26\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"c0f2f980e2192529\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"ecd134f52b966488\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"2cb68ad90cb342bf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"09a487c7c7f749ea\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d8d2f6b14ebf5635\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"97e99ffe2c2913e1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"27837b44f26c6ce4\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"59a88318c5a10518\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"3e146c14e3316240\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"f1b25bcdfe9cc6b8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"b73fc9242f43b8ff\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"12d082c68b8ba402\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"6fc33c758f880e4f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"61e00a4ce83d8023\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a03aad362d4dad38\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"07a5ac83a249b043\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"72c911029de43f88\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7472b1dfb899a912\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"15bb3ca055a56f8c\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"31756d91511535e1\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"69e1b26f6b9acccf\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"4f59a239bcae9a3a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"be017bf5a0f39dd5\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d10d171463e8a823\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"6d3d17a803923853\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d482686f08d01e6d\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f274036c9be75198\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"10c7f4f47396fe08\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"9b3981ec95309a50\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"813ed235c92cbc06\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"f4d7854d220d0f97\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"2d92e120365c1a31\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"e0eaebe7dc1c4827\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bdb655501c493e72\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"7c5f915225e47d07\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5eb0cf9652b2c577\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c6a8b8a61d3b8027\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"30e6e392ad63ac51\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"577943ec60f12590\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"9cbd090790c61ece\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"39c7acc6e39dc8fe\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"71c58d18158fb69e\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"2ba4119ac4f060c3\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"5fa3241462fbe945\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"f5530d4ed76968fb\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"414b53342b368017\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"7f5d941ba9add929\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"ace6326f37b45885\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"a010f1789f145bf1\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"52eb30264833646d\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"746657eed7f6c635\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"39f8480816f73d7b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e22e0b8675d41dad\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3a8ebc3a51a8cafa\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ae66eead3181772e\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"0639e4f78d7dacdc\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"4c64623b1c446df1\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"80cbcfa58e7d6365\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"47cb4b2604b03417\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"93300cfb2b562d3f\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"57969eb989eff75e\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"91ce33189d9693db\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6e616c61bedbb42f\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d62931c42011bffc\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"318bd77524f2c52f\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"9109fd44bab88ba3\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"23ecded0d847df7f\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"93496c6edcbe3462\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"9f75c81375e455fb\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"56564c25265b3cf9\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a0b1f292b756d217\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"52060b34e6774d3b\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"63fa976f5759dbc9\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"aeb6b0547cd82b38\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"4a8b1342f8fcab80\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"8f2cd6d5cd71847d\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"a292642521653b59\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"5f549bfec0eddba1\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"e5e6c46d82377be6\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"e9778ecd2065ee4a\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"30b15a8575e46d30\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"8bb6ee6d4f00e486\",\"/knowledge-medium/src/plugins/geo/index.js\":\"f60431b618725b6b\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"977044e8d3b43dc6\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"67077961f008da3f\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"0823c0d74364bd1f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"80fe48d494da2615\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9759c1e2397fd07b\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"a7e77e4c0c0ef0b9\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"38bab33c139553ce\",\"/knowledge-medium/src/plugins/geo/query.js\":\"d3f3f45d3e6d0907\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"ccf1f508df606086\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"434f4422af371722\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d34b62d78c3619ad\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8b7921207bd0dab5\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"428f20447ca8da9f\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"70ed5e0144309ca5\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"4ad59e47a063b25e\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"07348eaf9e6c244c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"3b9af7b50df14712\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4cf7e77c6fd36c97\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"cf5224a7d7f15cbb\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"0d031810ee253fbe\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b5ea6c8db03e1601\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"13880ca43722e0d3\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"74ab4682f68f5704\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"884872de90cc9fc3\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"aedcb793967a0ebb\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"08fbc491e8249459\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"deab4d47e32e73b3\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"3c106c45ddca49a9\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"9d32437f781d59c8\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"6badf9b5fd21a993\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4de58f7e7b24a8f2\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"45628370bcc936ea\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"f212977f654a2c65\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"73024eacd1aa6781\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"0c997e5f20b0f693\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"86ad60b65809195d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"f24a5406758834a3\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"199ee49b5c5e5798\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"0dc5ef01336c7f7d\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"00052507c5315d79\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bd28d41cf43b5d41\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e5729fcf686fad95\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"fc0b92bfe8aa62d0\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"e746cee507a88586\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"70b2e5636f01666c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"63d7d1e4d95fbbea\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"5549122685a69ea3\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"83a739684aa38fab\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"ad842c200df03897\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"457ea068a423b867\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f6b45b36b218e4d3\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"cd19eca07a429093\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"c5f99c7652413ce5\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"30e77ebd6de1a240\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"81cbbe2b13fcdd92\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"92efe01a718bc7ee\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"f2f80554f39d468c\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"81fb135c5144a0eb\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"b712e2be19dd8189\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"eea6355a074f930f\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"154e6bc9ed0a3e83\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"31243e9f864d5c79\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f560f204b5d65038\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"24c8792ed29a1b05\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d07a0c8370f24eae\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"ef71af9e7965d750\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e5e68208c2846fe5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3ce938c711bac00a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4fa4cfe4b187f3e6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"85dc9391f42b2334\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d6848257ebdc2ea4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"244ac51ba9721646\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7e12f1de0976e357\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0c96a5a93b401f71\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"849f4bcab29b43d1\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"9e9846888105d56a\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"9a8f79450ec990c1\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"7d475f1a8e8579a9\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"03beec100191fcf2\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"d0c3981b8677f5e2\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"760c907eeabe8667\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"6a89e5cca5dc23bf\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"a799ce943a8a527c\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"e6d3fd4b1f92a067\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"ce8ecf231a579335\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"0b560be423897192\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"77380f3014ad3862\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"4c9cc5ec07720ac3\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0f63c42b7f1d6fa9\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"1e45a1e8203fdfc7\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"6d0af2d356275912\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"d2e65a2104adb5e1\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"78a1ffcc392aefe3\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"03948fdc9d45ec88\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"40c9d87ff1d4e603\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"fb5a3775ffeff4b1\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"de1ab47ec4f845ca\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"2ffca30179de5ff7\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"a9acb485f37ffbce\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"fd3b64d08ac58a89\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f0bcee1adc64e1f9\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"2eebc6b7726399d9\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"487772537202c8c9\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"7aa99973166a7df9\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"8cdf548d0f5a4365\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"8974dcab12b392d6\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"96f236d78660180e\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"34f74368f83b08a1\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"57e01ab3ed555458\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"10ae8d9ca74fccb9\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a3def458c5d08eb7\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"cc83b0d9f90170e5\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"c8d6da6767e86281\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6daa5631462ca4f7\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"246b7d3c12a0bb04\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"ba97dbeb106c67a8\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a2eb49071bb08a5e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"db065c4816d7cfa0\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"3248fa0184cd7697\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"5bdf98e9a8de8f28\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"1b92218e9777f729\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"ac0e16e248eadeae\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"9ed793aae402ab90\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"0b1f61f087adf600\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"5975f41dd4c78cb6\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"34212842b524d2b3\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"eae6189cc76bc610\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d805dd98b4ef4861\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a4be239cabf8503d\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"d04498df6379d50e\",\"/knowledge-medium/src/plugins/recents/index.js\":\"7664fb0d86d29864\",\"/knowledge-medium/src/plugins/recents/target.js\":\"76f63933a98118e1\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"23f84c0f4da7668b\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"02fbf99ecf8c91d8\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"572ed7ed0f288e51\",\"/knowledge-medium/src/plugins/references/index.js\":\"1401343c1a069ac6\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"166b808d8f37410f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"868bf28231e918d0\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"a525f3f5a9a5cc53\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"34f6da771a41b6a1\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"166cb8c5e5b0631a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"dfa40641780fcd62\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"6606ef907d67e85d\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c08039c9918fdcf5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b6c6f2bb817ad6d6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"1fc45ad3c157892c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f5c0a9dc1b95eb0b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"137d42dbd7e20eb9\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"5547b11bf25bc788\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"181ececde1aa28c9\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"d87434cca5787f5f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"bec14cbbe68f196e\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"aa4bc1b5afeac9a9\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f822d2dcb23dcd6b\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"e6bdbf08eee107dd\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"933480516c72d85e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"15d59ef67164cb97\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9d0c00f1d54756f5\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"8b302d2f22b23cf4\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"cc1b1220ba8487a9\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"87b78e0c863d3532\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"be21ee8fd29e7b29\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"f3e9de5bdac3bbce\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"23876f312f5f5e47\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"021ebd40fa9c6df2\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c770aad94f1e54ff\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"dfef540b58204a05\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"1104ac8f066b9f0d\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"0cb8859f9cd3f79c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"2760569ec7d58877\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"fa8b9651f9ab8a0b\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"847bbe28592e6e0e\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"513c056f7be85c3b\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5be6120a3ffdbfa1\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"6c6a11b02e7090c8\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"6245f3cec9a039c9\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"10c6cbe9bd3c47ca\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"d3d79e10c8685dd0\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"8b948bcee2dec664\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1fc85ebe393102c7\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"8136c4e3fe683991\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"8a9b7e449ad8dad4\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8bfda898d28cf61b\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"2aa6ace58ef1ee39\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8310a2cb194f9122\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"19526db5b6290ba8\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"18e42da28acea809\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c251984253523d8d\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"90ee6535f8e5e75c\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b1d50e1ef6ea9f6c\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e296ab3dd1824fb4\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"80ce63227691ec59\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"e0e14655f1576b5a\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"9c1a601fdba34ce5\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"58ab74945a346705\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"565970ec6e476f4e\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"60ae70457a925c9e\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"6578d9f5fa34e538\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"b055be703c432c64\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"41edd6550633b959\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e8323cc539b0d469\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"fa2a731db9f21bd5\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"db2cc0f854e8854e\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"73ea9ea553842171\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"9126530d6dd1d9b7\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a1c6cb079e2ddc0f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fd4952a25859e962\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"53d1a3fd778d4222\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"442006a952b5ddd2\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c05fb8f68f996989\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"1c8f4305ec840a58\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"5141d2560dd2b844\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"08ad0a9e37d846a2\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"949b2cacc9bc1548\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"eea3639fce6e86de\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"5568eff579f29b3c\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"8afe06d349d6ad50\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"7551a893d109423c\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"8bfd46ac1591a152\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"188e4420191d8cfe\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"e0214e7f5efd7dee\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"9b53f58830129a1b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"d9d5ca61d8394b73\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"2e64e8c4aaaa4bc7\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"47cc66e6d81c0e65\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"0ed7e9c92f51a124\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"12ee57e248b4ce95\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"3cb430b7c7e4c1b6\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"9f81380491f0ef4c\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"124f0f93d490c6cb\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"62dd38c053a8b117\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"41bc48bce6fce6bb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"861402652bf45c7c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ea2721cba2650d1e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"cb529acf337163f7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"426c9874570c78a2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4a5303100cab0929\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"eec39ede8b6ea3ba\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c6ac94ed3c34afd2\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"4bde0827394e1586\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"8ddf36970f8a0baf\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"46614d17e2043ce8\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"287cc69b7c6f4fb5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"44680f72c85d40f5\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"4c3582bb449ff6d0\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"18c55058bb7b4e64\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"a18fd79f3836cb28\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"bdaa97a0d1d92697\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"74bfc4aa2362a131\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"38f883def6422381\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"22cb419bae5eb2f9\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"52dc83a4097b5c0a\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"33b11cc7a0f437dd\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"9edea7ea3e2be823\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"3426d8c5ff1f1472\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"33b3cb580a9918a6\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"ccf98427a6c335de\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"0fd7a7f9006943ac\",\"/knowledge-medium/src/plugins/tables/index.js\":\"7c250c97184b86fa\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"7d044544584da9f1\",\"/knowledge-medium/src/plugins/tables/model.js\":\"d90cf0cf2f151992\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"a6e3ef3567e155d2\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"2373fbc9d3626c7b\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"144969a3252a0dda\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"af0280e18e25ee1c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0a538367410f50e8\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"103e9a658f92523f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"cb9633df388a6759\",\"/knowledge-medium/src/plugins/todo/index.js\":\"78159d8ad8ed00ae\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"4391d06954c9aa4e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a89dffcdf9b14786\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"db5eb69bbfa8db9f\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"02cb563994279c10\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"e39eebf86d8115b4\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"a97c03e550bb3cb1\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b8e1b6e1ccfa8ffb\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"422502bab1678344\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"76d49a07434708db\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"e6aedad683c8426d\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"cbfcfbec529df286\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c24c7eaea513ca59\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"7ae8edc1afdcf9a6\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"0a493a18e40e128b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"0ac1a9df0885b3f7\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"a5511bdb6bbc2ccb\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"e40aedbc1fcc3246\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"de95cfd269b682b2\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"cc6df5a9b35e65ec\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"53c0a57359f7ffb7\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"039799513eaeff35\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"9bc4b6d82919caea\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"17a90ba958920212\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"cf5cc062bd33ad9f\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"062e8109255a44d9\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"bad6c39b59e0a982\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f390fb134f555f58\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"2b368cad91d59ecb\",\"/knowledge-medium/src/registerServiceWorker.js\":\"d0d94380eae982b5\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"a266d3523b5b7b98\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"69bc9574d6f46c7e\",\"/knowledge-medium/src/services/authStorage.js\":\"2112602ac1b39fc4\",\"/knowledge-medium/src/services/powersync.js\":\"4ff53a6555b93e52\",\"/knowledge-medium/src/services/supabase.js\":\"449c926e8457c596\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"f0f5bc5132cc007e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"5a165001dbd562c9\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"59e3262c12a5db5b\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"5ec86f828e0a673c\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"38f5d055be39de19\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"94c3b071a61b2737\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"22cf983dedfe97be\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0e031c3a8a4ee1d6\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"eb03ca150fee8d16\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5689468373efe9cf\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"7ab182cccff91b83\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"cf0b45dadb387921\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"7d2742d6626d4980\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"0f0e444a53166504\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"564211092efb1684\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"f3e6d25fa4c3de5c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"436f83b33e18f25f\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"5c2f4038c76b566d\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"b4de812c600c4b8e\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"60b9421abdb8407f\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"259ee0d4b1bebc7f\",\"/knowledge-medium/src/shortcuts/types.js\":\"20f82ca93960f4dd\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"80e02064a8397799\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"c6fde60b2a9183d9\",\"/knowledge-medium/src/shortcuts/utils.js\":\"00ec05d6a617761f\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"b9ca62d2b7e3f2b5\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"be7c2ed1d67828ec\",\"/knowledge-medium/src/sync/byteTransform.js\":\"16a7b04b8b0efe59\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"cc352fa29582ddca\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"7921845b72111a27\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"affa99064d969b54\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"2c9bed544a6de308\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"2313ef9c32bfd416\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"362bdaafc247f2aa\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"2b0d8ef831fbf355\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"5c5215dcee98e8b5\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"763b21655036ba66\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"95cd8ffa58f94df9\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"231ad3b3f88f2e1b\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"e4499c69998bfe6b\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"35e64b477490721a\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b8c08122a3723b0b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"560f08343ac762a1\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"746237f1e30d247b\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"52372cc61afb79fb\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"edb8944fa62517b4\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"7a95e06e5b8711ee\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"e1ef00f9d1c30336\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"cc757422a25a7101\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"3706f92ed6da9123\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"84f347b4b763e285\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9122a79d4d2aefee\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ab5f6994976f644d\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"ef4f7b3c7375e0f4\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"cab9ba32ae05ed6d\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"818b0ae9ca0ccc16\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a83cf618fec988c5\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"892af3b44d93df25\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"3e8ec2433a4c5f84\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"67aa8075185a4e76\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"2f172b650866c2a0\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6d90009f1a3c1fb3\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"0bbd13ebc94d3f06\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"503a066e62ab6b65\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"81b4d25f1e7a0861\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"0799f0ea6c2bbcc0\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"19dfbd26711e6460\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c9fe8d7da4bbde80\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"5ac7a640b0889924\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"f4ba5d289f6108f0\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"d9a7dd532fc54008\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"531056b48fed3227\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"9ad6a12164a4b8ee\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"bf8ac804ae47e797\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"34cd6e42a6880779\",\"/knowledge-medium/src/sync/transform.js\":\"c3bcdc4f044cc5ab\",\"/knowledge-medium/src/themeBootDefaults.js\":\"759a2b40fc166f60\",\"/knowledge-medium/src/types.js\":\"abd1e94c9c5759f0\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b5f82064e27b2ed8\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"2ff9b409f86c4d54\",\"/knowledge-medium/src/utils/array.js\":\"6283accd388dffca\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"d6caac1dd112eba4\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"eec565e56ae46500\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"fd2984d95660b818\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"0ba8a71aa3584738\",\"/knowledge-medium/src/utils/callbackSet.js\":\"fb2bea29841901ab\",\"/knowledge-medium/src/utils/clientId.js\":\"9d2f29af77f4170f\",\"/knowledge-medium/src/utils/codemirror.js\":\"c98fb28373e0e468\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"c4bb2aab09c2914f\",\"/knowledge-medium/src/utils/copy.js\":\"65f4a0a894924aee\",\"/knowledge-medium/src/utils/dailyPage.js\":\"903d60c38877e9a7\",\"/knowledge-medium/src/utils/dbForensics.js\":\"d9dc461d1f458689\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"50532e4a3d1bc3ba\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"ca3924a9edebfce2\",\"/knowledge-medium/src/utils/dialogs.js\":\"416c6c7a386610f5\",\"/knowledge-medium/src/utils/dom.js\":\"1cbaa600ac6e2d89\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"25d89079fe629746\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"4a5833ce8d101827\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"905e15ff8cf7efa5\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9f3a4f95444bad73\",\"/knowledge-medium/src/utils/fnv1a.js\":\"fb7e997458fedea0\",\"/knowledge-medium/src/utils/formatBytes.js\":\"72f2184fb9a7f2c8\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"5f3a42382a701764\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"a8fc6fb4e5900cf0\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"9640a1cf20ec9833\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"bc18655b6ecb1881\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"6d09f976f51ee20d\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"b7ce1273bdafd998\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"da192063ece28237\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4e7d412b5376567e\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9e57f3cab6a7051e\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"1b02f06218cb0f1b\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"aa5fa14ed8324a6c\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"1a9046951b8e43f1\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"693882f566ad7ede\",\"/knowledge-medium/src/utils/markdownParser.js\":\"c907e7080bc6b06e\",\"/knowledge-medium/src/utils/memoize.js\":\"80bded6c20434f57\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"91f86cb6640fa6d0\",\"/knowledge-medium/src/utils/nameList.js\":\"451bd709bf509bb1\",\"/knowledge-medium/src/utils/navigation.js\":\"5635b65f2e4664cc\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"5596ee45d43b596b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"50d28a2f84689c55\",\"/knowledge-medium/src/utils/panelClearance.js\":\"670af1f97f50c27c\",\"/knowledge-medium/src/utils/panelHistory.js\":\"c3cf3834596d9da1\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e1d803953db629ad\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"911a35af4d990f95\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"10643a1958498034\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a3cc781f4114e416\",\"/knowledge-medium/src/utils/platform.js\":\"28c783c47e78e6b4\",\"/knowledge-medium/src/utils/pluralize.js\":\"c767bf48a9c13066\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"7af310777b7d3e8c\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"0446c326d8053234\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"2493141fc43203ad\",\"/knowledge-medium/src/utils/react.js\":\"f50904d23f1d737e\",\"/knowledge-medium/src/utils/relativeDate.js\":\"dbf1c2b454d7f784\",\"/knowledge-medium/src/utils/relativeTime.js\":\"36af347c1521626a\",\"/knowledge-medium/src/utils/renderScope.js\":\"3eb4853a16b31f0e\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"728819ca43ad4674\",\"/knowledge-medium/src/utils/routing.js\":\"04f6499bd7744570\",\"/knowledge-medium/src/utils/safeMode.js\":\"b7ed1e70b2220a7d\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"88c543089eb30264\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"6e7daf442f543407\",\"/knowledge-medium/src/utils/selection.js\":\"354ba7bcc96e04db\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"c322bbbfe7e67630\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"c70f3e5f757c3afb\",\"/knowledge-medium/src/utils/state.js\":\"74626426767eb5f1\",\"/knowledge-medium/src/utils/string.js\":\"3b4d6556aca05983\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9d4cb34bea045d57\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"207a0289e0bd0a2b\",\"/knowledge-medium/src/utils/toast.js\":\"b0df15738fbffd4e\",\"/knowledge-medium/src/utils/toggleStore.js\":\"08a87a4bd2b47378\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"e9368459e8e2be00\",\"/knowledge-medium/src/utils/userActivity.js\":\"b52f47090cddbfac\",\"/knowledge-medium/src/utils/viewTransition.js\":\"442c12a54ee1b80b\",\"/knowledge-medium/src/utils/viewport.js\":\"c6731c7d009dfc68\",\"/knowledge-medium/src/utils/webLock.js\":\"3a374d9c383c60dd\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"2e2525317296a7ee\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"fa2ae66f9a2f5991\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"3d339c62d4a1c1a1\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"ce2048e1930f6c9d\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"400e4beec3a4de65\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"e8ca34761fb8f622\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f2ebe652cd279a37\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b74ff7cb5aef21fd\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"cb82f83435521f0c\",\"/knowledge-medium/src/vendor/react-dom.js\":\"cc76f88c187cf831\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"39a6532b06ee070d\",\"/knowledge-medium/src/vendor/react.js\":\"6d97c4e3d8e9fe6b\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
