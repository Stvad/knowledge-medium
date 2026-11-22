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
		buildId: "793589fff4bc-1d687d36",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"17201f5ca58b8e6b\",\"/knowledge-medium/index.html\":\"17201f5ca58b8e6b\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DqaLLnnX.js\":\"05dfbde353795c6f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"790ca0b5005bf36e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Bw4w6HtG.js\":\"e3d6e0e94bcadfd7\",\"/knowledge-medium/chunks/FacadeVFS-DARTB5f2.js\":\"5e05a58da947454a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DUlRh6WS.js\":\"93d15298acd8657a\",\"/knowledge-medium/chunks/MemoryVFS-D_Httwxp.js\":\"4c67233c400019f6\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BUkNOTiW.js\":\"9d72142e9bfa7c97\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-C3J0WMLJ.js\":\"15f73658eb099ab8\",\"/knowledge-medium/chunks/Preview-Cq1ExirS.js\":\"11e6bcdefbc9f689\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CsTOu5Hj.js\":\"ceeea6b7157ed8a9\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-0x5bYaS4.js\":\"d93aa15b3b2b27ad\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-Bh_L2jM7.js\":\"fcc4906bd18ec7fb\",\"/knowledge-medium/chunks/react-CGaDx2cw.js\":\"e24ed174a07d21bd\",\"/knowledge-medium/chunks/react-D1DZJQh5.js\":\"905a302301e186a5\",\"/knowledge-medium/chunks/react-DMZW4oMr.js\":\"7f70a44ba5209881\",\"/knowledge-medium/chunks/react-DMZp3FXI.js\":\"c7d37ad3aac311dd\",\"/knowledge-medium/chunks/react-DmLz4-fA.js\":\"bb0f1cde38e73f4b\",\"/knowledge-medium/chunks/react-DvRHP8Fx.js\":\"5d66782f8255a883\",\"/knowledge-medium/chunks/react-Dzqe3HDQ.js\":\"fd4a08553fe46360\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BaDBuKvv.js\":\"8f5e9cff31b5f45c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BLK2cDSZ.js\":\"844d29c1cb0b1c4a\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CbLALJMw.js\":\"cafba5c642e117f7\",\"/knowledge-medium/chunks/server.browser-BzXdwQjU.js\":\"1aea31dce4265f88\",\"/knowledge-medium/chunks/textarea-vl3uHnqj.js\":\"886cfd5d7bde4eb9\",\"/knowledge-medium/chunks/ui-dxJwnwPC.js\":\"34653771c74da140\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"e08909e29c1d6ec1\",\"/knowledge-medium/src/appUpdate.js\":\"5f8b8b80c5ddba84\",\"/knowledge-medium/src/appVersion.js\":\"08f97e1aa6f2f17a\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"f207f150abb9698c\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"19c19edf93ddddee\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"2d0172bf83bbff88\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"b4cd3f83bfd5ce7f\",\"/knowledge-medium/src/components/BlockComponent.js\":\"4f80e2354b6043a7\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"9086cf6a6cfea0c8\",\"/knowledge-medium/src/components/BlockEditor.js\":\"21ab083d2e47e861\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"12e8417df33760d8\",\"/knowledge-medium/src/components/BlockProperties.js\":\"e2af8ae225435654\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"53f35479b9272d33\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"9aaff561165fea40\",\"/knowledge-medium/src/components/DividerHandle.js\":\"646112e5c0f64deb\",\"/knowledge-medium/src/components/DraftEditor.js\":\"7506078343f49f5a\",\"/knowledge-medium/src/components/GutterPill.js\":\"089b33efad0876e3\",\"/knowledge-medium/src/components/Header.js\":\"9d12b1ebd41da317\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"5ab009973b33a43f\",\"/knowledge-medium/src/components/Login.js\":\"480550ec9159d958\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"0b656a874b5117ab\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"02a746df3775ded7\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6b9d851d31d07162\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0e49b2c8205bdd8e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"70eef5d99caae6ca\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6a052e507bdb5fc8\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"cb1bfd96756e7a3a\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d6dd0767ff2fa019\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"945ca589d59c49bb\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5611a51ff8112d51\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"4fe8a5a78a99f90b\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"d37d6315c8085607\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b0e55e33d8afb227\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"33733aaaa3b7bf4e\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"0799d3ef124c47f7\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"437e5b76b40a0b02\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"bc069d83910644cb\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4043f91c7c796a01\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"ebb28a5bc31b5ee2\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c631062aec41e57e\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"59689544e7e66da1\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ac7b66039f327cd8\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"808fadcd6c7c9cdd\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"bd2ebbad870a1881\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"73cb1a78909ddbd8\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"143579b21eb03e51\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"82fb0ffdec633561\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"e5113df8c059188c\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"f54c34c8a3007f6b\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"15cb9f1bb4214cdd\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"09feb27a00e5414a\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"6debc7d764e9665b\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"ef1b96bdcd0f9cac\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"f58518ceeb36a83d\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"ef2b740c0d7956f9\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"df23eba8aeff01e4\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"a04317288756c607\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"267985dc11cd3b3f\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"fe8d5f20532b907a\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b86cf5a2d422addc\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"ad402d227b84bb72\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7276965f379dc31d\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"8e536059227197c7\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"224e666c215336d7\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"a5c0c480bcc3551a\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"a1beb32699a09a4f\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"ddfe0aebd4f9c24b\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0d0ad4d85c536a0d\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"8f65635afe80b28a\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"6a03262133016e24\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"3d6d1b61b5ac4478\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"2ab424a5e6cc9f71\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"c9e7e28d706c2bea\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"d1656f8c598320b9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"f9ec7d66a9e82cfd\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"70892e4e0a740097\",\"/knowledge-medium/src/components/ui/button.js\":\"9b99bff47c63c10a\",\"/knowledge-medium/src/components/ui/card.js\":\"eb904db873085a9e\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4aa398d9debd0632\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"fa4d2992565fdf70\",\"/knowledge-medium/src/components/ui/command.js\":\"e875aad5d723eecf\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b7364c5a8c220f35\",\"/knowledge-medium/src/components/ui/dialog.js\":\"b59beec21d629439\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"0586718dcaf25847\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"5f2146d20a08c570\",\"/knowledge-medium/src/components/ui/index.js\":\"dac8ffe924b37211\",\"/knowledge-medium/src/components/ui/input.js\":\"67d688fb7cb063f5\",\"/knowledge-medium/src/components/ui/kbd.js\":\"29f6a4c6107f6d67\",\"/knowledge-medium/src/components/ui/label.js\":\"b946ff841058a861\",\"/knowledge-medium/src/components/ui/textarea.js\":\"39821a924e60eb9b\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"8a597142e16a6670\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"6b749d94bb808465\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"5654e4044deed034\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"86b48b32c34f5f15\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"44449533e9f7273c\",\"/knowledge-medium/src/components/util/error.js\":\"bf41002b056fcab9\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"d495f19d27799f5a\",\"/knowledge-medium/src/components/util/suspense.js\":\"ae288ff950084049\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"000cd4af25af2f68\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"c0f84ad759e56bcc\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6f3420f93101f614\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"e6947c385f2d83e5\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"5023993a501c61ce\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"a7b23d4e802ef009\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"e68dc14f6b4b1a7b\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"9285ad9045e8446c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"08cf6af026a35312\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"97da13b63620b016\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"2dd768387044f8e6\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"40daae7b2267aec5\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f3a812f922700274\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"ad0e4a3335c48658\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"91ac6276a526a0f1\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"ac9ff6d4d5b1cf74\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"184db5ed90972586\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"bef5067fdef3cdcc\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"2da0358d9effd7e2\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"acd339caea40f2aa\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"1139a434f72ff4a6\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"9708935c1341c819\",\"/knowledge-medium/src/context/block.js\":\"3ca8fbfee895e5f2\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"e3179e346298dd22\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"cc85ead11a9b4d15\",\"/knowledge-medium/src/context/repo.js\":\"61e8996a716b5f9b\",\"/knowledge-medium/src/data/aliasClaim.js\":\"9a192bcc1817f7cc\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"73f41e5efda9db6e\",\"/knowledge-medium/src/data/api/blockData.js\":\"f7b70827a524b1a4\",\"/knowledge-medium/src/data/api/blockType.js\":\"66502928c5f6fc16\",\"/knowledge-medium/src/data/api/changeScope.js\":\"eee0dfeb49d1bbd8\",\"/knowledge-medium/src/data/api/codecs.js\":\"5a6b5d7ff6d69225\",\"/knowledge-medium/src/data/api/derivedData.js\":\"753fe2d37230b913\",\"/knowledge-medium/src/data/api/errors.js\":\"c2e28f1303fb20f8\",\"/knowledge-medium/src/data/api/events.js\":\"6851e0dd65bde8e6\",\"/knowledge-medium/src/data/api/handle.js\":\"2e44f1e8a0760696\",\"/knowledge-medium/src/data/api/index.js\":\"1f3a92b326d1c599\",\"/knowledge-medium/src/data/api/mutator.js\":\"f415b6f5f49a85f5\",\"/knowledge-medium/src/data/api/processor.js\":\"319f6529a9936f52\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"2501b3e327b617e9\",\"/knowledge-medium/src/data/api/query.js\":\"78ddcb0ad5fd29fa\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"dd26495e986c38b9\",\"/knowledge-medium/src/data/api/schema.js\":\"2e44f1e8a0760696\",\"/knowledge-medium/src/data/api/tx.js\":\"2e44f1e8a0760696\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"d4ac735cca69df57\",\"/knowledge-medium/src/data/api/user.js\":\"efd6650edab6d49e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"07f74fed30113f83\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"7ec3b8b341baf332\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"b99a8051d2160d33\",\"/knowledge-medium/src/data/block.js\":\"5252eecc624de0f7\",\"/knowledge-medium/src/data/blockCache.js\":\"47c35daef2edb283\",\"/knowledge-medium/src/data/blockId.js\":\"e97b735c5717fbb0\",\"/knowledge-medium/src/data/blockLiveness.js\":\"51eedc0f3b0e6e02\",\"/knowledge-medium/src/data/blockMerge.js\":\"2ab6495353470502\",\"/knowledge-medium/src/data/blockSchema.js\":\"9ba5f39f1a8dd524\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"503fe32b78e8b5c9\",\"/knowledge-medium/src/data/blockTypes.js\":\"3f92ad350c0ea696\",\"/knowledge-medium/src/data/clientContext.js\":\"2318311d8a5d46f6\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e27fddedff4635c3\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"0ff198cec7b684d0\",\"/knowledge-medium/src/data/derivedIds.js\":\"0b29eca340486005\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"6656662feba0ba1d\",\"/knowledge-medium/src/data/facetBridge.js\":\"99b1b760b27d2d0e\",\"/knowledge-medium/src/data/facets.js\":\"7c73dff82b33a5b1\",\"/knowledge-medium/src/data/globalState.js\":\"60eab6d79478e583\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"3bcb107df67d549e\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"5c3764693ef319e9\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"eca358187299b136\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"da5ab762d11b476b\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"836a1f8aa1dcfff3\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"df5930b4e440d98d\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"6a66d8b0945d3f3f\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"2bd5ea97c3e16698\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"4f39331f62730753\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"5c645c2efa9edf48\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"cf18f4132de5a515\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"82f2a0160eedc96b\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"16374583953f87f9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"da97c8e9a950017d\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a4bf9534abc5456f\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"34ee6bd51646ef07\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"94a22bcfe7678590\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"35a609fbf070c199\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"f660eff4e5fecf11\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"41acda8f35bcc41d\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e38225efd7aa8479\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"5c142c856dc67840\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"77b1972ac5af266a\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"766da20fcfd136f1\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5f260151b7fefcf6\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"f49a16527032ce97\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"f7f5be8ae38a396a\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"79abf3987b4c2537\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"f6a9bc05b1ab9495\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"529c2e5899a0b145\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"82a0329e9c41c4ff\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"38d28c729be628e1\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2eaf98ec81135e2b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"f720238e20a84d77\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"cc0d51331a20d18f\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"e6bd26ef3ee2cf3f\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e782a700af46a9d4\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"92a7d23a971aec65\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"2fb731f9d4b23eda\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"18b5a09d0e733ec1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"cb8269a4aab0e75b\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"549a4d32f746d8c1\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"6e2b4aba9a59c31f\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"411f5a8374243096\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"22b26f6637a067b9\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"3c7f326766b10c3d\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0fe41f8b3e8e63c3\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"f7f79946d4c49286\",\"/knowledge-medium/src/data/invalidation.js\":\"de0d448f6fb67104\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"620af9ba72f1a8e2\",\"/knowledge-medium/src/data/kernelPage.js\":\"e232a2ce327032b9\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8c0c11c148a10679\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"0fcfe8c7d446f847\",\"/knowledge-medium/src/data/localDbStorage.js\":\"429c5a3cdebc27c1\",\"/knowledge-medium/src/data/localDbVfs.js\":\"70c123da263606a7\",\"/knowledge-medium/src/data/localSchema.js\":\"c9c7ca4593dcb805\",\"/knowledge-medium/src/data/maintenance.js\":\"1d7e1375e93ec50a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"1ae2217ae3810c90\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"09322a54d88d0d87\",\"/knowledge-medium/src/data/migrationsPage.js\":\"b9ac155c555883dd\",\"/knowledge-medium/src/data/mutators.js\":\"a663b2dfe92bf399\",\"/knowledge-medium/src/data/orderKey.js\":\"9879fa85bf5bb39f\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"370b8d4c4166d66f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"7eacf604fae66fb6\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"6049e33fd9fa4c22\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"3327f0f89725e2da\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a00186999e214aa8\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"2fe4a63820e59631\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"2c219d90f0d38734\",\"/knowledge-medium/src/data/properties.js\":\"4f8a1383aa2d651c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"3157491b15f0b408\",\"/knowledge-medium/src/data/propertyChildren.js\":\"88d2be4b977fdb3d\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"617525d77e1dabbf\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"f406382543314f75\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1f88576f8f4d33f6\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9dd36282efd88b74\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"d4b9c4fe8b3c7af3\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"b0e62acbd00b384a\",\"/knowledge-medium/src/data/propertySeeds.js\":\"1d63d484144d4501\",\"/knowledge-medium/src/data/recentsPage.js\":\"4fd20827b5fdbec8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"1d4a2c740b4fdf97\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"1d6f2e840f24f428\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"aca6fc383aeb3591\",\"/knowledge-medium/src/data/repo.js\":\"b8519f8e21c4f131\",\"/knowledge-medium/src/data/repoProvider.js\":\"f2014321bb914673\",\"/knowledge-medium/src/data/rowProperty.js\":\"dfff77b6a47a1d07\",\"/knowledge-medium/src/data/searchFilter.js\":\"eb862a595f3a5d0e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"19231c89eb2cd1f5\",\"/knowledge-medium/src/data/stateBlocks.js\":\"4acfd1d7ffc8c478\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e4c912509a28368e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"8b493011a98a91f1\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"c8385fbb9b3a8a61\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"6a6f2c8866ba99d1\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"72ef393225bdf3a0\",\"/knowledge-medium/src/data/targets.js\":\"2c0a4ef175e21c60\",\"/knowledge-medium/src/data/typeColors.js\":\"fb6434c17823b21e\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"3d3410dea4f34f34\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"c4603d2813816ea7\",\"/knowledge-medium/src/data/typeExtraction.js\":\"cf6b6658ebbb8ffc\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"f9cac1c9be7704b4\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"167fdd5d9d801fb5\",\"/knowledge-medium/src/data/typeSeeds.js\":\"16b9351244b79a55\",\"/knowledge-medium/src/data/typeTagger.js\":\"1b4305e93f04af2b\",\"/knowledge-medium/src/data/typedRecords.js\":\"9d30726290639e97\",\"/knowledge-medium/src/data/typesPage.js\":\"856b143f6f48dafc\",\"/knowledge-medium/src/data/userPrefs.js\":\"f0c34b7337210c54\",\"/knowledge-medium/src/data/userSchemasService.js\":\"35a9525947c4d99b\",\"/knowledge-medium/src/data/userTypesService.js\":\"50124dcc872162ba\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"daa8298c487d0939\",\"/knowledge-medium/src/data/visibleChildren.js\":\"26c49a8ed689f51f\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"62faf9777945bde7\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"77c060275b03ebd3\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"4e4f68d8fb960b8e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"79285ad30a4b4bfa\",\"/knowledge-medium/src/data/workspaces.js\":\"0cf6d3a57cbdfa5b\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"a32773e944af6814\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"0af1c171b0eb69ec\",\"/knowledge-medium/src/editor/atTrigger.js\":\"177acbe07cb91862\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ae59cdce8c8cd15b\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a3e0b1e64af0b0da\",\"/knowledge-medium/src/editor/contentFlush.js\":\"02365dafd39ced63\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"2026dab0faa59c90\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a3691159376ba581\",\"/knowledge-medium/src/editor/insertImage.js\":\"f69e1607eed9c465\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"3c4e9d1e9a8bcbef\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"5ed4fd9332889246\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"15df2b2983755ce1\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"5681cce9e41297b4\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"5c6dc9d8756e8bf2\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"aae234d7c83cc0a0\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"57e37b326e395c32\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"615ff1dc2861c708\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"eccc5d7f707a076a\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"51d604d59be44643\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"c65e27b9ec559c70\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"8c10c7639b313f9e\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"63bba064f230a4b2\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"9f7d3dbfcc4367a8\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9f53ef094d51783f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"3627d18a942c660b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"105491e7e2d12dd1\",\"/knowledge-medium/src/extensions/core.js\":\"e292115adc2eb688\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"877d06057617d8a5\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"557917aa39a7331d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"a9b33481afa82925\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"01313fdf927e71a7\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"0723ec4a91642008\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"711bae350aa631be\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"41f4f08351324219\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"4cc15675e35f0f7a\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"b6d4cb93bdd8c262\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"5d390c387a79fd33\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"eaffce491e3a58d8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"6ddfb72fc587abf1\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"f6e7c3c24196b08b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"3789a398b10f9409\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"eb9180682deaabf2\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"b695d91584088948\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"a44f4e027197c04b\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"e694d0f4423a6cdb\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ad1db10a9cb76fae\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"631a665f376eef38\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"24792794d10cb59a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"818ccca165217379\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"2f9e6c26fc50af00\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"4f231c7d2600c77e\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"7e28056e2543ce4d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"e4eba6f5e7ca5a5d\",\"/knowledge-medium/src/facets/facet.js\":\"92cbf14086de9dd1\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"549627145e7d696d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"5285d050d47693f8\",\"/knowledge-medium/src/facets/togglable.js\":\"b2d0ae079ace23e2\",\"/knowledge-medium/src/facets/variantFacet.js\":\"6097ce3ec688391c\",\"/knowledge-medium/src/facets/verbFacet.js\":\"759f6b4b6943be4a\",\"/knowledge-medium/src/hooks/block.js\":\"590555a812e3d228\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"2d6b4a100018c9a8\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f8d049e958626107\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a1cad69da90e0241\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"de855762e71d6eed\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"1e30a6e3680ff2f9\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"e78d1f4f8e71a168\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"8fd9178b7989562f\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"4c067450a03ab511\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"004529daebafc736\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"ffd788e6a46d5395\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b58a233b0a2f5be2\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"89352515f14e9e99\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"2984a540d469d9c1\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"abb2c28642bb4f83\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"359b570ca1ca1291\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"97d039a77990712d\",\"/knowledge-medium/src/lib/utils.js\":\"87b1838af77a85b6\",\"/knowledge-medium/src/main.js\":\"8aab6ea74ec07170\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"d11257ab20e27250\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"8fc96c96313cd3b9\",\"/knowledge-medium/src/markdown/context.js\":\"ce612a47049b073e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"6b642b852d6f640e\",\"/knowledge-medium/src/markdown/extensions.js\":\"579855fa27d1063e\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"752768158ab3e96f\",\"/knowledge-medium/src/minimal-editor.js\":\"02e15f099add7309\",\"/knowledge-medium/src/paste/armedCut.js\":\"f2709febe9758af0\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"951c75823002f212\",\"/knowledge-medium/src/paste/clipboard.js\":\"e17ae3a9337d6062\",\"/knowledge-medium/src/paste/decision.js\":\"e8098799ae86931e\",\"/knowledge-medium/src/paste/operations.js\":\"3b1f5777cb5af06c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"babe899b54bc9a24\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"3119689723766899\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"49ed16c8de8bca40\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"82ced25f214d2090\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"243fd6e81fc4befd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"eda7d1ead2db0a22\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"a6739d7fa37c4e63\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"414658ba143b23b2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"06c0151908fa5cc1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"18a4787c36479d66\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"3711cbcf0baf97a4\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"272c8bc29291e4b9\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ca9a4050e3f679ab\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"4b502c4eb1bafc0b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c80ea9c217e43c50\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"752174207ae013a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"76676019fce2cb62\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1bce6d0b679cc5d8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"748477a2ba9ef551\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"5ddb5f3b78b45094\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"571f29622af34464\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"2ba32518e95fb981\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7ed41b6710b1b723\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"dc98090fa44a6ed8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"9a2b8896ae9a5789\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"bdc599f9b112851c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d6f8cc0b150e047a\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e35b9c808275fd6a\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"3b8eb9cf88b97718\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"29fbcadb29f29a6b\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e4df92c0b0b26fe7\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"af151e92a8b33fe1\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"e50096f422a17a13\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"92e5db39cf987753\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a36067140bc96c4a\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"f67ed99f704158b4\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"fce6879b65254003\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"dcbe76dbb1e78279\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b998aa82ca07f4ea\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ab69d6d64099de8a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"67fe1b873e111ce8\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"3538cb4d7eeee1d4\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"b4f931fe5a4f5a93\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"10c62100f49eecc4\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"6969623a770d9b69\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fb1bee93669d606b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b8cc23a60086c7db\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"32e2722025a3b37a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"04b8abef6afce160\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"dd23bb910492c2b1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"8f3a1b097a5dd62c\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"0a3313a641afa4ca\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"04f425843a5ce6d6\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c83a2bf40061575b\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"72799b1bd4a74ef4\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d9577cc75e53b41d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"571c30707f3e2d68\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"b6a8d38dca876be4\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"4df676ee2c354a25\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"402f1f696d60f177\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"ace2582e5d6ad213\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"37cd7952dfcea650\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"bca28a2c984ade76\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"5030176edfe31a6d\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"1443086fe8a5ecf1\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5eab33e2cf337e3e\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"f402db631df51ba4\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"40104c652c25f2f5\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"1b7dc141f28774ce\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"09104c5815eec070\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"41272aaa709b9cf9\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"534e9c78393d3555\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"781ffcf56e61676e\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"bad91fa2c1476c12\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"26b95a899bed152d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"539497fb673c17e6\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"05650569f8b0bd0c\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"b11eb06d2708a366\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"b7bf7013818ad9c1\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"bf16175d94133acd\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"0831aa7e195ad943\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"2ae3ac689587973e\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"0c0e04434f78bad5\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"a0ef2bc162d55e66\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"4a13b1c907f6bfec\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0e0a8ccb1327c955\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"9e2bc3bbaefcba94\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"32b34997275095d2\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"d88d9ac2f583de36\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"08ddc3e43be3d449\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"5c7af5f32bd494b9\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"924bf2c7877fe25b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"e63f1295384a7140\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c1f9cfd98aa624c7\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"4a30a79d0ecbfcdd\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"04cf4578094eaaf3\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"fa21d20902a33d63\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"a4c62eb3ded29003\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"999aaa8619b581e4\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"19230ec3827236d6\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"1b1e91ba3362623e\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"63deb2798cde7401\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"35c3c74201b16be2\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"bc1d18da50799cec\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5d4720d96611a73e\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"7f091903a041a1ee\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1c3d8ccd417fc88c\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0ffc082637859227\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"4f28a59b1bac42e3\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"3ce2d19c2de2f17c\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"faeb1568ee722363\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"7a4ffbc944b829f0\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"651c3e04e61ed65f\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"e8fcdbf5f89b2925\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"9978269cfc44400b\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"5f290b39d9e036d3\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"662466c99687f902\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"af0c4dce00eb74db\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"0187bede7f5295cf\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"1a6bb18e5ae46a6a\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"0bbef555dd3ec361\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"bdbc8f2f80a3fe62\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4bed44ab72aaaa05\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"94fa94c700f43000\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"19538f82743ddf2d\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"fa591604a2bef5de\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"12db93934586f8c6\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"176f0d9bb8c426b6\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"60e95f42a9085ceb\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b9021ad91dfcc9c0\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"661accc4348aa5d8\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"89853104d4bfb85a\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"af1dba1611ae3148\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"9191b4b39f8d06fd\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"d9aaf6b169848aa1\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"2955807d6e48a085\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"e675082908071947\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"617bdb56e9809382\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"05e32ecaa4c3c828\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a6b33373e6d958ed\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a57c0127550dd7df\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"d53bfc7b21bc5788\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"1ef583031c0d82db\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"69ca1ea63e6e2e83\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"956c5dc00a833ece\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"d1388145dddf5dfe\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"df16e8439b68c638\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"49cd593cf5ddc19d\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"ec8abc42adfbea15\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a790abe06884e81f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"0ac80abb506d53c8\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"8c622f1a1f7c14e6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6c43ffe5c4435999\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"43fe16b230acc761\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"d8a2add08fa11bee\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d29101c539098122\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"6b950d002ea9cc0f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"347e09ebcc9a7480\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"c87ec6b5a91236da\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"d70361e768d725f7\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"fd181f62a1e513b0\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"bd89c7eebcc1579a\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"e4375dfc1349314e\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"2d69e79009c5d863\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"85b989f5e0aa6b39\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"6eb1f5ecc669af16\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7d885646e3e5b0e1\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"3dc1205cd192017f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"9ac52db2e4c0a0a0\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"2c3feaf39c1e6a64\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"45cd5b13b9ac5106\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"59a13ccbddf14704\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"bab7b86368d79cf0\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e473e622e6598017\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"09be007696df487b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"d15f7c693955a186\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"85a753538b9bdbd6\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"e81cd6603a873d02\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"8f3de25cc1a2c399\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"d0cf04cdbb11df30\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b820d42390d32705\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a623b2c9c5c26178\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"c65ce3555854ed00\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"425638211a69322b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"622af361b14edb33\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"862291d85d18bc55\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"c3c5aa1fb55c851e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"2e463733eb25ade5\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"14890e18858f7cd8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"53c9f8fa1ceaa2ff\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d87387c35e5defad\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"437a7a0f40e8d70f\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"93b79f6c99ce2d36\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"30302b355ed57607\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"11638c2cc3789249\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"95e134ec44739a78\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9d6b729c278d6208\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"a70528a42469edcf\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"2d11960f9395cc68\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"f59076a19b6d603b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"81c41f79c52958af\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"5256a5e7be2cfd63\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"10b5d087140e8ff3\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"c2361aad4e600f69\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"eecdd3f38dc40a27\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"8aaa496fdc1309be\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"e540bf4d44542a5f\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"8a67335a5c01f509\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"d6ef9662b5f7e29d\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ace4b172c817ad89\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"4a68bc6e93ccabb8\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"5510743a24162453\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"9853ccec192ba6a3\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"7cc2cb24d7a7046b\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"95d0a4e2e137ce09\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4b7a6b7df1c62028\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"77321d91ca8555bf\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0815399bd9990cbc\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"acf97904d9c8699a\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"7d92985a59dd27e3\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7023546caad8331d\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"5423de9d53d3b148\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"fdca6562bd05e5be\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b630ee198f78eb91\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1f0a4007ab9c240a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"5359b4e275a0cfc9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"79caa98edb240fc7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"3786441c6077a607\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"2a3d7d940ff1dfb7\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"0e6db8fd8ba2c626\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"09e722ffc83c3de4\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"1a4fff4bfc9364ec\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"6517efdae3da1aac\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"fee166f5fc20783a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"b5ac4fc1f75c1be8\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d458236dd4369da9\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"5300c168d23002bc\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"024db3ae49475981\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"af9b1e34708811fb\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"e1e2c13cf2eb6abf\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"34012c701f1575e1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5e3a08f32af92273\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"2492376df093aa16\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"39b628e030192acf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e834c887c84578a0\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"4c44c69330f85fb8\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"a33130c1d81f8103\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"49430841ed3dfe57\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"af6ea39ff4134a09\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"d68f66ad57259ebd\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"aeecbc743aeb7ad1\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"eb4c6d18b71eccf2\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"5a466576fe64bf33\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"a10acd237c0e0510\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"14347bb649ee293f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"43083306ddd0e1ab\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b8a79333437f3675\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"741ce81c36e12427\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e19efb6e79c8a49c\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"72a86cc12597679e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"c0788ecd0594fe4f\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"9b3bb352d28e6da2\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2981c036bad9a877\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"7154940352098507\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"79c3a5cc65cea4ce\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f9cb0b790133e4b3\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"3b7866c9668d6499\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"7c5a54d50d707c32\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"c6e74e2ec96eacbf\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"c7b2f31f4c1bec48\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"73ef1450ae18131e\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"20e6d482a0baf730\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b0541b33b56a0519\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"3d5d78c1fe389191\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c9389aa56766ee7d\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"b94378e61ec4bf95\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"1e4e7f7e908b87ad\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"661a96e354846203\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"552f6d7d32c3b4fd\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"4d9fda5696d9985e\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"5f14ae35896eedcd\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"7b3d58a83cf51a59\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"d3b915f25d2070c9\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"65eca8064f416bab\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"32ea72489601f854\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c422275ff3ae6084\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5d2e4791c81013fc\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"322e4815238d77e9\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"d16e11b0e70a3273\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"4070e4ee237465f2\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"6b1a3e8064a6c8ba\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e05ffab46c1824d8\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a472e4de5e60fefa\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5012983bddb51ae1\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"80d2212517eb2fd5\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"8e90afaf5e55240e\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"d5d30d7fc70c4d30\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"4b7dc6dcc1e70e04\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"40a3374f0e593e7f\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1cbd09398c11bc80\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"cd9272385e183e02\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"55b9e435bfc0179b\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7eab9d9c04ee6f31\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"98caa8b6d238f2f4\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"6ef31c31f2a0d84e\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"4dd31887815ffeda\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"029d744b8dcd9e40\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"f0e80220fb77566e\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"1f20b08179d9a679\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"aafff67bc84d4413\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"ca15c5787ae2720f\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4db51c0196a10277\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"7795a7e80f8462b1\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"96d66776f6fc9861\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"65e6f8b427b407d5\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"3e84c062bb501322\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"b8a1626329de825d\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"67d13382bb40a33c\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"d49ffb4e0c11d341\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"d44165e8f1f1ab63\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"106fa92b77eeb3bf\",\"/knowledge-medium/src/plugins/geo/index.js\":\"eba11d45bc1989ce\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"4d99df92abef41a6\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"feb5e8cf0d706883\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"fa3706d87f888a46\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"a1ff7ceff9acc6bb\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"f470251a33526d39\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"34be7e3c14179929\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"55da5789bed46a7d\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b70efd4dd2a5cc93\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"e0c3f7bf5619182a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"61940213cb4d0016\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1dd3e5554fe40f3c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"445088d51f9b7186\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"8ad049ebd8f2fede\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"0d6ed4b943818bcb\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"db506566128564ca\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"83354bb423b4393d\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"d95f4699745dde2e\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"124ba4c960ca4390\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"06d1fe598f7ac228\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"7afbd936e1b82aea\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"80b23dcdef842b79\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"df0af5b344d01d43\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"ec2e46116e0ea3ca\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"eb882ecdc82be9ac\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"488940aa25d5e136\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"f279b79732c8bd79\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a0b62a6b7b6e023a\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"502387c49d94ae00\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"64264b6095c5a480\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"36c48b4cd8fab724\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"120f96e1d0573bc0\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"a7fceb26e8a150bf\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a4fc55ccbf892f51\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"972370b931100cd2\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"648bf5faaf363d51\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"6968e0866f7f4028\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"adada0724a43ab3e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"11564418c22d52f6\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"6bc03e32afd6d9ab\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bef97dc5bd91a46f\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"ba70f07cf24080a4\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b4e66a81f189087e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f9afc4bac01ba8fc\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"a3877d5494886590\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"bb840d1c0f13adb5\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"5c64b3f41006afd6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"4b11481d82bbd167\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"243d129854447feb\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"3d2754d100056b5c\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"dcbdc4f13432b718\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"269b0009532ace24\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d014eed9ee852f8e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"46bcedb0a333b4cd\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"42c7fb151ee394bb\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"ce85924c3676753f\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"f42aeabaca132b7d\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"16797ea8f4c3c37c\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"19766383099ea92c\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"374e041b3a1842ad\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3345a149419f7164\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"30d6c3cc63fa4989\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"8813bfdff9eae89d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"97cde84bc5ca551f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b38e86b8f3c1189f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b28a4e3b3e80c9c2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"eef65f79a38eb12a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"25067492903746c0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1c958f5ad9de5a0c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c64589fe740dd3c2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8f8f0599f7c5824f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"351e673981befc1e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"9cb3d54cf741d082\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bce85aa5c0128a97\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2ea521c0c7624c15\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e79be8923c435f58\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"cd6d44c31bfc6635\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"2da2e2bea23f3883\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"e92bda57f9b83527\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"e21d947cfaea7312\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"688585ea4df2327a\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"80ee7f30df663b8f\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"4ec6f8f197bacdc0\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"cd9fcd95878b503b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"86283893801ff364\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"75a85ce94f8f41f1\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"35ee437ee2ad729c\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"971ea366ff11b038\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9c91e0d55171a93b\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fb89778ea9c25e9a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"ca59b3cb5b8e6a03\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0d343082aa206307\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"1efa6f91ef9ca94d\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"02b1881c09670b5c\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"8f4812ac0dfc5dfd\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1fd8efb6a956cdcb\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"02b8a9a32eeffeec\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"5e79bbc844b87854\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"6e319d632c0dd674\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"7d845a9e5791ed7f\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"b3ead6934a46a175\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f3966c7e1bd8e1fa\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"e9379deecf1c6fe0\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7578100df5c92ee1\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"ab8250a3a468ad88\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"a318534f56089b17\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"a6182e6bf2d4bc0d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"4e18f1e5f20571cb\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"8acea6b360a19dd0\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"4b031ca2090a047c\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"a955524f9c4e7fda\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"d667f5d87d36eca3\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"6d10988c5a094a4b\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"41fb17dc054a289d\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"c52d2dfd13ac9664\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"a0f62155282207aa\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"7cd2c5ef521f61b3\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"3118c0729897e60f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"a4a0546437487b35\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"95322a07194147b7\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"74d3ed924dc4a774\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"f0012ccca8043590\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"105ceb1ac2069993\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"daeb2d379e5f7fc3\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"0dbbc99328d45bca\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"2b5785159ee096d3\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"ccc22a1d31474f03\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"3c2561f8a5d8745d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"995bb274089965ba\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4141098c20835168\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"9cd4c67eb9024540\",\"/knowledge-medium/src/plugins/recents/index.js\":\"176c90b56e8c9a1a\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7f5e5a019b1a2d93\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3e3f11b695a76f79\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"6042196b76411eb1\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"840b62ee8956b8df\",\"/knowledge-medium/src/plugins/references/index.js\":\"bb6820b09619b8b6\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"302a636f3084f930\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"de56bb9af74976ce\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"8518da50f94efa9d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"bd1745b53f4890f4\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"17454803be894593\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"9ad55dbeee79f1e5\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"1ae3f0029cf31a73\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a92418830d8f4b6d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d0fedef219b665c7\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"2593a020504f23f1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2cd7aafe03723469\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7a4b11a21e8ed605\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"dbb8db6085ce2aed\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"23eb73b8184d0c61\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"0fb35e297db91f01\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f76133940b9a146d\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"d31a2b737401530d\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"2e31e39e6c2ace28\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"d26d5e149499e0fc\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a70df83745f1904e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8688f8962e56daf0\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5dfb266684bed283\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"76b1151f1ff69589\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"bd0b620ca5a3d558\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"90af419d435bdeb4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"6cefc3fb9ea496a4\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"b827c970a1c5c0c8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"8f9b8d71f994a99d\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"4368c5dc43fca573\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"8dfab152cf433878\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"59085ef20988e946\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4588542f20722686\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"e56f75617bfc6a7a\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"1ba8e3251f6c80ba\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"d2d14d8ff107d285\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"28913f024eefbbce\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b509c98727cfd8c8\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"2df55f1a7f1bc638\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"5a5879388fc049eb\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"92e754c339bec637\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"e6750a1758a460d7\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"2466961428842b61\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"05ba8e61ce91737f\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"9b46b543a51dc544\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"300f3eb9f6d538c2\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"37eb425064103c58\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"20366f8a86340ce9\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"e452f71676ea7a74\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8d6d7d29c7591637\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"69edb025829721db\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"e47b18382a4b5487\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"16d3369cda6ef264\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"8d5dac6dec93c9eb\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c3538af4480a0074\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a2fc1000252b7e67\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"c8492034ead66c72\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"c8a2117f230d5ef1\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"dbbb69e5a4c3d955\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"9b34ed2efa9e8c18\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"147b2f604d178746\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"e7826727c4b527d4\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e7f907cec0c16ea7\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"cee25cf19127b9d0\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"00c91ce3be997ed4\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"22fabd9ce1ad5d50\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"cd9be9c0664683a0\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"ceb89fcdb0cc2ba8\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b3588668b07af4d8\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"e6483059945c0746\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bfefc7ffc0a7631a\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4b6bddf7a1c329ff\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"371483574e5869f7\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"ce51f777280a38be\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"112811fb60cdb720\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"efec52cecf2c5265\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"aad9752b238aab02\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"c37ce25ecc32066a\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"c857412a5c4320e0\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2cc3366add59f4c2\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"e3103b335fd5ec31\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"432c399942433a57\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"03bd56171e31ef3e\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"453d68a782a748e1\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"d7b54468400a4322\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"584ff7e168b8f66d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"60183c6f391f4a82\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"5c271ac9213ee2ed\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"b33eb9402d046b5e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"bc847161d66a0e22\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"66fe496a4a00834d\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"26ae8a409321b815\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"da0d76a84b1bd695\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"a9a0374c19e7e78f\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"d5dab514b27b33ca\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"bccfb87f40176c78\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"f18da3193ed29d04\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"addf22588e7cd297\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"7f58a78ce799a5f2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"456f53cb8fcd2c55\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1bdbf26d5705f62d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"531a1bcb2fac89de\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"9648ea7f3522aa0b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"60e48f0cb675a75e\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"1980b359ef95cdb9\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"fa812c689665c932\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"d05724d299a17911\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"2a736d457b15d0d1\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"80c565ba6fcb18b7\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d5b85a7abf4d0adf\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"75e1840ada249198\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"363a8fa667027581\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"d997bbc145e9ecf5\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"38d14b18fe6b2b49\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"eda11c452d0eefa2\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"12ab5b20b0c10d2b\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"6a385166b9c1e15d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"230c9a04ee4d7dd0\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"b7b18a16ac64dd3e\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"9b00986821d3bd5e\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"0d8b5f1e7b695afe\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"fc13adf8568aece0\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"d3411906efc19234\",\"/knowledge-medium/src/plugins/tables/index.js\":\"bd716670b39338bb\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"274f70d199bf7fa1\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b47c24c5bd003288\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"c55fbb5ab19733f2\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"c6c5fc38ef62b38a\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"96e3adbfcae0bd67\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"7264bd9ba34be03a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"6a9116bb2a76a029\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"72e52e22e561e156\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"df22e566ca132682\",\"/knowledge-medium/src/plugins/todo/index.js\":\"fe65a6d9fb71b124\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"956a597da75198a7\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fd9252d8b59113ac\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"9bc54a3a46eec6d6\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"234b30687743b42d\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"97ccb322b9c268c8\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"c429aaf5dd89a928\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"a1b646710014c96d\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"22944f66b20ffdd6\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"f3b5dcb2179f50f1\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"628abdb5c74249c9\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"8b9580b507e79a38\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"fbce165b7df20583\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"16729b1390754abd\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"69b977279d06753b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"146ba41670e5c493\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"23efcc15ea64fe50\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"56e9503ab46efdca\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"7b1007850085b789\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"28cf6fb82ca53648\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"11d131704f5a692b\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"38fecdb3bb5e3320\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"7e06e7e00c7d511a\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"6112f083b091a801\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"11775f2a08c929d5\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"79b70991fde91256\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"cd8e5aed1aecdb94\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"5b1132ab8a8edc0b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f40533dad0f00507\",\"/knowledge-medium/src/registerServiceWorker.js\":\"645f07d37f9cac6b\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"4f1b35fb76f0245c\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"9db3deb185b7d935\",\"/knowledge-medium/src/services/authStorage.js\":\"fc285db74ff3112c\",\"/knowledge-medium/src/services/powersync.js\":\"4074eee875a9f55a\",\"/knowledge-medium/src/services/supabase.js\":\"1203f9318761f21d\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"ac49d1722a789e9c\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"97fe90345e16e1af\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e2a562c06ced3d81\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"196ca85d4e466725\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"e290067e4d31f592\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"f4a9dc29ecfcc0fe\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a7583f3d75e102e5\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d9962d71b240b392\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"6a9fa92c15d7e709\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"7f2d39f9df9d0b05\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"64e9d3e28e94c7ca\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"a9c2fd8271ece179\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e23a06274028588a\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"6609cd34fb515e02\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"42a09aceeabd2c61\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9e2912a2d01e7109\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"0476d38bc819f52d\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"526c96635f2b56d9\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"48c906c162135fea\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"88f1e6d53f0cf5c6\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"c1cf015ca32cfa29\",\"/knowledge-medium/src/shortcuts/types.js\":\"9fc270a9de475a57\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"8d52c973b203a703\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"132674d9cdd34959\",\"/knowledge-medium/src/shortcuts/utils.js\":\"934da949f0fbcc74\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"f26c20ae3e872932\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"0be325529fc00cdc\",\"/knowledge-medium/src/sync/byteTransform.js\":\"93769be7fa0bd6a5\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"b7326d58d32c5c51\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d6be4940797cf98c\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c3257782a1eb1551\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"83708b5ab7cc30eb\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"5bf54cda44b2ec82\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"1eaa93df35958030\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a714209bcc83051d\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"698e5ae36d1aff20\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"bd0ee2bbe07a0ceb\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"9ea4e2f30b17cc05\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"e15fb7c8e13abc5d\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"13f6fe810f9355ec\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"541270ef0e58bc8f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b28650c18595435d\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"df1c6fd026de8351\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"3b3eb74f9cbd25c2\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"92b540c7741cb5a6\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"6a23bf4512de4374\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"707fea3b5f08d10e\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5bcf73ae91acdcf0\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"c670ee4281a4f430\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"6cbdd0c901c53285\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"41fd20547e6fcd46\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"c450f512b9b3cb96\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"26fbbfd4d403fc24\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"3646b0f78bee6747\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"3dbef556b8323aab\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"26a19a1b132606c1\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"c03a7bdca6d5b26a\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"67306bc80aeb1593\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"a6a7a77fdac31e53\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"99ae14c3ec503516\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e97fb2f9958677df\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"528817c8b3fc7b29\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"85fa45b63889f71b\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"d7aa4c16beaa93ab\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a638763d9da296fc\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d1b3a0f6709e50ef\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a9b91b1263f49568\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"de691f9c39af5c09\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"6579471fbadf98db\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"c1b8609edf5256a8\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"df1e8db2f212dec7\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"6725b5463261c5c2\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"aab86b844474a45a\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"48a1bbcf87834811\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"7b0b089eff3c03eb\",\"/knowledge-medium/src/sync/transform.js\":\"d6346ccbbf226f89\",\"/knowledge-medium/src/themeBootDefaults.js\":\"f48b3b660933dcdf\",\"/knowledge-medium/src/types.js\":\"360ef2b324a51b28\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"226665a4db41803b\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"571105c98ee328c0\",\"/knowledge-medium/src/utils/array.js\":\"407ac8aa99ce12b4\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"eef34fef4e920ef3\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a5d03396e8efad49\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"bd6a817c180a006a\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"716e3bc6273dd5f7\",\"/knowledge-medium/src/utils/callbackSet.js\":\"615a653301fb52ce\",\"/knowledge-medium/src/utils/clientId.js\":\"5b3356a5150db4b8\",\"/knowledge-medium/src/utils/codemirror.js\":\"ebe603a096826cdc\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"e3d63b17475e3330\",\"/knowledge-medium/src/utils/copy.js\":\"42d38202979a6445\",\"/knowledge-medium/src/utils/dailyPage.js\":\"8fe33ef5ea9f61d4\",\"/knowledge-medium/src/utils/dbForensics.js\":\"21e380f0b556e730\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"54a84b072a051633\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8e9165c01a67a2f8\",\"/knowledge-medium/src/utils/dialogs.js\":\"41aa52bf24729ef8\",\"/knowledge-medium/src/utils/dom.js\":\"11f3a98fcac09b44\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"cfa90730aa9fb3b1\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"e4b5d29d97fb4b7f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"d481ebd9f11bd403\",\"/knowledge-medium/src/utils/flipSlide.js\":\"ee6b716f1b68e9d4\",\"/knowledge-medium/src/utils/fnv1a.js\":\"4e185d744570a183\",\"/knowledge-medium/src/utils/formatBytes.js\":\"50b1ba7f8898ad91\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"501ea2c75718abbe\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"dbd6de88110f519e\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"27741f6cebefcf0e\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f8e3015ea4c6bb5b\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"e61e254d426e4511\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"aa382b5175e17081\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c706b662b60456e9\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7780ae50ec9163fd\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"55f92b9cd95f67ef\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"fc4c581335b463f9\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"46054c4022276bf2\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"36d5091f7db28a8d\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"a4ade55025426e78\",\"/knowledge-medium/src/utils/markdownParser.js\":\"0735054c483fd036\",\"/knowledge-medium/src/utils/memoize.js\":\"4f85f3dc61b12e8e\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"bcc12aaf5a6a130a\",\"/knowledge-medium/src/utils/nameList.js\":\"d59a891d8d6615e0\",\"/knowledge-medium/src/utils/navigation.js\":\"26576c89d8462ea9\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"3a01af95a928d510\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"23f1604e3dc0743f\",\"/knowledge-medium/src/utils/panelClearance.js\":\"6a363ada11b597e2\",\"/knowledge-medium/src/utils/panelHistory.js\":\"f17e633e5848e8c3\",\"/knowledge-medium/src/utils/panelLanes.js\":\"8f4eb506b46ba6af\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"e51a46551d61406c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"fd1f5ef9544a3c1d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"f2f5bd19423131ea\",\"/knowledge-medium/src/utils/platform.js\":\"e22ba75b457d4fb5\",\"/knowledge-medium/src/utils/pluralize.js\":\"df7eae41f5ec8d37\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"b80b169c03d9b1c7\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"2a4fd909057a4a33\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"5e8178d858b7f4d3\",\"/knowledge-medium/src/utils/react.js\":\"eccb120f41c1d614\",\"/knowledge-medium/src/utils/relativeDate.js\":\"bd1b143f767bc96a\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d0beb4a74921aa4f\",\"/knowledge-medium/src/utils/renderScope.js\":\"b2732d5508b3fe91\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e6996209f669d59c\",\"/knowledge-medium/src/utils/routing.js\":\"777ecc0a042481fb\",\"/knowledge-medium/src/utils/safeMode.js\":\"6d886cd52a158d3b\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"211865939cff2138\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"8ee28a10582d7d32\",\"/knowledge-medium/src/utils/selection.js\":\"ee80bb2ec8c7eb50\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"0d46e3c292051bae\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"db2deab750adbb89\",\"/knowledge-medium/src/utils/state.js\":\"07bf8722fa5f07aa\",\"/knowledge-medium/src/utils/string.js\":\"284a6f8d74c056b6\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"fd65e822d9af21dd\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"56b80d6323eaa788\",\"/knowledge-medium/src/utils/toast.js\":\"8f6cb27772140079\",\"/knowledge-medium/src/utils/toggleStore.js\":\"adf0678a5facc11e\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"45a27d63b2330028\",\"/knowledge-medium/src/utils/userActivity.js\":\"0dd74c462eed2fb2\",\"/knowledge-medium/src/utils/viewTransition.js\":\"ff97f47cd507fe65\",\"/knowledge-medium/src/utils/viewport.js\":\"4afedf39e518d06a\",\"/knowledge-medium/src/utils/webLock.js\":\"e2a80fdca0eb8735\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"b4b992a34d486c5d\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"8fd3b11b50ba3056\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"692492a0b949e52c\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"4aa637bec08a712a\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e156f72b373d7d7f\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9f1e3130daef5cd2\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"b1de9b1ecf8d6085\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"c1dcdbb90f5081ed\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"24effa1f928642c3\",\"/knowledge-medium/src/vendor/react-dom.js\":\"346c8906860fa478\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"1ce079552c340e1f\",\"/knowledge-medium/src/vendor/react.js\":\"9687deae42d04ff7\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
