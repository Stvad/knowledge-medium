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
		buildId: "cf6def42a0bf-d46a9c43",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"223a8ed5da16d1a8\",\"/knowledge-medium/index.html\":\"223a8ed5da16d1a8\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DeOMtgw0.js\":\"48bff76b62b589c4\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"41a8992e8b96f12a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BSQPffGM.js\":\"fd764f54a09f21ab\",\"/knowledge-medium/chunks/FacadeVFS-iizdrj0s.js\":\"6c5622aa611fb556\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DWkW238m.js\":\"9dccf8c700cf014c\",\"/knowledge-medium/chunks/MemoryVFS-Dew82TCE.js\":\"ee2ece6d7ab5ff30\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DWaHaFFf.js\":\"5a6a45d23b668568\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BfuVxRw-.js\":\"3dc5740cc46905b7\",\"/knowledge-medium/chunks/Preview-VgNkq-FQ.js\":\"0c92841fe27cd46c\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DGCrIC_W.js\":\"19205610e5e1220a\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C_u3a9VF.js\":\"7448d90891cc0f85\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BQV4f0_V.js\":\"361e9b1eb6438690\",\"/knowledge-medium/chunks/react-Br-UElDR.js\":\"f782e78f1e4cf611\",\"/knowledge-medium/chunks/react-C3K2rwve.js\":\"49bcf785de01c201\",\"/knowledge-medium/chunks/react-CGoFz0uS.js\":\"535d75afa7014ad9\",\"/knowledge-medium/chunks/react-Cx-LAorO.js\":\"f440f043dfe02957\",\"/knowledge-medium/chunks/react-D0tANCHr.js\":\"9895391c575333a6\",\"/knowledge-medium/chunks/react-DuVaIK8K.js\":\"b05ef10d4f918a4c\",\"/knowledge-medium/chunks/react-McllvwU7.js\":\"d0d05f7e5a53a34e\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Ura_37TO.js\":\"cbc94a6e1dfc077c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-tbnBYyL_.js\":\"96505924725a8760\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CGPlIeey.js\":\"d5b625f6ab677197\",\"/knowledge-medium/chunks/server.browser-5WA17M2R.js\":\"cd24cc81c6b5dbd8\",\"/knowledge-medium/chunks/textarea-DBdEUcrO.js\":\"01ac59a7fd87f765\",\"/knowledge-medium/chunks/ui-DJdgJk5_.js\":\"9c24ee0e4f36ffd4\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"f6e4b1df67206aa2\",\"/knowledge-medium/src/appUpdate.js\":\"eeee0086ae2a8dda\",\"/knowledge-medium/src/appVersion.js\":\"098af856c5c9a55e\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"18b0ccb930b8424e\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"55469fca03f64564\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"9f97676e932502c7\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"d16bc5715664225b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6eb4c87d5869d9bf\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"9456359265570650\",\"/knowledge-medium/src/components/BlockEditor.js\":\"e95134f25b325db2\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"5d2ebeb4f91dcf61\",\"/knowledge-medium/src/components/BlockProperties.js\":\"cf565a91124c2350\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"77cdbdf2a40b7a63\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"d86d868da0f4be83\",\"/knowledge-medium/src/components/DividerHandle.js\":\"cf6ee75dfd81820c\",\"/knowledge-medium/src/components/DraftEditor.js\":\"9663f2bbb1983a23\",\"/knowledge-medium/src/components/GutterPill.js\":\"d369cd527b152e61\",\"/knowledge-medium/src/components/Header.js\":\"1e3623100be2f169\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"0256c207ede19c81\",\"/knowledge-medium/src/components/Login.js\":\"b90226cfbf8a22ae\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"51c26095fe7276dc\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"28c0676b5394c7cc\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7fa8f2fe0770add3\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8a59369e6208a14a\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"768fa13111580400\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6f532915834cab3c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"51a8b594fe081d4d\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c1b7e93967fc3e27\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"40f93b7dbe5d5c59\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"f121c1f2d474685d\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"fa03f32c3b08a085\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"dd6676e600171c26\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"eb1a78141421d650\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"0674929dc5dffa91\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"ae608392d359c4e4\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"152e69c3e6899d4c\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"0209c8b876bd953d\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"fe30ad220af37ca1\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"bc0e2748b1827284\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"de6a044696f9d367\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"de872b8513518f72\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8ceb2a06028975b5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"27dd00d6b1b33905\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"94fc221eb3783ba0\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"c83d75fb80ab6fff\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"57486a21a919367c\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4f723b65c67fd37d\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"7a04b709ec86437d\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"d434a80070a46135\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"7f8bc16bb4484c6a\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"a89042d533a49461\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"4d236af1e8c3e8f0\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"dda81cff5330dc6a\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"86a96e09eade1422\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"6133f20055ac4430\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"8c67fa20bff844e3\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"ee16e4060090ff1f\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"8f2366e93d7e9986\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"5d45f342d6689a2b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"519a6c2c810fa7a7\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"4ffcd1ac1e8578fa\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f7695ce11f9f9bbb\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"b24a00d47e181d97\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"2fe74099a081934a\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ee167909b29e09ae\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"edc58de9750ee6be\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"e045d746b3006320\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3b5cf4dae22a4bed\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"ceb63f0963798b16\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"3d5198b472bb4f12\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"edc9ac651bdb0dfe\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"282259cbc03190c4\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"ad1e29113ec2e4a4\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"6feafda4986148bd\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"805f979837acd5c8\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"27df87ef68e471c9\",\"/knowledge-medium/src/components/ui/button.js\":\"4d4c47801c5053f3\",\"/knowledge-medium/src/components/ui/card.js\":\"8ca1d6512126f018\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"369d2b3b09b57caf\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"aa92e2573aa4bcc0\",\"/knowledge-medium/src/components/ui/command.js\":\"91ecad8fd76496f5\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"e52ee0dc40d3a850\",\"/knowledge-medium/src/components/ui/dialog.js\":\"7b06e6a111e3b170\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"ea72205566ff7e68\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"37886baec614870b\",\"/knowledge-medium/src/components/ui/index.js\":\"c25a76df42aa679a\",\"/knowledge-medium/src/components/ui/input.js\":\"1ce73e5feaa5fe28\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e6be21f07fb635a0\",\"/knowledge-medium/src/components/ui/label.js\":\"99190738a0620c9c\",\"/knowledge-medium/src/components/ui/textarea.js\":\"bfad81bad14f7e4d\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"ff28af64f6473d26\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f3f011cab24d32f5\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"d9cf228d2acb893e\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"49350fef64bab23f\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"318d00f7337626bf\",\"/knowledge-medium/src/components/util/error.js\":\"c6b37836879751dd\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2ca6768c0d65a45f\",\"/knowledge-medium/src/components/util/suspense.js\":\"a960c57ccfa6fb3d\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"862f53c4221794b4\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f6f36cd9ca29567d\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"645481afd01e1cb8\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"a8236d90d853b07b\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"24b896bf53befb2c\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"2c62170e75662012\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"864598df24f83b98\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"f2dcf0123958f9cb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"d8609eff28687675\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"0932efaf2306a3e4\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"069143de7fbf7483\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7ff3a004d0c8743b\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"270e1abd730e0ca2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"d9c9c97adb8255d0\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"32a74e8ca33a99e6\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"74543265581cbd92\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"ab2f0785c16a7b11\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"99d32b9fc6f3de40\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"8a49917cff79f672\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f9c2294e1f64733a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"154e21affb8322e3\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"423d3c6192713b14\",\"/knowledge-medium/src/context/block.js\":\"6da93e53408bf667\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"7890d884ea89bd1e\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"748754f65b4284bd\",\"/knowledge-medium/src/context/repo.js\":\"41f930615811bb30\",\"/knowledge-medium/src/data/aliasClaim.js\":\"7e013769a74e35ac\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"750c610a3a48c38d\",\"/knowledge-medium/src/data/api/blockData.js\":\"40670878ed4b24db\",\"/knowledge-medium/src/data/api/blockType.js\":\"45b4faeb61eeeb11\",\"/knowledge-medium/src/data/api/changeScope.js\":\"8fbb7ed14b522ae3\",\"/knowledge-medium/src/data/api/codecs.js\":\"300fdffdf99c75e2\",\"/knowledge-medium/src/data/api/derivedData.js\":\"becb323b0ffe44a4\",\"/knowledge-medium/src/data/api/errors.js\":\"7f4ca13dfa0b65f3\",\"/knowledge-medium/src/data/api/events.js\":\"bf234dd8d96dd705\",\"/knowledge-medium/src/data/api/handle.js\":\"bab6af95d3d01184\",\"/knowledge-medium/src/data/api/index.js\":\"2adb70a1399a268c\",\"/knowledge-medium/src/data/api/mutator.js\":\"b24242364dab4de3\",\"/knowledge-medium/src/data/api/processor.js\":\"5a07422b165bc238\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"527552ca21326042\",\"/knowledge-medium/src/data/api/query.js\":\"5ce832c3a18e59f7\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"8ac0c3b489319562\",\"/knowledge-medium/src/data/api/schema.js\":\"bab6af95d3d01184\",\"/knowledge-medium/src/data/api/tx.js\":\"bab6af95d3d01184\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"f47c3c6e1dabc229\",\"/knowledge-medium/src/data/api/user.js\":\"b6cbd5b62625e753\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"ddf5bd042abd5f42\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"15e3c88b9bf2cf2f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"897274b507daef42\",\"/knowledge-medium/src/data/block.js\":\"c99fc917d3629d1d\",\"/knowledge-medium/src/data/blockCache.js\":\"72b9d853f9b0df30\",\"/knowledge-medium/src/data/blockId.js\":\"5050630bac280468\",\"/knowledge-medium/src/data/blockLiveness.js\":\"6d9f2ccaae01bbc3\",\"/knowledge-medium/src/data/blockMerge.js\":\"7caaa2cbbb2a2ce9\",\"/knowledge-medium/src/data/blockSchema.js\":\"39ce0d4ca577e30e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"c5fdfbe36d4e8b25\",\"/knowledge-medium/src/data/blockTypes.js\":\"6fcec11df0fee5d6\",\"/knowledge-medium/src/data/clientContext.js\":\"61b9d964651304a7\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3d8673abbfe49a90\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"a725e99de9e7a77f\",\"/knowledge-medium/src/data/derivedIds.js\":\"ec0fae8b06efba20\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2a173bbad59ced24\",\"/knowledge-medium/src/data/facetBridge.js\":\"3e7ae8580b7f2830\",\"/knowledge-medium/src/data/facets.js\":\"3b5bf6ad13e76333\",\"/knowledge-medium/src/data/globalState.js\":\"2fb839bb282df6fa\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"806c904479648a89\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"7b732f312a6dc23a\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"4ba853404e49ff3a\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"05e0ef66b169f8c0\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"7a3d96e08882fa62\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"cd90267252f6cd6a\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"94a1d1a6914cb17c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"3791c3795dd272c6\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"ebb37d17f0fc6b8e\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"eeb8657c8d0b7d28\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"a8ca653969c623a4\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"6ae5f075b8bde07f\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"8fa078373781f1d0\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"f40798641ebed23e\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"fe608a48619a727a\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"6c309cdb99ef3f54\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"8c418f6b832baab2\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"0df7def380f61f28\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"4769bfa9dded183f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"7f41dd3734b6321b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"e519a9ed79cae5e0\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"91009cf0b7ad3e65\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"858db19b5361a42c\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"70293c2372dc12b0\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2407af387cad6529\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"dfaaec85c95f777f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"40b4aae13db21a4c\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"59653769b770d1c7\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"cda38cb51403676a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"d83f29a9b116a704\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"3bc9d1b18046e23b\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"81a7b5e9172f484a\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"82a28086806c507e\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"e07975439c78124c\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"317c5966d2a9e71c\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"afe1f233e0479d17\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4d3aab7ba5144519\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"84247d4552b1ad79\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f6ed24186511bcab\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"049566f68c7918bb\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"9ccac273ca1c78d4\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"aeb6716cba24242b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"9cc33733ec31ddf0\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"73e24cfb5dc09c25\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"72d7aa279617cd1e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"01e7a082ecf91150\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"639fd7be09ff9a7a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"76c23acb7059474a\",\"/knowledge-medium/src/data/invalidation.js\":\"9ce94fa934114e1b\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"45c3c7d6b090a7e7\",\"/knowledge-medium/src/data/kernelPage.js\":\"daccd936c205890d\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"ee0ae7683606df22\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"99ab2e28e76aa102\",\"/knowledge-medium/src/data/localDbStorage.js\":\"f83163af049135e8\",\"/knowledge-medium/src/data/localDbVfs.js\":\"e86ce509536ddd69\",\"/knowledge-medium/src/data/localSchema.js\":\"c9d1b6209c327ff4\",\"/knowledge-medium/src/data/maintenance.js\":\"2bd30f18880cfba8\",\"/knowledge-medium/src/data/mergeProperties.js\":\"770b171541ed0d57\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a7056c32d00f4bfd\",\"/knowledge-medium/src/data/migrationsPage.js\":\"d10513863e80c6a6\",\"/knowledge-medium/src/data/mutators.js\":\"f89f616b769e4291\",\"/knowledge-medium/src/data/orderKey.js\":\"e74b1c4c79a1ce1f\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"b1817588865dce5a\",\"/knowledge-medium/src/data/outlineSurface.js\":\"2ba678b23d54cdc2\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"1749d83694dfc559\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"69947ba37a4a801c\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"2ccb144a719740b7\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"165d6f8034b05c56\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d3b796951e8b494c\",\"/knowledge-medium/src/data/properties.js\":\"983cc4e90e63e5e5\",\"/knowledge-medium/src/data/propertiesPage.js\":\"499d3718af4e0565\",\"/knowledge-medium/src/data/propertyChildren.js\":\"84d6d297ced2cd99\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"cd3a370448dde109\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"47dcccf025396ce8\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"28019809e7810b02\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"3504748f9286a3fd\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"33d7429ada9d5af8\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"f87f02ef111396b2\",\"/knowledge-medium/src/data/propertySeeds.js\":\"ff729eb58163ac49\",\"/knowledge-medium/src/data/recentsPage.js\":\"487fbc07840dd4ad\",\"/knowledge-medium/src/data/referenceBlock.js\":\"2db2289db08fcf14\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"be504c0f4c39ff50\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"9f4529d55e0dcd9e\",\"/knowledge-medium/src/data/repo.js\":\"b5ba9914ddb80971\",\"/knowledge-medium/src/data/repoProvider.js\":\"2a8039ed885313ec\",\"/knowledge-medium/src/data/rowProperty.js\":\"22043bb5a4d6dbfe\",\"/knowledge-medium/src/data/searchFilter.js\":\"b6bbad84d90e26a7\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"04cba351b1d09026\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ddd07a079dfe697d\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"b8b7a522eb0ddf66\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"0c5fc78ea8ad965b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"5accd6141a139670\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"3bfdf5cd251a4fba\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"238675a81ed79109\",\"/knowledge-medium/src/data/targets.js\":\"644f85c82e9df6cc\",\"/knowledge-medium/src/data/typeColors.js\":\"c31cd0e8365e4b38\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"0654dbfc1803a441\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"55c630e8a10facbf\",\"/knowledge-medium/src/data/typeExtraction.js\":\"3ecd985f87775adb\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"857be0afb30fb9a3\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"21608e8acb64310c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"fcfffa52aecaf89b\",\"/knowledge-medium/src/data/typeTagger.js\":\"e70d1cef101d314e\",\"/knowledge-medium/src/data/typedRecords.js\":\"3071ed856d3b8870\",\"/knowledge-medium/src/data/typesPage.js\":\"8408f1e740dd5908\",\"/knowledge-medium/src/data/userPrefs.js\":\"69dc2c032c8df1af\",\"/knowledge-medium/src/data/userSchemasService.js\":\"369a6903090f9062\",\"/knowledge-medium/src/data/userTypesService.js\":\"4c54de33a69ce70d\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"9131978589892852\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b7050c7b9751c3d9\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"366ce8cbbb0311e9\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"791b908cffc36484\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"6b7ee3569751e7fe\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"4603727d4eeeb4ee\",\"/knowledge-medium/src/data/workspaces.js\":\"a81d7c9ad11bca69\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"fb10c39f64a6dd62\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"a4cd056d21eebb73\",\"/knowledge-medium/src/editor/atTrigger.js\":\"dfd7d741b99abb28\",\"/knowledge-medium/src/editor/autocomplete.js\":\"e618868cfae8f92a\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"3e2857573a9602d7\",\"/knowledge-medium/src/editor/contentFlush.js\":\"53bf39d7a6975615\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"87ccbfc3f734b2fd\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"d175c2f59c22c69d\",\"/knowledge-medium/src/editor/insertImage.js\":\"94dd2f24b4116159\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"b10f1b8b0a21fa68\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c966dc46776262d4\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"9cdb88086f6718a4\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"19b8163ab0e8601f\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"f354277f478d9e4c\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"3eba9455f1db20df\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"f964fed35af4a812\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"0744fc9119fcd641\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"13cb955294a246fc\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"e9d51937e03029ed\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"466004d02d5befb0\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"cba4043514a8f9a0\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"882d1ef7cb9d3786\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"7d15de07469f0644\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"81c2e8e94f3bbfdc\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"61be6917d33b1ca7\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2d36fe61b819dbad\",\"/knowledge-medium/src/extensions/core.js\":\"4fd0d60145a86942\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"4c3dfce1734f4068\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8cbd658e61b7f610\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"5ae506d94a107624\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"160468684d0824e3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"c5a14165704203a0\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"73b5f6cc8a12848d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"cc7c94f1a08bb2e1\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"6c73866c285570be\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"b2c24b8535e1e91f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"97db22fec16e84d1\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"60b626167282a25d\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"e29877b713ad52b5\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"1e11e39065014e00\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a1daa3adca3c6c18\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"375bb53a2a0a319a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"65f80e6d7c2afd36\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"9f16be6d973050ed\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"39cf5e40ed8d9eb8\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"7876b659c1258d86\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"1cc9e867be67da78\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"5747b76d2cb08a63\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"7f21e5c3d60cf975\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"ca7032ed55fac6aa\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"bdb7b09a9224705d\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a69ec3c653458524\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"8ea070daac05be61\",\"/knowledge-medium/src/facets/facet.js\":\"84429d2406d56ba2\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"22e35ef8339a81c6\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"d587904bda33633a\",\"/knowledge-medium/src/facets/togglable.js\":\"cd1a5f814902d634\",\"/knowledge-medium/src/facets/variantFacet.js\":\"1f05b1c902f30190\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ce5302c2c38a9945\",\"/knowledge-medium/src/hooks/block.js\":\"386e38544b94c222\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"865660c411a3c01e\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"e221fc380ed80fae\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a4cd1ffe4da9b0c6\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"9b7833236985fbc7\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"b5e3fa37c337f08b\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c6c6672e07cb4adf\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"29b5263a85cdd91c\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"5262a4d222fca7bd\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"d2cba13cc4a1c9d3\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"8a71009f054dff66\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"ca3b9887c180dc0c\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"b7928eaf0d33b996\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"5a090f3ef9b65d7a\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"cfbc56ea56141266\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"dd99d9b9be20e07d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"82e9454e2f7fb4c1\",\"/knowledge-medium/src/lib/utils.js\":\"e08401ed25280e53\",\"/knowledge-medium/src/main.js\":\"a663366152a2a8bf\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c8f54319a53d2511\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5002544c31503df5\",\"/knowledge-medium/src/markdown/context.js\":\"976a4d9bd80b1bb2\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3ff36690e7ff0d3a\",\"/knowledge-medium/src/markdown/extensions.js\":\"5ce78d061fe1f6c4\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"c77c3cbf64b70e78\",\"/knowledge-medium/src/minimal-editor.js\":\"68e30256f475bf7e\",\"/knowledge-medium/src/paste/armedCut.js\":\"2a667d823ea30cfd\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"809be41e7f4e03ce\",\"/knowledge-medium/src/paste/clipboard.js\":\"e5568d8e0968a638\",\"/knowledge-medium/src/paste/decision.js\":\"0272b8c09a94534a\",\"/knowledge-medium/src/paste/operations.js\":\"361f5f87a5931de6\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"5b9c7781f6dcd24e\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"2606d941fda1a346\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ffbffcafb305d70a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"6cd67819ba469837\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3296f8cd47de63f4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2eb0a1c74903b3cd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"2e2ac7e3b2eeed95\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c9b2336476f0e753\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"ad01ed3e5deef59d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e272c3b50d8ee0bc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"7570fc252ad8a670\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4a93cad51b10996f\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9df59b21dcc0242a\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"9a7948316a5e543b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"205af14a8a315969\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"65e873d50fde3b0c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"1aa68fc03c4f7b9b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"06314b1f7de47d16\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"8d9c3f9d3b3dfc30\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"d476b2098cd9b79b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0d33b7af45647c6e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"b4fe257f5b9aceac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f212bac8b28cde99\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"058769a2e2d2aa82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"25fd30e434162075\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8a9dfeb24ff07cf4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"02f34e061426b385\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"95754a42fe61dd76\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"c9ddb3303b19662b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2768e783391f457b\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"8d6bad1fa75d294d\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"14231a573583cf64\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"178caaf8e8223d07\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"dee14119590c686f\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"982ed6f09fbd9d59\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"65f4c82cc8b7ea58\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"1ccb7b078b6f1de0\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"98927073c999d671\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b20ad50ad7205cee\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"c7f3c5b6f7a9def7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"2e16af1f800df1a4\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"367834dffbd082ee\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"c0945fa087b6e9ef\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c558a9a83734f9b0\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"f0caacfa76feac7d\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"5db4d8a47e10ac95\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"a505ed6f50f8cf3a\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"9eb9acf65251b437\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"04785f0df1ed0194\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"3affd197d8f3b185\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"f2e289d1c7d85800\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"f48492a397ca42f6\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"0bdb042d9476f1b7\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c94a3c7d5a41b9f1\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"a2edc3dd2ec3f8bf\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"180aab9a3cf864a0\",\"/knowledge-medium/src/plugins/alias/index.js\":\"a27c567cab9f985c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"59f824620962411f\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"3c009e27ad4f442e\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1921ac8da9411f85\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"033628a5001cbde8\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"8ee90ca3024d3588\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"62ddabf2bdf5403a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"85a5fbadb998cd57\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"ed55869eb5f672c2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"0ebca661124f5356\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"c6aacb508bb9366f\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"17cbbe6cb300204a\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"76a82d5fefd0346b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"4c2aada3f3594bc8\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"8b475768e1247bd3\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"6220d123199e6908\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"041d5a2297594214\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"a26fd746e8473c7b\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d6b6e8df91dbafcf\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"fe8bddd8a639ceae\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"e06e9a2702b78468\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"19675283ba4065d4\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"682b6b1d00f91db2\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"5c119166a4faf811\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"f3624a574eed95ca\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"048e5f893ea7bc23\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"794920d75eeb6387\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"c493ef178941c82d\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c7d05ed79bb54ee2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"fb5205dca38e80b8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"99a3f5e8be628581\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"535b5a865289f3fa\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"e2f27ba4125cdf9b\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"03f4ff9529c0094d\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"dd1547c01e169acf\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"39f3c4cd65243c9b\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d810cead3c85d268\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"6323fd194534bb7c\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"277a7bd6e7539c71\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"b275b6c7e313bd4a\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"0e9b4cf0aeea150e\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"0a6741bb23e29d41\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"6ae6a79adbe63289\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"c72202d7b860c810\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"39abd92087d623a3\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"39f12b58ffffbc5a\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"6219b4cee1b0575a\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"b8d48e3da27f93c9\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"86dd267ac6b4eef1\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f40deea32afd9301\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"804680ba25cfb0f6\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"a8698f580bc7b35b\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"c14b0dada11dc3c1\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"61f230051254b4a7\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"92b84ced757d4169\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e7af6855f27d6ff3\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ecd27a85f266d51a\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"bdf32ad31cd5812e\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"c8069cadfee903c8\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"2dea9a1e95e5d24c\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"8d24554dae2036b3\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"b91aa2f577b00640\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c83e9912884d52dc\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"2d4721c6c131615e\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"a84a36b6d3ddec0e\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"7cdfdcde343452c1\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"96fa34959204c9c0\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"414232887f05f72a\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e2126b4d0727f221\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"67db370dfae265c8\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d700e972fa2e4575\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"c348b1474332f433\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"574739039b690576\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"117297e0ec2d573f\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"c9a468a5f41fd547\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"3b11b209e4186451\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"72ad734b91a395bd\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"70a2301c897c51d9\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"f390d70f77481f89\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"75de753bcdd064f1\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"75d37f92068bf758\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6a9397912a843667\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a351a124afae88fe\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"70f623c4f8138783\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"60406cfdb8dab4bc\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"46c9baa97392957f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ed77a2b681f3e5d1\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"83a43bcb59834335\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"5c08866040d9f385\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"9428971b833fa927\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3211d299d08c8aa2\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"84bfe4ddbe844d9a\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"5ea0dcba482704e0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"2a564b80da265bf7\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"33531659b267d530\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"38428f937c86c4bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"937acac7792cd998\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"bf1f28747b35c426\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"32d9e9df8a3780bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7cbfafd519e4d2e9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d56893f0ca673719\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ea6f9200d307c3d7\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"da61d44e11260374\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"a1d14c276360803e\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"46c0179a1fef1914\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"3a86063d15667398\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"346f7bf54b881ed4\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"077a2647c6215e89\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"44ef7a27fbedf6cd\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"a79d894a68e828de\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2bc94ed334ce8fd7\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"b7fb07afee8184b2\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a6546641c5558e9f\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"7648f83b74aad360\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e004b8c10d6c7726\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"269b807874f5d82b\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"858746f7705f6a0d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a77c919d19577342\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"e8ba60cb366bdeae\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"27ccf69e00a9c3c5\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"abd01b5a7968d755\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"7d085023f442f107\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"1279735b365d5ac5\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"bb70c1d6e5e6b1ad\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"54ca4784325b6a63\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"36f93ba0eea583eb\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ec05239e7be96088\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"0ae80b2051163ea0\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7e84792f7cca1578\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b4e956afe778296f\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"bef74caae2ac9f2c\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"00ac484be35bb02f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1884a5e341b6f192\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1951c6063bcc1310\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"883c635623717fa9\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"65aacf3641215e6b\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8c38a9b682a8545b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"737007c5617be47c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"016f141562a84639\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"39bea3bafb107c40\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"253141252c565221\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"04852996eb581ea2\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"adae50f4888b0ad6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"0f3ef8afb09f1899\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"22ba82b286195768\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"301fbe00a4fefd8a\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"abe9fb7957cc4c73\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"e0ee25303bbf2d86\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"0f86a6c49b1f9e19\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f3e3a95af4fc6d70\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"993c1931d1a4201b\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"e27e07f5f5d5afc5\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b69906cb47b2602e\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"0b407b3c5ad053de\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"de55cee21db7a045\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"b431862c68050faa\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"4b15482d2d9132ba\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d0a850fb24f4a43c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9f1625e172ea13c3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ef3b6cb65208ebc1\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"836e2c19bfea1e72\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"42e9bf2dc23152f0\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"383d07460fb4c170\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"da1c72d3f07682ac\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"65847c26e87a05b1\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ea3c56ad67fcb08d\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"13b032e45a316c83\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1a3a14586f10638f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"da1b27710c3bce68\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"e668eca7be4ded16\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"99a89bb38cd306e1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"6b222944c1bff7b0\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"efb0555db3f0c311\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"3a6dcd8e628afcb1\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4043cf0ba07e97fa\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a8da3fa21ab6b661\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"ffad573c26deb39f\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"376c92ef1342238a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"0034ce2376f4ea0c\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"155206fc95201eb2\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"7724f44f6c22b5a4\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"744af62c7a1ea7d4\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"b7e020541f91606f\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"dd052a2c5d12f2a5\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"232056662f59f446\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"6d3d4549bf8a85b0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"bc8546a73c7b9dba\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"00b085501de213ff\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7b75c7b54c2bf8a9\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"cc99c92e498e1643\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"6e97d711b18c6019\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"5cb9982a77756e21\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"8fd1c46ec0cf4313\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2f5d3c228a3c2eb3\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"5405f1b254a2d6b8\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"42723b85e8c4cc9e\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"1020e723074d8981\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"f1474aeef04d7c6b\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"7985076d82f686d4\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"1e58ea6b682517cd\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4a770551865d8695\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f7577d253f36632e\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"63e016cf691a3320\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"2ab882ad9d21423c\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"edc86f272d74d501\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8e0e60493df91d86\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2ca4f01cf8d3d4d1\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"711d3ea1d7e69a21\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"18104d289d5ce5ad\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f253c191f7d89da9\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"d8825e0ab7c43dc0\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"18f202d9b9527ea8\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"37e54981883a3b3f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"d12334f1266673a6\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"c3aba45d3a8c8cba\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"f315b7d031564479\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"db40112ed5662ea7\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"0ab31c05f8cc8a15\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"f574727b947a5294\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"af763c70c2071e65\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"7c9eda1a84d94806\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"f64032cc9bf7969d\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"12abfea98df3e882\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"551c6dcf7b44f83c\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"8ef156ef4e32c1b0\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9cbb12dd13750b0b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"289ad0b88e51a962\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"ac17d9624e0274ce\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"868ef3f278188755\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"fd63f37a6c518537\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"b740a0f2e232e1fe\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"fe90cb0fe6006c8d\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"1509974e3ef530c4\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"b2f6b40d9808273e\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"0ce6a5a36c19402b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"4772d2eebae2f891\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9b724d8e727c8a92\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d2a036b4030809c0\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6a21c56327fb9ea9\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"16e1597761da3eef\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"78efa7cbe9300faf\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"5cb9bceff08f6614\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"c65068d493b2ee6d\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"24c6197a0839c0b3\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"8f27ea0feb23a7a5\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"ace0a38c06a14545\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ce25ca47a3f92cc4\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"de435639a78454b2\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"50020b06b244e375\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"e779490f885052eb\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"d0a9b1aecb335d0d\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"edfff8b5e822f8d6\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b156e47bc6e1322e\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"4e36f608cde2ef1b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"482c57128d028823\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"988165a1f9e6fab6\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"6a2b29d4e8069c26\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"feecda9700e34004\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"0815ce595470287a\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"c784a2fa51c355de\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"00d01da0863ae0af\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"a7a3755a28d02245\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"717f932be9f1be4f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"af1616fee809a303\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"a24a8df24200b8ae\",\"/knowledge-medium/src/plugins/geo/index.js\":\"ce21c2dd6b34842c\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"6ccbeed8e21a8a1a\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"180fd3e2ff91ba4b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"18e8b6dd3f36ff8f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"b4a2fd82dcc55071\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"a2921ef501fd76ab\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"d1d1474fa0392aeb\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"47353c38ee52056f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"22dd991043460d2b\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"aaf8cb483d3c94d3\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7deda8c855c3d458\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ce8367c4cc013b33\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5165210c91a9af7f\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"d85e4d7fd8ae48a0\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"53b9e05cb86eb755\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"ae36e6f8c006f5f7\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"711957267920d457\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"3ebb35ceb12704f9\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0965b59231df8730\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"be76633e5229959e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"c951258ec6b98f3f\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"80ed9681a50926b9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3c10520504ead70c\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"2f39e4903f4ef336\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"69af7fa78bba6f48\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"a5d7fc6af958686e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"bcd682bcb8014ba5\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"b7f70d68cb176245\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b96ba449b7c9ef21\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"33d37a0853901382\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"7eedb0eaff3e7084\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"829dc3ed474ddd48\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"da0e9d8a131e1c9d\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"21615c35e80782c2\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"b426899ff3d1cf1f\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"499210f95eadfff6\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"38de68cd395cf207\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"07133d6e2f1b8437\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"13f0ba53b05ece6c\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"10556d58964b1af4\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"4719972b7caee4b4\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"9c58695e8bd94a61\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0f8b17a9c52c3b97\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"46f94dcbfbd16008\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"cf7501eb83315eb6\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"4a87f68f09385c1a\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"0c85730d53407e3f\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"262ec3e2ef96c27c\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"4b065ffec052e596\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"d4a8b15a56db07c1\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"67bb059a0d4aa7d5\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8469e97217d8a02c\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"7b002d567e00c5ab\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"06b3f126471b2b77\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"0e75281d03f0f173\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5664df0e8a62d85b\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"95af1fcd2525d2bb\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"c02e3f85914f8473\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"807c12705f09772e\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"a342b7b82d8a5258\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"9d9669aad83e08e0\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"07c96eb9fb222044\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"df8deb8a9e52a1b1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f8a67fd230558009\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ea074b28c32a1e8e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2f5155097c70779a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9d886483bd54051c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"ac74b29dd0171893\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c254304b57e22987\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"59eed649ef0e0fbc\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2922df7ec9c38106\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e189defa281d4f2b\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"7a5c3f5fbeba4b34\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"becff202cb947e3a\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9a06ff4bc8697d8d\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"217c469776662370\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6f0e4ad32900b441\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"6f848c9f372fe008\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"e225eadc0e1640de\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"3011ee4934eccc9a\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"1f7acd196cbd213b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b49ab5a925b478bc\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"34b47c991238e2b5\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"717635695a7c1a76\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"73155f2db686e9a3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"b6bba3982b3393f7\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"f2bda16a3d9672ad\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"e2976bc624cde31c\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"3335e90e428a0727\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"42083d47f9c69836\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"64a81d6c3d4ce022\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"9ca5e13fb765f2a9\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"3f87e4c825ec95e7\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7bda571422d5023f\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"aba23b47a66444b4\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"fd4eee31541d00d2\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"1c66fbb313c6cb8f\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"35a727693cbaeb29\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"94e8cb8222cb41e5\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"2491c6ea9e732956\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"3ae6fddbe4dc653b\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"c2e73c4d12c88c40\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"a57d9ad8a808145b\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"24ecdc6fc776bdc8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"1c4ad181431d6557\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"a44004ac533ce7e5\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b03884e195b83baa\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"0cf9ff2c0ec63941\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"5e94b53708290c41\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"735708a82b33bb18\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"92edb7890e86933d\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"f2bcb764794600ad\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"4cf987e9397415c8\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"4579b341be50f2e5\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"7e706058a27fbc0e\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"b1ce73c1019e411d\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"bf91fd3457b72823\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"4599a255ab3fcba3\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"27533b974350549f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"7638c570aaff760d\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"8e1b7aeb5fc6599a\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"fbd291c06031098b\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"cc168a29eb610fec\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e5f578eb8d02a122\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"ffd58b3d1ae1bfc4\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"a4dd6b4faf546ed0\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"fbb338637f0df21a\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"c77dcb05b63600e3\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"4857c2894a011659\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7c63cd9d2df27802\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"1b64f5031109ab6d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"0bf856a16bd4ea9b\",\"/knowledge-medium/src/plugins/recents/target.js\":\"00be3c47069a91c6\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"6b349a58e4a38339\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"0e9c7e971cb3e407\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"6a2ce7a0fc0286ff\",\"/knowledge-medium/src/plugins/references/index.js\":\"c8aa1c2a01e3a6b3\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"861a8af7ebf2244f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"0dd14e21416b9962\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"0f99beb09aaa96ce\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"67501fccfaf4d6ad\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"318c533d2a2ac466\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"cfb57201a48e7923\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"f46208d9172ea4b8\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"62a1e0b165cfa3a7\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"81da4fd5f8d55b39\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"4777217d5a457f9d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a9057bd3f4e4c402\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b872c56420a2ee95\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"48839b4e1fbdea87\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"d560da762010c198\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"f0d8921549d4fdce\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"6ee757b83ec5960f\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"3ba287fba9db5c36\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"b06d6d1e1d5fa618\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"f2df407d594f4107\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f75750427724776d\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"b3e9e9da5ce4b175\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7fe57a10633862cf\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"ecea6001af1004d5\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"c1b9ed9ffccb036a\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"8d961ec15ce1b4e1\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"c3b0479b30a93baa\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"6a28dcd61eb151f8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"a5e4d953014bd948\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"45b00a5ff8dee690\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"afb3acaa91bf1cb1\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"55f8b6327123694d\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"303fc4297c3903ff\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"c79b1e6211f2db26\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"7a5df7a20a136153\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c701188330d87395\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"095a298fb8fbf257\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"aeb16506ee9de948\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"67a24ad840c8b948\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"1cdd62b207f9a645\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"418e144f9c29c6a8\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7f74f78c28ee003d\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"f48f9c1593b067bf\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"16d3693679d9aa2a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"41ed72f3ffb601e3\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"675b3c58994b42f1\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"7f6708820181c57c\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fb41c7fdcbeb2800\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"73a56aec54e63787\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"b928de3cdb9462f8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3ebfd036c638b4b2\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"32f848d4aa82a970\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7f2529867d6683a5\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"0db56cfda7bcb059\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"d933dcbc7499f219\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3346aebc033c5960\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d1db775b00042685\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"fd64f5b05e0462b6\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"66b4f2bee8aad8a8\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"72f9c2ef4a0d5f43\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"514b1df7dbb5bdd8\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"8e69c9f7344c965e\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1ea6ba32e486003c\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"81d18f37c0ba66fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"32e1081d2ce0394a\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8e1ffff3f6027271\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"42773d7f1f9a8675\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"c77737f633989641\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ddf28c79c4f3ca9e\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"19cbc87f1f06345e\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bf9f49a1f6ae212f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0d7aed13464a6ff5\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"5804405e60f12c66\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"10ad53eb735c5f4b\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"45466cc697d3a937\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"033b473dc60f3b42\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"7c9883c4c05c4d83\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"0e018f7ca5057994\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"9f1e5256e07ae338\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0e225a39d29a9ddc\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"954dab23745abd36\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"b861498ef7a3e275\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"61f790928ca4cd0c\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"175469c6a50f34a9\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"26368b5a953f1a57\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"c79c4f59d987b78f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"5113d1ee9c95d655\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"85af4b9c7b3c528d\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"bd1e8a1c3294be9e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"09c65689c8498e50\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"4c734010144ad584\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"fcd5a9ec1dfd50fa\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"eee236e1ce686733\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ba9c6570b0d46967\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"b77a25e738b6a5fd\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"3cb3264303242022\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c66b44885d59168e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"044bbf9456464829\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"e85ae123e132ef3e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"bac5e593298a0356\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"26668fac14426e32\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4fd605a71f1e428a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"a1f8c5d9aa942498\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8368f3a89f1ea0f1\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"73ab303fc6cb2b10\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"2006acfd99e67765\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"fb269f5d5684a35d\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"cf7068903df4c882\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b7fb55a6c53f54eb\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"5624775bb87fb6c2\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"093926a2d444ca0f\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"b00eee34166874f6\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"391f59618648ec20\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"2e13f2e84d47b728\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"ee70b2f478ab5bb9\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"5f56e3f8bdafb139\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"c491a1de3676ac3d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"d44116e753f226f5\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"e7803fd5b5abf728\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"7712b9006768301d\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"001b793ef913829d\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"1ec9f9e638c6735b\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"4471801c8752dc53\",\"/knowledge-medium/src/plugins/tables/index.js\":\"2a7b23e4be167f2b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"6fa69bc3738583ba\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b5a8c8ebd4e68d48\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"cb73d49b41d8e31e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"74214fa2136236c7\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"e44ab433b5cbb4ac\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"b6c2b5b84c49935a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d0b8d95de4c4814b\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"c1564335bf2f70ba\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"27ae444f9709a6fe\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d7df22d76809c561\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"94af1d0c7f643250\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2542dccb66d05d2e\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f55b5c389d25e04f\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e8b87ffecff3f4ac\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"696102981cca7f0b\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"8da2268683245980\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"bd2423b32be61b9a\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"ac9f356b8db2635e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"6865f2e17dc8dabd\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"f77d6178eccd5bee\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"fd685c7ab623cc44\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a002589bfd2ef251\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"fc378c8d6fed987c\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d7587a070d6f782a\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"261f521d136ab339\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"9ab507aaaf816dd6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"3014824a34864f20\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"c4eb62c9b71931f6\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"662e0b45cfdbd796\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"7d0f8af39586f16c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"193144be18e52dcb\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"61d6955a2499d091\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"33dd16178b9e12fa\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"b36191efda9144d9\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"721f1ba8423ee37f\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"b1229c49012a45d8\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"6bf56ad8893827aa\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"ee580e43137e12c9\",\"/knowledge-medium/src/registerServiceWorker.js\":\"fad97f775ddfa672\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"add2e7c6c51ec061\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"f23778867e06647c\",\"/knowledge-medium/src/services/authStorage.js\":\"f6f6f1b73560078a\",\"/knowledge-medium/src/services/powersync.js\":\"c37ec8ca4c63742d\",\"/knowledge-medium/src/services/supabase.js\":\"53315cf67e46968e\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"6fab8c1ce2d79a60\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"ea7d8be3e6a07c38\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"30c964b29e9ecd9a\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"4fa17637c6617ca9\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"3097ac6eb08007f3\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"07e9fa77bd78e68f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a714a82bc3983448\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"32324844eeafd3d5\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"abd05b952ec4a492\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"b44db8cd2d15bf5d\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"943f8dbc2972c910\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"9e57371b4a60d3f8\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"9687566ef36c2090\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"86b7a69d812b5651\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1730bd78f175e910\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"783665dc050b937c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"cd0bd5c846b7d578\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"68aab1f5ce8a3201\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"2125b2e72f8a5e7e\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"ed44a4e59cde8589\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"1d7e4652fa331331\",\"/knowledge-medium/src/shortcuts/types.js\":\"a44d135ec4671f35\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"35c63353491b3b33\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"2ff234d250a3cacc\",\"/knowledge-medium/src/shortcuts/utils.js\":\"12e81421e54b2029\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"28643540959c4359\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"c439994e381a1320\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d61a6735fc36ffe7\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"7a806036408cf4f8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"c0d64a656e25630d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"653d1780c676ddf2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"81042ecab57bfbdb\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"42a55ab2c0ed48d6\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"15b4688d167c99df\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5d89ecc7553c5d1a\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ef296317dfbfb231\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9df53165591f6b7d\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"a217849aa8b99d9b\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"35ff2b9163c43604\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"38c2041b29310293\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"0eefc420c3913b59\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"fbfd72859d911f45\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"91ca806b242f7977\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"f4268de54afe2dc7\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"a978b24bdb7c2b37\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"886928ee6a5f462c\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"cb72f631b77e85c8\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"dc232b071ae1597a\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"45ae0bd2bc7e093f\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"68f073d5378f0e41\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"332b1dcbd01586a4\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ad3a7846b1ade659\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"2359fc475be99fd9\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6d20e2381e2dd4b8\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"aac9b49f182175fb\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"84061eaeed7ae872\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"88bfa77470264009\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e677ea9cbb16e4aa\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"9e217f8804f80a93\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"88fe24ae260888d0\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"9d2d01269b17c5b4\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1a0ac90ff938b3d2\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"17086b3e75048cd6\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"da6143195480e2dc\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f007eae7abfda500\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"df311b68d3733f37\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2b94daadca3f9a2d\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"65712f0877e67c06\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"259d79bd58711c8e\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"92cb479e5e442d39\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"3fd29cf4e38323f2\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"a39e8e16393e4ea5\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"082e44e3b67d9b97\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"9c0fcd4d3e65f844\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"03deddce51b36a67\",\"/knowledge-medium/src/sync/transform.js\":\"ba4b0a47d5e9de66\",\"/knowledge-medium/src/themeBootDefaults.js\":\"e896db151711370b\",\"/knowledge-medium/src/types.js\":\"2692fac52fbd7286\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"1231e4b2f9d92a78\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"220c85c11489ea7b\",\"/knowledge-medium/src/utils/array.js\":\"02519a1b900470ea\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b850d673ab47d9db\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"b46fe0fa0bbc3edf\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"c2aaa724cba8526c\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"a1231dbe4d760aa8\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d25e7be8680cfc09\",\"/knowledge-medium/src/utils/clientId.js\":\"dc84a888f0fd2af3\",\"/knowledge-medium/src/utils/codemirror.js\":\"2e11efead86788be\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"b422c58dffa3216f\",\"/knowledge-medium/src/utils/copy.js\":\"ed0a82ef84f53079\",\"/knowledge-medium/src/utils/dailyPage.js\":\"6cf5ec3287faa5b7\",\"/knowledge-medium/src/utils/dbForensics.js\":\"103602f73906e076\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"f9b1ccec84d03bcd\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0e2fbf4797135354\",\"/knowledge-medium/src/utils/dialogs.js\":\"4a35a3f55eedccfd\",\"/knowledge-medium/src/utils/dom.js\":\"cc667f8d571fba78\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"c0bb8d287526dcdf\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"5738c734feab6b1d\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"bd17717fc2737930\",\"/knowledge-medium/src/utils/flipSlide.js\":\"928f69ad84f2d4d3\",\"/knowledge-medium/src/utils/fnv1a.js\":\"3985af8ddffdbfa2\",\"/knowledge-medium/src/utils/formatBytes.js\":\"47c8d2ab04fc54ad\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"36fd261fc21b7765\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"275a49c3777a1bda\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"1c5380788aabaec7\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"0fa01493f99c1ecc\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"877750cc867126d6\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"fee415723fb0909b\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"ffd395b874478ea6\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"80cea2f7d7293a26\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"6338c9a903421500\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"144e774e4f133346\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"3a2881d3ae769074\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"f7cd47449b45b1f2\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"0cdc6a0e031fcdd1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"35f8413b4745f3a5\",\"/knowledge-medium/src/utils/memoize.js\":\"32906403c6de80e2\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"07b9d5ad24c8631a\",\"/knowledge-medium/src/utils/nameList.js\":\"bb04b6018b6e3bd9\",\"/knowledge-medium/src/utils/navigation.js\":\"12d9cb67d9543b93\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"eebb75e6a78e005c\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"5f2ada9d31493d2a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"dd7d419c99fb829b\",\"/knowledge-medium/src/utils/panelHistory.js\":\"2846eff760084b90\",\"/knowledge-medium/src/utils/panelLanes.js\":\"d4fc4f29aff8bb06\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"3f4d0f7becc82fbf\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"aab84b2ec477e63c\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"171a6a5ca7e6b933\",\"/knowledge-medium/src/utils/platform.js\":\"4f32a3483f912546\",\"/knowledge-medium/src/utils/pluralize.js\":\"ed06217b3443822b\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"cdcd449ba0b5355a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"a124d219ea1a00b0\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"fe4e3a576483dc26\",\"/knowledge-medium/src/utils/react.js\":\"5f8df8d8f9b79d12\",\"/knowledge-medium/src/utils/relativeDate.js\":\"0b83317d3377b6cc\",\"/knowledge-medium/src/utils/relativeTime.js\":\"8968f2cfbb02a239\",\"/knowledge-medium/src/utils/renderScope.js\":\"753012c516a6b6d5\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"8729039bd0050e79\",\"/knowledge-medium/src/utils/routing.js\":\"d27d054dc169a686\",\"/knowledge-medium/src/utils/safeMode.js\":\"bbde352192a73c19\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"4ac93ac0e9c56967\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"9bf36ada21bd5baf\",\"/knowledge-medium/src/utils/selection.js\":\"e2d9661aca2ddcf6\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"80a023a8fd50e413\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"eeb0f0c42a37a1f9\",\"/knowledge-medium/src/utils/state.js\":\"6076eaf9f48e6f76\",\"/knowledge-medium/src/utils/string.js\":\"238ae05d91437a33\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"b6f9fb44c7914294\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"92ffd573a10bd57d\",\"/knowledge-medium/src/utils/toast.js\":\"eb740267368f5c01\",\"/knowledge-medium/src/utils/toggleStore.js\":\"fc1af8797cdad9b1\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"d89614c313873ce8\",\"/knowledge-medium/src/utils/userActivity.js\":\"d8a903440acb02a4\",\"/knowledge-medium/src/utils/viewTransition.js\":\"166bc2296bf71872\",\"/knowledge-medium/src/utils/viewport.js\":\"983e45bf5cdd0ee0\",\"/knowledge-medium/src/utils/webLock.js\":\"2c76211de3cba58d\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"c23d2713c70d39ca\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"cd68c29921cd1922\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"917c8996decb14f8\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"5f25c92658330b19\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"83e56ae8a1fdc87f\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"17a498e1e6da081b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"6851d46401d40697\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"0270cba72e95ef8a\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"e612ff80e29e5803\",\"/knowledge-medium/src/vendor/react-dom.js\":\"0ad3719bae6dc573\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6c15ba0a05e1500a\",\"/knowledge-medium/src/vendor/react.js\":\"6c5a57b4f47cb8f6\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
