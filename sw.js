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
		buildId: "3eea482e4bf5-8b976800",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"7d05977b35c53879\",\"/knowledge-medium/index.html\":\"7d05977b35c53879\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Vxiyk-Gc.js\":\"46b606b9fb8c4c69\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"8233f41945df7bc4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-O1YTbS05.js\":\"27f89a536d32a007\",\"/knowledge-medium/chunks/FacadeVFS-BeKrxjhi.js\":\"a6fed9d047a7e6b6\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-ChDhJjlj.js\":\"974dbef087a828d0\",\"/knowledge-medium/chunks/MemoryVFS-BmMnY7go.js\":\"a48c86c92142f9bf\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B7M_tT__.js\":\"3c50dbec2660fa42\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BcDbsLON.js\":\"2b1e2f781a2126fb\",\"/knowledge-medium/chunks/Preview-LV4UQb6y.js\":\"62cc3558202eb4db\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DhZEZOsK.js\":\"852f96dfde7ee1c4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CK6Q_dDH.js\":\"775ba926d94bd873\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-2mOc5CAF.js\":\"00de14f9b10a351a\",\"/knowledge-medium/chunks/react-BM7Bg8iW.js\":\"b767c51ed9a0e5e2\",\"/knowledge-medium/chunks/react-C_I_Df9F.js\":\"7adc534d0be45dff\",\"/knowledge-medium/chunks/react-C_buWRT0.js\":\"3806a8dfaef0fb94\",\"/knowledge-medium/chunks/react-DNSAtnyd.js\":\"c58b83b448ab5b78\",\"/knowledge-medium/chunks/react-DewegLgN.js\":\"afa6eb92ad9139fa\",\"/knowledge-medium/chunks/react-SXzvt7yx.js\":\"ae4b44153b59de3a\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C2vH0E4Z.js\":\"9ae57eaee48f54f0\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CEUmWqk_.js\":\"c749e3e7cb174726\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BMt4aaUH.js\":\"4d1fe66971a01f50\",\"/knowledge-medium/chunks/react-yFnr1UJC.js\":\"a875f52ab14a8b1b\",\"/knowledge-medium/chunks/server.browser-uLXmeb0X.js\":\"bc0d82bb6ba00c3c\",\"/knowledge-medium/chunks/textarea-C24kcgRC.js\":\"da83b5848102eb0a\",\"/knowledge-medium/chunks/ui-Do1oTNYJ.js\":\"7a2285d350aa821e\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"a8ad1d1e62a8118f\",\"/knowledge-medium/src/appUpdate.js\":\"e229ec8c695cbad0\",\"/knowledge-medium/src/appVersion.js\":\"e4045a2071677ca0\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e6441602e29679ef\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"cd669c9c62c758e4\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"8475ac14e8c63585\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"36b82f4fd67b5329\",\"/knowledge-medium/src/components/BlockComponent.js\":\"53a4fd2fb25e67c1\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d1e0f01c82da705d\",\"/knowledge-medium/src/components/BlockEditor.js\":\"cac3c616a19d0197\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"f81ba486023044d5\",\"/knowledge-medium/src/components/BlockProperties.js\":\"02d1b39a66967493\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f7a17613344d7ac0\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"b4508a8a2a1826fa\",\"/knowledge-medium/src/components/DividerHandle.js\":\"714ddb6bf0841b9c\",\"/knowledge-medium/src/components/DraftEditor.js\":\"5ef2069d7e1f9894\",\"/knowledge-medium/src/components/GutterPill.js\":\"40b284066c755cef\",\"/knowledge-medium/src/components/Header.js\":\"925f07d927bbe0a0\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"3ca290b5b9952e6c\",\"/knowledge-medium/src/components/Login.js\":\"b1a4a9abc77ff463\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ba061f5ebbf993a0\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d046f47cdde54377\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"451050dc53868706\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"afa0849f5a137698\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"001c3ac6784b32cd\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"ba83c6cf8eda6818\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"5fb87f59d02a8eb7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ece17990a23fcd5d\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"959c7526fad2b17f\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"92456630f05c95d2\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"57cf85d05aa47540\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"8ec1202bc15f1a46\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"24cff4cf94c65081\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"90659afe3b3a38f0\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"062740129c147b4c\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c761100a69a48f66\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"9a8f1224e3515785\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"bb6d6f870a6eb882\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"739dd7a2a16f62db\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"0c9e58a8dc3f94f0\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"b8b0e236a954c9c1\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"6b5cd32b2d3faff3\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"054a7025fc7bd3ec\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"272f8297ebf3003c\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"c477ac1544827dad\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"310d6cc0b33006e0\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4a5ee2b005c0b8f7\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"551d2f6b45b34b25\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"ef79417e49639146\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"52adcbfd051b2db1\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9cfe0ef87cabf2f9\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"9375ed28bed687e4\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d1fbc857a5ec1453\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1c2e46b6f6fb91e3\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"cc7b3e01d49e43d8\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"93209cf61e0fef24\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"f0692fe7e4c4f1c2\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"8fb8069815fbbb07\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"62f2707a1972fa88\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"cf57d5dabc3dacf1\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"a5d35cc9ec878c6e\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d3f8ddae3d9c7bf7\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"d634727392fdc75b\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c95b0e3deadaf91d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"3e949a3b1376bf70\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"ebb5d6877f1ab5b5\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"8d7a0f14b580684a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"246d4235ae736cba\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"38f91434cda19ccf\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"201b12f55c196b08\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"867a35256221d394\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"186ce4b377a1d2ca\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"4967d9ba7d47774f\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"97df9a2c32dc2ed6\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"baf3a223121b7019\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"166321b04fb0193d\",\"/knowledge-medium/src/components/ui/button.js\":\"4b7d1e9d47c13de0\",\"/knowledge-medium/src/components/ui/card.js\":\"4fa9a1302cd61606\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"6d68eec10395f534\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"41971ebcbddef4df\",\"/knowledge-medium/src/components/ui/command.js\":\"5ff96e5040bb210c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"84c574705d2ef439\",\"/knowledge-medium/src/components/ui/dialog.js\":\"9022763dc8f77535\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"7fb2d06c102f0de4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"49526c17ec225a2b\",\"/knowledge-medium/src/components/ui/index.js\":\"c0f97c74a381a47a\",\"/knowledge-medium/src/components/ui/input.js\":\"96db2981888c5e98\",\"/knowledge-medium/src/components/ui/kbd.js\":\"6f212905122c2644\",\"/knowledge-medium/src/components/ui/label.js\":\"01744df62e1e8098\",\"/knowledge-medium/src/components/ui/textarea.js\":\"f5fce829def9616f\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"9b1546ca7b1d53d3\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"ee39b080493e07b2\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"9f5121917fe20609\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b7c1753ebcefa78f\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"dd70a2b7cf688423\",\"/knowledge-medium/src/components/util/error.js\":\"61a08ec8d45548d3\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"c116418d4fa1d937\",\"/knowledge-medium/src/components/util/suspense.js\":\"12ec8d01e2141822\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"07c1e21a7796c3cf\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"75405dfadbbe0fa8\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"f19cd7cbcd8eedd7\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"dff25f43abc3bd66\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"9cf58ce87258ff01\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"154e77d2a30d8c5a\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"59344f0f2b1148c0\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"d4db255c48f1e8bd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7c6c81055152523a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"a0aec716e51e50db\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"c3b5c760cf56f3d0\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"9c36e2699dee8d46\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"158b1990d89dbf8d\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"94200b618501c41c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"625b06da28077ae1\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"b47974d7f2e4799c\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7b44ed8d83cba107\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"8b77910e30262cb1\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"5579716d070abfcb\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"65ed3e62cd8ef009\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b5e687d269e834c5\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"ad40e5d343ddea1a\",\"/knowledge-medium/src/context/block.js\":\"7fd7c7670db7d626\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"80a8f70aea5a6968\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"c54ba03428722e6f\",\"/knowledge-medium/src/context/repo.js\":\"3ec5a7cba69a7590\",\"/knowledge-medium/src/data/aliasClaim.js\":\"6ca173bab165717d\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"7617d78f75661e06\",\"/knowledge-medium/src/data/api/blockData.js\":\"a7c9de97d2ca6335\",\"/knowledge-medium/src/data/api/blockType.js\":\"d2ecce7432ff3417\",\"/knowledge-medium/src/data/api/changeScope.js\":\"e768176801cbdd5d\",\"/knowledge-medium/src/data/api/codecs.js\":\"beee0a918ad59ada\",\"/knowledge-medium/src/data/api/derivedData.js\":\"23915a4e1ad63040\",\"/knowledge-medium/src/data/api/errors.js\":\"5dc4410b7c393fa5\",\"/knowledge-medium/src/data/api/events.js\":\"897c8acffc0238b8\",\"/knowledge-medium/src/data/api/handle.js\":\"e8a3e1847a48c24c\",\"/knowledge-medium/src/data/api/index.js\":\"d72a1cd3cde7a912\",\"/knowledge-medium/src/data/api/mutator.js\":\"387b88f98d7be6be\",\"/knowledge-medium/src/data/api/processor.js\":\"f29b8cc23b06205a\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"fc48eaf897eaf9f6\",\"/knowledge-medium/src/data/api/query.js\":\"385c82bc31800e43\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"282b82e9b9d8acca\",\"/knowledge-medium/src/data/api/schema.js\":\"e8a3e1847a48c24c\",\"/knowledge-medium/src/data/api/tx.js\":\"e8a3e1847a48c24c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"962fa40d97b94069\",\"/knowledge-medium/src/data/api/user.js\":\"cc75333149aa4b2a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8a9aeaadef5c3d7a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"7d4bb2344745042f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"756581aa71bf5883\",\"/knowledge-medium/src/data/block.js\":\"ad56cb616e146e54\",\"/knowledge-medium/src/data/blockCache.js\":\"8265c41d14df309c\",\"/knowledge-medium/src/data/blockId.js\":\"86c8d8f443ecc260\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ab3df2f9d5bde1c4\",\"/knowledge-medium/src/data/blockMerge.js\":\"a6f65caa12ce50a5\",\"/knowledge-medium/src/data/blockSchema.js\":\"abe268953da62343\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"f4eb6a4a3ff1ebef\",\"/knowledge-medium/src/data/blockTypes.js\":\"ea7861b8898af191\",\"/knowledge-medium/src/data/clientContext.js\":\"efb78b2603e938e5\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"5789c941a66498c7\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"e9ca2222629b8f5b\",\"/knowledge-medium/src/data/derivedIds.js\":\"1ec23be892131013\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"b680a2a4f1b71ec3\",\"/knowledge-medium/src/data/facetBridge.js\":\"901374a9df8f80a8\",\"/knowledge-medium/src/data/facets.js\":\"b146aaeb0f7a4f97\",\"/knowledge-medium/src/data/globalState.js\":\"08c6676d1c97b58b\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"e671371b287a6b45\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"51764431169b24ac\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"7a6b1bd7a3b5e1cc\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"89d69dfe2ee184ef\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"09c1b8a91e6b5110\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d4fa362b52d2f45d\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"3148c7f527b767a2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"4ecd40549046bc3e\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"4bf50a564155b6d6\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"d1c00a3570a4a217\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"12b1f52b0f9b8ccf\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"8dd828b34c9c8774\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"9129541eab9a6458\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"7839823f962e3fa8\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"9482746c64fb57f1\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"173c96348c2409b5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"f17f4d66e05f06e3\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"315be24b13bc2361\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a6d6fcb52fb58af3\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"2019fee9ce26abfa\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"c83de0d95ca733c0\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"c705178a8c8e4df3\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"05e758f3d8a750c0\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"f73fa6e2fbead484\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2b17a61c9ba1c586\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"5013e198bd29e95f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"91172c838c0069d8\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"76f7c0c065e23388\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"e2811a9da0be056a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"c0c499253fc8313c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"11c6172af6d48dae\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8d6c5223abab3d13\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"f80f9c303402a1e7\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"a7abeb7f5097c83e\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"863ced1d62fd6632\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"3b152c22c4758992\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6f12a09f4e88cfad\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"2900870984a6c8a3\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"b65686e6060dc18d\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"6c2eba1abdd8fecb\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"85c12867769d0c9c\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"83ad5c5c9ace7c72\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"ec89dd41066d524d\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"38cf23975c3fe399\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"1bd8154da4368414\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"9c6122cd4a045750\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0d9c0d698d6905d2\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"40480839b406d37a\",\"/knowledge-medium/src/data/invalidation.js\":\"7a7f07380cf7d2c5\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"93393655986bfa6d\",\"/knowledge-medium/src/data/kernelPage.js\":\"af88b77811776a75\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"946034c8b04bb064\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"d12764629a8eb63d\",\"/knowledge-medium/src/data/localDbStorage.js\":\"81b78dbd0635f550\",\"/knowledge-medium/src/data/localDbVfs.js\":\"961c95d2a573345b\",\"/knowledge-medium/src/data/localSchema.js\":\"d510495520da8eed\",\"/knowledge-medium/src/data/maintenance.js\":\"a79cee3fca70ed5c\",\"/knowledge-medium/src/data/mergeProperties.js\":\"c69995196a065604\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"9a450f7fd9c26348\",\"/knowledge-medium/src/data/migrationsPage.js\":\"240dde9fbba54791\",\"/knowledge-medium/src/data/mutators.js\":\"777bd168c4bccefc\",\"/knowledge-medium/src/data/orderKey.js\":\"6e87c563161d54c1\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"f6db733e9d7dd806\",\"/knowledge-medium/src/data/outlineSurface.js\":\"f94b58fb9fe2e229\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"4baf1d1a4ad44503\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"5c36c6e565e97c67\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"62c25283769c22ce\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"c31d046be470f53d\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"78ca42104abaf384\",\"/knowledge-medium/src/data/properties.js\":\"c9cc75635d42953d\",\"/knowledge-medium/src/data/propertiesPage.js\":\"fb3dd9a861f8139d\",\"/knowledge-medium/src/data/propertyChildren.js\":\"e36917f33abbd81f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"2a58ff6b9601d92a\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"88fcefe447a8bbcc\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"de0ddc39d80c7fe1\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"55ec4a790f14bba0\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"c9d0590119b33f96\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"35d9d9ed425343ee\",\"/knowledge-medium/src/data/propertySeeds.js\":\"cc6151267d21bbfa\",\"/knowledge-medium/src/data/recentsPage.js\":\"adb81e0e955cab51\",\"/knowledge-medium/src/data/referenceBlock.js\":\"d127ab87be338583\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d712644d25b17b14\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"8b08ff2c84aa3e0a\",\"/knowledge-medium/src/data/repo.js\":\"fabca8fd4140deec\",\"/knowledge-medium/src/data/repoProvider.js\":\"2309abec158ebc9d\",\"/knowledge-medium/src/data/rowProperty.js\":\"771ce5d6024443a2\",\"/knowledge-medium/src/data/searchFilter.js\":\"83374558115aec04\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"aef357cebd96d957\",\"/knowledge-medium/src/data/stateBlocks.js\":\"91f3877cf4b04283\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"d5ed38644b35ff3b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"7edc2baec7cfb21e\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"263e648d3046ec07\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"012eeb8a1143fef3\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"1aa1a1aaf30ecfb9\",\"/knowledge-medium/src/data/targets.js\":\"b90eb673c334cc05\",\"/knowledge-medium/src/data/typeColors.js\":\"b2d1577d9bd211f5\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"b1a39d9daec25fa9\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"d7bb59c02b142747\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f3fdc359cf75b515\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"c518dd4b5a0c9c76\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"678409b4cc6db662\",\"/knowledge-medium/src/data/typeSeeds.js\":\"91855d4beb921240\",\"/knowledge-medium/src/data/typeTagger.js\":\"4472443e0e479027\",\"/knowledge-medium/src/data/typedRecords.js\":\"af26ab03cb7b4577\",\"/knowledge-medium/src/data/typesPage.js\":\"417a14fbaef2a646\",\"/knowledge-medium/src/data/userPrefs.js\":\"9410a3dc41c49a23\",\"/knowledge-medium/src/data/userSchemasService.js\":\"56eb45d61bbc94eb\",\"/knowledge-medium/src/data/userTypesService.js\":\"0c2c6e049d7e1243\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"aad078dceddff249\",\"/knowledge-medium/src/data/visibleChildren.js\":\"2017ee33c5d34e43\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"62fb6bf57879cb87\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"ee3296cb872db213\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"bb71245676c3fa61\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"294ddc3a553a7940\",\"/knowledge-medium/src/data/workspaces.js\":\"6336e6a95570d492\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"37e9bd2fad97c4f9\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"fdda253da4ece5cf\",\"/knowledge-medium/src/editor/atTrigger.js\":\"11cfcc652e12d226\",\"/knowledge-medium/src/editor/autocomplete.js\":\"310030f59aeb7ec7\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2ce6fc611dddc3e5\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e45a8a81dbf35f99\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"171d4c226c373ba2\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"37aa1e9ac810ed5a\",\"/knowledge-medium/src/editor/insertImage.js\":\"fa35c907ab6d8030\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"83d8cbee01630f96\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"0ef8f75806c10cd8\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"f1ea610991de46b5\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"35271ba744ef8353\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"46058b06f8645d5c\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"b6e7fbd26c3f1a4c\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"7cef9f512ec35849\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"ad6f50673c1b51a6\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"78ebff2f94a42248\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"8bae69618a2fa3e5\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b14dcb467224dd54\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"cc5b1af519f66270\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"5ebfce76301b6e99\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"152e287d548ad1f4\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"cccda4900c29707b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"329731a704637826\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"4c62b1f569224d61\",\"/knowledge-medium/src/extensions/core.js\":\"82defaed571809e8\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"192d2d74ef0bb1f9\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"0adb08e6878971d6\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"0cc8d55b1db24ea7\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"bf9e70524e734259\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"65eaa9a13ee2220e\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"5277eff718a13f89\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"ffc789436ab8258b\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"8097b8ff82d47022\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"1cc4864e076292a1\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"d9e9f9c6f6a03985\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"81bea2eaf9eb87ac\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b168feeeff65928b\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"56263a5a2d94c55b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"f67fc2711ac64edb\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"eda626271592e384\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"5e453dce6a13f33f\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"10c741204d6909e9\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ed44c7475956a8bf\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"cf8a61e0dfb678bc\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"4089f2edb355471f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"4e5f0d876290d538\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"a2532801db68dcbc\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"d7e9a985d26432b7\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"d5b1f2baaf8747b0\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"7c9351bd50d9a71c\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"755194edc42ff089\",\"/knowledge-medium/src/facets/facet.js\":\"514bc3d9e7357d50\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"388ae6763349c560\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"c66a28e653e20996\",\"/knowledge-medium/src/facets/togglable.js\":\"d71aca94461b6df9\",\"/knowledge-medium/src/facets/variantFacet.js\":\"b0ff397dfa1c1bd9\",\"/knowledge-medium/src/facets/verbFacet.js\":\"278e1fecce49afdf\",\"/knowledge-medium/src/hooks/block.js\":\"0d385bb1b37ac9e0\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"518152c9ca102f8b\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"3b479af761944b67\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"f6e79f053bab8b0d\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"9dd48855ff9bb5ab\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"75c2988c6bad0e2c\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"e68c457cff6d0f80\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e0032752c38c7007\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"9d56d4699a9ce4e7\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"65f8d8549a4cfdf7\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"a1edce43d984fbb1\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"2541b27e0c3b3e74\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"c885eaf842c60dba\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4ed9ff35abdddf84\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"379b1979e2e94204\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"827705db8dfeebc4\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"30d31e1a4c046583\",\"/knowledge-medium/src/lib/utils.js\":\"4c56f9664d9e33f3\",\"/knowledge-medium/src/main.js\":\"d7cc147e25ad7f19\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c20b19d932564f05\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"a31bdf3244872adf\",\"/knowledge-medium/src/markdown/context.js\":\"b992fc44d177945f\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"ee26177465981187\",\"/knowledge-medium/src/markdown/extensions.js\":\"0decc57630a62d9d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"dcfe13098ddec9e0\",\"/knowledge-medium/src/minimal-editor.js\":\"5aa8aabf272016d4\",\"/knowledge-medium/src/paste/armedCut.js\":\"d946f9347b27be66\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"02c8d423c82c3789\",\"/knowledge-medium/src/paste/clipboard.js\":\"3e03ae83468a6d7b\",\"/knowledge-medium/src/paste/decision.js\":\"4f1154bd6ef0e1a9\",\"/knowledge-medium/src/paste/operations.js\":\"0a974ff3ece282f1\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"82647e51d89cf67d\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"8775f482a666ec49\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"97ddfb0935733d84\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"18222445bae22fed\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d0f2c1706467c166\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"52e498197a8e9e68\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"cbb496015ca45c2e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0f12c46954be6620\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"fbb140b071ab4eff\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"17e4a728e38a9e5c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"8d5a87a650598d20\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d988b73f2a277f7f\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a3ce900701e98e5a\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"ec3d202efb594573\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3700be4e76dc7e94\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"6d4671b0fc8dd2e2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"55bd28529629e4b7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"96011388ade1d89b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"e596acaf3f4f5ee5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"7513a88b50cd9689\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"63daf265b5299e64\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d06ad5f4a071664f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e01c02a145d95c6c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"fbf9d29de4dca474\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"c6aa758bcfb7cb48\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"23abd2b890167d01\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d5461364f6f69c94\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a8a18b1381b40692\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"1a477e553e4d00de\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"81e985c96dc80e08\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"78f8a5a3bfe4b98c\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d47495011ea7e5bb\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"154013775eb5c921\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"f94363dd294669c8\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"ee8f34156e61049b\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"86e9337e9a01c7f8\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"f9ffe98f8c8866ce\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"8c7a6f6d62cbd7bd\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"9e6a325711b03d83\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"eb2937ace96c092a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"63fa708fede497fa\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"2c20dbbe1ebb8324\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"30c9f3afbfc2cf35\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d38daa0426949e8a\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"ddf3ed91904bfbe4\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"b5e039bd69222086\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"1a708f3e44d4feb2\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"e01f18a42a45fd39\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"d84e1e620c36af2c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"40dccaf3c3820f74\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"0556f024d7c1e0c5\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"902b31092e3fff24\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"8021f1d85116caa3\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c2636ce93f7f6d33\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"b60b516bceaeaca9\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"395a708628bbc28d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"4a88b7ca6489d063\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"53ecd56ee5f8322e\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"c0313fb176348a34\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"7a0b33503b796832\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"b0cfb2fd57f7c5b7\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"5ff9b61d547f665d\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"d0c3ccda934cc7c5\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"6d0749bdc9edc692\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"c67a6afbaa0a29ca\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"663511e3590f3bbb\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"433d376b8eeb505e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"82709e4d389b2fa1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"71b7182755c2f7a7\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"f89a514e95d85cf4\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"5bdf67b222370ddc\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"15ca1a6e8fec0c23\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"190163417d80819e\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"2a0e23e62a9d6e66\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"2ee72a2094e9d6b5\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"760d7bb1099a0a9c\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"de5ec4e77abb065b\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"73cf6628da80a05c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"43b1b20e028d1cc7\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"dc5c60ef0a55ced5\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"eb14ce7e45f8db9a\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"b3597421cb6c1559\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f606294f5f469e63\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"ca6e24a1c48ec06b\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"119fb15803d5a00b\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"df16c8733a0b3098\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"4cd375c4a6a767f6\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8dda40e73ca6347a\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"f57624df004e7697\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"813fa66d5afc6040\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"c985f1aa871d4e66\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"bd1fb23379ce10d1\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"86ca80ee8621750d\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"5666011d8421ad40\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"e696c5d28a4cba00\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"b1d46f9ea18cb8ef\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"dd29423bcc4f6c8c\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"3a2fdcf6154a7dbf\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"cdf991ad616674ed\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"f6f83c85b8d511a9\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"2ff496133e24d16a\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c58c7c57bb2d3958\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"3c0df91ea75a2825\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"56ccab5bbad42ff5\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c365b175fbab1966\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"a3486f66f8f85ec7\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"52015ee6487193a7\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"8a89c32644fe7668\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"9639132bed7bc085\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"4d36af2d3448dac3\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"b0ad308ef3a8761a\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"c567423a67cf193f\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0b81325170dd9aba\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"2273e33d30f6a69f\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"d37df8ba40d5dfd3\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"509adf6e9ffea9db\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"74a792e47f68062c\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"6ada235d9bfdbe46\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"f62ac56dd001e157\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c40a8a1997a35340\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"b4007094a18defc7\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e48b069cf84408da\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"b8dc28b8632d580f\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"c2c71cf2eceb2db6\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"a63b88eb535d2ca3\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"a6bb0af991c29029\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"2c6cb62c8d8cfcc7\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"fbc9df4f85d62e25\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"6012acf88291b7da\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b5240c5440ea6b25\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"bebe34b70e404a60\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"53e0055a6649863c\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"b870b4b44fd342ca\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"d7b0b41a1e4a13e1\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"0a5d423c21b9535b\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0c77d9962ec0b129\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"bcb68d3fe00d9f1b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b4b80e564f975532\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"80cf0ac6dc1412ef\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a160c45585eb3d18\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"106f056c809d4d00\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"1ed4bb5c3761eb9a\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"e5c6804b2abc3cff\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"26127eadc5100b1d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"1199a7a4828ca13e\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"1876fa1adee5110e\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8dc6564b1e0eee15\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c167a01666edeec0\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"a4bf91928a8259c8\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"27d81f15e1946ef0\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"58f96b30655a4384\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"ad007ce5c2df716c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ae85ba8970195bc5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"ddab8594810a0f4e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"7da33ab4fdc3559c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"865289f13328a735\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8e87893d392cfdf1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5067a9f3666d6b45\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"86410a89d47c5d76\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0e905c8ff5b3bfdc\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"0ce9e324186f568f\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"c2e775bd5126ec01\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"6eeb19ce6fff9071\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"4d9f32eae088867e\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f572cae41bbb94ef\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"2ba69b32f65d69ba\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7ad4658cbd2e2c3d\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"12acb9b2dfe503fe\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"81e11994a673c64a\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"abf5b0fb25c347d1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"275a41c024a99287\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"7c7ae45a520589cc\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"353058a00c501740\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"56b59eba7aa992a0\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"69f52a59a10b2a96\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"40d52b45325ca7c7\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"f91f78f7e99e8d76\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"6e094700344941fa\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"60afd87843689062\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f6ec5dade4cfa4eb\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"196607d1b1cc2a3c\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"2edd2144e6e17308\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"086479756188fcb1\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"362c6bc5a121d4a3\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7f67cb53e39ea30d\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"494ce2df8760734d\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"d0d9102356f6cd6a\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"11492c15aae79bef\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9f7757121603400e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a60875997739499a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4254f356c015b85f\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e6e1cb8068bc2743\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"93fd6fad5c7132fa\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"46e2addd37ac172f\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1ae531065f7e7437\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"459ca51554bfe5d2\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ebdcbba823c63ad5\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"eed9775c440c5358\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"033f534a60bc0770\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"087b9e94a697e539\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"2bf195971bf0e965\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"ac88783474b507fd\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"6bfb47f4ac12e855\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"2ec23db97e296c94\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"288dd7c784483c55\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"a4be3adbb9dca5d8\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"b764a66df2383dd5\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"3e95379807a72ea5\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"880cf4ccb16318d3\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ce59f0c7cdd434b8\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"3dd5a4b84875b4ce\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"8ef13ff75b705df7\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"d608aaf185a09281\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"777ac4371d13ae18\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"fd8273ac0626da03\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"74fa9834c5b83300\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"352cfac98728dd3c\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"266c3c7d999e020d\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"0a3291875da95dec\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"986688715ae36c27\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"56c5bd2ec39847a0\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f1fb830128f8654d\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"fc445e7196cc070d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"71a3cc1e30628422\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"13cc8264dab841bd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"59af78bba0632aac\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d07405a0b7aed8da\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"df3a16926e03d4ef\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"ee2f922816e91622\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"cc7c5cdc62879920\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1a57c496f4100ba9\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"029d5d6f3f2226d4\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"303805383b1dd629\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"0b1c99ae83165159\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"4572ba2f97b6f33c\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"654639e399530d32\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"86c47f5742d25209\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"4e09a6a4125d4ca8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"2c5b877fd23a267a\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"9f560e7c21527066\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"ca32e510f27932e4\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"ab2a9e3510eb2e14\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"5befdbaeac1085d0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"530901811d64bf74\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ee577cce529d4ffd\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"631fb837ee4c1e0d\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"a898b4bec15c740a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"c3641aa32fbfe8db\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"127e37b8b822078b\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2fe10e63f2b4076d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"4c873eaca775cec0\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ba3847f267078aef\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"5809f994595585cf\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"e1d0cfe66c850d15\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"8053d279c102bc37\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"7304c599f9a5188a\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"818af5479b09560e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0137ceb8870e3887\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"d88ac1dbba318c42\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"01aea47953cfa738\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"2e2bdc34ee00b4c7\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"658dfc3d70ed89e6\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"118115806cfdc7cd\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"de1580d09bf7ebef\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4349742f097f4ad2\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"0dc0c9c4629938ed\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"1acaa22b6e2438bf\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"6a1ec669a6802c07\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"5fff79f03596733a\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"f29a2166f39e6466\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"eae2852f33c177d9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"0ea3a5ade3a91588\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"af4121a35131a1f9\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"74d2fdfc08c31fb8\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5df6eeaef822d722\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"e73f05877657b387\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"dc839dc56cc4e9f3\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4cc94b0c7d7c632b\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"25bcccfb461f079a\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"407eade03451904d\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"54e107822760c1d4\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"c08843bcbd9d6eb6\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"3f70bef447d5d289\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"866ccee717dc59ce\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"dd87f125fa22c9ee\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"50452b31198c0f78\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"e14993e05ea9254a\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"77d469c1a615c03a\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"c12ecc6c9be5ed66\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"5939ceb0975f1da7\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"3f428af428751c3b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"00599924abb2ff35\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"147345965c43f3f2\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bcb3ee960231b06b\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"8a3b0ed455d26c17\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"dfe388ad2fd40090\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"9a888fd3731b87d9\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"c0a1ce83f3df0260\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5186ed7700553176\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"811bb1cd4b5ac528\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5fe366631d8ecea6\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"1ec5f412b1d25c6c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e03ab201aefe30ab\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"692751e7a5fadbad\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"0d19fc04acebf986\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"d9995903ad4087c8\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"9bc8be68d37e927a\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"1bf6ed7ee084092c\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"431d23d3573111a2\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"20df118ba22c5d57\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"0b3307cc9948c5cd\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"33d10a3af61aa7f3\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"3541107f19b6d50e\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"2dc651e683f66e5e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"c08f97612163c7c2\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f509a8e1d2e21588\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"2dc107a2f989ae69\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"b0b62e2e594d6b2e\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"afa5ef1098cd8e0c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"28afb6b34ea54882\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"b628f8cf83fbaf59\",\"/knowledge-medium/src/plugins/geo/index.js\":\"842c784258ac9cab\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"0ee67607fc2abf58\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"4af8a2680f964249\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"b6f1e3ddd7664a26\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"301a7aed7104ebdf\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"89ddc45cc22fd522\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"50a93767dbdc4a5a\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"129e360c4653db08\",\"/knowledge-medium/src/plugins/geo/query.js\":\"4cefaed726dd5cb6\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"959877a7caefdd0b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"73b3a6fbdd2d66a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d6a5c87407cfd196\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6d71ad895428539d\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"bcebaeb01aed9f82\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"3c5669cafa22f11e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"20cbdd7b93fba9e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"fe603babab9a4079\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"33f258e2a5f140a9\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f9847f1f82b768e1\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"7f4c3aa4d30a6663\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"3a79f6cbf8874ac4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0a5470d59cb3f3f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"14ecdded2b56757d\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"2463b72f836a67d6\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"283bbfebe2e34ceb\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"50171d675ec175f4\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8e4e3bf2ceb3fc72\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"689d2b2adf65b804\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"d84a51b4c783dc9e\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"4d02c08afb1832a2\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"1cd00f13ddfee191\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"006d2cea6b4f3a09\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"e244bcb1791c4cab\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"0fcddbeb5ad18b6f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"cf6df54db85ec096\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7824ca71c5d6189a\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"d77fc914d61f4f6b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"3c945fbcb2476fdb\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"d12635e6f920263b\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"8e26fa6c238f8242\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"72acdf104fe317ed\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"b5c78c8ec9f74bef\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"42fea26223ab5db1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ac1b8ae9e9d74994\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"4aee429ca93f6079\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"50031962fda12816\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"0fb0fc9b01f82536\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c12aa21cfa005f95\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"e98115c435150540\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"49ecad3a8363643b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"fab1ad298dcc1893\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c488eec257ce610e\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"97bd8924c073fcad\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"4dd88201782e5367\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"14cc6948795893f3\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"be2e8dd32bc6b2c1\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"e3621bcc12060ae7\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"d1df0de3764f8ecd\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"22dd9dda70536224\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"b36ab11ba6407f09\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"6294d7bfb0f1e6c1\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"2c248113e86cab06\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"90ed9601fa5b1274\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"02ed215dd422dd7c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1df43599bd9f7ea\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"740d1119bea5d42d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"915492052dffd22a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"a3d97e88e06892c3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"768145a867546220\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5819deb39a35d499\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f7461a0e13060a83\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b69dbcf5dc044c20\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"574141e3f1d24c36\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5a3a4d16b70a4d82\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"81156755a2c54014\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"3ed88340adfa4f82\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"b8cd8af9dcfcd89b\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"3d3ad5a57508bc7a\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"4448c104873b3920\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"03df033636a1fb70\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"6f50d2981b1232d7\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c704a515ec2011cd\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"5af5fc212000b5ca\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9f8a5d29049a0564\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f47005044126ed08\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"70374bfad711f80b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"581d693b859523a9\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"fe8eba258c5d4483\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e5cc2324fda67536\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ec5191460d9c1a12\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"06da614ad8de3370\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"efe07057a00c9556\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"0a15ede5b5a9f5e4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"633f62601b1dceae\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"043d3f8ccd4b79ee\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"b8067804457443b3\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"4d595622bd375980\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"337ddbcb0d5a03f1\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"24aa0e72dcf1f25a\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d5d8a20e71ab3ad7\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"404b9b2c2ccde810\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"9eb6510580f2b94c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"8c550ea43455fb70\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"88916330209ecbb2\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"0eb72e2200a021c0\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"d830355909ed67cd\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"4ee847ebb9349ad2\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"04ad64193cad064a\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"0dee2601826c1072\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"58892449e3a21195\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"367b45922171a47a\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"63c9e17a08466449\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"0b8eae7d1f4c87bd\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"4bc89ab06434e33f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6ccb8138c0ae66bd\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"20903b8ca4520bba\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6fc7aa74fa8baae9\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"2bbab712adc7817e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"8caef5adbfd3cbf4\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"cc878adc682bd026\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a899f2c437e6fbd7\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"3772b20ea192ec6e\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"dfe6c39872129a63\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"0226bda2711dcdde\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c390be4313ab6eb6\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7f5f033d0215e4e6\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"0577dbbf36e7ca37\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"aa93a6e0076ee561\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"4d95df4d89b9af66\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ba846cdb8962f7a4\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"cccf63b860f5cd15\",\"/knowledge-medium/src/plugins/recents/index.js\":\"5291c3fb1df9d914\",\"/knowledge-medium/src/plugins/recents/target.js\":\"6ca1d8870bfcd22c\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"4cc0f379387edd97\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"e65f42d879e79eaa\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"e95735043a7889e7\",\"/knowledge-medium/src/plugins/references/index.js\":\"bf4e73e3f5780d89\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9b85f55735026bff\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"1be4e078cbda3012\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"a09e2ac433a9be3a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"53255b55a4d20a81\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"912bbb4450dc36b0\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"2bfcbabf157a803a\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"465596a6f9e9e371\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b6faef3ee6338183\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7a09cdd2da96f209\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"1d709b91e68f171b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8dae2a909e9738a0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3e527a2638646938\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"0ce7e2f70c8443aa\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"5badc586a4606e2c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"b833575b604ceae3\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"468ef924cfcb24ec\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"2abf3d3c47e353bf\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a2b52ce2d9ab7b0d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"cddf8be272735a86\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"3051f64e8796cc5e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1a0f26caa3ff12ee\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0bef1c56d28bb4ca\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"1b3a1be2a4aa0225\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"43375555d08835a7\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"bc7ce5a2f3946859\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"772c7bcad8db40ec\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"51f9449d911102be\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"8d11cea6588e8733\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"2c6d91871d795e28\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2218caef6267487b\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9933a11ecaaa068f\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"0ce2a3623186c4b9\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d2bbdfc2e2c38fab\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c33dc5da3addc9ec\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"7e9b299d009498bd\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"88dc30a37f3c2a61\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"643fe5f424cfe324\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"a4e08ab9d642b172\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"12122b81ccc469ea\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a094f13b47427812\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7b1209ecc7040571\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"683d82abe29bef6c\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"933960c8086cfaf8\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"349e077311b51ba8\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ab478da35ad9056b\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"05d44428ec2c59c0\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9dae9fe6c71a1156\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"0de5b7832655beac\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"9a96756954e24bbe\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"8a47bca9092b21f2\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"b670efb211388ec7\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"56c42577b88e5941\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"73d2f4a34a6f858d\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"03a5c24dac2e52de\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e015b0b56ff9f950\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"b3ddd44dd124b3b2\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"01bd5bb9df077829\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"0cf7f2024055c8cf\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"1f4954ba9a617fd5\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c4c483fb1d04fb1e\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"0a059c1406e64ead\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b0058cddf7323f8a\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"99fa4e5051c3609b\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"b7ec7b2a154c96ab\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c4bc994e4a4aaa88\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8a89f3d26d5cc71b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"67e0ea2ce48c7a77\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c7b995a79bfbc9b0\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"40b93b605ad689f9\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"eb51b6e4123660e2\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b9aeca2e73051fa4\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"b5e73236b31f8351\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"1762b8eb7f71f963\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a74c28e66dc7416c\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"0eb4bf99471e0068\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"21b40cc4218ea8f9\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"5da7e31488d68b8f\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"7ae01fd43f8a572c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"b8fc3550cec9b406\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"cd3ab760d9dfcd45\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"dd4c73e8e8de062a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"998009d847aec8df\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c69c36ca1336d844\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"ab76b65c9558ee86\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"59f5c749fc01d123\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"302e35ac6cf4b125\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"ca389b3abd8e3099\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"7668ab67a0ad289d\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"280bfabe6506c2f4\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"62353674af81871c\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"bce2bf92d7f29e24\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"5ad8b03cfb94000d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"f63ae849539d07f5\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"ec9501582edb1192\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"92db3d3b212b2344\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e131ca372466741f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"725d934b68738cba\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"86d7a35068dacac5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"a0a068c5302ffb9c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"bea7be6835707a40\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"fdade8439de7f46b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"696b06889f0c173d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"75001f039f4f014a\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"f5924f9bce0b8de0\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"32bcf2ec19321236\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"7092e204994d46e7\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"71dc1143676270f3\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"84f1d61384a2215a\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"794a7a39fa8ac679\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"62a8c5d254f46a25\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"413c6a3cf16aa22a\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"ef7f1a3eef831f20\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"ec7b6eaa4761e7a2\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e836764cdbf3e230\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"0b41f5fa2bdfa59c\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"9276ea4b90385fb8\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"5407419e031473c7\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"80a6fab41a77be00\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"6206c2c0038e796d\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"cc0b433ba8e4140f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"5a1080e23f83f336\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"47f245807cc8baee\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"fd5fbf22b01b91a0\",\"/knowledge-medium/src/plugins/tables/index.js\":\"02b761530ad3c25b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"284c467ee91e5a51\",\"/knowledge-medium/src/plugins/tables/model.js\":\"5b8faf3ca72cc0fd\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"01505b0ce32ae93f\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"8f8d680e0d248db8\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"7c55d3e2b653d7e3\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"3591d09d23541388\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"77082148ddb743f0\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"4bfb64e8c8b80040\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"acef8e79fda6b0ec\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c6e9bd071788e5e2\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"abea0374f9cee208\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"685d774856e6e958\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"7251a87b5cea43f3\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"94f6168bfbdb4a12\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"bc765325f057864b\",\"/knowledge-medium/src/plugins/todo/index.js\":\"ea78b2927b607b85\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"986d032732c6218c\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"79c59ea67830dbe3\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"be2f07a624beb52a\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"eef298f46d35bced\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d959e2280ab4512c\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"f66de56212170577\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6f2c921474b3c425\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"8a0d1bc830fe5c71\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"73af180f3a27ac4e\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"605f2eab4ec8d7a2\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"4abf15ac18ccfe70\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c79eca7fa5dfb064\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"353ca10634ae7fa7\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"b53d4e0b62e8e4bf\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"124744701682249f\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"62183ac43c38a07b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"dce2c1d725264482\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"884940840849ce17\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"67102170a760d982\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"a0accf9288c133fb\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"0556dbbd6f5838db\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"06b01b00afb3cd14\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"6e10a512ea282160\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"906aaee46b0a8992\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"dfa6fae8fa3bc758\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"6e2cc5a5c2b10661\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"ac721c1689f7f326\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"752cb68e88b46286\",\"/knowledge-medium/src/registerServiceWorker.js\":\"f09f9ba4fec1a4c5\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"8b0b5719bc65df56\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"5d4b4d17c91307a6\",\"/knowledge-medium/src/services/authStorage.js\":\"d427c347b1ac1e54\",\"/knowledge-medium/src/services/powersync.js\":\"34090b1927e106dd\",\"/knowledge-medium/src/services/supabase.js\":\"1011dc8db129eaaa\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"d629b05e619ba580\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"3ea0dda6c8d09b6a\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e10fdfa8918ce789\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"6b6339db21630ab7\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"649186e7ed5e8647\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"d41862b6ea7407d9\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"f9a593cfa839273b\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"86ea2bce457aa200\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"f5783229ad182adb\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"f16744e3a3de1269\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"bf631add5c66f889\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"a013d8b6cdf03ceb\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"ad31722b18bbaf57\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"9e625d44e085b8ca\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"554a073ba93a4f51\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"f6d510f40e39f3f7\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"8dd9f6aa12d48332\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d119331eab6b7b12\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"7690f0fd70ee7117\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"d1764485eef0c3e8\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"bb71607430a403bc\",\"/knowledge-medium/src/shortcuts/types.js\":\"5df831806b4d8650\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"ce65b36c153812a4\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a0b0d2af49ee91b0\",\"/knowledge-medium/src/shortcuts/utils.js\":\"a3ec813644e4a1f1\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"150bb886041f1552\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"b91cacad6e66db16\",\"/knowledge-medium/src/sync/byteTransform.js\":\"21bb6e5b02a58090\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"bca4ed74e0ca6dfa\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"7a502b331248d8f7\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"82642e9f7d9a39ce\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"57281cf0051798ab\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"5633e4d9448b39ca\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"5720287189c3e3cc\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"69133d57d3e77803\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"0f7421fb33d73d86\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"bff966c4967bbda6\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"5a8a24171f8e3ca4\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"458b58645fdf4507\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"00fb153170ab508b\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c04ae08a7832207a\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"e06a0c2c42cd229b\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"e59301aee23199ef\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"e0705e8ab98796d0\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"68aef59b697e3780\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"a74360c859615cb6\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"1cf7ef7731f603a0\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"1f012f125a7dda06\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"9dab6d19ebdba3c4\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"2bb29356a4535f85\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"4378fa232e8558b7\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"f57c4824c47ba356\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"dad60168ca29a6ad\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f143383a8246f753\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"1d38dffe0f68f7b2\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"325b7a01b9a7e449\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a44b99b5d062644d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"282a528257481396\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4b4da72ab5832d7f\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"ba382f2272471635\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"f67e3dee736315e1\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"75ac1d31eb68c62b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"43207f379bfc7a15\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e8a0c7d69ee46733\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5be3db1834ad770c\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"ddfe56f8c999b5e9\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9965f19df8ec09eb\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6fb396d6e17f8330\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"4f032f0feb8d38d7\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"bf9a8aa0de3638db\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"c2bfc26e98d3f75e\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"0c2d4f8e55451f13\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"2362acd91423fdd3\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"8b28debdf139e547\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"d2149b2cf70806a6\",\"/knowledge-medium/src/sync/transform.js\":\"de7e4e01650d154f\",\"/knowledge-medium/src/themeBootDefaults.js\":\"7b5cf6b59bc87fd9\",\"/knowledge-medium/src/types.js\":\"2eddd3747d06944b\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b54d75ee0a1786af\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"52d5d3a50e4e6ccc\",\"/knowledge-medium/src/utils/array.js\":\"d5dd70dcbb38e187\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"ed63e9862429b1e8\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"5dc6dda6a0c88f69\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"50b464e4d0437f9b\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"cc44e276e54465d5\",\"/knowledge-medium/src/utils/callbackSet.js\":\"2aa3b28334e3d361\",\"/knowledge-medium/src/utils/clientId.js\":\"d02f0e018aec5005\",\"/knowledge-medium/src/utils/codemirror.js\":\"f798fee29ec3d6da\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"11c64e94dcfa072f\",\"/knowledge-medium/src/utils/copy.js\":\"02d756c5215cc54e\",\"/knowledge-medium/src/utils/dailyPage.js\":\"200713458a53a0f8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"268bcbf00d607321\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"585ddb62b97da604\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"1ad1096ef0e0afe0\",\"/knowledge-medium/src/utils/dialogs.js\":\"63874bdd036fc020\",\"/knowledge-medium/src/utils/dom.js\":\"99cf621df53c305b\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"a8c8aad8a1e04058\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"aff3e5e0c7f55173\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"d305b09a2a9d176d\",\"/knowledge-medium/src/utils/flipSlide.js\":\"7c75bce2eee089d0\",\"/knowledge-medium/src/utils/fnv1a.js\":\"1d226ea0804959be\",\"/knowledge-medium/src/utils/formatBytes.js\":\"a9ee3cc794d2a28a\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"224e2c7915d5626b\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"ae990a8b418af1df\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"00884b97b0d50fdc\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"30c506cb2b60f16c\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"7e450296720effde\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"d6ba463227f74795\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"3fe454261fa12d7c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"3d5e0d02d447b710\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"2b7aeacecd079adb\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"c34f5896edf8de33\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"3325fdc9b3950ecd\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"dad854a76d9d0455\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"6c9bdc2b3449d97e\",\"/knowledge-medium/src/utils/markdownParser.js\":\"3fa1438dd0d7fe66\",\"/knowledge-medium/src/utils/memoize.js\":\"e61c9c0eac04b335\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f986e0821bf90625\",\"/knowledge-medium/src/utils/nameList.js\":\"d465b8768ac81bbc\",\"/knowledge-medium/src/utils/navigation.js\":\"c61007459330bf81\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"75528455fdeea64d\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"2cebde6086f2348d\",\"/knowledge-medium/src/utils/panelClearance.js\":\"337a27c738740912\",\"/knowledge-medium/src/utils/panelHistory.js\":\"99d73500d74db1ce\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3836c6ed463b2755\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"33dacef21047c4a9\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"9d7053a5fd63778c\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a32127712bdef118\",\"/knowledge-medium/src/utils/platform.js\":\"0dc64cdb5476d36b\",\"/knowledge-medium/src/utils/pluralize.js\":\"2a2a2d80f8ce2929\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"9750d28abcf72a86\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"be8d84b5a5188ece\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d8b52acada955408\",\"/knowledge-medium/src/utils/react.js\":\"0c08355a2c8d8e5a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"72d938273adbf407\",\"/knowledge-medium/src/utils/relativeTime.js\":\"55a03a1694b3a89e\",\"/knowledge-medium/src/utils/renderScope.js\":\"436409aa846a3fec\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"516344bfe8c5dd74\",\"/knowledge-medium/src/utils/routing.js\":\"4855560e8e6095de\",\"/knowledge-medium/src/utils/safeMode.js\":\"f454a32fb6c4b1a1\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"f868f299852f324a\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a535bba903295412\",\"/knowledge-medium/src/utils/selection.js\":\"c07e945a1eb66e45\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"dd546365d91822d1\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4b26b2e2d750d438\",\"/knowledge-medium/src/utils/state.js\":\"f81dbd3773e297e7\",\"/knowledge-medium/src/utils/string.js\":\"b01f87583af62787\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9b635d520c17f05d\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"20dea9b540ef34e9\",\"/knowledge-medium/src/utils/toast.js\":\"27305ec65c5be041\",\"/knowledge-medium/src/utils/toggleStore.js\":\"17c69483351af43e\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"2351b0c6d2483f7a\",\"/knowledge-medium/src/utils/userActivity.js\":\"0e356da4261224d4\",\"/knowledge-medium/src/utils/viewTransition.js\":\"a1dad005efd09b3f\",\"/knowledge-medium/src/utils/viewport.js\":\"2c2da70f6dcd6633\",\"/knowledge-medium/src/utils/webLock.js\":\"ac948f5624ac173f\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"45c8930728eee154\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"db62e94ea79e240c\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"13f0d1a6c150da68\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"dd52c69fc4c135dc\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"7f4ef7769df68364\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"12edd321fb5bbcf8\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"26c5f402d03628b8\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b7081629c339663e\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"a14ac75ee47bf552\",\"/knowledge-medium/src/vendor/react-dom.js\":\"529cb5c92905b72a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"2a3b252727c18945\",\"/knowledge-medium/src/vendor/react.js\":\"2c7f61067b4f0b8d\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
