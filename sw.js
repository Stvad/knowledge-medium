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
		buildId: "221ceeddaabd-28b420cc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"e455657cc768cdee\",\"/knowledge-medium/index.html\":\"e455657cc768cdee\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-qFT5fKEQ.js\":\"24f35655048a4b50\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"8501e548d66c3551\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-C418MVBw.js\":\"8520e05a39800c19\",\"/knowledge-medium/chunks/FacadeVFS-lqMS0xEu.js\":\"89759c47f9faedf5\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-VbCE6090.js\":\"643e1be4dcf7c83f\",\"/knowledge-medium/chunks/MemoryVFS-Bh0Jd9b8.js\":\"d441cb0e673cc960\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Cc4GIhmR.js\":\"314f779a475d47c0\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Ug0zf_nE.js\":\"2e1547f7e79d4b1e\",\"/knowledge-medium/chunks/Preview-oKo3zK-F.js\":\"e073f5364bb70037\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BxfDeETE.js\":\"040286073690faf0\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-ngSBuU_Z.js\":\"34be643fb60a31ad\",\"/knowledge-medium/chunks/freezeExtensionImports-Dz88x1Bu.js\":\"9a6b242f2ebcd0d2\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-64u6dPZO.js\":\"16fafb6b04a943ed\",\"/knowledge-medium/chunks/react-BgN3JVdh.js\":\"f368f4656e867663\",\"/knowledge-medium/chunks/react-CA8Gc6gD.js\":\"11f9c27118534cb3\",\"/knowledge-medium/chunks/react-CLFcVTDo.js\":\"7ff12cf9044325fd\",\"/knowledge-medium/chunks/react-Ch7kvxd0.js\":\"a94dc48a6d464db7\",\"/knowledge-medium/chunks/react-ClBASFpO.js\":\"08df9e5fdb23a06a\",\"/knowledge-medium/chunks/react-DaGPc1cD.js\":\"ebe916cebe41f342\",\"/knowledge-medium/chunks/react-RGuZDtFz.js\":\"e48c7b0c875bbe4d\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BsqLJQJC.js\":\"8f05e24039e35f42\",\"/knowledge-medium/chunks/react-dom-server.browser.production-Bv2ZF9OV.js\":\"a23e72e119aaa645\",\"/knowledge-medium/chunks/react-dom-server.edge.production-B9N9iuJq.js\":\"2b4608a6f830429a\",\"/knowledge-medium/chunks/server.browser-C48DVFdK.js\":\"4991f2c3e1fa5a6b\",\"/knowledge-medium/chunks/textarea-BDG36yfN.js\":\"f59c5fc1030ecdac\",\"/knowledge-medium/chunks/ui-Fnw0JaYg.js\":\"08bdbb17ddbf47ec\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"eaeade897ae39534\",\"/knowledge-medium/src/appUpdate.js\":\"1626b399e1d27741\",\"/knowledge-medium/src/appVersion.js\":\"267da5ee3df50dca\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"33f98bad8e0a3064\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"84c59a722445102f\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"4e84909e16d4c897\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"799ba1686ca10d77\",\"/knowledge-medium/src/components/BlockComponent.js\":\"4380cb299213f4ed\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"14a32bf296c66416\",\"/knowledge-medium/src/components/BlockEditor.js\":\"3824e205619e04b9\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"01381ab6ee0149b6\",\"/knowledge-medium/src/components/BlockProperties.js\":\"eb1ff47fa6ff8adf\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"ec5f0af0acaa00c4\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"9458770052d03b5f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"a9b3f74430b6f8a0\",\"/knowledge-medium/src/components/DraftEditor.js\":\"9f03f0b9a541ff56\",\"/knowledge-medium/src/components/GutterPill.js\":\"4dd131b141bf124c\",\"/knowledge-medium/src/components/Header.js\":\"5905a8d02ed3c7cc\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"06afc305c6c0b38e\",\"/knowledge-medium/src/components/Login.js\":\"e0b999ad8a2f7bea\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"89df953ca0e8935b\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"f8b15bcf65712a4f\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f84edffaa500dd97\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c94e44ecfef2b43f\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"88e3ac93506c39bf\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4e33dc4bac5a5f88\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"47549a7bba8b65d9\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e3fdda054d64f774\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"6602979b9b6c2a1f\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"618336deac17a204\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"e84b48fd6334957f\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"31cb848d4782af9f\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"368e0a6fe325fe47\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"c5fc828039c5d236\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"f0bbfbf6fd91c18c\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"6370af20b0afc128\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"96f880773cd378ec\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"ca6fc97f5c07f8b5\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"185d8918102f2aba\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"71018eb65e3541c7\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"44baaeb3201a5992\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"aece186db6224bdd\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d5ed18a111d3cf63\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"60f1f4d4243a71c7\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"0124c559a502affa\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"53ff4d467d65eccf\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"bc300209cb327b22\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6284e66dee6daabd\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"6aca2074bf29a3c6\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"e48f0dd16edf412b\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"19ac9aa864780fa6\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"c521c10e431d2125\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"8c728a47963c0ea1\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"fa56a263c8781cd3\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"97eb52ad6072b82f\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1114cd8b405fb52a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"1bb004023dec05fc\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"52e2c650c021025f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"9421800d08fcabcd\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"5efdc79266e9f3ca\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"f22a662d04752f91\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5f526984c41f0a1d\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"4058c5bb464d5555\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b88d564aa9d12554\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"1c8771f0c8092fe3\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"37b053ac2ec7a46a\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"972024c674e1d877\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0c85e4fe13838aa4\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"5cb148f7eac02ebd\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1092060965d3790e\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"2c8edeccc72f77e4\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"3f7d442b3955d4e8\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"dc888450669be394\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"ea41e6c808c6ca5c\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"b634bc285c4c1019\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"7521899e4a34cf7e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"65896c47efc19b2d\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"de7e467bbd2fa95e\",\"/knowledge-medium/src/components/ui/button.js\":\"79d4c4dc1ba72eff\",\"/knowledge-medium/src/components/ui/card.js\":\"9779c0c19f59dddc\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"7ac0a21718d3230b\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"0f7139c29729e480\",\"/knowledge-medium/src/components/ui/command.js\":\"c53eda8745947a6d\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"85f582f15d9bb3b3\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0cd509d313c2ce04\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c7a017d3a372da55\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"55dae7798f0f7cc7\",\"/knowledge-medium/src/components/ui/index.js\":\"4497a986f863a724\",\"/knowledge-medium/src/components/ui/input.js\":\"c78be0cd77cf5516\",\"/knowledge-medium/src/components/ui/kbd.js\":\"859f56bfd85bbe54\",\"/knowledge-medium/src/components/ui/label.js\":\"f995672f900c26ea\",\"/knowledge-medium/src/components/ui/textarea.js\":\"3dd6a453b054e8c8\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"59d51436c6a26189\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"6b8d02a6dd645c17\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"3ebc1df0b633e7c5\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b06b2fe590b82bb7\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"4705e2fad3bfc8ce\",\"/knowledge-medium/src/components/util/error.js\":\"d59136ae8370828d\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"f280b92e2bf7396f\",\"/knowledge-medium/src/components/util/suspense.js\":\"c035db635d44a6a4\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"2f850118ed764869\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"2898892da64324c8\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"1f3eff611441eafe\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"7911c242dc5cee69\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a50bf4d14b6bf2e1\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"027c4e34d068d32b\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"6d6b26fb69f95786\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"8325c6294d62934c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"0aacd0a2d2ee7bfd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"64f8ebdcace048d2\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"134557ead0a0a926\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"0af788f462fb8f24\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"712cd9425a7046a8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3821e93046abd450\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"9a7752e0d83fe9f8\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"d0ec6285addea9c1\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"1de787a698e47457\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"108c4f20553d78fb\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"394a46f328812143\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"361dcf4ab52ce0b2\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"31829931f9e0d8cc\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"b2d1c58c9172c121\",\"/knowledge-medium/src/context/block.js\":\"346e8724c4c1f743\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"6f9940ceea1f49d2\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"979997ba7d745bc7\",\"/knowledge-medium/src/context/repo.js\":\"e7df5c8ed96c1183\",\"/knowledge-medium/src/data/aliasClaim.js\":\"fa737f5dc44ed506\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"225bf3c9898dfffa\",\"/knowledge-medium/src/data/api/blockData.js\":\"095100b7d491061a\",\"/knowledge-medium/src/data/api/blockType.js\":\"a258f1ecc0613039\",\"/knowledge-medium/src/data/api/changeScope.js\":\"9937d97439c11a6b\",\"/knowledge-medium/src/data/api/codecs.js\":\"92b4636d4bc26fcc\",\"/knowledge-medium/src/data/api/derivedData.js\":\"1a9238f073762d29\",\"/knowledge-medium/src/data/api/errors.js\":\"8ca11a9d0bacbd2b\",\"/knowledge-medium/src/data/api/events.js\":\"1980738d9ff2a756\",\"/knowledge-medium/src/data/api/handle.js\":\"3537703f70fc2b97\",\"/knowledge-medium/src/data/api/index.js\":\"794de96410df06f8\",\"/knowledge-medium/src/data/api/mutator.js\":\"8bffa96872a1779b\",\"/knowledge-medium/src/data/api/processor.js\":\"5a9c85e14b287a58\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"67b5429f071e1a41\",\"/knowledge-medium/src/data/api/query.js\":\"f2d1cef8a21161f1\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1bf6168a5ee9f0d3\",\"/knowledge-medium/src/data/api/schema.js\":\"3537703f70fc2b97\",\"/knowledge-medium/src/data/api/tx.js\":\"3537703f70fc2b97\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"e2f6e3323f645305\",\"/knowledge-medium/src/data/api/user.js\":\"9188b099942d927e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"6637c037866df2e4\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"6fc4fbc5bab0f1e3\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"8f6c2e61d7cd4fb5\",\"/knowledge-medium/src/data/block.js\":\"ad1f91f988d5fb6b\",\"/knowledge-medium/src/data/blockCache.js\":\"5f02b2697a9a21fe\",\"/knowledge-medium/src/data/blockId.js\":\"6a3b84fc07461ea6\",\"/knowledge-medium/src/data/blockLiveness.js\":\"4a6de076b809995f\",\"/knowledge-medium/src/data/blockMerge.js\":\"51b6484318855e4d\",\"/knowledge-medium/src/data/blockSchema.js\":\"d7ec2f5ad7a219b9\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"a735b174f68eac3c\",\"/knowledge-medium/src/data/blockTypes.js\":\"3c92455d837dd0cf\",\"/knowledge-medium/src/data/childrenView.js\":\"4f2f54baae371b19\",\"/knowledge-medium/src/data/clientContext.js\":\"1cd5e4196f320499\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e6df2e545351fd0b\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"0ed25d3120d576b5\",\"/knowledge-medium/src/data/derivedIds.js\":\"5c66c236b877c36d\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"cc4893e1d18df504\",\"/knowledge-medium/src/data/facetBridge.js\":\"973ff7d1f24fe48b\",\"/knowledge-medium/src/data/facets.js\":\"fb872a7cc5ec85a2\",\"/knowledge-medium/src/data/globalState.js\":\"6f5187f6e070dbdb\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"1a0250e7929d06b1\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"7034342b28910cc9\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"fe32f859c6509a0a\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"6ac35f65c453af7b\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"cd9e0f417dfa5279\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"203ab65b5828074e\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"21c1c6ae9b3e662b\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"7a5698d39d158d47\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"ab48e5fe85248619\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"644c6bf00e88558a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"0886f86223587e23\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"abb6c848720408b3\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"9509283d0dbcbb94\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"e74de44c8f145b71\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"65bad3cf6ea70d30\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"76e0df0bb75a4c05\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"13ddd1a56df3e264\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e9026bf5c4fbc497\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"aa20ed0b727deecc\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"b920f2321a904e8b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"99ce415d7d901779\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"24c907322e41e4a7\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"3ff53b2702ae1a36\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"cfd6bfb7058cdb64\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f0cdec6918aa66d3\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"4050052cd37b32c9\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"4fbaddbc1947cddb\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"c0ef399da809306a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"720ac964681e4f43\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"353a6910e9752654\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"4980f4d4089056b7\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"65f16b8c6e5d26c3\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"db267d9eaba0d754\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"878da1854dc26b45\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"19e417251c4e1ffe\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"e91bfbf579b02b88\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c600f0b37c8fdf18\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"3af8e7c62965b0b7\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"8d8dec77ab9017c5\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"ff0df4e0e2b145cd\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"54626486beeaaf1c\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"606ca02646d05cd1\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d09db5d3e9b55b7a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"9cf692a12eb6bde6\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"6846b89c95a3055d\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"e2ac7dd0d59e752b\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a72c15eade2aeeca\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"07d9ff298524b312\",\"/knowledge-medium/src/data/invalidation.js\":\"3158ec74af83e905\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"727143afb65707f6\",\"/knowledge-medium/src/data/kernelPage.js\":\"2622cf729bae79ed\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"3f4cb286319ea74a\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"81fbf9d35deb11f2\",\"/knowledge-medium/src/data/localDbStorage.js\":\"bf130024a5c15aba\",\"/knowledge-medium/src/data/localDbVfs.js\":\"73993ee12a6a2d15\",\"/knowledge-medium/src/data/localSchema.js\":\"fa13676fed3187c2\",\"/knowledge-medium/src/data/maintenance.js\":\"3dff7b261f457d27\",\"/knowledge-medium/src/data/mergeProperties.js\":\"f41369ecf600ae2b\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"b9817fdc264a1a3a\",\"/knowledge-medium/src/data/migrationsPage.js\":\"133e4ea8136d66ae\",\"/knowledge-medium/src/data/mutators.js\":\"c1118aab899d963a\",\"/knowledge-medium/src/data/orderKey.js\":\"04ac8b395a03025d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"925efcf9c5acb6d6\",\"/knowledge-medium/src/data/outlineSurface.js\":\"840e370b79906159\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"827ce71ab6280468\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"db313759d163a16c\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"2625f9e20b319ed4\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0758f2670767b3ab\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"37b0280286a543f1\",\"/knowledge-medium/src/data/properties.js\":\"9ce8adf9ca7e0582\",\"/knowledge-medium/src/data/propertiesPage.js\":\"a6df8781fbd2bb0d\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c4c258473ff8d880\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"b391f4484900b9ea\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"91f7fae5444c0677\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"cdc7e6a0dc4b5a13\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"e49896698c87be8d\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"c5d5967cc2799e5e\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"3829176edafd64e4\",\"/knowledge-medium/src/data/propertySeeds.js\":\"a36c1d9acb7a787a\",\"/knowledge-medium/src/data/recentsPage.js\":\"3f9dbbec496d9ec3\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"3d6c60fd1e23dac2\",\"/knowledge-medium/src/data/referenceBlock.js\":\"0c8e6ed55715d204\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"e09f7f14bed9b539\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"276e8cbdeb500f98\",\"/knowledge-medium/src/data/repo.js\":\"742bfdc544a77845\",\"/knowledge-medium/src/data/repoProvider.js\":\"8ce1860d6f237daa\",\"/knowledge-medium/src/data/rowProperty.js\":\"0a19c8c27a9d776c\",\"/knowledge-medium/src/data/searchFilter.js\":\"9ae22e7c46fe74cd\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"628e97beee86bc6b\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ad968aadb0dd9c4b\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"afdf5860c7d6eafc\",\"/knowledge-medium/src/data/structuralInsert.js\":\"f1b4578aaf0d3949\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ece7220a4d403505\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"b1846b7f65596d9e\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"f2cbf5c80fa2a24b\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"81db0a6206f02c8a\",\"/knowledge-medium/src/data/targets.js\":\"cdec5d7715b73fa9\",\"/knowledge-medium/src/data/typeColors.js\":\"e0570d841589c324\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"bc0728efb5e33163\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"8c8bdedacf0538f2\",\"/knowledge-medium/src/data/typeExtraction.js\":\"2570a13047fb08a9\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"83fb5a6eb3864988\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"9248fbe09aac7eb9\",\"/knowledge-medium/src/data/typeSeeds.js\":\"10164cbe94ed84b7\",\"/knowledge-medium/src/data/typeTagger.js\":\"ae93125d5fc18f65\",\"/knowledge-medium/src/data/typedRecords.js\":\"71868b72b0d35f81\",\"/knowledge-medium/src/data/typesPage.js\":\"dab7007fc2cdca9a\",\"/knowledge-medium/src/data/userPrefs.js\":\"d4c109aa71da7636\",\"/knowledge-medium/src/data/userSchemasService.js\":\"c4ef56c042ec60e2\",\"/knowledge-medium/src/data/userTypesService.js\":\"985409ff447459b8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"0ba5968f1c530036\",\"/knowledge-medium/src/data/visibleChildren.js\":\"44e7c89214a60cab\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4de8b484db8f3a81\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"6a5aec94d3994f6c\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b5e6148e3bdb3c67\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b727efba3bd3c814\",\"/knowledge-medium/src/data/workspaces.js\":\"cc73b8697a626d8f\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"b77cce4c558c2731\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"ca3fc622b15af715\",\"/knowledge-medium/src/editor/atTrigger.js\":\"f6a5899ccd0dd76e\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ebe77e713aa7ecb6\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"f64b22389ab97df1\",\"/knowledge-medium/src/editor/contentFlush.js\":\"9b872deef1c109d6\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"46d35833690e67a9\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"5402ad520b9856f3\",\"/knowledge-medium/src/editor/insertImage.js\":\"46e2accf5dfc48bd\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"5ba5baf004f56e37\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"1207f961ccd98e02\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"0721fcc02eadfb33\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"9743bd7740477479\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"0b5045d63936a1e9\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"2395fcb18dd2e694\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"9e007d657e18f061\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"5af83a245448e74c\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"2623c070f846aa67\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"3ae3b70a2681f9b8\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"5bf4adeb081f343a\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"4b88303429060463\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"7cd7b3864cab9466\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"377fb3b170f105a1\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"513590413fc212f0\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"bf2b221edbdfbb73\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"f2db5c3c9a2a0383\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"8f19ce9cceb08a48\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"12ff633cb389385a\",\"/knowledge-medium/src/extensions/core.js\":\"8345dbd071dd37ef\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"afe92ffdebdc3d75\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"95b54c6e2bfb79f5\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"c03511bd2b0d5c73\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"9f3b69abce988068\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"73aa59ff30b71b02\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"42688d905ecb3f80\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"6558121de84efcfb\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"447ce7bbb77ffb4f\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"f6933d4434497359\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"c63eabc4d376379f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"9a46bedeab21e759\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"9e5e21b563be2cff\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"784c2b37150d8fca\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"b365d06d74284a81\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"8f6ae467db368650\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"98ba64880c3251ac\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"dfc5059d358aadd4\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"dba2a778ce5b8f3b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"e144efb0de32acd2\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"7cc83950570a3b15\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"d4202d11680f632e\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"9f13cdec7cd26ccd\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"9d1b34098741252d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"da998083d8761999\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"809d5131da108ba6\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"ec68b8eeddd1830c\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"95e5c7a4adaab8a6\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"087a719c57e8dc5c\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"6ac282e68f592232\",\"/knowledge-medium/src/facets/facet.js\":\"6c784f5ebff1ed6b\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"024ef09c46931c24\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"62b78d90a76649b7\",\"/knowledge-medium/src/facets/togglable.js\":\"ace8db32f14cfa9d\",\"/knowledge-medium/src/facets/variantFacet.js\":\"afac5ea1205643a8\",\"/knowledge-medium/src/facets/verbFacet.js\":\"fb45e972a637d1bd\",\"/knowledge-medium/src/hooks/block.js\":\"01a4ac2bc6550c5a\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"2b7f164a7b264fc7\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"8b1d6a847f476225\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"78bb560c7b6b6191\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"efba5b016d9c0e3a\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"edb97843a68c21be\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"bea7f98b90d66439\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"5711e63ff190de1a\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"b7fc0101f39118da\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"db2e797b43b3a3f1\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"b6f1115fa0cfc7bf\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"98c21615edc6c8ca\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b458b59177ac8e68\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"7917e3425d62ca8a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"429842596b7ef5c9\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"7ce5f7318c0a292e\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"78bbfc19fe0d27a0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"8f72d5c27e764a36\",\"/knowledge-medium/src/lib/utils.js\":\"9ebbb76c99d56bbd\",\"/knowledge-medium/src/main.js\":\"428b8b01cb7b93b9\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"78f537a12466e01d\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"a0cedb3c4e5f34db\",\"/knowledge-medium/src/markdown/context.js\":\"902bfc08aaed3aac\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"57ff629ab451fd1a\",\"/knowledge-medium/src/markdown/extensions.js\":\"61c1c1fc8d09577b\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"4a8539d42231a060\",\"/knowledge-medium/src/minimal-editor.js\":\"bbaffe5582fad02a\",\"/knowledge-medium/src/paste/armedCut.js\":\"530d10e95e53b2cc\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"417fdc4e675e344e\",\"/knowledge-medium/src/paste/clipboard.js\":\"e57881cdbd53835b\",\"/knowledge-medium/src/paste/decision.js\":\"92a80fb2f9153f14\",\"/knowledge-medium/src/paste/operations.js\":\"106e8893790b58e3\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"6d36fd106ccd7f5a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"4fd69b2804eec9d2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c2c834d91dfd46ae\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"6dafb506fa3cdba4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"bb5ca3d285c91785\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"00a892bbca439126\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"c12204e5cc258861\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"154b46f3dd1183e9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"308e731680e444f9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"83967e5e982d85df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"438d9d80a4846376\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e243766295a03e94\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8b4361ae75fc7b30\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b94b3f177600f23f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c43721a570360532\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"41171d3737d50e8e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"a240dbdf56b16dd4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2e1ccb0f73eef28b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"3b6f642b88f44f9f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"89869f8c3c70b926\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"79012c5155e3d02b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"32c7c46ae908cfc6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"79cce7ef38995ddc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"2620f0c01024ef20\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"9179bc827dc7ae94\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cfd51b86d789c46a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"7a3fdd897b814759\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"0472bd45ccb1d693\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2a6e494527184f78\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"12d4fb236be8676e\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"3a108daab740119d\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d1a1eeb8810456dd\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"dcef80fdaaaec35a\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"4beecc26ec9f4487\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"5c7fce62b74dc971\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"1070d4e94438e2d5\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"b18588c46dd7ff1d\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"0a87ce5ab2842205\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"feffa131ead085e9\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b8553167edd553cb\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"58b8da2a33c6165f\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"c89a44347199ae40\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"9a241aa66f11f727\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"775c4dd2af5cc697\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a73bb6e6895f542d\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"8efdd21079c959f4\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"339fdec53dcbcaf2\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"d4093003a4ff848c\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"eff4363c3f983f3d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"854236b30589f729\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"fefe61c676e9360f\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"f130d45086cd8d0c\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"053ef7806a57275a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"783c61a1cfe1a0a0\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"6a9dc561ce6ef58a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"1f28d3f64ba499ef\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"083bc4462c2628a5\",\"/knowledge-medium/src/plugins/alias/index.js\":\"5ebdee1a226b63c6\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"f4e0a9a9a8fa95cb\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"37655d206627c13c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"2c34da4a8ba5c23b\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d2bd105607d5dfea\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"67490fd2262b57cf\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"5f87bf68a2be27f8\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7342e79b58a24032\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"434cdd49df55ddb3\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"d6fcb666a147a7c0\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"f88f856f1e6c21c6\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"7a2a8522941a901a\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"b6ce12ae11cfc65f\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"05ee4a0e3ffa5d87\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"3ed8551508e20512\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"251a14e429e9e2e4\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"b5ea3b57ad37f280\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"0e232870a12d05a1\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"c572418218c43fa2\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"beafbe9c2018720d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"537eed05a08d0b0a\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"b8c28496857c4a2d\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"85fef52eac894562\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"9ec466e8b2ac1954\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"e1c2fc158acb9658\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"56b5d3d9bc9474eb\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"4eedcf15937caa8b\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b30d19ceee9ce1cc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"e0e36857fb5efaf5\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"f7facebb4843d36e\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"bfa804d67118c260\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"74fe14d28a4e3be5\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"1342431b99f6f3d6\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"d8d1ebe8cf317fa0\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"1bea4de5f112ddba\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"4db80c2e2bc551c3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"39354e641baadc3e\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f236ca69029b631c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"299ac86c5c0a6850\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"acdbdce4b2669f2b\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"884d5013ef34223e\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"9308df4fec2f39e5\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"1b2569fe5cd1e2f5\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"ce0c49466867e953\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"095b78ea4742b47e\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"eaf319ae74efe323\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"9c7f003e8148675e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"1eeb45f8829608e9\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"be72a0f730201f1c\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ee74b5eba31aa091\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"eb39bfda028b1fb6\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d4a3d0d36eba8dd2\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"c075313439348496\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"e0d3fa1befcfd29e\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"7e8defaf4531d78e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"4d7ea74b9c48da61\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"55c872d5282f6b75\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2ef706d822e82736\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"b231d8126de56568\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"00bdd04884d423c1\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"ee5ff40083c7408c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"831a1db42cbdb993\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"a0353fe6b61165be\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"da6c8caec15dc74d\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ef12c0799add8360\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c530364f81db8866\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"c0868914306ae133\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"359a573e7afc6a12\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"b35cd34baedd67c1\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"604b6aa366b6328a\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"b15ec27097945bab\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"36db60fb3f284dd8\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"f1097c31f47db3f4\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b52ebd55ce2e06f0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d1319e6ff2f0ddb0\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"58b17cb1c644c8e0\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"70ffc4f173d0a964\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"bbc4d9a740edac72\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"2f62f79116c843db\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"189bffdede69ddfe\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7f3dc55848bb4d5f\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"912238c8bcec1ac0\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"6305099fb8900929\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"197b39eb73010411\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b1254450f593a762\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0785c19caf36bc56\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8ee2b7cb322d406a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"646e6237943d424d\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"2147d1f20b1e9242\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"49a2528d71d742af\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d393ba1596e8d5c0\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"5c4761770e36e860\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"cd0cba9e57af2b26\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4deeb8577e232fae\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"569482317e95a510\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"5ee6b299cac2958b\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"ba2786066cb511dd\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"ec5a491655419ad4\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"963aff7970554db2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1c9ce539a8ae82b1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"0dc731cd66c92554\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"80fb1b6f3dbb00e9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"87170f0daf40636e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"210b7331f3c1261c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3a029c4e5e0306bf\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"cfb0474cddb1b369\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3627a21f636c975a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"04733e697a292492\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"ea5f7855d192d440\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2312a45078189df1\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"de6eee5887198549\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"795ae2cd36467ae2\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"c454fb42e66e46a3\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2822bc65eef5c331\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"17f3fb9a8285d5d0\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"e107ed43bcf56448\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"b6e224c4cd4f3e29\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"98360fbfd71e39bc\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"e9a43ea8599246aa\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"e14f3b7836591217\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"2c875ec7af62b8df\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"167f6d246053b39a\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e8e094c5ace7b764\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c6249e81890ebbf2\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"9328e3965a4deb81\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"17531922acda73b2\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f4b4475531e7aa0c\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d0165048a837b01e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"272cfde546389879\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"94c584323f276a46\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"3ed205a63fa05170\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"aeeda19ead061075\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b03ec34bbe45495d\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"b45221480c89af99\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"958744d667b85b12\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"efd21e6fd64934f4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"41995ccf03f41e52\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5cbf3cb51477e2eb\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f831d6e37bd35099\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d435653640d3da0d\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"c16b730ccd7cf6e8\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b8978e8a790a6669\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"67c788145e10c874\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"15de749f8f55af36\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c858ef358c711170\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"69061f3b12dc60bc\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"ef7b5b46b22caa7d\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"289828c978706c91\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"6e2598344bc11fc2\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"a9bb0d238d248c5d\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"112d622dfbe7a797\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"d616ac28849ccbb1\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"364925125635824e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"08a671fbb91f47de\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"beb85f63650e68cc\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"57647aa107ea8ac5\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"5927705ef82da5a9\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"c763961b515e1b18\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"f0a878dec793d50e\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"cf4abfd5d4380888\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"8dd3491c5ecbbd59\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"b743b4cdbae5da4b\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"1775f8aac4327d70\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"a32e4ae2afe8d2d6\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"5f383deeb1c1f72a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"0da60553c301c75a\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"66f2d3e8c2b54b4e\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"47a5fce7e66d447c\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"b4eda67686751dc8\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"4e370d82039f5b50\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"d57eb4f89dc01188\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"6449cd911505863c\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"595950f21a9bc2b5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ff9d604177565791\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"bcaf8a4443dd7b9a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"f8c816dfe45ed37f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"71d397d49b2dbc99\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"643c9e7b469736b8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"fc691f0c91ae48af\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"5f8a20100b0cee13\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ec46434f6e11014c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"011759816df81c3a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"6c229e7a604f0ec0\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"05b76b3192d78b73\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"58c902e12ee972ad\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"43a2d255083b09a5\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"80c585ada9052005\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6464ab74cdd4e833\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"1e05cddfad3503af\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a7f259a65486fb9a\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"b292bc7ec170fd34\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"69f0c92dd6c430e2\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"545c0d919cd8c706\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"884a8ac52f7839ad\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"f85c9cc49500bc21\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1728ea82e5e0364e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8fc7c06342518929\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"82c9c530569768c1\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"31bf0f15f95d20b3\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"514a1c34620e3fe3\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"130e24a65d1cd45d\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"85f117b121872720\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"a92a074b37455226\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"5df9ce17a09d5b64\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"d4b0f320a7368cd3\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"4cb3d2173658c56a\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"85152d6b023ab8b8\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"eb223c3609a0d3b0\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"01411d809feaa292\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"cf9ae51525ff2d1b\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"03b7c9f8b257d3ba\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a1513deb98b04bf4\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c55d95d860e70e3b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"26a85ef44d019097\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"8857f3fcf235ee69\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"c6b98c04a3c0cc29\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"dc93a63cdefb8a18\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"b575fffede8122dc\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4a438c48b3cb07ac\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"794a7ed66ebfd8d8\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"83fd640526a6a63e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"962a50a27bec4e10\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"d29c1017fee7e4ed\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"57a4f256d00a9537\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"6fca6c96f9048989\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"e72e1da470e78e04\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"369681e551dd6e68\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"5ce69f1ab8c20af0\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"d419cc67d158de3c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"89f68c483086eaf0\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"3b4fa95fbd173a96\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"3092acb7af002920\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"edf8b602f725e34b\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"8c4bee124936510a\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"0363f8e04aed140b\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"de705e4e0fdc6ffa\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"7ae62c4c45742359\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"d2554a9c6da16bd6\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"d1c2551b42042291\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"5dfc8ffd59835547\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5c1639882f344cf4\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"1a18e6dfb955c125\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e0ce92cc7675c28e\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"ba0a1f817f42a4f2\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"2c15be8f3852c1e9\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e0a8fe646862f504\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bef7484ea3ea9ebd\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"43e4a5995ad5efcc\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"556f846e35b6c317\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"854f9e054c55c485\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"52ce36ab7e833c82\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e11e16a7145e3706\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"4db073cc21dcb089\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"cf6c295f28a8063e\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"7c2f7d472ca24aa9\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a03fdc163d0581ee\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9c1c65a1e00ba610\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"986c1faa93aa5a10\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"cf47d3cf92ae47b4\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"a2ea80cd2b73f87a\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"ee1e70c663ad3026\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"12a6cc009ed48710\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"057f9904c8398165\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"8702032982f66dc9\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"45a37d1b91ed897a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b88151b084df31f9\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"e9178532d1d6c8b7\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"0824a416f0856599\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"390e70856c758361\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4d20eeadd8fb9a6c\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"b0b02f31f49bd243\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"b95258301fbb9cd6\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"b8264e411bded493\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"88225967ccaa99dc\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"d358eccb277f1ad0\",\"/knowledge-medium/src/plugins/geo/index.js\":\"6319aca58eb7e7a0\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"160e09579f636e27\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"44b2ce7250670a81\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"17135f2ceef2e3ac\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"e615f2762f5fafe5\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"1b7c603cb1ff9568\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"f8257e1982685f69\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"f0bcd8ab4441c61f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"c5b78d70ed686648\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"855846d0d63e76f4\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"18de643e0dd19b50\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"29ab75cbbb15237f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"896e774bba06ad4a\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"363f3f928f8d974e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"73ef595f1469687c\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"9dde87d9eb79b51a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"16b711a324042200\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"e9efdd2cbdaff187\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"885a8e1c55967bcf\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"d75d5cfd08c42c6c\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"a1f2c134892557f5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"00125e7f4003b0f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4a0c7794e8c26f60\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"d8433f6a3b53e508\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"07d8cefc57d2790d\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"8231ad2dadb6d46b\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"c30864bbeb902149\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"e1c2744a346e4552\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"fd88adf8c20bb0c6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"0122a946d33e29c0\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"2c45a8680ba533ef\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"6a1fa1c266aea096\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"4d48b6aeb72078fe\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"e188fc47ce66c394\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"a8f02b63159f0dca\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"9223e0433bd54f28\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"8e8082482d3642c3\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"c19df514a6557bed\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"274956ac16b26f05\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"cb03d544ce5d06c9\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"ef4d07b53cd9a7fc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6d944190499f59d3\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"acc317bd531a74f0\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6b5ed4e91961c596\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"f77f8de8aa0b5e11\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"b8d1203a22bb8104\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"614ef38488c4b437\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"236df5a6baa19eee\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"819e8be9f518cb18\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"f19efbf4c20f789c\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"ca76175a00f81c81\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b6104359c1f05577\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"5ce1e789bb76f749\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"1c92299467140787\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"441038323f3d4440\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"4f7dcba2f7ffd195\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"96ad4530ede343ba\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"25bc3cf4fcfb6bd1\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"6c41ea5afb48d44c\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"0bcc3b4e809e9359\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"9c83bd05268e144c\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"3dbdf76130399b9f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"99bb462caf8d089d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"0cee9ab160cd450f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a1de043e4292bade\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"749d7f1097bf01cc\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"47686847fa326fad\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"743e9d874c1298fe\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fda5b77fa3d156ba\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"11703de2a8c12865\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"377344cfb3c27dc8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1c3556f29f1e826f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"6cdb3cb557598da0\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"cd8816d32efb6a28\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c2a5656d536c0f0d\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"d80a7fa00dd9a31e\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"0e3599f1e99cfa5e\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"bcdd455992577296\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"7159a47cccfad190\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"421ad65b45faadde\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"720525811c89b4a2\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"bc5bfc2b18682e60\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"f2066b663b7e11ec\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"1b77b18136abc997\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"60bca9770755d4f9\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"a9e0ca9351091305\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"63b8d312d46deba2\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"6a7dafc3776c5395\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"89b4676af302d1c2\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"932745db5bcf7744\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"61d68de1cb4a9c17\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"d962f81f29647c2a\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"cb10747030e42eb3\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7a8e0dd54341d969\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f11cac832021c72f\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"300b529991482518\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"5b4bc9df4f9624d2\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b8a445a7440eb459\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"89bc660b3fab7831\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"5c7cca87bf2e9204\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"011ad45de2dc8154\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"b70857d065b4e8e7\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"65c892aabe509b83\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"706c791d351b9fd5\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"dd198ab288161f25\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"5e7a4c660f7d3f22\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"60d7543d352cdc1c\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"6b51664d4794d406\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"f23e163a84157d9a\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"cd0de669c7c3c327\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"1128a714681155d4\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"5893039277a742c7\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9dbb5df3a1271ce8\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"e0f3dce1e9235b5c\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"b5a882fcdd30c9f6\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"83ec188af779bf8c\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"dd3747e1e43b93d3\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"32b05875368aa997\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"1618a4b0a0195f65\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"22a6e81a09af55c1\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"a418f3abbf26d571\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"8b6b83d2d4ed121c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"57dcf6007de2baa9\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"14c7f35b44f7fb91\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"0f0464b3f7a4d51c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"4e2936d0aa06abf1\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"1f8c45ed3264754c\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"9715e61c3a103da8\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"ed834c6ee0d9c54a\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a73271f5b229d716\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"d0555ee6a3977c82\",\"/knowledge-medium/src/plugins/recents/index.js\":\"2207c080ce43604a\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c151af134106841f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"727607bf55227b39\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"e68a7baff74dfb2d\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"f7e25d36e02b51d8\",\"/knowledge-medium/src/plugins/references/index.js\":\"8a45295053e52a35\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"eb72330a53287603\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"879906c717c91c10\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ed1c0441b44980a7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"8c1eadd829674849\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"62b5fc373d12867a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"6189df34fefac0a1\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"c8e1314207ea9407\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"07a455ecec9f4f9d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"caaf929a5a562c2e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f7f2b1e0812773d1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3f5712a177ee8027\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1e3a2e2209c84d5b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"4fba2992dc8b773e\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"eda2be0e6590c65c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"0ff7904bdcf0b6ff\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"86762a0308e61474\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"43853c609fc756b8\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a04f5b35012a6c9d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"0865c5f026bdab4f\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"4b2f25d9f92378fd\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8ea9a8b9d465297c\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c1175fb84c8c6c1c\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"e0dd87e46a830a10\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"ebdf3e9fa89c7f7c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"61d9cec320b76831\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"83867158cf061630\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"1674a025c3d669f1\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"c5d849cd43436539\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"0c728641c0e24831\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"d83c22585be47dbe\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"a04a205aafc57fb0\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"91131dd49aa5c9d3\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d77f24c5511663e4\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"438dd9f4f5e7f3d6\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"9da6484ce6bb2ab5\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"bb2c5167540bd589\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"9315f0e55b086eed\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"90b7798ed2d8a976\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"f54f0cf20f3ba96a\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"42625b4dc7e452ca\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7fe17153549a402d\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"e6d4ae9bc8e9caaa\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"c533c46c5316b738\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"e290c848528dec37\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"3e8bd3a4151fd931\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"9b7612ca7b83d83b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6d6b3ae0b9eeb15f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"bc5528b9456328f5\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"99134bb8ce567021\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"2c925bd6ffcb1a74\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"9505b71bb63b2e95\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9bf45d45aed1ba33\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"eb2d0cb88ede9ed4\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"d13d787fdf3bd5d3\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a266420bbe1c63d1\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"69ebde4fd1a3c68d\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"667370b4e662e7fc\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"efc1e6ba8d34382a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6449c88dee6c0617\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"318c16b009944caa\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"dcc602ca00adedd1\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"4d3a5d852461e269\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"204820a98bc72cf2\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"5e6ba65e20307160\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d8e833cabcac4c21\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"36ce72a2e9868afa\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"ea385e469c3743fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"30aed89eb0891cff\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"932bf37acbcf2710\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7b34bcce564eaf5d\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"913a97d23bbab6bb\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"180ab25a2a0d41ad\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"c3e4355c2b15bc3c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6b2ade6879d42ff2\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"5c2f9fa696ae52ff\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"406f2744e3bec1d7\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"634952eb6193bb2d\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"cb442776ec26873c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"7e546715ed4bfc06\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"dd15807b4fe241d6\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"739145c6661c189a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"345e73da59761402\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"4ec8541b11de05fd\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"c9c4d3d15d6151a1\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"bcaf9115f09c0bc4\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"b6c25ed257d5a567\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7a61ae4d921a4f4f\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"0cdfeb065e90a3bf\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"816fd2f326117764\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"35de2c3afcfec3ec\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"800d20cfd8e37cb4\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0ae3475eadcb9ce6\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"7810195e4439849d\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"ff75e01a8390ccbe\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"6d166d215f86f8b5\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"935a0a52550c510f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"01c9876c05c80016\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"7d8f596df69441bc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"1e55f1d71dd300be\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2091bd940cc3f3f3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e7b6b272c15cebe7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b674971c5dc892f4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4b07d459388fff52\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"9577337c19a2468d\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"8f7a2d7fa7d2095a\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"79befb0702d97723\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"0d9a9f93238eb13a\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"32fe882dee8ab63c\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"442bd17f79cdd0f4\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"685c9c93e5b48f3d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"0006804be33f4b8f\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"71a032fb1ed0e41a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"b5b126858ee639dc\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"2dd097f3f9d698de\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"fcfd6543ea15bc8b\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"92953f35a354de42\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"5d76ef2296f3b9bf\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"9b0ee43c0eee2823\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"abf0f1400e14c43d\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"1ec5040967bfc9c1\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"49e6474b12e0a620\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"1ddad0afc92b49d5\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"c9a5a52761296be7\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"3fd09566874f1e7f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"8b912a1f372f18ae\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"2aaf0cdbe8d3c8d7\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b9f3f367cf9521d1\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"52ac22499fa746f4\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"c05014632a472e39\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"a0540546badeadd5\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"96408fbfe3d67502\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1ff52cdb7af70a0a\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"e2d8e7656ac6e8cd\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"4691bc6d397dba1d\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"66ad10cb7a4c1cab\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5a0a0179bb147a2b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"47039c5caf62dc6a\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"f53d72c0abcf0c30\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"ce6aae52dc9fe073\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"d9776842f687f106\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"706126347b2d28cd\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"5a2999cf21324c09\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"190768da6c2150f8\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8fadaee4dba38e75\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"ea08fd6e3c2523d6\",\"/knowledge-medium/src/plugins/todo/index.js\":\"445b3a0dd0841e0d\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"498cffaa9c080591\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"945bdb545a6459c0\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"b175a65347e9a29a\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"92c2a5078a791e6f\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"7e5a473925ebc3e5\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"21c656d92c323c0a\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"b761f89d2e03d549\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"2106beca4f4e1827\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"03f323f61a435bdd\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"9e806fc482f3fed1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"bce252e381f80612\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a7a60128feb1703e\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"d65fa618ae58c548\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"f5c16e4d33ae9b6c\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"766425eb89decbd5\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"5297e97740186c1b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"b45278f8369a25b2\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"739618572d96e7a9\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"90443086d4e545dd\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"b1abded80819ecaf\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e9514b963e3de822\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"a8b8b3ebc9b0aede\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"d27890b039dc8a92\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"5063c3d92d2b014d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"7808645dc0688178\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"9992f2420b33e6e8\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"9bfa2a608124c4ca\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"c05c729da5e39bc2\",\"/knowledge-medium/src/registerServiceWorker.js\":\"96550d0ad7c04a11\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9fdd49aa9ccabee6\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"0856b0fd8dae8408\",\"/knowledge-medium/src/services/authStorage.js\":\"2ed6a2e7fd737d31\",\"/knowledge-medium/src/services/powersync.js\":\"64d517ba5ab2d719\",\"/knowledge-medium/src/services/supabase.js\":\"183427cfca7d1aa3\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"79d478fb4ab4735e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"eb87b7dc80966195\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a0ca4c01c7594099\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"b1dd348d1738a1f6\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"c87a5471eb6be256\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"e866adc5b19830ee\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"2d521bbae1e1432a\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"7c4ac006698f11fc\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"19e12fa60fa867cd\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"053d9894d799b7eb\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"17ef869347869f8f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"40b899ce446f5d57\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"4f1b33aefc549111\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"5533128114a2da39\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"a73f63b6f7a0b53f\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"bf8cd912ffc2642c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9f8c5248894d4486\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"baec189ba268c499\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"1ab6472ae1d286db\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"c7aa17c2263d5227\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"ccf283c93beec95b\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"3729cf942068019a\",\"/knowledge-medium/src/shortcuts/types.js\":\"7f5e46dd43ef4b19\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"9632cea29235ca9d\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"b2be2e1919fbbd17\",\"/knowledge-medium/src/shortcuts/utils.js\":\"6ed0543ccc0d1dac\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"023ec3978b8e7954\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"3412629ebe5719cf\",\"/knowledge-medium/src/sync/byteTransform.js\":\"7b091a432162bc6e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"99eb4a2ebd22b8e7\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"42d32a09d33a9597\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"f7efee39025bcbd0\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"96bd6d09000a25f3\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"cc514ba60a96a668\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"9a526e879d07cc78\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"87821a2a2c4ebaf6\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"f753e5bf54c2decf\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"2fb84aefd6f616be\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"779066526862e561\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"f9e6a26f5123adb3\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d819ab5d0466e847\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"a6418317510f95bd\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b265b3afdcd368e2\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"c4c3ecb7b9d15b98\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"b5b6cccc5a8755dc\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"79f0d32e20b8d541\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"b889fc4bc625a511\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"8764e982710da0fd\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"055b38162f753b9e\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"9feba6949690a814\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"08499de9289c992b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e91827ef5f21151d\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ccd8e05dbc109569\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"732eb6ab6ec048ea\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6f08463887adf24b\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"662e6aeea531e703\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"be157e52534cbaa2\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"d5c2797aa232cbfa\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"3eaf88f98806e926\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d116369d104ba91f\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"913bdd9eaa3e3b8f\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"3e560f7d950faf65\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"46c5d3a065825e0a\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ac9c3c37f34d9deb\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"c7f44ad2ee806253\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4d05891e368cad6c\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"100573c9c5ce001c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ad1b7019946e879e\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"72ee318fe2cd25b6\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"294854d6b28c79da\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"07d1c6e7fec542e3\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"b578200784d1e719\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"b57df89b00e3048b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"256c8355b163de3c\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"bc7e094032a3465f\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"d9a17e9ac379291b\",\"/knowledge-medium/src/sync/transform.js\":\"bc0354e04b693909\",\"/knowledge-medium/src/themeBootDefaults.js\":\"0344046351bb466d\",\"/knowledge-medium/src/types.js\":\"33df88c33a729a37\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"8ded7761bff928e9\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"23652c926d48102b\",\"/knowledge-medium/src/utils/array.js\":\"0f9c8c25f994de87\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"46275890821cddcc\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2a9ddea9e12303fe\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"f32917b615e1ae1b\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"087d1caaf7474110\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b0d6aad8a7005958\",\"/knowledge-medium/src/utils/clientId.js\":\"a20f760e0deff142\",\"/knowledge-medium/src/utils/codemirror.js\":\"8bb80ca142947ec0\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"37e56ca9e1dc12ec\",\"/knowledge-medium/src/utils/copy.js\":\"152420d231e0b225\",\"/knowledge-medium/src/utils/dailyPage.js\":\"7fc7d4720d51bafe\",\"/knowledge-medium/src/utils/dbForensics.js\":\"12b03b004c8f6de6\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"5eb3476be37c0940\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"a26bc9522d816de9\",\"/knowledge-medium/src/utils/dialogs.js\":\"9b5693d590a70c7b\",\"/knowledge-medium/src/utils/dom.js\":\"7ab10a84a1978c46\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e5b8f89a1f61b9cb\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"c99ab6b893ed8b63\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"2632e6e90c94c742\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"8216dc10ca34fb89\",\"/knowledge-medium/src/utils/flipSlide.js\":\"f59a7581eb42a4db\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2cee84f712863486\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c901effcfe7ee7c4\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"deff498961c85554\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"83493ac74c5de338\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"3abc32d03849dcb9\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"6546b16db2d39e01\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"482e1fd52b72a529\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"f7e951165c4363b9\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"202d3d3d08f47ed8\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"eee97ccbda7915a8\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"44145c3076e2173d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"fa6e5bad41997f46\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"f388707f4193e69e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"8329140c623fe853\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"90e4fff8dad9856d\",\"/knowledge-medium/src/utils/markdownParser.js\":\"083558b480e83809\",\"/knowledge-medium/src/utils/memoize.js\":\"71df6b7e95e0445e\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"b83e72e806e21fb1\",\"/knowledge-medium/src/utils/nameList.js\":\"f88eef71ba5d22c5\",\"/knowledge-medium/src/utils/navigation.js\":\"cd11b5b3f5a63cfc\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"3f1f0cf1bc7c252a\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"95c2440ea0886e9a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"24e98736edd9f73c\",\"/knowledge-medium/src/utils/panelHistory.js\":\"7ab1e4c4af424936\",\"/knowledge-medium/src/utils/panelLanes.js\":\"1acae28f32af0ddf\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"9e64161d7c1bcf1d\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"95084f5c77bb4d1d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"757dea28aad3b90d\",\"/knowledge-medium/src/utils/platform.js\":\"316d9c4c7a9a7b9f\",\"/knowledge-medium/src/utils/pluralize.js\":\"c9b19d279ab97da0\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"daf5b4988ab64344\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"8bc6c5c3d93c143b\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"9b3ad26ef1110c15\",\"/knowledge-medium/src/utils/react.js\":\"c4d1c55d00944a66\",\"/knowledge-medium/src/utils/relativeDate.js\":\"16c4d256ad70a794\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9be1f87c7516928e\",\"/knowledge-medium/src/utils/renderScope.js\":\"aa88cd32cebc3e57\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"dd2561f24da2b8c4\",\"/knowledge-medium/src/utils/routing.js\":\"762d1e800bab8421\",\"/knowledge-medium/src/utils/safeMode.js\":\"50ab77f4326085d9\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"cc043c917f7a5c6e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"92331348cf877e30\",\"/knowledge-medium/src/utils/selection.js\":\"b5f33acf4cb4e088\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b42970b3290a4602\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"b9f5afe3fb86926f\",\"/knowledge-medium/src/utils/state.js\":\"39979edb98532a78\",\"/knowledge-medium/src/utils/string.js\":\"097869c25410a258\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"f433c51c8c95f206\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"aed5f4b2279a7b9e\",\"/knowledge-medium/src/utils/toast.js\":\"8fdd20fba950327f\",\"/knowledge-medium/src/utils/toggleStore.js\":\"b3f6185d112ad03d\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"3d18def41d446725\",\"/knowledge-medium/src/utils/userActivity.js\":\"1d779f23716d3f60\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f3a803670795799a\",\"/knowledge-medium/src/utils/viewport.js\":\"267e5d8e1df0abbe\",\"/knowledge-medium/src/utils/webLock.js\":\"653e25bfed38dd88\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"4f0d3bb77321592f\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"45e75c3191d39899\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"afd99baa5392a050\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"56f3b1057a007b9f\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e9a0c9433b265333\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d327e6622240b5b3\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"00059b669e90d4e7\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"538b16760a91f3d3\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"1c9553eb76517082\",\"/knowledge-medium/src/vendor/react-dom.js\":\"b0605b68afe303d6\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"5a349bcc9d21668f\",\"/knowledge-medium/src/vendor/react.js\":\"3bc30f6ed6edb4e8\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
