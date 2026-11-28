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
		buildId: "a8e434062c63-be96eb3e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"aea04d473510ad8d\",\"/knowledge-medium/index.html\":\"aea04d473510ad8d\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Dx_uUBLU.js\":\"537d463ae5dc9166\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c30d8ccc49f05874\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CskJjBPy.js\":\"5f685831231433a5\",\"/knowledge-medium/chunks/FacadeVFS-CQPPUpjB.js\":\"98a604205b66ce8a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D0vHxCxy.js\":\"4ca59549ed5b300d\",\"/knowledge-medium/chunks/MemoryVFS-DL8CDuqC.js\":\"c6dc553dc3fa0d01\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-TKcEfcS5.js\":\"a6e6c81809f9f28b\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CYrLMfS-.js\":\"447dda71ba73dc40\",\"/knowledge-medium/chunks/Preview-BR_NPdRY.js\":\"6aaef52b55e06080\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DjHKu43M.js\":\"6f047320202dd509\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DISEqfra.js\":\"2ea59458571017fd\",\"/knowledge-medium/chunks/freezeExtensionImports-B8pWFDt1.js\":\"48be1f5e6980317a\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B0piIH-J.js\":\"e4ed05c1372a7fe8\",\"/knowledge-medium/chunks/react-BS6Isu03.js\":\"46c3a797101423cd\",\"/knowledge-medium/chunks/react-BdJUVZs0.js\":\"38030be3a81982d5\",\"/knowledge-medium/chunks/react-Bf41O6O3.js\":\"8e1e8fc44b16bae9\",\"/knowledge-medium/chunks/react-CZCVXJxK.js\":\"17b4941563f93b0d\",\"/knowledge-medium/chunks/react-Cq1vE635.js\":\"a3352480c3502e8f\",\"/knowledge-medium/chunks/react-Cxf0kCou.js\":\"293db5c014d32d0a\",\"/knowledge-medium/chunks/react-MROSnmkx.js\":\"ba85769e0c76316a\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-pk6oEue_.js\":\"fe62727ce506457c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-poOLxcBy.js\":\"ef4e2cf65999d7bf\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CTq0f_d8.js\":\"f587381241e31f60\",\"/knowledge-medium/chunks/server.browser-BGJxxnaD.js\":\"84cfc51851a9926e\",\"/knowledge-medium/chunks/textarea-F8WHRzs6.js\":\"1f8d70fd9016fdf3\",\"/knowledge-medium/chunks/ui-BXLxqWvV.js\":\"3bfc93418be91300\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"8adba776243a9355\",\"/knowledge-medium/src/appUpdate.js\":\"19c53c6c7af47607\",\"/knowledge-medium/src/appVersion.js\":\"95b64654c95860ea\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"b7310f36db4c348c\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"53bd9459c0671bf5\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"c791c16352e59c3a\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"ddc7d076fc913cbc\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b63c35bf19d62d27\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"30b8ff71066601d8\",\"/knowledge-medium/src/components/BlockEditor.js\":\"879b9dbda44c73f4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"62a84d71b67d300b\",\"/knowledge-medium/src/components/BlockProperties.js\":\"41e883d4da347701\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"24a0c471b2f3ad1f\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"c371a2bd6a3345e1\",\"/knowledge-medium/src/components/DividerHandle.js\":\"992d36e1f483a041\",\"/knowledge-medium/src/components/DraftEditor.js\":\"45a06537edbb4ca9\",\"/knowledge-medium/src/components/GutterPill.js\":\"8cb68966a396cb50\",\"/knowledge-medium/src/components/Header.js\":\"583d9b60d8f0f148\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"a3dceecc7ce19b30\",\"/knowledge-medium/src/components/Login.js\":\"ad3513188ebbb6e2\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"40dd6cc61d71cdf4\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"3e084a5d3d257391\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4150e9fb95af45cb\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9c71a7ba2878dc45\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"e41551b21f03228a\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"bbccbf4aa67ee409\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"782971d0a52541ff\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ce6b58471f4dcd3a\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"0741f2606eb0e186\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"29a0aed22ae77329\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"0f999522e139a926\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f234a30e8802bdff\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"20b048a45cc8377a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"536936230df97a60\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"0741d79f8e040757\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"3a01003f9eddcddc\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"a00a77af568d3f29\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"a155c27a060febb5\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"767b070a85158dcb\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"972959a9fd7b15f5\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"ca6a5a20009d1ed5\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"55a6d978c00f7cf1\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c5144e016da26c5b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"eabbd3b01ca1e72a\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"bbcacbb05e21c83d\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"adc49c81aeab3a92\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4735c6f981708b7e\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"c547128a50fefde7\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"35216f05f5eb5758\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"26f1abd7d02d32b0\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"f7a73b414132959c\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"314649a39aa23b85\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"2b65f1624a3705ab\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"fe62dec52fe88b00\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"66149b05eb174f66\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"4af22a85f4109d36\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"3037ead2a4a628ce\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"f55222a128b3621f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"f6b02fc17b41d74d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"609b7815b1d0538b\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"45ad6756c3285b8b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"60d45750c9afa4f5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"65870a6a465d06dd\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7fb5019ecef1f257\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"4ae391e1e51d9e1c\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"1697ed7d3e9a2b7c\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"82bb38c57089e60f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"37ef0d32292325b1\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"632201bfda60e1ee\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"802522ee8c487af2\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"5e9dfdb949426b9d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"e24af97e79fb7910\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"5f8d0b3014673208\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"aaddaceef2ba7b12\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"548b7eef7eb0a1ae\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"c1ce16f741cb4781\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"80b9e1d21c08982f\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"290c63d8bf9a387a\",\"/knowledge-medium/src/components/ui/button.js\":\"33370af446c42b69\",\"/knowledge-medium/src/components/ui/card.js\":\"c79a88ac3d2ab665\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"a6e952b329cb3ff7\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"9bc3fca28cb4f7bd\",\"/knowledge-medium/src/components/ui/command.js\":\"95c8c353f0fcadbf\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"8506ca6443691a9a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"b30fe7c4f2beb32c\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"9910e326a377ac93\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"3211a3ec0de2241e\",\"/knowledge-medium/src/components/ui/index.js\":\"e64479548332e9df\",\"/knowledge-medium/src/components/ui/input.js\":\"e40f528c312e43b9\",\"/knowledge-medium/src/components/ui/kbd.js\":\"2e6f3f0e58d620c0\",\"/knowledge-medium/src/components/ui/label.js\":\"44edd186268a34c5\",\"/knowledge-medium/src/components/ui/textarea.js\":\"41026600a63cf100\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"703e4fdbf95cebe1\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"9f1fbf9b652b01e3\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"03dc67dc82fc22c5\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c647c9fb1d774ed4\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"94c4a0f56f5a9a92\",\"/knowledge-medium/src/components/util/error.js\":\"6d30af5448722d7f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"95e0e78abd3c4278\",\"/knowledge-medium/src/components/util/suspense.js\":\"8d0f4428c5162c77\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f90ef1540d120afe\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"7bd72aa50306b128\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"0079d94059acb5ff\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"df87dfd08f2348f7\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"b2e3d4881b3d2d34\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"bcefd70ba12de47c\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"41e043f34fbde713\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"9d482a7f2ab2fc23\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"963d60423423f7c1\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"80b18b78a7203e22\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"044ce00e01b0a4f9\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"3645b98a4919ee0f\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"19c73a4370a35ca7\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"0e5e5ddd992a0079\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"205408c37ff5880a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c5195f6b1017d623\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"fc2144f630595b81\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"e47cd77e9088a2a4\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"add2de0ed87b45cd\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"ae0e0c0ea130f00c\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"f42ce4a30af2440d\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"e1fd83eae29e5de3\",\"/knowledge-medium/src/context/block.js\":\"282dc048ae798ff2\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"bfc54829631caa3c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"3d116a42d688f42f\",\"/knowledge-medium/src/context/repo.js\":\"0cafaf441c0506cb\",\"/knowledge-medium/src/data/aliasClaim.js\":\"d4ef28cb8acbfbcd\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"f833e74bab833f17\",\"/knowledge-medium/src/data/api/blockData.js\":\"186193810fe3657e\",\"/knowledge-medium/src/data/api/blockType.js\":\"48fb5b3d450289f8\",\"/knowledge-medium/src/data/api/changeScope.js\":\"88d50beeb5916050\",\"/knowledge-medium/src/data/api/codecs.js\":\"67eea7c58124c762\",\"/knowledge-medium/src/data/api/derivedData.js\":\"b5ea1b202bb407a6\",\"/knowledge-medium/src/data/api/errors.js\":\"78fea19d4055f9d8\",\"/knowledge-medium/src/data/api/events.js\":\"62c36e925965077e\",\"/knowledge-medium/src/data/api/handle.js\":\"95c6aca106d56930\",\"/knowledge-medium/src/data/api/index.js\":\"a0fbfa32d38e552a\",\"/knowledge-medium/src/data/api/mutator.js\":\"29036dd19470f76f\",\"/knowledge-medium/src/data/api/processor.js\":\"665cd12df1205d68\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"af4a5e4a7ba22a19\",\"/knowledge-medium/src/data/api/query.js\":\"61c2959dcde6613f\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"0f98133b5e2311bb\",\"/knowledge-medium/src/data/api/schema.js\":\"95c6aca106d56930\",\"/knowledge-medium/src/data/api/tx.js\":\"95c6aca106d56930\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"7652ef0285b3f23a\",\"/knowledge-medium/src/data/api/user.js\":\"f1c0387f1d6aebfa\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"0acb798fa3d28986\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"f123c353942f9f41\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"620136db731644a6\",\"/knowledge-medium/src/data/block.js\":\"0cc797f3f7c202df\",\"/knowledge-medium/src/data/blockCache.js\":\"b74a985a9ed63e37\",\"/knowledge-medium/src/data/blockId.js\":\"72ee48dbe8f85500\",\"/knowledge-medium/src/data/blockLiveness.js\":\"d9ed8f915ac020e8\",\"/knowledge-medium/src/data/blockMerge.js\":\"bb9aae2676b8bb04\",\"/knowledge-medium/src/data/blockSchema.js\":\"a6a5c3c609f0a9fc\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"40ce654dfc038214\",\"/knowledge-medium/src/data/blockTypes.js\":\"e79b30cdcc41172a\",\"/knowledge-medium/src/data/childrenView.js\":\"0306dd9c8b57fcba\",\"/knowledge-medium/src/data/clientContext.js\":\"e3f734264180eade\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ace9371342e6bed2\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"7cf9ff99d6e8e051\",\"/knowledge-medium/src/data/derivedIds.js\":\"f56d17c5a1d56aaa\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"70c08720b574aafd\",\"/knowledge-medium/src/data/facetBridge.js\":\"0847d4addfb6d26b\",\"/knowledge-medium/src/data/facets.js\":\"5aea184149000a9c\",\"/knowledge-medium/src/data/globalState.js\":\"7095d67b0b6d01ff\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"e40c5770db7cc723\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"da7d2a7b1263459c\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"65f9b382725bed2c\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"18c43bc3f95b3dfb\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"102c3dfd1d3ff110\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"369f6830e660d96b\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"da35366e3e5080ab\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ce56dbc701ae4389\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"0e325c106e900af5\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"7cb742850037bc76\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"875be8f8f1774e55\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"a1cacad66a6201ee\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"afba348afa58d1f9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"88534cdef303dc71\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"836c817e8c490a55\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"9fa04f7b582889d6\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"09ab13603206d03b\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"41cea1d2aa062d4f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"653d416ba1e73fd3\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"6df7464bb6fe4de8\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"98d2425a42c04409\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"3d0068cad1e8b8c4\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"8726a976e35e2c25\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"566db1e51c346119\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"62a2fd45ece0a456\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"a4b7fe6b2129e36d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"c0d94b8cdfc1ce57\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"56cd794096984f6f\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"8c1816da823b78fd\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"ebe8ea8c169e2630\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"d60f48b8915b604f\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"4e7078197955d9d7\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"08a57a09db71d0cb\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"cf6ba029ef9199e0\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"2b190533e5249c52\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"c88ccde6359ea18d\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"702584ee6d40fa85\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"30f560951f48900d\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"c73564c9dcfa93ac\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8708397d72f2c902\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"26c1301ee90e283e\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"a12b3bb85139fb19\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"ace537f98b7ea1f2\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"f7657a3f1d8baf95\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"4b30479d65cee30d\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"afa2ee15fdce30d4\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"33fb182b5e919498\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"397cdbc539e15b0b\",\"/knowledge-medium/src/data/invalidation.js\":\"873a75ab3628b0e0\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"871ac7cd3d0e28cb\",\"/knowledge-medium/src/data/kernelPage.js\":\"bc20b011b82168fd\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"21a719c6350d5f87\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"97e63ad1aa6f69e9\",\"/knowledge-medium/src/data/localDbStorage.js\":\"a2db170e23873ce0\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6259145728202e4e\",\"/knowledge-medium/src/data/localSchema.js\":\"34b3f9ed6eebbb29\",\"/knowledge-medium/src/data/maintenance.js\":\"69c5fc1190df1be6\",\"/knowledge-medium/src/data/mergeProperties.js\":\"ca9537afd8977f8f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"7331c270c2f60beb\",\"/knowledge-medium/src/data/migrationsPage.js\":\"2837c235b81b0814\",\"/knowledge-medium/src/data/mutators.js\":\"a3c7c423eb2c8fc6\",\"/knowledge-medium/src/data/orderKey.js\":\"b9153711f532df51\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"952a524f9e88b280\",\"/knowledge-medium/src/data/outlineSurface.js\":\"da759694f23bd0fc\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"58d44f2aebe160a3\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"d8c4273be1ed5929\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"91493ec7b07b133d\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"1bb852292165fe67\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"26fad3e117c0219c\",\"/knowledge-medium/src/data/properties.js\":\"c8ca4e29693425d9\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f87a8558ce1dd5a1\",\"/knowledge-medium/src/data/propertyChildren.js\":\"a3e472e2cba0373a\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"4c3e8b28b4709bb5\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"5b8afa24c2c74586\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"b471c9ae8c2ff31e\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"39452dacb0d6a39f\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"a7771de4795aa1c5\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"48171c604ce706b4\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e04b6b660d0f1539\",\"/knowledge-medium/src/data/recentsPage.js\":\"a341e71a18e97763\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"d43494d0f76ff643\",\"/knowledge-medium/src/data/referenceBlock.js\":\"538957ae9d81c9e3\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"d6a3d49e3e964ec2\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"6ff812b603ae0eaf\",\"/knowledge-medium/src/data/repo.js\":\"5cc1b701aa60183e\",\"/knowledge-medium/src/data/repoProvider.js\":\"f96c16726bbad188\",\"/knowledge-medium/src/data/rowProperty.js\":\"b5c0c55c83027f8c\",\"/knowledge-medium/src/data/searchFilter.js\":\"70579f4cfeb82ab1\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c0652b229650dfc0\",\"/knowledge-medium/src/data/stateBlocks.js\":\"9a44448794acb5e5\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"332835394f93db19\",\"/knowledge-medium/src/data/structuralInsert.js\":\"b936f82dc07f62e4\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ceb38dffa705c05d\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"cc87acd42c67c548\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"f248d744f9af4afc\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"d83c098202834bf0\",\"/knowledge-medium/src/data/targets.js\":\"0c6699c86fda6aa4\",\"/knowledge-medium/src/data/typeColors.js\":\"f2ca2979d3de49bc\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"4dfb013575ce9646\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"52c08ce034d9cc34\",\"/knowledge-medium/src/data/typeExtraction.js\":\"92c183becfdd378d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"8178479d2b9b6294\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"9ad490ebda9375ac\",\"/knowledge-medium/src/data/typeSeeds.js\":\"299c78a8ed4db77c\",\"/knowledge-medium/src/data/typeTagger.js\":\"d95b3355fd23ef74\",\"/knowledge-medium/src/data/typedRecords.js\":\"85348d0c93fbc66e\",\"/knowledge-medium/src/data/typesPage.js\":\"4a678c9df3b4aa09\",\"/knowledge-medium/src/data/userPrefs.js\":\"4ffe426f1cfd3492\",\"/knowledge-medium/src/data/userSchemasService.js\":\"60c6ab1e90d193f4\",\"/knowledge-medium/src/data/userTypesService.js\":\"24fdb46358d9d40f\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"c066b00c0a3fb655\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b98d981851bb04e7\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"16a77db6caf6478f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"7d8b4b24b80fdf1d\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"a134a8a256034b60\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"9280712bc567471a\",\"/knowledge-medium/src/data/workspaces.js\":\"bac30978d08f5643\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"df0a1bb3640b0719\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"5ae915218ad4cbbe\",\"/knowledge-medium/src/editor/atTrigger.js\":\"11971168a680bd38\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2e41bb268df6920b\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"b72bd77d93954cdc\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e5f59f3b42293b11\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"39f1f159258f0d55\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"c698be8b811f2b5b\",\"/knowledge-medium/src/editor/insertImage.js\":\"4a2ea90cf2e0f6a7\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"fd8e03731114f5c6\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"6da715ba0ffa5b63\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"01d57ac03ad1fe91\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"3f65d7f8d60dc35e\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"63c011f70c619f0b\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"adfe560158a71c3a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"4dc8b6429067c8f8\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6a2a4e36239e854a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"9a1da47a0ef6197f\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"327678f861ad058a\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"665005fdf992ffc1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"9c82ff057b04ac13\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"45502f7b41d9f469\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"7be650600d3db748\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"573285e5782c10c5\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"266787ed1dcbd34f\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9c53f51ac4073920\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"8912a7d27211befb\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"91f0115647e87d9d\",\"/knowledge-medium/src/extensions/core.js\":\"970f409ae3e3cbe8\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"a54ae726022bcc07\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"124c60a333b6ffe8\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"a4b5813c273e07d6\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"6f497e748bab230a\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"ada96db6006daa86\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"334a4e90d6125a6f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"e55027b5418a47ec\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"f96ba8d90b8b0b53\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"0f524c60f6999d9c\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"dc60b47274f6ed95\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"c15f2237c5a69aa9\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"a92f769062ce69ba\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"4bc453799f11a7ae\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"4d8db4dab8e91e86\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"140e3e778ba8f89f\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"42bd696c792f8162\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"6dcf3672d1c11e1a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"e3c123ed29162523\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"0f5aa72752048154\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"0be750be7f54d715\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"5214f1d5519a8ab1\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"3768826bf17b1f8b\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"7644cb3261729e2a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"de971dd0a7a1c78f\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"298a80ba00278536\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"e32140b910391e0e\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b28437fa6cf0e1d2\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"7e2614d0befcf1d1\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f9a72f602b8a789f\",\"/knowledge-medium/src/facets/facet.js\":\"bc0eceb13aec2c8e\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"0e2de06a55be6238\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"079fbb10db64cd4a\",\"/knowledge-medium/src/facets/togglable.js\":\"21b4574e541cfd5a\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3bf73379b0c3e493\",\"/knowledge-medium/src/facets/verbFacet.js\":\"86fc7d8514c8dda7\",\"/knowledge-medium/src/hooks/block.js\":\"84c9ab26c60a181e\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"59cc33dce1de7c82\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"fa80bc1d3d8d8f05\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"4dd4be3d84ff904b\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"2583721b57c7c9a6\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"66b754a566fa4262\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"ab02e85a6c24670f\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"5ab00b4f4c8a6cbf\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"2c4d0b0a0d251f0e\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"55cee00b44f8bee4\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"e3eb23131e91c2f1\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"1d17a8b437727856\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"498961e205547b4f\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"10a504160fb00050\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"0c09343fb27a3b69\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"046e0917e765b03f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"bf11fc7aaf34233d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"fcc84267d165c936\",\"/knowledge-medium/src/lib/utils.js\":\"04b1ed12f97844ef\",\"/knowledge-medium/src/main.js\":\"b7705821d9decfb2\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"e023e533db8b8b15\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"8744240eba841bce\",\"/knowledge-medium/src/markdown/context.js\":\"ef85f92d87c159dc\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2f3f1cfcd9f00f14\",\"/knowledge-medium/src/markdown/extensions.js\":\"815ec55fd0c2290d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"c5f0ef6dbd9279e8\",\"/knowledge-medium/src/minimal-editor.js\":\"e2bca0667cdb6f88\",\"/knowledge-medium/src/paste/armedCut.js\":\"4f5cd2f82f76a0c9\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"48bb4a9d6a99683d\",\"/knowledge-medium/src/paste/clipboard.js\":\"39fde8480a37405f\",\"/knowledge-medium/src/paste/decision.js\":\"a5364657a0377e03\",\"/knowledge-medium/src/paste/operations.js\":\"0beb7bc6003da08f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"582db6cab801f232\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"1e0d6da2821a79c6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2db104e6d69673ad\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"db2e1fa81b17bca0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"fc0191d96dff5c49\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0eb16d1dda03530a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e13843dc073a3ba0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"752dabd9356c0dd1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"58b8645ebff04144\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6f41a9ce1948e12e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"d9f1b9ee94191b7c\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0a3e25858e1a81e0\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bcd381cd3d66cfc1\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"5ab7c6ea4351f959\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5d8ebd72c580eb91\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"2d384391118d98ee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"35708e1d6bdd4af3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"796abda143edc870\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"a2f88e2d1fe92f90\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"06b94b387a046a80\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4412944792c13ff4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"7fa9b7051f20ce66\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2aef05d8393c16fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"a69e97c9ab837126\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"446cb984eac6036a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6cf43cf785ecc5e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"fbff5c68c22e82d9\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"2bca3f0c41e67f48\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"0aa0abd0ac3b1cf0\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e1c96b48672faa8a\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"afffeea356bf7a29\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"6b2710117e777dc8\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"511f3c4db86cfe2b\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"38095d642c8d5893\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"910080c61d428e06\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"82c2fd73d8fe3e6a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"812089a71dc3f0ec\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"08ad905a4044d8cc\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"a2092bbaa17da49f\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"49d0a62561016533\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"f13a18cbee6bd135\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"46287af1f0f0693a\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"cf57b0f82c849bc6\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"1eb9073ce0a0f775\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"80ecb10d97048d63\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"77dee70a099081eb\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"8f879088f8fec48d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"a6f859fed1a67359\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"927b44529cd2721f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"2790b4d920cf54fe\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"351567b9d5ba6dd5\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"3077a0aa84e5cfdc\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"158fcd303b24e2a4\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"37d817794e7124a2\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"586aa1116ed88817\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"959d9f29cc90093e\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"1c34d58181f746eb\",\"/knowledge-medium/src/plugins/alias/index.js\":\"085e14d4c25e94e0\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"405093e32b4107d0\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"25336d67319d1502\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"07c436455b1b3518\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"41f05c1ee4f2e1f4\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"f866977e678f3603\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"7153aa9e053f4e2d\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"bb507b08f79dbe7b\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"aafcc10fa7549245\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"08aaff7e52e152b6\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"39d72462e55dec37\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"66e362e7556ae719\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"400ecf1c8b711af7\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"e5fee22ab9a65438\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"64e4316740c5924c\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2fb94100cbf3b8f3\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"7bc8e3fb900152b2\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"f6eb3d4b8c92390b\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"c97173a328e066b5\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"5a05ab2c8f0ef6ab\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b187530e57380c6f\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"db7162728c9d01c1\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"968a5595b762b1e6\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"62aefb7c8eab0875\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"c08de85eff090afb\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"651467a06a79c063\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"b02f450cfa20df7e\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f6275c67428f1ffc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"a5bed971a2ea962c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"9cd1ee4f55f70580\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"02f3cfaf1d25b7e0\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"628b4045cf595558\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8717370faab3eb3b\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"5ff0ef2b0e53821e\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"3736ce3dac975816\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"625f3aeb46fa8cd9\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"8ce8b07476f48ae7\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d5d755f6beabb970\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"2ea8a135533e26e1\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c028cf649cbf38d3\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"8682e6fdb5069a72\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"77943e15b84c7996\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"ac5ab3829da53759\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f5f5b066e9ad83fa\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"e11c427a2116828d\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"9e8d83a5a8fdd5ef\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"bedd591c85948786\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"bffa933403037b29\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"be00d182f6004627\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d8ea68ca5f72b0e8\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"3814c3ea007db53a\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"367157a905ad3291\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"0930c28d212530dd\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"37ca71047fe88221\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"1d03665183ee2dac\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"60191ec362b901de\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e7ecf8d4a02f8a96\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f8bb88d21ebd5f46\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"637defba0dc74003\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"e79eff538f27c872\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"904d9b4797129e5c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"6495c2d6fd96b7d3\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"8d8e589b054bc4a2\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"c02da41c79e70e25\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"806b2a4b19a5595c\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"15719583a7d08374\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"f741bc4104bd581e\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"ee69cb34c0b503cf\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"c3767310f1cfd2c9\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"129d0653225566c7\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"613a9f7d61f3f78a\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"10ecd63bb8ebd684\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"948f8fd5712ab2eb\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"fa488eadd7540e3d\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"c90c92e55ea4d143\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"9465db79537bf962\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"89e9b2941292a23f\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"dc4f479fe94f14c5\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"212220022e712814\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"fa15bb5eb45fe988\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7deb878abda40f41\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"231e0da89291aca2\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"7cac09f46b12d027\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"351d8f6b571fa1a2\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2cd99f3408433a94\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"4094bd47f6e430b1\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"572b61c907096832\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"3feff256d9c64f7e\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"f7eec4deb7e268a0\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"216ba14c3ea5cb85\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b28890b4d6584089\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"12e0a794bebb355e\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"2065429a82ac57b8\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"57697f0623d2bc5d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"903655f7ac4d7629\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"9080282deab7eeac\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"a2055e3690eb526a\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"4a478eeb2f3d7748\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"fc52f397fec0fbe3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"64e7d9189a517afc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"5571ccf533ac011b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"74b8d43d0ea98606\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"32d83c46adc765b2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"528093508a010549\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"220039dc1388da99\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"d7d455318b9126ec\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3709949ffcf5931d\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"938106d585c3e4a0\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"604e454e6d03d4c0\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"208110e75e777021\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"1c0b5485e6bdcfd4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"92dd6d7d723a50e9\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"0382c01ed1983376\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cec5d219df59e703\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"e4bd6aa2f1894b03\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"c969da28b1935d27\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a22fc25c2da2222c\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"83501800c7eb4981\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"c940344a4e70b996\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"2d04e56d4525536f\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"90258f2833527e9b\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"9f76157b0c4a79e3\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"9c64139b5587fa5b\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d5c25c9f188c6e5c\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"a6173a943167ec64\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"be44b110c1932241\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"3ca650ae217949ec\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"31d06218eb0105cd\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"df32e397d9a927d9\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"03983208e5a7c882\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"2a110542f0dc21ca\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"e8e467a9d3d15534\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"9420125deceeb8a0\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"1a753707cda81372\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"899558b3dc8db16e\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8edbebcd3943c4bd\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"119a5a7616748779\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9db75e4f3dcc3172\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"80bac35908e029b2\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"58847b3d412ea1ec\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"de4e789293aebd30\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ceb21be365135904\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"ccb1dabb7a998427\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"989b1eec5e1cc622\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"195443a042b41770\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"ba4ff1afbef3081d\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"6171e19e9aae11f6\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"40d0c9e25d0fb35e\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"d46246fc929f3eaf\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"4ba3009ace64c27c\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"a1caf1feba22899c\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"18fcd2fa4796f947\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"c9d0ab0ccefabe8e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"c7d31b517cb2176f\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"2aa0371104e35751\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ee76fff177c81398\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"af11a8565f106cd8\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"4937c9754d4fbcb7\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"a7781463ab70bf9f\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a2aac8fefeb6dfba\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"74801c0884fc5c46\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"589878ae35e62140\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"6af85c5498b0d2f3\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"56954b2805f71e83\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"3694845e89430f2c\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"72242124d26a82a1\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"925d6b0bcdfb93f4\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"0b99c66e3c73b647\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"78b68e48f0024863\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"7ac3b1cda99856a6\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"5e93a784f2844274\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"9aa677c3d36e61a3\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"cdd4858e0e31745d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"71cef605e6b70ff8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2ac88f8b17ef3804\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"1e845d35b3138723\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c43423668aa33b93\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a9f6a04d09631db5\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"aa1599814c9e37f9\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"ee07f5a59c7f77df\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"605004cd9e7b29c5\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"283b6e0c13d1702b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"7dcb10019595bb66\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"d02ecba347326e02\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"48e1b087494ef48f\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"d0a9d1a0da725f38\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"c57f52a4fc81afe8\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"71e771c5f348bc46\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"22854464a3b5ffc2\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"22026e579d18006d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"cd9380ceb3233da1\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"7ffa26d3189a3cd8\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"5df17a42e91d9705\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"90db3b7fc363f13e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"5deaa051592c4736\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"750360729356db50\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6457eb0748df5049\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"fd6ee54b42d18eb4\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"7182506987b6d3b3\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"26ce98fdbb1edf38\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"258e5267a6b774f3\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"175ec1dfda04b035\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"1d119edec9419956\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"7593853f587ad8cc\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"423d1caedf127cb3\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cf729a14a78ed4d1\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"7cbe6758a2c0aa92\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"274acff44779955c\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"4ecf7ae7b0dacac3\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"d0c2b786e9bfe1ab\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d0c26e0d89b05f42\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4d2403811dc98ba3\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"02ac1303d026db5a\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"a60a04c0e3a6e25a\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"1505d430d3142a4a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"dec80c5a19016201\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"eb029d5df5d9a2aa\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"5e2eddef3ecae922\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2ba4a4068f0c24cd\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"80849f2cc6883c30\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"fd8ff838321850b4\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"3bbaca8777f41007\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"e96261142134fc9e\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"d78a18fad7ce6ed1\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"250c7a367841ae57\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"ea32faae37a4cf10\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9a65c2ba5cad688a\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"78ce415f22c18d36\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"f5bb51c486a2e201\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"012018f8a79d3829\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"b317484d0f737ce5\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"c71b4ecd443f4523\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"f173ca5e96ea8855\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"e018ca5b76c3666d\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"d6686da9fb5cb7a1\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"f0487e7c318e2cd3\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"02fdf15e0d35aa5b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"b4a18fdaf87bf51c\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"0855b85998d0f8aa\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4acb4bf4aa95edca\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"23afc7ef69c64831\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"ea93d75bc43ccefe\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"0176143e29de37df\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"982152473fe32a99\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"5edc785cbebf9faa\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e5a3e04056abc63d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7ae21264517dcfd4\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a419d91a64180f43\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"5bd553dd5d37143b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"7ac9e558c5c5d815\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"d2a174687611e51a\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"01a1c37047c5d0cf\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"614ebcf50c86caaa\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"48243e9756369956\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"6d09e877c7b53a3b\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"5d0387f45722479c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b67ef4794a17ccb7\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"02437d4ba35e02c5\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"6f45477504fe6860\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"e48cd2d36394fa48\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"70c3a724f083139b\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5612b7d06df6ef39\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"5e206c87f746682b\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"fd9300045e4e25e7\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"b7fd60f831a78297\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4227abd476f76e53\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"3a797e205f829904\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"eb8824e1006dd22c\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"4e34e3d589c49d53\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"e5ed37fa63649898\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"2f4bb9853f70f5f4\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"c671b59418dea8ba\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"dcffd479e9205107\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"104ab623fffa2798\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"02b1f306c4ad2def\",\"/knowledge-medium/src/plugins/geo/index.js\":\"34170b50908362ad\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"58708d45cdddfe8a\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"832446558e2f767f\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"616484361241aab0\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ad6d3b3505576abd\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"75462f083f41d745\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"6aa553e359fa6319\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"fe810d270fdfee37\",\"/knowledge-medium/src/plugins/geo/query.js\":\"e81918abc88f31fe\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"72ecc696b94371f7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"613b58837d4b53c7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0491aa25be1bba73\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"943365eceb507d49\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"75fc42047135931b\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"c02fca404bd22fef\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f59ec2191595c9c9\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"29fa41aacca5eb18\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"57c4f657562a1e09\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6ba293496523665e\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"8f937d51f03e3ecc\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"654f987f9842f686\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a337992ef67c9ca5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5806261e86e8f706\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"a763cc3c56092619\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"0eb8fffae1fd5916\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"3d8012a5e7bdf279\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8428e68133bccccb\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"37469237d28c6ff6\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"c4346e87dbf554aa\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"c950ab32035a3c8f\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"39a83ac0e566c588\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4c83835d28b39ac7\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"d9da6a90d8e1dd5a\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"8cb1f469ef6cdbde\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8882ecfce482cbf2\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"36c50aed3e651890\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"6565660c3bc34ffa\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"5b2c4de6e8402a91\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"1eb7129ce0285f2b\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"a323c9dcf62f30fd\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"5e8106ad084fcdda\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6f110936fc77ea93\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ae6f06b4373c7000\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4d4186523be9b528\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"825859b36db792df\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"7756fcae50d3d5b2\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"fce279e6eca5972f\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"ae2c9d120e311edd\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"a5bdc3fc6b298df0\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"edc13726b98499f3\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"77817946f829abc2\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a0f8061d9edf7ed3\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a6d178073ce8894c\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"f31eb11287a43de8\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"348eea4bca8bfac4\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"12b9ef95baf230ab\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"92925eaf1406606b\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"06a8b6edb85fe26b\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"61d4d178175799f1\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"332fe3561051e30e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"b70972f4970cc321\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"f845fbe8964206d6\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"fd5cb219b00574fd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"763f25c6bec6ac18\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"97edd45f2c984ada\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7baf8287c8b97bf3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"5d120236e53737dd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"f28e763eaf1df1cd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cbf95cf1df8d1d39\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"30bed3754af4264e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"fb0144248ec30125\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e8c6bf6d65e7a30d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"58c2030d91185549\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"683005e3853b69a0\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1f5a9f79f48de0fc\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"3a1194d4709671dd\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"3005e03ca590b91a\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"04da9faa31af5e5c\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"73d38d96c1833c49\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0e91f5ee57cd5a67\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"98bb490e2a23e339\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"ed9de4ec2b7626f4\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"6d9687fed8431608\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"4bd29d5d6870e25e\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"3c23756a3bcfea52\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"0cc2819faf9bf2a7\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"387d9a2bb7bb6d6a\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"5d36e7ec2970d1f3\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"b01b7c453e0d69fb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"df2335fb55c33f2a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"cdfd2fa2337c30a3\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"e34de91cbba678fb\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"49fbb951fe8f76bf\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"e6655e65209e7ff6\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5a99a0571c19a22e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1f1697c50be10fc9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"a0f2f7d0fee4f659\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1ef4d709f37725d3\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"da9d8648b021d0b6\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"c3c264afd06cc2a7\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e097719bd6294935\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"7cb5a3c15f41a0a4\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"1029187822d7658d\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"685d07c733149697\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"2ad9907d5c2c656e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"ab417092d6ee92c9\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"076bf511c5d9200d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"89d979646ac231a6\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"9163341a2aadffb4\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"c45bf56b05252ddc\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"e942cee6bf7bb415\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"ee13e27a0e78a8eb\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"2d929866ebc7d14e\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"73a2df00e4077439\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"69cd9955b40e04d7\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"5e5e7523147c7c34\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"96f4469ecd10e58f\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"1d9aa0b511909efd\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"1aca8feb48d7b9c5\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"8c0bdc84bb4fb5a0\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"b572c734743fabea\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"d0d53b04a1a5883b\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"f4eedd56f5078f4a\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"9888073fd8062c60\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"31b032822c7aa843\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"78322fa0daf78fdc\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"23e98824ada95d80\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"459d0284f02565ff\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"527685fc0fb215fb\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0e54af7f7953060a\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"e8e962e03ff886c4\",\"/knowledge-medium/src/plugins/recents/index.js\":\"417cf86a8d58ed15\",\"/knowledge-medium/src/plugins/recents/target.js\":\"b9ae74bb9d488418\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"982a63f442898f89\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"825d812b525f7a5c\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"291027ed5630877d\",\"/knowledge-medium/src/plugins/references/index.js\":\"e0aa37ee508510f5\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"aaaec6bdacc20d82\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"d511c9e8a9ad084e\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"184d6e95a55ac1be\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"2fb15dbc9f42d5cb\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"178c6ab5734eae20\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"add532f0ee66601c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"9618579c538de368\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d647a6e670ab7c28\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f0c43fcde69d5553\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"214970f42742a23c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e2156c394f62c0fe\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"307bab6000c79f06\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"a54ac4eeaba5adc7\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"6ae83b8a0c82e767\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"b7daa5d250438a2f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"36eb5990deb7595c\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"74c20c5b760b9f3f\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"2a69df621f556fbe\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a2e3f7aaea56a87d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"9822f7d0ec65d6e0\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8500b57950135644\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"31fbbfba03942548\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"f492ab0cac3498fe\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"9ddc232f991f2aad\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"55b2d25da7de7faa\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"1201d211f6f38e40\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"3cd46884f11c556f\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"9a6c82716d8d2870\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"85f1c8747284bb07\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"bc734300fe7ace79\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"14cca6ac1174d847\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"5e4321ccffffa2ba\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"7eb2f3477e6d3ddc\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"27ad14a42b2c6d1c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"38b0a4d804522d8e\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"2763505d62de44ee\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b6df8aa1e3252d3a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"a4c78e4120833fa3\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"4ffac544b2efeb0e\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"cae02a9c61101706\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"8a2baf423c6cef74\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"4b7214511e956126\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"e4bf70d5578a252a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"5d7dcdb576f72349\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"4890ed558387cda0\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"5f8a070726de2412\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f303728488b2d9ef\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"fea5d10846be5600\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8861c78012ebaf96\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"ac18cd9d9b960698\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"40b42ac16be428bb\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"60b72d9979463e72\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"f06b8a971bbc608f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7d443bae15030254\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d702e1bd665e6ba3\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"6446df19592bd36d\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"8360cbaf751e67d6\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"5a44673ee8322ac7\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"aa60567d43f48a5e\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"fc5d543a6cde5494\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f56bbfbbe38ab334\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"6df73c9f593ae824\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"1fcc7524efcf1c30\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"885f76a13e96dfd5\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d3b7ad5ff78e3115\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"41050cb519d1f0b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"3eb92dffde06f7d6\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"84601414ca04afda\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"a9d3264329806e4c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d64a647a5d91e0b1\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cb619882db0514af\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9381822d3110065a\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"126c750c682db110\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"edd267369f83c339\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"8001ccd35ed74762\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"659b00e4bb137138\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"26549b5210258f7c\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"d9093e3647e05379\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"5e6d157dd3135a3f\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"663f6574d287792b\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"48c867db2a643691\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"90dd6753909f8146\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"cfc12e25e18c3693\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"1459791be4a94d64\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"83eebdfb67de5a0f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a929f41e056075cf\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"04a93efdf22fd3b9\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"bbdbaa4b042f6688\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"6b5ef9d9826e8553\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"0ae1f5e274eff327\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"95aed6df56f15418\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"8c1f7c6b0dee7ae3\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"78f5077fe9b7cd31\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"c33e7f3c63fd33b8\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"747635078731eebc\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"b4d8445bc94792e0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"96e2460980b7e12f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d0afca58a9092dea\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"ccec0cb303b5214b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"baf8d8a57389f35e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"366023622be996d7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"a5273592c04ca617\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4621756b86d844ee\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"c1dce8f172bd2d24\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1a5a2777670eb15d\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"11840c16a40acc13\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"25df9e76b2acefd8\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b2c6641ab20cca72\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"5f78006ed4e55347\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"d9906352133c5c75\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"b9bc50e2daf298e4\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"12a0b0c0bacbd56e\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"0dc7adcbf988c811\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"4959188c71f60094\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"5bb5f063afab84ea\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"5f7f7ebe35111c62\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"726ea3e101393087\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"114171884700b01b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"93ebfce34afb41db\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"715bab7af0c0e1ff\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"c2e3822e3b020db3\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"886fc6e6d2fb2752\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d4cab7aa3028f008\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"712095a358067af9\",\"/knowledge-medium/src/plugins/tables/index.js\":\"48ba1ac1e0a29365\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"fd96719ed3c48fbd\",\"/knowledge-medium/src/plugins/tables/model.js\":\"9fe38581eab57914\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"5ca11d9f15645d31\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"abbb276550e7d50e\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"ab66490bb332a7e7\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"d802b1333989fa34\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"7ac3ee6550c80ae3\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"22269670218c2530\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"70dcb79dcd4734f0\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"88ea4396d734872d\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"c9f12b36ebe47a24\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"40dd2cb726c13ae1\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"818fed71d6bc3ea4\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"e49fce99465da62e\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"d1ee8dada0b954ba\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"83ebe90cbe6bd6fd\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c6c5dd58d171441e\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d18472771d09153b\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"c0824d9e6468fc8b\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"819c4e50814a8792\",\"/knowledge-medium/src/plugins/todo/index.js\":\"a36885f3b54ee096\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"d3e7212043ce90a7\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"25fce9f6ae475865\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f774ef3012a7cd48\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"6869d8940feb3cdd\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"fbb1e05295b74ca0\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"007637b8a858687a\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"712e1b66104bd564\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"918ddfe6f84f1646\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"babe97be7ede3619\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"62f98da8fc35e829\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"5c92dbcb5c4d7713\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a3ec67f91604459e\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"9ee2ed95e922e481\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"4a0fa977aa0a5c99\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"d866fe546cf2f78f\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"09167ec7812b7cb7\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"b06cc42485090474\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"df86e378a50054dc\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"ae2b5a0aff847051\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"c8b1a42a45aa112c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"324fcf73a7f2f21f\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"62086f4c0dd90f8f\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"4b50a74c214d36ba\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"9069f84200d093a8\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e9cf7101350ff05b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"258bb0e38644da7d\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"aaf3d23761434a1e\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"dc15cf96f0146a0b\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4ee6eedb9fe875a1\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"5c748dd329fc408c\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d8437c34f3e093eb\",\"/knowledge-medium/src/services/authStorage.js\":\"450d4c56fbb88d72\",\"/knowledge-medium/src/services/powersync.js\":\"0f08d73db180f765\",\"/knowledge-medium/src/services/supabase.js\":\"f475ebd490468143\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"5e2a23d0eef26b65\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"106e6a0348853bd3\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a6b6daedd2e6e12a\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"fa4f8af30e836c32\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"25f2df317ef74000\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"da01eb3e281c7988\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"2e0bd0b1169a35be\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"b24da45791c19a92\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"b26441da79418a5d\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"a4d353e6438cf18a\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"3a3eb34aa00c5ea6\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cd1e96aa12532eba\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"98ecc7962d299655\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"15098889c3a52043\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"b4991d2121740637\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"0d3e9d6a9c579fb5\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"3e6641a9ab6c70bc\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"74f944714105cf43\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9ffab945673c1e96\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"46c66ac5baa61ac2\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"fe079d6e3eda1ede\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"e21337b5e14700c4\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"d143fae3b87b9bfb\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"802e8fb8c1c65638\",\"/knowledge-medium/src/shortcuts/types.js\":\"5a17830fc208ec4f\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"e6df5522dcf999df\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"b953bbf702c3b670\",\"/knowledge-medium/src/shortcuts/utils.js\":\"6e03e42b2e00c107\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"76a9271bd724a211\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"873e3c077b04c581\",\"/knowledge-medium/src/sync/byteTransform.js\":\"dd1c27166fb949ab\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"75bcb78186a6c399\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"25a56e50c17044ce\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c0862f95f6210026\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"92a20ed6cf11bc9c\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"a9df6ae9aee9aba1\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"94cd5104464c8433\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"3ab83ec6fa5e1df8\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"9a7881906c415a48\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"2af25ed8285b4634\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"450a2adc01ae8912\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"fd964badeb2e5679\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"20069944b4438d41\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"d1b6b8c96232d49d\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"c195831c242b2cc0\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"28c2b95fcef1498f\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"8089e28102d3df41\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"55f470dff9466afe\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d59b3ba1a2bab5b5\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"c625a43639320e27\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"3d18c7703d59f587\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"d8dde6ef4a28b36c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"54a15df27ce17184\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"902f4931982b30a5\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"2a8c4be5214d15c8\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"7986bc129a6a279f\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5062c92f8a0084ee\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"e3d6a9dc62d1063b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"c89bc91f994d4d1c\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"4db7a939f7211483\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"616fdee5a0f1cc8e\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"bc81bad0892fc680\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"ed20678a324ffb25\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"54dfb92dd560dd51\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1435acda06341624\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"78f1f815fc83a080\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"a519c1c0762132d9\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5daf1afbe72cb0fe\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"bb2975a6c769157a\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5dc9d0decfc996df\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"946b4bdd92fce63f\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"1bce410068234869\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"00cb6decfab84171\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"743137ebbe9fab8c\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"15782e130c7fe838\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"20727a7738043081\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a9655321a03ad0a9\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"166b2e850f3095a0\",\"/knowledge-medium/src/sync/transform.js\":\"f30a2a984e17ddd7\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ce9333e97a6ab9a5\",\"/knowledge-medium/src/types.js\":\"6972591a9239a0e3\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b034d992ce2a291f\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"57cde64241024f81\",\"/knowledge-medium/src/utils/array.js\":\"03828e059aabc295\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b88076379605ee1c\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"cd07d5ce554fa379\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"8b29f2b047dbfff6\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"91ee37d99066d8d8\",\"/knowledge-medium/src/utils/callbackSet.js\":\"fbbdb49718b935d0\",\"/knowledge-medium/src/utils/clientId.js\":\"0122da57e08b22f6\",\"/knowledge-medium/src/utils/codemirror.js\":\"a10987e446c765f0\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"d21ec4ce683640eb\",\"/knowledge-medium/src/utils/copy.js\":\"67a2ca816cfbfa60\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e0a98d97566ca81b\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c0e1b6c4d06cf63f\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"68efd1568bcf60fd\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"080667772b8d4200\",\"/knowledge-medium/src/utils/dialogs.js\":\"c1629c44ef05cc2d\",\"/knowledge-medium/src/utils/dom.js\":\"8c73302d5a296bf1\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e45b0a0b4d0c7e37\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"561f1e8d0d60df61\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"429076269fece7e8\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"9dca3d356da2e2cc\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cb84d97995b22146\",\"/knowledge-medium/src/utils/fnv1a.js\":\"557139ae131b1173\",\"/knowledge-medium/src/utils/formatBytes.js\":\"bb72661a9d86ffe4\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"d6ad8162d0a90716\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"89ed46dddd7a1795\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"6bbac70459633f8b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"5dcf2752176d45a6\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"2a9426f23eaaf598\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"3895b57e4bea6cde\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"172ca4e397f32922\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"27c11cb9e7378fc3\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"34ee45fb8e887807\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"b51ae190fb5f11da\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4e270aece43d9899\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"0e8e83cdfca1b11b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"513f27f04f2c07bf\",\"/knowledge-medium/src/utils/markdownParser.js\":\"92e4c76caa1415e0\",\"/knowledge-medium/src/utils/memoize.js\":\"02adc74937acfb99\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"e583ac9a3712c17d\",\"/knowledge-medium/src/utils/nameList.js\":\"249a2affe436ddee\",\"/knowledge-medium/src/utils/navigation.js\":\"5a4ff2db63dbb26b\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"51a4d1cf0cd70826\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"055502a58cb0fcee\",\"/knowledge-medium/src/utils/panelClearance.js\":\"945e51dffb21d9b5\",\"/knowledge-medium/src/utils/panelHistory.js\":\"da88c37314d1a393\",\"/knowledge-medium/src/utils/panelLanes.js\":\"bbc1e4db94df10d8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"eb5eaa05f9423677\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"dcda205556c51683\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ec908f5b4d2ecb5c\",\"/knowledge-medium/src/utils/platform.js\":\"17bac0f27a8d524a\",\"/knowledge-medium/src/utils/pluralize.js\":\"47b2a38b89fe8621\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"aea4a4f56ae29b2a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"400c64551cf3c7f6\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"125ffeacef83741e\",\"/knowledge-medium/src/utils/react.js\":\"914e269abc25641b\",\"/knowledge-medium/src/utils/relativeDate.js\":\"19127f625a3693f7\",\"/knowledge-medium/src/utils/relativeTime.js\":\"0a507a1b2e602ce0\",\"/knowledge-medium/src/utils/renderScope.js\":\"771b68c521c20917\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"8c24e90914d513b7\",\"/knowledge-medium/src/utils/routing.js\":\"9914251174625adb\",\"/knowledge-medium/src/utils/safeMode.js\":\"9d9b88aeace3c6b1\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"49f84dbac5af973e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"43ffb97550764d9b\",\"/knowledge-medium/src/utils/selection.js\":\"3cc4293da9deb08b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"c76c560a07d190ea\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4e89836430bad27a\",\"/knowledge-medium/src/utils/state.js\":\"3c88c7607be1cf6e\",\"/knowledge-medium/src/utils/string.js\":\"21050ddad76620a4\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"d1bdbf4087a2d847\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"5e3278228ee789a0\",\"/knowledge-medium/src/utils/toast.js\":\"21508e640f120321\",\"/knowledge-medium/src/utils/toggleStore.js\":\"7617d19bda0092b7\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"d306cbea8f38056a\",\"/knowledge-medium/src/utils/userActivity.js\":\"76b74ddd8a8310e2\",\"/knowledge-medium/src/utils/viewTransition.js\":\"06e615b397f9d7ea\",\"/knowledge-medium/src/utils/viewport.js\":\"6ed145bfd1965114\",\"/knowledge-medium/src/utils/webLock.js\":\"d8cee786030c2f2e\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"a7f06008cb02f2cb\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"bb6ad7f037d34a6b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"2f90e48c31732015\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"f807c23ca97ac070\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"181196c768679e75\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"f5530350da56979b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"5b3cd1a40101e13d\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"b2d948015ee7abde\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"e4d77b8d99aa6e7a\",\"/knowledge-medium/src/vendor/react-dom.js\":\"3661224c3a7e1d25\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"c4814899df78f9fd\",\"/knowledge-medium/src/vendor/react.js\":\"e7c1f091f7617069\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
