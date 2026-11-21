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
		buildId: "75433fdbbf0b-457af3a9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"0a6197b56ba2f03f\",\"/knowledge-medium/index.html\":\"0a6197b56ba2f03f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DdiqAC9H.js\":\"f09f198b25ce1f2b\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"b84e4cca2ffc81cf\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-C0TgO3jV.js\":\"ff933becd4f9fe13\",\"/knowledge-medium/chunks/FacadeVFS-Bq_Upz0w.js\":\"03564bf3250a7951\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CGIl5pOZ.js\":\"e24a805a376ce715\",\"/knowledge-medium/chunks/MemoryVFS-D010ncqF.js\":\"f5a864763ddebd27\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BxmRyo0o.js\":\"1b87168fbda89ebc\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DE0xqeVx.js\":\"d6a9c385dae43acf\",\"/knowledge-medium/chunks/Preview-BVNBsNOm.js\":\"9bb24b3f37f541dd\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-KtSjnqZo.js\":\"5d58cb464b30fa7c\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-T4YshU57.js\":\"1e5dcb68be33d043\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BEXoHIU_.js\":\"1ac02a38ab4af0e0\",\"/knowledge-medium/chunks/react-BmDAvja3.js\":\"ad44ee5062e099f0\",\"/knowledge-medium/chunks/react-CZzdJhkw.js\":\"f3933a6d30def8e5\",\"/knowledge-medium/chunks/react-CgilLgFN.js\":\"4c39a7c05f976688\",\"/knowledge-medium/chunks/react-CqnWjBfb.js\":\"a265b464f7b585b1\",\"/knowledge-medium/chunks/react-DNW_ieXj.js\":\"8e84eb2478b2dcf9\",\"/knowledge-medium/chunks/react-DRHNSNZY.js\":\"6a202484d2ef6c8e\",\"/knowledge-medium/chunks/react-DTWOYFTP.js\":\"b4ba78b17ba70adb\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DYF_LLTS.js\":\"530ac03d2fd937fe\",\"/knowledge-medium/chunks/react-dom-server.browser.production-rnGQNb2D.js\":\"417746ba4018c6fe\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Dlo76y79.js\":\"84b35b984725d1b3\",\"/knowledge-medium/chunks/server.browser-gCSzix6e.js\":\"e5d5f12e84f0fc00\",\"/knowledge-medium/chunks/textarea-DyeyzbZV.js\":\"6e8dbb9dae1a28d7\",\"/knowledge-medium/chunks/ui-k1sjeWnN.js\":\"b8a2edad6daed28b\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"40524f8f2b18d46b\",\"/knowledge-medium/src/appUpdate.js\":\"3c318922fa88c823\",\"/knowledge-medium/src/appVersion.js\":\"70caf73146e190e6\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"faba8e66666f2ac5\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"69628256204af9ac\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"19bd23e0ffb3f35f\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"7a0253d65cc57df7\",\"/knowledge-medium/src/components/BlockComponent.js\":\"a8316bd12bbbc0ec\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"cffa1025f4cbc2be\",\"/knowledge-medium/src/components/BlockEditor.js\":\"e70a91ef1ac39ef4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"632e753b0d7d326c\",\"/knowledge-medium/src/components/BlockProperties.js\":\"8ec77642d085e5a5\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"1bf197561fa8f10b\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"7f04c4d35bd4c62e\",\"/knowledge-medium/src/components/DividerHandle.js\":\"8e025662107d5bd9\",\"/knowledge-medium/src/components/DraftEditor.js\":\"208e9b999ae3af91\",\"/knowledge-medium/src/components/GutterPill.js\":\"9934b78cb162d7bd\",\"/knowledge-medium/src/components/Header.js\":\"58aad2e0819e1222\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"0437bf6a4933aadc\",\"/knowledge-medium/src/components/Login.js\":\"9dfcbcfb90d4d15d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"badacf21268517d6\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"1d7dded21f849240\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"167c8b72a8a79bc1\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3ddc1ca5c918dcf8\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"5ccf6c9d5984e8e5\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"c867dd6b873d56f8\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"74715287f21b1740\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d0def34e79f3899d\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"4d6ccaabecddb393\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"c612cf455fbe5544\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"cc0d9d873481ea17\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"6ff230e0874200e1\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"7c36ef9f2c76b163\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"eac9e061782a0755\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"19826293e9443546\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"5fab90a47f9b16b7\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"337c6487d29d330d\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"e2840ab5a7a5d852\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"2535a394dfd62712\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"3612f56ef6a7e441\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"c308cfeb32845c40\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"d97e2f881ed8ecbc\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3e89856afc281f27\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"76d1e53a498449ab\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"9658f11c5543053c\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"f98a36bc51614988\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"33b82217af30c993\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"ea530ff3f6ef7f58\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"84f49effe2116345\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"94c4de7120659845\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"59cb02d344969b6d\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"3aaa37d3e57fd975\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"353fe81d52969bf0\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"b5e97c656bc053b7\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"a9cafcca65b61b3c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"4ac19e97f52de56b\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"9c433ee10819cbb1\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"78fc7a94a69bb87f\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"45c3efe47ae742fe\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"44bbfdccd0e795ec\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"0292d30f6cd6a617\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f89e88bc8e73aac0\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e095a045c3bc4d48\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"dd3e9961af360f8d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"846b90317a01ab11\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"fe9fa639f115ffce\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"8a69dd10bd7f4a5d\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c56e4736a3f2efdb\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"7b14380a3bb9d791\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"5a0f1bfd3d8ac2f8\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"46548fc1f08ef6f6\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"56fa606aefe9d6cf\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"601444236684d457\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"020b953031c814a9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"c207f5ed2a3b98f5\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"b4717b305ed4743c\",\"/knowledge-medium/src/components/ui/button.js\":\"1b478434dab5775f\",\"/knowledge-medium/src/components/ui/card.js\":\"6cde839fcef4f984\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4e60399ed07f96a4\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"1a0abd164ce44c6f\",\"/knowledge-medium/src/components/ui/command.js\":\"261397c001ff1c59\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"322bfb697a02ec3d\",\"/knowledge-medium/src/components/ui/dialog.js\":\"3edbefb851546faa\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"6a7c7b6774ba2fad\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"145faf4d9bcec85c\",\"/knowledge-medium/src/components/ui/index.js\":\"e5f31d45e367f99e\",\"/knowledge-medium/src/components/ui/input.js\":\"75ff0ad39896bf90\",\"/knowledge-medium/src/components/ui/kbd.js\":\"0d9a0628eee4ada8\",\"/knowledge-medium/src/components/ui/label.js\":\"361fc6bd716f2b3a\",\"/knowledge-medium/src/components/ui/textarea.js\":\"1423ca129bd44c35\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"2e741cc4367139c6\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f9d93da124c767fd\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"9d5939bda68459e3\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"49a6d4e0d0021561\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"f500066752bef360\",\"/knowledge-medium/src/components/util/error.js\":\"09760b7d6288af7f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"be2ef4526a5a3304\",\"/knowledge-medium/src/components/util/suspense.js\":\"5942087ba1eab947\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"aaf564bee5af7f3f\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"65a12eed9d9b0cd7\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"7bd5396c64c1e1e3\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"cdee6eb830ad936f\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"0f902b39dc276709\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e103f6262971dbc5\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"4c8d0884f6dd9985\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"6279cca8e1c8a46f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"60103e6774b85986\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"a96d3e437cdc09d0\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"cb9960664eda3118\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"08c494f3c53e13f0\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ce51d8953c4599df\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"f4fd246d4ba309f2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"ee493d3a2fffd39a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"8fe2d89c8322bdc5\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"499353799325ccd3\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"17e79178adfe5b08\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"c6d37346c6a5ab06\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f7612d6814394d2f\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"a204cb549aa59d01\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"f5bb821382720a96\",\"/knowledge-medium/src/context/block.js\":\"fc52f777443963b3\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f6f305a51e3e98ed\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"dd9fd6e556724ef4\",\"/knowledge-medium/src/context/repo.js\":\"cff6f14fc9cd1ae6\",\"/knowledge-medium/src/data/aliasClaim.js\":\"56a562641800cc2f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"f281c56233a9a566\",\"/knowledge-medium/src/data/api/blockData.js\":\"7df48403151cdf61\",\"/knowledge-medium/src/data/api/blockType.js\":\"68c90533ce6e1dd2\",\"/knowledge-medium/src/data/api/changeScope.js\":\"8c155f3fe5585af4\",\"/knowledge-medium/src/data/api/codecs.js\":\"ca79461529e5f9b1\",\"/knowledge-medium/src/data/api/derivedData.js\":\"cc307988cdef8276\",\"/knowledge-medium/src/data/api/errors.js\":\"01b1aa3fd963a623\",\"/knowledge-medium/src/data/api/events.js\":\"f738dd6a6a762324\",\"/knowledge-medium/src/data/api/handle.js\":\"0700eecb7b147710\",\"/knowledge-medium/src/data/api/index.js\":\"c5247d7a73d84f10\",\"/knowledge-medium/src/data/api/mutator.js\":\"da2b9e6e39d03e27\",\"/knowledge-medium/src/data/api/processor.js\":\"58d6ffb45961c676\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"f6e1bbf94174a8e3\",\"/knowledge-medium/src/data/api/query.js\":\"31e4e13ae32c5d2c\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"f83a928b4f95feed\",\"/knowledge-medium/src/data/api/schema.js\":\"0700eecb7b147710\",\"/knowledge-medium/src/data/api/tx.js\":\"0700eecb7b147710\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"92c08279569f7de2\",\"/knowledge-medium/src/data/api/user.js\":\"d4b5ef2af7b660a2\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"b0f732d8360badeb\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"6417bf1646d9d8b7\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"eac1e70c24441fe4\",\"/knowledge-medium/src/data/block.js\":\"3b9fdd162369b0ee\",\"/knowledge-medium/src/data/blockCache.js\":\"3b512992ee6422e1\",\"/knowledge-medium/src/data/blockId.js\":\"8074b30f6c690226\",\"/knowledge-medium/src/data/blockLiveness.js\":\"2e5b1990808ec03d\",\"/knowledge-medium/src/data/blockMerge.js\":\"0af53471bb96822f\",\"/knowledge-medium/src/data/blockSchema.js\":\"36090627da7de0c5\",\"/knowledge-medium/src/data/blockTypes.js\":\"388b4e335a26a365\",\"/knowledge-medium/src/data/clientContext.js\":\"6e5f557474abf364\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ad306847c35cb062\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"0ef98093be4be0d2\",\"/knowledge-medium/src/data/derivedIds.js\":\"f08202a8d8e7e343\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2237f9505e399ec9\",\"/knowledge-medium/src/data/facetBridge.js\":\"97c414b9dcec2877\",\"/knowledge-medium/src/data/facets.js\":\"d6bcd72265735722\",\"/knowledge-medium/src/data/globalState.js\":\"2455bfa616e02328\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"4a71071f749ae3ab\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"eb7384a7753f2412\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"2845508637b9d25a\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"a1b0142cd98dbc3a\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8cc1ddfb225b6afc\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"21cabcd9ccb8d9a2\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"1e5ce4e00e792e4e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"6c4b8341e0f96551\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"ad55c92b79ad0034\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"e635aac6d37e3939\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"d6da6dbaf15337d3\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"5081cb868e50213b\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"cd3313dd6ddb2862\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"d1ed263e2af2482b\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"0e7eef4bc312473b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"76028c4e7e104134\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"031d285f46291514\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"65ceb4bd43d5970b\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"49843b1b1d5a7e9f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"f7304dfdfa9a0f57\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"559ac1c4a1c4fb0d\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"a33a683d90715d99\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"b5e76110b9c3c4b8\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"f105ab2edaddf486\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e911ace628ad5d86\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"4b1d14c8c6ecd773\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"ceb164bc2d2ab855\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"c614e877a9af2abd\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f6e0af6b50c00e59\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"a9794d2de1cf9b20\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"624ef813fff30fb7\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"0ab2513e9404f026\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"0004a29c3d369fa5\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"7cd2614fae7ce77a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"ae5416a691c07e2f\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8d498da0d7cbd7f6\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"51dc70694eef2dad\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"1e5477b668e54106\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"15def4c5881de263\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"e9fa4ee8df07a2d4\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"8b11cd3b9ebc078c\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"52184cf2a63306b8\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"400ee3cf722c0971\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0e0a42c3a2b4bc0e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"068aaf09f4787e4e\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"5c69a0d5a05f6968\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"56e485e0adab2741\",\"/knowledge-medium/src/data/invalidation.js\":\"40103a07a6168c81\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"6281e7318564777c\",\"/knowledge-medium/src/data/kernelPage.js\":\"df0e3499ea0ba8f3\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"c5e0102a98915652\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"2ee8fb22e21ee766\",\"/knowledge-medium/src/data/localDbStorage.js\":\"4470602b886ae5f1\",\"/knowledge-medium/src/data/localDbVfs.js\":\"290a80c15153b614\",\"/knowledge-medium/src/data/localSchema.js\":\"3b829dca919304c7\",\"/knowledge-medium/src/data/maintenance.js\":\"0d2e42cae0112b54\",\"/knowledge-medium/src/data/mergeProperties.js\":\"cf45b7254ed10139\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"31b5083931f75bfa\",\"/knowledge-medium/src/data/migrationsPage.js\":\"d5888c25d5a1f290\",\"/knowledge-medium/src/data/mutators.js\":\"b5cd994ebcd0fe88\",\"/knowledge-medium/src/data/orderKey.js\":\"35842138157f0b9d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"c860020dd192dd26\",\"/knowledge-medium/src/data/outlineSurface.js\":\"5e6207bad2d8fa73\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"b8d753e906a3a4e6\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"74aa58656721093e\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"896ddc450dd421de\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"5628f1507f302fc0\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"f1d6270321d2a0d1\",\"/knowledge-medium/src/data/properties.js\":\"74d4e036bc599e5d\",\"/knowledge-medium/src/data/propertiesPage.js\":\"ba37434fba23fe52\",\"/knowledge-medium/src/data/propertyChildren.js\":\"e781b4efa919a471\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"d86fd6a7fb80a5ff\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"36101bee006f97fd\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"865fd79cfbc6f4f2\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"491ab18f0708cdf5\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"814ca4ac73e2240c\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"2d733213dcf301cb\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d2f8ab6d54fc56f5\",\"/knowledge-medium/src/data/recentsPage.js\":\"404b4ec6d0d58b32\",\"/knowledge-medium/src/data/referenceBlock.js\":\"2fe09cf6c7be6114\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"395bb05536b56837\",\"/knowledge-medium/src/data/repo.js\":\"2d6a038617581de9\",\"/knowledge-medium/src/data/repoProvider.js\":\"afacb48ac07bbe57\",\"/knowledge-medium/src/data/rowProperty.js\":\"6e33a018c25255e9\",\"/knowledge-medium/src/data/searchFilter.js\":\"5c06734eb79c8735\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"ac2658cd57375a18\",\"/knowledge-medium/src/data/stateBlocks.js\":\"919a82c2c6b8b3a3\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"10df5fbcaba27573\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"f4cb5e5800e02764\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"c524dabcef6c0e48\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"a35d04d67b62a914\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"a6effc8906725a79\",\"/knowledge-medium/src/data/targets.js\":\"756dfc1378efc030\",\"/knowledge-medium/src/data/typeColors.js\":\"d114949d48d9ec8d\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"357a608a7be7a7f6\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"f3c4d90037bea0a4\",\"/knowledge-medium/src/data/typeExtraction.js\":\"425746f74c5cbca8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"c36da9481d493659\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"4b67dd42a9824d2f\",\"/knowledge-medium/src/data/typeSeeds.js\":\"bdfe1f72a60383ba\",\"/knowledge-medium/src/data/typeTagger.js\":\"ccb1873ddd96d07e\",\"/knowledge-medium/src/data/typedRecords.js\":\"60f2b1e6d357a7a2\",\"/knowledge-medium/src/data/typesPage.js\":\"224c08a6baf6c501\",\"/knowledge-medium/src/data/userPrefs.js\":\"dce54026f2ccca3c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"c89c966f436535f5\",\"/knowledge-medium/src/data/userTypesService.js\":\"2c55375f91ac3340\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"615ffe5f529ba466\",\"/knowledge-medium/src/data/visibleChildren.js\":\"470017db3735c80b\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"c09a41def37763f5\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"92bd9b508b40c67a\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"0784da65c3a5447f\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"d37400c118e9454e\",\"/knowledge-medium/src/data/workspaces.js\":\"fbbee8f3ae4224f0\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f5af903e3073e617\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"f5ed54539949cc94\",\"/knowledge-medium/src/editor/atTrigger.js\":\"55c225cc513e7228\",\"/knowledge-medium/src/editor/autocomplete.js\":\"909306ee4031f2db\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"00bf6ee761eb623c\",\"/knowledge-medium/src/editor/contentFlush.js\":\"68f9a46b61206aef\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"0c35eb57327c2b33\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"3a8446c88c122044\",\"/knowledge-medium/src/editor/insertImage.js\":\"8de60e6f6d880ff3\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"411c12336317f0ec\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c8c701608222c451\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"5ef4e6990cfcaff7\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0e1a949731a8f788\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"968c5005b72dd777\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"71c253b920a24aa2\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"e04a766eb0571c50\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"f754732fcc05e08b\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6ff5582005a6fa2e\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"e7d5f07ee440b993\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"3588ead6e41cb71d\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"2bf6ad20dc5ecb7a\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"cc7d42cd3c1aa024\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"4d993bb3bb6689f5\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9e53cf38af9c75ab\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"cb85abc4a3573b9d\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"bd2c931de3fb1b17\",\"/knowledge-medium/src/extensions/core.js\":\"8cc46ae1ceb1bc8e\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"2daca5131f438329\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"f3f439d358f76d5d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"5bb4d4a85df288b8\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"55069f847f9f183d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"64d4408039a81324\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"a93ebd086457a780\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"a2390b54b408d03e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"a0647fb9e0fab7bd\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"866893cf6fb6207a\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"3656ef44e9817b6b\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"77b0e83c6c810cd8\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"10cc5e1d051e8d88\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"e993e0a2546f25fb\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"d8f619a4ab1a6b20\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"d17724520cddf369\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"b85a5b18e15954f5\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6c60956245065cbf\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"9dbeeaaac7fa6f97\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"052cdd01a895b541\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"e050dd95e65667b1\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"5ca90606b832051c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"5b8439bfd4f6bbbb\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"d8bafa7031a4acdf\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"5153802b84b32d7e\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"012d78dea87a9a32\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"a2a67985cd177793\",\"/knowledge-medium/src/facets/facet.js\":\"0322aa104c9d08a9\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"0100c70f7fc03f67\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"4d31eba6753afedc\",\"/knowledge-medium/src/facets/togglable.js\":\"1e73a3fd0ed78886\",\"/knowledge-medium/src/facets/variantFacet.js\":\"c4502b6ecec5d84e\",\"/knowledge-medium/src/facets/verbFacet.js\":\"fb70f3606adc55b2\",\"/knowledge-medium/src/hooks/block.js\":\"e8b98a540f48bbe1\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1ff33369a67cc118\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"60a61ea5a17b85ec\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"ca1a65729b0b0867\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"2caec86691b202b7\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"397b85cb843fa163\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"25ccf9b7015a65e7\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"55e66d83b27a8beb\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"7e93b727b8d96469\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"8ccfdd01065fa540\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"a45d23a3c890594f\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"69319f01e6642c87\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"78b098748963d390\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4de362efd4c5e3ac\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e8cbf5b447457a23\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"1489167c241c83c7\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"d5f7e8306eae7dca\",\"/knowledge-medium/src/lib/utils.js\":\"354ae1b088e8a140\",\"/knowledge-medium/src/main.js\":\"875c1e5ace2247af\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"6f50a2b7e3622d37\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"948a15a2a5d5b470\",\"/knowledge-medium/src/markdown/context.js\":\"4c746f5a9681d7b8\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"ec7729097cc4e593\",\"/knowledge-medium/src/markdown/extensions.js\":\"d530e39a76ed66f5\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"e22758f425cde25f\",\"/knowledge-medium/src/minimal-editor.js\":\"3dd5b9bd3a7b3cca\",\"/knowledge-medium/src/paste/armedCut.js\":\"c24f72351aad05bd\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"1cca5d7f7664108c\",\"/knowledge-medium/src/paste/clipboard.js\":\"72ca56a53a635ffd\",\"/knowledge-medium/src/paste/decision.js\":\"7324f11ca54ea00f\",\"/knowledge-medium/src/paste/operations.js\":\"63e8e40b8a2bda5c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"a35d5ac658da0cef\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"096babafce93ceec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a2559c3ea3b62010\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"f1416969b3591e08\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"79f49cea9611879c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fbb5121d731400ed\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"514425683c8dc2f2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"af7e33b2ee60a432\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"2ea059318347b710\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4fa0647214cf84b3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b5771c664f464dea\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3732ef6995786492\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d0bed2ee33447351\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"858fe33dc1a7583e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6c9f23d16305b0df\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"63dbf273a8f9d5a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"885385f831ce0913\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"99fbc78e97178298\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"fdec6ec1cb174fbf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"78d98348afc80711\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"6ee02c944af88592\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c1f721d85b1d47f2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"69501034cde88ac1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"4cc3624549e40a80\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"f955c10bf2654d87\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"33947596912c8587\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"4350e9ae4d6447e5\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"ab4a4d2f721545e6\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"0c1343f1d29c7d2b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"d772977727deffe4\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"52bf80ee6d9607c6\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"8af397a801fc6842\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"60f0cbdb6dc15a82\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"2279247aa4870b8f\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"6bad0bac9d3ddf58\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"3ce2c0d531ef4c9e\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"c8ba9a9f283f2c72\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5349c720aedd5e38\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"9d26346a9b709ecd\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"d0f36271e8c17f56\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"637850273d7f156d\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"ec4f6611abf170df\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"0af12b4830f0eb95\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8955ebdf809b0eb6\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"61dfdf8ebcd025e6\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"1bb222064343f726\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"cc43c3656d829cde\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"df7aeb80035171f1\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"e58b2eab99c3d40e\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"ecdb9b21a9967e5b\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"b567b14a027e53eb\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"16f9cf24609967d0\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"c2b0b8bd15aa686a\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"a9f1d3c43a91a93a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"d51250544aa13a53\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"221ea0c169ec0455\",\"/knowledge-medium/src/plugins/alias/index.js\":\"288ec81362acab66\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"92dce48bfc5b2137\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"326a0c3305e2fccd\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"0a955f6f64fafec1\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"af52f6d839fb2883\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"173411feb9170f14\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"b0d617519fe98ca3\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f52478e0c5df72f4\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"0244a51d7e38f8e3\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"33a5170f50eb9cb0\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"818a695cc4799228\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"dc5bf3f208a85e25\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"4d0da35229287615\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"73cc448e78c95043\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"7708319e6b9e2003\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"970a275578c1a12d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"c9307f252c216814\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"878a477130a8bcf8\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"9bc7238baddb70fb\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ccd255bcd54a369b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"bb22332e2397ea37\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"6044ae418bb651c8\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"97042235b0ab911a\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"7fc6cc7b5e15b0b0\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"25e248244f107f18\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"cea571583d72c961\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"49c48f61ade04fcf\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"d8a4a210e92316de\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"ff493e741bf158dd\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"464a7c099302fdb9\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"1c1f95660c972712\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"d80cf2b2352b0c06\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"73e0bc6361d9e571\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"c8b44be8b256c1d2\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"c916f69897a8f97d\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"1de126615f7ec393\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"4e36338a9fc3fcbc\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"7c526097f4c32387\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"d41f7e9b25d91640\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"442b41deea0a6bc7\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3d3cbca1df435d8c\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"8588e74cadf419f9\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"00e265cb00fdf441\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"78b5c0b09e34c363\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"fc25356acd8c2662\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"77acb44000abf076\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"7a55955820e8c01c\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1f497db56c210258\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fbed55cc1d525dc0\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"e7f9e8c543ac444e\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9892a5c6837ceeca\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"9ca38954215d2728\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"37405e445223a301\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"44dd722e208fd5ba\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"f49ae1b09f226dd6\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"c483b1d5c234ffb0\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c0e31d4941046bc3\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"db91f01fa69679bf\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"2d79fac1e25b6c77\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"2466fb4ab3a726f0\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"03b101abc180b94f\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"b324196bb854e62d\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"e4f128ed4a4d8628\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"cb6676ab29270da8\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"12841bbba4886ac4\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c15e4c70c07b6d78\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4050c4b750aa5d61\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"85b3f139454cab62\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"384ba163cc4be97a\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"ed0e1f0a73e32422\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"e29a848de221757c\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"4b98ada46c6b361d\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"af1ddb525b2e8f45\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"eb27ac57ba020925\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"36bd6b971d344fa8\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"dedec058d9c5fa83\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"7d6a35dd06eab4b6\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"c205e641dbe9eb83\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"84136c1d229abfd9\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"6c55dac0187314a1\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"c6f930ff9547fefa\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8f029c848ab3b2b0\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ced11dc9111b1b40\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"3c779f4a3272c58a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"221d5f81ba010718\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"7ba05c25fc49734f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"078fe2cb2886f3c1\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"050d2c5e19c84831\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"3d7c8e529f38b804\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"8aabb811af43d6f6\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e66be7c9f2db8d0d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"df7f092938fe40c0\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"30b05a328633bba0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"9c94eb84c130be2b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"0aad689a9526ff73\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"51f74e180266f243\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a3694dd19eca704a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"138e598e64ea4526\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"12e4410cf5559f77\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7a570069806b321f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"193f4cfce82ad9b7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"99ee3fea9a93de7d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"27b7280a2cc8b6ce\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"c74e1364d58a375b\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"8a861f0e2fa708ba\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9411c6902c4f7670\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2f598d68cdded58d\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"5e6d276812612b02\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"51d204652c24d70e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"997ce2e9015dbfad\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"dd8b99615126dfe8\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"a5125902afe53639\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"7a59ed4ae82c05fc\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"f9ff33cc5b194bdc\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"ef463dc845742103\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"35eef8780fecf06c\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"52721fafd97c1012\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"4c6c51f350482227\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"ca8e85df8dcafe14\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"79950c4e9acac5ea\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"a317ef2999bd8ae4\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"80aff2ad0764d1f1\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"8c9d9fcb944919f0\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"7c890fda579cbc2d\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b17efbfe254ca1e5\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"cf10c64cbe9d27a1\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"5d311f48093ec328\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e9eaf36877bf318f\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"05251f84813eeb7e\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b987e26235b03936\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"47b31b6414e676ab\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"2e6bdbc73009c929\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6ec85dd4d373d6c9\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d581d47467e0ffcd\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"39e16309bcf65088\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4566dda465ba5fd9\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5aa7158e139b1697\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"5647ec5ae901ea75\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5aa357a91c1bdfe6\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"7c6e3bbb2e960e67\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"70cafd796b2ebfcb\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"8b421ddf19cbf98a\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"f32b39fc457ae4e6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"33097bdb501739a5\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"c8510cb878f38f2d\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"2ec303502b20ac2d\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"9a77bc5e39f09aa7\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"4a42c9c1e9eb7c4a\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"176d28863dc1105c\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f34a085229bd078d\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"cd2fdea787fa8085\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"a0a4eb7e29a2520c\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"9574099842a06289\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"3185f6ab8addbca0\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"7f0dc801be7ca495\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"6fc8b7e649419711\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"46bf2cffaebe457d\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0a6b3104a56c6a8b\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"b007bf9233bf6351\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"9c9892aa5d98738b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"a68c5e9aff8657a0\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"1d071be2c0237329\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"00ce9f00083a3d06\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"9e3de10cdfc226f0\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"da393e5bc1b5df28\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"739b6b777a00b582\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"25aa226ff7d336ef\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5e528f3a575a941e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2efaa6a258a57bac\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"16af672497d59087\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9df85809ee1b5bc0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8556aaa1630fc118\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"b0cf1d9b118a7046\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"e4b4b0cb84a2db06\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"741f7a7722ad4fc5\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"0bb36be40ba7a07b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"86e1b71059451230\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"50710ea46669d551\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"47aea2a8a8bd2ddb\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6473d5a499905a26\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"72f2d173b0d0570f\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"4dec9e7f068d52b2\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"2f4f748749d4034d\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"ace2f276fee8add1\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a493e1b9b22dd44b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"83829920bb04c07f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"ef931ef883a91102\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0ad6eb13839aedc0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3f3c34a4a909100a\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"6b7a0f7ad8d181a4\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"8a2e937a13885702\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9ff5fbcc7761451e\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"5e78d7c6d85cb988\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"1ab758110a0c20c0\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bf51025744f81938\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"efaa7f89db06b7f3\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"439e18830bea3020\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"7bdce19326bcd528\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"15ecf2653b41cf8a\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"5db719d615d54da2\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6eb4715376356d15\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"298d676295035c9f\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"bba912b3d3f9e166\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"7e50d0d7ecec737a\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"bda5062f745894cc\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"4e28ce427ddc4cfb\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"829c8998b3b93c93\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e020ceefe7d3471e\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6a28d6997b4578e9\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"7a342c99384e6886\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"e91b2c161cc72eb9\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"cbb769ecdeb1d05b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f905abc2f2822d62\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"26b429230526a54a\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"d525fd4c0ca28eb9\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"21411e42efa94785\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8d33bd49c82c75e6\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"5cd5e73eadf971ff\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"a557de84185fea51\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c6253656ba69f0fc\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"3d91e026c2221354\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"1a8be929d29856ce\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"ca71c050db7d2268\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"557b07c287873afe\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"7afd9067a13ff4ce\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"37f6b4280e8283dc\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"5a9e9363e48f409e\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"ce7942db7a043fd0\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"01ee88642f6c08f3\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"826f4d57a76c8e23\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7ae3b879e356cb85\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"74ec1e4903d73528\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"95d276fee511528a\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"222a82d77f541b15\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"c734abaab3641ae1\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"cb5ea0deb5415090\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0a2af1c2329305fd\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f230b693d464dbfa\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"5a8de12f29649acb\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"03691416ae06fa13\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"487811ec980bdb94\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"9d2399df8b5335d4\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"66de8f4db907c6d7\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"dafd1f9be3dedbfe\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"afbfe17bc67af328\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"3e318e7f4e58226a\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7bf6e4b68adac4be\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"f16030ab9372e7ea\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"047c427704c3f389\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"72e96f5d12d7842b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"2645667e8c163dbc\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"484e364c0338d56f\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"6a1fef842af5e050\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"acfad619bf683f8d\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"3d072688cdbc3b38\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"238120cede4220b5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"29b33fdf9db4a2f9\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"add9bb8a8ca852f6\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"faac03b053873c27\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"ea1545f28f6a8e2e\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6a952877754cd5dd\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"e4bf16faa9be4a70\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"6867b4012a42564b\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"1a77c9697612d869\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"951e01b63e471d65\",\"/knowledge-medium/src/plugins/geo/index.js\":\"1b1135367438e2c6\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"efa7b2b1e81d7841\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"91fa24092d9ac206\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"0f708afe9b71cc08\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"582ed58da8c5872f\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"d01be31f5705105c\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"8ccf353638753385\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"5dfe8b624fe1082e\",\"/knowledge-medium/src/plugins/geo/query.js\":\"779a573125f8c271\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f88ac9423a44d755\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8ecad44611c3e6fc\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cf110cfd7c6e0da4\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"31b628c85dc28ae2\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"15c452187816ab11\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"46dae1b1e6310503\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"7f902a2b3bc95da9\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2c26be52ccb6dd49\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"d1443dc4fbe62d9c\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1338a7f88c96950b\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"82170c0774cd4973\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"3d62e99fa9d82e28\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"01efe1c58a39506c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5f7949e185723991\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"f94135d08315a4b3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"c4d5184308bf3259\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"ed15fc3f356bb11a\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"50f33166ceafdadb\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"68e75777627b62c8\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b274fe51085ca332\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"93bf72c449645ad0\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"13ef1988a43eb881\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"6630a226a9f2ae77\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"78242a2f47b05079\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"b559e54b7729e39c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"e8f8ea27faed5fb4\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"68f5ece8a0cd700c\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"7e0afa5f39461af6\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"287cb62766c8599b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"a9b368411afdf545\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"2cc27f565e0b61ed\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bf185d70e087e820\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"4197b26fa8eb0245\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4e4ce91e74135737\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"81e517cb4f904a6a\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"773dafda6a283c29\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"330959a11385de00\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"77834b1f0cb32db4\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f4493c521a3aba33\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"fcb0cceaef36d97f\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"0c94fad86837dab4\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"cf9cca5711f4735f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b0257755dc4bd4c4\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"5adb494eb3047bc1\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"49089b7be3464c9f\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"2fcdd1721e5c1398\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"0c502677d8226147\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"6a4fa0e65635ebee\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"03920801c71698d3\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"a526fd858298e6df\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"6db7890d58bd995e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"2a91e8bcad968f43\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"85f043d9e29e8456\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"27a38b32635b53a6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"0af206c068de297e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"63f1f165e9b5efdf\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dcec4bdcb4348973\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"8c7faf3bb483f627\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"ff2129790a5d8612\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a0665a8bc5a0a358\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e62af2afd9c7e960\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0cdd6c50cdf5b980\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f254251c2f31292a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"425644aa9a79e05f\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"268e1d980ea63953\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b660c726f863ac00\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"92282d26d7c9bd3a\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"0b4288b5874072a7\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"5aaa7d6fb1a7cb26\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"968b1511d65a4126\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"1e8d184de0f8101b\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"29a26f9fbc32a13d\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"8bf315b2cf528e9b\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"cbb55f018816fb67\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"5e12ff81d79ded05\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"bc97b8459f95c9b3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e5c1cef0b5d5e39d\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"5eabfe3ef7b790e6\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b010595fa0ca67e1\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"ff71fd6ae02a59e5\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fd6d0bb4889ca453\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"658ab00a028cabcb\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"46512dad872f1721\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"da6fc27efe95ebc8\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"3d9af5f0f3b8129b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"54186b5d457a451e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"61a42de653a384bf\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"446ee8fbc785a054\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"5ef78061328423ec\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"40aaac69cf466f4b\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"b323cbc4f801f896\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"72c270e624cdb5f4\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"9c72b66e719dc22b\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"a90d1c20b0efdd23\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f19f647bd77df0f9\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"a83c09f58d1de8a8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"0cc6500324569abf\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"6eca28647160f2b0\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"1879885e0ffd1877\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"eefc865070dda8bf\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"b5ec6d5b437282ca\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"093faaa894cafd0a\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"7fe7d71f5a00af68\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"14750ad30705758e\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"8660e78d17174b10\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"98adbf338a497029\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"f64ac914684f66b3\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8e5b40271c3d3a5a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"3b0ce69d6fefccb8\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"1c0afa99fbe4f52a\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"2b8415de9c19c58f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"81a1b62e86d7a550\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"89163a3277d7a571\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b3ffc48bfbdc61a1\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"d7192f378e75b480\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"137337dbdda9a1fb\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"58056a09b588afb0\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"0b4aa1c87cbf6d45\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"509290de53138e7d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"036f2d2c68f3baa6\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ded89f004610141f\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"30179ca08e3aa325\",\"/knowledge-medium/src/plugins/recents/index.js\":\"a1a7626dfe2b4023\",\"/knowledge-medium/src/plugins/recents/target.js\":\"ab273586251c56f9\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3c9e4f66355441af\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"24b2741a7ade6b6b\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"777ad51fd6452d0a\",\"/knowledge-medium/src/plugins/references/index.js\":\"7da94592e911582c\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"441057f356a828ad\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"43d89bf5fa386eb8\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"7c04df8c76464cb9\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"50d6a339fdbc31e0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4a9e403b53d26532\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"8d03ba42239dab25\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"2c11fb2b7f16a4ab\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"63cb5b5725185a1c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8b3c412da50734ae\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f244d8ead27b1df4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"04385e66dafd85ef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a4ad9caa5ad8ea18\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"1c017eea6f836ef3\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"3770f6df3105ffa9\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"6651d1f2341359e0\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"bfe14404eb7d48ef\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"80e5e595abcf3d0e\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"92f20568437034ac\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"bd965885f2d4dcdd\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"e9679f6a73df3ee7\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"609dd66fdabbf421\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"150226c115da6317\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"d825335a9b6baa6d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"b94bebbc592b3c58\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"87589fcf801b3fb6\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"f8fb874792b857e8\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"af5ee51d0c8938a8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"64f1e405d07a3bdd\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"d470f50ff7b6dec7\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c00980f4e2e74020\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"f64397e7d6b051a3\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"315c0963763d39e1\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"963a45da1e0bd881\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"28db978cc8d48d31\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"f86a7818366f85a7\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"02783b72f46faed7\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"7adcb65b35462634\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"25676e7e0934604b\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"1072c9bfae152fb1\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"979b6ce9a3f46d64\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"2159f8db4fb0f315\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"4df8a0108ebf56cd\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"67d318aa30da1b1b\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"f760cacd5277ec45\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"1bd93ce1c67647cf\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"d8a9a464359fda1a\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7f6c2d31a9b51e31\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"5a9e7299fd038d68\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"cf10549d3590a0f9\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"cea5358cd5a67267\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"8ae152aa3b8aaa46\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f11792e375dd7854\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"aaa59bc8d2bba724\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"39586d3f9314f3fb\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"94b9ff3a88a458cf\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"0625740dca22b30d\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"955fad1dec75669d\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"3f4829055c3910ad\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"8f7a93e6a14222cc\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"184c9679364c1e68\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"26db30650219a763\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"a4626066f08319d4\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"3839bed21eeddb92\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"5f7e2d63da45fb40\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9ca801e5afacf74d\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"d50175a11b38ad1b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"19834bdbac70541c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8ecd2ded97af2680\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"aec1a426ad9b1f0c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"452eb703d26be773\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"91707bc4f83ed5fd\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"1b25bb4d892c9b96\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"57e6cae2c0cd666d\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"379ce6f735848b38\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"c6b6c4fd3f6854db\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"26be458bff406262\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"98ede05f2c14c685\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"ec6e9fe3aaff6a6b\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"daf57cbd3a41a09e\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"b51d37f97f448ed5\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"074c62a1412033c6\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"abb98507678612f4\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"afeeebc1ff33d45e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"dffd1fb3ed312366\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"bd24c876112855b5\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"c39e5602b27be7a5\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"2314db0533dfe0af\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"cb1e417639174cc6\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"6d17050d6610188c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"6dca8d93e896c51a\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"67ace65b53ce9322\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"ec499b91485b544f\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"2180ae073f97d8a5\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"02685debd87bca16\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"dc1fd2f67e6c5190\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"f01178c17824dedb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"40931c753f28994b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"92626b58211ecbbc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"c9d1bde99b5944e3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"64a1a3a83c3fd130\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"802e1511a91c84e3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"aa4a0a72b2159a20\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"81e3cbfe66deedff\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"893693d65d394b34\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"57fb76b4e1a0d71c\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"ef684140055620a1\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"d30a0379999d4c44\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6378bd4111cdb0fd\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"698a338653f5b885\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"2eb5a8546bdcfef3\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"7bb2155b23a8f06c\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"5a7428ba417f1580\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"8da36c71c9072ce6\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"62f8786da4fac422\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"d24269960097a316\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"42e03b754ae43962\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"620d1ac85fd6bbdc\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"105d816dd9f00721\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b599c1eea7074924\",\"/knowledge-medium/src/plugins/todo/index.js\":\"eeb99a21e34b9ffc\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"925407010828e384\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"667d57fa083a4f38\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f63ba92c84a908d8\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"34f0971c940b3ebe\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"4c7a7201fd87d233\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"892d041d3a6d2268\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"8bad36d6a2bd165c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"32f51bdbd68e3a79\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"140f23127c5f0e48\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"b6fc9d9e7f5508c2\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"9dee5523ef1ff1f7\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"3523a939e6e62405\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"33a3c6a0e59afb1c\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"f273947fabac307c\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"8b907b7beac9a756\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"651b47ddab998f13\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"7a03f35919142903\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"41ea44ac8f31d074\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"f6c7ed9df046291e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"83fbd3dfb3caa7c4\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"0150d685b9be106e\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"414a125aa28f010d\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"5af243a88976ece7\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"7489460b7dfebb8a\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e9720d0d1396c32c\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"dfabb0221207963a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"24788570d3777154\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"335f4c069642b0a1\",\"/knowledge-medium/src/registerServiceWorker.js\":\"291d38a90d9499c3\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"d7027a927bf87f37\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"f458e033c3497bc9\",\"/knowledge-medium/src/services/authStorage.js\":\"90e6b5c9b4959844\",\"/knowledge-medium/src/services/powersync.js\":\"574d6fbfdb0108dd\",\"/knowledge-medium/src/services/supabase.js\":\"2ed515f0fba4e596\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"79cef29e949a38ca\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"058b244b9db90755\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"18fd72bccc12833e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"83cf4a8994149992\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"7f6d237069d1f553\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"74197c0124f9fdad\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"5163a0a160080d48\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"b3c4543376ab0d24\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"a62e43901ccdadbc\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"fe734dc83fe90aad\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"3f932565527d0902\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"1ae5fd68650f5dfc\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"67ae5c05e7dc0637\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"815c8985bbead810\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"caa9cdc8093d0598\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"2e064108ccc02b79\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"b3114e0f33e13a1e\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"7a030817003e0b4a\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"5c0ad79204894f3a\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"5e66aa70445d8d5e\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"76cf1bc97255817b\",\"/knowledge-medium/src/shortcuts/types.js\":\"05de617b3ea0f69c\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"563934679d24f815\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"48f76b5b98a97c6b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"5b707bda4df5d7fa\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"af0565777d8384e4\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"d21aad44e7251ab0\",\"/knowledge-medium/src/sync/byteTransform.js\":\"97d024c00e801585\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"a8747ac80a6f20e5\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"617a2730fa95864e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"d719839ec0131d63\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"defdddd03b7d8cee\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"c598e875f4b9b18b\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"069bd91d48e47a4b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"979d965ab03d6204\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"e38ce05b93c0eff9\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"21963e5aceeda3bd\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"bbb9b54cedae0bb1\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"62cf348dfe203a60\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"f29edc8792a8439b\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"e87dd25442f6537f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"59596db6d3176278\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"2212690117ae8169\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"eb0884e61e696da5\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"16de55df6dd1098d\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"158966831c3679f4\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"4554c11ec1e06845\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"94df771d00a33c95\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"d9f3ccac8a1f21dc\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"7ae1f99b1649dd62\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"81863586c95f4d1e\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"86f1b050a552ceb5\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"9e6028fac67403c2\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"350c15b1557816ec\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"cb726d2408ea630b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"888482666abceb8c\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"b10f030a05994276\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"24ff1e61de55a1da\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"5e59a6ed116e2869\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"53f30e17d9ed0d1f\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"ab7ed0f0aaed5775\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"663803a7f7cd6d7d\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"b85e5fd6aaa1cfa0\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"8440fe859f17f946\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"53e2113488c845e6\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"cd1c545f13a3fe90\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4cb7fe21ab29d3d0\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"43445d7beeb494f7\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"e597c93ee21e0020\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"50799288d803bf0b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"4489c0dff16b22d2\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"dfa7cb1d11b11ae7\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"381d8792ea2d5fd2\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"b3cb6c8c6871f4d8\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"3cf1ba81a7c7be29\",\"/knowledge-medium/src/sync/transform.js\":\"7abe7c60623b8d99\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ba8670c65d5182b9\",\"/knowledge-medium/src/types.js\":\"b597dbe6f46241c6\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"bc2dff3487ba014d\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"616c887b3a1f73a1\",\"/knowledge-medium/src/utils/array.js\":\"b2b757321964d274\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"620385bf3d21f311\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"d9a97225beb0c316\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"e094ac9d0ba155fd\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"00bb7a2c83f5988f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"2e1b7895b6ed13ac\",\"/knowledge-medium/src/utils/clientId.js\":\"b74a6a750f3d9af8\",\"/knowledge-medium/src/utils/codemirror.js\":\"5786a03d9c9ff8d8\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"2cea34bad72fffe1\",\"/knowledge-medium/src/utils/copy.js\":\"33f4c01ab4c23ab7\",\"/knowledge-medium/src/utils/dailyPage.js\":\"b858edd385a02122\",\"/knowledge-medium/src/utils/dbForensics.js\":\"4ae10b0533aaf2a2\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"bbf7c511f8241ffc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"ab08d7c7a2e05e47\",\"/knowledge-medium/src/utils/dialogs.js\":\"9f4e99c134055393\",\"/knowledge-medium/src/utils/dom.js\":\"f9108c5a010a7f90\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"763b832483410cf5\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"f11990c524b998f6\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"0c70a90d7c652675\",\"/knowledge-medium/src/utils/flipSlide.js\":\"dbe3f7caf8cea067\",\"/knowledge-medium/src/utils/fnv1a.js\":\"0f826e26b9f1fcea\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0a3442d89d08b4d9\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"e86a8c1b8440dbb5\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"91eda315eb789e61\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"ff9ae9afca1e5291\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"e4333554875d3189\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"972e9b3d828f18cd\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"13a989c032432341\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"f7515ede783035b2\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4c7171f1b8b552c1\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"58d92681dfbbb1e7\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"df5f3b06c70b9154\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4bda0ce505861450\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"25b5f51c8b4295b1\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"d335c971a85cc26c\",\"/knowledge-medium/src/utils/markdownParser.js\":\"0e36eb140f70ef48\",\"/knowledge-medium/src/utils/memoize.js\":\"0eb3a8a68674b784\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"8453b09511cc2123\",\"/knowledge-medium/src/utils/nameList.js\":\"220eb2a00a8f4143\",\"/knowledge-medium/src/utils/navigation.js\":\"ef601ba07f262778\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"9ccdbe336be6239e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"e6b2e6b4ec0d6078\",\"/knowledge-medium/src/utils/panelClearance.js\":\"6cbfdf963aea8a8f\",\"/knowledge-medium/src/utils/panelHistory.js\":\"2976a99e304f20c1\",\"/knowledge-medium/src/utils/panelLanes.js\":\"ddf70673b76989b6\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2b00d5a08f000578\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"0d47c9a69a5071ff\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9b1617f6592a24b7\",\"/knowledge-medium/src/utils/platform.js\":\"101910706a177981\",\"/knowledge-medium/src/utils/pluralize.js\":\"f4beb5e539f618f1\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"cc56c379e5a7319a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"ec5c2e34d17c29dc\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"74f1351157199e33\",\"/knowledge-medium/src/utils/react.js\":\"b9964b3f18609bc2\",\"/knowledge-medium/src/utils/relativeDate.js\":\"4cbcf9668415f9d0\",\"/knowledge-medium/src/utils/relativeTime.js\":\"80fd3fc1fa767896\",\"/knowledge-medium/src/utils/renderScope.js\":\"4020fb61eb512498\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"83e03dc31561c6e5\",\"/knowledge-medium/src/utils/routing.js\":\"95d8b87462beb75d\",\"/knowledge-medium/src/utils/safeMode.js\":\"42c900f8548edbb8\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"0d2cb734cd4b2758\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"555d094d2f345209\",\"/knowledge-medium/src/utils/selection.js\":\"90bf56aadf1691f8\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"ac168a2074ef372e\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4ead4b0bf618e0cb\",\"/knowledge-medium/src/utils/state.js\":\"a7736f38464b6da1\",\"/knowledge-medium/src/utils/string.js\":\"b30c9e7bb59e091f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"6bf5026922d2b32e\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"48ee840b5da2dbfd\",\"/knowledge-medium/src/utils/toast.js\":\"e701cc2b3409154e\",\"/knowledge-medium/src/utils/toggleStore.js\":\"a96171ad46c7d388\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"72a90157af4a162a\",\"/knowledge-medium/src/utils/userActivity.js\":\"7fe33c1d9b3694d8\",\"/knowledge-medium/src/utils/viewTransition.js\":\"1b9e53f3874c9fde\",\"/knowledge-medium/src/utils/viewport.js\":\"3851a91616741b31\",\"/knowledge-medium/src/utils/webLock.js\":\"6fcc21b21efd54cc\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"05938d96aae713c7\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"25d4f38bbcb87b90\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"6da19bc8b5d661a7\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"92a8586d149c59de\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"31cbb6370261cf32\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"3e7be3785f941f60\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"d440470498375b5a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"50e74ab1e372fc50\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"ab1e035c40e877af\",\"/knowledge-medium/src/vendor/react-dom.js\":\"a7acd88cdda38e16\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"3dbb06f015022412\",\"/knowledge-medium/src/vendor/react.js\":\"0a50706a04790dbc\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
