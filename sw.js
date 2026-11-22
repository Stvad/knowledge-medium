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
		buildId: "2e4ac60d184a-02701ffa",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"65efcb1d95942518\",\"/knowledge-medium/index.html\":\"65efcb1d95942518\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CBK1vqRz.js\":\"6d6774b118243868\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0a5c9f4287134cfa\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BlKffCkq.js\":\"4944d248a275031f\",\"/knowledge-medium/chunks/FacadeVFS-CLKWBKz5.js\":\"1705bcc330961fba\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-j8Qz5jpw.js\":\"72347dc94500ab91\",\"/knowledge-medium/chunks/MemoryVFS-BM7P7NQE.js\":\"188985ec8cbdefbf\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CYsG3OyS.js\":\"c339f42e1acf9cb6\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CcLy479V.js\":\"b03f0fa66d9b0dd0\",\"/knowledge-medium/chunks/Preview-B9__5qrB.js\":\"1095a354377b6085\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-nAidUGDj.js\":\"3d4c99511f159da5\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-ClJ7JQ3V.js\":\"e9d5cb3308ff2bf4\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BCHhPthM.js\":\"eb75482ee321fdd2\",\"/knowledge-medium/chunks/react-BLBZ0OBZ.js\":\"764fcaab6bc40122\",\"/knowledge-medium/chunks/react-BMXtq9qJ.js\":\"a1c01f80eddda46f\",\"/knowledge-medium/chunks/react-CA8Rnidq.js\":\"f414c1fd10b7c83b\",\"/knowledge-medium/chunks/react-CTxfxgLz.js\":\"023cf83d60c9fbf5\",\"/knowledge-medium/chunks/react-CijVNUzm.js\":\"af31c024966d55c9\",\"/knowledge-medium/chunks/react-YIO_Ucnp.js\":\"fe34226c696d9b8e\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BbGGp6nU.js\":\"ed374c4bd5d2362d\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DgZlo_Lw.js\":\"4a38a7f2dc65fa69\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CrbypR_U.js\":\"e57ac43e66a8268e\",\"/knowledge-medium/chunks/react-pV3RgZHe.js\":\"a0dee40205a02ed0\",\"/knowledge-medium/chunks/server.browser-MtyRLfpv.js\":\"c4a6e368392bbbd8\",\"/knowledge-medium/chunks/textarea-B0WTM8Ro.js\":\"1b218082bdeaa152\",\"/knowledge-medium/chunks/ui-BaYza-YS.js\":\"4b0133a163081bc7\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"7ae9d07a8d1c6d32\",\"/knowledge-medium/src/appUpdate.js\":\"f12dd97b84ea9680\",\"/knowledge-medium/src/appVersion.js\":\"0e85add94847f5d1\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"34c1ec566841b3b7\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"620b227a554589e9\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"d47f794148faf5c2\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"bc6eb628d2bdb362\",\"/knowledge-medium/src/components/BlockComponent.js\":\"c45aca2480127e2c\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"d4409f14315d559a\",\"/knowledge-medium/src/components/BlockEditor.js\":\"57b00f7f288bb6b9\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"195c0f28171b70ee\",\"/knowledge-medium/src/components/BlockProperties.js\":\"33d6cc8a15f29bb2\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"53ccbaf706bff41f\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"644ab9d502f89e8e\",\"/knowledge-medium/src/components/DividerHandle.js\":\"cf57e323d43284cf\",\"/knowledge-medium/src/components/DraftEditor.js\":\"1094ff6b34c140ef\",\"/knowledge-medium/src/components/GutterPill.js\":\"4555eb34b8b1b7a0\",\"/knowledge-medium/src/components/Header.js\":\"9d1fdf090fb3c75b\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"f39a3dd82c935e8e\",\"/knowledge-medium/src/components/Login.js\":\"734dadee6dc15a8a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f839a37da0eaa1ff\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"dc25a1c2ab722ae9\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b5d3f4f128f4e4f7\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"90b06cbb27ea8b12\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"9588131c8e592764\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"1aeee7810a144d1d\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"65cacf495516fa76\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ac5519a717af759b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"48a701218f2cccdb\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"24ff283a29de8653\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"4b377bb0dd8d553e\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"08f3268fe209150f\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6bd50c54e547624b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"f0932b7133f83452\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"0f42c9ab19ea9adb\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"9b8aabc8a172faa4\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b990dd8ec3ef4c27\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"ac1a7fd5fea9a621\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"2344100412911163\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"14100dd0228521ea\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"928b792d776a3ea9\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"f417598205a74466\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5a959d73b3518b0a\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"10420aa7ccab5a6d\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"f55034c6dfaaf069\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"87761937d6bdf0b2\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"fd5b621b73721ef5\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"4d40cf96054a7490\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"a949e8e2b4464d2f\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"5022ef388184c8d5\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"6ef9cc6b619aa711\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"2e46de42274ee98a\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"ff086842420f940f\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"2ef12ccce68e9d7d\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"3b4f784e2f351c3a\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"cb390b6cff12dd74\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"a5bdd6a4015818fc\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"1933cc4bdf715d1c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"bc0cc7527096c4cd\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8e6a5115244734db\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"64e0bb497dbea481\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b2cb55acebb32206\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"2176d8028fcdb455\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"4a6b8849d58cc4ed\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"f61c50e3e1324e64\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"21581a3b28ba56b0\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"3fc093e79a875072\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1621ecbeb4578a63\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"3b2fbc1664e5648a\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"10cb03a2a8b44f4f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"1a73e2b573053cbe\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"f6df73a7616d77fd\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"c67f155a0ff248d8\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"b5e9c6ea2238bcf1\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"e1271544369d8125\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"b8512d6eca516591\",\"/knowledge-medium/src/components/ui/button.js\":\"7ebd5795f645ee7a\",\"/knowledge-medium/src/components/ui/card.js\":\"535087ebd5a61ff6\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"e110d0f9cb4e002a\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"8de44fade9a92ea8\",\"/knowledge-medium/src/components/ui/command.js\":\"70d4fca99cedef88\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"c99361f18eb8f954\",\"/knowledge-medium/src/components/ui/dialog.js\":\"13613c59945e8df0\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"fb796ca4c403565c\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"ef5e66fa7ccba69e\",\"/knowledge-medium/src/components/ui/index.js\":\"136d07fb93337916\",\"/knowledge-medium/src/components/ui/input.js\":\"482284c95ac9dbad\",\"/knowledge-medium/src/components/ui/kbd.js\":\"14731a6a1513fd55\",\"/knowledge-medium/src/components/ui/label.js\":\"bfd226dc3375bef1\",\"/knowledge-medium/src/components/ui/textarea.js\":\"7d1faf32d4e3f18e\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"ca22392be2ea31ce\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"34b8709265673a53\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"c58548a87c14a641\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"27cd3530aeabc5dd\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"eaff357e82d50b8b\",\"/knowledge-medium/src/components/util/error.js\":\"03897751bb67f83d\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2c708a94b5b47c36\",\"/knowledge-medium/src/components/util/suspense.js\":\"80a001091ababca8\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f5f3b321fd84ead4\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"1e9c7a20c12342f6\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"5b1d4c9e0ca785e7\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"9b8975ae48d965ff\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"def7914b6b5007c0\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"79b69c3c769d09a2\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"48b6ef1870a4e961\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"fd4f86b0d1f2a845\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"acc7d0d4d4ca6d1d\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"5d006dc5f9e258d5\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"f3ce9738f72c4f14\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"d85ead47d49a5e77\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"28b7591683f1d285\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"380f5e575163e4c8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"0c74a68152840266\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"a543827414a98ba6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e4d0ac6bb4671cae\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"3ab5910be6035510\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"568d5e96403566c6\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"6777b5a248acd1af\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"c9e5b1915b6d4674\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"b2f72422231b3ec8\",\"/knowledge-medium/src/context/block.js\":\"ea44723bb2157099\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"079af95d96c9a909\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"5d065ccf747f49cc\",\"/knowledge-medium/src/context/repo.js\":\"1bfd301bbaa80514\",\"/knowledge-medium/src/data/aliasClaim.js\":\"92cd6aafe68a144c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"dc00b4c796b8bf6c\",\"/knowledge-medium/src/data/api/blockData.js\":\"ef954a24aef888f6\",\"/knowledge-medium/src/data/api/blockType.js\":\"1a81f28a9616edf3\",\"/knowledge-medium/src/data/api/changeScope.js\":\"6b362b94c5cc174c\",\"/knowledge-medium/src/data/api/codecs.js\":\"5791a825fb3adb93\",\"/knowledge-medium/src/data/api/derivedData.js\":\"548f4e077dd6d1cc\",\"/knowledge-medium/src/data/api/errors.js\":\"9eef7495f0302a38\",\"/knowledge-medium/src/data/api/events.js\":\"1e1fbac2a4e591f5\",\"/knowledge-medium/src/data/api/handle.js\":\"2556f4400fc6c1ae\",\"/knowledge-medium/src/data/api/index.js\":\"207a1bbb53e36129\",\"/knowledge-medium/src/data/api/mutator.js\":\"242f0abc3e025be6\",\"/knowledge-medium/src/data/api/processor.js\":\"300c277a2117fa4c\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"98e2ece3adb7f484\",\"/knowledge-medium/src/data/api/query.js\":\"537f4789a5475979\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"4ca102a892fdc9d3\",\"/knowledge-medium/src/data/api/schema.js\":\"2556f4400fc6c1ae\",\"/knowledge-medium/src/data/api/tx.js\":\"2556f4400fc6c1ae\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2bf6157c50fbfd80\",\"/knowledge-medium/src/data/api/user.js\":\"b9039ab3fe792bf7\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"7e50dee8187573b5\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e61398255d540733\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"523ebe43721a9d07\",\"/knowledge-medium/src/data/block.js\":\"7c39c980bef461fa\",\"/knowledge-medium/src/data/blockCache.js\":\"37b01596d02b8c2a\",\"/knowledge-medium/src/data/blockId.js\":\"4987921a21ff85dc\",\"/knowledge-medium/src/data/blockLiveness.js\":\"b89b3f0390d5d33c\",\"/knowledge-medium/src/data/blockMerge.js\":\"022e0ee16284ec18\",\"/knowledge-medium/src/data/blockSchema.js\":\"045d04cd858cb21a\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"2c69645bf80aa2ee\",\"/knowledge-medium/src/data/blockTypes.js\":\"3a291fcf07bec492\",\"/knowledge-medium/src/data/clientContext.js\":\"bc655fff1a3ed0f1\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"388eecea8d4a5e14\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"8763bf85f8f3fdec\",\"/knowledge-medium/src/data/derivedIds.js\":\"2d6ca66ea9edb20e\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"9df925b9b70631f2\",\"/knowledge-medium/src/data/facetBridge.js\":\"eef4eb0bf9285197\",\"/knowledge-medium/src/data/facets.js\":\"252cb876b9273053\",\"/knowledge-medium/src/data/globalState.js\":\"a50d397c0b610e1c\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"06629aa7557f1be0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"d70dd5dddb43248e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"ba842e503dab5dfb\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"4c707175422a2f79\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c4d9852e99e86cd4\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"7ee88f84ca65aeb5\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"ff1ad8fd92ebf72e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"fee415e62ec8cffc\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"6f46ee932e2838db\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"9bd28f90dd6123d1\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"b9fee69dc30b5fb1\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"cadc982a05aaddaa\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"9ed141c4a0e9e53b\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"904cdd76ba3389d5\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a0d5654265d0c639\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"46898680cbb23af4\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"baa94569aaa93ff8\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"6afa82193e233062\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"e6949faeff7fab63\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c3424ae44c2be4fa\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"41defa562b9dacb4\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"934b93df22a34b29\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"2612898d4b800b2d\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"896df384a4283fab\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e23074aad06def16\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"78cd9a1a170565f3\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"4689982312a8f201\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"7ff0d04e1ec5cf0d\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"385a3a8f01186ac4\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"1c599dc149e709db\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"55c1c323aab26409\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"74ecd99f4d1fd7e4\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"cbd951caf234faec\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"10f1dda05914e9cd\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"f312e40345f43d59\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"9cb9038517526f20\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8c16d1abd4316f20\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"d3c3467a3c83a347\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"781fc38aef840a02\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3e6ae5bcd23c19e5\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b063a2b5d1827137\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"8f63e8136b91f8dd\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"525f44e33d23fb3c\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"a9e65775c1d15ba7\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"1d1c91a6045bd136\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"91cc1e5e672cd211\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ec59c192819ba36f\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"1f4af3565a799edd\",\"/knowledge-medium/src/data/invalidation.js\":\"3ce5012cf69160cc\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"69ac041301e86269\",\"/knowledge-medium/src/data/kernelPage.js\":\"9febd3f602cc5b24\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"e27f6c1288ed6351\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"a98e6e69740b56dc\",\"/knowledge-medium/src/data/localDbStorage.js\":\"4a8121078064ffaa\",\"/knowledge-medium/src/data/localDbVfs.js\":\"21d7b15702eee95d\",\"/knowledge-medium/src/data/localSchema.js\":\"4e5fc7ea4bad8a93\",\"/knowledge-medium/src/data/maintenance.js\":\"702b148bf1a2199a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"c20f1271e8347800\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"2356c792fd5b465c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"d7ec6c0c3a3bf0c2\",\"/knowledge-medium/src/data/mutators.js\":\"069173c8fd9b19bc\",\"/knowledge-medium/src/data/orderKey.js\":\"a2e24edc9334c091\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"4e5ff13fa0f836f4\",\"/knowledge-medium/src/data/outlineSurface.js\":\"4b8cf16ba2a44587\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"7fea32d08e49f735\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"a1ab4b81d81af649\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"ad61188c8202dd40\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"2721b7358b8f27cb\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"1663def6c9c03095\",\"/knowledge-medium/src/data/properties.js\":\"0bd8b876473cf28a\",\"/knowledge-medium/src/data/propertiesPage.js\":\"052e25f6c0acb63c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"6f9f961e02a324e5\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"caec48b3e041c9fc\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"e9684a641aad6f6b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"e4ba175749802db4\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"55fb1cf34568f93e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4c7152dbfc7f1001\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"bf8426cfdb40fbfd\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f9d9d6c346985279\",\"/knowledge-medium/src/data/recentsPage.js\":\"edf73fd6eff79665\",\"/knowledge-medium/src/data/referenceBlock.js\":\"b887ee5f0cfd3af2\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"78d4428b884b49cb\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"bfe276755e1c784a\",\"/knowledge-medium/src/data/repo.js\":\"9020ee4dad60af46\",\"/knowledge-medium/src/data/repoProvider.js\":\"d7395f30a0b0f7b3\",\"/knowledge-medium/src/data/rowProperty.js\":\"85a6eece85cc3771\",\"/knowledge-medium/src/data/searchFilter.js\":\"e33f33cba646aae5\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"42bd1bf4c8c9d994\",\"/knowledge-medium/src/data/stateBlocks.js\":\"cba3b9999e12676c\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"71e5545df7d4aa82\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"c07944fa4571979c\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"c4b50706373c65dc\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"c69dc7eee3c3b854\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"8a7c3508f489cf7e\",\"/knowledge-medium/src/data/targets.js\":\"ee0be93c82647f8e\",\"/knowledge-medium/src/data/typeColors.js\":\"d85188fc179592e9\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"200441b3357080ce\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"86c58c1b0c856abf\",\"/knowledge-medium/src/data/typeExtraction.js\":\"29f29315195ef318\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"d1ab92cc6fb6b945\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"95193fbc0c559f44\",\"/knowledge-medium/src/data/typeSeeds.js\":\"d0f0585cbde4d2c9\",\"/knowledge-medium/src/data/typeTagger.js\":\"8af496ecae004b98\",\"/knowledge-medium/src/data/typedRecords.js\":\"25b19f8cd659c7aa\",\"/knowledge-medium/src/data/typesPage.js\":\"8b45d73005be5c10\",\"/knowledge-medium/src/data/userPrefs.js\":\"574eeac42f57700b\",\"/knowledge-medium/src/data/userSchemasService.js\":\"271eb97c3ac7841d\",\"/knowledge-medium/src/data/userTypesService.js\":\"6b0bc545dd414a39\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"0a0e83a393e0ac82\",\"/knowledge-medium/src/data/visibleChildren.js\":\"6433ee09c9c3c903\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"b572960e47dcd1e2\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"4e9ccd85eee94f02\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"590513d4ecf171c9\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"ec3b1583e14fb791\",\"/knowledge-medium/src/data/workspaces.js\":\"987780f5f06429eb\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f1f109c285924330\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"7943c3445c9b1d6a\",\"/knowledge-medium/src/editor/atTrigger.js\":\"49ccff7c9528e34e\",\"/knowledge-medium/src/editor/autocomplete.js\":\"fc9c6d6fae2659fe\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"f9c68f6cadcc3391\",\"/knowledge-medium/src/editor/contentFlush.js\":\"5927d2e39691e374\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"ee29e82fe9558d68\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"c08fd6835636ac8d\",\"/knowledge-medium/src/editor/insertImage.js\":\"bf9eeac9b0a5b141\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"df0551d4d43ce2b3\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"e1dcf75ac63c36fe\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"02bc8fa0627f35c4\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"ead91ead92bd30dd\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"5b71b6f1c8f28979\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"cdc8aa15dbd027c5\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"71c2493cf768981b\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"57931a201fd114e0\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"ba72928392b79581\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"4c32010565b7d8f2\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"8ca4b1c240e93319\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"770ef484be094e58\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f18d04e56da43df6\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"2e2011577fe9fa12\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"313fbd7b2ca6584b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"9adf17582d5c0e07\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"5f5ac05075698abc\",\"/knowledge-medium/src/extensions/core.js\":\"4169d88519974a23\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c21b60d8925ea98d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ae44dee28788b60f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"f935939d7c884363\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"3dc3ce8f7e01dde6\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"d7abc7fa886d7a82\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"442263d6934b56b4\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"795aeee6b2c9aea0\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"04f7fe74bcbbcbdc\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"bbdbd33bf1067428\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"25422257dcf22c6d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"bcd4eca37e6276be\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"89c44324a8c83c8a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"d5666867e19a3077\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"33d743f70931d33d\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"6e5bd9ba69c6e4ee\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"fbdf2ab968051a44\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6878677613afa02b\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"70234a40626e83a0\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"00935f9bb7816156\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"03b1d96e29a83538\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3f8a4cb9fb9dce06\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"bfc7dc8391c07461\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"6d4125537dd35cf6\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"3acc729cc90ae404\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"45f66fda4b558240\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"8ec93e006fc5979d\",\"/knowledge-medium/src/facets/facet.js\":\"b6e31d1cf30ccf5f\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"985719e3d979e067\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"196051b462734d28\",\"/knowledge-medium/src/facets/togglable.js\":\"f24d84763a02b8da\",\"/knowledge-medium/src/facets/variantFacet.js\":\"eec9d98fd911ded3\",\"/knowledge-medium/src/facets/verbFacet.js\":\"163a66915f7f03d7\",\"/knowledge-medium/src/hooks/block.js\":\"51f6f7225d165599\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f949947c610bd3a1\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"7e6d0f4a32d51e19\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"977ad804cc13854a\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"4d8f9f04cbf0c73e\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"32e783ba755b241d\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"36f35ec834de058e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"8c7955ba7c28da3e\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"5ba85472e88c2cdc\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"22cfb55afc9bb174\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"95aa765818ccd7f0\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"2a593d7eb2ab96c6\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"6a4a1a876d91e77b\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"03347a9e23059876\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"9fd5cb0cd16af336\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"98b3689af4d6dc1e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"ca7405a080e4a2c3\",\"/knowledge-medium/src/lib/utils.js\":\"3422dba643318697\",\"/knowledge-medium/src/main.js\":\"9731c4588166bcca\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"16141df2dd16964a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2aed7fc7ec7b4a6a\",\"/knowledge-medium/src/markdown/context.js\":\"7cc66a14dfc78b4c\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a0042b989f3d721e\",\"/knowledge-medium/src/markdown/extensions.js\":\"1c483c549ea36d1f\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"a0ec796af6386cfc\",\"/knowledge-medium/src/minimal-editor.js\":\"2c2a8d679de88a76\",\"/knowledge-medium/src/paste/armedCut.js\":\"5424a18778cf4c0f\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"01c089b6bdce4c52\",\"/knowledge-medium/src/paste/clipboard.js\":\"e0b412613418cd78\",\"/knowledge-medium/src/paste/decision.js\":\"66fa781e7fd25df6\",\"/knowledge-medium/src/paste/operations.js\":\"306277c503304627\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"08d8b37afd12c0d9\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"42a18a31c0908297\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5be0d77ff75cd266\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ace304fb6566099b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"05f546c24d08a06e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fabc59175aa2b8db\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"2af4f9cdb04784ca\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"acac21f576bdc18a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"8bb711f4fb97a6e4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b9d4855fb49d1529\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"dbca4d0b41a2034a\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d9ed48b69f319abc\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"80d936dc4c47a977\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"e60164fd9a037523\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"efb24e759ccd55af\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"bd6f8cfcdc594742\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"29c3a30cba2b20ac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"539a165e58482702\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b88878214be086a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"0cfd6adbfa639c48\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4af253bbdcdf2a6b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"74d1e4676609cebf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6f06b816f90a70f3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"1b025409bbbe0a17\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"5e712600ab23cc72\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9695786c6452a92a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"28e99b7298266871\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"754a4f8c59bbdae8\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"533408c600a285dc\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"5bb20ae3ac42036b\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d002e370d395389c\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"942e04c7967bf6e3\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"cd3c12bd7fa85f26\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"e4b3fc5c3e941901\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"34ffaef86075f2ea\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"55ef3ed0379398a1\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"5d65124d87a501e3\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"59527ad9023b582a\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"355b3fa5e207276e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ab4d555ac7e7b993\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9bccf35e6ab636a5\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"69c17f38e3a9ff4b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"f3bf5fa43041a630\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"cfa2377fc52903c1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"3ddf8bc8dfd88c65\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"22ffe84f043d3469\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6a76c13f231a2d9d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"93077ebc1c4b2fb2\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ef9a8d119ac5750c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"717c6c819198bd42\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"ee272998431aea82\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"9a490cc55612e634\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"bc83cff7c17a1ee5\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"b327198fb164fa91\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"3cfc48941c5e6b77\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"e1e3cdbb3dcde24b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"f5dbcef2512c348b\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"c10d2c437fd670ff\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"d40f560ac41f45fc\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"09dcad4c3162b19a\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"3172f13871f55833\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"53769f9e616b9f15\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"abea05cbf58372f8\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"28593f53b338f3a1\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"02db517bfd437bb1\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5f635fa919ed11ff\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"050a2cbe2e0b4831\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"dce09244c1a65ea9\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"bd5f49bba3bf94a8\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"0ae2bfe41384a263\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"e21174e31f8f5afd\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"137f333fd112f4d0\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"0d537b20f1d524a7\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"3bf1e2255ca08c1e\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"02e4acae2759ff82\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"02490c0c85a17434\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"23a6648dc8447ef8\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"fcb9710853703be4\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"b07bf72c668d0cb6\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"011314cca5ae670d\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"91c75dad21c86730\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"118f2a21c5d31d4d\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b4eae7f9f3afdc00\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"c40ba433d01fccf3\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"5253ce0780a45eb2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0e620e721c622638\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"ba628e2713b5d44f\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6273b008373c6c89\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"88bb0200db23724a\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"b382d2b9e37e9180\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"8c397f7ec8c3e52f\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"4abedb13e93651a0\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"dbd8d8c21755b1c3\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"e2b61ca73b51658e\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"6a69ec6f17aeffa8\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"56ba6b9738d519ac\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"4761f10f903b638b\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"7caa8d343ba5e4d3\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2f5065087c269f57\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"702e76d8d688f562\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"96a380db9872c8ae\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"2423cada3c04ec90\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"584f850286d9a933\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"5894d236f97b4332\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b2b9846dddb03c7f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5e8853d5f1e51297\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9864c2d879faf603\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"e16c29a4356adbad\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"1f88573ec71991da\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"bb6cde225e313533\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"f4a4a65582f704d4\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e5eb2d4221858f4a\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3b1e1c913d1b7d58\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"897cd49b67010724\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"e1e416d7986c1e2b\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"624d07e5569f00d8\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d2411363d46430ce\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"64eca58f3908c2ce\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ae60e6c4d96e8917\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"b218a0050febb6c7\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"df28887b1b565893\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"97ec776ee8c66a06\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"b780f30f51bb8089\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"ab136b577f682bfc\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"ecacd92f47cfc9b3\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"276fc3c86ab7177c\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"67c34c4ab1196189\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"57fe7a7b9e297116\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"68df33f74fa17276\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"5b5b22675a93b437\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"6601814f825b941f\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"f579bbcd5010a16d\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"4fe8e619fd8e4a67\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"b175eaa6c334faff\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"824fc949c1c8aeb5\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0825f1d527b06869\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"ddc1f839bfb30b1d\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0c1aa1b633ff52da\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3ec13cbf78657c9a\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"31407eadb4845890\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"9a048652a76ec7cd\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"e2a64b9b9c82f735\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"49b928275b731543\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8f937895efc1a8ba\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"f97e622795292b75\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"e17419a40ca9ebe9\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ba6aba28b4e678c7\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"5e572be677b2e8b4\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"c9f6aac016254490\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"97dabb2f127bb75f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"060c5aeb98ca3ac8\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"36558e9274dba2fe\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d40556d2f773fa4a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"592c7558e7d2e6d6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"7dc10bb6ff132812\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fb28ccfd146fda30\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"8c8938d6e6b07f57\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8859b2c387c9eeb4\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"0749e71320078baa\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f5c6eb6c3720d305\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1c26b5b3fda1e9c6\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"cc54ff29c2f34dc0\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"791683760caa2286\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"69744d671dd7acc8\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"68fe33b196c920ae\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"613f19de35be9bf1\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f0e599cf8cb6c64c\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"4eaa37335977e27f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"fce0e91d7786749e\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"de9d86ed3513d9e3\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"07cb54e73f459bb3\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"a6ec2e4562f55cea\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"e24e15f9b8187d7a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"c8683f517b23c6f3\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"42bfe6a1e0d31516\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"49c698b5ea7b0c94\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"02ce4238ae72d4a7\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"ca8328fc80fa8fd3\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"536a38c062e970e4\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"03981451b3ed997b\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"663ab93f3be0847e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"c20eeca8420cb274\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8d0c59383df985ec\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"fb70c3be5048ed26\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"3d908efddf3ba575\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"2ccc9e4847e46248\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"041983bfd7ed063e\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"813f56783cd59f52\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"042501f600eb4ccb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cefc240dd70fcaf0\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f9239ebfffb1bd87\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9993e1e1e3fd853b\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c28a9ba3c26f65b2\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"f7e50f54ddc66ece\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"166441af13687837\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"c2cfcaebec7d24ea\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"61878486b2bef505\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"6a71fff9e00a1579\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3d2c509b28698cad\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"d09841f40b96ca44\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"aeb87653307ad5a1\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"d0a8530332d8acaf\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"90c574dfe16a47f3\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b9962d9e7fac2765\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"5ce428257e93650d\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"caaf6101d3c7bae3\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"b4fa3ca3a207530d\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ffadf399ebb35f9f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"98fc6102e08021dc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"0f2a9c0485542565\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"f3168f32a763c347\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"59c4cc4d6cb7cc95\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"e5d2081696e9d6a9\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"1a123eae92b7b618\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e0c0b5272027b953\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"342b3ee2c84d71bd\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"10f07141bff2d796\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b933eab67ecbdff1\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"4f2e7c6fc3d2d8da\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"cf813346afcaa523\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"fc0dc63fe1fe514f\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"67aa3ee2814474cf\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"638c60fd877f5fdb\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"08cb426951323d34\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1bc09a308d45a5b0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"5355ce510316453c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"80890692e6778c0e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d5750c1c56b49a90\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"4e3ed7ef8e7ceca3\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"14bc91c86f2b7893\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"33070aa4d02c38f1\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a3a9fd139116f187\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"9fcf743cb9fd853d\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"40b3e26fcfc02647\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"de49ad3a2cc46cb3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"27734cb3ca44a9ca\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"fde5757503d398c0\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a7c590fed94a3f6d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"c22ed135e4e88426\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"f25f0424aa3228c5\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"66bae1ff21ffb56d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"3b137cad343a9f50\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"734379c0f2c89ce6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ecf3eadff22cb682\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f6a2b5e9e1260e44\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"fa6cf4ab76f60c76\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"0a8058643049ae66\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"3c651b5fa3272b4d\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0ecee41482eede73\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"63988d70aadbbb01\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"e24b413aa9729cab\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"fe00c3356e5d298c\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"289668978ae6249f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"8b0491035475fb10\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"e8da62c3dc1c5400\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"34560e6c27aa59fc\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"dd5f985345d71ba8\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3423370a3d3a0890\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"9773f713d38aafcf\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"7cab9d989ab9e764\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"6ac440d1cf3dceb6\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"7cc810142ef84e6c\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"0558fbb27c13f90a\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"2f128891d063192f\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4f3b1e026895c499\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"9ba14c7d64285d34\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"bb5726e804cc7647\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"06d77aa9b7f13660\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"21a6d0f307627c1b\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"4b1ee08e0266df60\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"ddde256822589191\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"9ad9a3894f6de18c\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fb4c66e2115c922a\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"8dd127fc53a8b363\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"0765b5ade02eb7b5\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"11b7143071be8334\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"fd7f47504088aafc\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"1a29648649dbf730\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"e4943c00b1179f8d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"cb7c349aa090774b\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"b19b0f3bfda26d3a\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"932de5c56a3c6b5e\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"b1a20fdc31ecd8d4\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"8da82df27b42b8ea\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"f9655668893b1bb4\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"21f4dfe096656d6f\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"ab4c2e5fa4d4cff4\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"4aa5f057cc510b31\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"59efde31455da21b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"76d10c8e2f18a251\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"433f3f84bd1cc6e5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"3142d43c1126c417\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"24cd92ceba301af4\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0386058dc4bebc23\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"28f8a5a7680a82ff\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"264b677e5f6c0716\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"3b5dafe84707a3a4\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"9aee901cebf61a37\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5c84e77b7ef594ee\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0c1fc76cd3c583a2\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"6c61fff2944bc60e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a4d30ee49a3be293\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2807e515f53da3cb\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"3f4c6cd73564e689\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"1324cc3c086e0195\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b4defca21b836fca\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"b95ff578a668af69\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"e7af3c451375d6a6\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b503da3423b1298c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"e9e339b422d80734\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"8c167241cdc5a920\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"f241731ce57049d8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"3b328447a45bc30d\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"00d2df909b1adfb4\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"8a14d8f4002229e8\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"aa51b2be40ea1853\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"57a888b48e205573\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"5916a2b19d72a525\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"bc51cc06c60c6424\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"f95eb041a998687a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"64ddb3b10fea1326\",\"/knowledge-medium/src/plugins/geo/index.js\":\"2e36749e9d1a7742\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"4b5facc8b388f9a4\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"835a651d685b3279\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"d6eb5566e1ed7ceb\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ec2ce6aabb2e6703\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"0516d51fe8163457\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"bf840a6d701bee25\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"b0aacbcf924c5f0b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"7008abcd5e6d563b\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"8018aade21568086\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5e89da110f153ffc\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2fd62af8440ba1e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"920c3137458f107f\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"df6272f3fdf20b7e\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ce8a192a134c00c4\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0f9bb95894f868e5\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"d0f7d0ae8fca39a1\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"d1e07984be1d258d\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ec643961753b118b\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"b49f818cc0169ac8\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2da95d0b3dee8e2e\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"438086c15fa5f182\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"33d73592d8c87383\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"e5ea5bea4f3b440b\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"228e2483e11f869b\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"d43dcc8ae9bde206\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"6c14f3d1fcfd9d42\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"183d02b5db9a36d8\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"c2160405ad50b9d9\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"ab8c29ace24fe5b7\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"0e278aa42d26102e\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"5974a743c1f8ce6d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"1245f3a1a8263bcc\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"8f50b1a60159f7a6\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"0bd9743ddddd8c64\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"041f575ece32ddcf\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"658bfda11f60571b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"680060103f7c05dd\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"029a7b2696ba2b3c\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"585471085d2b99e2\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"7b19c8d0742e80ab\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"54d67c7bd04147a7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d049fb09f3409cdc\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4181b3294e189e64\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"592e24bba4d5e55d\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"107dca0d77c1f6a1\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"18453aadc57f00ed\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"a228557bcf2fc01e\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d524d48df9f321fc\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"8702d196bfaeeb69\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"d39122081b25044a\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f71ca1fdb3652618\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"397b8284839d628e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"afebee4bedbd9de3\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"55721f5e65fef73f\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"70dad3f780f71a2e\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"1ac22c81afd2933c\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"b56952132afa1bb0\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"b553d40f34fed86a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"ae48e235100239a2\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"dbeb84a18c3d51b8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d1e5d681598019b9\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"f2d6938cabee8d04\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f65123766ef4320d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"70fe1643fe02f85c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4d78d3ce7c8f5504\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"1d6108d7c02ba4f3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"fa78368871325652\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fbcf9be636db438e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d8c3dbf4ec508db7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"08a6c9b94c7a9ec3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"16546916105c549a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"b5403766803f0cc6\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5664a5d2c3111e04\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"216c4235f6b28670\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"72f28e005ca203f5\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"d85b89731ec54225\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"a35abba5029343f4\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"659e7e2cef80aed2\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"73ab534f6f883635\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"0a1d5813b058b259\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"8abcf372122e45a8\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"9122d1e2a96d58f4\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"8a5327694a7c1089\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"6e637f6dd282c725\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"46847d6cde2d1e8d\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"2727ffa1ff17785b\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"d986326bb9592e5f\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"519cfa01f554b77c\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ddec9475a78841c4\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b876c6b2cd102633\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"e9c0c804fc8796f6\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"fd82cbca8e35b213\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"34a743e79fef8e6b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b40d14f909b30c53\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"b373c4aa25b5e800\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"40366b7caf7a00b7\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ebc1060975ee49ca\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"0ac0d61bea1b2bec\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"365a811ed0284efb\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"fef9b893db037a9e\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e165f42ba3d37513\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"4b05b1f740ea6fa6\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"bc6151655d19a5ed\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"22edb4bd032edfca\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"c8836a37d045e4ed\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"22461ff4fe2b729d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"187e2b4cf22552ea\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"1e8b8955aa31d0ec\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"9f97b69e1130bb37\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"2878f1b6465ddace\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"0cb3ecbb231f927a\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"6e9df061219f5b05\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"9af52a27072a8a6f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"265e4117d4cd7513\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6d8b0d91dc4375ef\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"9423b130e6bd7190\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"823219adf2782fa9\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"f775406f9cead57f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"47392b6035d9b6fa\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f85a7b4c6b1e2202\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"410869c97bf8e7bc\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"0dded5f521435c15\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"ecace50d79e5f780\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"51058d64a217c5ff\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"2f1985218659d8bb\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"fc3c5f8f0afaf741\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"05abd70583a700b6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"4c779f793ad13598\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f617b3cfe38f7790\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"a1681bc8de429e31\",\"/knowledge-medium/src/plugins/recents/index.js\":\"98059e749ce014a9\",\"/knowledge-medium/src/plugins/recents/target.js\":\"435638816fff65b6\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"f8b83a0ffede91b9\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"87b06dce3654acae\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"d392cfc564acfbf9\",\"/knowledge-medium/src/plugins/references/index.js\":\"466c023b0bb5537c\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a13775b7f631e46f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"e28403a67faeb75d\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"21f57272d2d800db\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"b7c9f233e5a83a0d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"dd81890b4fac5a99\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"bd20034896e1994d\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"76d939e40bf6de26\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"331e0cb7a1fdda9b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d19c90192e15c3a2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"ab4f45bdb7c85cfd\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e558e1d28ec53c58\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2d7c475591d8fb75\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"be8419f47e4a5370\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"f319a573d1dec79d\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"63df3093fd3dd609\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f59a133ddc793adb\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"0d823f5b18a42554\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"b4664abe99da2aec\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"4e93eb51a7d4f981\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"aabcbe39b4ef233d\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"e5d2bd4597a4e9a3\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"358923cee59f5de4\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"61ebccdb11e48620\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"ffc089e06896ee48\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"6838012e69bd7671\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"543c64012d27beb9\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"555630fc0661b392\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f6076dc7ce867554\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"f91478c4f2aea42c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"8d43fd1255ee6d0a\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"7cfd57525efc9cb0\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"892b88f16e42f5cd\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"a7aa99a766aeaf82\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"f8d34ee2f75f652d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"504f6e459a1c2a50\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"e4d780b3bb1888c4\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"84a3034a7e08fa95\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"18d9cc19ac9297bc\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"dd671c02cec0d7c5\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"7b109be4c6a27ef9\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"8447a6f16ad34ed7\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"3807a0d64c691417\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"01463b3c3390dc7a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"5a6a6e32244119d8\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"673f347ee186fbee\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"cae27bef7bb3cc85\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e66c97c56526a681\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"ee1081ff78c0780c\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"9a3f3efef4384ac8\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"84d30326f9322886\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"18f0c55af7cc5d3d\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f1a170c75f69c327\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"541712bb2be0f793\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"f1be3f3fa277e51e\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ccc5b637dc2c1d50\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"eba4b765497979a3\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"8e65b74462c0fde9\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"8766218d0a568a13\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4e1892b2fcf4b695\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8247a8c617eacb1a\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"4536d3c568d13a08\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"84dd782580052aba\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"c5243f7e99cdd736\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"0acd8ebdc8e5bf11\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"86f8546f34ead811\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"991643bbbbe6688d\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"c5cfd2043e864e31\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ee4259134ecec25f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"ec0e1b9a3998156f\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"775b741cf091f6f7\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"15ee675cd1d3ee6e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"246afcdb6dd85cf3\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"3fdfea915d0184f9\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"38a1012bb0ffe52d\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"afdc9cd7f8e76ac3\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"92088f6b8de57bd5\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"9ea940a53b4964cd\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"1e7355de97534dfa\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a55ce450b40f45c4\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"44f50f20023beb7d\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"da18280927444e01\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"c1aa6c4130eebcf1\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"9bdf84393a648353\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"9e7d717d9fce3da8\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"e4f05ac3c2852d2d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"33cc0ad59f15208e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"6f1e0adc887674f0\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"7fc212fd4e50413b\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"f520c7c38536d230\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"e2d68982816c49db\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"762c1db06003cb26\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"88758b1995d09617\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"6810ca812628a613\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"bbfca9eba6497603\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"87a88bcfa3b5348a\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"3baebbff46ccead7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5cb25f9e3296a404\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"488f72d7d87af426\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"6b882d56782d538b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"33ea3d31e4fe9608\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"2dcdd68735817692\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b5c2732b0292f7a7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2a682a2260cf748c\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"62a710775d1538a2\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"3e60c8cd871e6832\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"d43d6df3519c5e17\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"f0769588b686fbb6\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"366954c5f234938f\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"98ab6525675c6dd8\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"0f236d4411ab6caa\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"6e2b427763079d0e\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"74fb94e5a471d4fa\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"05f32d795d917df5\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7a0af5f82a03b0fa\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"06b5b0882c75a0b1\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"f54a0a80e0ded420\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"9a6b373a9b63a4fd\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"f1621d97a7656184\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"f07d2bc4d606e0bf\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"fdbd2e7d5bf0d0ca\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"d33612a74bb6798a\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"004a441333c4053e\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"ea5e62481c8a8ddc\",\"/knowledge-medium/src/plugins/tables/index.js\":\"10d2eaa122e8a0b8\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"ba6f34778ea3e0e6\",\"/knowledge-medium/src/plugins/tables/model.js\":\"db41813124467226\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"6423143009513d2b\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"c7af87786b94a47b\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"8b792a8f40043e30\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"9cfbf6c01639bfe2\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"323d58775484e7c0\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"5b94a159d43d0504\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7aae9c238851b8d7\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"9475ac240df5b5c8\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c60aaa3f6c6f296e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"3230fd2841195311\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a4fefc3196990a85\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d0f1f4ee596422ae\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8364fc202dd25cba\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"c24682ff02400892\",\"/knowledge-medium/src/plugins/todo/index.js\":\"7708ea53db878622\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"8618d967fea910eb\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"64c88302b8e3e9b4\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"c847e4dd0c209b93\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"ff05dab090d53507\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"59af10e76ebb7ae8\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"161737a6782350a1\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"d8d7565129a5a3aa\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"28bbaee431a9870d\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"891382e9567320f0\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"3b7df099ce8c4533\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"39ab1a53517fb3d9\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"d3c2ba5b06e67b78\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"7d5db8af97193ce5\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a8122db6f79468fc\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"d08022aa91f28d54\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"783a817a6cff7128\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"1d6b51ba1cd1cecd\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"b8cfde53f82e7799\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"682388ac7cfcfbc9\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"a1d77cec9ab0f419\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f0f31967c423a103\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"a96e8fdf85a68a75\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"fe0e7e12f612d2d1\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"1b5ec4982b8e0948\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"bc24aedea8944529\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"e6545ba74ca86075\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"a62c1c8fc4b51faa\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"6fb698c491e738a5\",\"/knowledge-medium/src/registerServiceWorker.js\":\"45d7c0d243a6f6a5\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"69b8faba8c311084\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"e39a4758a88e84a5\",\"/knowledge-medium/src/services/authStorage.js\":\"5501e2a21d098bf0\",\"/knowledge-medium/src/services/powersync.js\":\"caa7823fe25426bf\",\"/knowledge-medium/src/services/supabase.js\":\"380f954630a8e8ea\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"757da20b33ce3e81\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"8fc2c7cdc39aa2f9\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"2ae57a393934a959\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"5634682e42867a34\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"e8baefbbaabc3c9e\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"854294d14d4c4640\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a39e2c8db8c7bd77\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"fe5ff5323e61f409\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"403e80694e30c71a\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"962a62614f5530b6\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"db80302ad3e49449\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"7ddcea556f2ebf5c\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"1ade64fc75579cf4\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"650b2c51c0e6629a\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"cc16a70390f12343\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"c706e4b19d01d997\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"441a762098650217\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"34d6eca1870325e8\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"38b3582fe48834e0\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"9415bb6b0fd5aa3e\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"3e0fda3826273ca9\",\"/knowledge-medium/src/shortcuts/types.js\":\"c764038d2f0ee660\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"fc0eaa86bae305f0\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"8865e65bcba5e1a0\",\"/knowledge-medium/src/shortcuts/utils.js\":\"053ddf2f88719eed\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"475a4b61e3cca4a5\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"d8247a86e871832b\",\"/knowledge-medium/src/sync/byteTransform.js\":\"8f8e003796bd67df\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"1a74e4b17e701f0b\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d32c53529148fb67\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"0ca20fd6eb573815\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"a68c239787f08395\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"3afaff9bfff1f9ec\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"58b6b11a33f96fba\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"375be6c6e5d86a93\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"80d08f7c637ac28d\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"639fe74c985c594c\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"b67db13b04fbd7d0\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"4918f49466f65cbc\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"2381f2fc438c3d37\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"9c5067150ae2ce1f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"ea5ed59645448a8a\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"91e3404cedd9af14\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"7afcb8097e4c0f54\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"09df0fd43cd2ea1c\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"33b4846dd3290480\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b3b9ac8977d5a8fc\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5a89b61f3bf9557f\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a6770d3d70e45586\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"954f855f76d10f7e\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"0c6b1ab25dfa6bec\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"6cc563cb17b3654f\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e28b6eba9cdafcba\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"9f97163b960cbe2c\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"f77c36ddf182d37a\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"084a64c2462c2c72\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"136c62e6dbebe4c9\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"16b413957ce87bcb\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"1d203a4718104815\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"2b7eee44b44868fa\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"9bffd42c272793a2\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"3b1dada3f116da3f\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"dc791cda3b17c8cd\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"4ba7e334637cffe8\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6b363b1ec6584b9b\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"575c862b5e8ddaf1\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"841724492ec7058d\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"411dc0ba9f9d9fd9\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"69ac331deae064b9\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"10e7641ae64e245b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"0e9ae26a7579f88d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"45735c632eb52de7\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"1521b40fd0ba4b27\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"1d1038ae622cfb35\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"97e5da6d3f6b0e68\",\"/knowledge-medium/src/sync/transform.js\":\"a2d7ca2a09cde357\",\"/knowledge-medium/src/themeBootDefaults.js\":\"9ac1b1bc3765d290\",\"/knowledge-medium/src/types.js\":\"6d52523744ff164a\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"fc89522a76b61dcb\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"d052556211849fe4\",\"/knowledge-medium/src/utils/array.js\":\"64d48ba2bba1a4e5\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"089194c2f57f175b\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a4a7e4118dccb9ef\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"cb3abd033fa81de3\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"227da6f87b75ee22\",\"/knowledge-medium/src/utils/callbackSet.js\":\"3ce48923b3084222\",\"/knowledge-medium/src/utils/clientId.js\":\"127187e5653f2335\",\"/knowledge-medium/src/utils/codemirror.js\":\"07d479c0a5f7a68f\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"3a5fc134452a52dd\",\"/knowledge-medium/src/utils/copy.js\":\"788d93fabfda6d09\",\"/knowledge-medium/src/utils/dailyPage.js\":\"b9028551ed274168\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0f16daa1f32faed0\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"55e82a69b09ef4eb\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"cb1d76524f75e5c3\",\"/knowledge-medium/src/utils/dialogs.js\":\"0a7667ba87aeef71\",\"/knowledge-medium/src/utils/dom.js\":\"71c21102a1e52ece\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"04ac2ea40de5251b\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"c0c8a8a13f42c6e2\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"2684c4eeddd9080b\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3be32837b6744985\",\"/knowledge-medium/src/utils/fnv1a.js\":\"24d4f170f08d6077\",\"/knowledge-medium/src/utils/formatBytes.js\":\"42e0e9813539dc34\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"d1ac777a3fff9264\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"c31793ac418934ad\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"a36dfb1ceeef42a1\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"fb13895643d10b38\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"b906a55b876573aa\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"cef8cdd4a128ed92\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"b887a6596defaaf1\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"61702837c7c6b881\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"d409d6503574b7a3\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"2deb34bf848fb41a\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"5a3fa189c2fe663e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"605e89a619678b97\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"76a44a6c2a34e4ee\",\"/knowledge-medium/src/utils/markdownParser.js\":\"1cbb11398d458f30\",\"/knowledge-medium/src/utils/memoize.js\":\"07d1aaf9f52c3acf\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"cfa15285872076ec\",\"/knowledge-medium/src/utils/nameList.js\":\"0db725c7d26b5097\",\"/knowledge-medium/src/utils/navigation.js\":\"b5b45e98e99a6a9a\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4b6c91eea40cb08b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"db3fbf6850be4528\",\"/knowledge-medium/src/utils/panelClearance.js\":\"fe135caa0c542d40\",\"/knowledge-medium/src/utils/panelHistory.js\":\"a010ed8411cfe969\",\"/knowledge-medium/src/utils/panelLanes.js\":\"0a1e83e216048f48\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"74f35b2afc362bbe\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f5f4ec364306cd9d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"c989c2a19be9a10d\",\"/knowledge-medium/src/utils/platform.js\":\"3e1bf957d164f839\",\"/knowledge-medium/src/utils/pluralize.js\":\"420a76071d2357e2\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"185db916ab3d53a6\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"b5ade18c64fb5a0b\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"427e8d706e3db05a\",\"/knowledge-medium/src/utils/react.js\":\"51c0161a7a504cf1\",\"/knowledge-medium/src/utils/relativeDate.js\":\"bbc2d73308919274\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9e3e75a43e6c1416\",\"/knowledge-medium/src/utils/renderScope.js\":\"033c1536b664a37b\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"fe170814380fbd5f\",\"/knowledge-medium/src/utils/routing.js\":\"c0730199c8353581\",\"/knowledge-medium/src/utils/safeMode.js\":\"e9e96c5de836a4d7\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"71c62d1fe543df22\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"a67799dd0772df65\",\"/knowledge-medium/src/utils/selection.js\":\"1b7bd05a26d7462b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a12e1601dcaf55a9\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"b1fa05f61e0f153e\",\"/knowledge-medium/src/utils/state.js\":\"63243058c2590ba4\",\"/knowledge-medium/src/utils/string.js\":\"cf128d43aa929c53\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"471b4a6ae5485397\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"a0adae914e5677cf\",\"/knowledge-medium/src/utils/toast.js\":\"6bf6911527dbaf45\",\"/knowledge-medium/src/utils/toggleStore.js\":\"e48a523d7fc3c378\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"21b539ab9dc35b4f\",\"/knowledge-medium/src/utils/userActivity.js\":\"c2d3cd36a988a21f\",\"/knowledge-medium/src/utils/viewTransition.js\":\"8863a36b3da7d541\",\"/knowledge-medium/src/utils/viewport.js\":\"d8bed39940ecbc5c\",\"/knowledge-medium/src/utils/webLock.js\":\"b2a9dc4edc94150d\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"89a08c3b9ecd56ae\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"2799c9845273594f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"8aecd174581e7365\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b80f2effc6d05787\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"fb21b7e473869aef\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"bdbd2d539ad65d23\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"671e193acce38d3a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"d60c3f8eb3240f2a\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"403d6bd1cdfd7653\",\"/knowledge-medium/src/vendor/react-dom.js\":\"2bb6bc5350c8bd86\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"66635c57521e38b4\",\"/knowledge-medium/src/vendor/react.js\":\"e073adc60de5ce00\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
