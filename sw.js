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
		buildId: "e0c44b51174c-27f01cc4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"0dfc0d44d8e95ac1\",\"/knowledge-medium/index.html\":\"0dfc0d44d8e95ac1\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BV3TjMCP.js\":\"90f1c62e50300845\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"d362e7b2c56c8be5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Bc0pEWpj.js\":\"1adc39617ed3a0fd\",\"/knowledge-medium/chunks/FacadeVFS-B0yO0I99.js\":\"cadfebb76b42018f\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Drsgl6Of.js\":\"db2eae6cf0c9fa18\",\"/knowledge-medium/chunks/MemoryVFS-CJ6TYLd1.js\":\"db54fdca271f039e\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-PA2kpOKX.js\":\"a19b9e47584e5213\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BCClavcr.js\":\"747856a9c3e823f6\",\"/knowledge-medium/chunks/Preview-DcNtEA3u.js\":\"51d2bd350d2977c3\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Dk8ZvJsz.js\":\"1796b8baca82a24b\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DFLU1aH9.js\":\"951f92146ebec7cf\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B3cdo9Wl.js\":\"2c01a499d1ab104a\",\"/knowledge-medium/chunks/react-BRaQN2vz.js\":\"09ce145e97199122\",\"/knowledge-medium/chunks/react-BSb-VQFm.js\":\"0bae353da66c0af5\",\"/knowledge-medium/chunks/react-BmSiAcR5.js\":\"056a6ffa9aa95c6c\",\"/knowledge-medium/chunks/react-BwLYxFx8.js\":\"05ccf201b069e2ae\",\"/knowledge-medium/chunks/react-D1sNU3WB.js\":\"f379881e62f8b8da\",\"/knowledge-medium/chunks/react-DXALLFEQ.js\":\"b24a5e88334fa0a5\",\"/knowledge-medium/chunks/react-DvJI23vC.js\":\"7c55b0e643423268\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DgKR52wo.js\":\"9a16f25b572e5cda\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BkN2ld7A.js\":\"d71345dc1496b5d0\",\"/knowledge-medium/chunks/react-dom-server.edge.production-4J2u4Vvd.js\":\"d81c9049e518face\",\"/knowledge-medium/chunks/server.browser-DwXhrKJL.js\":\"cc803c9e13eb3bfd\",\"/knowledge-medium/chunks/textarea-DNnxz27A.js\":\"7b6bfe8e6a96a22b\",\"/knowledge-medium/chunks/ui-Bn6B2Eb6.js\":\"d629b2fa59af1eb0\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"2fcefc274e6c5ace\",\"/knowledge-medium/src/appUpdate.js\":\"248af06ccbfb50da\",\"/knowledge-medium/src/appVersion.js\":\"b5db299e229c53e4\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"4830654713da1427\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"509c06ae676bbf34\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"acf96faf795ef2c3\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"d34fc753fd3fc950\",\"/knowledge-medium/src/components/BlockComponent.js\":\"41e5a9a02231e506\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d45a6a09f78fe270\",\"/knowledge-medium/src/components/BlockEditor.js\":\"ecf69cb312364dbb\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"07cf098002e4a9db\",\"/knowledge-medium/src/components/BlockProperties.js\":\"34dac04401ca017e\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a38ee293ece49185\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"825df2fc2e1f4757\",\"/knowledge-medium/src/components/DividerHandle.js\":\"0faa735821d69262\",\"/knowledge-medium/src/components/DraftEditor.js\":\"b8cde89d7238f7b3\",\"/knowledge-medium/src/components/GutterPill.js\":\"c3d55daffc6dc22e\",\"/knowledge-medium/src/components/Header.js\":\"adfdaf358542fed8\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c00481fa6853cdd1\",\"/knowledge-medium/src/components/Login.js\":\"6d6c88e9e5ad6150\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"5a7943667cc6d87e\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"7ac7b1b5ac1dacdb\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"dd05ab2a8f752661\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4495be7e06c79cf2\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"81a1c6f3d1c59b82\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"093fdfa6fc01a66c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"9de6a0e9efa1a9b1\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"126493a271aa8e09\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"61297b8b02971ce6\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"0e5215fd7f275b01\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"25e91083bd55fd37\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"9b19edd1219d08bb\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"9c7b9dc6c90dc912\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"48f5904f78794599\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"3dfa62e52d15e8d5\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"cab153637099937a\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"a69cf20cecaf3a81\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"906cd5f841b5dd8a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a723f954e3effa35\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"dbe68b31b24fa659\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"bda1413a8321496b\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"042bdb2f5dc72a8d\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eb9c2850fc425e19\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"880f0eddf3d80efc\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"af982bb80a73ad1b\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"5c5868fa8b73e13d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"b7d3478ef0a99ce8\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1755589b24208c50\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"bfd685ebe914592f\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"02991f5390a6625a\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"1a703813468a91fe\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"f8727866bbb431ca\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"0b273d9a70e52754\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d41213e05d583f48\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"c9d8ee99eb071ddf\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"a89c558e06674f4b\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"e444ee93300b8d83\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"a932e3e884822b02\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"eca040fc2128f3ae\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"40ab689ba2f99a12\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"d1a260b5063b9d6f\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"17515f32416c9336\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"17b689473d53debc\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e3c86e2d319a633e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"17a3a3be1e6ea1e5\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"421a34729aafaf66\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"49ae9d15a34b9176\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"80f4e8ca4a87c2cc\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"e4cd83473a1a42f1\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7af0a6b3729f68e9\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"891bcfe72840913c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"f371b3efaf6e189e\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"3646873cd6e654aa\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"eb1400fec1bbb731\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"61f4471509a58ced\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"dace8a0f2425af53\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"cea9063c781b1a7a\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"907391a755e8a655\",\"/knowledge-medium/src/components/ui/button.js\":\"0fedb68f0f33a564\",\"/knowledge-medium/src/components/ui/card.js\":\"55fd913a33f01f4d\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"5574f9699d37ab81\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"78371fa48d01164c\",\"/knowledge-medium/src/components/ui/command.js\":\"3e248cc330e42c63\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"280e61cad65c13c6\",\"/knowledge-medium/src/components/ui/dialog.js\":\"751d9f700c0754dc\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"d2ad83e521c9f2d0\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"9422b36ddaac9b66\",\"/knowledge-medium/src/components/ui/index.js\":\"b7e54ea432972545\",\"/knowledge-medium/src/components/ui/input.js\":\"b37f5a58968d7444\",\"/knowledge-medium/src/components/ui/kbd.js\":\"06b600faff1782ea\",\"/knowledge-medium/src/components/ui/label.js\":\"fa8702b73fd8e21d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"7cd3571b8f2fc578\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"7bdc448613d75bbd\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"80a5de213a35f6a4\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"6fb1cbecf394bf06\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"19806c1e7c2cc758\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"7c69bad731891d41\",\"/knowledge-medium/src/components/util/error.js\":\"8caab80fe8f39627\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2cdbb02423885753\",\"/knowledge-medium/src/components/util/suspense.js\":\"b9ccfb6ce1390dba\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e01e3d26f1fbc11b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"44d52cc16ef001e2\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"03234ce60f59c9db\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"a7282d6d07e7f088\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"e2743098a296ad29\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"8b6e499353e30e63\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"1eb005be2f6cbd39\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"edc39e3a85a8af9c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"bcce8037cc53ab51\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"a64745e0b5d9bb37\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"f9e4bec466434364\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"e2de9e56f277f0bb\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"978b1d1dd9cf24c5\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"bdfa13dcc93639da\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"d7c68febc1618cff\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"4b2411f01ad11851\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"807076be245312a5\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"073c8e0810c039c5\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"758dfc69ef7d118f\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f966b90423b813d3\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"343f222df006594c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"d5afe96027207d71\",\"/knowledge-medium/src/context/block.js\":\"aaaa84ba9ba14a58\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"730f4ad43a64f541\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"a7ba67997a2bc3c4\",\"/knowledge-medium/src/context/repo.js\":\"ca6135cf858082d5\",\"/knowledge-medium/src/data/aliasClaim.js\":\"44aa1f80f8a53a07\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"3cda04621ff0e209\",\"/knowledge-medium/src/data/api/blockData.js\":\"d5b31c5376538f4d\",\"/knowledge-medium/src/data/api/blockType.js\":\"3fb371eff3d723bc\",\"/knowledge-medium/src/data/api/changeScope.js\":\"dbc9d69ab372bcd1\",\"/knowledge-medium/src/data/api/codecs.js\":\"f8fdc13b03fa9296\",\"/knowledge-medium/src/data/api/derivedData.js\":\"4231082f877f6c54\",\"/knowledge-medium/src/data/api/errors.js\":\"cbc6905f461d4c8c\",\"/knowledge-medium/src/data/api/events.js\":\"7e918f4d0a6fa34e\",\"/knowledge-medium/src/data/api/handle.js\":\"c1a74ba677771ccb\",\"/knowledge-medium/src/data/api/index.js\":\"c3138e6cf10d5983\",\"/knowledge-medium/src/data/api/mutator.js\":\"c62a0c051b245d1b\",\"/knowledge-medium/src/data/api/processor.js\":\"95cf07d169f8a680\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"881baaeff4f7a583\",\"/knowledge-medium/src/data/api/query.js\":\"9a6eadb7a29c5f22\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"247c7ce9491994e3\",\"/knowledge-medium/src/data/api/schema.js\":\"c1a74ba677771ccb\",\"/knowledge-medium/src/data/api/tx.js\":\"c1a74ba677771ccb\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"7e75c68714468106\",\"/knowledge-medium/src/data/api/user.js\":\"f479f6d706b69858\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"b5cce94fd93430db\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"2e92e93901a44c33\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"019d83cb595babfd\",\"/knowledge-medium/src/data/block.js\":\"0c8acefcb5d09e0e\",\"/knowledge-medium/src/data/blockCache.js\":\"2525a09681182b00\",\"/knowledge-medium/src/data/blockId.js\":\"688c870f9e8ecec7\",\"/knowledge-medium/src/data/blockLiveness.js\":\"d136b305ef2aa3c2\",\"/knowledge-medium/src/data/blockMerge.js\":\"f0de7ff36abb5b5e\",\"/knowledge-medium/src/data/blockSchema.js\":\"5cdc689680f32e9c\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"c759bc915f6f9399\",\"/knowledge-medium/src/data/blockTypes.js\":\"9396514439e7d9e7\",\"/knowledge-medium/src/data/childrenView.js\":\"7eee392b7316cfd9\",\"/knowledge-medium/src/data/clientContext.js\":\"216e81b4a15d414a\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"be2a24079cc30475\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"e942ce3446a9f90c\",\"/knowledge-medium/src/data/derivedIds.js\":\"9001418e215f8574\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"88b39efc3c334cb1\",\"/knowledge-medium/src/data/facetBridge.js\":\"1697f7894287f222\",\"/knowledge-medium/src/data/facets.js\":\"28ee0a54bc43bfe6\",\"/knowledge-medium/src/data/globalState.js\":\"1cc9653ddc5bce7a\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"6607fccc6d58ee26\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"6412736452a46bce\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"286396f39bc12c09\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"8e710cea14f9a842\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"88227b9ff3005f34\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"fef1256b2fea5ef4\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"8d9bc3eca30074be\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"a768e1b8495b0e33\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"c8db7f201025df5e\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"29db5f081ecf87b6\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"dea21e160822ab9f\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"baf7575f066c42da\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"e7543410ff1f55ba\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"3c8b34d8ebd9b2c9\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"d5fdbd140b9de122\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7590672ebe8bede5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"6692d54198821d1d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"142c030551366d6a\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"77aea8478ad83439\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"8a03507f5abc4692\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"53aa4a5f3fec60a1\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"243435b89b495b82\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"44cc7f7aa8dd4530\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"1657320c7fbaeebf\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d3dd8f19e452fb3c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b1a03b00cac229cc\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c35af15b42e48267\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"d119451cf5d6a140\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"5be0b2d655b469fd\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"65a9fb764ef44a3b\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"9238851250b4e938\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"5bd9a2ff8a85e04d\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"60bb27644860cb95\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"ac35632406e4c6a2\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"06aca3e638506199\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"090e7d25219a2c3d\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4e2bcf0f2aa1d87e\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"6fd9a773c40afc51\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"3107d0654dde540e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d876c95d7c1e903a\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b5da0e8e9084e772\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"8372aeb35ac77869\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"aeef5bef8e8b8a0d\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"0204d16200c9e4ad\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fa6862640e6aaaad\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"7f86e337c5064414\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"eb76e3480761927d\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9362a044c3be7ad2\",\"/knowledge-medium/src/data/invalidation.js\":\"291d182aadaa3385\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"bfb4aa277b729e67\",\"/knowledge-medium/src/data/kernelPage.js\":\"5624dbe48cf194c2\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"ca38703f2276c4a0\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"fcc5846b576a877c\",\"/knowledge-medium/src/data/localDbStorage.js\":\"daa04f7c1984670c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"40a1b0eb95e568ce\",\"/knowledge-medium/src/data/localSchema.js\":\"0cd8ca3258dfce76\",\"/knowledge-medium/src/data/maintenance.js\":\"c4876be0a86ed42c\",\"/knowledge-medium/src/data/mergeProperties.js\":\"c854a3c052c99c17\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"ad0a83e82b0134bc\",\"/knowledge-medium/src/data/migrationsPage.js\":\"cfcb87c8670a4920\",\"/knowledge-medium/src/data/mutators.js\":\"420415a554206b96\",\"/knowledge-medium/src/data/orderKey.js\":\"f725adcfaf88f6ff\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"f1a62285d99c953a\",\"/knowledge-medium/src/data/outlineSurface.js\":\"dc0ac8354b5e46b1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"349bc9cbc24dc975\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"e0d9243b303330c6\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a8574e1235f4acbb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"72791dc219d39400\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"eac056fcc19bfd3e\",\"/knowledge-medium/src/data/properties.js\":\"898d0aeac19e5791\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f2493c555e7fb1f4\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c7b2ee67448c9445\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"7bac79ce9cad22fc\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"5b0650235baf84db\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"0908b89cace2ab75\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"df77de6103821f57\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4afcc5dc66365fcd\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"c9af624a2c594b60\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d77cbe58bf6815b2\",\"/knowledge-medium/src/data/recentsPage.js\":\"8453a0e193f9bd07\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"fb58b33534169d56\",\"/knowledge-medium/src/data/referenceBlock.js\":\"2e97aaa431b1ea72\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"e523a4aea1473aae\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"1a79cd3d5eb5b99e\",\"/knowledge-medium/src/data/repo.js\":\"879fa53db4498207\",\"/knowledge-medium/src/data/repoProvider.js\":\"5e46f7f7a4feb357\",\"/knowledge-medium/src/data/rowProperty.js\":\"b217af327002fb02\",\"/knowledge-medium/src/data/searchFilter.js\":\"c2089c0e59138be8\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"6f827eefc374578c\",\"/knowledge-medium/src/data/stateBlocks.js\":\"7cb71e21bdde7419\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9f3f7a0b15396df1\",\"/knowledge-medium/src/data/structuralInsert.js\":\"d25fbdbd764550bc\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"3d3d3bd17c408c40\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"4678bfca59d18383\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"56255c4397387905\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"a9a5680e213eb5ed\",\"/knowledge-medium/src/data/targets.js\":\"bf693bd603f5659a\",\"/knowledge-medium/src/data/typeColors.js\":\"e0c3505d6b492a37\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"8905db50ca376e8c\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"b36526c400f45924\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d9bd5eaed19dad5d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"834b1e57f006a995\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"d50152ac20c8a0e2\",\"/knowledge-medium/src/data/typeSeeds.js\":\"904e055fff61638a\",\"/knowledge-medium/src/data/typeTagger.js\":\"909ad5b56d717aed\",\"/knowledge-medium/src/data/typedRecords.js\":\"3369fa29e63c40b2\",\"/knowledge-medium/src/data/typesPage.js\":\"3c7f311cfc683bc7\",\"/knowledge-medium/src/data/userPrefs.js\":\"3f06bf198152566d\",\"/knowledge-medium/src/data/userSchemasService.js\":\"48825066b738d9d7\",\"/knowledge-medium/src/data/userTypesService.js\":\"aeac426410b2dd38\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b1bae2b27e7aa2b4\",\"/knowledge-medium/src/data/visibleChildren.js\":\"edf4528694aea022\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"86dcd171fa58ca87\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"0a4dedfc9a5bcfab\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"f25af113c62042a4\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"81c4d1dd9b80d377\",\"/knowledge-medium/src/data/workspaces.js\":\"24d8cf4d1e5cb18c\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"293e0c1f54cd0e05\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"100b6dc5be1f29ee\",\"/knowledge-medium/src/editor/atTrigger.js\":\"cf35fd5e2e039e0b\",\"/knowledge-medium/src/editor/autocomplete.js\":\"723bdfe5e573183b\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"136271f0ee488631\",\"/knowledge-medium/src/editor/contentFlush.js\":\"aafbb748c7b8920f\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"952284e7babe23b5\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"5d329548d9755cb2\",\"/knowledge-medium/src/editor/insertImage.js\":\"1c50922435ad4328\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"f04fe010c11c5ce1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"1d80f0e981a9cfd6\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"d0a6fa219e8797f1\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"bf4951e88708321c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"241d91fef1489d95\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"0b6b03b624723342\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"cfdfa6329bbfd109\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"2cbf001e5e13d13c\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"28bc303ca5878d4d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"70faad0fe5adf650\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"d66102902245e281\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"572bad3ed3adf3a4\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"42278004e16acf3b\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"8f09d054f1c6d198\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"d8a81b079a65514d\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"59c0bad009080214\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"4c33751583ac9702\",\"/knowledge-medium/src/extensions/core.js\":\"a481781af29bd772\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"1b151950dbfeb4c6\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"6ac0bcf61cd0782d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"9f520e874bdc16fb\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"c700004ef6c4677d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"12747b6b0e04694f\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"6dfbee2010d8dd2f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"aaa482df1ad02dda\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"b1c1261169c679b4\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4738cc618f586be6\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"cf7b4bfe6d635f39\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ea697805330f702b\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"3d1494eeb6b7a693\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"7652e3e78bf3400d\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"750ae4e0882f89c2\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"49f9f289ce76bbfd\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"6ee37a9c847de916\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"a1800afa482c926d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"478fc31f7d5f5dcb\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"1ad8b589017c5b54\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"ab96e9030f3b243c\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"0faf4f83e2233adb\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e677de96bf13cc35\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"5e26debf8c2ebdf8\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b36b54aa6e63b140\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"ba3a9169e9194375\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"d8c5ffa68c9cc702\",\"/knowledge-medium/src/facets/facet.js\":\"c47fa7c48bd0c525\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"793fcfcaab4df13c\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"2d67ec2f9c27a96c\",\"/knowledge-medium/src/facets/togglable.js\":\"a07957f3d383f967\",\"/knowledge-medium/src/facets/variantFacet.js\":\"1d02060fadb056ae\",\"/knowledge-medium/src/facets/verbFacet.js\":\"26852f01c8ba5c61\",\"/knowledge-medium/src/hooks/block.js\":\"4f37fd62dc575520\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"61c3014f700c5425\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"513b5ef24bd1d9e4\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"47463fe3f5ba16c9\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"94528e2b0d4a3441\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"cf3ca6dd87c5a345\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"12e252a2360b6ea8\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"3c32987831897e3b\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"e908462b2c16b808\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"870f1100afad25b3\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"1b1413109abe26e4\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"139c6358255dae33\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"ae3f380bcfb74343\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"8f3aeb26ef4c71a1\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"2f1ccb77fb9fed98\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"2d5b3f6990e9b7d1\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"3f08e36b532a3119\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"b3b516dd1f162843\",\"/knowledge-medium/src/lib/utils.js\":\"88ef8e5866156c4e\",\"/knowledge-medium/src/main.js\":\"32431a258c944b21\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"7ff0dafe6b9d5af2\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ad370fa2ef8e6a64\",\"/knowledge-medium/src/markdown/context.js\":\"f39a3a1409dea757\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"77aeea6389ea2fb3\",\"/knowledge-medium/src/markdown/extensions.js\":\"5088aa1227495afb\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"3a91dd724a770ed3\",\"/knowledge-medium/src/minimal-editor.js\":\"8c882eefb7cb1ddb\",\"/knowledge-medium/src/paste/armedCut.js\":\"62b8795b751805ff\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"698870ba18c26c06\",\"/knowledge-medium/src/paste/clipboard.js\":\"b7ed04435722387b\",\"/knowledge-medium/src/paste/decision.js\":\"8305160ae35473ac\",\"/knowledge-medium/src/paste/operations.js\":\"e28f98f064f9830f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"d68540d85a334513\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"92ac6a6c7d3e6bf8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"400af35f8816cab7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"abae843cdf262809\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"aab8a80a2409a8d6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d2ac347108fcd582\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9ae6fd16f45015ff\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4853c403d287c5b7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"ab238e05a11f202c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ccd5fdaca5ad3d63\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4de1e8aa07af4756\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"258f2c04c9855d5c\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"88fbceecc8e3a12d\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"809b9eae31a9a372\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bb013d2800ce56b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"da2595021036958f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"c0387ba89e64db0e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"403742a1ff24beb3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"0d7d0a83784e4063\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"4a04856d591405ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"fa350015f442f519\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"37f0b7033772a095\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a0867cd3215ad493\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"d77925d18eca2a6d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"02efede856511d0c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"98620aef8ee14f12\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"cf5974d1319d639d\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"2a3dc73bd3443432\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"7d5ac92a6809a79e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e2fbf8d2d3cd3620\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"4c6ab3d948e1b527\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"0692be0d17715183\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"1144abb3620c913f\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"b93f32638c72d894\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"8198caa9f016da22\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"ab5cdcc2c9692e9a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"521eab28f86f3d6c\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"e44ae92c8fdbdc72\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"73a9dfb363517f98\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b9d9738cf499da36\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"1330d0d31dce7a05\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"1f3d3f0faa98701e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"4ea68d11fa948612\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"04cb6da5cad655fd\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e849426b229448ae\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"7baf5c7b5bfcee21\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6e5ff3235ce22111\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"3e9d423a2eb6194e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"fcdff0d8012230f7\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"1f4e7600ee488004\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"562ceeac8113d36a\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"d382eb4e6cc189cf\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"df6602fbd51fc3df\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"2e44955c721e1f2c\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"0743e3f2a5c9649a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"ae3662e297650e1d\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"f36ac91cb9d2719e\",\"/knowledge-medium/src/plugins/alias/index.js\":\"a5d59572f99dc857\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"1e4483544594097b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"b402af6f95dfbbf1\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"554f1c600d81f212\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"13020c09c247938d\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"8acdf6914da3518a\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"6b2701ddf041b470\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"9596930714f0a5cb\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"fb0e44f37804d9d5\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"7e00e2f4078f2a30\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"be563e2077f64c50\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"214fc3568c655b2d\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"0592926a489dec4a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"6e579adc3402e44b\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"9f2e13ae3ecd5e7a\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"67e6b36e2044f471\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"fbc6edede4d2b4e5\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"72571add626565f1\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"9ffcfe2d6b195e94\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d28d9c857123b1ea\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"f7a122efd5df32ef\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"3417ff076f2f58f4\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"52b579645179f883\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"fefe11144c7324ec\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"51903074bdfd8e90\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"d79906291eba52af\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"d072e932decaa256\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"d6fa410b593234c6\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"78d1449a7d286283\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"3c4e43e88f0f0d48\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"ef81490cf4d004d9\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"c17ac9236abb1a61\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"a43e7bd7362ff258\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"ea1a430be2005c71\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"98b764ab67083bf3\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"67c911c4795d46cd\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"75db0601a983584c\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"de3803980894488b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"a14d9debc181d350\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"b306c80ac36bd867\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"049db9949d3b89c6\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"802827d251cf8822\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"a59e0016d1794d11\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"33590a48ed212172\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"336ff16ab48ac0e7\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"375fb9281c8bff07\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"e62fd66c050fb038\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"2fd0b54aed55a5ed\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"3b0282e9ab2df3cd\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7180d940ce436e2f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"e8558cd02ff06416\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b60831ab01118aab\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0f7999738ad431b7\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"9172372d51f8f5b9\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"186e86814154dcb8\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"70a3ff02424f5e8b\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"049f2be100a4f170\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"95317cad4fda3ea3\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"b7470c79ac8466df\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"aeb2584d751ac94e\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b1e38463b9633136\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"8cc0d6fcaf5d12e6\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"2c6ee252356a2e2e\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"7fb68c061a235c35\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"12a372493204f5a0\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"74a11a3eb731536a\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"b554940c665e8f4a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"cbdfd4dedd9c655b\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"9114f1dba8d17106\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"94c0c2a1f74fb798\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"06d6d502e3b0599c\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"3c8b09db0c527c94\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"b3fa4836afefeb40\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"22155222b1cfdb8d\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"1bac6409fb2be687\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"f45cf4296cdbdb54\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"1de35fbff0aa6dc2\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"9fb14ad3d97ea317\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"a774949d661f5563\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"037ac34b58cf0967\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"9a26ad34693e19ab\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"e05f013ca1dc40b3\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"b52c8341d9587ca0\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"26cf96a856c8a172\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b2dc2b9e79ef1cef\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"014340acee57dffa\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"faa96f52b1dc7dc6\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"e18d65e862f0bde2\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"3b3d969e6e3156c3\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"1207cf4504508125\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bd43de335cd0e3c0\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"a01c78d88b87655f\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"8bc929a24f8aba1f\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"822edc138fd67db7\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"b553eca812307e8c\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"137322093085ba05\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"566858fd416ea3ca\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"881c8f9e0aa60b70\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"b6bf02082a1e8cc9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"91f84e4362ae0e16\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"811ee826069c76cd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"ec9e56c66956ba6e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9aaff8e12e3e8352\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"14693dca9ce46bf8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9f7f74865e7c25c7\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"96a880c04ebde915\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"2d07fd5cda1c341a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"56e8938811e7f007\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"cbb7c31f9ce1e80c\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2f20e029c4283403\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"6a2a58b4e1cf4395\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e4de3936cadec2d9\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"b2119ee7267bbb5f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a4ed729f6dce3848\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"d1f86f22d1ec9694\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"9078e57de39dec24\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c67403950a37df6f\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"62df8e3c7877c0d3\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"9ccd08a499c535ec\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"c6b06d1683f4ec48\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"08efaa558092086a\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"84eacb168f0d19a2\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"2bae2022a468bf84\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"ce9f453958be5fa0\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"01f9e12d958f4a18\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"562a425f6fd080a7\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ede016f7c1506b88\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ffde0c57dcf24a79\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"8df3816dacd5647e\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"c02521ab52f9b40e\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"7e110d37b19ab69b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"08fac8dc408f2c6e\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"f633ed8dd19b103a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"cdc4e313cfa363a1\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"d516c38e2c61ff5a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"806a3351d3a8ba5d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c82971ae0a7e52c6\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b11a8916b587b4d9\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"00be942234332728\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"90573e7d4e9d9882\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"c09fe5f5ebf1053d\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5d064386f59d3681\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"300c6e911ec19664\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"02845093728a03aa\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"2c6eb75611e15d6b\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"5bb8f6bbea1aa242\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"64b28d7861c85102\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"b6f452d84a873078\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"7a8bcb84a2c35e73\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2bb2bb518ae4fcde\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"e94ecf3a5c27a324\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"a3761a55bc454d20\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"d5556f9229af75fc\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e669c3f6003a2188\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"cde2bb5fe790b9b2\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"13f616b6d45138bf\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b9a6c5f04a1b42ef\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"c3c71bd964cb64ea\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"49d58ec5ad6e59bb\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"19132413436fc6f1\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"6faef04cc04b2300\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"88e68f9119f22f06\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"0e2502f381c7afdc\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"fbdc05a38cdf71c3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"7b518a58ebab774f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"05f73bea689db5fb\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"485442979cb1f81a\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"1c02db26517f4a05\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"c8fdf27244d10ba0\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a938b4073e67e47f\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"a7c58fb54d71bfe0\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"d1f8fc028ad4dba0\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"440f62f687f2ffd5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b80659e0cbe12501\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0f7127bee16611cf\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a5ab19247d8131df\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5d605f931f644629\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cea0b8401f5c2141\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"a2d1c9d1b00c2aea\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"9aa50ae8cad762b7\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"717df80771b7743f\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ef90ab79d3e2b266\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"25a85262d6ae5ad4\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"f424780281bcd8ee\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e70f84e844b32544\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"4a5c3c2be4435909\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"738105cb0ad4629d\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a7fc3a63f38d8bda\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"a005e07bb91c297e\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"694e6f54aae57c65\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"147286159b6829d3\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"8e3102b8d11f92ed\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"5b16530390c97a3c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d004d719e20463d4\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"30368a2952c1c5b4\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fb549698aa674d27\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e158263403b05fd5\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"9d8d6f8e7232ac4d\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"21295c3b39b1694e\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"1178cb21d63955f9\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"4beb409967177fb9\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"8827bb1981a9f1ba\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"dac28cffd3c685e3\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"155d2a58ccc10006\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"fe18ea2ce027cb14\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"f49e38c48cffdabe\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"86cd7a3d8279a8fc\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"95f7eeba833b910e\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"d7c23099fe2078c7\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"727824b829086f1f\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"09e07000b3a46949\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bd054d749bdd6f59\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"82c4822b3abe22d1\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"bea8e4fe46f1f33b\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"8f28c6b4d618f702\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"e0103482e293d8c9\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"f117ba8f85fbcc72\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"1a2f5405487d23eb\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fa779ce623cc52b3\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"9d38a1a8f8fcaaa3\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"aa280e27a485fb86\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f60aeb84c9b27016\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"a04f573232621106\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"ecff09d825fde74c\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"7ad446ba1d04ce74\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"1f2f161941a74e97\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fbae5d7aa7a15762\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"81ee19f617329ce2\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"133f774507a4ba3f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"9d2ee31fededecf2\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"8efa64970531e8ab\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"f72aba434c9db8ef\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"df86a314770f4c68\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"b11b81ef51c37da2\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"9be2b3ded432a2ad\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9c0c20df31baa552\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"a7a35291a102b390\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"789366bcb7db9cfb\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"25f1d0bbe1a88496\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"3ccbd43d5e5aef5e\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"dd05b684189a61fe\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"2c0c7a82f6af4615\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"ca78fb7b5c0c3201\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"19f92f5b48d248b3\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"98426063c04bd980\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"c23e2946e19c6715\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"49d93f49e3bbace9\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5ee55fa8f1f2105c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"d6074e70ac5b77bf\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"6e84b5c279f08811\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"5c31f07a4d0dab6b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"86bb32c499bb64a6\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"bc1457e392de7657\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"efa97f10ca717a49\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"f16a811246164a62\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6beadc1fa2072db6\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5f93a57b52986322\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"d52b77dc394631e3\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d87c465de8e142ce\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"558f50f166892b5b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"eeb92eb50636f737\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"8af871375d356b5a\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"2972e3f732d60ee5\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"5a9ced0d141492ba\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"5f22aa6e4535a2ad\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"9c8c67fe734f63a8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"2dca2c631c2ad0a2\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"135fc2794d50799e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"37fbde84ca987487\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"0475bb449c46e295\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"05ceb243bc9a1220\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"801b76932af12367\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"8ae9941aa30296ed\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"05eb5de0bfabb7d2\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e9b6febb61edca4f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"1304cc8e30de0574\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a7a119a910a75ba7\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"2086aee40d44b554\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"b7037a13317aba77\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3e6a4115c64b149e\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"24252fadc8964249\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"9e4e9b4edb8730a6\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"9369d24f2080c579\",\"/knowledge-medium/src/plugins/geo/query.js\":\"c4911a10031292c3\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"7fa6eff1e63f36b5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a32cc264d53a031e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"784e94b2c2f0d4ad\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6d8c7eb2940150c4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"bcebcde9868127f6\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"90f8b95834eb2f20\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"a3c5325c8cb4179c\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"9955d498482210b9\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"b47b73f64eff0b40\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"319f63efac2a0a23\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"c1affb523c88d0c5\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"3a0f49382389be5c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9ee9a9652a9b4fc9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7adb6b63e8e10409\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"90e1fcd4459ed4f3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"abd0c54beb5e2cfe\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e0ea330536360027\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"ae97ba6f779a4115\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"d91d0ada3113d2b0\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"471cb32ceb41cbb7\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"a8fc79e0cf6aff22\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5f884dbe012e5478\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"1ac9c606b174936c\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"5014a3c2a3b7d7be\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"fd2ec66b33eda650\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"df1905055ca6975b\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"8721dcf1be18fa93\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"a8b980f0c2a0bc23\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"feeba590f5f1651c\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"9d630f91a81cd52e\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"db42a8563600f975\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"7597b28df4234d3c\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"025de570944e0c82\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5783b2ef73e7b075\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1570d9985b3b46fd\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"645e3b9e8aac1bf0\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"82f915f58f78653d\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"60b875d1e5873223\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"eb16cd9bda73a91e\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"9b5da935e315e84f\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"c2f7f5d4f26df20f\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"dea85b2865eda4ab\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3d9d1e24f5caf791\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"e70ac19d6f0d854a\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"e7ecdbe3e11dbde2\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"287de0d69e53d4d0\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7ea425b25e13ae7d\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"30dff97eb812a4a0\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"3afc397002d23dce\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4ad88628fb8c4de3\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"e258cfa5c91d930e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"1171bc53fd8a65d8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"b7799049afa2d086\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"1c0e35b670070519\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"13a85a4f0e5d4e37\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2d43f66cf880ed44\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d9bf4a1a65e3129f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"965c3e5ccca3532b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"521471acde578e2a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"29030b956d996960\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ecfe1c15973d811b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d7b93f00767fec49\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b909f1d8fe3d0b27\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"3f8a650d73cfa920\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"17bd717b8f6ecdbf\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e45103d2d4777eee\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"2d0fdd8aa10de905\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"7964418e8fcac6b2\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"ae2088f49be83823\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"f9a5f67394afc00e\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0277e772403a5574\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"5ebb37159770178a\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"fb95523105ef7ed9\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"a68032952fcbdb27\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"303e53638bd36ffa\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8ff696751bcca5f7\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"4613cde09588d2da\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"3b81f7aa9db472c8\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"943ddc69a9fcf004\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e3f2197fd107dd4f\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7d014c495a507bf5\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"7bdf748cdc29fefd\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"11b250e5f23a6905\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"757530fd4eb714b4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"4066da7d7848ea18\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"93d2707b8d7b3598\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"0e9c99ef37f89875\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"64d54346c8cb5b1c\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"231cf6288b08abf9\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"4a86ae8b7643c91f\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"10496995546672eb\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"ffc51e0821593e9a\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"0522e1b271b42180\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"02ea29d432608425\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"e268b26af18221d6\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"2ede33020b18e430\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"ee0eeba560e062ab\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b88780fbf78e249a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"476b27138c65ca4f\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"7b5bab90d1d2ed1e\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"9553e3bc2ce3a030\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"edb0791926b6b3b8\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b9089f060cee4efd\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"163f384fb956ac48\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"cbf6646f41493f4d\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"4b366d7c6c246014\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"5c14ca3d7b9e7777\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"7f1d407ab5b24a64\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"50981c6c15a14c2f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"0325fe8d9bbd0113\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"176d5526fca8d184\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"be2eb585bb62a5d5\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"86c81645e3084bf4\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"97cd93ee46adbc73\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a6a68886a4c72844\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"3d372652850f71b6\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"fe0cf6c437ddb4f9\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"f273674ecfb204fd\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4410e0028a78bb55\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"30533df8ac3cb4a1\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bb294e92abd48a93\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"24568430e4d9f039\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f112997b28f1b49c\",\"/knowledge-medium/src/plugins/recents/target.js\":\"649e0a339b8759c7\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"04856883ca4f80bb\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"12397f168ab3ab70\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"b3cb3fe862366915\",\"/knowledge-medium/src/plugins/references/index.js\":\"439b25f8c5ddde55\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"17ba4f9612375af0\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"5ec7601581d47650\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"cac95e72be8489a0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"b0fa08e7a9926993\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e822da63d25f028a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"a73b1a4cf69c3193\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"05f03ac91abd81c1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2aead5471f094ff6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9a958eaf883b4470\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"c34f47ae76b5f97c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fb8a319bc78b0b50\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"75a9be673cc955b6\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"7c0578aaac13b7ab\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"8560622075b18448\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"5a237f396fdec986\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"4b0f3f740429930a\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"52af9cc795c12948\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"5b6542fc9c7e934e\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"37093886f0de01af\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"beb499a29d08eaea\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"cb078d5b3e7ef526\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7759e5b7329f3eab\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"0051a223a79c6707\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"67967543a4b8d8c4\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"339f327621304b54\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"7e1d429b302f1ed6\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"a36872a0e833b055\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f54ab4f5df26bc04\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"689dea7b2e4f0b6e\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c029cc11c58c7de5\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"40a535fa6e57c2c6\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"2a0af8a6ff1c6be0\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"83833884615a46a3\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"e47a8b77f6869cb5\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"1c38ece1dc0f296a\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"f7ac73ca001ca754\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"0522670c756dfabe\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"9c803493edfac0e0\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"9136492a23ffb100\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"862905021652bf8b\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"3438a79ca7bcfb9a\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"2b93dcd1ddd1c4ef\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"f236d850f441c4df\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"425680ad076f9e63\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"9dc42678396849dc\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"1c1c2ff074754b90\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0cb04e32bfdee36a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"d9554bd37baae208\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"721563a1d6faf35b\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"fbbcf8285cf23256\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"58116076adb25405\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a16532fcf78f7758\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"69f9a0b31b0dcbec\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"5856de2f957ff86b\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"faac46d44b3bfc97\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a0c302832c170bfc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"17afde7c53fe3352\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"c80ef814607a9b3a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"34a6f24ca96f4630\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5d0b2ed04df0db2d\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"04897ebfa97c709a\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ea5a71cc582bf05e\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"314d0404e5fa74c8\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"0c163367773837e9\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1d87a273e81af926\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8600b5d54e4388b4\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"2df122a9d32903b1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9fd678e2ee087a1f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"e5926d38f1abb933\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"33233af2f40f4212\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4cc98fab6a727226\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"cdeeaa2643b6a12b\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"4003b9fefcc84792\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5429e48943fe93a8\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"7281ff87a8c740ee\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"2c332ce1dc7e3bf2\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"ee579db0e39fd4eb\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"9c1b76534a8c2a42\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"c55ba818defdf412\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"96485d3bf5706528\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"fa8db94475919f1e\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"95c2a9a1c55690f0\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"2b7d8cc354c44e72\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"fa2a62e88b97592a\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"739e9e5e92bf3a9d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"9f7e5747e9330a08\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"af50d1237aef030e\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c0bd77d05d01886f\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"7c310f0f745e8c0b\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"c66afd0cc4c8f1c6\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"4c841f5d5d495ba1\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"76072b388489193a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ef229789c3f76d2a\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"9840ba78e1eeb380\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"325f16f24fe91930\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"35ce3ec0858ac117\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ebdea8434cd34fa6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"1817273c65db276f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"687036605e1ecf04\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"bea03b74db10d127\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"5b85efa567c8a5a4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"be751751f6d4e270\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"073f9957f830a33f\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"81b2a6c914ff4cd7\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1df785f0b42e3eae\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"c4e2bdf770752333\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e256b06dda938b59\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b9790ed405b251da\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"ec8e9a7f8bcde2d1\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"b7ebcc903a0b2415\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"3a33def3256519e6\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"5722b307eae0765d\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"684d7e25797b7a3b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"05ea4812d0c77db0\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"7d78a9f4766355b3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"0075500ce26e6d59\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"b3cf45619dbf1870\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"3bb80be6cbd04831\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"67b85f194a8e310b\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"2faadd0c6d82fbd2\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"4dc1d4491e20b9fb\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"91e34bb378e71ab8\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"779d030b2748077c\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"da73751ca8c6697b\",\"/knowledge-medium/src/plugins/tables/index.js\":\"e761c69e6d6917c4\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"bfb08765101971f8\",\"/knowledge-medium/src/plugins/tables/model.js\":\"583d1daedbc9a40b\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"c99ee22e2780601e\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"b1eb271f9b347e5a\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"0e29113eaa56b35e\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"f0fea58e1a90089c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"779beb506a3e6bb9\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"8259d1827fdb0f6a\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"e6bb1b7721bd379b\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"abd06325ac980a9b\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"d5af91f3daada6f5\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"3e06095eab06940e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"8534ccec82804e52\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"173b6f0e6f6ae494\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"60a2378574cd1b1c\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"6b09eb415dd9de76\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"e145894e9acd6f9c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"13050429ecd29483\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"5d87339121df9739\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"80c3faa388848d2e\",\"/knowledge-medium/src/plugins/todo/index.js\":\"8b927532d6cca3dd\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"dd3f10f75ee6483f\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"03fbdb71c67ff260\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"243684951f89290e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"b9425b02caa80b43\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a5d1ed9c9a13e0a7\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"6688479d38a3c1b6\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"16918a6542fd1ef0\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"6672405acc1265e1\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"09f40261c777110c\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"fbac1739448a0036\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"0295459ea9850624\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"4c0e7779d5992830\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f63092ecf516bb8b\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"c7dc968d09b22a29\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"bb5f74cc20522576\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"80fb79be2d8f2539\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"eec5d4656e245ad0\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"4e46b89f125261d5\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"de104c09333bc954\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"c5c2e538cd46d6d5\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"244aee4b1dac83b4\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"4d387c680d6795b7\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"1eb692bcf8ce205a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"ed9aff5154c8c6a3\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"11d7c647931381ea\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"c4d131cc35867b83\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"8a9c1f7ae706bf6a\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"0b5fcc576d30bd33\",\"/knowledge-medium/src/registerServiceWorker.js\":\"e4b195c0be31a357\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"6708f84bca7df014\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d0c88d42b8e72d15\",\"/knowledge-medium/src/services/authStorage.js\":\"b19feb229f3b08c3\",\"/knowledge-medium/src/services/powersync.js\":\"ece344e596727b6e\",\"/knowledge-medium/src/services/supabase.js\":\"f3f590d469b8a3ff\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"34f8fe54eaf4f92e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"54dad896f459a382\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"7d5fb02895d4eed9\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"44fdfc7444779ad5\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"696211f02b027ca8\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"d9089a9b5d72455f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"af1e4b5f745aa5fc\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"6d221737d785c33e\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5e785597832d38d2\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"662f4d1876c7db6e\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"a7021a41cad2f639\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"ed2149a0365ca1e3\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"585e5e8a875d4658\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"5641dcb6f8edccda\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"3eab47cfae5707a1\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"9655081ff8579dad\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"6f550eb4a6e8bd13\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"e2a4a05649db1e2c\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6c453b7a1d29c3e0\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"6fc5ba5e3bf63877\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"63614609585e6518\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"29aefd766e84ed2c\",\"/knowledge-medium/src/shortcuts/types.js\":\"5a429825aeb1b599\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"e3766114eba521f3\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"3e620272b935081a\",\"/knowledge-medium/src/shortcuts/utils.js\":\"5c8edd3af5e1fff8\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"94b85df373428ce6\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"f55b088e076eba92\",\"/knowledge-medium/src/sync/byteTransform.js\":\"315e2a53c89a5b89\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"2741f2f0b482ab77\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"9db346e61e7f4ee2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"8715651f086b530d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"6e2068fa14a38409\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"788ff7ae0b0b0623\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"fa120f7d980bdb37\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"ce5c3c2d8abc11b6\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"5979aa13212c0776\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"45c573eb93baaf89\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"cb58f5c3fa32a3bf\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"40581271ecb1c7e9\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d09b70e0ded8fed5\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"3af116e0572f26a6\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"63f4f58cd6882661\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"c592c4efba5b2a39\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"26aaacf79143e612\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"7e3eb25559504460\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"72ab527bde0fd1c3\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5339e55d373d8c58\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"d07cfaa523965c7e\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"75a6b909a84b07df\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"941d7740a16045db\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"9b0e8387c61f1ddc\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"72a8f0ca9452e2c5\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"11cc6de6cea4802c\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"d7a7e3b696f1d53e\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"695974ec346eabec\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"8a85d3640047f983\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"99f8cdc6aef18ca3\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"bc14ef51a709940e\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"6b9250d93a20c2b3\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"dd3f33dce1be5ee1\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e6372bea5d7ec056\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6da8970b05f8b8c3\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"6b2fec8e1e742b36\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"26aaab8de4de3a35\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7364d37a741c9dd4\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"1992f7b9717f78e1\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6b360a74c41c06eb\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3876d36e58496107\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"da1e7319a72c7525\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"f7cf1e84e713ee3d\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e4b4979255741b43\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"a7c28228a1a0ff6d\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"22ba10c0bd71a378\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"df02ee7648c20360\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"bca2792f4162ad36\",\"/knowledge-medium/src/sync/transform.js\":\"bef1b3aec871ed96\",\"/knowledge-medium/src/themeBootDefaults.js\":\"23c31ef0bf60895b\",\"/knowledge-medium/src/types.js\":\"e45230ff30a6035e\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"d3e9c4bedae2033a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"b49cd2c0d1f24373\",\"/knowledge-medium/src/utils/array.js\":\"c5d0601dc1c43ba6\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"61dac523e1ccf5e6\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"be4596b64844d78a\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"41fdcd638d4abb21\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"3d8e7d65c27ff082\",\"/knowledge-medium/src/utils/callbackSet.js\":\"6e10b82a843cd2ee\",\"/knowledge-medium/src/utils/clientId.js\":\"db134c888714cdce\",\"/knowledge-medium/src/utils/codemirror.js\":\"86e15f5877eb081a\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"b93df7ce1029d10e\",\"/knowledge-medium/src/utils/copy.js\":\"36e6d0c9f79ed0cf\",\"/knowledge-medium/src/utils/dailyPage.js\":\"41cbdd1aed59bcf8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"6a10188cf2cffc18\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"37a0faf2addc958b\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"b3ff0b0a086df64b\",\"/knowledge-medium/src/utils/dialogs.js\":\"68ee0948eda666b9\",\"/knowledge-medium/src/utils/dom.js\":\"2dd4bd10171e482a\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"5fad4f2f612828f6\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"0dac932083319682\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"d029377e5eadb6c5\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"df80bc14f1a98c2f\",\"/knowledge-medium/src/utils/flipSlide.js\":\"630c3c0759ac6b4e\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ae1ca7ad2fecff7c\",\"/knowledge-medium/src/utils/formatBytes.js\":\"2a9f33b546bba527\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"fb7c62de3ce68f81\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"1a770ccaf916e9e6\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"e9658d849373b92c\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"694d2f57830d87be\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"c2973bda9601c2f4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"335d556f4231ee53\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"459ea3b787407709\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"286f9feb6f09cc9f\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"34481a92695dbdf9\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e98c99ab43ef0ed0\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"38f6c4f2cc271e20\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"f99a5ac9cb8840f6\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"f077fefa9b1c96d1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"52cac8b6d4e03a2f\",\"/knowledge-medium/src/utils/memoize.js\":\"1b333d924c4586e6\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"a8c136169c239960\",\"/knowledge-medium/src/utils/nameList.js\":\"e52bf9ee10c60ebc\",\"/knowledge-medium/src/utils/navigation.js\":\"72064fd11a530fec\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"9d53b95704944151\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"5bff524c4a84bb87\",\"/knowledge-medium/src/utils/panelClearance.js\":\"631a0048782bd830\",\"/knowledge-medium/src/utils/panelHistory.js\":\"f03d5cd02df58304\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c43c743390e9e5c3\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1215aa512978b0aa\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d7d4d18afaa5b657\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"8db3989d6b3b4da6\",\"/knowledge-medium/src/utils/platform.js\":\"f236cbfc4d68e768\",\"/knowledge-medium/src/utils/pluralize.js\":\"fd484692dc11a7b1\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"48c216b219fc995f\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"137517439e92a528\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"4d7518cc4c777477\",\"/knowledge-medium/src/utils/react.js\":\"904dfbf152b9eef2\",\"/knowledge-medium/src/utils/relativeDate.js\":\"294f479c16be281b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"e6cf5a27b9cf2638\",\"/knowledge-medium/src/utils/renderScope.js\":\"2fa75b6bbc1b7250\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"6901bba6d269e75f\",\"/knowledge-medium/src/utils/routing.js\":\"3a0ac790d7c32402\",\"/knowledge-medium/src/utils/safeMode.js\":\"321fe799552eafa7\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"d020cadc4dbc7e9b\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"39e58d3943e47fbe\",\"/knowledge-medium/src/utils/selection.js\":\"33f78202e95fd4e6\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"e0fc3df65ee27fe8\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"c41eaa3a74149030\",\"/knowledge-medium/src/utils/state.js\":\"6f43c855b0b73352\",\"/knowledge-medium/src/utils/string.js\":\"807be09a294ba90d\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"7df01aa97ebfbf49\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"1fc3267162c9efff\",\"/knowledge-medium/src/utils/toast.js\":\"dded6e545fbc28f1\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8d9694f9c81bd74d\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"93cb981c2cb82d2c\",\"/knowledge-medium/src/utils/userActivity.js\":\"1bfdcaba6db05717\",\"/knowledge-medium/src/utils/viewTransition.js\":\"71a9520223b58ca5\",\"/knowledge-medium/src/utils/viewport.js\":\"d2571ec481e54214\",\"/knowledge-medium/src/utils/webLock.js\":\"2b15e39bebf1cf65\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"53d49631bb1aad84\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"0ab92bcf7c2965b7\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"d847ce75f09ca180\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"bc9ac319761266f0\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"e4038ddb703db92d\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d6cd59bcfda539ad\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"c0f57eaa7e2b04a8\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"65b19d008074904a\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"50fa48249859641f\",\"/knowledge-medium/src/vendor/react-dom.js\":\"5872ce497baba01c\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"a86bc1248706ca3e\",\"/knowledge-medium/src/vendor/react.js\":\"8a89e22c1c95df4c\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
