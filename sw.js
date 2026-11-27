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
		buildId: "a62e16390422-5a883424",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"35a504b4cf831473\",\"/knowledge-medium/index.html\":\"35a504b4cf831473\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-ByOIzUI-.js\":\"8b8c60f2859b9e37\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"cb0e025cee2af7b6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DwewA-Mt.js\":\"180c51bd591d5120\",\"/knowledge-medium/chunks/FacadeVFS-a2P86at5.js\":\"79d0cbb44c7b2636\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-aRwA9qaL.js\":\"4732756a0004f8be\",\"/knowledge-medium/chunks/MemoryVFS-D7kcg5_w.js\":\"dacdaa4aed46ff21\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-C7UCEWEE.js\":\"4f05e10ba2a33ae2\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DbXUp9Dj.js\":\"dc73742c3c18f562\",\"/knowledge-medium/chunks/Preview-unc1v2Rj.js\":\"3def3545a34ac2b9\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-ByNSqhKJ.js\":\"699a615db24e4492\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Cy52V2Jd.js\":\"5aaf36ae710b1dbb\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-7iRfEknk.js\":\"5d442d73de5aa6fd\",\"/knowledge-medium/chunks/react-BEUEuMC1.js\":\"d161bae17d478341\",\"/knowledge-medium/chunks/react-BKTmohSI.js\":\"9cb8f53d41d249c7\",\"/knowledge-medium/chunks/react-BxPkrNiW.js\":\"cd2111795cc14282\",\"/knowledge-medium/chunks/react-Cc0S6u10.js\":\"59bac953a767e778\",\"/knowledge-medium/chunks/react-DbB-FyNi.js\":\"809b6a38cb29ebe0\",\"/knowledge-medium/chunks/react-DmmHjTnZ.js\":\"4515563510e67f5e\",\"/knowledge-medium/chunks/react-QdirAg45.js\":\"991d09aa8429a8df\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-GVQxnPGB.js\":\"082d7898fc9c89e7\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CmNIkMvN.js\":\"10d83f851dd95c27\",\"/knowledge-medium/chunks/react-dom-server.edge.production-plazvrnm.js\":\"4c251c7de9336fcb\",\"/knowledge-medium/chunks/server.browser-CP5QlOgQ.js\":\"f0ee5f0abdff6378\",\"/knowledge-medium/chunks/textarea-BeCo7xRw.js\":\"c17ec0eeb2d60065\",\"/knowledge-medium/chunks/ui-Bc1MB-YZ.js\":\"20ade9118b5cfe94\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"77796a3bd58a9217\",\"/knowledge-medium/src/appUpdate.js\":\"1d4a9d718175a9b4\",\"/knowledge-medium/src/appVersion.js\":\"8f42a0401418b61c\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"4b7375bb23ace754\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"7032c457ca08210c\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"78d71f637fbcf64c\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"8b82d19e2d2f7edb\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b44666ca0cda73a1\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"594af621d272f40b\",\"/knowledge-medium/src/components/BlockEditor.js\":\"950d410cd74fd789\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"8e2057debdedab51\",\"/knowledge-medium/src/components/BlockProperties.js\":\"65089189388e0526\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"92a2e6576a8234be\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"e2ab775027a6492b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"b3c476a7a4822860\",\"/knowledge-medium/src/components/DraftEditor.js\":\"137f8554922546c9\",\"/knowledge-medium/src/components/GutterPill.js\":\"f2bf638d73195c2a\",\"/knowledge-medium/src/components/Header.js\":\"9054be8520d8bba4\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"5d68fd854f2328f6\",\"/knowledge-medium/src/components/Login.js\":\"7a7fd540922560ee\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"6b1aa3ba121a63b1\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"3635005d2053ad64\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8cc703b5ec6f0734\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c9996bf7c328e964\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1566bb6113fb8752\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"7fb3539e269e9ee7\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"91e788170884da70\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"064df0274a91940e\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"bae8d9e0addf3831\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"41ff5805e6dd01fc\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"5a7c36f16c658fb2\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f10773bddc7cdff9\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"709fa1a6ddcaa136\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"1c3d9d9afa67abe5\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"54ad96d6952654cc\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"73194da5e36d2849\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"5a64edbc0ac0ec87\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"208702b37fc95666\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"173d9b37e35125f7\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"fa5f4dc6a4adbbd7\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"9dad853cfb26b5a3\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bf6fc03bf8b470d5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f9e89d553ab16975\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"629f8f58fd96b0c6\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"72521e2efcfb3db8\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"f73b3c550cf85ba9\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"928cc970993a0c6a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"dfdb1766be16c802\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"6a9e812e1e02d805\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"e4991a92fc59f9aa\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4da9c30d331cec96\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"ad12b7981e338af4\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"7ca424cdc7b2cb4f\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"b3585dfe1a49a51c\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"2b135aef0f73d0b7\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"005c1c2a66de966a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"61d3a55de0f3fef3\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"ddac19a8be93b484\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"33663e5cbe3bb946\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"ab0bcfccdf302191\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"5c00ff9ff192dfe0\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"19ff54173eb3eb78\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"dd1df0c390d2ad1e\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5495edaf806f635f\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"90f240e4ad26f9e0\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"f33cc606807e227c\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"19ccd98d6f386e85\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f278bfe652ce1f75\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"74314cbc2dd9b032\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a95c96e7563eb4a7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"de5d2634f964a019\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"389fb94e2af82ea0\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"eb558b0de40493d9\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"79720e2fd734d3c6\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e41c1c56456b55c3\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"0ecd7acbbd3051d9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"67cb256d83ceaff6\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"bb628dd6577af3ce\",\"/knowledge-medium/src/components/ui/button.js\":\"8a2c154bc3d80971\",\"/knowledge-medium/src/components/ui/card.js\":\"a306ae6d97075940\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"0f9c6c7d63483add\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4da9e6984580014b\",\"/knowledge-medium/src/components/ui/command.js\":\"bc3b3bff0306dd60\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"92f789ffec27579c\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0cf6b72caf399286\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"7bc4c2711ed7734a\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"0e87af0a915fa9c0\",\"/knowledge-medium/src/components/ui/index.js\":\"fd3e01b9ffa6a4aa\",\"/knowledge-medium/src/components/ui/input.js\":\"6dbb8215ee2b7066\",\"/knowledge-medium/src/components/ui/kbd.js\":\"c88e80869ce1e0ad\",\"/knowledge-medium/src/components/ui/label.js\":\"bb36a91b50c1b629\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1d63266c50da93bc\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"6121e629408aaf68\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"7a8dd23a90af9f95\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"b630ccc3a579d0b6\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"083dc294a5a27f50\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"fa6dc96a35c01624\",\"/knowledge-medium/src/components/util/error.js\":\"341c71a3644d1ebf\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"10bdac3515922547\",\"/knowledge-medium/src/components/util/suspense.js\":\"801a536950667f38\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"ab803fb45a255875\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"196cdb087bddb2c5\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"f82ce4108fe4fdba\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"6f6143f087fcd33e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a7c1496381e8075f\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"87c5b963dce81e76\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"9ae7c1001fd06330\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"04e0901351b5361c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"91fd3b63e547374b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"41daf9dd894f35da\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ec64290634350eaa\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"beff946412d185cb\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6af730d22bff2a0d\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"deb88c687a409649\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"5a8697787ba8bb08\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"be2d4bda2456d410\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"1e683e11a74baeda\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"5b7b51f19861a108\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"5d487882d88283d2\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f64fe7fed6ff3000\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"ef842ed9e355c3f5\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"76e1fad8b343d2c3\",\"/knowledge-medium/src/context/block.js\":\"a9e8947fa7134707\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"1c1c40a434a40481\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"50ef8017e44d9ba7\",\"/knowledge-medium/src/context/repo.js\":\"389179fe552efc16\",\"/knowledge-medium/src/data/aliasClaim.js\":\"53b6d37505af8d93\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"ffd0c8d3201a83f4\",\"/knowledge-medium/src/data/api/blockData.js\":\"4dca05bd3f678b09\",\"/knowledge-medium/src/data/api/blockType.js\":\"ebcb9c1b18dc2545\",\"/knowledge-medium/src/data/api/changeScope.js\":\"7e079eed8de35f1e\",\"/knowledge-medium/src/data/api/codecs.js\":\"cbce9abb1523e285\",\"/knowledge-medium/src/data/api/derivedData.js\":\"cffdcd16b83c5514\",\"/knowledge-medium/src/data/api/errors.js\":\"cd9a2c07d8451e6c\",\"/knowledge-medium/src/data/api/events.js\":\"da25cfc3ae9ee435\",\"/knowledge-medium/src/data/api/handle.js\":\"99edd00fda56d0ea\",\"/knowledge-medium/src/data/api/index.js\":\"32765d990650b4e5\",\"/knowledge-medium/src/data/api/mutator.js\":\"65c0e28d983223f1\",\"/knowledge-medium/src/data/api/processor.js\":\"9421fbad92feb83d\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"147e779708d71abe\",\"/knowledge-medium/src/data/api/query.js\":\"2a1ce428083f8b67\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3d276b210b91ce08\",\"/knowledge-medium/src/data/api/schema.js\":\"99edd00fda56d0ea\",\"/knowledge-medium/src/data/api/tx.js\":\"99edd00fda56d0ea\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"85a511a6e8fd5a3a\",\"/knowledge-medium/src/data/api/user.js\":\"c3b903961f05718b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"f57253539940d80e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"cd12e4f7377eee42\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"38c3ed3bf262ce7e\",\"/knowledge-medium/src/data/block.js\":\"3ca76be4c1420708\",\"/knowledge-medium/src/data/blockCache.js\":\"e5e7d6b396d35e35\",\"/knowledge-medium/src/data/blockId.js\":\"c9e78028a7c49730\",\"/knowledge-medium/src/data/blockLiveness.js\":\"6bfde36227723cf7\",\"/knowledge-medium/src/data/blockMerge.js\":\"e381b8d1b5032ca4\",\"/knowledge-medium/src/data/blockSchema.js\":\"02d4c6861282cded\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"688b8943402a2909\",\"/knowledge-medium/src/data/blockTypes.js\":\"f9c42efabda8328c\",\"/knowledge-medium/src/data/childrenView.js\":\"2d1612434a6dbb8f\",\"/knowledge-medium/src/data/clientContext.js\":\"22d780fd4d59124e\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"c17cf44dacb3e3a3\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"915afac405834e9f\",\"/knowledge-medium/src/data/derivedIds.js\":\"5ea82c26fbff47a5\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"38782be382ffe7f3\",\"/knowledge-medium/src/data/facetBridge.js\":\"390fc9c4b657f5b6\",\"/knowledge-medium/src/data/facets.js\":\"c22e9edca46f2c24\",\"/knowledge-medium/src/data/globalState.js\":\"05f9770117f516e5\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"0073de913ccbb931\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"04f8597d46db8aad\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"687d1467c3babd26\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"02848f02441125a7\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"20e948ad97747a9d\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"8ff1fe85a218c630\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"da69a0156691148d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"4cd78abd357cbc7e\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"f447d50e95413d2e\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"0bb8a7be7b6f2eeb\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"001fecbe59a38721\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"ce7d504cd38ef432\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"11858583d541595f\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"4f8ffa56ef88ba77\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"c2081c5792dd62a3\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"d939d2cd3c32f2bb\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"82efe9c4afac6b04\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"c79bcfcdb7309ea4\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"3539927fa5578c5f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"736876ed3aed2d28\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"d3929e8d42e18272\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"2d7098aa6aacc41d\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"07bbfc59aba241aa\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"5fcaa1666b8c2058\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8344f65c19f7b047\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"35531247344563be\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"9f2edf702e9d0395\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"1c0c6c8bc2cf076a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"903b026e57f7f1f8\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"29a4d6d282e2af20\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"b35677dd8a38df16\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"38bf5f64ad768008\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"173f26526a922ab7\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"96f21e81bfcc606d\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"58b37f61630aecd2\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"32fec8a9a69b0586\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"bd1ea95e895994b8\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"1af86d8d47c272fc\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"a813c22101a4de6d\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"4aa3018bb5a37c4c\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"51e00073dac57ffd\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"7e61d8fffc540278\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"a70a85521fced246\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"2adf1b0addc8cd4a\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"e746c9b653d1369b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"0cc454692860054a\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"b0a74520b9931176\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"299cac1bfe0fb6b1\",\"/knowledge-medium/src/data/invalidation.js\":\"286a85b5cba2c992\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"b0b19bb296c08ae8\",\"/knowledge-medium/src/data/kernelPage.js\":\"5175a14da88d41bc\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"a796f90ca398d766\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"fb2b163ca6d60ef5\",\"/knowledge-medium/src/data/localDbStorage.js\":\"267185ed2ead6bc8\",\"/knowledge-medium/src/data/localDbVfs.js\":\"214777d239c29da8\",\"/knowledge-medium/src/data/localSchema.js\":\"5990a2be92b60fe2\",\"/knowledge-medium/src/data/maintenance.js\":\"80f50785f25f9566\",\"/knowledge-medium/src/data/mergeProperties.js\":\"fff1047800f3ee64\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"01fad610afd85dbe\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6559ad4f30a29914\",\"/knowledge-medium/src/data/mutators.js\":\"76ee84895a029c99\",\"/knowledge-medium/src/data/orderKey.js\":\"3d56d8a97b40685a\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"7fdffa4a7ba07fc9\",\"/knowledge-medium/src/data/outlineSurface.js\":\"27da863c749d8d38\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"a07b0af320705c00\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"3f5ae6453b3df11e\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"b670d509067d1089\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"11013127d90fa47e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"61974064d52dd437\",\"/knowledge-medium/src/data/properties.js\":\"11668129f7e05914\",\"/knowledge-medium/src/data/propertiesPage.js\":\"3ac9ff11cadb6039\",\"/knowledge-medium/src/data/propertyChildren.js\":\"dc3b8869a0a40bb6\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"ddd01f266f3e46be\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"76590f8069c747ad\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"10a0f771061d329d\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b11c26b98af70cd9\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"61fc2851682c4fca\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"9d870720f3787a17\",\"/knowledge-medium/src/data/propertySeeds.js\":\"9eed712ac7fecd49\",\"/knowledge-medium/src/data/recentsPage.js\":\"097ea1b0c19a3e55\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"fde53fb6e73e5819\",\"/knowledge-medium/src/data/referenceBlock.js\":\"e284f7ca25f6db53\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"5137415ffb218c8e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"1ee737ec6ca83dce\",\"/knowledge-medium/src/data/repo.js\":\"4dff28f281b16459\",\"/knowledge-medium/src/data/repoProvider.js\":\"096658f9db40b576\",\"/knowledge-medium/src/data/rowProperty.js\":\"1a019b62d5715c6d\",\"/knowledge-medium/src/data/searchFilter.js\":\"e38f312432c0fec9\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"b84c7cce898ad052\",\"/knowledge-medium/src/data/stateBlocks.js\":\"b6125c3ed690efba\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"eadd60a685c87914\",\"/knowledge-medium/src/data/structuralInsert.js\":\"0220bd80a7da0a24\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"3ff01cac3dae6a11\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"27cefc229ba91b90\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"7f007be6dd9d3edf\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"7036b5b0945bf1e6\",\"/knowledge-medium/src/data/targets.js\":\"0711147caa64410e\",\"/knowledge-medium/src/data/typeColors.js\":\"0508e413902b41f5\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"f3a4e92859205f12\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"f6177592c611377c\",\"/knowledge-medium/src/data/typeExtraction.js\":\"921ced30eaa0dd5b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"25c3dfec1ebd2c71\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"717635f10ea1d5c9\",\"/knowledge-medium/src/data/typeSeeds.js\":\"ff3b4d86d77eeccb\",\"/knowledge-medium/src/data/typeTagger.js\":\"d24349ee5fa52b8b\",\"/knowledge-medium/src/data/typedRecords.js\":\"c433807ef2449b99\",\"/knowledge-medium/src/data/typesPage.js\":\"bca0c4542cff6819\",\"/knowledge-medium/src/data/userPrefs.js\":\"05a7712811192e14\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e1a9c4e5cb714a2c\",\"/knowledge-medium/src/data/userTypesService.js\":\"d6d4c5b164646a9d\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"4900d3f6cf97fc8f\",\"/knowledge-medium/src/data/visibleChildren.js\":\"da1069b412e84532\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"dfb2e739ac605f64\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"73df4196bcf56666\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"1aacea938de2ed15\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"c55f7980bc384640\",\"/knowledge-medium/src/data/workspaces.js\":\"4990491e5b934c40\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"e633a767d4ace7b3\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"127e238ad86c5519\",\"/knowledge-medium/src/editor/atTrigger.js\":\"5cc443123fe5fee9\",\"/knowledge-medium/src/editor/autocomplete.js\":\"a3a11ce2b40e2afe\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"ab60b3e83ca48531\",\"/knowledge-medium/src/editor/contentFlush.js\":\"b7c913fe96593690\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"61461c41ab9ab548\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"e644fd54f84dc2a7\",\"/knowledge-medium/src/editor/insertImage.js\":\"3b1a577b29fb203a\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"124a1b12720ac3f5\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"bc065b6bf2f7f8ae\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"7c7df183008da88b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0e8eff6ec629ba72\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"1ae10443cb0fb97c\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"0b447eb0e2d8132d\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"0e88c9a539a99b71\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"aec861488945fc3e\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"d64b168ab8ba4e34\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"a3af8d5d48254301\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"1fb77ca4b8b6acf0\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"9fceaf158ce182d9\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f10a5c9e6b1129d6\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"067db8779538a770\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9975475b39a06a47\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"24b0d17bf3608a3d\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a58907a131dc44cd\",\"/knowledge-medium/src/extensions/core.js\":\"911e6a004fe57f2f\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"052569a9f546c00c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"411049b5ea48b921\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"07875ffbb3efc440\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"384451f68e414b5b\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"0cc264f2ff28d42f\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"c37d04d5f81c423e\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"81d29bab9b980691\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"c2984e540fc0ddbc\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"3c687897fbb13765\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"5e88be9c1d76f6c6\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"754cfbf949a8a226\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"85a0a91869c23392\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"52bb72373d4972ac\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6a419b22ee3c6b0a\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"5eb51c23ca1566a8\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"0bc33a56fbf449b2\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"9daf66c1539383ff\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"70612d42baa69ff1\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"693dbe81e572b335\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"d53c38e84d1d4048\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"006df46a72ec357c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"254c3a917d061798\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"f7b3a50c77f9f37b\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b1d7e2ae0b1e5a8a\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"182948a88c730164\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"58483bac1702f1e4\",\"/knowledge-medium/src/facets/facet.js\":\"4e36d9e89d2576f6\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a8c155ce3a07a0bf\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"27e4dfbfae329a8d\",\"/knowledge-medium/src/facets/togglable.js\":\"472ebbc630be9954\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3a2c00833c1f4218\",\"/knowledge-medium/src/facets/verbFacet.js\":\"f956a009b6fb7a1a\",\"/knowledge-medium/src/hooks/block.js\":\"66db8af5c96c5d0b\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f5c532abaaddd2b0\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f2ee79351c0145d4\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"ad99903a208b18a5\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"4a21abd1ccf8c9ca\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4be580c035c41bf8\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"390b921d38c687e5\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"488d4f966642e36c\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"67c37294e8965df9\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"3a41bd6032721efb\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"96c094e5d0e2e690\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"405f661e14183150\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"a0ab5b046113e308\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"26a83d11100b0b97\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d4b93fb9768e4db0\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e3d7a80f75861a17\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"a31bddf676334955\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"8adeb2eb3d5f1234\",\"/knowledge-medium/src/lib/utils.js\":\"89464e9d4064e9b7\",\"/knowledge-medium/src/main.js\":\"f63628354a7be806\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"a398cf513a194deb\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"e7528e21aed7fdbb\",\"/knowledge-medium/src/markdown/context.js\":\"7980ef877fc53f90\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"8429027e70788e98\",\"/knowledge-medium/src/markdown/extensions.js\":\"36917bbfb2b42d5e\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"72bf4e78bd63826b\",\"/knowledge-medium/src/minimal-editor.js\":\"137c8f3433a02427\",\"/knowledge-medium/src/paste/armedCut.js\":\"b9502474e5f279a9\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"2b73aab36a877c49\",\"/knowledge-medium/src/paste/clipboard.js\":\"4c324d788be1af90\",\"/knowledge-medium/src/paste/decision.js\":\"f72d36d42626f359\",\"/knowledge-medium/src/paste/operations.js\":\"030ca6cb6121eaf3\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"6197c0c7ff65cbee\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"7221f085afba69dd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8d42fc369b379f0b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"7b4fb7b2e41ad81d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a3057d0c27b53bd9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7885eb1318506063\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"6d5a0c361471716b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c995dedc6128c411\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"fc57116b0f4ed3ff\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"803dab338dd0c626\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"6c90c02bcd7082db\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6260698671a10b37\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3bded66f4ce02fcb\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"765ff20920b286d6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"993a8927197fbcb9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"57ea3554f6dc012e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"612a6c926d0422a7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e3361d65297831d6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"ab2950c515557546\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"35fb28607bf4cd44\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"165c37b341be52d8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"b74a0d99e7b81c56\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0ece6dc0c623356e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"6d34a56ba9e1fa82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"131aebd96291fec0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"39e03337c5bda50d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"8a4cdfdd61b15956\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"5099a85382530024\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ed3c904bbf2e516c\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"a56e895a7f201da2\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"46115d84047aa995\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"58fa17fc3f897e0b\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"c813797f566b3187\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"97de462e78b787dd\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a467ecd85513ae52\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"8caae31ff9d9f769\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"673cf7bd271d46ef\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ffe68c7655de422f\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"a1a6e222174b3e8e\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"79992bcc2f0301e7\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"7725c71c542e8ec6\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9ac2baee33bcb824\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"767182d209c90c0b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"19f2d6ac12f1e503\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"39b126ef11864300\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"3b8a3849926eb315\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"08c6c20f55ecb2a8\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"780d7f22412b861d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"27db4c742bfcd1fc\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"2b73b34248811856\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"20e8a153c3ea03ae\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"51656452a5faaac2\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"e856aa3624f23dd0\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"6731eeab803957e3\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"dad8092066a16f99\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"8c20d7db857ca76c\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"b4bd0cede5a258b2\",\"/knowledge-medium/src/plugins/alias/index.js\":\"f96275ce18c11ab5\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"2428b288ed2418de\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"525e2b3ae7a2f4fa\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d2cd4007f4098ca8\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d904bc24f89b5d8f\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3e6b10b5c2626cd4\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"3de415576229bc4f\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"a503eddf2a839e94\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"b1fdc0b1c7c94432\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"cf2e5931d232efc1\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"fb526d1ea5586e95\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"3e3d6e5947a0e3b8\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"2f5374eb15b5bc08\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"e56f17b5455962e8\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"2e31bd40f1bec5fe\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"9f6b8e7b00f85af9\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"26c61f396e152dfb\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"35eb8298ab0820e0\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"7dc191e93c8ade62\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"c8553875ea236167\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ba03380a57792438\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"cd9993b5d9294b44\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"f8c599f98d1843ea\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"dc40a546757d7a5e\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b14d3d8ce9434346\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"5fb14938b9319ce3\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"62af64e8fcb9bb47\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"dd5ce4bdf5f37031\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"7c8de6db8197c644\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"dde14541fbfafff2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"4e75e3b32013e1c0\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"461bfcb9afb46f2c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6349d7282c3f22bf\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"ced4e05a20c633c1\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d6ff1e87a581c1aa\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"aebb23fe684fbf39\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"ca43542d65466cab\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"328d88e88e23807c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"37d3530177079b0a\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"0b4a414768998aa8\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"71a9bb058eed9620\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"ce450c9953940779\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"87455421348684c5\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"d90e93dc47132c78\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"56f2c24f4669f4ec\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f0b0f45c1b85a9e7\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"3baa1ec280d11db0\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"b0cb835c3e7a3762\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"81042b2965739078\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"789de4e1747acd3b\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9743a6a303709a10\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7752ba3d2027c9da\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"6485133ca17f8db3\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"5e0ca54f79aa5ecd\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"a7411eb9f83260e9\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"86bc3c110fec9935\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"c0786f8233119284\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6b131544e4df6391\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"89824543fc1911d2\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"3ff5d3d86d24a6a1\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"07f726a4e5604d2a\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"edf6a63c3bb8f131\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"256f515075a82f39\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"a0b9c4e50321063c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"3fbe4287e21935a9\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"0c083127b82e749a\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"447585573c0e677f\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"9b4589fb482a2314\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"9204c89b0f776bf8\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"5267eddaf9c6abf9\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e2cdd1762900b943\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"3ee3201e46e06c91\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"ad1c36813480ef85\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"2e3390bbd942e743\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"775c00a583aa8748\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"4ac84066b77f8536\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"221a48e4b5394afc\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"1f38eca6bec9bd53\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"d2e10bc6004e1e45\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"368c9c3b693c0a72\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"0725b212abf7b97e\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"8ca60d53974265f1\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"b499295b41fc55a4\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"d8579ffb3643fd48\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f64df65a0cd4ec4f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b092e8fa42879351\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"b2cdb10b86239eb7\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"6df363eb1b32ffcb\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b40d5ae7b75dde33\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"c40c30ba926c97ee\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9d614e388ddaea5c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"723f5dac2a9534e3\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"c1cb58324ae4f7c5\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"55c0d572342c43b4\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"5500c2d7bc60d814\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"fd38efa8992ab8e6\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"fb4cb0297989db04\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"4e9778e8b3f66e38\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"92b9d161d9f17477\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"73ac8af0f2d8cdc9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"ba7c730aa02c9085\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"bf0f69ea159db32e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"017d4611fb8f3f23\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"de1c7ca41c594c7e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"63c1dfb854a018ce\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"408eb3a0f620f7da\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"7c18b72a61608bd6\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"e760ed2e9899836e\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"db6988a36d4e5127\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2ffd2ed6b35a2238\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"e95845dee8df97b4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"5f7b9e7542d133e9\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"1bb039c154095e5c\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"016bb6ac24813d4c\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"562258feac7f128d\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"0594fd90bb10a5a0\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"fa712bd72679d853\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"240a1b9876456f14\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"d5d4953d08811f9b\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"2d4994ea49013e6d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"d66e7f442f7bec7f\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7bc98298d2ba4a56\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"6134ff62180c3e59\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"e806ff49ba613ed5\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"73b4112564fd0310\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"aa8536035381ccce\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e50f468fbc0f7e16\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0ef3c9a1f756f340\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"39c9eb043e95d7f1\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"f269b637d43f7883\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e82856803f0eb5e2\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"722d725d549ca903\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"de76bf4e366b98ae\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"03eff8b08564f1ba\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5331aa9aeab184e4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"fc342c34a9d31a9f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"31f162a278160263\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4417349d347116d8\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9ccb6f75b0405406\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"14d9c63f534bfa89\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"c9f5ad6e7ff051db\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a8edc774ba450d2a\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"ce60c7eb348c641d\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3897957f11e1f29d\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"34481896b1c2a9dc\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"a3adaa7f167f8eed\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"416dbe232406ae82\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"5aac504b505a4a07\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9e1c75de5320cd8f\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"256ff4a5a8c8c9fd\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"21cdc2e285c28aac\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"c4fa0ad3f9411c65\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"bb720efe933ae6fa\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"7b80b5b2444c2b71\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"6f0d6ce504735045\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"cb37302efe74b75c\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"d58c7d9b07b5a191\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"351288be31ff3b3d\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"742bc72ca4e33074\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"f0d84676137b2c29\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"4ee1b7f7939e445c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"e089ade8480fbf7e\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"627cd7c4e6e3884c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"f6dad62e00f65a67\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"c38c2d6046d1e739\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"396604c6e93a3d1d\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"979e9b538b971b5c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"56b9d30105c2e1bd\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"5fc80928dcb9568d\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"4645f0ed83e97b1e\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"8bcf6c95c6eae372\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"932c5939dbbd9fbf\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"e69b3ae06b72165b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e91bd56349bf1a06\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c8f258d5185d2d2c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"3e96a454ccd51731\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6c09cbe661498f45\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5be1e17f55934362\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"23de547c44a325e4\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"97afff5e788b5dbf\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c7133a8b14a34dc8\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"bb6dd117f378ef0c\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"87fdff6819ef432d\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"0fe3f83bb9973778\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"f58e4c8d2a094171\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"27470909ab5fc7c4\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"c673e25518ae5878\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"52e0d3811e2d6ee9\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"9ad5fc40268f2eea\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"cbe182a3d5b2bc28\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"b73bd723f66e8f11\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"5947e982226b69d3\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"977d713ca4f91428\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"c3a39d4183106b86\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"93989a1b6d80c613\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"68ed06f82d10c3f2\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"207d5e91612f096b\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"094cdaaaf01386cd\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"8e6af466a6f97c4a\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"bc0d09d74e5baa1a\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"6eaa0a01112cb88a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9710b62e956d6ef5\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"41eadfda67c4c86e\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"216c5d737e7be34f\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"b2a9c09452a1be17\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c1bd1adf82fb6580\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"f70a98ba34f5a5c4\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"49ac3600e91b0818\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"fcb3c40085ef8c04\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"ea9dca6ca431c3b8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"64d6b9e617d369d8\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"09a22b07a1dfb9ac\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"92fd703c5531a27e\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"429961eee66bfc1a\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"5f3319487214f82e\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a4ae57bf20b36ddf\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"96ad97913c8760be\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"13fd14d4a2c3c64b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a3a4c5f844175d72\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"26693ea185aa5ab1\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"30711110eb875bd6\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"be607100b0f3d8fa\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"c5c46a290d1065ff\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"4bbc3b60b45f28a2\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3fd42fba8f5156d9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c5630043ea20d094\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f8d49022a47d8491\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"34ac380008d6e8cc\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b35c18a34e9b8e2f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"035a76584c0a76b7\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"8f1ba73fa87f044e\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"95fa9da9475a6c48\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"309699c21a4d6108\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"dfb13fbb40575b84\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"21b11a5504ed0b86\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"055dfbfdc4c866f3\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e063920ebf167b81\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"1129bfa601292ce1\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"2ea87c61b05d332c\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"1da8662f2322ef5a\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"e92c63953ff0d0e3\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"7177311061afe347\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"c98c68f4a30353fd\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"bcfaf81affc93d5d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"80cbf8ecd2f0c9f3\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"99e1afc655a556d2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3c11aeabe21a94ea\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e87dfe624b4658f6\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"2ad5387e53d91acc\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"cb11e0e55c0bdcbc\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"1fe73a63f96f10fc\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"1d97e8428a701142\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"4010d2c47bae98d0\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"167d9a1fd42c2691\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"cc784e515668b7d6\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"dad2e07ad2ff8015\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5a24760f921ccc1e\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"8d57b073a9704e78\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"3232b005507d5b52\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"ff62515541c7ca44\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"34e4df4c4edd51c2\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"cf8e2a2dd10ff407\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"84028d05cd481dfb\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"28d0b15afafc936e\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"2b17958cbe3770f6\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"250ed6043f6d8c44\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"26786d860de537a1\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"d88459732e348977\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"bb865a62f00c8923\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"e1b1fb7db5c6e647\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"ab42b2751476a223\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"b8aa72ccfad4300c\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"4c78a433e6763f42\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"bf382b12078daba8\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"43af6b85efc638f4\",\"/knowledge-medium/src/plugins/geo/index.js\":\"e36f5fb4df505931\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"b47308f1f25d26ad\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"ada8ab7c35eae516\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"909296684605698f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"d412fd9657f1d325\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"c0c1853e4fcdb3e7\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"036ee31325ab1170\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"bb407a7826c94edf\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b6083bf494b75ab6\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"63816b18a23f77ca\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"daa09fc97f609846\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"03a027a557a4e1e7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1f150b2edf624a53\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"46d052526c345559\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"a638c8b48bd84bc9\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"92926bf0486c75fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"68dad0e65b037429\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a058778de82837f8\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2f5fa6009d7fb526\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"f787ba35e74e375e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"ff6b86de1b9d3ab3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9367632999c2f58f\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"52b514677aa5ee6e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"dc435c6fe15f574c\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"5d0796f6c87560ea\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"9b943b83b1389365\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"7599418530d8e0dc\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"ddd30286d9b64049\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"ae885d53375a88f7\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"4394db4faafdecb2\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"0dbfa80b72ce9c9c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"bc594cab610be8b2\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"91c034558e2b0ad3\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"f273735990bc88cb\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"08463fb3d5d41bc0\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"799e65e8a66bd9f5\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2ca1c9712346ef35\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"5f06cf0bbebd48cf\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"c8991b9e2feed056\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"ea74bf3d94a40fc7\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"99d81efa63325c5e\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"a065ba3a87b7bab4\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cae576bc06ed9452\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"61b4c931282a132e\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"159a8115156570fe\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"be2bdb0ed662410c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"978fadfafc962704\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"160d08ce90c418b5\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"2d7a1dbb6e581995\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"859cfe568ff0311b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"e6347fccf15b635b\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a91e73f50565f5f7\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a14a3c54743796f5\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"bacee5b40656a85f\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"5a35558b993fce5d\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c3dd99f58d39041b\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"1c2b1fd2ea368a0f\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"af2b52fe3081f8c8\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"14aa0b92ec58ebeb\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"466f1559295fe87c\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"4ebf1f35a118485f\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"7c4f10c2c59b75a6\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"1083866529acd75f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"5c79245192326600\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a18bbfa860ae9438\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5d426293b403731b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"049e1bf671a3c00a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"3d97e8b123d56d32\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7ce5114f57c3d29b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4a90ea3d6614da28\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"83e617e28ee8a26a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e17a464a7866f6cf\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"88340567ca5f245a\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ee18ba72b3e1ed96\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0fd752b6103060bc\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"fe7d4bf8cc14d178\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"8ebc3cd7b54c5302\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"be78494d0cda89ce\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"75bd8d4715bebd84\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"053c9c1d77c59a90\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"5d780720c8940328\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"95c0323323093d5d\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"ebfd0409beac0805\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"e79f4bb3575fc690\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"657716b2fa21d145\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"d30e44df2644b7b8\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"b3f77eb437e060c3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"4bff0cec837ccce1\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"eecef98fb34cc654\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1c6a2ab059a8d0d3\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"81e0dab8095c3143\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"9e581d5530f0aa8b\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"98853e11d04f6232\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"5d32e42e59e3babb\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"80e10e2738967889\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"682f74c5e4bfa775\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"b228e0c4b2263845\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"482d11dfb4e71308\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"01adb7fb60ba89df\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"aeb43880ba870dad\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"b1b706a7d0b528b8\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"25e04905171f89ae\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"ce08b3cc77fd0399\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b69663b1bbd9ac23\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"e0b228547964011e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"51916b1cfd7ae45c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"473f7297e1993524\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"b9b466d5a7581bdc\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"752d7d5cdeb53541\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d81c8bbc4d9a7514\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"3d01390af9311578\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b57d6e1b6e6310a9\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"37c969db3fd77837\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"8bfa664067505036\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6261c0ea0d3c887f\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"36aeba7108dd29c6\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"66e5e6f5a0c94d56\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"90be0fec19f22f6e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"6995df5bb5ebada0\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"0e092367c60505ed\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"c5bf63e59d9a8e53\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"7b3c937772a69e10\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"82f6e6a6092b8155\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"8c1969fb8ae32a8a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"ae04b159b8731434\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"aeedca50b2bdecc1\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"b000c6ef4d7ebee9\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"fbb9bd160e7cd35d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"09e791359d0ce68a\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bacf559058ccf6f7\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"a96689cc43c6b1fc\",\"/knowledge-medium/src/plugins/recents/index.js\":\"050d3c68418b72a6\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c01860eb44313246\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"f0e5a9d0cf67a5bf\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"5702c828c09ffa56\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"d30089aa35d832fd\",\"/knowledge-medium/src/plugins/references/index.js\":\"1e3ad6fd8059047f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a9848fcc440bcf94\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"1c991c58f1005afb\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"1fe12de42a2a9061\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"9856b626e2ad7e1d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0532339937bfe174\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"27284889fbaf3a55\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"d72c5c9d566e342f\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"09224263a9021221\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"69ba459a578a4be5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"aa18646ce0763bef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"09d818f827b4d556\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1b81ed41e37eca62\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"cb1258d0868a5194\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"4aed84c5345be769\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"338c675b8d165194\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"5f18c385fbbd4d7b\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"13e1419af61251ce\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"2c371494a9895698\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"4ed8e763f519beca\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"7294fb19c6202dd9\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1ddaaba37b00f974\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8eb843ac6589d703\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"b78a69e09df2a9bc\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"dbaf69279a3a6560\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"7d0757e5fafd99e8\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"8a4f48c237ad6743\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"a56f1543c1344a49\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"e484c544b242f0a3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"214f104651d0d1c5\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"699ba4aee157300a\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"582e65234ba4e7bf\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"b09fdc4d21b5f4c4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"fcb765d372084d41\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"3a29febef0aba540\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"305e04e7fd8ee6ef\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"aa7f455eede46fd4\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"baab057e09efdc88\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"8aea033a83dcb0bb\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"6fcae8acc4a720c6\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"50e10abce25ad8fd\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"06519dce44052be3\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"3f69a60863078f47\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"bac29db0fcd02c32\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"99b46265c460bbf1\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"0cc9a5cb0ce7de35\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"838b6bf300aaeddf\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e1849cd03869329e\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"3dd9c37d5229d8ad\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a7fd679cc7ee3504\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"db6b7f1099934b6f\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"51dd6642ddcb48da\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"af9c01b8d6ce8f64\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"f0c3f705fec2d05e\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"26d7d92bbce8688a\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"009d762fdf1c81a7\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"796511070cc4b07e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"fa36b4004960f191\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"60f640d6843599e5\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4c6187f847064191\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"00c4bcb3bd0a7e36\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"80e8abd809d1cdaa\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e38305f49a376047\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"e44539910d364d6a\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"c59e5274b343c4dd\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a3bc6044a4eee25a\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"bc9484d5115df9f0\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"10e64b6792d0e28d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f23531ef8c69a922\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b6c088d6b4c23ef8\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f9d1a63f69fe46b2\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2378bc1a16c67c59\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9cc1451bd4cc55a9\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"3459e248bf111326\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5ae926086c4d6e22\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"6513f38056ee544e\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c68efead5d28440e\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"3d6c2607f4024ca5\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"77a1e606e703234e\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"12a686d4832bd886\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"9034b7bfa5680772\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"00c244e72e9502d0\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"003338ca3ec79109\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"9099c275c6fa119b\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"b1811dd0c160e860\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"6e44cdf1f7b3ea21\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"ea6c9a775fb9858a\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"cc76b60c6f143bbb\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"397e2c6b7e45d214\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"759b323399a66742\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"fa8feeda7549cb4a\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"4937c3686ef51bef\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"8077f4713fef6397\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"1c35e0b5016715df\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"e23910c0d0bb58ac\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"7bdec6657023172e\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"0a738486bf267c12\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"192674515675f8ff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"1c52c52c6f475253\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"925a914a3e17a767\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"421d8fcf76b7233a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"0cc31ed26518f979\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"d00f494eb5b1e1cb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"75bbee67c575f51d\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"3fe1e0d36f48a961\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"fe85a8dbda1fb3ea\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"78936fac45cb009c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"4105f908dd73a1a5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cd472f2616c45b0b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"74c3073565a567d4\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"036b550942e14a91\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"b03f95355c3dc622\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a39e5de02f31f632\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"5f1dbba05c66655b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"34084200d334b335\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"176ac5c952f06993\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"e8280a754c5ebcf9\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"27c5268b52c3647d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"9ea5ffa506ee52a5\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"e432fe8e69516128\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"f6a0942e19d928e2\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"9001867eee95ce6a\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"865b7f901eb8fea5\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d3db4e25e998f1d6\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"2a23f39e9967b6dc\",\"/knowledge-medium/src/plugins/tables/index.js\":\"71444a9c256c7fe8\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"d8b9fb93ccd3a077\",\"/knowledge-medium/src/plugins/tables/model.js\":\"253c6acd4d0d345b\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"1916c91fae6f3654\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"beeb2c89d5d0adb2\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"78a80d67f53d3ac6\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"bbaaf1e59bc1807f\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"8411c3252ad16b79\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"b77cce6bc8a33c59\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"e820c0a92d553dec\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"862f366ce6fd24ea\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5c9e25d317280647\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"0e4dca54ef82ae02\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"717711a4a03a0b29\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"6d45dd4e451e6470\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"30897a578158a428\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"6aa13d80e217e261\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a26d09b11ff1cd8a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"974a0c4512a30f17\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"2fd58d537910cd87\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"910b48cccec5b77a\",\"/knowledge-medium/src/plugins/todo/index.js\":\"a667519fdca9b54f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8afba78f7bbb1063\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cbcd00575cefd07b\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"b71f40ff7693c7ad\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"315b2807b6a18da9\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"609f32fa069a7b8b\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"d4a0cdcce6a857de\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"12dc78b07261e9e6\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"a1baa2b001be89dd\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2b86e78368f4d1a1\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"2dc5310d6c11efba\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"7f606120b80310a1\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"6857a2fdd8ae2691\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"978ad49eeee87b71\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"92df6b16160386b4\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"c2dff6530d253c04\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"51f4bc6ec3704521\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"a6ab23bcddf4c5e9\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e5dd680e833abab6\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"5b67198f5903c6b9\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"c245bb091446202d\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1ec4a628c3ce62e4\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"dee7c4df987b667a\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"080999eef2235210\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"1d9cef0063cde588\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"77207b62aa1aec94\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d8adf10edf84c78c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"3c2ce1b938768b66\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"d9b0cdf9e4301b87\",\"/knowledge-medium/src/registerServiceWorker.js\":\"ad59cfbc081e9128\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"7f6bbe29db793325\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"82436db28492ecbf\",\"/knowledge-medium/src/services/authStorage.js\":\"0117940e83291dc9\",\"/knowledge-medium/src/services/powersync.js\":\"f59256653f8d9830\",\"/knowledge-medium/src/services/supabase.js\":\"3b01757e6b79b080\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"7cdf929982453dce\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"c7d77e29e872f846\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"60ad5462d064fc9a\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"53be6b6e5f889be2\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"45559b734ebefe03\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"04101ef287f7718c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"dbcf71c251a21098\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"7c41d36bc8e9e9d2\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"03eabe195a6a33cd\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"a30f60d05681a0f5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"c133149b29ede379\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2c7d218454cc10c8\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"9ba5bfdcc91a69f7\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"f495f461b23cb4d9\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"83fc8f4300288509\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"7b31e9ff60eaacd5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9a9da4a0628b1f91\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"7de7fa50588652b8\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"02ba87e29fcc6bb4\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"a30f0f1f927b03c7\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a9dc662d935302f3\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"9a49a14b1834aa74\",\"/knowledge-medium/src/shortcuts/types.js\":\"5c7cdda8a06c26f6\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"8ee1cf610402c779\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"ea2c77755f5bd78d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"ea80f2f9d32cc6d4\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"c5ff90c4f6d7a4fc\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"67e01edfbecb0342\",\"/knowledge-medium/src/sync/byteTransform.js\":\"f84d6a8913346677\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"99c3573a7788a3e6\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"acc7bc40c3212bc1\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"bcc499b423ddbd9d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"4675f711dd1c2e4a\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"23aea17e64228b07\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d7b1dfff0fe67f8b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"1d9c2a983ed992e8\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"b5df4366621f5976\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"c4a4004ebbdc637a\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"bc8f8de14d73613d\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a984f0ea5fd3d983\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"ea262fb840b8ccbc\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"6e99bf4e88415908\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5422af8a645a8b5a\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a978eec742d56e4d\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"9eb2355c32c8bd6d\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"0079ea22364abc92\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"128da1ae60d819b0\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b10113019cd5b320\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b4634d330ee88874\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"3d858802a99abca7\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f1e74e193984e911\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"664834f5b71d6d23\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9bc6c532ca117aed\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"f57870d07a03c797\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"e37dc40f4fb28126\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"af5b35929b8014a1\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"ace96131d5c4aacc\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"1604fbeae80ee5bc\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"ffd99f46dc9edd11\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"8d8eabf2bf8a455c\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2fef0ae16b66e1b0\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"41fd69568eb1162e\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"3cb57a3fb0902b47\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"45aa9bcada260f1d\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"2b3c3dd9df115225\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4ba303ed9da9c679\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a295e7d43536797d\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f1ddd36fd7b8e6eb\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"46182933ccc80c60\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"77e5f5ce3ddd8a16\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"81afbc6d670eed8d\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"672423e90bafd22b\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"d19fbd15dac9c9c8\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"41f35a33875c7649\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"7cf223de1946fe7e\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5b07822854399fd9\",\"/knowledge-medium/src/sync/transform.js\":\"0168b41b1dd66de3\",\"/knowledge-medium/src/themeBootDefaults.js\":\"571745ff629a43f1\",\"/knowledge-medium/src/types.js\":\"52ee76fcf819ee75\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"56be99b586dc6184\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"97a6e8f9faab6582\",\"/knowledge-medium/src/utils/array.js\":\"6602cc3014575f1d\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"f0be636bcf18e1aa\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"32c6d5ec74de6548\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"497f9d687d7612b7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"00b05ed31373b6de\",\"/knowledge-medium/src/utils/callbackSet.js\":\"bdb2fb4d23f49430\",\"/knowledge-medium/src/utils/clientId.js\":\"628a50dcc39f792f\",\"/knowledge-medium/src/utils/codemirror.js\":\"315b40676e47a02d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"07a29f10f2e7b338\",\"/knowledge-medium/src/utils/copy.js\":\"8bbf5730a0aebdd7\",\"/knowledge-medium/src/utils/dailyPage.js\":\"63bc95640d17aba0\",\"/knowledge-medium/src/utils/dbForensics.js\":\"dd12509827cf8bb7\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"d23d20bbfab5eeb4\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"225fa007906fc425\",\"/knowledge-medium/src/utils/dialogs.js\":\"801737648d11d071\",\"/knowledge-medium/src/utils/dom.js\":\"ee5d0caf5df6b6c2\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ef862eeeaf416724\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"6ca08816db04d454\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"0fc6ffdc3d063c8d\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"28d3fdc9f1e56112\",\"/knowledge-medium/src/utils/flipSlide.js\":\"e6a7323a4c6f29aa\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2cad23d9f18ff872\",\"/knowledge-medium/src/utils/formatBytes.js\":\"b19588cfc15b788f\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"e37eff3092521200\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"590687bc656d1a0b\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"046cdb7cf725168b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"850ddbd2f0d42011\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"0d05fbb079a25208\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"acb2e62f06383957\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c1e459e5b66ff621\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"a92f14fca3bff521\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"51824775888ec7a8\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"084c4ecfbde4ff23\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"484e1da17f014d5c\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"2acc2eab0a25d77e\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"920828da168c7b83\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ceded418c71662c2\",\"/knowledge-medium/src/utils/memoize.js\":\"fe192cb33079e05d\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"e85e9a4a0bb7ac6a\",\"/knowledge-medium/src/utils/nameList.js\":\"6afd8e6fc29774f1\",\"/knowledge-medium/src/utils/navigation.js\":\"7d81f4c3069b34ba\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"871c9aa4c13a0dad\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"870455545e110033\",\"/knowledge-medium/src/utils/panelClearance.js\":\"9096f8d4ffe80af5\",\"/knowledge-medium/src/utils/panelHistory.js\":\"b3781a27274eb310\",\"/knowledge-medium/src/utils/panelLanes.js\":\"a48652fe7010721d\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"424b537f1806d106\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"5019131fac47e9fe\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a94369675c378339\",\"/knowledge-medium/src/utils/platform.js\":\"8da2b0a9bd136528\",\"/knowledge-medium/src/utils/pluralize.js\":\"df54e85fe5cfa3b8\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"607cef7b872eca2d\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"178e42d00bc9f265\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"838c34f925bdcc97\",\"/knowledge-medium/src/utils/react.js\":\"d4b46f847608106f\",\"/knowledge-medium/src/utils/relativeDate.js\":\"9d71fba16e4e4e1b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"5d6bbab9a9ae89c3\",\"/knowledge-medium/src/utils/renderScope.js\":\"5ba84227f3b43f26\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"c18fe3c6608a1ce6\",\"/knowledge-medium/src/utils/routing.js\":\"24a1a2e3f2f5b7ec\",\"/knowledge-medium/src/utils/safeMode.js\":\"d8c2b2863d2a8da2\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"2edb602e1548f77e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"8bdceb5e56589023\",\"/knowledge-medium/src/utils/selection.js\":\"62f13410cab34666\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"3bf0a4fa5ee36e65\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4ce3e72cd89eb879\",\"/knowledge-medium/src/utils/state.js\":\"214169b649b4f92f\",\"/knowledge-medium/src/utils/string.js\":\"6b460aabd0ac91e7\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"7a8ffa23929f8213\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"a7da960c48f11c7d\",\"/knowledge-medium/src/utils/toast.js\":\"af0e0acd2271f390\",\"/knowledge-medium/src/utils/toggleStore.js\":\"83dce5d429656539\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"983495e0c8fbdbeb\",\"/knowledge-medium/src/utils/userActivity.js\":\"34fae190ac55c62c\",\"/knowledge-medium/src/utils/viewTransition.js\":\"69ac436c84067467\",\"/knowledge-medium/src/utils/viewport.js\":\"2fc393df740b249b\",\"/knowledge-medium/src/utils/webLock.js\":\"b34eb59561c2d9d7\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"a6193c0c47fddf08\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"e72453e5b18710bc\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"5b4dac1bd6442405\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"779af54c23448f25\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"82970630686d1704\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"5515399894704c37\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"73f8da8a56e42c2d\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"880f2b3fb8358d11\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"f42ce5955ba4e089\",\"/knowledge-medium/src/vendor/react-dom.js\":\"3e0d90192695c76b\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"c6d8e621999ec8e0\",\"/knowledge-medium/src/vendor/react.js\":\"ec1a184adacfc58f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
