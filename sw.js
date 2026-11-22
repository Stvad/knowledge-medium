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
		buildId: "fa0296582ec3-d29e5763",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"410ed57f992c2395\",\"/knowledge-medium/index.html\":\"410ed57f992c2395\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"57e38bc41f8f0860\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-0BB9DKX6.js\":\"d93b290bb73ef7c8\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"4d1a43ed3d2550de\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BbaizECf.js\":\"f8890ddcebc08e5e\",\"/knowledge-medium/chunks/FacadeVFS-BTpzB81F.js\":\"05234a7b67076ebd\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BHdMa0MQ.js\":\"77f7c645ec46d8e8\",\"/knowledge-medium/chunks/MemoryVFS-PiYHnZsb.js\":\"ff5da7caa2cf45fe\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Buq5_3aV.js\":\"6a10af0b612e3708\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CM5oYjIw.js\":\"7bbf39d094debcbe\",\"/knowledge-medium/chunks/Preview-BqRVHSII.js\":\"9bb27e910250602f\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BlBjf9eu.js\":\"6f7c2b0444136f3e\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DQb9b8Es.js\":\"2f27e3599b714049\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BS0K6Nth.js\":\"8169eca8666f181e\",\"/knowledge-medium/chunks/react-BbNgRvw8.js\":\"3c429fe48d7f8d6d\",\"/knowledge-medium/chunks/react-Cd88AcdI.js\":\"b3f12f6d6b1c41ad\",\"/knowledge-medium/chunks/react-DEeRr3cH.js\":\"5eb967cb66c77fb0\",\"/knowledge-medium/chunks/react-DGms_B3R.js\":\"b0cf76ff5fbf34c1\",\"/knowledge-medium/chunks/react-DQ1hCXhz.js\":\"bb7daa2e0f97abb2\",\"/knowledge-medium/chunks/react-DU-yHuIQ.js\":\"53c772f8eeae8a86\",\"/knowledge-medium/chunks/react-RnUEB60P.js\":\"fde3799d1e637d03\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BNsB1Ic4.js\":\"a96580b44d7ab948\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CJnUqDI_.js\":\"ad1c77df5ab2f4d7\",\"/knowledge-medium/chunks/react-dom-server.edge.production-RkiCh_K8.js\":\"071a8760346e3338\",\"/knowledge-medium/chunks/server.browser-pnFWsr4z.js\":\"bed0633679c537b4\",\"/knowledge-medium/chunks/textarea-ysovm4dw.js\":\"62806791208a7fad\",\"/knowledge-medium/chunks/ui-BbMEMSLw.js\":\"cf232a4d7f44ad42\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"6a42adb5180e6328\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"ac5b79c4010d6702\",\"/knowledge-medium/src/appUpdate.js\":\"cb53e2b8e677a3b1\",\"/knowledge-medium/src/appVersion.js\":\"0cd5f1ce87cb8c97\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"3cc0530e5434dd27\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"099295809333c031\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"ec13b24bbfb37687\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"104dbff07a125d02\",\"/knowledge-medium/src/components/BlockComponent.js\":\"66b0782823ade4c4\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"142dd0e89975585b\",\"/knowledge-medium/src/components/BlockEditor.js\":\"1c0e74c3c3d4c604\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"b1b7a97844dd8c20\",\"/knowledge-medium/src/components/BlockProperties.js\":\"1dc2ef6d509f7145\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"ee64b79347c2b168\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"4389ade569ee83a7\",\"/knowledge-medium/src/components/DividerHandle.js\":\"4717031bc2467ccc\",\"/knowledge-medium/src/components/DraftEditor.js\":\"55cdc234d36cd8aa\",\"/knowledge-medium/src/components/GutterPill.js\":\"65f34e28cc8f42ab\",\"/knowledge-medium/src/components/Header.js\":\"9cd840aa7450091f\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"be9dc7e505d9f143\",\"/knowledge-medium/src/components/Login.js\":\"e1ebaf7c9b5e0fc5\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bfe9de38cafbe9fb\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"8e9465ed92beafd6\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2324d07db7c7b856\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"45c7e16e5590b7b7\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"47e274b054fe6505\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3cdaa84c5d1549ee\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"99a7538cd7a06805\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"0e72ec7733ba56b2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"8af60bc4b9d6860e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"2744f22613fcbd4a\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"6d11f74c54238303\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"24d52998adda9e9e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6d67d5b72a8abcdf\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"fb2347784d5f2e59\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"eb0068ce2edb7411\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"15a8c26b9fdab3f0\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"69959c056910a5e5\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"1943a9a1568fdb6b\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"b4cfdc20ebbb45e9\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a1bbf6653e233168\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"99db3c5a782e853f\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bac07287ff783630\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c8c052259658065f\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"244c4f1290efe4fd\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"105995ae99fbd0d7\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"4c21c004e7e1aa82\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"0bae285eb99a90fc\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"84933cb8f30d5972\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"c212fdc1d61f8fdf\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"6cc6a9a877c56f73\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"f7b61e2678dee99c\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"4d18028aaa48a35d\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d68b5396409ef891\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"48c3d5eaefb769d3\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"7e13b42229bb9700\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"5dbdc4fc74cdcb95\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"0c0b8c344b377f87\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"f69a1dc57f1db6a0\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4dafc6815775bbfb\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8fb9878153a1f227\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"78ea991ad8c64854\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0d3ca360ecc5e8d6\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"83485450dfad91d8\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"e495881add2ca035\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"459db2e7b3809926\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"32df0013cec3465c\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"552f9a1b89990080\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b2c3041469051e90\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"eca481f888d09386\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"27a1fc53d59c1acc\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b0feb896c3eac713\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"4ab64caf0edea825\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"dd350e242c1240a0\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"3b6e41df7b1afa5a\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"2db3dc680c645f6f\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"a40984466da5f043\",\"/knowledge-medium/src/components/ui/button.js\":\"d042f15742f77aa4\",\"/knowledge-medium/src/components/ui/card.js\":\"5aa9b3e1df4e3dd3\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"08e9dbfa5e2c9ed4\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"cb613cf002e67283\",\"/knowledge-medium/src/components/ui/command.js\":\"cccce096f0af345b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"f3953f043fa6ae7b\",\"/knowledge-medium/src/components/ui/dialog.js\":\"3a7eaf478b89d54a\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"69a386fa2fca246d\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"f8cc886de325c158\",\"/knowledge-medium/src/components/ui/index.js\":\"04f7e7cab41a6c0c\",\"/knowledge-medium/src/components/ui/input.js\":\"6c2f03a4310fcad5\",\"/knowledge-medium/src/components/ui/kbd.js\":\"25796b7a7efc65d5\",\"/knowledge-medium/src/components/ui/label.js\":\"54e7c69d93c5f581\",\"/knowledge-medium/src/components/ui/textarea.js\":\"0ee690796421a271\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"88fb7ca67f95cfc8\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"6b8bcfe5d28d85b9\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"fa3fea50767d4bae\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c2fea674cec2ecfe\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"65aa30e348cc4921\",\"/knowledge-medium/src/components/util/error.js\":\"740e9e334e942b65\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"fff720864eb20b7f\",\"/knowledge-medium/src/components/util/suspense.js\":\"30b1d1f8bf8bf1a5\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e6b50b7d9a5d107b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"0ea27c39c1b26232\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"9ba3530f13c4f042\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"10a7bb81711175af\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a742cabf2cda980d\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"4adeaf2b4e8c2f75\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"070e77216b6f127b\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"1982af19191a8b8b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7f056d3b15009f3d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"3569b7661aeb7d7e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"c1adeb1318011efc\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"332bbf9742829060\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"896f00803aaa90ca\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"1f99926ac5cb74a4\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"afe18e415bada3e8\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"087d170bdf077b7c\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"41f8579b7bf9f69a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"68dbe5d60f86ea37\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"2886ac6eb5256881\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"284f9e8443b16e76\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"84c28c6ba6d76bb2\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"c2e5fbf95777f395\",\"/knowledge-medium/src/context/block.js\":\"c84627ca90808a60\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"6ff328fd7423889e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"1d3123c712b0f838\",\"/knowledge-medium/src/context/repo.js\":\"f9a70573baff9925\",\"/knowledge-medium/src/data/aliasClaim.js\":\"5ba8ce7f99e3225e\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"86ed4cf707f37764\",\"/knowledge-medium/src/data/api/blockData.js\":\"91d7186a89dbd5fc\",\"/knowledge-medium/src/data/api/blockType.js\":\"182e808e55ad8dcb\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d60ccd25f7355dec\",\"/knowledge-medium/src/data/api/codecs.js\":\"b531547f3416cc43\",\"/knowledge-medium/src/data/api/derivedData.js\":\"550b31b1e4c8dd35\",\"/knowledge-medium/src/data/api/errors.js\":\"743faa640f00709d\",\"/knowledge-medium/src/data/api/events.js\":\"94a9c9af9893909e\",\"/knowledge-medium/src/data/api/handle.js\":\"5597736d864e88a1\",\"/knowledge-medium/src/data/api/index.js\":\"e5af8b9a7970ae39\",\"/knowledge-medium/src/data/api/mutator.js\":\"faeedb67f4cfa5f3\",\"/knowledge-medium/src/data/api/processor.js\":\"1766d87243a7c0b9\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"65d12869bef77ec9\",\"/knowledge-medium/src/data/api/query.js\":\"74bc3e552272d65a\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"df35271b197fd943\",\"/knowledge-medium/src/data/api/schema.js\":\"5597736d864e88a1\",\"/knowledge-medium/src/data/api/tx.js\":\"5597736d864e88a1\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"21368df0ebe5588e\",\"/knowledge-medium/src/data/api/user.js\":\"2e1cc71b162d6e48\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"cb6cdcfdb30e023a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"31aa022092bc2730\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"7910a5e591127a5d\",\"/knowledge-medium/src/data/block.js\":\"d99c219416546b96\",\"/knowledge-medium/src/data/blockCache.js\":\"e461270affbe0313\",\"/knowledge-medium/src/data/blockId.js\":\"70981967fe3ff643\",\"/knowledge-medium/src/data/blockLiveness.js\":\"701e65de2ef1fbaa\",\"/knowledge-medium/src/data/blockMerge.js\":\"7ae87dcaae426bcf\",\"/knowledge-medium/src/data/blockSchema.js\":\"9c318948deaac0eb\",\"/knowledge-medium/src/data/blockTypes.js\":\"3e61dd76d9ce1e1d\",\"/knowledge-medium/src/data/clientContext.js\":\"aad4796e813bbf3b\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"4f7e6be3b1fba587\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"241186933c2fab16\",\"/knowledge-medium/src/data/derivedIds.js\":\"cdf1810cb2467ee1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"e8fe608917ccc1e3\",\"/knowledge-medium/src/data/facetBridge.js\":\"4b4bf07abd6ba14d\",\"/knowledge-medium/src/data/facets.js\":\"380cac72bb8b7aae\",\"/knowledge-medium/src/data/globalState.js\":\"79398715ab61ebb7\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"9396462a5e88c207\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"962f2089dea88729\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"b37e9e0d125244d4\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"7c55b5f39445a48f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"21ca99cf35d76894\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"a9e23951650f3a84\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"108cced89fb4e12d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"d86cbb1a63e56ce1\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"49d94de99037bd63\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"dfcab90548423b3c\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"fe0fadd8db5f417c\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"a296fe9e74115c5f\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"e58b347b37916a76\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"d139ffd4870c9b66\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"518cf78852465373\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"144be29cacad1744\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"7a8b31a61d7c6aa4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"7499ca4ec0070995\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"281815fcc634518b\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"52129c3d27db0118\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"8ec43541fe77e2a0\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"5fe15eb3174d0ca0\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"bd7eb8f82613fca9\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"86e160b3a0e8eb08\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6117d1433fbc6834\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"e17e541b14f269f3\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"093e53b4ab69a93c\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"08539b848bca955c\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"31fd7f0d69ba16e7\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"6824ec21b7959488\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"d865fc7eb23102f8\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"1f618ae2b3fbd6e4\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"66127340b9765328\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"affead644d70ebed\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"53195e6d62e218a0\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"87cfe4086595f0ae\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ecc35b48f2b53adc\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"2dfbbd16e06660e6\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"116c4105940c7714\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"a5aee9aaec3a60d4\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"7d8d2db247785e20\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"e36a67cfe64e29b1\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"5cf7aa9c7da2fcee\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"9502335a1ca48c64\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"e9169c6df4fe26ab\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"4bc3064230cd36a9\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"20851a93cdc1644e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"db76ca9e0209b1bc\",\"/knowledge-medium/src/data/invalidation.js\":\"5a650f1cf4b1f381\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"e5e34f44a24a32bf\",\"/knowledge-medium/src/data/kernelPage.js\":\"e3929bdab170e716\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"3295bb3d81a5c1c2\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"e8f3bb36ccbc5e82\",\"/knowledge-medium/src/data/localDbStorage.js\":\"72667df6c2ccf90a\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f2e4cc447f2ef9e7\",\"/knowledge-medium/src/data/localSchema.js\":\"afc85efa9b406e60\",\"/knowledge-medium/src/data/maintenance.js\":\"b0df78eb4406be23\",\"/knowledge-medium/src/data/mergeProperties.js\":\"72e1346c8e4a2b5a\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"ea80a7733e350ad7\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e2bdffe0625b3457\",\"/knowledge-medium/src/data/mutators.js\":\"b5a1bb97c65a3434\",\"/knowledge-medium/src/data/orderKey.js\":\"231d2b2d6f96fed0\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"ce2a73e202339208\",\"/knowledge-medium/src/data/outlineSurface.js\":\"7ee0f4a3860ddbce\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"d3a4ca2cff491efa\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"efd2a4508869521b\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"50b297e53cfb3740\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"243cd9dda402cf9d\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"ac33c143d8ed850e\",\"/knowledge-medium/src/data/properties.js\":\"95af5c9790c6b583\",\"/knowledge-medium/src/data/propertiesPage.js\":\"0f1f3cada4a47738\",\"/knowledge-medium/src/data/propertyChildren.js\":\"a98f2f3961e4e8bf\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"5da0aad51d9297a4\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"a11b4df550c7a9d7\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"42af8cad6444a278\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"4785699fbf05d422\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"268fa99492a70f6a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"1eea7a49af13a623\",\"/knowledge-medium/src/data/propertySeeds.js\":\"ab21329449681129\",\"/knowledge-medium/src/data/recentsPage.js\":\"9c217749c38b285a\",\"/knowledge-medium/src/data/referenceBlock.js\":\"0ff08e3c78a80fb1\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"1159e7ebf6b7e072\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"d485872ba5145b32\",\"/knowledge-medium/src/data/repo.js\":\"119fe853c03d6eb4\",\"/knowledge-medium/src/data/repoProvider.js\":\"6a6aeab5b6ed1d95\",\"/knowledge-medium/src/data/rowProperty.js\":\"78324c73132817e1\",\"/knowledge-medium/src/data/searchFilter.js\":\"289a7142ca53884e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d3ce04767361347d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"d2064f7357679118\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"40ed33e84408bed6\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"cef2bf4817b26159\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3118e62668fba404\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"74bb5e9f32cd25f9\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"980e309a0ba841d8\",\"/knowledge-medium/src/data/targets.js\":\"ae77f3909a09bfe9\",\"/knowledge-medium/src/data/typeColors.js\":\"3176a0e66e458d33\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"3b21fae68cba75bb\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"8b728d1d55c9630f\",\"/knowledge-medium/src/data/typeExtraction.js\":\"8055be5ecce61ff3\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"ff7887ef773904bc\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"fb426873e5ff7f60\",\"/knowledge-medium/src/data/typeSeeds.js\":\"42850d28bfd53f10\",\"/knowledge-medium/src/data/typeTagger.js\":\"cb320f44f726d116\",\"/knowledge-medium/src/data/typedRecords.js\":\"b12bc04d1ce0c8f5\",\"/knowledge-medium/src/data/typesPage.js\":\"863a582b6ae577ab\",\"/knowledge-medium/src/data/userPrefs.js\":\"b12b29509d29cf41\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e8d796a7906ccb88\",\"/knowledge-medium/src/data/userTypesService.js\":\"f9cea9c32dff8ca5\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"7bce547e5754b2ba\",\"/knowledge-medium/src/data/visibleChildren.js\":\"38724e7be74d2cec\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e93463c936533d2c\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"7541444be7118a7d\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"a67d00b880ed61f1\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"90e073865be1140a\",\"/knowledge-medium/src/data/workspaces.js\":\"771dfc2925fd65f5\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"c89c6444cefc911c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"5685999673f918fd\",\"/knowledge-medium/src/editor/atTrigger.js\":\"dd856d261259b6b7\",\"/knowledge-medium/src/editor/autocomplete.js\":\"762d66ae44aa5f47\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"ed4e7cfa8f889b9d\",\"/knowledge-medium/src/editor/contentFlush.js\":\"d0c03782d37055c7\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"26ed24affb39bcc3\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"62e285c49696bb80\",\"/knowledge-medium/src/editor/insertImage.js\":\"32571e62faf6c0d2\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8155358918abc9df\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"d7c5754a7a8cb227\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"9b2cbd5775a8c270\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"82d93f8c68686e3a\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"2d5dd5a49108ecd3\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"e0b02fa818c1558a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"90211945c1cb6538\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"c25e73be1c4fcaf1\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"a8ab4bfe2f216f5d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"0ce99f136fea32c4\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"e6d9bf05bf29d012\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ff98651ed09ae533\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"d1e2b730eb900d57\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"ba0ae2d741f871e0\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"8cc7f50403d586cd\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"62c2beeb8e8ac465\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2a904d39853e2165\",\"/knowledge-medium/src/extensions/core.js\":\"c9762bcb34975147\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"31f332f3e0e7467f\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"a310ef58e2fa4820\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"ae2aa7891febc7c8\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"27314b90b89b3273\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"57091019b92eb29b\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"73f1d7e3109cc387\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"51e12d8cf649cb8d\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"6e82b42c2ff0e972\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"7cc78fa48a7feea4\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"a1a6c0f12dcebab3\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"5ad907ec0539fef3\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"0668c20cce680073\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"9d1b6784cf45fff6\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"ba8653504a3b0d21\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"270391d7742db124\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"9d8ad9598998a622\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"0526e5bd8796dd9d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"6b4f1031c0140161\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"25a1eb76464672fc\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"026b7008cc441792\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"a3404f5fbe064b2e\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e9f7ecc085082ef9\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"b23f4a2ddc9511ab\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"dc030a5891e7c5f8\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"308bb6f8f7360e60\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"88a9d95af24f911b\",\"/knowledge-medium/src/facets/facet.js\":\"1389476797463f4c\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"9ce9b28b3bd94893\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"4c12b5f29658276d\",\"/knowledge-medium/src/facets/togglable.js\":\"02e1d8115e1f14b3\",\"/knowledge-medium/src/facets/variantFacet.js\":\"5aef9040e295ce52\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4f43f515c57433e4\",\"/knowledge-medium/src/hooks/block.js\":\"3096fd252a0e71e4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"fdbccb1690c36d4c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0cf479c93ecaefd7\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"6c1458a328129399\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"17154657f6fb3b47\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"aa29257cdcc21103\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"43333fcd70e89e56\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"9c38d69e542a7ec3\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"1b2dadeec28dc20f\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"5fb0735f548d30e8\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"8ea2fff83a683e4d\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"64e31e37188a245f\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"12623433fed31abe\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"f9eae074081b1ef4\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"074600479a8a20be\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b4e173cc7cc73082\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"55c360d957e25069\",\"/knowledge-medium/src/lib/utils.js\":\"5d9afe3afbe6f62d\",\"/knowledge-medium/src/main.js\":\"21fe58ba20a77ce5\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"e2ffa9ffd94fbc2b\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"432281a6fb8d4e1b\",\"/knowledge-medium/src/markdown/context.js\":\"8d7dd3065530b529\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a3ea1f18402c2419\",\"/knowledge-medium/src/markdown/extensions.js\":\"7deb8e29cdc0cb3a\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"01e93e775fa11e0b\",\"/knowledge-medium/src/minimal-editor.js\":\"2b74b27b46bdf80d\",\"/knowledge-medium/src/paste/armedCut.js\":\"f6a60f4087594ffc\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"3df8348e299f522a\",\"/knowledge-medium/src/paste/clipboard.js\":\"dac2a5f6bf56312d\",\"/knowledge-medium/src/paste/decision.js\":\"b7d77afeddef0b9b\",\"/knowledge-medium/src/paste/operations.js\":\"4e531c1246a85681\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"476b23519417a536\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"ce29c44f7f717dfe\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7197a48ec79cfc06\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c72661d2c19ab610\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d0b5f54c21eb5ed8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9ec4156a03011122\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"d03ad358ea985736\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1254830dfeeea534\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"2428a952b20cde5c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c30d1aa45c673d39\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"96362d93826cb0b4\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1e75c158eb5d767d\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"97427ceb8606dd07\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"8613b4c64c5b5b21\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"603f866c7426a7fa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"a4a0a4851021c3f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"2d7df48160fead78\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5605b35ed5767b1e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"c8aac311e6040194\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"6384dabfacb9484a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"200e21df7f5c9055\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"9c382bb20af59a4e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"374c712e01517c96\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"80e7d9fdf2e63388\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"e1223bfd540d4f7f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4a03fa78fc1f1f0e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"23b8325cbc64dd41\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"86b2c12dc7df4cc6\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"36b5a378fe9d453e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"f57a1e5ae61af603\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"7359cb4f9a80086d\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"5635f03d55f33f56\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"69f66ec8f0c0b33e\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"6736587fa937bec6\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"37571586d147a477\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"1654453864e93b3c\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"554a0f78025f3f01\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"2fdddc492632d07e\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"a033f19e91fcd803\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"a3d243ec6040b359\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"a4552589b778acf6\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"21aedd874c512aa0\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"1cf5f02c5f15f376\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2ceee4eae58ca045\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"581f0d5ca0b0144d\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"a0d77f4829a35e93\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9fb986ae84589e10\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"08ae7b1a1de9beb6\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"755d1b6b55463570\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"95a183001d18e5d6\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7791380abbd26d80\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"f937247fe8d866cc\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"7f3f7599feac181d\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"ff70cee408e70e7d\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"974606f141f93f64\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"9af0b1f74088bd26\",\"/knowledge-medium/src/plugins/alias/index.js\":\"02053e55bd601fe8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"7f091106dc5d106e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"a5a5d325e6eca922\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"481809be78c6b350\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"832e77cd51021a6a\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"80255ff686fdc08d\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"14b5ebe1f0e20822\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"cbcbecc89ab6e796\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"d94eac9530ff6956\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"aacf62e0fd7a1786\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"eb887bd20a86b89f\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"09c2ddc3fe1a8fa1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"ea075fad50676b87\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"2466e8c1df1c2525\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"0880b68477d825cb\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"7a02ad347e2210b3\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"830537a62b1a979e\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"201205c5a45d057a\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d204b4df5b0cbaab\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"f60e6afde2acebe4\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"f474af0ff1f36327\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"375914e6276b2e57\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4d5ec7ba63e2921a\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"c002251ede322eb6\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"0a0d42314ebb8cc0\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"8ffbf39ef37efde9\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"9b813f7920491cda\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"4d11a0f9f8ecd2dc\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"0c543673e3309293\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"1e0001b4379037cc\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"aa1c9a88780588d5\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"22101426da8b2dd6\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"bb05c1d4e1c11caa\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"44c3d04e4835deec\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"3ae5492a3b973eb4\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"ee4e2d1339b2c188\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"91780eb625e66297\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"cc96cdef8ef62b6d\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"750ec340d6e3c99b\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"31d9942cbf3d50ed\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"14ebea4b14dfd540\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"93a3d49816e1205b\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"531e62050397ff1c\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"74518d4d97efb6d3\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"b7abd49154f75bfe\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"2e2a1a3d7d310cee\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"692f32e9b67bd752\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"b9c963ee8a5d2252\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ce41190a8d35de63\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5dec8d47c157add4\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"779cb4fda1c34d9a\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"01487be2616101b4\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"73caa386b8c51c6b\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f9f683acbf840814\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"4270e290a1f98ddd\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"1510b4dbc3ab09fa\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a5bb11d8c599521f\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"9bbda540dfead36d\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"0051fb696eae491c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"003375f748bddf90\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"5e18bc86fe3bb3ce\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"331da0fc3e8fb138\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"be77a34bd9a0b3e7\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"e2301b12010ab084\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"704bc3ad3b64b1fe\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"853f15534f04cb02\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"3c14554feafcf2fd\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"d29faab7ab0e9990\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"0a86c22a381d0f98\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"e89ffe0913d67a79\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"e41ea765845f81dc\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"1b30d65aabe352ca\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"a41279956b5bb715\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"fbf94e71612bd8d5\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"4453779a547a6ff3\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"23422e640b30380d\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"9cbbc4fc6ae86f53\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"a7e8d6aa5906490a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"b88a6340c0c1993a\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"5fe8109171fd1cfa\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"5b501f99114a497a\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7e6a8c64750f55a6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ec8e392e2314f28d\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"797610ea98f5b80a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"d49057e3b161a648\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"0c8b52aa8b2c36e5\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"d232fcba0375f6be\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5dd32c401faf466e\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"da239a29c436120b\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"03a1c61c32fdb3bb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"14495f0d2922d047\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"109c6efeeb885daf\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"a7865d791bc3df10\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"818ed2e2bb489628\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"8062e0b0dd35aaa7\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"f3983c092af3bc8d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"42a681e966b880d7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"792cbaf22226fbe3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"f036d18e778a52b7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"960749c7ffb18ecf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d930cc9491237975\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bb63dd77fe1968d1\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"54886b63126af438\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0842bd44c4fcbcca\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"7d58e4d3abd7b0aa\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"01b2f42ed0e238f0\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"fa9dca7333185170\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"7b7222b7f7bab101\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"2a5ce7ce44b0800b\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"b6c43ec1b470c4ec\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"36d6ca2ddb5a458d\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"392dde1d986484ea\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"0021b1f150a4e4e2\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"bb7ca6461039a26c\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"62695ebcbac309cc\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"adcfdf9bddf3a890\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"232b74ae8bd0fd9d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"7721bce3f9b500c5\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"2fd6784db17ab228\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"1eb727f513ed9ea6\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"b7d30f8999d6fa3a\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"94b1ade902c424ae\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"17aa2469a26af4ec\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"de864c040fac251b\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"48fd8056ef76fa07\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1398c28e6a8ebcde\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"b7ed4021dc260c7e\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"4cb99ac80ac07f46\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"480dc849fe3d023f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"2e1cc1f684579606\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a4174f5c3a00ab99\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"7f45b887c3e87aee\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e3bd483c89683584\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b0aa74c74273a105\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fcfe34fedddca7ef\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4f96afe0569edaac\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a0bc1489347a432c\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"04bfb27c501c6616\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4ff4be61caa26e25\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"333c4f106d12612a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"09f7d48514c69804\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"e29901296bd09913\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"8b259ed868fb2d9a\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"007fd826423f5a92\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"200f86b98c8d14d1\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9489d6cc6e0b1b3c\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"396c3427a4f24ae6\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"949fdfa754aec9d7\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"452cc9f5880e1b51\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"106cbc87ca97c36c\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"312cf4b93ce6e021\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"08bc6f75098cebb3\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"7eb27e2cd8be918d\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"6243f74df9c94727\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"51f12be1a126aaef\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"6b27ad3bd37222c5\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"268fae041f1d5122\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"495908fdb23fd43c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"7b0c0a0ed487784d\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"55608806846cdf67\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"9179c2e3178c3067\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"6fe0e4ed563df1f0\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"bec8c6ed42c4e5a1\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"918e476fee0bdfd2\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"d37513a5e04d1392\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"d8b6bdc0942ed700\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"c086d4a668816e8d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1c29e8f5369cb776\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e205dd54513c3b56\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"bcff2ae01372d314\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"67defc4fb0dbf238\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"61401e71176fc901\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"2a455a8bee0883ec\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"b7c922d5b373b963\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a84022757a2afbf4\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ae9bf32a426f3663\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"745933d26f7c6449\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"99400956a44c378e\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"a18326d2397713a6\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8bf4b609e8a6a957\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"3ae28ae3a1abec98\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"ec896f5056d51e3c\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"8dcab9dd734917a2\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"4e9d8d41956683e1\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"02e6f1db082aaec8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"ba9047f8bbe76471\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"44502e4d59381247\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"02aed801c9414d52\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1db4ba03b61fc019\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"cd74385f409106f0\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"4510e44bf3c4ff51\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"14ba69801cd65422\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"642ff2abd89ed343\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0eb88c62c72c534e\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"e93ea6d10fc50c8d\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"6a29743da87ed40e\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"d129616b588ebaba\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"c6e27f16683460af\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"1c0a1c706c4071c1\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8f8062c1bf985965\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"40bd9fd0f7d48f7f\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"807cc0b1e1b58bd9\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"6d8ecaee02364af5\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"0facb8bd6e459f3d\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"fea5e1bdeff70c3c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"d42ca7eccdf22217\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"e0bf4960a24c2683\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"837ed8f656618141\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dac69e19abfd1862\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"b7dca530ea459d5e\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"03ed38a6bfeef67e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"a6151b41e4918d8f\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"4960ca4d26efc79b\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"16eae9b4ee3f9ce4\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"06b27e790c075966\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"034e707d70fe353a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"41d2e885bfa7a9a5\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"fc138135414b8427\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"ce3988c2a0d6a2fd\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"0748664a14f72032\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"42c2a5b316a005c6\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"cfddd6b8f736a3ee\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"01b7d4501f2e5186\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"15591c62864f8daf\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"2f6b4cb3918bb430\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"4d0d2e2deffceca4\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"04761764623a166b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"e1aab16110e19b52\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"be1e109e41c154be\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"d63422728892de1f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"6d4ff5a8be028232\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"7ca4b1fe22c85d16\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"3cc5521c1e10e785\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"4867b0820488e4bd\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"5973c8faf0881973\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"f91d6afc61fe520b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"eed21463bcedca46\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"039ed52ddff2e746\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"1ca9be495e9e35bb\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"529093567256c619\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"985404c71befd4e9\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"5a22ae7469589d58\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5dc5828aa9a01cf0\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ed7858c88a59930f\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"c7caa969b0aebc16\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"be7b52bdd04ba788\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"65b6d4edca487822\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"569c011d42ff2497\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"41129f55488ad933\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"3e9a8ce53ec4a2a4\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"b171c6571a0585b6\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"34a8d0a792adb596\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ee28dce6ccf9a160\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"f1a8c1944570230a\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"6a9ff8c3a4f1ab42\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"a6c97f652c781df8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"88295182bb107846\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"5af72466a3b6257f\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"606179a072eeaff6\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"db5214928b90dab5\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"e2f943462a655221\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"272ff16de6ab092e\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"c03d5541fb712e5c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"3efdc6379e88d81e\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"f44b9e3ff767d51f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"ba65b09649ac3779\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"fbb098d36872b726\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"7df82fc82663f25f\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"8d6fbb617bd752b8\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"42e901646f5d12c8\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"ab8501ee3193e137\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"2ac123bc1a22aa32\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"1983c4c8d9cd1b05\",\"/knowledge-medium/src/plugins/geo/query.js\":\"3d78ae82591dc6e6\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"7b7047dd46ca8b74\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"05397d766628658c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0a42d31c831cab9e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1bc756c942ec2dfb\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ab0086cbebe9dc73\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"358b9ae939302960\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"d4ff08b510366f8a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"ba82f3dbff4f1bd9\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"fc381ec5c2df6c78\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c3029a42665cd3eb\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"82df7193e6d55810\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"5840e6214b6bf4a1\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1163d0e852faa198\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b0d5c0e9dd03ed8e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"d6139397808d84ef\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"578ad6fe73a4c193\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"5076f742f5c2d5e1\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"e24b95a4b813782b\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"0452a998ef6046da\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"0148f697e016c5d5\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"63a091b82197a8f9\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"8c5d7f56a21bc9a6\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"27227ea41a0b8e4c\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"0b19f3eec70dd8fe\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"8ef4cfe0bd163d38\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"9762ed0ef18a85e3\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"833cbe405b19d793\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"60d0dcad29bde053\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"14d460e2237d0efe\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"5d64c4356158644f\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"b8f93788845b1629\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"b691bd1f4039fe44\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"abd16f6b6342d1fd\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"43af2f2c5b69dad2\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d245e6118f15705c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"93358770ff82393c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"d575da21005dff09\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"4507c3d446cddbc8\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"fa147d06ec5f954a\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"926323b9d737038d\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b64b5e772c2d198e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"154038e212edbb9f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"652605f171fb94c9\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a1f3da7edcf8d872\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"131554113ec6a49b\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"af01d7834f809be5\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"9c930f82d0451752\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"794128577fed6dea\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"8a4ed32c7420dbeb\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8c2e6c56cdbbb19f\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"05456ff8ed93190a\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"f18541b40ae7318f\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"ee8fbf08278bfdbf\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"25498d3a87801c1e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"da33399126c1126a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"cec9f05e80c6acf1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0d39f818f6c0d0b4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"ed4504ed3a49a5a4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"b004a58e7449a100\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8a2ae013cfb493ff\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5888dd0f88b8918d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"75b4ecc70cec1112\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"07dbb43c13b1f94c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"e2271ea56790d05c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b3e5b2790d8934a9\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0836c3a45df47172\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"6d5c37fd50c5ac2b\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"9ea4e28f113b7f02\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"ca3ec53a78830d61\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"f1ba3d5302ea3295\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0de28058a4f2ea82\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"701b0de39d49b2b5\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"f7ab4aef358413bf\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"6b8cf15e8ceca822\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"2d24b3a41bf0f1b6\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"c08714c0b4b9055e\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"7157bdd991651d00\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"fcf59081d0fe88c3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"82c9e9c43e5d0e20\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"c06da1646eed661c\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"be60cecffa9d3d18\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"2caef4355580a26e\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"f72f7f46a5bf67b9\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"da663a49afd546a1\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"15926993ef418679\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"6ba7b4fc210f1b0d\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5a54e9f3ffe8d6e5\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"b0ced8615ae4c57e\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b3df83c2f21f7ead\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"da3016da12a77cf4\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"39973c1a590c8b9e\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e60e59543365c48e\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"54f0c7abc812bd36\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"1378c67eec626adb\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"76ade3ba8e6a322a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"190dc635c87fa5b5\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"6a14b50de9e2b83c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"c55930bc327ef703\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"0d8f6440c92e96db\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"204046ed332857d4\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1acc7cf55c74af80\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"c39a7ce261e509ec\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"22b9aadc44d9a5cc\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"97554238433483b3\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a3cd99947dd059a2\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"d52b35df4ebe5763\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"a5ac99ad569c3993\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"636678a6b64fb40a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"d11c71f5d12c07f3\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"7690db935e955896\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"08f70ec1e54e0372\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"c73ce9808c3029ec\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"f94b01af71cf3ab9\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"d5b65f1c680a3142\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e700cf8317a5e295\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"886ef1ef2a9b5c84\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"85b310c32664da78\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"cd0bd6f28be6690e\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4563044f48a59563\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"de330802c18b85ce\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0e98e578b4841084\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"0b5d60c231d0787d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"7c9e518f85be12a8\",\"/knowledge-medium/src/plugins/recents/target.js\":\"0c45ae3aa452ea77\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"76ea47d5d4189917\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"e19ed4c99e24ff37\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"510d40a7e86fbde7\",\"/knowledge-medium/src/plugins/references/index.js\":\"7532ca8e22a52935\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1dbec35754a64cc8\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"79e2e5c2f9db01d3\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"71588ded4019f4b2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"72cb9efa7211a983\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f5ea43de62026b8c\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"7fbea5e2aee674c6\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"d27a2abb005ffc1b\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cf38b468f91b6dcb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b62afe903d184f6f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"2d5fc8dd26b52bfc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4a84ca1422f5e6cc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a1188d59a065540f\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"cdfd8ee3a94bcc33\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"90ee230554ba6600\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"15fa935f23653172\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"98ad59be2992fd57\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"c1291eb4eee357c4\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"91819d014c387632\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a5761493b88fe369\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"747e67a5e9cb9204\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8bdd2fef78289ab2\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2d1673505a040c8f\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"d9e506733576c614\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"6c6f344906878427\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"1848abc88dda499e\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e1de9f3f8fa2ca7d\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"5bee6411a6a12d8b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7f11fb1101ff46d7\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"2f880aca8c89b4da\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"69dbaf728bd5bb96\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"2702d271e34e6c59\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"6692c835fa459807\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"015943bb7d73bdd1\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"beeaeb860ee66d84\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"a11b35cfadd3d931\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"fbbf9c9b338ed71b\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"726b37d7486cfc5f\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"e8d55d43045d7123\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"27771e7617c0ae2e\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"de1c4c2ef552f3d5\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"0efa405f64877e70\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"e3c12fb0a1dc922a\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"864812d83bda35a5\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"ead1852bdf68f117\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"112c554ad8d260e3\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"16b6d9aeeed7f896\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"85957f542cc9ba15\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"0c4fdf8eac2aac21\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"69eda53cf4f1a84d\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"568a39fe37844a8a\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"0c09e4ee2e21ae95\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"35705be7b3ee1b9b\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"64b34ebbfeb0d93a\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"3a2b5c1f829effe1\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8b3fefbb8a12765a\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"1b3880f8abddcf7f\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"bd8fb44f2ae0a5b7\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"66b5d831ef69ee1a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"b7243e6a44103a5c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e7defb191a7a30c5\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f3eb4389e160eafe\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"a882e96c1437f4bc\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"4b3f0e32888161ec\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"2248ca09a6320d22\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"54afb436a1166dff\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e5b66f7afb868b5c\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"7fe0fe99891fec6d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"240ed2f215ee7406\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"ed2b7e4439e9f488\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4d2c1745ce17202f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8979de764bb223fa\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"8cbf7b7112351471\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"bfbbf5b4043b5ca2\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"eb2e4b7330fbcc65\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"eb07b36d362b34d7\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"98415b17a43d78a2\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"481b358b81a3a2c3\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"36598ea8c748638f\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"cb6a02e2bc5d222b\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"a762306490f0b98f\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"c354e59ad840f979\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"25f6038ad6af38db\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"4a7ee76fa4e89efe\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"4e1f52b0a669efc2\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"80d570bfe2a1af86\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"46e254fbdd3a2c31\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4eb0353fe0151faf\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"23b58c2b5651c127\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"e234f581d11ee776\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"5caa2b9d7c900d3d\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"3efa50ed9b2a1d4a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"97c9a0893c54fe53\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"76fa934258e6de83\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"baefd69a381b96c6\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"98220e2ef4e679e9\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"8aefea4e997c5fbf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e0560ea5252e8a23\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"253fa3ada9661113\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"58b7035bc73aeac8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"e1bc2e29b5538c5a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"d955941d05acd232\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"eb40fca09726f2b9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0a13a550049bee83\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"84a9211163d31584\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"0bb840886cf8936c\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"efd202680a482aad\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"97170daf9b798972\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5011ead2ea72a66b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"430cea587f07013c\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"e5af590f2249743e\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"14d02e74cccc673d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"5fc3017bd91b73fa\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"97568818a50c046b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e19d28b0b1a2bada\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"981a7d064e0466e3\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"16292e58d202c88b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"efd0f8a7336314fb\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"14d4f47c51a5eb7b\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"46603ec57d02701c\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"5c2ddf30b913a158\",\"/knowledge-medium/src/plugins/tables/index.js\":\"50edc88a22bb5c37\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"81d3fb5b866b4a65\",\"/knowledge-medium/src/plugins/tables/model.js\":\"a4e714447cab99fd\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7cbebfde91b5b48c\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"4efa22e914deb841\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"d614c11853d85ec8\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"9089a54bb8c41d7a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"30118d8d453ec291\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"22ad37cde3b50256\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b73a825b8e7ce4d3\",\"/knowledge-medium/src/plugins/todo/index.js\":\"b12bc3348fef924b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"ed047aca43902083\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"078e860c5ada09c9\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"e5a427755c6390a1\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"1046a0de536c1a90\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"8e4d95915d31f8cf\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"e1a5c9b4ca48446e\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"645de2fdc9ed0c44\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"bfc370e8a14e2f32\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"fd9af37e14799e42\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"033be8e47ac4ce19\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"76ba7ca0ba39ea2d\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"e45e35949e01cef6\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"d486d2dd14984ec9\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"3b21f65726822d6c\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"2013d400e8ca155f\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"30c225937daec9b2\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"844b77f56e7caf5e\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"780b59e0ce1c6b19\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"f38ee701e3d113e5\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"651789af7780a995\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"78a5608824bda311\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"8c025650976b75e9\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"4cf6c3d773e5e39f\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"51551105d00e2b6a\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"abaf979fc03bcd3f\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"17bce74da16316c2\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"d452bee931e0b9d3\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"d71a6906d2818878\",\"/knowledge-medium/src/registerServiceWorker.js\":\"566a0b84d48fba7e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"c886bd66d5619930\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"20b9a3f92648391a\",\"/knowledge-medium/src/services/authStorage.js\":\"ca016b35a5b08913\",\"/knowledge-medium/src/services/powersync.js\":\"ca754419b3f8fd35\",\"/knowledge-medium/src/services/supabase.js\":\"9b8bdf151339f7b0\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"507631fb70781340\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"1ca9d2ec961e9535\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"0eaa4e932a8ba8a8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"84b320b47bd3f1a2\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"adf1d9f049d833a5\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"a60db3a870dd68ad\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"1c3fd16f12de43c6\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"93fc872c0aafa607\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"45aa235f47faabfa\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"1d2c0496f7ba985e\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"6a9563fd66470390\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"997bd0d71d59029d\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"d55f19d48c87b002\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"3a7e7f6ebb2ab95b\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"ceafb30e875bbc09\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"32377fdd0f4a8508\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"325643e4b5b1479a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"a6fba5043bb23bde\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6252bc25752dc825\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b81ca4a350daa7b3\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"c8b749fceb7a843e\",\"/knowledge-medium/src/shortcuts/types.js\":\"6437aee0a4eb4c15\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c5b0254ff8a69b31\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"6c8f5d7ed519746d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"602d49d35fa72ff1\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"7a994b9d805981e4\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"facb32bef0dfeff8\",\"/knowledge-medium/src/sync/byteTransform.js\":\"49660552bff8874a\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"a11df95fd1b6e5c8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"0fa696bb986716d4\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c2b5648b8bd98c3f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"c762dbdf2ec7d35c\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"6a453cd68cec453a\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"2ef49dc53cba519c\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"de3bc2ff041c1073\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"d732ad46e3ab6068\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"455f09824d6dfed7\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"19825a74ae1d15b1\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"2ec433bb558825ed\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"70ea2d6f1f9e1dc8\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7e86a610ae41ef29\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"7b531b53c9707e6c\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a97e313f3350c08d\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"3fe96c2cb98ff631\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5b36e8e4df04f01d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"2846a54803c3c981\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c59323ccf51b0b6f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ffa4e306779a4aa5\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"63191e41b9ff5dc8\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"3aeb265702417f8c\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"44e9de048bff67d2\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"84ec1e8a0481b6db\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"6e6e2e29a47959b8\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"731f7bd0821801f3\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"a002541f8d6fcc1f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c3e4562f961b8e24\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"6934c7bb2186f5c5\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"f24f5e74d2079fc1\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"2f9cc6d5e51de1cd\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"20d08dba06aff64d\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"df81f9982ba31f7e\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6ded84d715fa1a98\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"260b09e1d05f245d\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"a6789134f7c898ac\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"84f2e1bbe11a43e3\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d3a6983fd6cbd85e\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"eb709034cde90cd1\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"224fdc7558a1668d\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"b0eec846ef7ec217\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"6301ba6bdf51511f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e47679fbee7f952e\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"f371b5d24c5d7e6b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"7e191665f1815d97\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a5bad491d59de2aa\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"710ee36f1e245f2f\",\"/knowledge-medium/src/sync/transform.js\":\"b28c1129acfb2b4d\",\"/knowledge-medium/src/themeBootDefaults.js\":\"9728ad2586697139\",\"/knowledge-medium/src/types.js\":\"996b1b6735bc4a7d\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b8e290578434137d\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"af8222ee3e43db5c\",\"/knowledge-medium/src/utils/array.js\":\"3b1ab4031fa29b08\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"ed48449e153b6b63\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"0284111fcd7e5e68\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8d5b37adf79a8d6a\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"351eded6428f00f4\",\"/knowledge-medium/src/utils/callbackSet.js\":\"c8ba0c3e1753c80c\",\"/knowledge-medium/src/utils/clientId.js\":\"22ecb631e25ae84b\",\"/knowledge-medium/src/utils/codemirror.js\":\"4b174a771ef39d89\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"29bcea784f3b7cac\",\"/knowledge-medium/src/utils/copy.js\":\"15f58115279dc71b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"de72bfdef2b334cb\",\"/knowledge-medium/src/utils/dbForensics.js\":\"e69746a3a07447c6\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"ea50b4e8ff539103\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"89a9a3ef54f543c5\",\"/knowledge-medium/src/utils/dialogs.js\":\"ff2d21783f57da4c\",\"/knowledge-medium/src/utils/dom.js\":\"a63d5531809028de\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"198355145db199b9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"18f65286bdd423c0\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"1f6bd2953a50958c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"7eab7c482575a46a\",\"/knowledge-medium/src/utils/fnv1a.js\":\"bae80d41caba4708\",\"/knowledge-medium/src/utils/formatBytes.js\":\"d0776c4181e51005\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"5cbfa48ed432e9d7\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"b9638472274fa9b6\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"cf3762b835d8e80c\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"01b1cc9188023d76\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"10cf3fb06c61cbe5\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"8403d674a0f52b63\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"284ac61f23de75dd\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"fef24455a4c35929\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"853f9c99dd3c809e\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"4795f9bdcb0e0741\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4bd5495929de2244\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9f71098e8ac95189\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"0e60b9fd08f24c37\",\"/knowledge-medium/src/utils/markdownParser.js\":\"5665f704a7dacc9d\",\"/knowledge-medium/src/utils/memoize.js\":\"5578739e414be9df\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"25bcadec3d4cdfb4\",\"/knowledge-medium/src/utils/nameList.js\":\"ec30325e87ff9959\",\"/knowledge-medium/src/utils/navigation.js\":\"90f105038ea81434\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"23e15f48c3d94d88\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"c7c7ea67ca6c1f35\",\"/knowledge-medium/src/utils/panelClearance.js\":\"8d531b56cfe8ca04\",\"/knowledge-medium/src/utils/panelHistory.js\":\"67cbd7861b63a6bd\",\"/knowledge-medium/src/utils/panelLanes.js\":\"a135116a276f0fdd\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a85a1c1058d5600c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"dc795f70469ef570\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"b74e68fdef91d2c6\",\"/knowledge-medium/src/utils/platform.js\":\"44572f957b8e77bb\",\"/knowledge-medium/src/utils/pluralize.js\":\"5e0b97c91f939f2a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"d19c0b8008ad7859\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"461ea1ac45fe9ab3\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8ebb4a2118af55b2\",\"/knowledge-medium/src/utils/react.js\":\"f9574a3082276cc2\",\"/knowledge-medium/src/utils/relativeDate.js\":\"844705eb83d8a77c\",\"/knowledge-medium/src/utils/relativeTime.js\":\"5cf433ad4dd4f83b\",\"/knowledge-medium/src/utils/renderScope.js\":\"2fbe2c43a8deae8f\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"b323c8114259523e\",\"/knowledge-medium/src/utils/routing.js\":\"15f2cb60cb69e90b\",\"/knowledge-medium/src/utils/safeMode.js\":\"506156e65af54c2f\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"123a3fadc622ae3e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"95e7fd5f28bab53b\",\"/knowledge-medium/src/utils/selection.js\":\"1d8ccdceddaf2ba5\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"ac74cc8db848881f\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"a6ba26e3b6418dc3\",\"/knowledge-medium/src/utils/state.js\":\"926f6054bd6492a1\",\"/knowledge-medium/src/utils/string.js\":\"0d0b23a967e0d2ca\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9dedc74c0972b4ee\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"89e1e50bede9a319\",\"/knowledge-medium/src/utils/toast.js\":\"591ff440646673bd\",\"/knowledge-medium/src/utils/toggleStore.js\":\"e9da5cc49792cec0\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"e1757e6e4fbb3fa4\",\"/knowledge-medium/src/utils/userActivity.js\":\"1604a51f7a9e315b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"33821f7decc17a8a\",\"/knowledge-medium/src/utils/viewport.js\":\"3caa046226f7bbfc\",\"/knowledge-medium/src/utils/webLock.js\":\"5a91abb2623ce304\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"33c39413f881952b\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"58cedb49f3c168d4\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"8f5d3bd67e681498\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"15dcbf4c87f29e1b\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"d8dd58cb281979f0\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"aa45d53eadd9431b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e58ce1662c6eb842\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"029ade8a3880ca08\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"a2ce4bf43c1c4739\",\"/knowledge-medium/src/vendor/react-dom.js\":\"d9753f6e670e4a34\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"d1e700e6bbd25df3\",\"/knowledge-medium/src/vendor/react.js\":\"3d6e7de1bfaa5849\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
