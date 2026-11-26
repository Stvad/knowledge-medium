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
		buildId: "9d77c48cb6af-c65ff309",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"af12280c0f5d00a2\",\"/knowledge-medium/index.html\":\"af12280c0f5d00a2\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-D7fSG-C1.js\":\"049056fedca2b6dd\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"ccf4b4f17df412c2\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-_sHMjf_H.js\":\"ff2636f8e5c5cb37\",\"/knowledge-medium/chunks/FacadeVFS-B-sDJl6H.js\":\"7619516b660a5c0a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Cm8yvfSc.js\":\"631679c88102893f\",\"/knowledge-medium/chunks/MemoryVFS-BxPOcE43.js\":\"53a7204defcf7d57\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CPIquCyJ.js\":\"e85ad4b499dc0fad\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BVw2LOKE.js\":\"a0fa0208f237a323\",\"/knowledge-medium/chunks/Preview-C4kZlCzK.js\":\"cdc79b23b36ca9fa\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Bzykoe7X.js\":\"06cdb2bb710b1aa7\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CNaQRgMO.js\":\"4c5fd82be1211630\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-2FtP2o2i.js\":\"ba9b62755554e7a4\",\"/knowledge-medium/chunks/react-BAwTmQ2F.js\":\"c1bfe3a3a900e279\",\"/knowledge-medium/chunks/react-BV0gXxh8.js\":\"4cf97eef6e6a26ab\",\"/knowledge-medium/chunks/react-Bec-qSr5.js\":\"ce9ad3901703d5a0\",\"/knowledge-medium/chunks/react-C96WIavp.js\":\"dd58079dab2e5161\",\"/knowledge-medium/chunks/react-CibFaMPs.js\":\"4e92d18da1790c3d\",\"/knowledge-medium/chunks/react-DDYetNVw.js\":\"c6dd307f753aea4d\",\"/knowledge-medium/chunks/react-YnlQFgKU.js\":\"2695b4992417ed66\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CkVI7FWd.js\":\"8ae3fd6590366808\",\"/knowledge-medium/chunks/react-dom-server.browser.production-1ejfmT-C.js\":\"abf74a62bdc5d477\",\"/knowledge-medium/chunks/react-dom-server.edge.production-If9rLvH9.js\":\"9129f0a121358577\",\"/knowledge-medium/chunks/server.browser-DmxyY3MX.js\":\"2dc8c52a16a324d4\",\"/knowledge-medium/chunks/textarea-CrAcGF5a.js\":\"bf452497b00ca962\",\"/knowledge-medium/chunks/ui-C0BpwdPn.js\":\"40d5a2d12b5ea68f\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"e83bb68390113a95\",\"/knowledge-medium/src/appUpdate.js\":\"6485d39ba02e8c78\",\"/knowledge-medium/src/appVersion.js\":\"5408f62175823981\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"86ee78ab3f5ddfe4\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"2e138977cf6ec106\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"f45cbf975df71ac9\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"36a5dfabed825193\",\"/knowledge-medium/src/components/BlockComponent.js\":\"300dab00f7e653ec\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"08a69992699e93bb\",\"/knowledge-medium/src/components/BlockEditor.js\":\"886c5007406d4ac4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"9d8348dd5249317d\",\"/knowledge-medium/src/components/BlockProperties.js\":\"1d6af6fe6cfb5988\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"62228f6a7eb4b418\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"a619031a687394d5\",\"/knowledge-medium/src/components/DividerHandle.js\":\"20cf6c63d9d8b4eb\",\"/knowledge-medium/src/components/DraftEditor.js\":\"2a648d6c95f91548\",\"/knowledge-medium/src/components/GutterPill.js\":\"2ea951419fac86c6\",\"/knowledge-medium/src/components/Header.js\":\"3ec258a323032888\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"528040430da83d1c\",\"/knowledge-medium/src/components/Login.js\":\"a4af6058d260910b\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"a7755e3d2f133190\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"3bfb4d417d441467\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4359c987cc60f492\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3dfea69842e870ea\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"e476c933fc0a90f3\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"e9429fd4016e727e\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f3d4f4e522db5124\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c96ad96279f95c77\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"499a314be864d065\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"7d620faa3992e690\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"148125c57763cf4d\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"68bf632d9f83565d\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"d7e947d90b663ebf\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"4fd9ef2f89dc9cef\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"b796c7e4b60f2e8a\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"84a333b9976f3806\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b780ddf8e85a19e7\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"77c26d5978adeb9e\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"82fec065c7be9cb6\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f363d5af3a49868b\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"d058973ba4d24b27\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ddb1ae072d0c21f5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fadd9c22b7394b02\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f47f0e2df83b6b9c\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"d7b89ef3899b39dd\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7f27a042ba1f7ca7\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"aa58a16dee206d75\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"5c49804f64ac5fc8\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"c1b7d8f4c02eb0e5\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"623c21976d5c1a47\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"03bad5642064a1c4\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9ada18608ad908d5\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"77083b23b1e1467f\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e1e2dbd3e485ab13\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"9751fe8382b014bc\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"fc730a3fe249d373\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"09cf7f6918394dff\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"9e4a3b386e3a5b0f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"3db604c06ca0bfd5\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"0997a389917b9cb6\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4aab28eb607d9c99\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c5eee6ff363f93f3\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"befb25ff3189f9ed\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1f09cf71ba45c22a\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"b7ed6249f32366a1\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"181cd0ea1d731c95\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"4b016e16e3b4845f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"c3110d3eb76a11a7\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"00468341a2b65221\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c50eee13447920ab\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"fadbfd930729ad10\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"b9bd5b4a01768ae8\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"7b179dec0b1e7842\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"96990eaf7c22f8df\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"146f9f2127bda6bc\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"8a4ff820beae57b8\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"8730d0c52dbce517\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"b7bd75295a1181fb\",\"/knowledge-medium/src/components/ui/button.js\":\"e6ee078c89ef0889\",\"/knowledge-medium/src/components/ui/card.js\":\"a8f1bf4fe6fa39ea\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"077d5a3aec07cbd4\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"fb0db10881e2105e\",\"/knowledge-medium/src/components/ui/command.js\":\"609ea35f67d19a96\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"327599500a2f7bcd\",\"/knowledge-medium/src/components/ui/dialog.js\":\"ebd5468efb331243\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"11956ff668211a7e\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"2173ed5f21b6f721\",\"/knowledge-medium/src/components/ui/index.js\":\"0ddd9c9abd95db1b\",\"/knowledge-medium/src/components/ui/input.js\":\"f9449b35d46b9a17\",\"/knowledge-medium/src/components/ui/kbd.js\":\"beb93c44f2536835\",\"/knowledge-medium/src/components/ui/label.js\":\"17ea91e66b2c598d\",\"/knowledge-medium/src/components/ui/textarea.js\":\"53d5308f9ac4e0a6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"10e9a4d139d2843b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"165557bb447c5908\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"be198d11291e4ab9\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"0b975a8dc33a95b2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"be8bc74c48e6949c\",\"/knowledge-medium/src/components/util/error.js\":\"5ce540d482cfb43c\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"28e5ae51897fcdd8\",\"/knowledge-medium/src/components/util/suspense.js\":\"1440c11f868483f4\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"b13e7161a05c2568\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"a462213732ea9c5e\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"e3b760df37e5d27f\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"45ff45ff06338fbf\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"43177050deece423\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"9ec8820bb7f80c42\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"1e98b43e73e5c796\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"a1e2d3b274021e21\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"da053f5c0180def5\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"44aab72abe5bb7ee\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"482bc8959be0a3a2\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"e7e0f9294e262de3\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8c0e6bd9bf5d2571\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"2359fd3c53723389\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"42b3b955be3ce3dd\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e89737b85102f3a4\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"6e80152113e07d0a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"c36dce1061c7e6c3\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"cbde5fe3e281a973\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"df0f05a9c17ce851\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"874967d193ed9afe\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"1764fa795f033e89\",\"/knowledge-medium/src/context/block.js\":\"129bb6eb815a2d5a\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"d4e10304ff544d4c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"23a10f037c7f1667\",\"/knowledge-medium/src/context/repo.js\":\"2c7cb7788a2295ec\",\"/knowledge-medium/src/data/aliasClaim.js\":\"d34c944dfb21a4f1\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"562ef3d332561671\",\"/knowledge-medium/src/data/api/blockData.js\":\"853d8ca55e23a9aa\",\"/knowledge-medium/src/data/api/blockType.js\":\"6430b0b2df6c9d52\",\"/knowledge-medium/src/data/api/changeScope.js\":\"7d5615040daa3ef9\",\"/knowledge-medium/src/data/api/codecs.js\":\"294e913b0e502c84\",\"/knowledge-medium/src/data/api/derivedData.js\":\"346036ef46751c81\",\"/knowledge-medium/src/data/api/errors.js\":\"1f097abfa56449a1\",\"/knowledge-medium/src/data/api/events.js\":\"4ad051083d4e082a\",\"/knowledge-medium/src/data/api/handle.js\":\"a0b93def6da5da64\",\"/knowledge-medium/src/data/api/index.js\":\"4041f4450f0a8b80\",\"/knowledge-medium/src/data/api/mutator.js\":\"8ad61255838b6e6d\",\"/knowledge-medium/src/data/api/processor.js\":\"c35954b6f53c7d25\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"c9b01c2355e412de\",\"/knowledge-medium/src/data/api/query.js\":\"f393a6cdcafacef0\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"cf6f65ff02fe9cf3\",\"/knowledge-medium/src/data/api/schema.js\":\"a0b93def6da5da64\",\"/knowledge-medium/src/data/api/tx.js\":\"a0b93def6da5da64\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"bdbf4cd62383fbd5\",\"/knowledge-medium/src/data/api/user.js\":\"b15d8f8006d62f9b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"dc2bcd3f1b66fe48\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"7d7d918fabc0952f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"e681141cdda17ae9\",\"/knowledge-medium/src/data/block.js\":\"62443027c3aa0066\",\"/knowledge-medium/src/data/blockCache.js\":\"4a2e082fddf77d6c\",\"/knowledge-medium/src/data/blockId.js\":\"c81bd2d54332c653\",\"/knowledge-medium/src/data/blockLiveness.js\":\"b2121bc286b0a687\",\"/knowledge-medium/src/data/blockMerge.js\":\"ac4d4e0f27f1e5c1\",\"/knowledge-medium/src/data/blockSchema.js\":\"54c8e9c44edbd875\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"d6538f1f4e5bf87f\",\"/knowledge-medium/src/data/blockTypes.js\":\"f39c4b8e3e8dfd32\",\"/knowledge-medium/src/data/childrenView.js\":\"aa9e80a8cf1fad0f\",\"/knowledge-medium/src/data/clientContext.js\":\"c583944b98f2534f\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e2d606b9d2e20475\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"391e092c08c28db8\",\"/knowledge-medium/src/data/derivedIds.js\":\"4b726412e3f42b71\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"5ea8a6e739a60069\",\"/knowledge-medium/src/data/facetBridge.js\":\"68ad8d4a3ad582d8\",\"/knowledge-medium/src/data/facets.js\":\"56c50b3e4a8ee709\",\"/knowledge-medium/src/data/globalState.js\":\"fdea68425856e803\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"e594593f255d7eb0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"0edc5e684610325f\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"702dd9cf0a58130f\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"bd9e4506400534ee\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"d6b6c94df727b85b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"df6f9ff2ffdb0038\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"1c9f5aff153e0d43\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"f43daa4e30a23293\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"583bcddadbc27585\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"21cc8d57716727dd\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"8e6ce3cee8c4fedb\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"c1cd414ff78b1b48\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"87fc3330f3d3582a\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"e8f6b768f3927ce2\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"614987d87617cdf9\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"8182f01445a06524\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"4ff56eda87da0b39\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"0553770091bf4a03\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"5b765580327c4f5b\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"8b7344f6fb2265ba\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"132428fa07cefc66\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"d9027cb54204c7fc\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"7ac6949dceefb4f6\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"c4839ae7061b3ef7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"901b299029129d45\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"1deef5931f766c2d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"2fd38003928c5c2d\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3d6939ae836f489f\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"18a3f22821013688\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"964cc9565c5abb3b\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"45fb901140e2fec4\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"be97d119a4595529\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"54630b3689b9e631\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"a1aef140f5a6ac12\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"7322f197fd6e2f80\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"08de32a8f2e0eb05\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2878e10d94f0ad52\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"de9f46f53d1f57fb\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"83dbb9f0711379ed\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"ec28a3892fb01c2c\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b37d0a3269885c9c\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"5f9c5f968296acdd\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"da14a2314558cdde\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"681b3e24d164b221\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"b7638cd6b5ef8476\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"2533a7d3724f8f09\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0823833cfd22aa85\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"11fad15d363f0aa9\",\"/knowledge-medium/src/data/invalidation.js\":\"39de6f620620738a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"07a2f61e5f16f944\",\"/knowledge-medium/src/data/kernelPage.js\":\"686b3ce7ed02de10\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"1ffa33089af52aa0\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"fedc56bfb22ecdb9\",\"/knowledge-medium/src/data/localDbStorage.js\":\"785225b39dcafde1\",\"/knowledge-medium/src/data/localDbVfs.js\":\"cb60068e620be87d\",\"/knowledge-medium/src/data/localSchema.js\":\"56d5a61fdcb856c5\",\"/knowledge-medium/src/data/maintenance.js\":\"df88bee75d62ec55\",\"/knowledge-medium/src/data/mergeProperties.js\":\"9e73d0e14ac9cd35\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"131ba7a488b7b37b\",\"/knowledge-medium/src/data/migrationsPage.js\":\"0d9faf6a1c3dda3f\",\"/knowledge-medium/src/data/mutators.js\":\"d8eea1b96e316be2\",\"/knowledge-medium/src/data/orderKey.js\":\"f42f83d5952a12d2\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"130e44fa77218d8d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"219d5f28ed4650f2\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"835d0191352b0b93\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"119f2eb1e0809f16\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"f07270a2c40e11d8\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0ae28b145b001b1e\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"b2e6ee9e839768f2\",\"/knowledge-medium/src/data/properties.js\":\"770a0a05c9d9cfa9\",\"/knowledge-medium/src/data/propertiesPage.js\":\"74eb50a08cf869e0\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c77d4457acb5c1d3\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"146a4718aa365a76\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"a1c5a6dce2883905\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"134eeb0fcf1700fe\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"a1ad676b5dabdb27\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"91800f1a96f7bfad\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a8a591258ac5c0e6\",\"/knowledge-medium/src/data/propertySeeds.js\":\"576458d7eb03f3a4\",\"/knowledge-medium/src/data/recentsPage.js\":\"ebd650511f4c8048\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"a256553c2da9c7c0\",\"/knowledge-medium/src/data/referenceBlock.js\":\"7e1f6d9054d4eb51\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"a956e7faab5ab09e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"022083b638a8ac77\",\"/knowledge-medium/src/data/repo.js\":\"cbcf14fbdcb569ec\",\"/knowledge-medium/src/data/repoProvider.js\":\"441e7d756da47ac6\",\"/knowledge-medium/src/data/rowProperty.js\":\"c5baabb6dd16519c\",\"/knowledge-medium/src/data/searchFilter.js\":\"0dbffd447bfa7fa3\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"dc11831088ee56bb\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ffd282d81e1a57a9\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4533f4223b145f0c\",\"/knowledge-medium/src/data/structuralInsert.js\":\"517caacb769f6630\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"d4a4bc5ade22dd24\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"122c0b38381eaf4a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"8e797c2922b08c4c\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"824e8835c4122190\",\"/knowledge-medium/src/data/targets.js\":\"83130f421aa8d7ef\",\"/knowledge-medium/src/data/typeColors.js\":\"0bf8e497675d8f89\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"072939205e4dd016\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"3d83338017e2db95\",\"/knowledge-medium/src/data/typeExtraction.js\":\"8f198489d99cbb02\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"da5a7c0c703e6769\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"11f0e4dbfa44780c\",\"/knowledge-medium/src/data/typeSeeds.js\":\"0181dc3e7aa1dd5c\",\"/knowledge-medium/src/data/typeTagger.js\":\"2c51c30064df044e\",\"/knowledge-medium/src/data/typedRecords.js\":\"8262a278d8b1c788\",\"/knowledge-medium/src/data/typesPage.js\":\"3753995a23621562\",\"/knowledge-medium/src/data/userPrefs.js\":\"0fbf148fea5cbb05\",\"/knowledge-medium/src/data/userSchemasService.js\":\"b6848e728a986aaa\",\"/knowledge-medium/src/data/userTypesService.js\":\"2137a297a0cd7bc2\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"b5bdd5e4da47288b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"530ede8962185935\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"536de5caee20b8d0\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"bc8a4cc64c432971\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"4dd8ebbc599db6d9\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"561ed13e909eb1b6\",\"/knowledge-medium/src/data/workspaces.js\":\"83156f8b219d2e53\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"c706277d378e5f5a\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"a46094c334525df6\",\"/knowledge-medium/src/editor/atTrigger.js\":\"15b271ed03bb0bb4\",\"/knowledge-medium/src/editor/autocomplete.js\":\"9fdec4871e9dd995\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"d49d476632c30d90\",\"/knowledge-medium/src/editor/contentFlush.js\":\"1837d98e1b230b90\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"de37940aa2cc76ab\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"791a6d43ab72392e\",\"/knowledge-medium/src/editor/insertImage.js\":\"e61afef67c9dad2e\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"ec011994156803f9\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"2fab02d5ac9460b2\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"a59bc5c72d77c62d\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"47a6672b864a752c\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"62b43862eabc626e\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"f8fc218fa31b816f\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"59cf46c496e75d56\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"cceb3ce48625574d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"792071abf46618bd\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"8095191bd9e3529e\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"cc5695ea006161af\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ef9d8b335f454203\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0af4b898ef90ed5d\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"d12daa96cb95f236\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"4e1e5f6046ce56bb\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"0930cae600fdd63e\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2b6b309c973904f2\",\"/knowledge-medium/src/extensions/core.js\":\"bc026c3c30f93f46\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"a57d76e859e58a0f\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"0ce1868f30c4b9ed\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"1fce2ee8de003788\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"46ba6be303620a7a\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"7162fd5b088f2124\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"316d4db5df6a79f0\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"f7e1c13c50621a2d\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"02ffbc7572d2b683\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"1211766bfbffdb1e\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"ba629c9f1482dc8e\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"58ddbe4033acd3ee\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b839898e9ea82365\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"e4dde6d8f67421c4\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c09da86b16667f65\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"0d441ec4764ff9a7\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"5e9606a538727520\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"cb9f1bc5c8dac76b\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3f2d316af1d8e39f\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"0eec08f7008d3728\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"5ddbd6569c49595b\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"0f3dcc3e10ade4e9\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"6745b81bf28ecfb5\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"a3dba800e5367719\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"f8d6689d1137e5ab\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"f7794a6dca5f8cfe\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"6962d0709cb26f1d\",\"/knowledge-medium/src/facets/facet.js\":\"72916e4719fde80a\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"32f9ef187213b155\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"3940eb6086146c75\",\"/knowledge-medium/src/facets/togglable.js\":\"b54d9881cafa1498\",\"/knowledge-medium/src/facets/variantFacet.js\":\"dca3d56175a04e66\",\"/knowledge-medium/src/facets/verbFacet.js\":\"559e4f607b7a71fd\",\"/knowledge-medium/src/hooks/block.js\":\"dcfd4edc28ec08c9\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"2c9ba3b1dab9b144\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"fe504a7fdc7190d2\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"ff0636b3f4802a1b\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"708acb753394ab14\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"020f1400741350bd\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"27c5dc4b449ead7e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e3ca33a108944f9c\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"100f2deef4b86b33\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"a97f5afc598e6e5d\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"d50205ef76f51b1c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"49f55e21ca0585d4\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"1f11ac3eb6da538e\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"730aee7342b4c810\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"60f752600c053dd0\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"f91737523c6b71b6\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"1d68030ae796086d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7bd9f0270db0ee99\",\"/knowledge-medium/src/lib/utils.js\":\"5b640299e5aa35a4\",\"/knowledge-medium/src/main.js\":\"698cd31036efb6ce\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0909293d03514871\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2afdb8a017cf9ce1\",\"/knowledge-medium/src/markdown/context.js\":\"24e80e39aa7e13fc\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"fef6bac61f8959d2\",\"/knowledge-medium/src/markdown/extensions.js\":\"3dcee1fdc14489d9\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"6d76fe2ac80bb96d\",\"/knowledge-medium/src/minimal-editor.js\":\"a0e79533842c3f8d\",\"/knowledge-medium/src/paste/armedCut.js\":\"689d871bfafe10aa\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"bc3458d10880545c\",\"/knowledge-medium/src/paste/clipboard.js\":\"a942911b79124bfd\",\"/knowledge-medium/src/paste/decision.js\":\"3a0cafe537b16e50\",\"/knowledge-medium/src/paste/operations.js\":\"d2b2b4dbc5914cff\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"0a1de587bc029710\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"a12ad460a3481925\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"3879bc56ec0fb616\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"070e1ece5b3eadc1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"944134ccb2a489ec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1ad7ecef618e6dc8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"c1e3c60d19e48dd3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"72c55e0276ff7e84\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"dcf51b699fadb653\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"883c7f8e014d34b1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"0e461e92574761ea\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6f73aee98c0be716\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"eecc21e560e9a852\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"dfab35d3f5fc4fca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f7c869a61098158f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"100ae88b2a42fce2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"aa1a80d51d7ed932\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b4cd25eab6fb8a2a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"ed0740826a3f163e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"3e80b9cd37b8d7ad\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"95c8eaea44bd30ee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"6d04b4df640cab02\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fe425e188a5d9b25\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"64720a06f9d2ae8f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"616bd0200090b3d7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5c83622ee504a134\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"c1af9bc0393ae011\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"6a6a895b15378879\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"0434408f2d4a8660\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"c4c73c4305a0e0a5\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"f81d56aba83bab05\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"0aed923c88eda35b\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9456932d36fc4f3f\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"d416551f71d5c706\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"f41cd24c4b854323\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"e098522c5883169b\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"617154b434519103\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"56a4db02e5d90197\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"6c243378438bbe1c\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5e6d3c32822e556c\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"2acb4b572f637600\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"4d58e5e2d278373c\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b3dd266834dc39fb\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"a87c558fe5bfb7c8\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"79ae46afa91e969f\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"96e04e486438dd20\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"e2f61ee6e92964a9\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"ea7c629a1c919d2d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"99091a92700fa12f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"65fdde2f3852fff6\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"d4d187700e480f1e\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e2b67c93fcaece77\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"3f3a6f308d503a52\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"16ed257aea897843\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"fa2bc4e1ec03688e\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"a1ed7a196839463d\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"da5a680d13bba494\",\"/knowledge-medium/src/plugins/alias/index.js\":\"3604089b75864538\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"affcbf6367fa4e4b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"0df93320e0c801bf\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"1ecefa284cee8e63\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"582ba1e017e9d635\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"87b1c692f6e76414\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e485747a530d2b66\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"4b50a9f25b5b64c7\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"14b47e02237c1ac8\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"8e04c0ccee35c58e\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"6f919ab3d7b0b7dc\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"e514f51dd0f581fb\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"5707ea15517dbccd\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"806036d2325e1eec\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"dbbbd1f645fe1181\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2019065e83edbd32\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"8bf3bc713774852f\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"8d6873cb1e926823\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"f7d09ec10e9daf28\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a18657a3a6a02726\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"49744b60cff30272\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"cb226009f4e06510\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"14332310ae4d7adb\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"934e236181c0e8e2\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"16aa672380643e38\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"36b47ad7e505cdcc\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"fbbf89e9adc388d1\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"a5a35aeb7f7367db\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"8b0a0d6d2150059e\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"8b74ed4fdafe179c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"15c160ba6468ca4e\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"1b547e0c96e41a7b\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"c5f2694a793e71bf\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"e5c07629d6937ac6\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"0a1f00ba3cb4da2c\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"319167ae8bad5f0f\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"931ee3c0dd03ca28\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"dd28cf96012fba1e\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"d01cdce17e5a8d1f\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"61a4606f14192366\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"5931ef0f5dc5fb24\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"ef3fa4dd19976c5d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"8cbf602622ef6c74\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2593248e26c5d80d\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"6cf762c5580d0e7e\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"5bf73587ff654976\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"a440dfb064193504\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"86d8aa22b36203dd\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"ea80e63efbb15aa2\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"539cbe873d3bd215\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"59856a9d029a4fd7\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"342e7d6c2f4a2f41\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"3236936954150f67\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"efc234e78858b35e\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"66abb12752da8a39\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"c5e9af44f7d279c1\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"025101394c6b7139\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c83d44bb717bfef8\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"245450f6ccb2d812\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"4d3628f8c4537221\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"99237d10b0a8a8b7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"b9faed6f5dd80370\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"afd4dcd9ec04199b\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"3248045440a56d45\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"90753f58062fc975\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a444a38888825db9\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"cb00189095e201aa\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"63db632f3a797c44\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"3e6ccec3fd38d71b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"b2d5e71d1748d68b\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"eaadad0baf69274f\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1c25966227135728\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"f6de91b42c87911a\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"f44647f2da43ac5e\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"ec151cbc804a0015\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"1585698e5b38d670\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"5c895fd7a853a3fb\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"410ca3d6539c12ad\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"40b672669041700b\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"c2d74bf788ac1bad\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"b6a1efa87434c675\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"9c3d062841f8f232\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0356ae4b102ece13\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"dad389e3cabbbae9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"272f18aca4e34b12\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b9b1bbfa98070f8d\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"5d6de106d30f390c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"fdbbe43b7d076ff8\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"87474d8917c47200\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"251c43b0a25f8eb1\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fc23a1f9893e9437\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"331ad78cf13a51c4\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"903c0582d99998c1\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"116ecd9ce0457f45\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"0538dfbb14e9414e\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"0a91482b90830309\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"2d54aad3a6d48307\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b22ff0c8c6d5b1f5\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"5338bbb68d20a2e1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"059c112d95416b15\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"be2279e61077ffcd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"42ce79171148ddb8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"aaa0b9497312888a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"22953f5dba8210d8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"dad0952255157929\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"84cf9d95c3e14b7a\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"54cfb2c73ff37aab\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"cbb5a110897b06c3\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"078faeeddc9dcb3f\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"1d742100f1dd6974\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"d228e5a6b6edc8b1\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"b09d19199cb82be0\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"ddd9e9ab6bb57a35\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"280a0a7003a79e13\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"5d8ae186fa877f8f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"11b7456112af83dd\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"985ec62c3104948a\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"46f3aaab3e87d947\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"a401584e9f826bc7\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"7fc0d8ebf1aa6e60\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"1c29aa6dbfd5bf22\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"41fa69ae5cec1b38\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"8896d1253900a2ae\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"ee8dc86b0019fccb\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"7814c753132ca452\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"9450e97c01d99d80\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e40433bb945aafec\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"304904e9c1c350f0\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"d9ab884160e1b6d9\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"4b3ba856bc7d44b4\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c1dcafa360364d89\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"80c13a500efbfeca\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a4d2eb91c240acc3\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"79fc7a55272caa13\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"e3e08caa6fba5296\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"345da4670927d8a7\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ea17f2e13570134f\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fd6cafccd6b50069\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a5157619386b3235\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9ab0dbe61bcaa1b0\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"64ba4ac7ee998b83\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"509779483ee28cab\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0caf95a5f222156d\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"17ed3362512cde3a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"e8d5f9c012603df6\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"b59d6c87aca908fe\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"f587da64edaf62ad\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"65ee7b9fca7aeeb4\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"c6f7b0ac44e1f9e1\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"f5ceba5ea1a0f837\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"871aedd0e03aa4a0\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"b175b72947c01ccb\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"5fe7bb4929fac863\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"fa423b3a3f647f71\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f3c8d402d1cbb7fb\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"4aaaef1127283ae3\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"76120c3c2ada67a1\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"194fa8785a61bfdb\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"50d10e1f2088d7bb\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a21229fbb7652115\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"12491daff4a7099c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"aacd7d418c146259\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"5231045a45f733d3\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"8f876040b80a2644\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"5aac04bf293789cb\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"e9ee186224c25c4b\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"cc948b01c5d66f2d\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"30a1b67b45b6692d\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a3396afa802e7b67\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"3f3bd1016fed9aa6\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"652a637d958d53b5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a90cc6d5eeb3a0da\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"050aa297fe799fec\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"27630fa18489933e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d0f9106d9468d90d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"39e32bcc7407da89\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"74db48b80174a173\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"0f033e8c8a84efa6\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c87cf4248948209c\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"11c33c289d9c6234\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"38fac7f59f1c030f\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"8cba889dd8ef56b7\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"bd05beab345cb9e3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"3bd7bde87ac9c940\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"5771126c0c29ea46\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5151ed4d766d6793\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"91ec10aef6745eab\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1ef169805370f6a4\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5a30bbe0028669ff\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"22f273ee0e1c56da\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"29723892cdde3b5e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"199aec5a97b5acbd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"934c4a3ca9404446\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e204894b3449f0fc\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"02e9e51202f0d615\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"27f7a1c0d67cdd72\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"24f84256ed8cf62e\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"e21efeb603d04f50\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"fb36e357e6c72a3e\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9d4659941bc4de3b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"be49e54298e76530\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"bc274e98e4e3a1e4\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"20d7cb9ddac2c9a2\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"aceafa7121b6cb5d\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"5ba9c945ac730b53\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"850ac106ba94e52e\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"9410c6cf8cea464f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"bffd08f15e19c64d\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3a5f721e787966d5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bedf61edd48c5822\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"d87f1ad92eba3fa9\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"a3efc52707b47e93\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"3eb069cae6c18299\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a3c06cf101ab7061\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"9e4f808771c9baa2\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"9d6ad4c1deddbf96\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1ab87603532161c5\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"6aab9952e1caaa2f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"276c87cb3511cb4a\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"293acfdbd0edf286\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"85162fd156158c5f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"0601d3cac272a966\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"cb85d9086b701338\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"6c4c4517275b9d10\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4431c77914af47a0\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"706ceb9b618eef4a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"58027db50c9f4edf\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"35d2af046f7df1c9\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"6d88426c79f75547\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"8baf10f01b200220\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"b17e466ed0338db3\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"6f4359fdc20059ac\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"bca948fd96f3037f\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"673928153fd7270b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ea75669421cb9ba0\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4a1846a82d917311\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"ca511f28fe8e4a49\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"33b98489293dd393\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"cce2358edc003d5e\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"c0b5c8ab4a83a8a0\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"23e8867a584aae18\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"05ab3e814b8314e9\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"40f29ce98b93f534\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"8df3b3ab6d8de3c3\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"328d42748b19d3ee\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7f7a3b431bf3ebc5\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"56594512198c9f09\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"6ae95c743b13ebb7\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"98235b899bc7c7b1\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"c00dc57335e3a3da\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"e4b47272177793c1\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3b2d1f9809e66940\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"b437e5c434cc19af\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"8ff2d006951fe94b\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"94b4d5bf4df1f4dd\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"2c9e9fb65a504484\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"a956687c21ff8f7f\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"913f715ef70e4c6d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"9ea6d11955211e0a\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"8075ae0f71bfb572\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"34f2332ba2e7c26c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a4b8e15e89792c1b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"c5724752d4e42a75\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"7928f0c9a08e2597\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"4c0d8e783da872bf\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"583660530779d1ab\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"30378a0f435f5b9d\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"438f54d205fa1e65\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"da4b3bf25a0916d4\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f5887d4012553ed4\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"46149c4533038871\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"44200891a246014e\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"920a42e17680362a\",\"/knowledge-medium/src/plugins/geo/index.js\":\"1071945a282f7105\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"2904ad65bc02d4ec\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"28bbf91671c7ef31\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"39459b7e65e2e750\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"33775374f0f530e6\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"b408c1790b4fa1c4\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"8b7c043a632845f3\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"145cb8f8dbd1cffb\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b0377bdb7c988c1a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"351c0d5666f234f4\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e8f1c7648b4e7392\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8b90c06658e3e1c3\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d3821820ba5ee613\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"e59a37d73c7759b6\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"e4474de7c9acc112\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"c935e7d7a8343638\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"aa0477ce915d4bf5\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a27019c3d98da715\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d03875e0ea2f4be9\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"ce1c8f20d1c07923\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"18fb43a2408be3c4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"046ff82e1fbf55d3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d1c5d536357af98c\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"1e62a57271edcee2\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"00c43d7c37854670\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"5abbd9d4aed2c306\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"0bd09f3f8b8a9127\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"d1e1a324bf5d9685\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"2b722585fd3824bb\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"8c88b7691851401d\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"b7e4cadd2da3692c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"9c20fc4b5fb1d74b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"d10a1cf2974c0af5\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"7b8c25ddb7c27b6d\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"4706ea7e850d53fb\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"4c86764de6bba7d0\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"b42a6e7bed8835e7\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"807887dc8d842d87\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"9a4a609ffeef2cee\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"60ee627fff7808a4\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"f2e481f79dcd4b70\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"299d86da6e458be9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"bca2ba6de44e552b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9eaff3803e71a3ec\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"4b51e91cb04ca2e4\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"e9aa1ffaac7fe8fe\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"b46d3aaa9bd1ba56\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"1de964465c351f0a\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"307d97a0997921ce\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"2bdd891f62cb0349\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"dccdb66ba50a52ca\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"77e0678ccace7fff\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"219bcb3b1aa7d451\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"2a35d3fea558be8e\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"665dd4a265e7da24\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"6ef1230349de8885\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"fabca0332f10e7fd\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"e2cd745bf15a0142\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"19f35de5cfd65a66\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"72ddae0b4a8a25f7\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"9536ee8895de0862\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"a5fdd5c59db4ea8f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"5810263294284aae\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"654d041ceaf9d675\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6d883bab7f7855f6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a133808fbe7052cd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"3b8ee1f5154f8985\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"fcf5f34a46b29e6e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"905ddc9c7a7db17a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"08710a1871dc46ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"672ff0f5dfc06ccd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dbc16f7ee08af7e9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"a8c6ef6a647dc690\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1b2007137bb16044\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1607bbb806905122\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8e91d9f66efacca7\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"998a53f5e9f2a2fc\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"275771ce839817d9\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"1d2d729c6535e776\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"f51f9705730427db\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"c01090815ef09f4c\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"fa3e8d80a350e848\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"1120ece482015cf2\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"76822a73393411ae\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"e98452ae9dce1eaf\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e714bf0c402477ae\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"771257e01a26d773\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"5f32fc5449808258\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"8b352f689a138d82\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f494c21a13477fff\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"14fda8fece330e0f\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"3ddcd70fa42ea078\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"cec6bad4b378aa07\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"dcd1080d19e20372\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"c2397d5f0713d315\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"fb9acf4b1ab00f95\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"4f60d68e538c7b84\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"9279f66db0cbd60c\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"50c39c4bf54faa22\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"28049f47aab521f2\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"d41dfc8f869c75ca\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"3bd4d9c6a11d03cc\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"fe08c2f6ada2adc4\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"41677935a5273ab4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"7d6939ba08e00bd7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"4f8918d132ffa414\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"89eb03ac46f7ca8c\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"dafebfc3fd674d63\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"61ced7c69e69f883\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"95922b1c6eb0f9a2\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"bbf0b57792351c9d\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"80e3ef706aa1cebb\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"746ed62a1966053b\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"060df015b34011a6\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"fa10015918b4e01e\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"01b042ceb7090788\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6186f46e6232218d\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"5dacf24a183e8b30\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"bad12ad9cead6c0d\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"f5eba682cd2d5ee8\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"3335402126195705\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"b8ab6ff68450fd31\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"cfbe9d42e0a9acc8\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"ea802cda78ed623e\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"3b9a10e268c9fae5\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"491585a93705585d\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"56bb78b2719515e1\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"dee92da61d1b71f4\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"05d5b7a31d180dd1\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2d9e30a17189d869\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"968a0921aa4cc7c5\",\"/knowledge-medium/src/plugins/recents/index.js\":\"68802b56ce10433c\",\"/knowledge-medium/src/plugins/recents/target.js\":\"a09cae693e4a3796\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"cff43b6d3966072c\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"e9cd9fbf4f826073\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"2bb339ee18470fda\",\"/knowledge-medium/src/plugins/references/index.js\":\"1b4be16f03f0ee8e\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"842db894dddb7112\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"dd84fda836ac6944\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"9ec570e0589ae446\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"8676b5e7936e778a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6a3a02de7812d4b6\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"b9be326bb3be0061\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"9329119554621bc2\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"28f15004ebcd32b5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"feb787d38e0b7f8b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"3bd835f93e61b44f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bafa36f7b8182c4d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1fad193d16f9a0fe\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"7e0e851ea6223ab8\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"a769cd6d428086ae\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"e71d5d2ce50f380b\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"fda0b8e29641cd1e\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"3517e54fd6115202\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"530906cf24237b75\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"301004a875478ca6\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"5e7dc8078c62f25b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"9f9b616dc26a0127\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"80132e1725c523cc\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"740a0d4da87d41b6\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"0a76aeee5131b821\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"e0ce7f9c2ec5dcea\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"7900d8d4868cbb69\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"b160ceaac5b78376\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"1e4a29975754eb32\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"8f2ecf9691b6b498\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"e5467862da6e2020\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"be86a6fd3d57ddb4\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"276336774092e00d\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"114b5c264c8bee9f\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"3ec8f646b14e7fff\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"ce77f9674b01e037\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"250219a8a9e1e29d\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"76bbdaccf17849a1\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"20790c9fd97ef10f\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"706740cb51b422ed\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9cb62284969c9e01\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"e355e4879712352f\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"9896e0b9a342ec4b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"45dbe18846619ee5\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"c17bfa4bc4b5d30f\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"14dbcf755248158b\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"09b6cf8ce92da108\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ae879c4c36c49da6\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"500db0be8f0db41f\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"834f64fc963cad15\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"1547399cbfec9670\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"59f3008e65e5aa57\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"598b159b95e749de\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"7ce428f2b3ccfef8\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"506cb3964921b029\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"10424296cdb083d9\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"64cf6f05881ab65f\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"24b167c3a564bbf2\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b86e54ac96b5f351\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"b1fcfea87dcad68e\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a4beb5dc3e7a6b94\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"ff150ca7b54ee0b8\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d66b8b60db703199\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"07fffc532151f64e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"49e500107ed0b006\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ca80b3589eb73cf3\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"9ca3074ccb7af020\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"06835a4923d559f3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"22571cdf360fc9c9\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"0bc926410865dfbd\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"8667621bfd3e449a\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"12395426fd583d9c\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"62e360edef6c96ce\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"b91f866a72a67349\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9630181a8f523f5e\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"3a7defe027a4d3b0\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"b198b7799ce42883\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"2288ef5c9bd02a88\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"7df6cd3f10f97411\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"ea57ecdc75023f05\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"61d398df7d875a96\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"ae94b2a87edae56b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"1d8093ec5eb80682\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"7205be1c69900ae9\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"d63a3ea6a4c348d6\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"c63e89565fdf2bb3\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"b436a045f637ce6b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"0d2da121a6e67fd0\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"7eb836dee1860f45\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"8509e41d88ed1301\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"698123ae39005c1e\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"198e1dbd01faecbf\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"7a2ab90e4b7f45c3\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"66fa9e5d2ea90f7a\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"3f5b4bf28a757fca\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"9326032add054fe4\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c64e21972c25a956\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"475d3a0f126d47e2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"6a56e7789d5ea87c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"6beee3e6f94384b9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"c01e55585b7cb0f3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"033e3b8b6fbfab11\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"db141a434b38f872\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"ca435621d75ede67\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"b505b3ba3746ce35\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"76f19de43347b4fb\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"31fd790ea55af3ec\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"7436bdfcb4e7c8e8\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9075c7da8b862a1b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"db1349aaa8ab9927\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"07a0ea5021fb52cf\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"7ad7ee7780501642\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"0b2c1242303cd3e0\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"4fd4194e8ae0cf36\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"37ee14cf328f88ca\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"b834c943229b9cba\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"8c1301c7f6e19ee6\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"a33928ce9e1e3288\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"a14182319d0bdde0\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"641b0dceffdd0bc9\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"ecb216f759eba66f\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"d55dc15d46887533\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"1781009906e73ffb\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d6ecd938ae4cfa00\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"fb2f80f108ce5ad1\",\"/knowledge-medium/src/plugins/tables/index.js\":\"4cf2f47fa951556c\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"a2dbd5c82c2ca959\",\"/knowledge-medium/src/plugins/tables/model.js\":\"02a1f200085412bf\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"09f6740196f9b913\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"8903ce687defe46c\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"e4fe26331d3bce7a\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"26c9e00f4601df70\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"a3886af8fc32196b\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"c35cb1410a355cce\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"d280702ca0fcc5d8\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"4337fefe76c1b8f7\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"711247c1206fb437\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"edda9878a15e243e\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"628bc4b2ff88b834\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"eb2d80484d247a3c\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"e527d827ee7756ad\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"8db8f2cb874545a2\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"7b172c6cbe4c4978\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"f3752b529b16a7d0\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"ffb9b75c1b030683\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"19f5ebae1e134bf5\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d82824a11b6a361b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"b43ecb260d92f521\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c2e13fcaa6ca53ca\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"2a9c52593c9a36e3\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"00b578241d72e592\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"5f743655f3e96493\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"89e18d8128ab5ad7\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"af07fb24829cb197\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d0bbf49790f864be\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"b1bc73ce012d0d0c\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"cf79d284f08aeaef\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"8c8cc0a2085a7cd8\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"7c369ed306ddb307\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"bab58d302dd4ba3b\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d72828665f04ebe2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"2c24c59bb27cf931\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"e8c49cbed661e24e\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"39b8ac7cce71e0c7\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e126a28e7743585d\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"58d70860f8f6151a\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f4ac2d146d2dcb0e\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f7444382538d0e65\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"57d181974b5bc3b9\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"cc537bd6e630bf6d\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"99a402660c925086\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"7c384bc3b309ec3d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"931feffad5090c93\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"55ca14729467fb7d\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"c990c260ace26ea0\",\"/knowledge-medium/src/registerServiceWorker.js\":\"dd6938ceb702e7c2\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"6e9047da27c06f72\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"485fa1d7e627f6c9\",\"/knowledge-medium/src/services/authStorage.js\":\"90a057dc462c9e6f\",\"/knowledge-medium/src/services/powersync.js\":\"71b78e313ce4a247\",\"/knowledge-medium/src/services/supabase.js\":\"49786b6d3bb1af8b\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"df0952858e6a0d0a\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"e78fd2488938367c\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"19a265dffa0ab3ac\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"62e917dc7a468a84\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2a3a54059f951a1d\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"0a5c8674a17a52c6\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"79f27b679e5caaeb\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0174bd3caea34870\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"d282ee371fc7b5d0\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"b878daa6d4e21fb0\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"48215366ea01a792\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2672db773014876e\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"54bd97c9b537f9dc\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"7265038949c98f7a\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"cc7c46f720acd82e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"4091183053e9a956\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"1005fc914586f6ca\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"fc44847208fb17ee\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"5e0db5cea9403c9c\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"ea71c09ca334097a\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"fa41df87144e6720\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"d032cacf4499d1c9\",\"/knowledge-medium/src/shortcuts/types.js\":\"a0aaa98b3ac66c3e\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"9366892fc719cd76\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"5335ee3b7aaeb883\",\"/knowledge-medium/src/shortcuts/utils.js\":\"f8f660f1896d4462\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"39fa88e2654364f0\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"3052b67e5342eef4\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d5860ad220e68b9a\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"9aaf0cf6c902f3c9\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"1cd7035eb6125746\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"86b55dd652e47f15\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"2e3e1a9438e88c3d\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"0430bc7eafd818e4\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d984e7c0f9d88f9f\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"bf9d65021c81d008\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ed75ee127c7b27e8\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"86e05447dfdf4985\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"0eadcd89a3402724\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"5d4f41434465b70e\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"c3ef79192c4013e3\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"db71bdf9b4b70979\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"8f90afab36695d21\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a087a5a0aa43d6dc\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4fd2af1237cfd7cd\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"3422b3c0edaa6697\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"bb1dfde903f8dd07\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"402516978ae6237c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"9d5ec227fead3705\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"1dde0106db163934\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"efef398630e42511\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"54141c1a7c7f74ae\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"2ccc447379cef09d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"935256556cb64bfb\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"7bf7bfb3fe5349e4\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"9a3d4f13e92555a9\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"812cc343e9f63284\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"c1b76b9c76cbc592\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"d4d09147f97e8fec\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"7e7e5f851b73419a\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"3c76ea0346ce2c16\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"5b2d26ee6c52353f\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"f9a0f32ae7a71b74\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ca4ffc821fc05e1f\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"32f9f54fc18ec3b4\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1b24546e89fa9404\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"f2aa84ee9bf143e5\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"97368b73e9baf3f9\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1cd5e51b8ca6d4d9\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"e295a37933eae5d9\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"0893e420f6f658ca\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"a47bc09bb9ffded4\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"16369bd7ee62ef24\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"52993d646d4daa56\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"d5d30c473393e17c\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5c1f6e9d0fda5ce0\",\"/knowledge-medium/src/sync/transform.js\":\"4458fe11f5ab0330\",\"/knowledge-medium/src/themeBootDefaults.js\":\"42964f4612595243\",\"/knowledge-medium/src/types.js\":\"5b16a2d21fc52fac\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0788f90ecbb94294\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"3a890520a0e04f8e\",\"/knowledge-medium/src/utils/array.js\":\"b76192a651a44963\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"aae615e9702110a1\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"83b39fad569f2e4d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"20744171519f59bc\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"03c228ad3e53fd26\",\"/knowledge-medium/src/utils/callbackSet.js\":\"023e8a626bf89395\",\"/knowledge-medium/src/utils/clientId.js\":\"c3987d02333333e3\",\"/knowledge-medium/src/utils/codemirror.js\":\"06a6456705102250\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"5fab0703d1acd057\",\"/knowledge-medium/src/utils/copy.js\":\"9abe7ac462ac6ceb\",\"/knowledge-medium/src/utils/dailyPage.js\":\"58d1247fa2fcb9b1\",\"/knowledge-medium/src/utils/dbForensics.js\":\"7ba85f908755f508\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a4fee2b38f945b22\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"6ff56e67f55c8613\",\"/knowledge-medium/src/utils/dialogs.js\":\"d10eb4bcc95aef74\",\"/knowledge-medium/src/utils/dom.js\":\"ccc46b6d0b51cef9\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"fb47c7f6a5fb6112\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"a74c829d669d617b\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"13eb97dd69849699\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"8bbfd9c63768dcfd\",\"/knowledge-medium/src/utils/flipSlide.js\":\"af4413ea5ac950b0\",\"/knowledge-medium/src/utils/fnv1a.js\":\"17037adcac5e4344\",\"/knowledge-medium/src/utils/formatBytes.js\":\"4f78cb758317d0bc\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"6d9ab990f4add6e1\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"5806ba5e9939fde2\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b727d69aa24aa293\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9ea71336de70aea7\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"aec57a5abda3b335\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"318612043f1ff2ea\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"381bf0abb2f49d36\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"f1a1fb16d03dba3c\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"9df691e4df1a70b0\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e2e67ef77d8b390a\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"d597beae3514e7fc\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"05cd8669585a140b\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"512165a0e137872b\",\"/knowledge-medium/src/utils/markdownParser.js\":\"5e1a26f8c2711564\",\"/knowledge-medium/src/utils/memoize.js\":\"6217898e7877724d\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"8c3e1d5de8ee520a\",\"/knowledge-medium/src/utils/nameList.js\":\"e42521778c8cc4be\",\"/knowledge-medium/src/utils/navigation.js\":\"28d68e4cada81cdb\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"d9da179d7f95e0f1\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"b4c41b783b61c0a9\",\"/knowledge-medium/src/utils/panelClearance.js\":\"b93d79afbd07610c\",\"/knowledge-medium/src/utils/panelHistory.js\":\"96382cfca11ffb64\",\"/knowledge-medium/src/utils/panelLanes.js\":\"b841e86bb6fa8179\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"7c2cdf97262f97ff\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"82da4b1c7d436f45\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"bad43955bad89c5d\",\"/knowledge-medium/src/utils/platform.js\":\"cb0837aab300bc03\",\"/knowledge-medium/src/utils/pluralize.js\":\"eb3b84256ea4d416\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"354accfc24caee90\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"e725e855ab801d7c\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"c3300d466072e6eb\",\"/knowledge-medium/src/utils/react.js\":\"19cbb7093dcb6168\",\"/knowledge-medium/src/utils/relativeDate.js\":\"65a4870bde902bd1\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d232ab3c87f01cbf\",\"/knowledge-medium/src/utils/renderScope.js\":\"4a03d7acf80bb208\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"7c0ed6736106f665\",\"/knowledge-medium/src/utils/routing.js\":\"38d869fc6113d55a\",\"/knowledge-medium/src/utils/safeMode.js\":\"05561884f7ad8f67\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"cf1c751f800f1aca\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"982601e4a7f2e98f\",\"/knowledge-medium/src/utils/selection.js\":\"c87b79ef3d9d91ba\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"e217867694524a35\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"1bfa311261e3324a\",\"/knowledge-medium/src/utils/state.js\":\"b2452820a4762801\",\"/knowledge-medium/src/utils/string.js\":\"ee0b85706e7dd102\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"7645ce2cdb81bed8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"fea88db27b60f6f3\",\"/knowledge-medium/src/utils/toast.js\":\"10f53fe8fc1bbd5a\",\"/knowledge-medium/src/utils/toggleStore.js\":\"becd3ec43d9f785e\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"ed4eeb656e124e75\",\"/knowledge-medium/src/utils/userActivity.js\":\"34f63a550ae56378\",\"/knowledge-medium/src/utils/viewTransition.js\":\"3713b73704241863\",\"/knowledge-medium/src/utils/viewport.js\":\"45a1718c082ddfc8\",\"/knowledge-medium/src/utils/webLock.js\":\"bd85d9a8264c640b\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"396c80d87bf50051\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"21693d7f51ccc9df\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"e2e112c755143c5b\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"d8957137617a9aad\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"cba3e0c7ed9e621b\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"eef39b45791322d5\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"4bd4238d397ae47b\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"a7b8d464224d2581\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"a7d6e2ce2bbd3661\",\"/knowledge-medium/src/vendor/react-dom.js\":\"083711ddfad9ec46\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"26a9ea47a3480f48\",\"/knowledge-medium/src/vendor/react.js\":\"ed720abb3a679d91\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
