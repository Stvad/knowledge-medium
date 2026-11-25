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
		buildId: "7ed6d09819fc-fc6b7fc5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d36ed5f707300b82\",\"/knowledge-medium/index.html\":\"d36ed5f707300b82\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DiCwYZ0-.js\":\"ab78e0bbc479c2ff\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c646eba40dec77ea\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-D_y0dQ4N.js\":\"21f30c5bb7b62acc\",\"/knowledge-medium/chunks/FacadeVFS-tATXYhRQ.js\":\"f64df6680f381354\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-ByDgIMoV.js\":\"be980bf8f8ed39db\",\"/knowledge-medium/chunks/MemoryVFS-CaZjYtDn.js\":\"ca5476242dd51e68\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DHhvMRsk.js\":\"1164de046207bc30\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CQZKhsik.js\":\"f27181f10df19201\",\"/knowledge-medium/chunks/Preview-hSQoHGTJ.js\":\"ef7d119b562251f9\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BWsqXirr.js\":\"4d417e605cb7c274\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-COiZJQ9e.js\":\"236295db83ada5a0\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-9KHKm8rf.js\":\"3928102a0e05d656\",\"/knowledge-medium/chunks/react-BOOKKPRj.js\":\"1c644aed3c0cb8f0\",\"/knowledge-medium/chunks/react-BkeqG2D2.js\":\"89be4f8b3ec65a7e\",\"/knowledge-medium/chunks/react-Cb2DRHkD.js\":\"9b868ad4b9249f25\",\"/knowledge-medium/chunks/react-Cm0RttfA.js\":\"333fa282fd7e6729\",\"/knowledge-medium/chunks/react-DP0zPUpM.js\":\"9e89e0142a4d0560\",\"/knowledge-medium/chunks/react-DgFtIIhM.js\":\"a78a8f76f5453659\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BScu-x3r.js\":\"ac9772be29d8ed98\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C5kV0lfx.js\":\"1e83d46c24112578\",\"/knowledge-medium/chunks/react-dom-server.edge.production-D1k_iglv.js\":\"43018a97044f201e\",\"/knowledge-medium/chunks/react-z2fP1ZPR.js\":\"8a118d31f2bec7ca\",\"/knowledge-medium/chunks/server.browser-HbupQpXn.js\":\"5868f1850e7ad569\",\"/knowledge-medium/chunks/textarea-DbB4Li42.js\":\"3df00c5d043c117b\",\"/knowledge-medium/chunks/ui-Bloci60p.js\":\"3a931c5a219c96c8\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"46fc0fc39cda0296\",\"/knowledge-medium/src/appUpdate.js\":\"4d12f4bab9edde13\",\"/knowledge-medium/src/appVersion.js\":\"f63c6c7917730f2b\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"f151fa98e2716400\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"dff8e59530bb32c0\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"5dff76fa1333b18c\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"ea54738e156ae713\",\"/knowledge-medium/src/components/BlockComponent.js\":\"46b7fcf3668b006f\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"47d4a8e516dd1c1e\",\"/knowledge-medium/src/components/BlockEditor.js\":\"be40195404437c92\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a2a59600b3022bbb\",\"/knowledge-medium/src/components/BlockProperties.js\":\"f61c144a22357dfd\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"7411f3e8b9e4a6c1\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"07dfdd8ed7c64d88\",\"/knowledge-medium/src/components/DividerHandle.js\":\"e5cbfbcb42bd3742\",\"/knowledge-medium/src/components/DraftEditor.js\":\"3707851a6694611f\",\"/knowledge-medium/src/components/GutterPill.js\":\"3326d3af589f095f\",\"/knowledge-medium/src/components/Header.js\":\"c3d8cae7cff742f1\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"9f94ca3004cee4ba\",\"/knowledge-medium/src/components/Login.js\":\"315fb7e1a3c3d419\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"d34bbe8398f71621\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"c3d44b5856999af3\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"de1a3aa3953617eb\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e69bec71be13f50c\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"b841f3db05af3643\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"9afd38f60a02dfc6\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"97db1bcd9096ac73\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"f8bc52d98121a6f8\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"c47728983ef2a031\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"af5197c59bdd9880\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"79a2144dfaaa6ca2\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"2966ae11fe8434ba\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"613c103a133e8ad9\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"49943d88ea58bb2d\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e925959e42f3e6e5\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"e16c1c70acee9095\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"37e9d8e1a732960a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"8c6e27ada2fe3b2a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"e41f34e94ca7726f\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"d4a1f242148fb755\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"04fb28b40659a5ed\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"79cc73ec66b888c6\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9cce540c3ed2b0c0\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"7c7b639f5e0e5818\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"35a2eefe78cb0d31\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7432d22c914cd50f\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"fc0392413a8c653e\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"da3c956cba475c7a\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"627d06b7cf2071a0\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"5df254a51232524e\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"6e4cf8f30064eab5\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"e2ae61e47ec4801f\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"8a206ce3e895d29c\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1dac3f454a380f1e\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1c07527ba735000f\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"0437a7f76b1b59fd\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"7c5730b5c30344d3\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"2599fdc10579f645\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"b0971c99f491e0d3\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3a5dce2ae1561204\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"11520e2d4a928795\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bea6115edc612171\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"5f4034160c7e31cc\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"11da0f1867008720\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"a75d4104b6a849f1\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"c29e7429d9d266ea\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"031b1089b100fa3e\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3514e5bfa8195c37\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"a0f1ffbb0673ab35\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"57aca0f1f29f9726\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"df8516f06634e5d7\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"da08ff6fb117d6e4\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"196770d24b22274a\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"373f9ae1cccf128e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"4771ce061f99de81\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6fe8bac073d00bd2\",\"/knowledge-medium/src/components/ui/button.js\":\"7031161c7c0d4c7f\",\"/knowledge-medium/src/components/ui/card.js\":\"14a3d1dc2583ce9f\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"f14cfddab437b2d2\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"e80e5036b9b2827f\",\"/knowledge-medium/src/components/ui/command.js\":\"c5a0ec9922e12a55\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b3fe9c6cb8c851ce\",\"/knowledge-medium/src/components/ui/dialog.js\":\"e3ed397e31c89cbf\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"e30d25d3eaf387e9\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"afb10f7b556bbe33\",\"/knowledge-medium/src/components/ui/index.js\":\"c7ea09af37807f03\",\"/knowledge-medium/src/components/ui/input.js\":\"2958e1db75e6d242\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3e5d1a65be17fddc\",\"/knowledge-medium/src/components/ui/label.js\":\"ff9d4c905096859c\",\"/knowledge-medium/src/components/ui/textarea.js\":\"0078f792e7268a49\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"1d1284990f907e5b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"510e14932cad5617\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"1f5c634390aebd3c\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"f03e63e505fef052\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"681f97ca44ca0832\",\"/knowledge-medium/src/components/util/error.js\":\"418b581b7d84eca8\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b770e9a87e0baa0a\",\"/knowledge-medium/src/components/util/suspense.js\":\"321149b7f9a0b3d0\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"6047b61bc45d1747\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"3666c54159b4626c\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"e9714b17afa3eb1e\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"d8d1e3452b417bf8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"b3221695131bc896\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"047acb359fb5053e\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"78f5e37b57b19a0c\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"40412078ef25e087\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"ff9c4a5922871f2a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d2104a8489f3e29e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"96a5d092bb51a59a\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"2c4ed6a8147373c0\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fe04897cae5fa0f1\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"ef6f3857fb3dacde\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c68635b10d9821db\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"45a40f1de70fd225\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"df154518554fbe9b\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"dcf39058358a924c\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"c8468071e173ab91\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"6f38cbf2b4ade288\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"6a476e0a99a1806c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"0f3472893215bfb8\",\"/knowledge-medium/src/context/block.js\":\"be732e72a7b887a6\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"19353ade75bd0a72\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"a15bbced43dea323\",\"/knowledge-medium/src/context/repo.js\":\"225923a630e3f523\",\"/knowledge-medium/src/data/aliasClaim.js\":\"a0158db27f4f81e3\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"023aaa3f2be07277\",\"/knowledge-medium/src/data/api/blockData.js\":\"948fa6e784e2fa3e\",\"/knowledge-medium/src/data/api/blockType.js\":\"5e15f1fbfcbab10b\",\"/knowledge-medium/src/data/api/changeScope.js\":\"128f505a8f1a147a\",\"/knowledge-medium/src/data/api/codecs.js\":\"227a348ffaee8b54\",\"/knowledge-medium/src/data/api/derivedData.js\":\"7199a6957f11efc4\",\"/knowledge-medium/src/data/api/errors.js\":\"3e68a72870342956\",\"/knowledge-medium/src/data/api/events.js\":\"2be2099d35477525\",\"/knowledge-medium/src/data/api/handle.js\":\"c3411cf73bb47fb3\",\"/knowledge-medium/src/data/api/index.js\":\"3bfbe7a911e93de7\",\"/knowledge-medium/src/data/api/mutator.js\":\"0e6a841765c1011a\",\"/knowledge-medium/src/data/api/processor.js\":\"fff1f15d5c50b076\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"532dc236f42efce0\",\"/knowledge-medium/src/data/api/query.js\":\"116ffe5fc41a1aa3\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"533584778c828268\",\"/knowledge-medium/src/data/api/schema.js\":\"c3411cf73bb47fb3\",\"/knowledge-medium/src/data/api/tx.js\":\"c3411cf73bb47fb3\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"47a81d04c4c2db3a\",\"/knowledge-medium/src/data/api/user.js\":\"7986fc36aa77a41d\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8f30416b87b56a59\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"24a489fa640697ad\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9492b29ab7b67439\",\"/knowledge-medium/src/data/block.js\":\"14852c9d3a914f3c\",\"/knowledge-medium/src/data/blockCache.js\":\"cf78c837ef848039\",\"/knowledge-medium/src/data/blockId.js\":\"96824a6f3e58d49f\",\"/knowledge-medium/src/data/blockLiveness.js\":\"cf2accf31dd65acd\",\"/knowledge-medium/src/data/blockMerge.js\":\"ae6cb250060f4512\",\"/knowledge-medium/src/data/blockSchema.js\":\"885d07ccc61041f7\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"ddb3ea3d8cb0411c\",\"/knowledge-medium/src/data/blockTypes.js\":\"6e599f7ca437bc16\",\"/knowledge-medium/src/data/childrenView.js\":\"c3a6f4ecac17d965\",\"/knowledge-medium/src/data/clientContext.js\":\"1651bbd76e59eb0d\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"817a9c5550cdbb38\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"b3a9f79f51b06938\",\"/knowledge-medium/src/data/derivedIds.js\":\"6ce3616135082b6c\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"21ff9a07a8eb3e18\",\"/knowledge-medium/src/data/facetBridge.js\":\"377ed4aad3f0ce48\",\"/knowledge-medium/src/data/facets.js\":\"3075aa6e3a4dc27c\",\"/knowledge-medium/src/data/globalState.js\":\"a8e4cbed6fafb4ad\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"50dc2c047dbc05d4\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"f7264d00719937c5\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"195186d447305189\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2f76c1538b8b9827\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"e1be9134090ea7da\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"82f4601a0dd76c5a\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"7544bd7959e57180\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"4fdbac4c47831ad8\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"2761a3ad41633418\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"71e0847fee4734ae\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"047bb787799f6e00\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"eb9e355bdf4c3321\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"350ab342a6d5a6fa\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"668a62831435bc2f\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"188736c0ded11efc\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"151339968bbe77fe\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"4c266ea0b8f095b8\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"669e56a1280edcf6\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"3655c719beeee738\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"f136fe98aa10012b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"781305113192c32a\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"7c3e38c9f347ddc1\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"14746d80ee8ea2a2\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"e5610c64b43fb05b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"db7cf8aba25e67a8\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"419a073522294c80\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c368c9581d7cfe54\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"493ff862b6eabc52\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"07bfaefc311cb61b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"57ea07cf1f480ad9\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"7cf0ca968fcfc9ad\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"0bfdf529074f0b60\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"c01474fc66e234f2\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"d282183bb50bd6ee\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"2da1a770fbaa47a0\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"9547f6fc269c937b\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7e0280de00bc228c\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"a75318087a210674\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"234ed80e8a2d5410\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"07cb1037575c7b3b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"1f3d8169a754d16b\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"74cc880c33ab7c21\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"1c12f1e406f7880b\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"a5e55a3933d05c05\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"2c86491903fe4d71\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"002a169f50331f0a\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"6158b95155bc3f15\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"436aa27f4d38acba\",\"/knowledge-medium/src/data/invalidation.js\":\"7b2dfbacf4c2f438\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ba83e896c63926ee\",\"/knowledge-medium/src/data/kernelPage.js\":\"d6096846205f2779\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"f7c13754ce46c1d8\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"605245670b5ab6af\",\"/knowledge-medium/src/data/localDbStorage.js\":\"e4d269a0a4859b98\",\"/knowledge-medium/src/data/localDbVfs.js\":\"5b685f33f60a0ba6\",\"/knowledge-medium/src/data/localSchema.js\":\"f0b3c1f71f3ebe33\",\"/knowledge-medium/src/data/maintenance.js\":\"040a8620d74452f1\",\"/knowledge-medium/src/data/mergeProperties.js\":\"28e8a19c5e55a826\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e84dc7aa26fee8d6\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8761d5c77e18a69b\",\"/knowledge-medium/src/data/mutators.js\":\"e8329a28eefa0761\",\"/knowledge-medium/src/data/orderKey.js\":\"1b87e534adb8ffa3\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"81eaed877edc9d95\",\"/knowledge-medium/src/data/outlineSurface.js\":\"891899ef87f37d9d\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"e90271fcd42e0a32\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"9f8570d7df6ea316\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"85cb0e60dd2b771c\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"30d9aed6e8f47a44\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"79d58277c5af530a\",\"/knowledge-medium/src/data/properties.js\":\"2e582f4506bf826c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"54e1d244e2d30927\",\"/knowledge-medium/src/data/propertyChildren.js\":\"7f7c8593741e2d28\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"38c64b916893ac71\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"51d2bddebc16ccdf\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"b70099a8cc2b4977\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"1ab71b3385886b60\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"71cbe36a449d5d9a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7f0f53d237566510\",\"/knowledge-medium/src/data/propertySeeds.js\":\"8db29bf1e451e2a9\",\"/knowledge-medium/src/data/recentsPage.js\":\"7f8536f740376824\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"70d15e9ca32082b8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"a81d60b2f6c62075\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"7808b84935a8267e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"9fe0410497ad80e7\",\"/knowledge-medium/src/data/repo.js\":\"f3ac35181e198ffc\",\"/knowledge-medium/src/data/repoProvider.js\":\"4d139362ef7118e2\",\"/knowledge-medium/src/data/rowProperty.js\":\"79b3c1638d28bc02\",\"/knowledge-medium/src/data/searchFilter.js\":\"96ad89f30de43c56\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"5e8be8a6c315eb87\",\"/knowledge-medium/src/data/stateBlocks.js\":\"27d006d7562ab4a2\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"678ae2d27352af99\",\"/knowledge-medium/src/data/structuralInsert.js\":\"b04788aa46bc6390\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"519cf67597b89619\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"7e31ff3e9b690c32\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"0da149b0e0124306\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"21e04c80598df8e9\",\"/knowledge-medium/src/data/targets.js\":\"0d2e888394bd90d7\",\"/knowledge-medium/src/data/typeColors.js\":\"817ce93104523ed6\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"71c054c98009c764\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"c36526c576e21f89\",\"/knowledge-medium/src/data/typeExtraction.js\":\"91883464ea025451\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1b6a51450f500fa4\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"2e2b33635444577d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"5527118f3170aee3\",\"/knowledge-medium/src/data/typeTagger.js\":\"2269e8a36a9f28a4\",\"/knowledge-medium/src/data/typedRecords.js\":\"961c582261d7565b\",\"/knowledge-medium/src/data/typesPage.js\":\"67924ccad5c622d3\",\"/knowledge-medium/src/data/userPrefs.js\":\"8f6d543eb5683a55\",\"/knowledge-medium/src/data/userSchemasService.js\":\"5eca39832f13b006\",\"/knowledge-medium/src/data/userTypesService.js\":\"a801a4d4e99eddfc\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"94f797687b1a461a\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b36fba642e99f94f\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e0db644cadae1e3e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"22037f4b4103e66c\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"a2e878038d010be6\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"b5e7c9ef0e03f948\",\"/knowledge-medium/src/data/workspaces.js\":\"90ba43c443979633\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"4795b74707020be2\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"f9c4e55541267e99\",\"/knowledge-medium/src/editor/atTrigger.js\":\"5e7b0faea53343d6\",\"/knowledge-medium/src/editor/autocomplete.js\":\"38cf0716e993f637\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"7e5d814ab87f3a36\",\"/knowledge-medium/src/editor/contentFlush.js\":\"a346eacb64f2529b\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"61b111c2e316f058\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a8aa09a4ce6e4a98\",\"/knowledge-medium/src/editor/insertImage.js\":\"8c6804e072ef16d1\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"9222bd126c059ab0\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"cf522456f4bebf35\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"d0b69d17ab02ad72\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"82f5be498a0c35ef\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"9eafcf0209313237\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"64b674152d524712\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"ea02690e00c63409\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b526bbb3a5162cb6\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"682edc42fd14f000\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"f05282783fa9bcb0\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"a61f8fa6252e5b17\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"847a63a95aa99805\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0c2c86df5055f972\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"71ed31c7f852be8b\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"e1548b78eadfd406\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"003c2444b01a95eb\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"0251014841c1434f\",\"/knowledge-medium/src/extensions/core.js\":\"a3507aaa4b9b8f25\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"3eb20eb647777216\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"012875e2aec30418\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"9dc8f989cfee5363\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"65ba4b82f9c0bfa7\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"2e1efb51c8161424\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"45b265da5e449087\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"5f8130de5936a6b4\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"333ce85e9ae55527\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"0c2aebfa0a1e32bc\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"7c4c517edfb91e1d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"f2f7b1d44f3fc37a\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"7684888e12453e6a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"1bcd16c594a3960c\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"fe7e7feab0d06be2\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"65004fa85afac7ad\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"783f42ce2e20cf72\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"39520af84661fd06\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3028ee707b15a956\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"680efdc942652691\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"757c394f2b71e8f5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"a2fd5a96c1c5a52a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"fc919697a27b267c\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"829472c896f88d45\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"17bc88521a76b74a\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"96ba905609336c79\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"768f9f597e86a725\",\"/knowledge-medium/src/facets/facet.js\":\"a14c7436a53583fc\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"d49f669a85db1483\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"0e2f1b271c56c65c\",\"/knowledge-medium/src/facets/togglable.js\":\"d3e523f972648aa1\",\"/knowledge-medium/src/facets/variantFacet.js\":\"9a90ad7a4baae7d4\",\"/knowledge-medium/src/facets/verbFacet.js\":\"12d2ab9b4bd7d2ba\",\"/knowledge-medium/src/hooks/block.js\":\"444927f7271d4740\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"7cf218be870932cf\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"f6bf78ba30a5885a\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"1ae3835ea666a05b\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"a0b49441b8df7726\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"f655fae07a0a6092\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"197acd4f3357544c\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"a39498d591aecc0f\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"f8fe68b14633b6f4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"27571a5cda1a1e10\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"d05cc0f8dc9cafd7\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"be7b19074927c174\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"a5cebf310231c385\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"c6e8a2c5093d3e86\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"611c903608953752\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"0015b6174b7cff5b\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"c027f8173b37eb7d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"84d1c023d82fa4fb\",\"/knowledge-medium/src/lib/utils.js\":\"ef9cd1839f6b06cb\",\"/knowledge-medium/src/main.js\":\"681746fd043978c7\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"12b5bb9a3179517d\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"a167bff7cb986c16\",\"/knowledge-medium/src/markdown/context.js\":\"d0a59a41e5e127c5\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"019c1c06c2f37ba9\",\"/knowledge-medium/src/markdown/extensions.js\":\"596b14ced98034eb\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"5ec6b28afca475b4\",\"/knowledge-medium/src/minimal-editor.js\":\"07e2eb32a10288be\",\"/knowledge-medium/src/paste/armedCut.js\":\"df13f7b86e0b1ac5\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"04ce8a4eab011ead\",\"/knowledge-medium/src/paste/clipboard.js\":\"c3c907b72901617f\",\"/knowledge-medium/src/paste/decision.js\":\"c89754494eb2ef91\",\"/knowledge-medium/src/paste/operations.js\":\"07ddbe8faca4e350\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"804a120b7cb4f30d\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"7fa7d79243dac265\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4bbace0f672429dc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"9095a21310ce5093\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"0e75cc7cedc8c38f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"18b0c96a112d21f4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f36ebaa6a7c54d64\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"99fec81d0d6ab0a4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"0941cfab82e333d8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c62bebccf7f2c55c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"0217dc583118474a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9dc6382fe8a997dd\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c5bc679a2f298239\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6b9a39641961ba99\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a5087043561ea58a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"062d9d7abf61a4da\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"77d05681c4b0d18d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"58cd89056396d269\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"a8f1fbb9f3ffd7c3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"19fc556e03b6c708\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"b880d8e2d79e8066\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"8b2b7cff7238c804\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f57e7fdc3c75bc82\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"510eacdc8d925a5c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"02d25e27793b82ff\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2abb1cbc2f04bc80\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d4170dd7448a7ed5\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a6c025fd2f103d05\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"413687b5c9bf6b92\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"ce7d6996d9c1570c\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"431773c082226ab1\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"68bc752160a56ed9\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"706f067c889872c6\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"f632d3347f6fed8d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"88cf1065390979b6\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"b4e8ea1aeb808aa6\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"947e6697b3fc5ec9\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"49db254171362186\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"7c952c059e552543\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"eeaa6692c99da27a\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"fa2cd988ca7e89d6\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"d2d356921110e14b\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"143ad6968a0b5020\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"5dfcf47039b6afc7\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"94ef94e855c1b9ab\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"b33d2ee962e4a71e\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6545f36a703efad5\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"c4e6707d4a7ecfe1\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d0abc579f1df979a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"d05b0be472841d60\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"2a145bfea394393a\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"6e1e98cd1dc1a3a1\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"59fb3fccaf80e0aa\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"8013d6023987af69\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"b336b06ff77430e1\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"cbc2f29e4b7e01d2\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"76f3bb5cc2a28dde\",\"/knowledge-medium/src/plugins/alias/index.js\":\"651f31e8226f2be3\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"4e40b21cb949e1a6\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"d039c7fdae9d06e8\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"b4beda88585b9139\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a1d0bbdb1c5cf6dd\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"be4c9d89d76c6d81\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"ece051b53dd532d7\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f511b29563f2bb87\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"80809b6f3c8c717c\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"b0f0ffe543eba0a0\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"59ce9b111d326c68\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"5134df002e12b046\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"b3c35e57fff3f258\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1274b2fb607b0b77\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"fafe4e04e20555f2\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"29a3b28fa1ca63dc\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"1c4acb8897f50666\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"40d9b12adb237ef8\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"9573de7831df1a20\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d68b560ef84860e8\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"65898cc010f04b31\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"1cb44e96a5f6b8a6\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"4a6b89fbda57feba\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"0d8aa5c302ac3d4b\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"d785f114c50ff182\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"5c533beb6b615df1\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f70b056cf10da34a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"686495b2cb36c34c\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"ce1aa69bb52a4b3a\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"50ffc785460994ff\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"436bdc2ad58e2c26\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"ab0e01a1387e0831\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"425e72cc2283f811\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c70127cc781207b7\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"aae756dae78cc06a\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"273f8f1dbc37d9b6\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"d19b693518b2552d\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"6938b54e782ffd4e\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"04f482dfb5e405ef\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"4c88b3ac6696fdc5\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"58121ae68cebf78a\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"5815a1bd58f26d55\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"08c88c23f229dbe3\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"fdfef355a17917f5\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"98296a210f5b3739\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"bbf59d458d8754ed\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"fb57aac5a621768c\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"46cb09f43a715f3a\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"00915f6d90b14256\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"65ad70efbbd6918d\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5e5ffce215ef427b\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"76a104c9d4ef4857\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"783d878de43ae0c5\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"d27d5fea4f68e891\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"6d7f91c7830101ad\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"fa5274fd5a697f69\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4ad4e4d0fa1a28c2\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"834e6e2516d042bb\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"1b130da1c145137b\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"29113d6cb3c95440\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"ba03404053582825\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"0cef56e63c23f9ac\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d8510b3e16d5f07d\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"cc5922607979ef48\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"3de134ba88b91076\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"07bffd1ae364b3af\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"4b6cd9e45042cbc7\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c3553ea667d61e7d\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"0d73e50f70e92728\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"cf100ebd1ce2e4a1\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"bb65e380c75c1361\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1365f532d2ed274b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"4b461f01e5854d76\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"06f4c871974ea739\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"b4f9090cbb736d5a\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"b9aae0dd3294764e\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b68dda3820f0877a\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"267fc406bc7b53de\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"596ceeaa96e26bfb\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"fd2199340c7d3cb0\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"0dc7bbc2834faa68\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"31ae652677b703bc\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"f51b4b2bd13bc072\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"106555a536d94cb5\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c6d6230aaa9ee039\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"906c2fcc5945b7b1\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"449414f0455299de\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"21069ff0e2f532ef\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"3ccfcf4c028d8ee9\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"b05b88f9fdae6909\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4b6f705eb7ce0f85\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"f57a5e74705127a4\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"10636faaa543d927\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"36755c80ba521594\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"e12cf2c6302ca66d\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"65c2adc3ecb6aa56\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a9b9f2593c16f6b2\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"2261bb16bb49045c\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"261e4cf32d85ff6c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"aee2b62cbaebd884\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"fb4074c48c823f78\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"64671147f2771681\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4d30af3fbd2185cb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"6082024ddd28a40c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2614ccda1e68e9b4\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"28f3b41ab6469abf\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f15453647b7770dd\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"64ce6d354e9e5165\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"d4f19bf14aa81e29\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"bf7c5f313b96bce4\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"681339c91bc17e91\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"d24098a06ae1f14e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"46b9e87201d8fc6c\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"485d508e157cbd52\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"30df1c81ed3468fe\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a168e8deabb16413\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"dc3b7e3bcea5b215\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"4309a940542f30f4\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"de6f5e6a2c7a42bb\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"94b3a80c1303bf0c\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"d0b64ec9b00a6e0b\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"d4026ca2657098f7\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"79c86e02cf46ea09\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"1ddc0fd148465253\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"08561010a5e1fd84\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"83147ea9f296f2ce\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"7ef2cc542af128db\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"851fbd274b4aca30\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"9ea5adfc86a93060\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"0edc6397778ee7a4\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"ab24f33d81030b45\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"215ff2d87db22711\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"4b2ba353ea0fba18\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"54caa5f6bae637af\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"465cf29a6c5ab080\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ef799b725cbcdea7\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3c6ddc65ccc97e39\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"691f5ee4968008df\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"69ad2b089cb528ed\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5851e8573fc33b6c\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"565cb0154d172f4a\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bdc419c6eda2193a\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"ed48202bb4c5d7d6\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2c4e72d0ac19e518\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"f49352cdfe1a00ea\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"a4f0bbd7f70792cb\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"6d471f073b530ea5\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"fa9b526c4c520ddd\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"01afd4380f466de3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"76b3cedebf5881cb\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"d93a1a5bad99c4bd\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"cf561fe21d3bc32d\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"c183bb4df1c19770\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"a72faaf2b8af7542\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"c18903df4cbc9892\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"beb77232be92b505\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"78222df2342dd946\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"baa5e2d2192b8f86\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"e8048ebb5bee9d7c\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"318f5139e945d96e\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"978faedacf044c4c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"466a49a99432ffa3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"3c9304c14d027c3b\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"fbf043df9318488b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"1ae1c468323564b0\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"ba0474b3b311c99f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"1274753bc4279264\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"b206acaae1778df7\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"d8c890ade93d781a\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"6ad46dee01d0096b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"27d96222480a8222\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"5f216ce890122e71\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"c4c262f120b4ae42\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0b42a3ab6e846e12\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"463b08cf6a3027e0\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"5b5ccfeeea53010b\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"81598c2b54909e71\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ba80edffa21270f6\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ba4fabc2d0f83c26\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"9f106aa2c747d4fb\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"d3a1589535aa4a4e\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"55e09f4afab0b24f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"3d6b02addb949bb9\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f0a463296c2d580e\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"47f4ff9a39a4b468\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"b3c8cfbb503ee0ad\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"8f79889e9bbc3c65\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"cecbfe49fa287f5b\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"ae20d75f30434ff3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8c2831afb4eaf0f7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"0acfb7424b4db595\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fe4b7c16483f93c8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"910e6ffc2a6dfede\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"57f9fb6409101c0c\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"5722eba3bb282f6c\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"43d8a079f10ec1c3\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"a85d7eb574542ead\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3c243f3502bfb0ed\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"8da4cc37084c7998\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"c53babb6023c26bf\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"327054caf46a0351\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"fe36cfab75bee9f9\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"60bb1a04e2970e9c\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"3da9ce0dbe4e5f69\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"f7b429ac026c17bf\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5a68950c9d5dde96\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"61f6fcd0e369f4d3\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"9d8df8ec0393a2ad\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"f33280d480b64980\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"eafd150c9e30310c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"fd14de693e34fee8\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d46c746086d0ff9e\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"4e7ffb811186d06b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e3cb83092996d633\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"7a1c23cb6a565e9a\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"4c17c393e9eebb7e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"fae070fe90c21c9b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"ee27f08e6cc936d0\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"e47b87f32d73fcd9\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"d66bf52e2f0ef02d\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"6054a6acfe65406b\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ff44e67ef839854c\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"18e6eb3703fcfeeb\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"0b22f0a25b09c863\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"8c180a4a2d481f6c\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"aeadcff7ecdf47d7\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"116095a92f0abbaa\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"377b160411895aa7\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"0380528ca6dbb9c7\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"44157c4f995d3a4e\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"fbb756ffde8f716b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"6a55cc4a3290a424\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"704a05592d2dd69a\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"1c2b6038205a1ca3\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c50d35a3e9598efb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7f1050266be0fd42\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"884aa91664567f92\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"4e26077192f7024e\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"5e32b5e8fad205db\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"9a024742955c26c9\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"f8f0461aa089584c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9dcfe932fd979902\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"643774ef3d2be013\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"99044800710aec55\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"60fed0015931888d\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"dfa98cfb0c27a358\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"853d4cf1e5e09bf7\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f11791882d258d45\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"13a209663b651901\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"5398944416485c05\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"632736c2c7b80043\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d8c51b63abf004fa\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"8e54b530984e5377\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"ddf248a0ae8f364e\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"c0975b8fd85c25d9\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"f80d80db0882073e\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"6c242eb2df70b90e\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"2aaaaf44a112feb2\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"18e69d7428142448\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"6d2b523dc2abd8a3\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"e89e895d016d89b5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"56e2f09d7d3ee1ac\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"2242a2b69bcae977\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"22e271559d465f0e\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"c27a97a30802a1da\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"799dcde4785deb94\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"eafa2210eebb4847\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"145eace8d8872742\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"01cd016321be6c5c\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"6466974a88e4288c\",\"/knowledge-medium/src/plugins/geo/index.js\":\"b16d96449d80c9c8\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"1446ddad472dfc1c\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"aa1ddce67ac8df3b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"9155230c52078ae5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ca393c7f4190b753\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"5d59767e290cfc80\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"4954e49eb07f02cd\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"c7f9fb0b0a6e12fc\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b187898f0e58f4ef\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f230682596406e73\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"59e3b51ebecc9300\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"79adc553d3900217\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"963e3a431bf429e9\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1dd0d2a657670706\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"539c06804b39f8d6\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"2194eda6b63b7d3a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"68f75e4af58c002c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"59afd037be080d1a\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c25da53f2bf1c3d1\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"418c0c4b11295733\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"03fa7737c62a5d86\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bd43d81135d0625a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7b8812f310c6404d\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"9f3b6f08154f6e8a\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"7a523408bc0dd2e2\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"263f0f98353cc8ec\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"cf03e0ca46232c7f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"baa290aa78c64310\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"7fcb48af2eb2a4a0\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"e8a580724316d2f7\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"fbf64cb11aa9f2ae\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"82d3a738084141a4\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"49078c5ffc8bc9fc\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"134b9ba308d78091\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"6a63fe0e1d9217b1\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7ebd9e716a2025da\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"848b54f846d973f1\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"7129e911028eac5c\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"4a21544c446c9e7b\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"781de68a3bb38909\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"7c9507d618f31d28\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6edbf15a4e2c883b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4a38cf2b9128d5db\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"003561ab43559446\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"fd93d0d3fa4cb739\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"ea6d8eda44a58add\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"b21c7e19f909516c\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f55bebc46c8637d1\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"82e58e9cf9d129a2\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"0da9567b7cd5c168\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"cc8c06e13f36df6e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9983720c38146fc8\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"2b29a8292b9ea1c4\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"ed20cc090c0036ec\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"eb1dca1a71b6ba74\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c4672e1cab3c8203\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"69c61493ce1c8a8f\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"6091d2a6c9d56b8d\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"861bf3a306e5badb\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"32fd78b07a229d0b\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"13d81683c254178e\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"04bccb4d0de5616d\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"71e225046f842327\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"a80e604f6ee70c0d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1eeaec8cb9df8463\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"746ed35c63180456\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"2ca1ee152fff5b88\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e8b1c315670ec647\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"95bc99c2e0e2c55e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"68217882615ecd7d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"db2920fb3b088d40\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6e20385046897078\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"707bd7022b4671e1\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bb6e0c7278b99e2d\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"609ee9790920d52a\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"aeeefb168e84c6fd\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6dc3f66f8df8a92b\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"ab17ad100716f781\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d915aee3ea8d5063\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"091ea556f9c8c595\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"4d87735ae23f22e4\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"6b4581f1803b5ba5\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"d4863aa7777a4e66\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"f079ea4b05f49d8d\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"538d279a007e02a8\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"8535f37f3ecae3a1\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"0eea9656f385bcd6\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"514442cdcf35fa28\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"48642eef921dfbfe\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0d4bcd0358e1c590\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"565bc2b83be1dbdd\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"bc68490bf66d62ef\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"e358ea27dfab9fa4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"fdbde49e4347cd73\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d9b62a8714778471\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"e4f7a5f86f7b60ea\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"df257403faf6fc7c\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"94686ff3fcdbaf3f\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"3c3401ad017d01bd\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"c01fa449fd7a3537\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"f1df33bc703cbc00\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"91ee09ab31a8ad97\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"f764a43a0b482ca5\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"13709620f179a781\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"bb28a6abb9257405\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"eded7901e151d152\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b51cb06a4dc929ad\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c10fca9a7666f0ad\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"ca93bc49f1739e19\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"cd1b43246f318317\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"a623d778626dc733\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"c44e7bf4b9a0546c\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"52abba9ae7f07879\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"8944c12e755d4867\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"de7593b5bfd1c379\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"73274a4117bdfbc1\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"333fc4686105c291\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"4e9437e4d89c82f0\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9d377a861b7a2d18\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"b998532ee38f821e\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"bcf0b9a800601b3b\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"e48b4dac660a4f86\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"68b317f1cf14cddb\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"f3a66cd439f360ed\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"bb6c3508320395c1\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"206be76db6288e57\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"1d0b189fe08aa251\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"cbd2b44727c75114\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"3395eaa84a0d22d2\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e46fcb8b36e4b63d\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"025357bd6e1c782d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"63329b86408e5cd9\",\"/knowledge-medium/src/plugins/recents/target.js\":\"29b27fe9aa8fcedf\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"7f567ae25cb5cccf\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"2a4a4e92816fcf6d\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"984498b81a5d38eb\",\"/knowledge-medium/src/plugins/references/index.js\":\"bfb4b7d4875df90e\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ea128b2066bce845\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"b8a7c36ec1b08f53\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"e6d6c71e16d8a5c3\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"a01ec46d241994ac\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"18da8be71448a30d\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"99b560b718c0285c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"754db8799a800e02\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"aa6782553a207ffe\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"334342b8fb8b1661\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f9b49b2e7d35e164\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cd7f64bf8cca6a76\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c7ffb82f99069ccf\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"30938ac148dadb9f\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"1071e61ff12a177d\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"12c4eff91deed09f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"53c6b8435f325c53\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"8d9130263529aeb6\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"79c4e35c62f1de44\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"e3fc194c5c335f99\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"8f53de26dd4514e2\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"3a3e5b0b29771fae\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c4ed303ca902da7a\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"e209d91bb36beaa0\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"57ea3c82e0f3fe51\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"bfde772d338578b2\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"95683813d7ead07a\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"85059fc2542b9fea\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"a0778556ef1a0136\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"32ee163945686373\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"a9d17141fbb0050a\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"6c7c6ea2d85cde46\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"e1a360bdd52f6c87\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"b7defd394c12c89c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c6cf47ee0692351f\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"f65fe9d59dbbdef9\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"20bd7928b3674183\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"0fa5ee6db619346a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"69c0bce71466b183\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"3ecf71b17ba301b9\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9d990b54d20d0e98\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"e2733399d1f41e07\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"8abdc1ccc6cbeed5\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"409719b6b222b6dd\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"60acbdef8b063557\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"d6102e4e393341f8\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"9899f2d5943dc48a\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"aa4c00605212e86a\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"f3da8c8a675bab4c\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"59892d4569f5d50a\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"b5a31184a1ce0e7a\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"6f3338ee80a5269a\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"99d6e1d794d2686e\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"efe32107e3c96da1\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"720661e05055f65e\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bc0c4fb5eeea6a50\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"35208a47941ef003\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"84abc7df8e58b761\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6c950b4f726e396d\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"3701a106cfe37f8d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"19afda85c5d6110c\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"4453c0464fa2b356\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"c639cafa79f07c2d\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"2506ba32dc2d70b6\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"97a9232c12b04c94\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8fb7927efa3a75f0\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"db3e9a7682b99638\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"4b9045f88fdd253c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4bf4374f8695f856\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"6eea82791d37ae49\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cf11eab286382a2d\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"307e0cf9a3ad2eed\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"0d2e7a0c82d13a85\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"79f6ed0e9a596bfe\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"44fb0095a9c6ecc0\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"e546c0395f7fea7b\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"bbd0f207dde9bde7\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"28ff364c197bb901\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"99528cf6c7c43e7e\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"f692c1923b15d5a8\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"a011b96b2b174cad\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"77ea814409bc9710\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"fbf5acac5ce5aae6\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"41c9cce3233bfff6\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"16b6f9e3562b75aa\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"591e0164203b7272\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"c784a6421a18552a\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"a0d71e19dbee49e1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"3bf5280cc190a93e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"142b204cb5405608\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"0b5a303159fabf0f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d9ad49c4d9634d39\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"339e23819bcf0862\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"a0cf584423899476\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"273903c5f1251bd1\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"1c73892c41a7d392\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"ba206fc093072cd7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ab6ce1bb0d70986d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"b42d188140bba7f6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"8aa9354b6735dd29\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"27f2c280b8c3e9d8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"084ffae26d7f946c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"1957232da1130458\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e30baf537aa2327f\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"a5c85334067ff00e\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"33921441f7179d0b\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"4e484a350fb5bd04\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"30984bb46ebedcd5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"deb51a6e35ff54ac\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"59a424ea9f323ef1\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"4d8096eac7c5ff5c\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"8f7b342d9d4fa184\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"f1da87f80f9fa2c8\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"17dc31a18ab61585\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"8d636adf96806287\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"3668bf0d788deef9\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"8dc492414350e4eb\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"763b7006febea830\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"e72b3158b827b831\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"f86b93eb6e04eaa4\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"60834b57a5c58be5\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"0f94ffb156650c93\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"40472669704e2b35\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"903028b70d0defc7\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"164ef0a40af5f900\",\"/knowledge-medium/src/plugins/tables/index.js\":\"1982ad33091ce672\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"09f95f810a2325d6\",\"/knowledge-medium/src/plugins/tables/model.js\":\"848616fe24931d86\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"45de4246dca568a4\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"cf4b923bdef27751\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"bb24e4b5cb10e22c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"60328c707457b1c5\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"21c5422f59b6c277\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"76027a9e400eea9d\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"2a53d8634e72f25e\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"24834e7b135d5b25\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"667457c11fe96368\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"deb378d4d263a0f0\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"10dc192b76ea2cfb\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"6ed805f850c22982\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"07fd50b7a2f2dfd4\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"23a47ccab891d413\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"40efee9eb04402a9\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"efeca92c7c8b04c9\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"e515ae9dd711b4de\",\"/knowledge-medium/src/plugins/todo/index.js\":\"93551b3c1068aa13\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"12fa35069b0f1c07\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"07e4b987c2c41a31\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"2c4bdc4d4eccf09c\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"ad109aa0201a120b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b79f20f17ddc087c\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"f91e8c5c157808bc\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"4db240c704d6fa21\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"f9d692485cf6566c\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2df6436f598293dc\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"5bd9d859933dfbd6\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"7ce6e64f21691a82\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"d7784c3d63903f72\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"3ccffbb9d4e7912b\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"17f3eb41dfd99449\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"047ba33d0b757007\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"ae3d3faf5c787f89\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"92549ddee93f740b\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"9f0069d006959891\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"fc5a5246185dee5e\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"2a783c9d34cf8f66\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"5d3c844c324c76f0\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"5f0648f20fb28ba4\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"92b03b1815d08178\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"77b2381946ec06fa\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"90a2b012e547bb5a\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d8f225f746bf8fc8\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b25ccff9b9f438c4\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"9c0f4ef73ade9b3d\",\"/knowledge-medium/src/registerServiceWorker.js\":\"74868da7dd9ea72e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"bf3c6124759aca0a\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"66f7370055e3aea3\",\"/knowledge-medium/src/services/authStorage.js\":\"32cfc9de0e5e4ba7\",\"/knowledge-medium/src/services/powersync.js\":\"2ac4be1c89a9a67f\",\"/knowledge-medium/src/services/supabase.js\":\"bfa526910cb016b5\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"ba522a285f8ab639\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"6b6a428e3e20da2b\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"ff16a9f726bfb7b5\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"87bdaf6c76ffb093\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"6e385268f99de019\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"8904d828e0fed3af\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"f0392897600f3655\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"2f2bf22168a08259\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"7bd7a8547651d014\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"2007d9a47c673ed6\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"8fbd6e0d536c24fc\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f15790d602e31df0\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"d4d4f45b7607f3c7\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"fb65b2c4f2bf2a8a\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"5ecb8ff04dc4b56f\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"9ba90dc4bf51caab\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"226aaabcf0ecd670\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"6b78fd2384130acb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"146bd719b24152a8\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"aa51446456837a22\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"cacb526f6421c85a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"63dffef4dd7bee85\",\"/knowledge-medium/src/shortcuts/types.js\":\"810f997e12d8390b\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"7098d7e9ddfc6006\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"4c19fd7b90ef5978\",\"/knowledge-medium/src/shortcuts/utils.js\":\"f06afa2001d02ed9\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"24336f27206e59a4\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"a165531ab916f749\",\"/knowledge-medium/src/sync/byteTransform.js\":\"1df01afc58277fea\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"ab0b028fbc49b419\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"0ada201acaea997e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"868b474505624ce6\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"0421666170f82980\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"1f87a6f63534e490\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"a49ffc39796f608f\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"483812a0ec17a99c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"d3f79ad86ff008c9\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"afaebd87a147aecd\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"d38c52d608419ab6\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a272b439c8ce46b2\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"26fc290715cc73b2\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"423190b54985a823\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"fbc3a35dcde0c0ca\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"e66fac15d49e22c9\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"444de187e6e67fa4\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"0d15ebbcd11e5229\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"5d07db5436c0a0ab\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"04ae0b32ec1a19b4\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"e2e38fdc9c3b43be\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"c24e50e14a9ea260\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"bc788a131bb2973d\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"3c0d24ad3ef3323e\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"4cca62e8599336c1\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"245f6ed44ebf1dea\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"86d40f41006114b3\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"3c7cc55b0387701f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"a191226b42d1dea6\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"dadd6086044b1f15\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"7fc0f30bb4a7d285\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"101973bdc237ca36\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"c803458b8d2d55c9\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"4256294875bdea83\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"0df6be01eabb51e6\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"fc363752dd4b1e2e\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"4bab8fd32729a5d4\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"42f0e9be0b3c013c\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"59185a1b42610c9b\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"96d4fbbf11bf7957\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e83186df04da1526\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"235828fd7759f334\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"0caff27dbd49f31c\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"74249d8dc3eca197\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"9ad19df6fa12887c\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"5f10d9668fb48c83\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"8b0fc8b4907e9af9\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"597e2e25851bf3a1\",\"/knowledge-medium/src/sync/transform.js\":\"08646de90ee43998\",\"/knowledge-medium/src/themeBootDefaults.js\":\"1157bd83f3061b72\",\"/knowledge-medium/src/types.js\":\"d3ed7329436d1523\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"03a608303f272fe2\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"70f1bfafca07cdce\",\"/knowledge-medium/src/utils/array.js\":\"bb91cd01ff30b685\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b1c152735895a3cf\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"7f74debe22aa824f\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"4c71ccbbdbc06305\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e7d10a86ae78f288\",\"/knowledge-medium/src/utils/callbackSet.js\":\"203d987a35e62325\",\"/knowledge-medium/src/utils/clientId.js\":\"1782af7d932d99ba\",\"/knowledge-medium/src/utils/codemirror.js\":\"3f0e10fd0e0c609b\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7805679a340b2731\",\"/knowledge-medium/src/utils/copy.js\":\"f4ae74595e0ff6bf\",\"/knowledge-medium/src/utils/dailyPage.js\":\"7bde7a6b058d5856\",\"/knowledge-medium/src/utils/dbForensics.js\":\"08b14feec70aad5c\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"9218fe9751141263\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"f0a6eac10ba40b73\",\"/knowledge-medium/src/utils/dialogs.js\":\"ba52af678950c0d3\",\"/knowledge-medium/src/utils/dom.js\":\"b13817817c1e4cef\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e8b0fcb908a77c6a\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"de0220f2530627f2\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"b9bb1e8dcfeaf7e1\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"f62a03771c41b04d\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3a9fa6a78b84b081\",\"/knowledge-medium/src/utils/fnv1a.js\":\"a8abb52a2739c927\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7788250d99339797\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"035562a79f1a1ae1\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4e8e78839d26269a\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"3faef7a365786948\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"c90f596629fb1db4\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"ce4a602251cc60bf\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"b143ba33d3181220\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"b7dd95f991534d3e\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"094b633674063f83\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"7e29fabfcab06fed\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"5def2bc1a18be0b8\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4dd6290f842b3b39\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"4dd683964c0f04d6\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"f6515519c4e806fe\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ae17b948997ea311\",\"/knowledge-medium/src/utils/memoize.js\":\"a4611d7da88d5eee\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"b63d608153f02447\",\"/knowledge-medium/src/utils/nameList.js\":\"bc78eb361246d009\",\"/knowledge-medium/src/utils/navigation.js\":\"1401f8161353e24d\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"693263c5faffd51e\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"234302ea4f97cd99\",\"/knowledge-medium/src/utils/panelClearance.js\":\"ac229547714d0aac\",\"/knowledge-medium/src/utils/panelHistory.js\":\"e426714c9754557b\",\"/knowledge-medium/src/utils/panelLanes.js\":\"10698dcdaa031325\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"0eb9553da8b0f8bf\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"b0248a22dfeac5d5\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"b49d3a7409d1738e\",\"/knowledge-medium/src/utils/platform.js\":\"b01bf87c5960372d\",\"/knowledge-medium/src/utils/pluralize.js\":\"f5fd012e117faef4\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"4a48f03693614fed\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"9a90b1423e2e64b1\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"3ad8940e48816ba9\",\"/knowledge-medium/src/utils/react.js\":\"f58daccfab58428c\",\"/knowledge-medium/src/utils/relativeDate.js\":\"93d3bd62018f5042\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9c19e65a071036e0\",\"/knowledge-medium/src/utils/renderScope.js\":\"c0f47f4246979fc7\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"6cc5bd3bfb31a8c0\",\"/knowledge-medium/src/utils/routing.js\":\"bb136cfdb252edf4\",\"/knowledge-medium/src/utils/safeMode.js\":\"aedd00cf1f11e368\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"4aac8126bcaec0a2\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"7e3ce1cab5b3ff5f\",\"/knowledge-medium/src/utils/selection.js\":\"9033dc36f5cf59f9\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"1e064fb77e1ff550\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"238fabfefd1824d1\",\"/knowledge-medium/src/utils/state.js\":\"3ef878572718b68d\",\"/knowledge-medium/src/utils/string.js\":\"6745079c47d1b316\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ef435e537443fdf0\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"44152255208528b7\",\"/knowledge-medium/src/utils/toast.js\":\"db97c9b6fe70ecd2\",\"/knowledge-medium/src/utils/toggleStore.js\":\"131026937a812bee\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"4b8489f8b6e66aaa\",\"/knowledge-medium/src/utils/userActivity.js\":\"a512a1052dc34329\",\"/knowledge-medium/src/utils/viewTransition.js\":\"9406dc7b4bc08c75\",\"/knowledge-medium/src/utils/viewport.js\":\"d391f293564167d7\",\"/knowledge-medium/src/utils/webLock.js\":\"27e975dbcd22f5cf\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"67b3c083772e697c\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"a47f400c8598542b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"8552cef8125a0354\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"e6259ff899356aa1\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"c30d8b03ff5c30ae\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fb311d5fe58068ae\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"48c0e83040ff8043\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"1601e7c10952f970\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"43efd3025e2d0087\",\"/knowledge-medium/src/vendor/react-dom.js\":\"216abb59b81f0b20\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"fabb56a92dc98952\",\"/knowledge-medium/src/vendor/react.js\":\"edbe5ca807cd121b\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
