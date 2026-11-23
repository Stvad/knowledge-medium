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
		buildId: "cc1c5eb5c2e0-cf8e4b33",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"88c6073eb39575cb\",\"/knowledge-medium/index.html\":\"88c6073eb39575cb\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CYZ5ccsU.js\":\"e45ff15fb4d77ce7\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"e71ab497389cb5b3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CttqnhFA.js\":\"938db6a388d088a4\",\"/knowledge-medium/chunks/FacadeVFS-CIZJ_qR_.js\":\"6b822968dc9d9eaa\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-k4fg8r_X.js\":\"2c5305c1f85d3979\",\"/knowledge-medium/chunks/MemoryVFS-BcekCdoQ.js\":\"fdf0696488aedbac\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DInjjObW.js\":\"37a6b18f6ccfbdc7\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DXUDtiyz.js\":\"6109281278136d3f\",\"/knowledge-medium/chunks/Preview-CvWoL3Xj.js\":\"f94f7665b891703a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-XtjKLX1b.js\":\"18bbb8e3aec853ab\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CIetPBvQ.js\":\"08ff02ae7576808e\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B-IQk_hV.js\":\"13fd53c1cd23dfca\",\"/knowledge-medium/chunks/react-B1eNnCmj.js\":\"f795bb64b14ca97e\",\"/knowledge-medium/chunks/react-BteSaUGc.js\":\"842f4bf82e2c0ea0\",\"/knowledge-medium/chunks/react-CciGY6z4.js\":\"b452c1a67f9802fe\",\"/knowledge-medium/chunks/react-DTYeMyL9.js\":\"daea993ddee8925d\",\"/knowledge-medium/chunks/react-DwASk-yQ.js\":\"8376a4d18866ad97\",\"/knowledge-medium/chunks/react-K3lP9tJn.js\":\"289d76fd92745dae\",\"/knowledge-medium/chunks/react-ZZDocWa8.js\":\"9ad6fbe18966112c\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CW5HQp_u.js\":\"d33963291495352b\",\"/knowledge-medium/chunks/react-dom-server.browser.production-B6l4_fdG.js\":\"af2f7b9e4cd02421\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DllNz7Zi.js\":\"5481cb3e09251b54\",\"/knowledge-medium/chunks/server.browser-CCB_unHa.js\":\"075477448059aeb4\",\"/knowledge-medium/chunks/textarea-gWk8l35O.js\":\"9368a40d3fa9b58e\",\"/knowledge-medium/chunks/ui-TtOzn0nq.js\":\"be3e6618477bb559\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"1acdf6d7f1e2d56d\",\"/knowledge-medium/src/appUpdate.js\":\"2efd8c667d00158c\",\"/knowledge-medium/src/appVersion.js\":\"4afd56fd07109dbc\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"f36592fddfbfd62e\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"4a4569b84d7123df\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"47362f60f1cbd8b3\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"0e9d5e22196defe3\",\"/knowledge-medium/src/components/BlockComponent.js\":\"cc716add0381b668\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"3946cecacf1e9301\",\"/knowledge-medium/src/components/BlockEditor.js\":\"a6339195e0d4ca16\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"b539e6dd4eab9183\",\"/knowledge-medium/src/components/BlockProperties.js\":\"6e6084cd30f98a60\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"d20423a876e87eec\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"2d7a73f62df0dd9b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"fcc6553220c045b8\",\"/knowledge-medium/src/components/DraftEditor.js\":\"28e4303fd30f4b1f\",\"/knowledge-medium/src/components/GutterPill.js\":\"118ac28a09aa510f\",\"/knowledge-medium/src/components/Header.js\":\"09e4b26ca0fd1268\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"e9b56d3279d07931\",\"/knowledge-medium/src/components/Login.js\":\"f1c41912e07fde58\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ad2c8b6831591aa1\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"203a83f1a5e34595\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0c0d84082a8237b6\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e74c50c4dfd4d746\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"7ce598cd297858f8\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"1ba71039ef1a17ac\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"a0054abe3c6b8738\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"3d21894acc5dcbca\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"12e7bc754ea7f5c1\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"16b91fd0570af8b4\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"aa4c8e43dbb2fb9c\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"bd231d27b34ee1be\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"d9e37b32b36c8579\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"78722b7f106e6d2e\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"03792e7248bea087\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"8ec982351d6e5ee2\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"ce39ef2676bee1d5\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"a7627814b0a1109d\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"7500819a38f3b4ee\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"291e645476b215d8\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"ba7bbbf839135357\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"52161f4ca74f6405\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4318b2879bb5f194\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6fc5267b34e49a90\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4172429b2b94ec5c\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"bd9532e243f297cd\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2a282b11f10bbd01\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"50356ba397b76e5b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"d2634736b759bbc3\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"e60a5efc18a86b26\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"3c2892ec1f257019\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"b05a40084e364553\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"00dc54cbd07e63ba\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"d37c3433a7dc9e1f\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"34b48fea1e262e6b\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"f9fdd4f2a4550306\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"29461bcd4987f1a6\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"e0a912c414c8c0bb\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"58588fb8ff60f29c\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fdd5395d77613f84\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"ffdc3762f5153607\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f87a43c0b3819a15\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"efa0fb13e4c5b719\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"5db99f9ccb94b034\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"914d46287ec56671\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"5eabcb32648c865d\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"c6ff482d9eee12be\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f5292ff42c9b685a\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"622d4d0ef5b1c801\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"c1d737d01ffcfb9d\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"303e7dbb4bf95f11\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"7bac7a98e8739e62\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"91f48e379859dfd0\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"2ca69a68959c9dfd\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"5ccb694bea9c615a\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"9bf27a552b030165\",\"/knowledge-medium/src/components/ui/button.js\":\"a78176ea3082358b\",\"/knowledge-medium/src/components/ui/card.js\":\"2ee6bee27d86ac08\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"96ed76f1253f65f5\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"960624ae737b67f5\",\"/knowledge-medium/src/components/ui/command.js\":\"bfa918c717a4e3c5\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"712fbd38470146b2\",\"/knowledge-medium/src/components/ui/dialog.js\":\"697623f89d8ee2ea\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"6b2f60327cf95f8f\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"cd0e448b963c801c\",\"/knowledge-medium/src/components/ui/index.js\":\"9ff51c3d680b9072\",\"/knowledge-medium/src/components/ui/input.js\":\"44534989b9c6e22e\",\"/knowledge-medium/src/components/ui/kbd.js\":\"6fb1ab853acb1bff\",\"/knowledge-medium/src/components/ui/label.js\":\"85bba8b91374a9dd\",\"/knowledge-medium/src/components/ui/textarea.js\":\"dd6ca6d970c124ae\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"683e9669072ec323\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f90abac18e2354d7\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"edd368c9ccb1d803\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"563ed85531363970\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"35def5d7d47cb565\",\"/knowledge-medium/src/components/util/error.js\":\"1b5ad92975fe4433\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"d02ffa5cab32a8d0\",\"/knowledge-medium/src/components/util/suspense.js\":\"fe719b65ee2fa072\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"4575dcd4031e4306\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"651383e0fd615dc6\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"07fd4ec63a632e0b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"ed4b43e853cbf45e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"30d6e7c6f887a095\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"2319acfe96be15e5\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"59609d4e2a3cdfce\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c6e1c520f1715d25\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"2354b03b9b8f9c6f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"24f7788d9a468d55\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"2cd6981617f8127c\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"eb4a97d802d138f7\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"aa4951ba8935e392\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"f763245c78ede8a1\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"21801203cd8cc1f0\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"6a57130e7742abf5\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e344bdd879af35a0\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"2800587e5344a2d2\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"e0719df7ce739fca\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"ae0a3ed37a2bad0a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"0d91f6ab4acded8b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"f0b6066b5dee7dd1\",\"/knowledge-medium/src/context/block.js\":\"fdf000345f7f4562\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"1e6ea05b6455d6f1\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"e3018399c587db9f\",\"/knowledge-medium/src/context/repo.js\":\"972c8dd57b044982\",\"/knowledge-medium/src/data/aliasClaim.js\":\"631995faeb66c8d6\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"cd87e8bdaa487bfa\",\"/knowledge-medium/src/data/api/blockData.js\":\"8f375d8c1ef54270\",\"/knowledge-medium/src/data/api/blockType.js\":\"5e9788c7bd579f75\",\"/knowledge-medium/src/data/api/changeScope.js\":\"3eabfd9f80f12299\",\"/knowledge-medium/src/data/api/codecs.js\":\"4183355dc288ea71\",\"/knowledge-medium/src/data/api/derivedData.js\":\"a8149ba6621455d7\",\"/knowledge-medium/src/data/api/errors.js\":\"af7cb9a383ac67ee\",\"/knowledge-medium/src/data/api/events.js\":\"527270cc5a2a4d07\",\"/knowledge-medium/src/data/api/handle.js\":\"2f45329a8e299e11\",\"/knowledge-medium/src/data/api/index.js\":\"aba88882b7b04e95\",\"/knowledge-medium/src/data/api/mutator.js\":\"52c2e9e3f4860c4b\",\"/knowledge-medium/src/data/api/processor.js\":\"8e0a245f8a0ef70a\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"e2575344ba0c9a24\",\"/knowledge-medium/src/data/api/query.js\":\"261021e1b7da9917\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"7f100fd5b440ecc3\",\"/knowledge-medium/src/data/api/schema.js\":\"2f45329a8e299e11\",\"/knowledge-medium/src/data/api/tx.js\":\"2f45329a8e299e11\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"08a67e05e2eea128\",\"/knowledge-medium/src/data/api/user.js\":\"cff1255d3a0455c7\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"83c3ed208fd5d315\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"dda8cdd6947e915a\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"2a162c860bf73494\",\"/knowledge-medium/src/data/block.js\":\"18d20ac39aa2cef9\",\"/knowledge-medium/src/data/blockCache.js\":\"85fd737228f4f12f\",\"/knowledge-medium/src/data/blockId.js\":\"7611209c8086b69b\",\"/knowledge-medium/src/data/blockLiveness.js\":\"74d51b127880832b\",\"/knowledge-medium/src/data/blockMerge.js\":\"240fa5b9a2d24177\",\"/knowledge-medium/src/data/blockSchema.js\":\"0c9a8454a75e83bd\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"0d79b1238bc1c7c3\",\"/knowledge-medium/src/data/blockTypes.js\":\"bbad217ad8617725\",\"/knowledge-medium/src/data/childrenView.js\":\"4c19afab33900cef\",\"/knowledge-medium/src/data/clientContext.js\":\"67ba35e5d5d02457\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3296879e2ab3fb8f\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"88b5a0745caa2be2\",\"/knowledge-medium/src/data/derivedIds.js\":\"5ae17fe57fc21cc1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"8e6b1349b601a550\",\"/knowledge-medium/src/data/facetBridge.js\":\"579eb3c128b697d7\",\"/knowledge-medium/src/data/facets.js\":\"af8f14f5d735a5be\",\"/knowledge-medium/src/data/globalState.js\":\"c2081b93c74f62f1\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"7abfc705b8dfb498\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"2478952b8cbfc9f6\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a9002911037ba405\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"37c58a48849038a6\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"2a6ee2b1a53ca69b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"0f445715878fbf6f\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"f3456f626b09c615\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"54e13ee99b319a1b\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"41e971ad42d635c9\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"8638fa24cac834f8\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"7f965a5955b19044\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"462e32e31cef2bb9\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"a34d9e1388829762\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"9fb90b8cdaac8090\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"4e3efacd98bc164e\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b08270c8c26044c3\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b17208d41c5a28db\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"68aeecef9a75eccb\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"039a107c75e79d87\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"f37115655bbdd5dd\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6e6e847e682cf41a\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"747f5a90b0437891\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"59c283468185c138\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"65ffd2d58e073ed3\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3ef5b268b343a5e7\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"19d29301258d8cb8\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c4b4d81f6174b651\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3e4828ad92323d88\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"e796fbd66de4ec8a\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"0fe2cae943b92e05\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"8d82f839aabc9794\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"d051c46ad4829fe5\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"86e27fdee7a4d5e6\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"3b7779f7310afc3a\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"7ad05ba6e4ee1150\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"c0c0f0f102f6439d\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b60ec3ae546177b6\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"772f893e0eea663f\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"719a2b74f4cc65a0\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3f6aa2ccf987fb2b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"79544c91afd96d21\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"7aa131b4470de9d2\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"ffdd163b5b4e4741\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"bfb95446718307b1\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"b9ea8c0004ce644e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"fd82e3f70f28b7f3\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"56d8fb7d4711cdd6\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"c5465653cb4651b5\",\"/knowledge-medium/src/data/invalidation.js\":\"f32a780e1f86dfbc\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1901a2d7d5ddbef4\",\"/knowledge-medium/src/data/kernelPage.js\":\"53f7dad598394908\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"43c6d063f00b5c8b\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"5616cd419a4eecb3\",\"/knowledge-medium/src/data/localDbStorage.js\":\"090b0261a7b21328\",\"/knowledge-medium/src/data/localDbVfs.js\":\"ba054965a8f5b853\",\"/knowledge-medium/src/data/localSchema.js\":\"47b82ab042f96791\",\"/knowledge-medium/src/data/maintenance.js\":\"2574c40cad76e827\",\"/knowledge-medium/src/data/mergeProperties.js\":\"817d8c5a1239490e\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"bed13a271c3e8d1f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"05e4e88505e1349e\",\"/knowledge-medium/src/data/mutators.js\":\"af85262d817d214c\",\"/knowledge-medium/src/data/orderKey.js\":\"724ec0f0ac84bc27\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"3e3f735ce7ad946d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"378319293318cb93\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"8dabe8109229438c\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"edcd90b48584228b\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"95158f202ef4cae1\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"84d7b6440867e9cb\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"1446b6896446469e\",\"/knowledge-medium/src/data/properties.js\":\"0497fc09c4aa7e2f\",\"/knowledge-medium/src/data/propertiesPage.js\":\"06d0a31e38086b82\",\"/knowledge-medium/src/data/propertyChildren.js\":\"486fd62c945cee09\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"a2f128efa2def1b3\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"b083a7d41ccb3bed\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"706f4c7130f496a3\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"ac32b909292b74dc\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"e4d8a4fc0c70a0b3\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d84f6a4f9a66a123\",\"/knowledge-medium/src/data/propertySeeds.js\":\"99b9d11210c7e9f7\",\"/knowledge-medium/src/data/recentsPage.js\":\"d901353bd7316585\",\"/knowledge-medium/src/data/referenceBlock.js\":\"dc873d43bf8c0722\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"25ccd53f83892be1\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"3f68171da88eaaf8\",\"/knowledge-medium/src/data/repo.js\":\"bf38883ad79ac7f4\",\"/knowledge-medium/src/data/repoProvider.js\":\"19c27361f2aacddc\",\"/knowledge-medium/src/data/rowProperty.js\":\"9bb7bbef69db60ff\",\"/knowledge-medium/src/data/searchFilter.js\":\"56e642b2ca8e43c3\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"4a7b45e5d857df9e\",\"/knowledge-medium/src/data/stateBlocks.js\":\"2c25fc9d8444bb44\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"28e7644ca5f8815b\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"83f0bf3870cec846\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3dc6b55d60099aa2\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"4490cda4496cf605\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"27ecc6ed0e177bea\",\"/knowledge-medium/src/data/targets.js\":\"f2c2b5ba025f491b\",\"/knowledge-medium/src/data/typeColors.js\":\"581c9f8d01b67833\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"85425b48f353bd41\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"f55f006a5fa4d999\",\"/knowledge-medium/src/data/typeExtraction.js\":\"d4d279e7e8e8946a\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1e30d8a15b3ea8b3\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"cee74fb745400053\",\"/knowledge-medium/src/data/typeSeeds.js\":\"d68d46230c057591\",\"/knowledge-medium/src/data/typeTagger.js\":\"e873c4ff1f628077\",\"/knowledge-medium/src/data/typedRecords.js\":\"f822e15e31b5b9b6\",\"/knowledge-medium/src/data/typesPage.js\":\"91b04a4e447c715e\",\"/knowledge-medium/src/data/userPrefs.js\":\"bdc90139ab365636\",\"/knowledge-medium/src/data/userSchemasService.js\":\"aa4326d4e5d6bd85\",\"/knowledge-medium/src/data/userTypesService.js\":\"9bc48470e6616604\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"59cc9cf4251060d0\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b3ba550b5d454825\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"0b933f97dfb89da2\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"925aacdc227bc802\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"9054a642e012436d\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"2418e1cf1903f696\",\"/knowledge-medium/src/data/workspaces.js\":\"fd5e59fd315f511c\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"343038075a32a2f0\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"a04ef8b0adf3c292\",\"/knowledge-medium/src/editor/atTrigger.js\":\"7c78fa606ae78417\",\"/knowledge-medium/src/editor/autocomplete.js\":\"03ead59d5bbeecbe\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"d904c0b12f790e1c\",\"/knowledge-medium/src/editor/contentFlush.js\":\"afc188d16e547235\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"742e79fc12e0ef25\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"89721ddbcb5762c8\",\"/knowledge-medium/src/editor/insertImage.js\":\"b0db1b678f81cd32\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"27eb408c2e8d54c7\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"73e4db1d32cbc00e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"c6a17b99df8b532b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"30a10d7c6601d25c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"71838c150b6f70c4\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"9d82b2ed8e4d595c\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"708756fea6a5f67b\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"56dce35bd3a8fdb3\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"9f305359c996b39d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"3e9f5a7b60e0ad79\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"2b8e535aed0d235f\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"64d60679b0385863\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"4f5c1a783e3909e9\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"8996513b44696af1\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"b88dc0f73d2944e4\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e663b2d4411c766a\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"b1543431b097a95c\",\"/knowledge-medium/src/extensions/core.js\":\"03c2fea5e7562b0b\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"74e39bf98e60f1d6\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ac34a160c6ea4a03\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"813665765ca2830f\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"df18882428c1da04\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"6e588dbce33aba7a\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e6c776c805875b3c\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"be4fb2ddd98fced8\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"80e2b782812ca8cf\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"cb9a60eaab9e37a4\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"4e61458c0f132fc6\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"966a62623c49b250\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"18108ca869e16d1a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"cac9526f6d73e7c6\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"ece73adc9e89bb22\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"752ff3db64da3bee\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"7747313608562522\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"65fd5f788a9f3f59\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"b5d45d2713e86400\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"8db4acfc7516059a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0e9c37daefedf909\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"80d2e3ca97f9aa58\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"8b33754456f2377d\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"aec05152995aeab1\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"d6b3548f41aaef2c\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a094be7fe714ecb0\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"d9bff06114acfe0e\",\"/knowledge-medium/src/facets/facet.js\":\"8e19b267fa973c29\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"4840b451ff3680d5\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"ee89605208129768\",\"/knowledge-medium/src/facets/togglable.js\":\"f694096aa9f14953\",\"/knowledge-medium/src/facets/variantFacet.js\":\"bd1b23db42186c40\",\"/knowledge-medium/src/facets/verbFacet.js\":\"54d7887ba23c6849\",\"/knowledge-medium/src/hooks/block.js\":\"783161e0448a15db\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"ab198d0e388e18dc\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"2d3ec0cb0cb3e4fb\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"0a01fc73aee245e8\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"871cbc1c4c4788c4\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"d7b27021a7b9195e\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"3a2f5050bf1bb9d6\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e52d9ee182a50ee8\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"78772d8f213d1bad\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"b4aabcceca2f6462\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0dcf97f3d1bf352e\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"0dd396d3802cbe72\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"b730ad36b16202fc\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"12cb8402013aefbd\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"0f5498606de2646c\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"2cc33a1b0379c6a0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"e187b49947822fe7\",\"/knowledge-medium/src/lib/utils.js\":\"61d57146e13d88c2\",\"/knowledge-medium/src/main.js\":\"a47caa95543a6c56\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"9921bb5f8dd82944\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"0334ba405a3f539d\",\"/knowledge-medium/src/markdown/context.js\":\"63ae8b38fc74ec3a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"db5a1333d4c50752\",\"/knowledge-medium/src/markdown/extensions.js\":\"dbab35335f797a5b\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"8fc730b5d7aa44da\",\"/knowledge-medium/src/minimal-editor.js\":\"d47b013eaa031af2\",\"/knowledge-medium/src/paste/armedCut.js\":\"ba80a6be8f471c91\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"3e57f04db3f14e5d\",\"/knowledge-medium/src/paste/clipboard.js\":\"6cc49a86624ca17f\",\"/knowledge-medium/src/paste/decision.js\":\"498e3bd316f92835\",\"/knowledge-medium/src/paste/operations.js\":\"498cb1f74a11dc67\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"9e2ed039b97de3f2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"fa3726cbe707b204\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"363f3a858d5fd3cc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"abada802cf44efa8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"04cf556efebc266a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5463cf9046bf501a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"58a089c0d0a13f03\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c1fe70aadbf113df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"b2a7d2b932f4bd4d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"166a2bdbe41c14e4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"a43bbede062eb8cd\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e9d339d3af5f0cb6\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"443393cc02855cf8\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"fb6cea430248e5b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7574f0ccc9b07f82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"2691eb3ccbfd16f4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"e168655007639ab1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d3f7b1db959294b8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"90b1bb093fb83059\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"f3a0f34851ccd6ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"09a02cc7b2b4782a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d779bf50b47ecf4c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ba386fb50483d1f4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8dbf0c1bc50642cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"0e35d51699b2ece4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6769546d07f5ea77\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"da63b2a86f9078c2\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"26c23ed670196c44\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"945a8fe79519f6c9\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"db8c786616fdda08\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"0180a193f3474196\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"646fe48f0f3cba14\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"e603fac4adcbfb9f\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"866fb45a784bd833\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"f5ca201b2cf93b25\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"ee2bebfe106dba39\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"61239bf99964dafa\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"bffcd8aebaed61ed\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"8434d717298a5ee2\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"bf63ba5ba385d1eb\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"7ff3399e53faa07c\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"95ea5b293eaa6dea\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"56b36f40bbc1b28f\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7b22fafc849abb38\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"22a166560324d689\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"08cd32b1f821eb35\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"c7200dd88afdc945\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"721fa836f6b36bbe\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"6dac595c0fe06e04\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"94a4e040148dc851\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"66ef2511055d5d72\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"c116ffb748d64d84\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"4b19a0abac8cfaa2\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"520cad28052cdc32\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"8e045b2135b9e770\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"296e27ddcc07dc59\",\"/knowledge-medium/src/plugins/alias/index.js\":\"3f71e3b6a6ded4f4\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"2525a965297eacf1\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"d5ba9606aec25c27\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"abed98ff80427594\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"41e1e3d2c9dccfeb\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"368af57c97ada82d\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"4f833ae9ba28c21c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7e4c7b28b056f771\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2ee2b91f5ec24018\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"8331d803324e13b5\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"59a261d34d7d8be7\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9769ad2534f025b4\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"0b3a102c5c7c453d\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"fe1eb3704bf27d2c\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"e1bb6e9214a1a45c\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"5e872ea1b558b899\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"6cd8b957971afc6f\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"68c6745c7e85e9ac\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"84b32f676f6ad37c\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"aad98276658bcad0\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"6199ab99751b2049\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"d16dc1dae3e8a73a\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"a6bca082809e001d\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"a8c69a172aa56084\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"acd7db8dedf85d3b\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"44e664fd2451e21a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"a994256a39e420ca\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"119fdc7aba506059\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"e4f5cf938657aef0\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"235d82c3fcc7d8d8\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b362a38c3ced5b0f\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"334982d863bec484\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"2a2ff779630d6d97\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"05241d4dc81529fd\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"744954c73800b26e\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"2f6c08682e92d598\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"045534c925fcdc17\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"5c915894d939da6c\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"dfe75918200851f5\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"01923c8210c30f2f\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3c548f36ffb52574\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"149f99fb8f7c04cd\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"318148ab3f577a59\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"6311703aeb2bdae4\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"1a0078460659da6b\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"cc43344d23887cbf\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"335f0a7acf6339ea\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"f258407b191a2112\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"604fe9b7bd8155a3\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"00b2eafeaef35154\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4953818b071a036e\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"5cf1059673058463\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"d3898f8e95714312\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"2cdd5970a026460b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"25b5239e0d274506\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"235ecba75861bd59\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4f21381f254a47c4\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"71c852b3923d6c1e\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"b612b7d598ba4c61\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"2d740555da0abc60\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"08de0d01b9441fc9\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"b3025c8295f18e51\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"82badb6634d5adb6\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"a8df8b5a9cd64b67\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"84098dfae99b3839\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"7f46c190740bace4\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"26451cb64d4934db\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"48ddcea0fac83dce\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ae66a4ffbc5dbb53\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"52e7ad51198f5893\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"ffb53bb68b4a30bf\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"28d63aabffdef3a8\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3b8b54b4b5137687\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"15d9b7eb32e92279\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"41f0cf91d3cf6199\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"d3f3b45592f11ddb\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"5eee4f2c5debfc53\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"902c64304dc649db\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"bf7037f5efd2c9c2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"11c54c4cd80e5542\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"5ecbf71d82d74e45\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"66eae3e2f6eca304\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"ece8c1e8174f1fcf\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f2ff076cba157fa6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"99eb43f39c417f34\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8291e1a29bf0b86d\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"e940dcc5f3bdc1bc\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"c864f5ac743dc51f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"4dad8d7eedeeec29\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cb3958628b1a1ee9\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"6f21549ccf99fde5\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"0be5bb71b040d714\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d041cf83eb91c812\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"f2520f9f8ac852ac\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"43f835f3e644e23f\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"398c374057d7e6c2\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"886004a47572bdf1\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"7f21713cae14ca43\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3006399f9f89564d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"daa1a8144d9328cb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"fb2461aa4334d9be\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"910fcce08080b971\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"ff91863f62c32a3b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fcad0ffb9581cf7e\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"26a732336494373f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"c43439734a8a8026\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"4e2a4d6066e71b67\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9f86e07068b57470\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2c8658ebdbc30d35\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"843f87b17f99ced9\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"a5966613d62ce0ca\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"027b53057c8837da\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7f80fe190ea5772f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"93ca26dc49803f05\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"c812189a1f51f29c\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"8af6f093ef7f6fcf\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"f2e56702ed400bd5\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"29a2f9f736b05a8c\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"9e1277eec96790a9\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"af80e9aec6942317\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"6daa8c95312563e4\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"d9097e3e4fd10011\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"9df326a2206621dd\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"72f130c10feeb577\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"596adb94a69b2f0e\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"87a75e53623399c2\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"bc5958a4cee7bb09\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"515059db83fdb551\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"7222cdc128ce73d5\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"d4bc02a71526d3d2\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"489f091af91e0e10\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"157a354fd5f5453b\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"74fca82114125f53\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"575f709db5ed41f8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a93b461a46f0bdf3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6584fc691ff62153\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b8db70a21fd43f4c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b192d0ffada3e576\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5892d4738a8a0720\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"9a96177194bbec95\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0bc1163e78618f90\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"bb2cbf145d1255b7\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"52e9cca91b1f8467\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"052197bb8f16e675\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3476bd23ad7d01a6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"3cbef10c5ca45eec\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"79d445550d143e20\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"500a1583478bb94f\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"d70d9573592f0ad8\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"664617cc889e847b\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"363bd0021b157204\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"0bcd065f6d27cb61\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"5eb38cc9c5bdfc22\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"08363f978b7afde8\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"29ea8ddea05c04b5\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"cc8a906f965d971d\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"96f3e4bbb4a4a4b2\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"19795f28d54b3119\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"4523a8157d847377\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"a5d77cc403355b46\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4b1e4247b69689fb\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"788aecc7d6d8012f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"33ec2faa7975392b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"05e655ae71703437\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"9fd50777d91a14eb\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"767790ce756ef4c0\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"32e4437c444c8149\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"56206803c718d9c9\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"0c476bdee77af49b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c41fe8d3d443236d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"419f68340d22a100\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"a232e41b629202f0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4bb771d7ab68405b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b9f0e9c943ba4057\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"14cfb7f7fb798e74\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"15964105dfc7685f\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"672b8c48c4d5d1d6\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"3ff285072fbb7953\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"a4fe49878cff5dfb\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"5bdc8ea2da748164\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"12a68788598228cf\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bea47943780214ae\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"9c08594dc81eac71\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"d4a8a2f76eed73f8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"9c28c9852c578fc6\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"626fa6854930db06\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a4351980c4f15488\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"ababf01cc63d4918\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"708e2aca52d482ff\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"610f25959bef0338\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"db0445acee849800\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"50c4bb9e00928cd9\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"8c95ff1b14958978\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"19215f4b1f53dd99\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"c19e17cd50f9786b\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"07146eaa228bf6eb\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"c4fd291da3e8b9b0\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"57e007537bc98a1c\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"c71c1f8452239e09\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"6e0482768fdcaaf7\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"680faa1ae1b91e2b\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3132ba11838185e8\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"185575fc2fd46898\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c7620fbba6aaf903\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c82f3933e7f91c7d\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"c58e2cc012eede95\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"6f594a439b98e5e7\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8c7958c92050056a\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"1c8f77e30321e154\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"a287bc1e5cc238b4\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"194d1198594187dd\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"bdf13807a871c2bb\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"e6f138766a488536\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"3fe9d91d56898cd1\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"a30d646aaf7d90bb\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"7fbde0ae5a8e2689\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"28bc69cea40a21f4\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b4e105d9a858500b\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3d19f5842cff9490\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"6ba41ff0c4a25219\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c77b3fcc40fa1755\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"6c0ae9daf92feeda\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4ec05732f8b14b7a\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"83f0557f2e678cf7\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"d696afa0a68cff9e\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"ba5fd1161c735378\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"80a8317dbac548d5\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"08f0b7b45f9b72fb\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ac62b65e0ace7f3d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"cdb748a8486f24da\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"31472f25ff6d9340\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"75769736be062f74\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"19d6c87ebaeaeb88\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"4154fab0524757ec\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"582f98981dc6ad37\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"8cedb77d1df2353e\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"89e8d468e296e1ed\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"271eb6eaab534ee9\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"86c20b9815d54c7b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"05c55fa6ff2830eb\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6d801d3a50581ced\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"0c5c681300fcdc65\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"8930f5906b714590\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"8839502822eb6872\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"cfcb80487390b32d\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"961aa8a14fda83f9\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"8de1f1d6d5a7d80a\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"d1b9b4f1cff7bc7a\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"be1f31e1416e017e\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"1d461a044cad3b88\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"98a74b88bd8e80d5\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"90f02f168ff14c89\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"94da209a299e1fff\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"7c3dde17590bc357\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b2b916a939ba9bd9\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"69829d5952817422\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"bc03d787d77076ae\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"abd1b9f1624ee714\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"004291abb60a97bd\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"1092bb5d44f9a22a\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"94d0edb37438c76c\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"a151c793720c4a11\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"5691b7c959a3b00a\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1f910914efacb85b\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"65a1428a32d946e6\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"a94666d319a82d79\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"eeef315c551eac1b\",\"/knowledge-medium/src/plugins/geo/index.js\":\"a3d821fe0b5f7c94\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"768601c3ca18cb4c\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"17987d4ba9ecc8f9\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"add1971fa806dd8c\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3009c393d38c4b40\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9a31162195ac8af6\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"ac1cfa735fcc3c9a\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"c3d04ef3a2cf8fb6\",\"/knowledge-medium/src/plugins/geo/query.js\":\"a3c70fe2f3a24f6f\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"6a66dd0453a98288\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"13bbc833008a9096\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"039f2b9dc0743439\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"677dd04eea370a16\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"971be9849491d1dc\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6cac3061c5eb1ceb\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"57fff92cb54889ac\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"474af28a8752703d\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"5d2cddea00ddf01f\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4e789600cbfce52b\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"6075c13f9279cf36\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"32959c1640cdf2c5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a4fa4f45e34acbfb\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"60a11f7cc99483e7\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"56c0270385997188\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4b905a30b72ec6ba\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"ae009d4415ebeeb9\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"2119377ae15cdd02\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a90d05c580954eb2\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"0ac3880c4b2d3559\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"7576ba2928797a22\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"983b9908e6214eaa\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"cb551d44eb625b6d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"e667a06ce70a1ce6\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"5e5e62692ea1bd2e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"253111cbaf8f7a90\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"51e2cf548c1dba90\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f8134a6576400c63\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"91cc7e9e68f11c05\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"db6e9d5c695b3ac8\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"1f61a4bee7ccca9e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"6eb531fe42fab1fb\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"fc4c9cd61a40ac8d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a8a1c356bf52cc60\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"cb8cadc8d2b29f6c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"bcba2ef015c3c7c7\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"f48811487872b04c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"100306de21b63d77\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"7f5fdd87edabf679\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d7f1a85b8cdbda35\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6468d91b2a37715b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"91efc976e54114de\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e142caf43780e1ca\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"3190483b1f40f4fa\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"5d6d22875c46cbe7\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"4f2b321415fda5fe\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"2691f42ace61f750\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"c44d9a2f779338c0\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"053a2a5e818edf8c\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"e4dde59fe38e3d9a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"17b8000a9b36dd35\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"52a7c03f7d73307f\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"817002fad7c95f47\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"bd046697e48e620f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"020768d91d9be421\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"44c2b9fab757ed5a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"52c1d022a6fb7ea9\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"3bb4d3d4bed086f5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"a33c1b9c62edc53c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ddd00060d609852c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"635b22d9ad3fa96a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"db097a527c3ae574\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"50b77d32b93514db\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"c12648abe94a6b2c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"24704d616c436148\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"df614d064c513805\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8e14e6d7c6e0be75\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"c23d150e1a4f3b7d\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"61fc857e287f6101\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"78cae0893589e297\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4bab8ec0f390044b\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"e48b8d40da9c9ed4\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"bc37ebbc32c28ade\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"b0c0d2945fb0d3ee\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"46c9e1dd656c7f2f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"5daafb4ef8a5dbec\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"98c7db2b1275ffd3\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"e29ec6298403b0f4\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"5fa8ac1d163bab0e\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"17ee26f75fa8626f\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b9cb49605dfec7b1\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"aa2fd0562c183b20\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"a360246958f597a2\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"a412d8cac0cb769b\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8dba46da677b4013\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b836ab9323498068\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"3e767551aec3a25a\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"855be5cb862a7ecb\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"c9e4e2b387f42676\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"3be7c4c0e3200d3b\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"bacffac9a7d4bae0\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"08e3569feb7566c7\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ca202d3f7d459846\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"af0e8ea3e7c21f24\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"720ad8f83183f018\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"46cc0ce692ea1be1\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"a3205607e5a77da0\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"52bea085b33e24a5\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"0fcf92a882e943be\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"b000efde000df483\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"6bd60fc2edb531da\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"5ff28ca2a7db484c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"2a20a049411b13eb\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ced894a0a2a3cbe3\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f01a76782e6e5eb4\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"2f15f9010efbe725\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"b6f99b1f12e35580\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"f9c4a9ba70b036dd\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"d395470836e48934\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"dbbe155c3d3d7d48\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"2532adf756e58e45\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"58287003104a4d6c\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"2f07d3476ec8c27a\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"6aed43f9c21c6e41\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"1d773f8554a488fb\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"7f536cf95668376b\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7226403fdb583e25\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"4a2fc0bceb908075\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"c3fac32c2405883a\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d61a82c4eaffd069\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2ec00641810bc153\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"c78dad36a37b9071\",\"/knowledge-medium/src/plugins/recents/index.js\":\"87917ac101d1390c\",\"/knowledge-medium/src/plugins/recents/target.js\":\"42abd5d1e228542b\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"2637fca49e94948c\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"84e4be0b3ffd6026\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"b214764ab2d6e01e\",\"/knowledge-medium/src/plugins/references/index.js\":\"811bbc1c7d718b43\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a5e38d558db8b236\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"f702f60e43528546\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"f7dc0429c4554d8e\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"eef7e7941f8a4e00\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"98553bbdd3e370ff\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"7a18d88f911290c1\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"84ebf16c73cd61c2\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"617a76148e2e4181\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"93b0c4067e70a303\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"b6a7594f7f36fcd5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"245ac102836ed366\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5b121cc60735d198\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"f6e1c980a2739085\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"294714fceb16d830\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"9025efedcb25eb8d\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"acb76448a298020f\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"5ebd7ba7df58cf33\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"919874518588e29e\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"c243edc633fa82ac\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"1d596e1758d3de4c\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"82d4075bd1c84ad1\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"696ce9b6cbe633bd\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"c7d711fcd5f59a9b\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"f5e4ca9f8d7042cf\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"fab367157514cbf8\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"38de73f227f1babb\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"22e3d27f491dcf12\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"9bcee6d7abd5a6b5\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"385a260ac82fe04e\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"9dcc90d87da4c1ed\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"574dacec133c7aba\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8d0284854d304ebf\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"4e346714b2874c84\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"94c2c0df5014ed32\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"cde975262a69068c\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"1b641ef169b53e88\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"2528504a941d83a4\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"d89e7efe10c152b1\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"87fdd9f5607e2b5d\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"0fc9aa231766c5ce\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"9de25e3a3ccae8b0\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"cb989392652c1847\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"7e9d98a284f2d547\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"0745a0ffe6530089\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"46bb11e2376cd793\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"f4d4212ded161ab6\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6b7e61e2ea992d43\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"cc7f89a51c30df51\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"f8c323ccd5346a16\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"48aff85a84f3c78c\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"fed8c148d1996ea1\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7403352c200ba823\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"1708468ee78f8581\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"5ec3f4e18d6a190d\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ab3a6006b00b2e99\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d50ee2972697fc80\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"5a50e69842086efa\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"8310b54434c72fcb\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"41ae19e2150f2e6e\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f7103d0cddd4b2ee\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"61dc23408dfa760f\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"77126d9aea6f8f82\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"051f82a84d16e368\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"9a44841ab43e8f82\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"13efdbeb0578bd97\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"4f270c54fad9063c\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"eb11b56f53e8fac8\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ff6ea6952e77428a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"44d6c425dc357849\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"079b997e37140a04\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e78324c2a155906e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"dd06209026a40902\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"8ad6b3d4bc648695\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0d378980a35fcf25\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"660779ce6be40c31\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"e7dd2dd162f6d56a\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4ce16a7d38ced551\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b1885ecb92c44138\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2dbb106184fbde25\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"6daa6f2720798056\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"38812ecd85d1404b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"7f749feffeaa95fb\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"6dc403a77515fd99\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"6a571b86a56530af\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"ad067cb2fd25ffc0\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"39b13e7e7f6db5e9\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"cc76598395789831\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"eadee8fc8333a2eb\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"03e678c4542a190a\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"1e5bfe981aeaa32b\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"94f57bc1e2683bff\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"5762a218b835c83a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"b39a70453a9faa87\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"e0957f382dd84ed8\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"f31c38bfb04a79ae\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"0952a606912d1ec9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"636dab6de361bd71\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"42fc7e9dd7f9b576\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"391403f306f976f3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"66712a3317ef5a36\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"05a87bc90ad7ab75\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2355dd2564fb1d72\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f4841e3dfd40687c\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"728fecea029a7db7\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"2782386b783dd81c\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"f789ef2106a5dc0c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"20b2e41e4b370746\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"46a00421b8fdd6a7\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"9ee95346a7703552\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"f01fb31dbc6ab8b7\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"5b4d0e8694dd672b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"3853b1ddea2afef4\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"7e59d0c3b15b30be\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"f4f5f4cda4b51f40\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"d48ac18d31e36977\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"34719b88351e880e\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"ecf42548cdcadbec\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"88ed13f718030a55\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"8da455483eae6a6e\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"a769149c222e8cc8\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"a222da588a0a8b4c\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"628d029223cd12c9\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"a0599129a208dc7a\",\"/knowledge-medium/src/plugins/tables/index.js\":\"5a5c1d92c4b819a8\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"264e8f7738398799\",\"/knowledge-medium/src/plugins/tables/model.js\":\"fd8dadfea8d1e629\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"d178ac790601dd28\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"dec336b7260755ec\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"e461ca1f1ae3c27d\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"f91daca4890608ea\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"a5836246ede38884\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"07cda601b2e8891f\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"fcf02cf9e09eea99\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"e427a3d57d88cd61\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"6ac4036083e6cab4\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"0f995316179b1c1c\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"377f23e348221354\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"9dba1d1ccc060570\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"551e01c34cb8c400\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"93b8c47a55e16bc3\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"f55c523328b38b01\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"6e036d04cfe1e475\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"dfa5fe1952aa21ca\",\"/knowledge-medium/src/plugins/todo/index.js\":\"8202f5112179ee13\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"15a4728c71dffa76\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"734406939b671df1\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"7bc82ed3927f866e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"c4f4292b057e678c\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"029cae4d0a55735b\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"9d8d52f6d9037f56\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"99569c70b04f6b62\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"725c73c99cbe033e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"7b5bb28b5c33620c\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"c5c1e22c52322246\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"9c4bb5a9d2651d65\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"bb89018ebc70058e\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f35c5464e19e3cac\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"5cb4721e9c6731b2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"28d48b40fda4ac0c\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"c1875748a20bd84f\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"bee7203bb0dac555\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"8a7ffeaf05c9ff20\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"bac4c0cf73636a83\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"77e30df647a02591\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"b80a7bc6a625c966\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"d21011d6b0e4af80\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"ed89742a8d7399f9\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"fed275993c4d31c0\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d3c9eb056e2b0d11\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"768339294bf56b6c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b104a8ee7df84462\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"4235fed7471f876a\",\"/knowledge-medium/src/registerServiceWorker.js\":\"91cebb07aabd5700\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"4efa72b3bb421458\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"e7ee4097f93264c5\",\"/knowledge-medium/src/services/authStorage.js\":\"f2c01e1f88eff885\",\"/knowledge-medium/src/services/powersync.js\":\"aceca72a3f2400aa\",\"/knowledge-medium/src/services/supabase.js\":\"018f934139269fee\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"e1fc004c8e2252a5\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"6c90ac0a91eb4d5d\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"397ce39e34b0f521\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"0d95f2684d37712c\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"c8a7cf5ac72454bc\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"74acff32308cc4a1\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c445646c574d96bb\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"3ff6d81f026ff681\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"6460b94bdec0b1f2\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"f07de237ed6a24af\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"f0bbfd2dd836b69f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"88c9a4d3d73504a2\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"1ff75a91f86531b2\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"6fd97d971c56144e\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"496e4b59da30f86c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"20ddc6ad770ea025\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"d65e576e6592399c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"26c2da88becfb229\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"9e8aa50d945302f6\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"57a1f6dc18c12bf2\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"bf226adbdff597aa\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"d2adbd34580e7186\",\"/knowledge-medium/src/shortcuts/types.js\":\"9ecb274badf85ebd\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c13f3d2c0630fbdf\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"b721fd52c5491c03\",\"/knowledge-medium/src/shortcuts/utils.js\":\"db82af1cb0602997\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"f674df994207e2e3\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"981668ff170bd211\",\"/knowledge-medium/src/sync/byteTransform.js\":\"fa9882ece098ce76\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6fc72c7c1ffa3cfc\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"bca3a5245db2cec6\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"2cfee02f5c08ba1b\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"81cd255e163794d0\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"af029f4ff281fab1\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"0b2477447a770f20\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"2afcf2b85ef9d6aa\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"b07a6acde4e60d56\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"8920e4008101554d\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"4240ac7fa4dfcc9a\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a61f1a4f3da82514\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"946ac9b8e8599cf8\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"e9333871edb18ed9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"5e6f7c58586270b7\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"0053d297aa203789\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"2b0bdfe63e811a45\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"e7007e055d750d15\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"68d79d9d6d3a96e3\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c66d13f15e221e9f\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"3e23c4e9c1ba7841\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"fc64428ffe3e1305\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"bb64045e32b0fade\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"6bc7a980023adf2f\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b0c14ca18fe32482\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b936f669a7ded743\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"ae0adeaa4860893f\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"986caff0e457aee4\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"4398f578433dde62\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a02599ead07a7688\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e6a673009191486b\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d131ec613edc9be4\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"e67182e433fcae05\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"346fb05af07b14bf\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"c87e29238918e5c6\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"9815ca22d0e4bf56\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"705dccf01cc3c194\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b811da82363d2487\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"763bf5f9c0a67cd7\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"616dd631c84c34b7\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"686655e5877cab23\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"c3b3ca2a4da897d9\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"1e3e8b80c6570d80\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"bd00e752ccbdeee1\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"c99f27ebce442a98\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"1c32943d628c4b5e\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"aa9eaeecec1c2cbc\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"f59779c479a18a6c\",\"/knowledge-medium/src/sync/transform.js\":\"83fb7850bdaa1c38\",\"/knowledge-medium/src/themeBootDefaults.js\":\"0299cf1ec9b4ec31\",\"/knowledge-medium/src/types.js\":\"e0d9bd17997fc4b8\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"6a103cf3550f7edc\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e0a055ead277436c\",\"/knowledge-medium/src/utils/array.js\":\"c2de375963765c35\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"0244975f5daa92a9\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"10cd9d0add50707b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"f3ca8b2430736656\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"df198426d78438f7\",\"/knowledge-medium/src/utils/callbackSet.js\":\"6c225973176b7a4d\",\"/knowledge-medium/src/utils/clientId.js\":\"9ede436b96a53754\",\"/knowledge-medium/src/utils/codemirror.js\":\"6f4388a15e27f06f\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"2a502ea4b5180405\",\"/knowledge-medium/src/utils/copy.js\":\"890cd3f3c05bfdb2\",\"/knowledge-medium/src/utils/dailyPage.js\":\"c2aa74f9bf2e6833\",\"/knowledge-medium/src/utils/dbForensics.js\":\"df95737df0c49732\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a34c25744489e41d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0c7326cd6de8046d\",\"/knowledge-medium/src/utils/dialogs.js\":\"1113a7209489e4d1\",\"/knowledge-medium/src/utils/dom.js\":\"de7ffa8ea36219ff\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"b8275a36f7253599\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"06344b07807554d9\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"35ed17a7ccaff0af\",\"/knowledge-medium/src/utils/flipSlide.js\":\"72db31cae24e8198\",\"/knowledge-medium/src/utils/fnv1a.js\":\"748d73780ece53f6\",\"/knowledge-medium/src/utils/formatBytes.js\":\"38fe038b264a935c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"8c0907843214d21b\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"9a49cbdf36d326a3\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"1e51547273bbbd2d\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"89197aac092792a0\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"eeae27b88780e175\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"b63d452f09be76db\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9f000c5303f1da43\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"b52135902c443ff9\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"bdb5485861f6f780\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"2ea7475fc1baa0ab\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"83f2ad944ee11fad\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"e950af0622bc4e77\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4065ea7ba16cc886\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9345d6855a568dda\",\"/knowledge-medium/src/utils/memoize.js\":\"d57925b75eb5d2d0\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"f647f95bb015a7b7\",\"/knowledge-medium/src/utils/nameList.js\":\"0c1139db9b10baed\",\"/knowledge-medium/src/utils/navigation.js\":\"006ea3805d52d585\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"44429c1627655b9d\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"c2177bf70647ded4\",\"/knowledge-medium/src/utils/panelClearance.js\":\"acdfb3d06d648fdb\",\"/knowledge-medium/src/utils/panelHistory.js\":\"8a5f315c8bc5d8a6\",\"/knowledge-medium/src/utils/panelLanes.js\":\"1477cbf2ffb0b89d\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2140b65c862e7dc1\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"6d36210a6a4f536a\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"40f175d5b97638f5\",\"/knowledge-medium/src/utils/platform.js\":\"b58955ee3d660fe8\",\"/knowledge-medium/src/utils/pluralize.js\":\"71b6a0434f3a0835\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"77e62e9df5fdcd98\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"4d66f715ccb5164c\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ffae38c6bd85e544\",\"/knowledge-medium/src/utils/react.js\":\"8b9d044a6e7f1616\",\"/knowledge-medium/src/utils/relativeDate.js\":\"f986c7b3685d7129\",\"/knowledge-medium/src/utils/relativeTime.js\":\"cdfd58ae6474d1cd\",\"/knowledge-medium/src/utils/renderScope.js\":\"4bfbb4b2e0e5f1a8\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"7035c1ea14bb9a1a\",\"/knowledge-medium/src/utils/routing.js\":\"a5ce08572c85a351\",\"/knowledge-medium/src/utils/safeMode.js\":\"82f3415082fb5f7f\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"14b2feda24a1c423\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"be13a1c483877590\",\"/knowledge-medium/src/utils/selection.js\":\"f1ab0f667eaf5813\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a2d440d6effa0e46\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"60ef151ea00daa14\",\"/knowledge-medium/src/utils/state.js\":\"2270d70927aed2b4\",\"/knowledge-medium/src/utils/string.js\":\"f4c82d4d76294a5f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"66e4fd2a47ffe047\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"aec65c0c97503053\",\"/knowledge-medium/src/utils/toast.js\":\"f44440699e57f8b0\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8c4ac3039f4108e9\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"362077093e435ce9\",\"/knowledge-medium/src/utils/userActivity.js\":\"5b76a60d812032ae\",\"/knowledge-medium/src/utils/viewTransition.js\":\"ca84643a37b00ab6\",\"/knowledge-medium/src/utils/viewport.js\":\"bbe43e86ad8bbf31\",\"/knowledge-medium/src/utils/webLock.js\":\"e9b49a3709c1256e\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"efcc4e6d40585a75\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"f41faf04a0973e5b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"f40a1dea264bf554\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d344240dd382636f\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"6925fd5d1f6ddd08\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d5e5f5495d500a93\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"d5ceb67709add083\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b5192743684edd01\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"9969949fc73347e1\",\"/knowledge-medium/src/vendor/react-dom.js\":\"bd391e6b6c1d0cc8\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"585141595a24f7d4\",\"/knowledge-medium/src/vendor/react.js\":\"3c932579c612ce3a\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
