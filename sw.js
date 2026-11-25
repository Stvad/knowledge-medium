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
		buildId: "589d8dddd158-0e8fd16f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"47166bcc0fa77524\",\"/knowledge-medium/index.html\":\"47166bcc0fa77524\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-l5obYlc2.js\":\"64de2866eda40a18\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c3eae179b979eed3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-VEmMvVeT.js\":\"d2ffd9db68a9859b\",\"/knowledge-medium/chunks/FacadeVFS-CxttUJHx.js\":\"a5c71ce190cdc982\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-gPOlxUS5.js\":\"6bef19c7c8b7ec61\",\"/knowledge-medium/chunks/MemoryVFS-Ckx5zttK.js\":\"0187ee95b6de880e\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B0Sqz_ag.js\":\"cf2e10b17ef31a22\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Dc1EKBgG.js\":\"9b11ba9de439bc6d\",\"/knowledge-medium/chunks/Preview-DktDv3xd.js\":\"6e2588075ad3d5ec\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-C9yBy9WP.js\":\"7bd07215a9fd35c7\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BApmmncI.js\":\"bd0086ba21e7738a\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BqDIo-3s.js\":\"13507453eed48690\",\"/knowledge-medium/chunks/react-COoI_Kaj.js\":\"272c953ae606a002\",\"/knowledge-medium/chunks/react-CoLzCycW.js\":\"b2fbb2a6d8500487\",\"/knowledge-medium/chunks/react-D-1WXJuw.js\":\"a96074e608a6c659\",\"/knowledge-medium/chunks/react-DR4AW_gj.js\":\"6b516502e3fd44fa\",\"/knowledge-medium/chunks/react-D_NbUyrL.js\":\"21095fb86998dd6b\",\"/knowledge-medium/chunks/react-DkEoMQf7.js\":\"b1df0a8e37b007d4\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C9r9UUbh.js\":\"1a059778c0b81eec\",\"/knowledge-medium/chunks/react-dom-server.browser.production-B3_NyvC6.js\":\"df0f90d40dcfd0c5\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BMqcwc4z.js\":\"ecc9f123eba87e3f\",\"/knowledge-medium/chunks/react-v6bj3BOA.js\":\"18766c10c5a395bb\",\"/knowledge-medium/chunks/server.browser-D3djWbJm.js\":\"ed2313700bc2f361\",\"/knowledge-medium/chunks/textarea-BXJX7Gaz.js\":\"5203866ba29099b3\",\"/knowledge-medium/chunks/ui-C-Z54rgV.js\":\"fcb1ef22da3b4b7f\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"f076544b2fe685d4\",\"/knowledge-medium/src/appUpdate.js\":\"83fdaf4b050ec9b7\",\"/knowledge-medium/src/appVersion.js\":\"27496fd0a596f3cc\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"5a94981313865b3f\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ca017143679bbe50\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"482db4c889444410\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"c1a8eec4b85b2349\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6f25aaaac98ddcbd\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"eeb3ba21a42a90bd\",\"/knowledge-medium/src/components/BlockEditor.js\":\"772e8b1cd4794e18\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ff1826d2951bc605\",\"/knowledge-medium/src/components/BlockProperties.js\":\"8d3d77094bace9b2\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a4757e4dfefba5ea\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"dbe7ef5e5f527794\",\"/knowledge-medium/src/components/DividerHandle.js\":\"821326fdb9bbf0fe\",\"/knowledge-medium/src/components/DraftEditor.js\":\"09cd0820de16a08d\",\"/knowledge-medium/src/components/GutterPill.js\":\"64495fb7a4dc495c\",\"/knowledge-medium/src/components/Header.js\":\"fd262e3153d45f1f\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"4c9c4f3fbcea20dc\",\"/knowledge-medium/src/components/Login.js\":\"d6dcb2487bc99cab\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"66b9cb4776b995a3\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"6138153ca805256a\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7ec4a177069e48b1\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bfe0f28a04b777dd\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"8927180e9cf0bc25\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"66142543ef2a5102\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"ec45999fe4dd64fa\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"92a45b69cca4cefe\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a2802e3b80eb93a9\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"42b141ff4e3415be\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"bc47cae2e9b2f692\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"22acdd8d6dddd71a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"92127fd4c5d1a5f8\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"8c42baf7112f5c4b\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"9cc9c72cc3f5dec3\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"94f3473ec51d4e78\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"e598a101adeab038\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"200fb9244363034e\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"c44fc14ee697d2b4\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f7399b2418fbd20c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"39691f5547fc8e8d\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"f7d045012740fb41\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d8ae8c1859d49649\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"5f903715ff72bfb3\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"85c2e34c8e1c1066\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"e8aa8a243e51dc9e\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2dd640f2651bfd7f\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"e527daa3ed765495\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"f24d6ee5024bd283\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"5f499712b2b4cb0d\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"60c41d2e94c20a35\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"0a65a1dafd0ab779\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"574ee1f0a95cd3e7\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"839bd13bd018404c\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1263a442ca367cbe\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"3582055cec59d3e7\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"ba2af528906c2ea2\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"66c45eca23fdbfcc\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"1e8e5e72f5da352e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d3cb65057d70ec95\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"495ab8bcad2037ba\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"01b5877455d41d92\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"138e27b5e6a64466\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c0b1e29ecdaf9c40\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"5d416f569d72e13e\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"3d8b36d35993b0e4\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"62d71b4e009db682\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"67f05a4ba09a9d0c\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"3dd999c26ff55cd2\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"5901fe32acc941c0\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"886a52249a9813f8\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"66e04462d222f477\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"dca45520ab00c155\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"287e8f2755ff7e5b\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"3adf596460c92a50\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"7c9390056a67625c\",\"/knowledge-medium/src/components/ui/button.js\":\"8bb621998b351f23\",\"/knowledge-medium/src/components/ui/card.js\":\"cd5f263c4f84af8c\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"46e6baa6fc570fc8\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"81431e754a92d9c2\",\"/knowledge-medium/src/components/ui/command.js\":\"c7e9bd05d72a4a2f\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"3ebb780b005d864b\",\"/knowledge-medium/src/components/ui/dialog.js\":\"8d0b1aa1c0800169\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"036e951d494c0e27\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"1972638ede8fd117\",\"/knowledge-medium/src/components/ui/index.js\":\"4723dbd88002e515\",\"/knowledge-medium/src/components/ui/input.js\":\"e3315baf1cd59932\",\"/knowledge-medium/src/components/ui/kbd.js\":\"f2fd6c97180a6258\",\"/knowledge-medium/src/components/ui/label.js\":\"12c065e0bcc6625d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"c5ec16e626151280\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"7f900f1c5634d98e\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"2c7c3c8359f2c32d\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"2d9601460dd75780\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"a795b251bc05ae06\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"5b0335a575707c51\",\"/knowledge-medium/src/components/util/error.js\":\"5852652d46b7c7b2\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"6c4de9a3059bd785\",\"/knowledge-medium/src/components/util/suspense.js\":\"a4e169e68171386e\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"fd2832ec5d57230a\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"7e83ea93cc9341d0\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"ef1ae9ffd0cd563c\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"42af2c0eaf4c9f6e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"915fdc7fd0ccde2c\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"a86ae9777ed7957d\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f53eef5c362690f6\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"9e55460483d05cd6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"eb99920e3b0e74e1\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"f0524baebab50b4e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"fe804777b4576bb5\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"92f354827049cc2a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5e83699a438ab733\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"8f3e40128f8be272\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"0fb5c332ffb43ab0\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"080d12d16a40c156\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"5f5e5dea25943774\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"73eb01039c095f4d\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"3e2c34d49d1a39da\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f37a98ed56141525\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"9283e8e7f0ddfe46\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"cb407491a57b863a\",\"/knowledge-medium/src/context/block.js\":\"582fff7cc404e4a6\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"0c25f761bd926d30\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"74b1a9eb456ca556\",\"/knowledge-medium/src/context/repo.js\":\"dfc7f616fb01a9b4\",\"/knowledge-medium/src/data/aliasClaim.js\":\"355ef87a0c3aa401\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"d7800db87dfb2d71\",\"/knowledge-medium/src/data/api/blockData.js\":\"dac5fc68b7723dd1\",\"/knowledge-medium/src/data/api/blockType.js\":\"6b90308f2189fe3f\",\"/knowledge-medium/src/data/api/changeScope.js\":\"6cb493887dc1a874\",\"/knowledge-medium/src/data/api/codecs.js\":\"578ac9c30af77cf5\",\"/knowledge-medium/src/data/api/derivedData.js\":\"fa64fc3d72620363\",\"/knowledge-medium/src/data/api/errors.js\":\"7698f28210604c6c\",\"/knowledge-medium/src/data/api/events.js\":\"a2f87ac2cc412462\",\"/knowledge-medium/src/data/api/handle.js\":\"03cb1759d4cd6d98\",\"/knowledge-medium/src/data/api/index.js\":\"01d09c12303b0a85\",\"/knowledge-medium/src/data/api/mutator.js\":\"38c2ab4f989a6638\",\"/knowledge-medium/src/data/api/processor.js\":\"6f370554a21ad8ba\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"94a2d1bcde863f1f\",\"/knowledge-medium/src/data/api/query.js\":\"dd3c4aa9f3b4db2b\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"db0dc6fa80fdc160\",\"/knowledge-medium/src/data/api/schema.js\":\"03cb1759d4cd6d98\",\"/knowledge-medium/src/data/api/tx.js\":\"03cb1759d4cd6d98\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"3e0513cae764e4dc\",\"/knowledge-medium/src/data/api/user.js\":\"ebeb15e969bb93ae\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8d7f2815d9dd659a\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"0948e50b39a36a84\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"ff06350a021fe9ed\",\"/knowledge-medium/src/data/block.js\":\"aeb32a494a9e2074\",\"/knowledge-medium/src/data/blockCache.js\":\"f53e194d4d0ff506\",\"/knowledge-medium/src/data/blockId.js\":\"823f19e127a31240\",\"/knowledge-medium/src/data/blockLiveness.js\":\"deffe89190f0a365\",\"/knowledge-medium/src/data/blockMerge.js\":\"02f18e04981230fd\",\"/knowledge-medium/src/data/blockSchema.js\":\"aec05867026df124\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"5607f1aa4d8bd0e0\",\"/knowledge-medium/src/data/blockTypes.js\":\"52d3be2922e9c0f3\",\"/knowledge-medium/src/data/childrenView.js\":\"da2211461c671e47\",\"/knowledge-medium/src/data/clientContext.js\":\"1a8cd659d403130a\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b3106dc55986f555\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"bb19eae7532e85d3\",\"/knowledge-medium/src/data/derivedIds.js\":\"69094def9319b7c5\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2551557cad2230ea\",\"/knowledge-medium/src/data/facetBridge.js\":\"3d5d99e9dbd43911\",\"/knowledge-medium/src/data/facets.js\":\"62bae0a409f06aec\",\"/knowledge-medium/src/data/globalState.js\":\"f15180f1464be722\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"2f61a2ad2b8f0601\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"074526df96299e32\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"f6558186ef8d8abc\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"e521e649a9b2ccef\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"7a2f790387d99b43\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"abb76264e66cd314\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"eaeb1b295f11b55e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"b4789a191d41dfda\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"1b26bcff5d837323\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"663f3884a207640d\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"65afa9d7bf28a679\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"21c31bf1d33d3695\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"bc24f2bffe2afa83\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"d674263f329fef66\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2cbd9a906a32a84b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7d891fa21cfbd813\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"eac1d7eff78ed3ed\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ce4594aded8923d9\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"18a98d99ed7dc789\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"cc4cd744d7d872bd\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"ffccdeb66c98ffa8\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"5434fdda097a30ff\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"a0d449c693a3bd49\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"36652ba8b2c09331\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a7ea7d09b80a1679\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"e3fade01acc9672e\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"97d53a9d870efd67\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"005447f24800d774\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"869b37363fc85869\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"e5e43906389136cc\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"554720b0c6f7ad2c\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"85628b25431df300\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"c15455d37566e3b6\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"5d6b3a5005137518\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d938c1cffb37e02b\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"89968ba4679726f8\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7f8ee08052fdae1a\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"06518f0e2d783593\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"d3c131b9924c127d\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3d99d554bff5b1ec\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"7834a578a11504a2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"38c8bb19ab2a9205\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"163b7e041e0946d8\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"4fddda0f01dbed09\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"025ad181ddc299a9\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"68aefabcab8727aa\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"70f8eb7275b3ec6e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"555cccf409c84c4e\",\"/knowledge-medium/src/data/invalidation.js\":\"c8e7b9db9d6bf995\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1cbd978ab26c2d95\",\"/knowledge-medium/src/data/kernelPage.js\":\"ed0f2fd1043a26e8\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"8aa0af193bd79fd0\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"b35ce8bd70aadedb\",\"/knowledge-medium/src/data/localDbStorage.js\":\"b15c7754e9c5ebdf\",\"/knowledge-medium/src/data/localDbVfs.js\":\"65e049b33177b418\",\"/knowledge-medium/src/data/localSchema.js\":\"531bf1cf70ed22ee\",\"/knowledge-medium/src/data/maintenance.js\":\"b9b114eda779dbc1\",\"/knowledge-medium/src/data/mergeProperties.js\":\"db04ca4b8074b295\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"090253d58740139e\",\"/knowledge-medium/src/data/migrationsPage.js\":\"48a065dc07ac21b7\",\"/knowledge-medium/src/data/mutators.js\":\"ba6de9a6f97d33b0\",\"/knowledge-medium/src/data/orderKey.js\":\"3770513a7fecde8d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"93cb3ac24b1c2a2e\",\"/knowledge-medium/src/data/outlineSurface.js\":\"f41f9c00ad4262f1\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"a920e9450307837a\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"33cafa9b4fdb0573\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"c7e08b34168d21bb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"fac49c3373bc6615\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"aae86483c68ce0a8\",\"/knowledge-medium/src/data/properties.js\":\"8825373930dbf66d\",\"/knowledge-medium/src/data/propertiesPage.js\":\"e5adc405cb619e8a\",\"/knowledge-medium/src/data/propertyChildren.js\":\"b8c00399de19f515\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"aab1b63a3efa2f91\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"9bc3d82b75d1b801\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"a0cddb6942a65f96\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9cdeee57bb362df3\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4f9be59d243522f3\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ad2b835918c934fe\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e10c086f94031b07\",\"/knowledge-medium/src/data/recentsPage.js\":\"09e74cee7186ef8e\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"62af3c9bb0ac8bbf\",\"/knowledge-medium/src/data/referenceBlock.js\":\"548a653c32ee79b0\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"18bc9e2bee0ec5df\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"bf90c9f005524428\",\"/knowledge-medium/src/data/repo.js\":\"4c97604ff669767a\",\"/knowledge-medium/src/data/repoProvider.js\":\"5616002889fe86f7\",\"/knowledge-medium/src/data/rowProperty.js\":\"ad0ae9fdf02721b4\",\"/knowledge-medium/src/data/searchFilter.js\":\"e8ea1de88b653ac3\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"4a7e95b704239e0b\",\"/knowledge-medium/src/data/stateBlocks.js\":\"53240267cc081077\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"ebc2a05cebf513c0\",\"/knowledge-medium/src/data/structuralInsert.js\":\"17d469097d4e5c84\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"7c1b51ca0eb97e3e\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"f83630603fcbe52a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"11a8b2610b5ac689\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"207f237bfe9a4b04\",\"/knowledge-medium/src/data/targets.js\":\"8990979bb4fa1e00\",\"/knowledge-medium/src/data/typeColors.js\":\"dce51c33f59a9682\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"387533d035612147\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"af65d61970c947fc\",\"/knowledge-medium/src/data/typeExtraction.js\":\"636ae9a6f4cbf06c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"d207065fab59618d\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"346da29061ce89b3\",\"/knowledge-medium/src/data/typeSeeds.js\":\"af504987cb5b764e\",\"/knowledge-medium/src/data/typeTagger.js\":\"9c6ceb062f457ea8\",\"/knowledge-medium/src/data/typedRecords.js\":\"b32568428f11f97b\",\"/knowledge-medium/src/data/typesPage.js\":\"db4e2b26876e3c36\",\"/knowledge-medium/src/data/userPrefs.js\":\"78c7b2fe6016c6e5\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d9e04569946e4abd\",\"/knowledge-medium/src/data/userTypesService.js\":\"f046dcc0bf50042e\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"e835df1fbd693f19\",\"/knowledge-medium/src/data/visibleChildren.js\":\"dd816cbe588c1478\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"81eb90e705999184\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"09b541830032756a\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"696640673166a7bb\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"62e29b032e4740c3\",\"/knowledge-medium/src/data/workspaces.js\":\"c819aef779db8c32\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"077d57eda201e86b\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"23d5f2098485e3b5\",\"/knowledge-medium/src/editor/atTrigger.js\":\"639d9518a49bf782\",\"/knowledge-medium/src/editor/autocomplete.js\":\"0096f075e694e20a\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a010a0233ec17650\",\"/knowledge-medium/src/editor/contentFlush.js\":\"ba4a952dd52100d1\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"b5b1b7d4c36e6bb3\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"3d32c3b459b7b921\",\"/knowledge-medium/src/editor/insertImage.js\":\"08448c3869856d46\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"bd183a3c958e1a49\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"220e998af2a34d03\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"c1886b7901c9974d\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"a5d136000276502d\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"4fddc6196f7b6e0b\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"e74647d4463d4e23\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"7971def6378e78df\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"51fbfed1aa43c5f4\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"8ebf6d15312150e9\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"1300b71e65686d92\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"ac70290b1ec321e9\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"4bf7ff8fb8776af5\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"83345fc71fc5d1ed\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"99af0fce160480d7\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"50a3687b55426c5f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"c4b827018ed95afd\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"3be912fc5e96c702\",\"/knowledge-medium/src/extensions/core.js\":\"a47e90fe36af0107\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"9f074dcf9a932df5\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d1196ab630c176bb\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"673f61ab7f4deef5\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"5837d45388e782bc\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"5f375cdd42f19daf\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"eceae6452df21e62\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"d7cbae0fe961e249\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"1a9c01d9553e88fd\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"c786f4952fe36a1b\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"9e1e1737e945f3fd\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"516a99eda2573466\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"effc18ed09e7bb88\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"c531141eb77e1ac4\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c78cec9c083aac87\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f25cfb1520cb1666\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"20eec62e707f466e\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"714a50228175acd2\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"e7dd1187a2435e23\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0038efd116d861f9\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"b04c1c81a724f3e1\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d3d79c314b049a53\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"82f1e288bd376624\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"b68f2d064e760986\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"d82e2cbdab6ef74a\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"910e1fd4c3e78f94\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"072674ca54d412e5\",\"/knowledge-medium/src/facets/facet.js\":\"da71ccdaf9b62e74\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"e69fea0bd2b4eb06\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"b5e8f7e4ccf64c0b\",\"/knowledge-medium/src/facets/togglable.js\":\"ef1c3338e422e979\",\"/knowledge-medium/src/facets/variantFacet.js\":\"11fd8fcf890eb27d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d8cd46d6825ab741\",\"/knowledge-medium/src/hooks/block.js\":\"af85094b519fc9aa\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"8e5d78f410977ed8\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"8a1fe807d5773185\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"e3d32b656a23bfa0\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"f955d7780ffae116\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e8e13fc5418c37bc\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"0482a74488657aa0\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"abaab7ff83cc9d2a\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"31b423d82f95ef2d\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"d65af7c89c938ce4\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"dcc67c9a6076e1fe\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"9d701b8e47e0141e\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b0764d8933eab395\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"e36e258e5561c3be\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"1e8bfe281eee596d\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"c83752fca4c080cc\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"3495eb95afa39795\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"f549e2c855eb6d0a\",\"/knowledge-medium/src/lib/utils.js\":\"000843f8d189c550\",\"/knowledge-medium/src/main.js\":\"504c590a4709de7f\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"11734d75d765f3af\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"86a4266ab8df50a7\",\"/knowledge-medium/src/markdown/context.js\":\"f9b2da71b98ae837\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"106ebbc043817435\",\"/knowledge-medium/src/markdown/extensions.js\":\"bd411aa1913cd79e\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"71245cdd201a4b45\",\"/knowledge-medium/src/minimal-editor.js\":\"002664dbf06f60f3\",\"/knowledge-medium/src/paste/armedCut.js\":\"a879386e1cb840bf\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"0fbad0dd6e9f36a6\",\"/knowledge-medium/src/paste/clipboard.js\":\"d5c48dfa05ed7b9c\",\"/knowledge-medium/src/paste/decision.js\":\"4d6af74e12f3c38b\",\"/knowledge-medium/src/paste/operations.js\":\"e67bb12e1873215a\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ee5e29d3ef364672\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"b7b5f8d8135c67e5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f034f978f4e87bf5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"f93882d9c708effe\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a8eb261281347d09\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f2f47023a0d7c7eb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"de3c29886b773bb4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"25fb8327c91382a7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"3d55db11242f6f52\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6af3b3bb2a497dbd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"e9a40404c4fba0b7\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"040122536d587c6b\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b7e82d6c2d366e4b\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"8a29cfd1d2c83cf7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"aa5b552ac8c21c68\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"c080011ffda43323\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4dc71e9089323d70\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"dfcffdb03bdd7e09\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"effc3ddb355cf3d3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"086d3c2033151d38\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"33b5a12f4ac869a3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"18277e1e6135cb4e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b0b78998eb7ee4b5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"53c0f2bb293abcd3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"c29e0bcd3eda1f9a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8087d46fab4b8258\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"f1c33d58249b72d4\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"9b5d7263fddf9cb2\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"78f589b82be9eefb\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"dd2632738937f202\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"ab2750c733c5810c\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"5f098acb0bdc14d7\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"327c46bed0c51f52\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"01d404d2b854329d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"51a82b75396096d6\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"5b3124bb827bf9dd\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"6e2a4365c7caf53a\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5c966c3e6ffaab35\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"1fef6adf970f1c1a\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"37fbecfa9242c8f6\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"29129b36119479c2\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"c5ff2b1dc3617d46\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"b5c703d22302982c\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c701da157e18f884\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"3c90854202b64d09\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"0b481e7a38b0e7ef\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"99b9431ea5147a02\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"790b0c6ebd825060\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"794053e384854163\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"189dc31e1e1ae131\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"a5ae6023be838914\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"c43f096a3a85aa40\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"e43f9a2fcc0796b1\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"8241800178d85e22\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"64c9c3262d5c37bd\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d05dc54f6eac052e\",\"/knowledge-medium/src/plugins/alias/index.js\":\"582a95d09a4c2717\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"38e96ab7144a57ae\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"37da0d547844e9d0\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1183efd759183049\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d320289cac1f02f1\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3c7d3cc018f06dfe\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"151a08fb5ed098d1\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"925dc6fc4d19c6db\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"91685aed39ca4526\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5eee56c5f1a469f2\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"7fcf0320d8daf187\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ec22eb1b194783c6\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"d830d18abf19d970\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"e3bca2d95e09879a\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"16cc850828de4fa6\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"dad60fa1412a23eb\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"f635699ebca1e027\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"7a5a4e9e96f82e2c\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"b5dca4cb8aa4b8c6\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"8c1a1dacb34e0e83\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"33a15c23a6b3fa45\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"01524381b8d2c8c0\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"ddcbe402e2224f0c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"fb2cd434beeacd50\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"aa25603e0bd8e8d3\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"8e8329fc794d9aff\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"99abdb83e9bdc871\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"6fa8683afc757e1d\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"fe588520d18303cb\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"90e089b045135b58\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"c2bcdcdcae498071\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"875635fe7310f408\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ab7d7b4868b93664\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"6edb3e20453703c2\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"0d34505187d21619\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"7822eb809214cba2\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a04c55767275c63a\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"e9f764204b16056c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"90a5a8674f47523e\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"9fb24b473ab4e840\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"e0b75d674dad185b\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"d215fca5d3a90652\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"266b1baeb353b947\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"dd6da0937aa0d9a8\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"631fa455c15b0915\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"ff3b2f1d2166f017\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"6de832016976a1bd\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"06c1d0ef0db40bb7\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"3dce440a17ab07fa\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c0e2073c7ba8acf3\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"08e0e589a92b6f28\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"15fe71d960d59d03\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"887138029588ad60\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"1eae61465eeb90c6\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"959989320a873039\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"02ff021f8b981cdb\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"ba9d70ec111b4b28\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e41e22d08822d590\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"1dc2e6ddebbb9a49\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"acaea05673e856d7\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b4d517ee27e8c762\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"ad66781449198a04\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"ac24b9773bbbacdc\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"633adbaea3fc1b39\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"34bffb18ee2633a4\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"85939bc8517003ef\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"44ce20896189d104\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"2312b8845f1d89ad\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"33275b479b04a715\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"cbbbfe2f7b9c246e\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"b0bea1b7b1878753\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"5fe43ba8df81f3b6\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"ca8bc25bc9889620\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"86fd16088fa23e31\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"ad67e9c35a9e676a\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"5416a1c7c04676ea\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"3e74faff235ecf85\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a4adddf1e7acaa01\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"de3d5a659a4e67e2\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"9ccde69fcdb9709c\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"5dbdb3c2ccfa424e\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"824598f46c8961e4\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"d107a05443fad3dd\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fd705f6710c40e3b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"569d76bcced8c86d\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"763408642ff1bad0\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a4b54a7d56ba6a46\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a193dd3cc26d0b23\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"ae925579b7e405e6\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"5061c12c1f39008f\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9b4540a4c4ec1dc1\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"fd27c1e2184553ee\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"eb1dbf1e519a0872\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b877bad8386b6f51\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"89f4a7da2aad3bf8\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"a592fe2c948d81cf\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"03119482db47bc9b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"1d8ace70e30e2844\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"026e5e903daaffe7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cf7d25d6144afb97\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"7ae563b897cec39b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"7ff7965650055b85\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"299743430cb26214\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8c11f56d185f8ee7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5f91ab85c26010c3\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"b84039165fbca1bc\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b7078591d203ad4e\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"13897c97c5a2a637\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9a51368a6c3078ac\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"bc280da6716e1ad3\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"a3890719cf75adc5\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"bdd3f2ced019657d\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"2b92b841698fba18\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"db0e6fbbb4cdd6d8\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"55f894a460dfe060\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"e6210ac57690ad98\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"d68c6c2ba047b420\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"24cff494094a7540\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"9fd4a18cd286acd9\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"2cb8fb949780ab3f\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e4dee009ff052b85\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"01d1844e1f77be9d\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"3a936eec516a3f79\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"3a173b54114542ff\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"df8e0965940ab54d\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"130eb97d48d14be1\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"10b0ff27a95b77fe\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5467cddd371f0c99\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"aba43cdc5f19019c\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"4d49cd1f95113765\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"abda378202ac713b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"f4799f0d40da339d\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"2c442afe35b66762\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"2fd654d12d6165c3\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"fa7d74f55ea86c18\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3bbdaca3acdd06f7\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"27d705bf58a58b92\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"119919f55ee9e2ef\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5f8d3dc7f93fe8e9\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2de640ffa0a93d42\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"4640d1a4f226877d\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5182c4c7f3bafc5d\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"419234db6741fd60\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"14ce58e86d87b106\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"4dead0762add7592\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"224d7b2906e96ceb\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"9bdc7b19481c2b90\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ecdfc8cbecb6a967\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"dc231a7adffb1e33\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"dc5f90ca2db68cea\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"73b7774be7b07a13\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"b42f95b007ad9b8e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"8b031e0edbf19355\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"09fa1e67454460f1\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"25cfe76e6ce05068\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"23708638926f27f1\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"1170ab5ace7bdc67\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"1bca44848c7f9ea4\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"d624d0329befd1cf\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"9d517c7d0a696630\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"95a39f8f31ba58bb\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"8acf6abe4c56eda6\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4f99cfeeecbcb937\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f30c230b0004d67d\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"a1f37abd49f56b95\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"59798f8d5777a84c\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"b28acd8457449429\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"b987a98ef3f17866\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"409a1c5b1bea5611\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f6fcb89078fc1d5b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8e86d7dc44d2b229\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f32cf58bbd6ed5c9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"9d8bc8daa78558b7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"925dd0850b77e47e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"49e6b0a60c195d6d\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"8f9d25b846cb2110\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"24ce094042d99a16\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"758af5d0f72a02d5\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ab082069d0fe90c5\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"3288d1729b5dfe9e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"04f8830cd3375b00\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"3b390e3c303f68f0\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"854ad690ad509a19\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"ff51bf65da7f3ad5\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"e372daf6648a37ed\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"6b30822ab60163ea\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"e042abf22a7b1866\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"893806e74a41b5a5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"06f375ecc755fbd5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"7e35e93182693c97\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c33e5e1289af72ab\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e7788c8d8e89e91b\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3c754c3627c0ba95\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"08788f38e5bb1211\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"8f97cbcd41ebd79a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"79332164ca1748ad\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"d20927be0c2a6210\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"ff30c57bf9b2999c\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cbd946844c24f7b0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"19019a59dff86852\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"6c36ec0c2d6026a2\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"8d6a3ce5f440a403\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"a5f8701edd9b15a9\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a9c653cb2ae04ca6\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"811ae5664f2c14d4\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"847812f4cce94cc7\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"ae32dfaa935a4633\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"1015ccff2dcb5d9e\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"79584fc9b2e601da\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"673e17e2b93b88a2\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"d49e47cce93199b1\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"777b92f8bb1a5923\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"e35a2d9d2b682776\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"675affec84b22ff8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"cd05fe186c54df60\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"55279a647326e4b4\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"2bc9f678c8733d63\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"cde39366bf3692c6\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"3d6aa64e89b3066e\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dda754e93078baa8\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"604a4302019a64a7\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"6f239620a90616aa\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"c8d3afe5f8464340\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4d2c3ef8014175fc\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"d481f7f00df96dd3\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"911c824e51ee8988\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"23f10af5c010052d\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"1b80f6faf48a66c9\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"1c460c9b113a0521\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"46ee6fccafe415a7\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"cd6ac5591b7d525c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"3a78e0f3ff2b9b73\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"71331d50792b6e9e\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5f739f5ee8cf8dfd\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"5932f24fa2ed2fea\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"bb4fcc4ca2001e90\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"2c68409f299407e9\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"0a605be715099e0e\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"6d93f4004247584e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"80922ecd53ef651f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7b461ecb2d7a88f1\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"75a96caee95f4b48\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"adeabdc4a3c057fb\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"b82558988c1bc62b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"6a797e3329f74561\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"0392620f2758be2b\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"14a082236f8dae34\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"dbf1ce554543a9ec\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"9d9fbd20b2b5dc62\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1da2e41f6555ef78\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"c525acca73657455\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"cd98473cf2b896e0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"3858ebda0b502899\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"bf69632979ccc863\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5deddc8f711c76f8\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"1aa97b8e8545435b\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"fa4d10bbccf3b145\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"fda7f69f18f51645\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"f6dcdac477fd87cc\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"29edf61445090090\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"630050d88d3f84a6\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"fbe8395582cef635\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"08b0dedbce469b1c\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"c6819c9fe8a6a555\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f3273e8afd174a94\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"1c09b43f399b080e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"aa3485de8011bc29\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e2df320379dac878\",\"/knowledge-medium/src/plugins/geo/index.js\":\"ca237ba76e629e36\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"840ea00bd1b1bf8e\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"db97e0915bdb6e9a\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"dba97232638246f6\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"503478608c0dff60\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"6d9fd13762cfb759\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"12245b79f2dced48\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d26986e1ed67c72f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"cb31dcc86d2dc56f\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a6e8913abea1e3a8\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5189ecdf5e9491c6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dec4caa7041da433\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d56e903975ec9591\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"b596bab070837b28\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"da9308aab2b40fbc\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"49d10cce26c4c182\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"79b4a7e483e4eab9\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"7a58c18ce3d939de\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e89dd0a8237e1f09\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"3b3235ef87b5e63b\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"0f9cb6dc45904ee7\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"120bf5f5e4a294f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"357a874ce825a254\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"aead0830be75210d\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"13736b1e80c9dd8c\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e3f4bbcf0d74dac5\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"3b8b3eea9fcd9649\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"a9c76da76276254c\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"f2b85dd7ee9899a4\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"a50cb1c4744b5608\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"550320709b2e79c6\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"2c6ee32c0014c056\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"8706fd5fdd05ac4c\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"0d69de391d23ed0f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"083a1141a441cc4b\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"06838a868ef0bcdc\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"28b04cae7321261d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"e6ca0e17475684bb\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7362814e1ab8b759\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"b5705d7ceb8887fb\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"bccd6aa7feff9163\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"455682e7ce5ebcc9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a8cd621fde639058\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ea2d170515be56be\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"afcbb924ee656902\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"0cb217197855c494\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"b9cf5e4ac54e3e36\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f1d4056efd4bf79f\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"499fe885c2812688\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6f8a9d961c1c8038\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"7b19f1a4d7b0270c\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6f8d74fc88c07a91\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"0fa95a28f92a3d84\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"5c12f5d7efcddda3\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"a6a41fb6ef022519\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c966190dfb91d424\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"2f43fa86eb098047\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"9d6ea98c7cd4cde1\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"ab0dcb4b79fe79cf\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"358b983b5d094e10\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3ae9812cd3b227c2\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"048fc8a68b73fcbd\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"82979322ebb37788\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"8acea25aabfbc44b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7b42c777a877b4da\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"52248ad09827e51e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"e3d7997ef6a340c7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"08fc87bc33796c45\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"58ca85b0f960182a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bea98e360dee7c05\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"aaa351628ce986cd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c2d4dda8fa9fdd9c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"639c3bb25293df4e\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"daff9b2916c53cdb\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6aff5ee79e0b200f\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"c384d62eec003c76\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"2a4b6e0a472fb185\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e0606fe9ab807982\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"debed7449638db55\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"6a312f3f860de2e7\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"a57ce07e46b23a14\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"17aa3cbc69803744\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"c49e933df79e98bf\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"fc1f2da1df331056\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"643fe9147e53bd64\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"43d5887a6b14422f\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"92252c96484647b2\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"128406651f1fa75e\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"6b182d18793970e4\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a10f057291e6072e\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"eb2ced272f2fc973\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"9da4e8020bda0c14\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"0baed14715027469\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"2c3d03363bbfe881\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"878b4514eee6f4ff\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"29d087a4ca0bd20d\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f2a7125b03aae866\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"9f0df3f2d0c1bfae\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"f237c444919d664d\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"fe60252620e15c97\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"a75a375782e1d065\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"2c2b91284cf74c9a\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"314dcd2bbc66e224\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b8b2018eb1688cc5\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"c12c1afb3f3fff83\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"8f52012945aea976\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"d11a3c7f88059692\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"f1c6c7bd55cfa1ab\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"5736763f962d4fa8\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5fc921c0d3412dca\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"44342bc3cb3e1e9f\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"90968d21338cfc6e\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ab89d5e5d83a535c\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"5dfba828ee8588cb\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"37183a6abe6d58b3\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"2ce40fe2024699ed\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"af7c4161570df0b6\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"d99d9b46945ce6a4\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"52f779fbebbd39c4\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"b1c5bbde0bafadd7\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"c0265c3831b6066d\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"bc0a0a681efdf3b4\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"786b6318ac091bdc\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"06cb967f80344e6f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"21498e990b5d6cbd\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"a615c96c60da752b\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"01fd21e6e2053317\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"93c1096f35187d59\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"91e8ca6c872e5be5\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"33c214225ca1b789\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"e7c08e34cfdb87c7\",\"/knowledge-medium/src/plugins/recents/index.js\":\"89da209623cef127\",\"/knowledge-medium/src/plugins/recents/target.js\":\"2c69f218fc263280\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"b110a48072dc502b\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"de2f5381e4937f6c\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"13001503e97e1787\",\"/knowledge-medium/src/plugins/references/index.js\":\"65059d62fcdc6151\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4a5771f675643fa2\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"8711663e9f585336\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"0c578ccb4624d3f7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"5f1a7f0c679cc57f\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f722e5f4d3318f85\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"c6105ab8da887ef5\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"45588c28a653b30e\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7fd53540873fd450\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"28eae1391b1a8725\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"47739c963c9b19ff\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8be259707b7aa37a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a7b5f5873ac739a7\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"8a63ea91ca781e8b\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"ae582e74b27888db\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"3a7ac61086df1e57\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"c39d18892061f731\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"a652440cae3ae98e\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"384312c4e50928e9\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"107344ef7a40e4e5\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"64cc5c29b341ba79\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"26378fd37ea86d24\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3fd48beb8b88c375\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"3b941e8a2c45666f\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"7179ffdd88912311\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"ea5fe8722fd0dc14\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"18f647b201f352cf\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"d7b5fae362c23c60\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"cabe3f6f4709b576\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"a5749d675aa89e7c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"9a870966065fb1d8\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9dbc777c3478a849\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"73f026f561809123\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"40e58ea51de5aaf3\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"81e59fcc1465b448\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"bce87ebcf4638a49\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"7342c3ff14ba2f1e\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"25c164482cf14a2d\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"075ad3fcc9141721\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"a8b916faf2b54150\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"2277b9bdcc57296f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"dc4e37da06587337\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"988d19cf653429c7\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"ef725a4ecbde26bd\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"517abd0d35a3debb\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"9979470658263ebd\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"ac2f805ae2ffc781\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8c6f13bae77b5ee8\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"68659520941ce376\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"67823ca88f117d73\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"313bc62f11cd09f2\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"4a591b163671f32c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"37f9f2aba086e06f\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"46f1d373307bdd5f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"4dbcb4f671fe458f\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bae8015ac5354ece\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"316677568d94d437\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"9183ce28f86566f8\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"80f1e6099e603c66\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"3c5caf6334dfbad0\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4bb10591f322586b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"b2a64b13345ca68d\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ca9ef6f9351f7f23\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"b05042258ea96357\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"33e22c23614c6c6c\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e7e032c1fd417430\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"d79a65b8b0db35e1\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"4611fc2654ebb557\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2f944e3bceb4043f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"43216acccd8e62fb\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"13daf54303eb13df\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"21bf60f9f6adc06c\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"488b47dd85309d15\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"b210bb0d763c191c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"69dd69912dc33c51\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"313f4a4fa439ee09\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"a93935d3d0a1a256\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"1672ebd07b2dda49\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"1c206532b46abeb5\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3ed97d553b149ed4\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"d6cace75fa54dd86\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"f8997030b453dc49\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"4a0aadbac6707c15\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c4353a08fba47d8d\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"a8230afcf7b007ce\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"a8037daa87a0c01e\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"98fce800390ac343\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"64fdafdf0a8cc6d6\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c7e54b6176d0e675\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"20700278618a46b2\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"96bd6709f24a1699\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"80c7d567b315116a\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"ce5e956f055cb0bd\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3e1536ab335d817a\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"e3cabb86c06aedf6\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"f8624ba9944b3f63\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"03efab4309bf3570\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"88d77e0de369c912\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"14a87bf050296460\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"ca50cfcc5f20e76b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"6c61496c2c42f8a0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e3bbbb51ccdf161d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"32f4cb7a6aed77bf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5d292a67efa24088\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"8c147c5c6922a7c2\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e3eaee493f66d4b6\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"c645e214142f54ce\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"bb64c9e571de6532\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"18e2965f8aa20dd5\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"df9a6fdaf4624ec8\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"5284646b7001f660\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"7119c766e518e29d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"70b312349d2d7526\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"d5c1408c77bd1afb\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"9780e8440e66c180\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"60cedf50de04025b\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"04bf66e263ed9c85\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"40e1fc665470334a\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"ecfe1b0951480b84\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"573d81cd18640d85\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"89084e3903b1d76e\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"942315403e64159c\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"05eddbd0b6c0fcbe\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"b2691975aae83031\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"53c81325b8679b94\",\"/knowledge-medium/src/plugins/tables/index.js\":\"b7c38af441a2906b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b92e840337734477\",\"/knowledge-medium/src/plugins/tables/model.js\":\"f8d9fb2084313bd2\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"43dd03020925a703\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"05928a68921edb63\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"21d28c73c763ff8e\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"de2a487772c9e962\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"9357c9657291c3ce\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"e43219d50e1cba70\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"afc4fcaf3fc17586\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"bc708055630e158e\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"272a367cdcd584cd\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"d4ec1a3d103f878d\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"e0b6a8754aa75bee\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"125cff2384b0f58f\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"2ef9d5b8064cddf7\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c9692965373d32f3\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0cb20ec033a05616\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"5a5e53fcb9cd4fc7\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"9452595a25b43d0c\",\"/knowledge-medium/src/plugins/todo/index.js\":\"10e069e653a1ad7a\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"cc7c840540f07f66\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7f791f7b8673adb1\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"be83ee1dcf47e60b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"d044c8c59f0e42a7\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"fb635f8d59df4a66\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"407a1dd43706651e\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"44dd26d098921756\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"aefe3964dd25e441\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2770dc3def68716f\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"e7a1d114ac3e18be\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"ff9a9d3e688de3de\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"2751f7b6696f7d29\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5a0abf99d7a9eace\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"3c288063f2881dd3\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"da14fb674003c2d0\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"04d8050fa36ac5eb\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"0f5d281fc6e4aba9\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"614e462cd71294b8\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"9360b98b7e88a4d0\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"1a01341fe4b19d83\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"63a8d767d9613399\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"298443691124442e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"2a73144fc03b7d59\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"35d99e6609d5c5c7\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"6aa1b9a0e3f981c4\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"888637aa2b0a4ed1\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"f47bcc0e8ec60b8a\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f3359c72c5945271\",\"/knowledge-medium/src/registerServiceWorker.js\":\"3e529adb7f13ccad\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"c22cf38bb2751b15\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a0486ada96cde3d1\",\"/knowledge-medium/src/services/authStorage.js\":\"491b42c9f5b81684\",\"/knowledge-medium/src/services/powersync.js\":\"8f2d8b90b75650f5\",\"/knowledge-medium/src/services/supabase.js\":\"36eea5e850e1b5a4\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"2d43426cd39934d0\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7067212c56040adc\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"da7ad1edd276065f\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"178aeb181aac3a39\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"5e09089a701f4c50\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"770ee22aee1d6483\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c199c56c65588582\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d465ab079f718eac\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"05a3d129e303c88c\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"fc4cea815ff7471d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"9df840ef8b692d67\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f22394c4b66fcc68\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"70487619c13881fe\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"febf2276a8ec82e7\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"75eb277169f8a699\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"0a37357bc5c9768c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"28e75a6be34119ff\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"097de679872dac1a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0b62759b5f72c77a\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1a37b28baec83c96\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"8fcd89890ba26d67\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"f977d64029d99d8a\",\"/knowledge-medium/src/shortcuts/types.js\":\"630a46291146556b\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"69174a8e5d26476e\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"53d9d805758bf2b0\",\"/knowledge-medium/src/shortcuts/utils.js\":\"9ce32daae130e51d\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"c8625de40827437b\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"afc3e02887884c65\",\"/knowledge-medium/src/sync/byteTransform.js\":\"272c724320180e9d\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"a36b398adeed90fa\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"a0a6b00523fd0fbf\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"63e0e6667fc3202f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"938c343b7c837128\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"d8a905389ad81c94\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8d87905abc0374aa\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a4fcea9d966f0873\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"94d38ab9515c7caa\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"9ce68ea59257f1c9\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"bb2d5904cd9883fa\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"12d15d4d3271b36b\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"a91fc0cd8f1a59c9\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"f7502d0fed215761\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"176ca2c2b2088428\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"fe0f99edb61d522b\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"8ab9331b902acbb0\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"c73e34849679fe22\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"76c9be124be5932f\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"4de7a02e5a95e4f3\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"730d82b7169dea8e\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"dd111d29d439d292\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"c5f47633a52c7540\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"984919b4333204c2\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b219f4cac4110bd7\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e7d439fe616c3cab\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6a25904850fdf770\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"785a67b890cd29da\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"967015861946099d\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"03cb3f0393d5d342\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"86aff5f898f1a8ee\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"c261879889e677c3\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"8078a8dd0959224c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"8e3130b91e253217\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"815462782e1a3b34\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"0a5189a8b778a698\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"07d4c59cc1cd2976\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2379f6dfa534b132\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"c6558f7310a8565e\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"910b6f51ec41e8d7\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"06f75512db3f8603\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"223fbbacd9b2d9cf\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"4cb1ad7461a7fd24\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"8c8600a8ebf5a7a3\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"58a752f1ee1ac3f0\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"5ba118307684640b\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"bcd64fb2aaba9af8\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"c6191b8e87ad039d\",\"/knowledge-medium/src/sync/transform.js\":\"ea0cd440ba651abb\",\"/knowledge-medium/src/themeBootDefaults.js\":\"47b53aea5bdd0458\",\"/knowledge-medium/src/types.js\":\"4fde14a3be9cfb1b\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"04a92e20d2f31715\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"4e67b8774ba268c4\",\"/knowledge-medium/src/utils/array.js\":\"d698f45999af1980\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"a2be3a9b19f454a5\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"513334c9f528a572\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"360a0ee04c770738\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e95844b122f6c690\",\"/knowledge-medium/src/utils/callbackSet.js\":\"ce615ea31818ef83\",\"/knowledge-medium/src/utils/clientId.js\":\"c5b288e5a8d45ecf\",\"/knowledge-medium/src/utils/codemirror.js\":\"0b01f73234f02514\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"75e6f5b5faa73ab1\",\"/knowledge-medium/src/utils/copy.js\":\"546e033e8a263656\",\"/knowledge-medium/src/utils/dailyPage.js\":\"0d3a0846ff4f6025\",\"/knowledge-medium/src/utils/dbForensics.js\":\"e4dd30545f2b3224\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"428dcdc5398aab26\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"440d900302b63636\",\"/knowledge-medium/src/utils/dialogs.js\":\"77101672765cb585\",\"/knowledge-medium/src/utils/dom.js\":\"e19709828ae9567e\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"3457ce17971ab0f0\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"28ddc2203062dae0\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"818db32ce1bccaaa\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"7051c945e5ca5bc8\",\"/knowledge-medium/src/utils/flipSlide.js\":\"0be961ffddd86979\",\"/knowledge-medium/src/utils/fnv1a.js\":\"0b568a3f518f2853\",\"/knowledge-medium/src/utils/formatBytes.js\":\"cec8e3eaffc76ff2\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"622ae2e8d8778790\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"2cd5a1523e6a38a5\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"a7d189f3f4d611df\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"62a10857dcf12787\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"913dc43b5384537b\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"acef0e0ad9c6db08\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"47664750d9ea1ab8\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7412a3eccfb6fbe0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"6528c50bb06c2d17\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"d6bb6b42a2727086\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"cb39408fae5d7f7e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"69a1d8f8c87487a9\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"06d9d3bdc2148369\",\"/knowledge-medium/src/utils/markdownParser.js\":\"8df5395d4a11b192\",\"/knowledge-medium/src/utils/memoize.js\":\"45c7facfcf655f3b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"5f41d191baaf4332\",\"/knowledge-medium/src/utils/nameList.js\":\"d17d06a125fb80f1\",\"/knowledge-medium/src/utils/navigation.js\":\"7a1cf9bd306423e3\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4b89b749f7cc391e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"280374fff813ca3f\",\"/knowledge-medium/src/utils/panelClearance.js\":\"f0e7d2fcbf58544c\",\"/knowledge-medium/src/utils/panelHistory.js\":\"5ed9ee9efb4d739b\",\"/knowledge-medium/src/utils/panelLanes.js\":\"edbb2a7e789b4ae1\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2c7bfab6472c3353\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"702b7116d2eda6d6\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"01f7612f0d2a2582\",\"/knowledge-medium/src/utils/platform.js\":\"9429001c75351182\",\"/knowledge-medium/src/utils/pluralize.js\":\"4afa7f650c05a7c7\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"22a4c80797a68998\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"4210ab41a511a313\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"d192513e6a70e1a1\",\"/knowledge-medium/src/utils/react.js\":\"c1df91f11d5efd07\",\"/knowledge-medium/src/utils/relativeDate.js\":\"56bdb02d57604f15\",\"/knowledge-medium/src/utils/relativeTime.js\":\"a312e2d8a9adaccc\",\"/knowledge-medium/src/utils/renderScope.js\":\"3e5457609d2fedea\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"05d996a8a24bb1f2\",\"/knowledge-medium/src/utils/routing.js\":\"96fd01092280efd0\",\"/knowledge-medium/src/utils/safeMode.js\":\"703591c3c463127a\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"4eb5124ebbde6ac8\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"0b90e916155ab99a\",\"/knowledge-medium/src/utils/selection.js\":\"a2730cec89906eea\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"3a0ab838a377640a\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"2b316152677427cb\",\"/knowledge-medium/src/utils/state.js\":\"331ba167dcc725ca\",\"/knowledge-medium/src/utils/string.js\":\"d932fd51e49f521c\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ca5f83773a5bb5c4\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"b0d08fd07b9e18e2\",\"/knowledge-medium/src/utils/toast.js\":\"5fec0842ba0fe86a\",\"/knowledge-medium/src/utils/toggleStore.js\":\"d24a964c7ad0bade\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"09706379479a331c\",\"/knowledge-medium/src/utils/userActivity.js\":\"ff9d0a21aae71dfe\",\"/knowledge-medium/src/utils/viewTransition.js\":\"c9a71f10311c6ce5\",\"/knowledge-medium/src/utils/viewport.js\":\"cbdce5d8c75c0f95\",\"/knowledge-medium/src/utils/webLock.js\":\"1039bad0d84cc981\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"553a5946f35d6620\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"fecc9df12291af4c\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"d1683fe1a494d508\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d4bf585cd2024c4e\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"8e1fe3c7c2ca6bdf\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fe51e94705d0ef38\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2b0a90cd6b9fa261\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"1cdc921e637e045b\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"99d483482d20139c\",\"/knowledge-medium/src/vendor/react-dom.js\":\"6b633ec86d074a68\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4795f3c4580f03d6\",\"/knowledge-medium/src/vendor/react.js\":\"c1ef70a9f851e377\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
