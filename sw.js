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
		buildId: "f1d184426f7a-896dffa6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"5e858fb556a48d63\",\"/knowledge-medium/index.html\":\"5e858fb556a48d63\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-odBvD6o4.js\":\"a42503f8c49694d7\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"629280ebadc84aab\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BVoVWwZy.js\":\"6e7dc0ba76d1c624\",\"/knowledge-medium/chunks/FacadeVFS-v0l3LLqa.js\":\"cc8ecec2e5f40a06\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D2C6aQBq.js\":\"6f2341ec639cc1cf\",\"/knowledge-medium/chunks/MemoryVFS-DkGoKMw6.js\":\"6226758cb0c27d6f\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CkdocOxH.js\":\"042c200c547267a9\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DOepq8EI.js\":\"55f27cfcfb748746\",\"/knowledge-medium/chunks/Preview-CDb5wJS3.js\":\"060620c623216be0\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CDf8HzCt.js\":\"0080b736034033b3\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DbGQBfaG.js\":\"2573f8e3826a58be\",\"/knowledge-medium/chunks/freezeExtensionImports-C39dB_GJ.js\":\"8c5d2acc57d8d950\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B_ym7Ers.js\":\"6149c06275f935f1\",\"/knowledge-medium/chunks/react-Bi1ec_IK.js\":\"743a4b13c456ee98\",\"/knowledge-medium/chunks/react-CF_MzNRu.js\":\"b0af45aacc7a20da\",\"/knowledge-medium/chunks/react-CaahIdrr.js\":\"1cab07289d4c57d3\",\"/knowledge-medium/chunks/react-Cakgw2Ax.js\":\"ab1e48e98289202b\",\"/knowledge-medium/chunks/react-CusmZY6S.js\":\"1338c82e1df5c300\",\"/knowledge-medium/chunks/react-DjHpezhW.js\":\"65927ea4bb639275\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BmO5VOh5.js\":\"31c08cacbe9a4f12\",\"/knowledge-medium/chunks/react-dom-server.browser.production-xshNVscD.js\":\"61ba2532550aaece\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BcH8DSkl.js\":\"40cb57b0fa09d1e3\",\"/knowledge-medium/chunks/react-h7BWNlTz.js\":\"21809139a6c4077d\",\"/knowledge-medium/chunks/server.browser-duudMVK0.js\":\"1d8cfb1b81c6bb8a\",\"/knowledge-medium/chunks/textarea-DxkwJDDx.js\":\"558568373f9b5bbc\",\"/knowledge-medium/chunks/ui-DocTpvRM.js\":\"1451a18a2c5510a3\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"f3299acace17f0f8\",\"/knowledge-medium/src/appUpdate.js\":\"91b2aee0900db1c9\",\"/knowledge-medium/src/appVersion.js\":\"fa7137a708bf0f47\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"9194a7d1a97b4c4e\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"218d926d1520cc14\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"3cf0d6a0274f95d2\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"2648816d8dea17b0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"dd3476f1401fb8bc\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"7de87cbb479f939f\",\"/knowledge-medium/src/components/BlockEditor.js\":\"b53d9b0e5d99f353\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"461e71f8a4b169eb\",\"/knowledge-medium/src/components/BlockProperties.js\":\"bd05f051954cedac\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"edd7097e8cfd5bc0\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"b208c2f41aad23a0\",\"/knowledge-medium/src/components/DividerHandle.js\":\"39244d419e15381a\",\"/knowledge-medium/src/components/DraftEditor.js\":\"4ec7c89f61f74a57\",\"/knowledge-medium/src/components/GutterPill.js\":\"f4d7d1ab88cedd19\",\"/knowledge-medium/src/components/Header.js\":\"074f58e481483beb\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"ba151569f0cb7892\",\"/knowledge-medium/src/components/Login.js\":\"ae6fc39fd14b8694\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"53004ff63db9804b\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"34d1825a43814d38\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6eb48919f70e66bf\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0b43f6ffb36898b5\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"aaabd9e100a148e2\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"c2420f25054997ec\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d632a1636f7768e8\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"dfc78c024c003644\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a0e1b4412a053f05\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"b68cbd9fbee30109\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"083d2a0327f5d9fd\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"241d44749f576682\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"fede55e83dc0792d\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b3f3d7288dd7e5b9\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"fe8c26ab46a1c5f1\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"090adb474d513366\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"1d8da017d1f91678\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"e9bd1362f9447238\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"6e71d8c8bf661d5e\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"ad6acab42180f30c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"2a396526f0e57462\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"5b67fd363cde7523\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0a9034d148578ce2\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f975972c4901e18b\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"3272cf914f73f400\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"0444d07ad7ff5742\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"da0453a3d14d2126\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"2bc32b049132b7af\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"e96962b7f0808532\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"c9977048467bc1d0\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"096c3862c975ac96\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"664ee94eaa008049\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"234887bd539bb191\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"526c931417c68b37\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"55407a30ecf3cf12\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"76c5bc0662b7b28d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"df95b817a7aa01ab\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"720463d494f3fbaf\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"3ce7655ae5b45e0c\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"eb40d91ad711bb7e\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"94189abd6c4df0ce\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"375a36bf922e333f\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"e2c2a2588c52cf23\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"156223c4eec02990\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"7841b53dd1206b1d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"782ef30d5b304449\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"3df5272cbbdced4f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"b0e059d322a46caf\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"7cacdb7750a69de0\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6903ea1071da3c6e\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"5ac9773c28138d4c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"add52870e2875343\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"11f09698f0f37345\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"dc0b5dfc38dc38d9\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"42b2273f4f06762d\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"97bbb3dcfa7dd3b7\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"77f1a10d274f0679\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"9b71bb83e93b4975\",\"/knowledge-medium/src/components/ui/button.js\":\"cadc579f4435d6fc\",\"/knowledge-medium/src/components/ui/card.js\":\"3602f6cf50583b39\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"66aedb5795bc31bb\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"2709bbde8ac331aa\",\"/knowledge-medium/src/components/ui/command.js\":\"01eb649bee364a7c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6190d63c35c6c211\",\"/knowledge-medium/src/components/ui/dialog.js\":\"834908f64d5f6470\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"196ff83af75dc8c4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"85bb6bb3a71fe7de\",\"/knowledge-medium/src/components/ui/index.js\":\"ac0cc8bd2fc8d1c1\",\"/knowledge-medium/src/components/ui/input.js\":\"b2edb9756ed9542f\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3b4683f7b14ea7a3\",\"/knowledge-medium/src/components/ui/label.js\":\"905881b8dfb703f3\",\"/knowledge-medium/src/components/ui/textarea.js\":\"804da3e37f884448\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"7a97d302a7cf423c\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f2ad99dffcbc15b0\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"160ec357313fd8b4\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"934aac1884b57312\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"8242595677138a82\",\"/knowledge-medium/src/components/util/error.js\":\"4582bad76da0b64a\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"4e8175ee3e1a7387\",\"/knowledge-medium/src/components/util/suspense.js\":\"7f8e68c1a3352073\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e59e0229142b0eaf\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"64ddb35b82783cf3\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6dd7846098af836b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5ffe26a6431d2678\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"d71fb1382421250f\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"f5341d7d0dde1a68\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"8b26e5143c913298\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"67ea1f3f8d0c6f1b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"0cef2cb877508068\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"79993ab799a7cb3c\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"4a7e51cc81f18b61\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"c8b4671819514d24\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e3fe6d911775ca4a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"8bc3911bd25a3532\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"13a7e493ed47ff58\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e87364ab13cbee43\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"6044769891b4c636\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"d8283bf96307197b\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"1070ba20776542c3\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"098e088121100dc1\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"3e6f1ad505bea3cb\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"2320d2ddc4709ca9\",\"/knowledge-medium/src/context/block.js\":\"426715da1504bc67\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"462a9096712a86e2\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"2ffcd5dd75b78265\",\"/knowledge-medium/src/context/repo.js\":\"b355b4358b75fb53\",\"/knowledge-medium/src/data/aliasClaim.js\":\"7c5e372422ff9574\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"a67d79e4d664d302\",\"/knowledge-medium/src/data/api/blockData.js\":\"b107c8c6e8236844\",\"/knowledge-medium/src/data/api/blockType.js\":\"579a38a75d4dee6c\",\"/knowledge-medium/src/data/api/changeScope.js\":\"9da6329cda96eba6\",\"/knowledge-medium/src/data/api/codecs.js\":\"35a5852ac1c5a38e\",\"/knowledge-medium/src/data/api/derivedData.js\":\"579920a96a59eb76\",\"/knowledge-medium/src/data/api/errors.js\":\"76302756a67d1aa4\",\"/knowledge-medium/src/data/api/events.js\":\"08d835b3eed89a4c\",\"/knowledge-medium/src/data/api/handle.js\":\"c62340f695efe651\",\"/knowledge-medium/src/data/api/index.js\":\"11b268efec1b9792\",\"/knowledge-medium/src/data/api/mutator.js\":\"083fce3acdf7641e\",\"/knowledge-medium/src/data/api/processor.js\":\"ecdd5bff08c2b52b\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"2832a181f3c7ea6b\",\"/knowledge-medium/src/data/api/query.js\":\"799ed183d7fc90c1\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"73fc2db464a00791\",\"/knowledge-medium/src/data/api/schema.js\":\"c62340f695efe651\",\"/knowledge-medium/src/data/api/tx.js\":\"c62340f695efe651\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"c2614701d86d1e49\",\"/knowledge-medium/src/data/api/user.js\":\"caae693fd9e47647\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"7c75a3acc0d0d8b1\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3bcadf8d48ab063b\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"06e1c66e81ea91dc\",\"/knowledge-medium/src/data/block.js\":\"b1f06eec74fbcce6\",\"/knowledge-medium/src/data/blockCache.js\":\"7e99226883c87a9e\",\"/knowledge-medium/src/data/blockId.js\":\"a992012d88d434b6\",\"/knowledge-medium/src/data/blockLiveness.js\":\"a0811009bc3977b8\",\"/knowledge-medium/src/data/blockMerge.js\":\"a6b57204bfa775a7\",\"/knowledge-medium/src/data/blockSchema.js\":\"52cf209be31f5a11\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"087006d9993c8f6e\",\"/knowledge-medium/src/data/blockTypes.js\":\"101a5ece8d2ec734\",\"/knowledge-medium/src/data/childrenView.js\":\"02ed94000c2690eb\",\"/knowledge-medium/src/data/clientContext.js\":\"278b0b80d62def20\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"71803750632b060a\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"a9c53a10041bd384\",\"/knowledge-medium/src/data/derivedIds.js\":\"b764fcce2083480a\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"37e4e517424f0595\",\"/knowledge-medium/src/data/facetBridge.js\":\"0525def1be21113e\",\"/knowledge-medium/src/data/facets.js\":\"782f172a28d6808b\",\"/knowledge-medium/src/data/globalState.js\":\"b351b804e7295f53\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"1013274bc782449f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"15b42afbf400c1a6\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"1c606757e0ac2fef\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"e828585c7b34739f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"bb3550743d1a6123\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"f9e176abf20d11d1\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"aaf2990b08c172d4\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"75f359779104fcb3\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"5cdf320c5ba004a2\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"2ae686c2a9d71a05\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"6fe59978a018655b\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"42b599a6ed0ffb64\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"84edbffccc2da4b1\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"17fd9711470d6c92\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"9e18abebc350a6a4\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"95800994624a704f\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"5ba9552cfc0756e1\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"55b94c1b7f90287e\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"65f7092cce939235\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"33e254ce217f4b0c\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"0f666ce659b020c3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"8fb46e21c64403f8\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"cf44c597b1bd4d06\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"684c18619dfcc275\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"418e2c1df926fc73\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c23859dc2a8fb44d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"63967597dcacfebf\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"351db2c134ce865a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"41e5d27cc3370f25\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"4df286c3775a012a\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"a03eb49741f92df2\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"d0dd807d59fc1e7b\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"7d6f987bffb27e3b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"b2ea86b166daaac5\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"973c454eb3990f47\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"c15cbb8e45943a78\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c90d6ec8b9e862df\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"59e20e144fed8efd\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"89f6f6293159160a\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"e22158f73ede5820\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"05e82a57b84a2836\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"dce82fc2bffc36df\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"718a46d06ac55774\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d58dad2459da4701\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fb24e4b2985856e3\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"99b5941c800453ec\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"53018804f505dc4a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"28e3854c8c1426f6\",\"/knowledge-medium/src/data/invalidation.js\":\"4ee0a32c53a74eb0\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"7958e34b70b68c2c\",\"/knowledge-medium/src/data/kernelPage.js\":\"a6cd20dcfab91413\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"126ebb1d7181d2f8\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"d94abd26d1115515\",\"/knowledge-medium/src/data/localDbStorage.js\":\"294a9f7cb8e0a82c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"8ff9b64a7758d484\",\"/knowledge-medium/src/data/localSchema.js\":\"75f2acf6fb7cedd9\",\"/knowledge-medium/src/data/maintenance.js\":\"9c931b086e4eed65\",\"/knowledge-medium/src/data/mergeProperties.js\":\"cd4afd8553954808\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"cf05ac377dea228f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"5a1f3b688ae4bd6a\",\"/knowledge-medium/src/data/mutators.js\":\"c35b8620a24ab9f5\",\"/knowledge-medium/src/data/orderKey.js\":\"2fc8bd11a9184061\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"9b5c08c55a2206dc\",\"/knowledge-medium/src/data/outlineSurface.js\":\"a588e27d040b2b03\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"99ef1a1dc617b973\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"b1fdf6d2cbc7a490\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"4b5126ad57409f75\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"aa2d11bf4a5eb619\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"ae8416eb5fbb1a1c\",\"/knowledge-medium/src/data/properties.js\":\"d6061ab1d6e2f9f7\",\"/knowledge-medium/src/data/propertiesPage.js\":\"808947adc1d64622\",\"/knowledge-medium/src/data/propertyChildren.js\":\"8f96e64d7e4519be\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"160ab61431da2dc4\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"f52df2124aa1a270\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"230323d8c9a37edd\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"3a44b1f18e791625\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"91167eeb5f662603\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"49b08c8e3d0d6b1c\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d5d6d13466733d46\",\"/knowledge-medium/src/data/recentsPage.js\":\"31ce242b77df99d5\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"8d3dc557ff72fe8b\",\"/knowledge-medium/src/data/referenceBlock.js\":\"1906a9f189330079\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"342c8474e393095d\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"199f3ecbbc2b1b04\",\"/knowledge-medium/src/data/repo.js\":\"2c3362225dac96bc\",\"/knowledge-medium/src/data/repoProvider.js\":\"6824954d80af646f\",\"/knowledge-medium/src/data/rowProperty.js\":\"6f511ed88248373d\",\"/knowledge-medium/src/data/searchFilter.js\":\"3fda1f8ad73c02e2\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e88ee65cb122e2b0\",\"/knowledge-medium/src/data/stateBlocks.js\":\"11cf3ce1e30df7a3\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"eec030b3e6ed7e87\",\"/knowledge-medium/src/data/structuralInsert.js\":\"aee59e78066a7d60\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"18fa34d46c5fcf37\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"4ad94486b3f34cac\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"0755f8e8b1a0bd43\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"542ade88dcda8d7d\",\"/knowledge-medium/src/data/targets.js\":\"1547a20bdf7adef2\",\"/knowledge-medium/src/data/typeColors.js\":\"c4256efac7dba2e7\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"df0241df11a2119a\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"e5fe094fe22acd1f\",\"/knowledge-medium/src/data/typeExtraction.js\":\"6d1c200a916350c0\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"139dfe253b0fad0e\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"6a2c7b4c184aef6c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"e57d74b15ce62028\",\"/knowledge-medium/src/data/typeTagger.js\":\"3bc86ba8c767e9c1\",\"/knowledge-medium/src/data/typedRecords.js\":\"244ebfaeba16b804\",\"/knowledge-medium/src/data/typesPage.js\":\"7af976ec5e497242\",\"/knowledge-medium/src/data/userPrefs.js\":\"452d7e24c062455c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"98a653c43b704b4f\",\"/knowledge-medium/src/data/userTypesService.js\":\"d20d5271412c02b8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b99f08cd5dce75b1\",\"/knowledge-medium/src/data/visibleChildren.js\":\"18a2ed354a06c77d\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"324d7e90e939a592\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"ceafdb2ac8a88fc9\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e6cb17bdc3aa12a1\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"1aeca162e7914736\",\"/knowledge-medium/src/data/workspaces.js\":\"48c918a981faaefb\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"40e6cb33d3167624\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"ba26aa8b81762d82\",\"/knowledge-medium/src/editor/atTrigger.js\":\"6eb86c8ebfbb17d8\",\"/knowledge-medium/src/editor/autocomplete.js\":\"f43772653d522136\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"8288e3c6213d580f\",\"/knowledge-medium/src/editor/contentFlush.js\":\"75abe805b0043ce9\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"e994c481b2846e68\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"9393baeaa084254b\",\"/knowledge-medium/src/editor/insertImage.js\":\"833c5530c02f21b6\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"b26211d92849875c\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"0b8dc17b8ee4a21b\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"0effc845d7543494\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"8133d1d6864314ef\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"41ba58b1f1f059d8\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"00ba13aff7f1f167\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"4c404f5d380dab77\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"8feb2b429a7ac3d1\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"c50e522a18e55088\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"1f36aa2a2ff5d327\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"c7ab39f50b75a8a1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"1bb314aeb7d0b3f9\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3e78a0321fcab4c6\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"fac671d35b6d8fdf\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"15aa39f68c4b6049\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"2d7da4d01ac5226a\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"95aa2889fcb1a8b1\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"9741bb32ae988ce1\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"ce5f739aec15daa3\",\"/knowledge-medium/src/extensions/core.js\":\"6d880dab955a1fa7\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"49bdd357bc2175e6\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"a6c33fadbba50209\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"830722b7993712b0\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b77dde4c959a814f\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"44319ae943f459b1\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e0c894b1a71bea4b\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"d1ed8ec96b407f6d\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"488a2a03949f0fac\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"284433499ce3fce5\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"9aa80bf659811f6e\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"46a066971872ad80\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ddcb9212b54ebf32\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"4ba0c9c5d110f31d\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"862518935eb452d3\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"438b2ab971e2317c\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"28250bc4468d9905\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"bae1ba431becf677\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"1a31179d0117fa1c\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"2f3b625dc8cdf3aa\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ca8a57413f1d5362\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"166b848ff2219fc1\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"1fc1eec6cd17a920\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"83eaa8b47a4ac098\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"4dbc05327a1488c1\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"b55606a42614c36f\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"f446b8dc80d907c3\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"45962e27e8d3310d\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"2bfc71ceb32ac689\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"5316e0db0b5eb276\",\"/knowledge-medium/src/facets/facet.js\":\"0d64eb5a1d0ce052\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"36816d93eb2f37b1\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"bd2847f47f2391e9\",\"/knowledge-medium/src/facets/togglable.js\":\"48972e474cfecd82\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f19a55aede416939\",\"/knowledge-medium/src/facets/verbFacet.js\":\"4c632e91c0f0d515\",\"/knowledge-medium/src/hooks/block.js\":\"bed96d9836f47da0\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"7c8e9827262bd221\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"5a0efad11be5e093\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"ed079b3770b891ba\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"0b387e7ee194d0db\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"d74e785865841cee\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"7591199ccb7c4cc6\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e35847e10093d7ef\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"68195f9e8b3d50dd\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"5b59b565c4cbdfb2\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"5861e5ae8bae2226\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"86df4399efd13da3\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"42aee9c6e6537fda\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"06253253f347a756\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"dd826c399e15abdb\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"48dced371093e860\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"254da377a4e65476\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"b9fa79eb0f439d92\",\"/knowledge-medium/src/lib/utils.js\":\"33aa2bc03c3b5370\",\"/knowledge-medium/src/main.js\":\"f91fb2af814ee759\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"83e238b2dc1105a9\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"8e5256ae9d13dcfe\",\"/knowledge-medium/src/markdown/context.js\":\"edc1b7aaa5e61894\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"cc0f2b09af0813a6\",\"/knowledge-medium/src/markdown/extensions.js\":\"4ba93dc58f2adea2\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"fa5865fdd4d87390\",\"/knowledge-medium/src/minimal-editor.js\":\"090ad6837c061e22\",\"/knowledge-medium/src/paste/armedCut.js\":\"e0b8132992b47ad4\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"00cb0b657fcdb0dc\",\"/knowledge-medium/src/paste/clipboard.js\":\"6188a13e956d4950\",\"/knowledge-medium/src/paste/decision.js\":\"84e8a21e34966416\",\"/knowledge-medium/src/paste/operations.js\":\"5e6093d323765a2a\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"943ba3a5c19e83ed\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"f59ad032af47c8a6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9d23ac5a936f0e3a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"636c9369f82b293b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7af188699a9e2d3f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ef17e87951743d57\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"30eaad50b8a44052\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"511cb4f5829afb9d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"a80702af049e053a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0a4405b0407b40a9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/retryAgent.js\":\"872eabe415f6d74e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"1dcd11d989c1b265\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"07ea87c403306990\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"62752a2a3aff0c01\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2d6fbe34a35d7bed\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6f0cfa965c8b7604\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"cd85c530b977ff2f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"df8d14ea8188913a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d5b79f6bc3b6fefe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"ea2b021fa09b7182\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"b71f4e6a0a384d73\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0e1e80dd9e380586\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"1e51a4e1f1a2d7d5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2f65a8b519654e20\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"264847a9f2ea3b5e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"24ac25281a636847\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4805d3913aaa46ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"e8df7dfb24e1cdd3\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a7658f873118b98a\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2ca7f83cebc4004f\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2650a6687ad9350f\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d6e37308a39a2296\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"d3b66461a615ba59\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"5ad8e11809d9861a\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"277e71be78112997\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"d361f56fc6119197\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"99a9df666e9bb778\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"2674094e26f8d070\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"432218f2478deed2\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"dd1b04fc69724931\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5f07bf45598e4b82\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"3b59619500fa88d3\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"7d4865fbd98c9ad2\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"bb83ac74037ae47e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"46e5cc7cae9defaf\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fbe61b929ecf7c4d\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"561e87d44a4e2d1c\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"1eaa3e1f5bc428a6\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"480cd266257536d1\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d68d22a86a00b03d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8a378170ca0d1d00\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"407af69f5c3dd878\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"d3ea90b5568d68fe\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"704d3695b8c91e03\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"904aad8edc99a0cb\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"6c38bb65fbe92463\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"bacfeff65596d6da\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"f1a4ea808cb5cfed\",\"/knowledge-medium/src/plugins/alias/index.js\":\"d9abc556a2aade59\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"3177990f47852898\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"528cc7dae850ab35\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"9f8d5dbd489d0301\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"b4b4d47b8dda13ec\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"a06baa07fe03f032\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"62970802685fd94b\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"046c331b8fa9fe3f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"5913db8b5c19bfa5\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"12b12d2daaaaf21c\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"44dee3b0eaca5adc\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"c5c13c0b138ee779\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"51b860c1e87cdbd9\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"d97f8daf3cc991bc\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"ae12fba0cb3e5950\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"03881554f3b360e2\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"a5b8df32c1ee63cb\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"20fa962b2a890d00\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"a4ac63ba01f568f6\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a27f4df20c0434c5\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"1d1ddf7d6fe4b70e\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"6b6efebcf9380d3b\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"2611a6c8f8008b56\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"7d4a70ec31710e81\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"f11315b778e8ad45\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"b9033385c23b763b\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"a504dd711292fc84\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f727ba0dc7f55cca\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"6ccb57e166ba066d\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"493472c2f8ddc59c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"c7ce16cab729dd98\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"936a8999b4232645\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"15e62b8aed1b86ef\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"ccc5ffde369d8a9a\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"ddf786d09f1011f6\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"7e3a30374b7a494c\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"7c5502eeba29bb00\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"57c77e165bcec31a\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"fe356f46ad4db37f\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"551423a74e998463\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"d4f764e3d9fe9aaf\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"0e3d77414d61883d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"887f909c634a02f0\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"c70c4525d1a3e9eb\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"6fb614e5a6aeafdc\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"7798ce9d54b4e773\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"95ec5d37418a9de8\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"807459f28a951197\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"eb0593754610f478\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"15d087a0099564dc\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"2015c943c8da2636\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"50f9947b6cbb9004\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"765d317fe803b9f2\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"933813cec66a479b\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"dcf9cbe465206110\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"a026a4930ad22497\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"feca80ae3f7d91a0\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"05ad062e683bf152\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"c80665e71468304d\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"7ce656c56805372a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4bd9040a97e005fe\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"f31ab0e2a94a6a95\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"8d19b4c4795a9984\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"2e4824b3e5f4e51a\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"791f85518a4a4fc6\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"54e3a59db88d8297\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"e8bd8b44af236da8\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"7d07054871fd7839\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"8251648ef675be12\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"d2d17b6c14141947\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9fd72aed5f9cb1ac\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"6fb396ff2e181a44\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"71c6614e0b831ee2\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"32bc16658a7f5ec0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"cf3b3a37c073554f\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"d9444ef84d357696\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"0fe067285ed8092c\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"73c3defe2d2cad07\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"8567ea08c32b10b5\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"30708e8889d2a15d\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"d82e4aeadc3bb95c\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2fe36901449f4a81\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"8baddcfba7b32446\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"192ae0f3ec3c75cd\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fed0dc5e4e24e5c6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fc271f8843d46fc1\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"845bbf8babfa3352\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"8f9b88459788ad6a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a243d9d1b9926267\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"9f363bbd48c656eb\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"227a2193dcbefd14\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"9b951bb473872ebf\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"0b823b9ebc3ca8df\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"580213bc15d43318\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"20d085d19a32dbdf\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"42ddeef8dd56030d\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"4848f8a542bbbf72\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"dcbb24827af027bb\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"cdbcf2a9a9578692\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"94822aaa73f5e974\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"86fed25f7b8684d4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"1acda54538928c16\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"eba460b9c9272703\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"d8d4f7e834c48d83\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8741b94554c2edc9\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fb91ccb0f5193c1c\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"9e1dd2932e91356d\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"93b794a888c17972\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"0ae385a131a5602b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"951230761d0a52a4\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1876033d95b8ecb8\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e2df062d512c1359\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"1e1f190dd6b0bfff\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"375809150c4da238\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"5c820cba5093df9c\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"8d3ed93c96037931\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"d12cfbfb855ccd37\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"6d7abf96da692ccd\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"fd3e0e798f1ca5a1\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"aa9a504d1f78bb20\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"34e7236ac8c74476\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"a0bbe409ee5ec400\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"e12b853f5b0d4a04\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"4a895e161e74a9f9\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"c502b22bcb9c97f1\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"e6078838260599b2\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ede9330a2b507c86\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"dab37a28127d0a1a\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"d71958916741ad16\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"c1b11c29f6e2c667\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"f11f8fcd2d550990\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"81ba464502ddb026\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"aa8c283954dd8f26\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"ccd0959938a79341\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"3d7b3304c2a5ada3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f00ca26c4fe8ef4f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a7ac4727ef2d9f12\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"212cb77a8740297a\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e16daa4970cb78d3\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ad5dc28d1efda4ed\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"27f739c6322a34f9\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"61a331655df33d48\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"23af1cbfb20be0ac\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0d6908c9e05090df\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3934587d07713dc9\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"feccf2ef3cd9b673\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"e375f93e87008d65\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"72570e9e42d23ef8\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"b8e289181b72976e\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"cd58ca53cd324fef\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"212134771f4e94bd\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"76cbef16d68199c0\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"5bc8d238ce83e595\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5844196e403d3456\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"4db7ee6161e2fd69\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"78ef4e9fa4996e0a\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"607af3225169e2fe\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ad0a49e35c06190c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"70b763419357b99c\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"27f5bb6ebda47a6d\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"522645caec10f551\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"28cedc3e3e113956\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"7c2879b1e2db6c43\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4b85770902129f4d\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"9cbbf1e8f9557e9f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"a3910a5f4235d071\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"fdaaa2331b6c0263\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"10ba850e9ad82004\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"25eee1d099815428\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0a98805772d5fcd7\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"2270a8e471085725\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f38d35e992d41224\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"9078644e8c8f1c09\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a3905753fac8936f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7a68689268a0849b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"21f3efd172073fc0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8d8335d5a691b179\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"15fe6eb1ba7d10d6\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"804bd2bafd8c78cb\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"866d2f9eadfbcef9\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d6ab45ee8f212501\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"31e5777c34515d58\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"f78a906caf047b29\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"1e9a3f8fbbd4cdbb\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"db3285dbc06d31c3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"141654777780326c\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"4471507e6373ebbe\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0fc977a2d6ae6369\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"3b7c869158476eea\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"296c1e52dca8144d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"7a2f57f56f655632\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"3846220472164d80\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"23e5a07df9a7becd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"947794eab7b53a35\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"ab6bcc495350f842\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7377e780510be771\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b259e9209fffa4f7\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"a53b8b786e1b9b0a\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"14cfe55121e98f13\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"d3b51c14916af1fb\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"79e730461beb3b9a\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"52eff4efa164f7eb\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"a720450c0b8f34d2\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"4e4a906151265295\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bd74563c79a6c1ca\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"d1dc0d42ad2d7356\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2d90310201dd9842\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"47c7783a67d24c9d\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"0a66f98455db0591\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"eb5061e69c5966c0\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"21d0d008dfaf235d\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bf32e5a4a548b343\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"fcc5693aa4481571\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"bc657be13542cc47\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"20c8a8284cc2eab8\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"d32e90423919b30e\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"7e1e324a589449cb\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"7ff72c27b356cc4d\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b70a91d2a23ec6f1\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"7a879a39aa1c66c6\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"ac693555154593f6\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"b87f6dd20e03e517\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"6dd704cdb076462f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"c098aa9d399fd4ac\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"41bc63e71fb25354\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c160435c49263321\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f71ac51b74d26043\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"223669e93ab12327\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"8dce79a7b4358362\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"9b3590da8b269dc2\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"65474435f29931ba\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"e380dd277ad107e8\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"a216c04d978f2f29\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"c360f98c2aa05aee\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"7b99d063a04627ff\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9b5d419374de333b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"7cc0ca67495311bf\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"335c2ded71d7c84c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"5d24e4694b6929ef\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"46a2ff04f63b5062\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"ffeaaeb946191969\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"2fa8d1d7b120416a\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"90083e2df9be000b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"f555e8066efb7094\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"4419f6e55004a204\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"820bdda81d797744\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"742518b8a204ab0f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"09aabf8447a258e9\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"c245387ca1b15449\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"bf67d3e98b6452bb\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"be9c7960c71cee7a\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"adf84ad92a120399\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"9a1509f53d91b1e4\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"253dc2b1ea68c518\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"462a8ed7aff48e05\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"0eafdc6ac403a38c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7df5d7f069f8576e\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"ff696c268ce8c1f9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"05fe00316dfc8faf\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"ad7d001e4792975f\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"010b0de4022d7143\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"504eb162f184fd58\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d81a2a01b4bd28f0\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"6fa6311f006c82af\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"db4f42ca18703f8f\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"2368928a74d95c91\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"762318abaadbde0a\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"e4452a0f4ebdfe76\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"aba3686ce4474c49\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f78f60f4f30b5131\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"1cf95440008ac3a0\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"03dda4e40918a979\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"5f21699791155ab1\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"7f02d6a1496732b2\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"110bf71503312d70\",\"/knowledge-medium/src/plugins/geo/index.js\":\"8ea1df0adf746c2a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"061afe4094e99479\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"ac0f20a18be662c8\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"5e7d71989b7c4e3b\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"43bb0a370a9a0126\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"261ebae8ecf8ff4f\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"b3b886c8e83b72b5\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"9a72bdb8581b96db\",\"/knowledge-medium/src/plugins/geo/query.js\":\"facc9580f1b5815c\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a5c5915cec2b64bb\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0b2a7c68486e06f1\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3ed8dcb0843c6e1f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"189c567ec8a3456b\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"9d17972249224e27\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6b551e7a4c49a41b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"ed94689c40f432d1\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"e93a99593f39526b\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a7e887a011cb2e39\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"baa6d025a245eeb2\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"00e4553017d33f2e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"5d3653e850b71498\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5151f05e84eab2df\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7cfafb5168f09daa\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"d6551c0be11408a3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"cda49f0b575c487e\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"b35850cde8526476\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"fe2f79091945054f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"f32e9b76bc2ceb4a\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"fb5c43bcc51fe9c6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"1665255721295127\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"7ff28338990360d6\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"cf9a14108888f67c\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"1f81a74082bd892a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"5cd83c81a33f3b5c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"3d31ebfbd16b4aac\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"0147d757dc185ddb\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"c05b479d19eb1470\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"95dc6116f62cc2e2\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"abfc1f05f6bdb739\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"d87f9e18cbd1b789\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"4ff4be23e0f288b3\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"41352fc9ac53021f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fc4d1bb5ba8cd04d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1d35ca851e01e82d\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"0ad2740709bfeb0f\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"cef9d3284365de5a\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"c1a015b02cbfc916\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"0e92a7808657187c\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"7f13253bc33c8d27\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"842325a32a3c3023\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"a2eab0ae27f50bce\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"506f8426378a8daa\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"47dd18c3d18b2032\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"26cd99b694fe39f7\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"4bad0f62e9ea7f59\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7d1c94b759156552\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"34513e95f63889cf\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"2ad176694b293ecf\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"13bfc29e774fc9a4\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"241b3d26a522ca41\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"629295e4ae534863\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"41123de9bf1a001f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"b993bcb11fde89f5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"2fc7e4486a635fd5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"206d16cb3dce7ffb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"51cc2fd0d1c6df2d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"578afaa253d2fe1c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e88b82e0eb290f67\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6013ea32ecc6fb85\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"853c0b905379630d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b1831419469a1af8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1b4ff8e52f4f6dde\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"6f1a37c39a612ed7\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"05c2727a545405f5\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4fb3bb2dd10d9fd2\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e7eddf2fd14f259e\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"f76417e378b1b3a6\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"7bb31c3487e9a08f\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"096113162e580288\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"5aa2263a2cc06c52\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"7c728567320c9c27\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"01ffefb1f3f67e5e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"3861d8c70d7e50b7\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"f3e1b61d8b141057\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8e7a65fb223b66aa\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"ed0ed428e072ebaf\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"14131162279c90cf\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"c49518b16938c878\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"d06e14062da99e2f\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7d810c7078bc2ad0\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"814a7908d5e5a42b\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"961374ef1252098d\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"789b42ef4d977e94\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"4f25be6bdbfece57\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f63592f35eb5dcd5\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"9ce4ec44d8c81977\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"5cd88d9708fa1908\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"bdb832dae721de15\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"3c46b11429a5eccd\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"a26fa3a040c97614\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"d05a0dbca91a1cf8\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ead7b95080061ae4\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"68cd6f10ba6bf56c\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"46319a386c274d6b\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"0bd744e5224b1163\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"91d498099578f0dd\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"1a333bd1feb03ecf\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"a172715c08891796\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"5088ac98b0530dbb\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"0d84cc551e24f4b7\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"bd1ce38faf1306ec\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"476082ae188dbba4\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"0f3d2b48e9d99f58\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a7403759fb21d174\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"5480175fec69dc04\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"f830897e8cd0bcc3\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d1a9c98245112f8e\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"2c48843f99bc1e92\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"920be6f7b31371cc\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"c9b0f6069c880c41\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f22ff8f5dd84faab\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"4a456e8cecff29d3\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"5444bdd354ad05b4\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"66ad87df517412fe\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"504b8d427c5f502e\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"31ffb0c2ea65116d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"152e1f949c483afd\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4e39e8e1afe64af4\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"4c90d16bdc419b8f\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"536100692f187e60\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"65b1f72a9ba0d71a\",\"/knowledge-medium/src/plugins/recents/index.js\":\"494b79a49cbd0f86\",\"/knowledge-medium/src/plugins/recents/target.js\":\"a73508356ff3f48a\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"240718fa67fd8a3a\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"3dd6dbadc3619fdc\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"f5d2e820bb305e23\",\"/knowledge-medium/src/plugins/references/index.js\":\"4303e5678b4b2b06\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f89f16ec8fbd336f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"34fa21ea6580cef3\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ff0b2fd363e1621a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"f9863a41026692e2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e509a341006913da\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"8cf20ab29253d343\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"ff6c00977938563e\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6d05f95917670bb9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d1319cd9e4075f08\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"6d56cf7debfb05a1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"86f962426513b9d2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bda60f8932cd2371\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c2b9cd0472b81658\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"9b52f9a22f0f41e2\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"68b56c3730d7fc82\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"d40e6ba0f6648bf5\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"e9d84a23fe1fe9b7\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"b6c78906c7a673e1\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"af3c75398afff426\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a5bbb326f224607e\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"222a7ed5f05d124a\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"11a1d3e0507e88b4\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"5dad7bf89f1e56fd\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"2d8c59ef00f100a4\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"8785f3837b491fee\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"94565cd2a45b1878\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"6382dca03c609f24\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"1761dbd04b87d7c6\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"58fccb2317e896d1\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"dcd7c1e9e7a2ea66\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"55e152b5b65a2a65\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"aac678be041a7dbb\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"c691c18c8b5bdb63\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"7e2f909fe1872618\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"174a7b4b8e48af97\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"26153a95b7743f10\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"2ccf4aa8b8eb2101\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"b889d1856f8cc110\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"034f9b4797343d1a\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"22140ea3150e695d\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c0574af06d457e66\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"cf22fdfe82722b44\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"9f8c3b726ecdf522\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1962df99f7e8886b\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"d954a7191ed4d65f\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"a9c534579875dbb8\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9962a4cf83a6ba8f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"0b477f50caef8a63\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8ab32b229e7c77aa\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0d34f20c377e997d\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"7025ecc7c065cfe9\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5de21904d346ae4d\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"850bfa88d35f3f93\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"cf3274ad10a064a6\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5b1ebaddd541b2ec\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"3a6585384ffb38ef\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"798555dc8964a2bc\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"7f87c678773186bc\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"0733f173cfb19766\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f073cceddcc6360d\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"acedf711567825ca\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d71c4c2325f492cb\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"4f45dfcafe8e3cc7\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"8e20a453c160a330\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0bc950b639515ad0\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"84acad74653d5942\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"61e697a0635cf5ca\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a99c29b60543957f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"e4afae455eae49cc\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"552f705eb37aef44\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"31184967db9279f7\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"8797f0845f61216e\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a945deafc3fa349c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ee0c8806c39ba932\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"b60b192f835c3d60\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"db37f029f7d8501e\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"a66a46558521e51a\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"6c872c18cd2c9f6a\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3a63a56da4d4ccfb\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"df111b2b490dbef8\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"0f6810776f491489\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"d0be3438f217586c\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"30014ef5df2492b3\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"a281b050256a66a3\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"44e5ee8d30d64c7f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"3dd4190172e3fedd\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"083e8ee1b4e66806\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"a14409e1e4caf595\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"e041a5a4e76cf1a5\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"1bd69dc92b6ca12b\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"37eb3cbfd6342c1b\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"a62b85d4af5c1b7d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"d1a2bac4e2d3463a\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"0568ab9a8f5c61f3\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"f69633e2b9a3c80b\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"fa702198e8d98257\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8d8a959745b2e42b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"25bf9787318364e4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"a069a9e5f8b5e41e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"c3550169cf74af1f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"9b0d0b9a96ea1a8e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"5abc93065d22de19\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"35a0f79b19d07fe1\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d56d5d35d12b6a87\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"9875b399c1c669fa\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"225c08b407bd7f9c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"de5b7aac07ae54eb\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"1cd7f9cbf280e7bb\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"b8b3668b5529ecea\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"5a1f63bdff5d7de7\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"76a4f621d3b35c6b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"4eedfa0b9005e1dd\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"725d1233ad0cface\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"441a42a921ee721b\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"e11fb9b252982001\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"73d066f5ee0fa4ed\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"1d5fdc70394bdd3d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"bf790a1982230f27\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"125a1d4cb3f86241\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"a742ae6328689a01\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"ff06c396d6fc5c7f\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"7055ee1dee033ad7\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"814a113e89141e74\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"4e56dad9c4ca7810\",\"/knowledge-medium/src/plugins/tables/index.js\":\"d64bfeaa0d4ba130\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"569818b5b1263bdf\",\"/knowledge-medium/src/plugins/tables/model.js\":\"07ea425809b3b0b4\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"80409c9d16fb67d1\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"49167171beeacfeb\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"67bd06c52f6e8c74\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"a1fbdf9e8fb7c173\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1eb24b6ce4fc6989\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"0c75c33144c39318\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"a6992bbc542ef730\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"24a85ce7a7ebee80\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"558bd30b563c7e1a\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"74742b524375ed2e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"dbe5335e97a3a664\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"be591853c68f29ca\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"74c5e029c6617c65\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"8d1368365c11a74d\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a4878b8e40944ca0\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"c3a58e7eefa81554\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"63d04e588f22e93c\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"9afefa5269b5c9ac\",\"/knowledge-medium/src/plugins/todo/index.js\":\"c1ef2c671af4dfbc\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"0260e74396bfb251\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1343c40816942ed1\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"6807d0064b11179b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"f8b0e23a82e1d2df\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"ea5d4fd50b29ec1c\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"a2bd152d344bedba\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"57bbd7bf4918d7cc\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"34be2f548fa3358c\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"16404aaeb9e249f3\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"da0d918758a79dde\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"18917d4cb906aafd\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"af251624e3638caf\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"52a4970cc51b3e0e\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"58d83efd659f13d9\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"bb7e882ee79d49ff\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"273d4242c9e48bac\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"7e46a51ff9f40b65\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"444280765b2ebf3a\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"81e85de3b989aede\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"7fc29d630b936b73\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"3f2dad46b38eda82\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"7a35fbd7cfd38aba\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"d1f8130456a95ef8\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"cf0c598bc7b6544e\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"c4235d3a3d318841\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"47d609bfb2d1613e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"fe94349a0f7360ed\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"278c09cbee757a47\",\"/knowledge-medium/src/registerServiceWorker.js\":\"2960b403f52c71e7\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"b3ae224409e53e48\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a8a16baa5509e2f9\",\"/knowledge-medium/src/services/authStorage.js\":\"19fbadff792198f7\",\"/knowledge-medium/src/services/powersync.js\":\"41f7179e1c1d406b\",\"/knowledge-medium/src/services/supabase.js\":\"77444b1a8b33e56e\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"05e02b1c4c356e62\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"2371738a6753be89\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"ac279d39d94bbc00\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"4a613311d956a830\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"652668570f76f563\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"4ebb029c586bc988\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"25910e5a31db7060\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"d7f135c7494ac9f0\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"2a27dde1e25080be\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"17dd182e0b0eb184\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"02b24f7402d77bc4\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cb55e094f5743c10\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"41b230c990c5a8dc\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"123225e030f3f1cb\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"44ffe86940ada60a\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"793af58b63b70e06\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"8bb07f6964c9d5f6\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"ce13380dbcf90a50\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"445ba0991f899e3a\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"53a9314a4c4641f6\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"b1991574bd0c0a47\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1c85ef6b823b7182\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"62503df65a2ccaae\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"746f6ee5da5d69a7\",\"/knowledge-medium/src/shortcuts/types.js\":\"3254b58a3f83f9d1\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"cc0c47eceb3ce2db\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"ea633abd41ee932f\",\"/knowledge-medium/src/shortcuts/utils.js\":\"be6ea4232e453197\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"92d4343359677b79\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"5c5d304d8178a4e1\",\"/knowledge-medium/src/sync/byteTransform.js\":\"4ace4e1b68451d47\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"06c453d000c565c3\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"303cb711dde421fd\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"a7f90f4f49687079\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"652d8f370da4d73b\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"4edf4d592729597f\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d2980e24465c336b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"c6001ed07e451758\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"09341ff7c26b2739\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"8d9bbddb0caff417\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"a3b1226dd8785d83\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"137c37654bdbc74f\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"5c615f7d27f1e481\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"50d9344096546dd8\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f26aedec86dc9fce\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"d61f7e5053d389f9\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"92e4ecf3f6add064\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"2a17fb18b132c36d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"4254f909b8634f75\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b0035f44104036b7\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"cf1fd791fa2a7ae5\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"99f32095aeee5e23\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"a5e2e208d4414969\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"af6909b3a2805dcf\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"5102d916e6a53229\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a1ea9309575d4799\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"37be97410979c8db\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"5ce1043d07b01c89\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"eb3f2ea4372b3514\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"d8f5225ceb6555bd\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"f4a26fc2318ccb2b\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4ddf5be11815ba02\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"4df964926b2faa1d\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"65148fd2cf87b969\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"6a4cd291738f440b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"8b1686bb3fc310f0\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"e84971f6888bb259\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e054bdbfb6347149\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"39855c74e29441b7\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"606d4ced1f030071\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a92fcc91dee3b250\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ba6451b5246e13d1\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"a356a1a48841f4bc\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"8992435a8e724180\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"b0c0baf6b035f06b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"deb14209148ebd09\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"2d7b0a1e4d53d4c0\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"3c330eb536bdd73c\",\"/knowledge-medium/src/sync/transform.js\":\"232a32b96df5e565\",\"/knowledge-medium/src/themeBootDefaults.js\":\"2c7a3394ffab89cd\",\"/knowledge-medium/src/types.js\":\"5a2e8db64a6b4c44\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"cbbc38fc2a7b34b4\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"fd3367a0db846e08\",\"/knowledge-medium/src/utils/array.js\":\"83b631ffb9715b6d\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"2639f553e3d674ae\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"bd1433bc3eff99d0\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"d32475dc663d4853\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"f6c21a03d28fa343\",\"/knowledge-medium/src/utils/callbackSet.js\":\"600dcdcbf1334bc2\",\"/knowledge-medium/src/utils/clientId.js\":\"862b82f8e11acdf5\",\"/knowledge-medium/src/utils/codemirror.js\":\"05487ac2cc0c7fc9\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7a2629c9f1d096d3\",\"/knowledge-medium/src/utils/copy.js\":\"4e25c13012aec852\",\"/knowledge-medium/src/utils/dailyPage.js\":\"08086282358c821d\",\"/knowledge-medium/src/utils/dbForensics.js\":\"afcceadbfb81c9a4\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"08efd8f43cb74b6d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"ceaddbfb66191fc3\",\"/knowledge-medium/src/utils/dialogs.js\":\"261737c1783e7f2b\",\"/knowledge-medium/src/utils/dom.js\":\"47ca2a1e3fd5ec8f\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"2006d9f822ca9416\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"b067a294e931b0fc\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"4035a585fcd92ae0\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"912df82d9a2830c7\",\"/knowledge-medium/src/utils/flipSlide.js\":\"77cf4ade70d8d738\",\"/knowledge-medium/src/utils/fnv1a.js\":\"bfecb84487c061f9\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c477d8c4a1289a29\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"e4a6a8baefc34226\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"aee77276dec3705a\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"37c0fb91ce70ed08\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"13eb8eb86d33429a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f6704c50353a28dd\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ed636340202e6c81\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"8549a65cd8df4e8b\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"aa2e8071403c7567\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"189fabce2a3d2fd5\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"097f98d849ee3d53\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"cb97c0ea46e69656\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"78d83fbf22e5bef5\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"9d430e697bd39bc0\",\"/knowledge-medium/src/utils/markdownParser.js\":\"145065bb13905d0e\",\"/knowledge-medium/src/utils/memoize.js\":\"898a08c9bede5654\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3e0483303e4045f8\",\"/knowledge-medium/src/utils/nameList.js\":\"947775e10dd5fab2\",\"/knowledge-medium/src/utils/navigation.js\":\"affef94b896c88b2\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"3dc6df9263784474\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"3c55586dc8baf743\",\"/knowledge-medium/src/utils/panelClearance.js\":\"0bb2feb71903686d\",\"/knowledge-medium/src/utils/panelHistory.js\":\"56469d6a502608d4\",\"/knowledge-medium/src/utils/panelLanes.js\":\"6b90a6a1bddb15b8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"ae35ed0931a03165\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"c1a6e4f1c562271c\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9c78516daa142964\",\"/knowledge-medium/src/utils/platform.js\":\"150205f70b54161d\",\"/knowledge-medium/src/utils/pluralize.js\":\"08412fbcfc569b21\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"b5884bdf3426901f\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"9543606f4d722217\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"c4aeb225ac2889dc\",\"/knowledge-medium/src/utils/react.js\":\"402dfa5b032830fb\",\"/knowledge-medium/src/utils/relativeDate.js\":\"573b93fb0c6faa7b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"4ab8e0f030c2362d\",\"/knowledge-medium/src/utils/renderScope.js\":\"89cecb8eaf9df8ee\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"3eb865cd146390f9\",\"/knowledge-medium/src/utils/routing.js\":\"c28ae67ba6f4fa7b\",\"/knowledge-medium/src/utils/safeMode.js\":\"a71b67971aec92bf\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9f022b2ffb4b2a78\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"8a270897ad75a2d8\",\"/knowledge-medium/src/utils/selection.js\":\"7b4c403d4f18a728\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"4bdc9cc3cf271ab8\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"2f95a5f1ee78d1f6\",\"/knowledge-medium/src/utils/state.js\":\"e67122c286edefc1\",\"/knowledge-medium/src/utils/string.js\":\"47b383d68d075b8d\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"1b29dcd2ad00c6a7\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"b69db4187e376442\",\"/knowledge-medium/src/utils/toast.js\":\"c9cc1ddde4e5b432\",\"/knowledge-medium/src/utils/toggleStore.js\":\"c5b7a88bb50c37fe\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"a72b2f410babeeea\",\"/knowledge-medium/src/utils/userActivity.js\":\"e1a0b867f120226c\",\"/knowledge-medium/src/utils/viewTransition.js\":\"9051fd493269334b\",\"/knowledge-medium/src/utils/viewport.js\":\"2869278452734f7c\",\"/knowledge-medium/src/utils/webLock.js\":\"6bebfb821008a0ef\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"700728de63a4dec8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"4e013179cf97026f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"a164396b05e79013\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"042c42e2c6f9f4b9\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"85fe10e1237d66b5\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a7481ab3282c964c\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"82da9df7f4c6283c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"e657d78e878290b3\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"73277bee6e5b524f\",\"/knowledge-medium/src/vendor/react-dom.js\":\"ebfa7306e7b553b6\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"9822eab5293f3d39\",\"/knowledge-medium/src/vendor/react.js\":\"4f3d9e3346853816\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
