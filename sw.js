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
		buildId: "2a045410437e-959afbf1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"b0c98dd112635949\",\"/knowledge-medium/index.html\":\"b0c98dd112635949\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-COIx8n3n.js\":\"398105f2e362dd9c\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"8518698bbd967ff1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-PnSudaoG.js\":\"791d301e9ca9902f\",\"/knowledge-medium/chunks/FacadeVFS-UVOdNXoF.js\":\"a59e4ed0478b3eca\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CSMQtoWx.js\":\"cfb9cd4a0bcee4db\",\"/knowledge-medium/chunks/MemoryVFS-CfUYI1mZ.js\":\"fe38ecafb06d7306\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-D1fEEOA5.js\":\"d08fc4c4f21da2ef\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-D1nzVc-S.js\":\"3d08b7952a982eee\",\"/knowledge-medium/chunks/Preview-BQFbBWvE.js\":\"ebae2598c5a0f7a8\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B7lxvTi0.js\":\"e3191d5f303a1a71\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-_jYYxvYD.js\":\"e503af6cb83b604c\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B8CP5OxA.js\":\"9a39853932a4e568\",\"/knowledge-medium/chunks/react-BHJ-lhaH.js\":\"31ab6ab3e332bb72\",\"/knowledge-medium/chunks/react-Bg9vZIpp.js\":\"4113ff6cd3fa0669\",\"/knowledge-medium/chunks/react-CDaioGsQ.js\":\"530c6c07c10dd8ea\",\"/knowledge-medium/chunks/react-DKgVkxq2.js\":\"1a0a4e5a9507ad36\",\"/knowledge-medium/chunks/react-F0kOeNSR.js\":\"6c323fb73f1c0574\",\"/knowledge-medium/chunks/react-c1MRdsEj.js\":\"10955575dc12dfee\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BhWmfd5L.js\":\"fc8fa22fc69ebd6c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CpbrdFAC.js\":\"56d2b8c865321d77\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DnxDTwq4.js\":\"065452c5f9d7c2ec\",\"/knowledge-medium/chunks/react-kgY9rJNb.js\":\"2b2dc74efed157a1\",\"/knowledge-medium/chunks/server.browser-C7aDvDUo.js\":\"2f3f2dfd19a2327c\",\"/knowledge-medium/chunks/textarea-C81oaYG6.js\":\"0ec1887966cee46e\",\"/knowledge-medium/chunks/ui-Br4aBg8N.js\":\"1ef4bf2910338808\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"f321ec916a3d41af\",\"/knowledge-medium/src/appUpdate.js\":\"72bec90b00bc42ee\",\"/knowledge-medium/src/appVersion.js\":\"a4519ae5b61eef6e\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"0078385ad5f6dac2\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"d51b1e3534cee3df\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"69c94684c00704bd\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e6fe89211230717b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d1b0c5092877243c\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"972d621cf451fa54\",\"/knowledge-medium/src/components/BlockEditor.js\":\"9d28a9fe79d86c89\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"74b4b9c3a8edcd67\",\"/knowledge-medium/src/components/BlockProperties.js\":\"5fa590ffc876baec\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"0d8950694b643825\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"ef63cafdc0e36fad\",\"/knowledge-medium/src/components/DividerHandle.js\":\"b781b1265af28ff1\",\"/knowledge-medium/src/components/DraftEditor.js\":\"1b17d0fe933b7526\",\"/knowledge-medium/src/components/GutterPill.js\":\"71da59d7bb08871a\",\"/knowledge-medium/src/components/Header.js\":\"aadc82d533fec9ab\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"3cd2f22e4c734505\",\"/knowledge-medium/src/components/Login.js\":\"9f92503a8f1643f0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"5c1bead8c7ba4cac\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"70ecf49b76f72dc8\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8bbb5f7b0ba9a422\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7c9007d07476f91d\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"d1009c48954050b8\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"4842a2c0ddb7336c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"7d585bb1c4e776c3\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"882d817df13c5940\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"4b07150cb8849911\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"adb0ed2594743f13\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"1e2c2b96b5ca424e\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"8340ecbb329b45dc\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b1e8a6ac9881b0f3\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"3b3027b571650406\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"6a0a0d554901aa77\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"adeead95d73db45f\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"bcbd383e8626d36c\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"5c060b5e8173dcc1\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"e031ff59ac8d7fdc\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"95469c6c25a86986\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"760c5c5c5f0c4e66\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"679c2dd58f23dc6b\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1bd51b0bb1d57c47\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"5945d4099dc828b4\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b58985501eb9e811\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7ab0a32bbf74a572\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"b9d551665d601878\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"a2dbdcf19c4da7fd\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"6332fae0686874ac\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"460ef48c459a3bb4\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"0f3c5edbf8da5b74\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"ea40b10d2ad309fd\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"dfc38d6da83585ed\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"094c5d58fd405974\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"6e8beff103131cb0\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2d518ca9a3b8344f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"bb58ce1df3ec8bae\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"a088e9e4f4f07f9c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"831f20f22afa595c\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4d2eb896e032cf73\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"efd9495ef16f929f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ebcb36de4689fd90\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"982d4e069dde6be8\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"cdd13d5d0cb5aa32\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"50c40f028a35551a\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"d163c6407ad19ae3\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"698b5f4d966f203b\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f96a133de0f8e9da\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"52c0e53ef282cce4\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"fbf0ab741f3630dd\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"758dbfabacc84391\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"b17734f69451999b\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e5f6adbe1ffbc988\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a5d92587ea0a719c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"b465574a598e1c0f\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"df46b61aa29ec4d2\",\"/knowledge-medium/src/components/ui/button.js\":\"2929a6ee1b49e4eb\",\"/knowledge-medium/src/components/ui/card.js\":\"8b10de23dc40e11a\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"48c3280369e986f8\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"42363cbb9c37f0d5\",\"/knowledge-medium/src/components/ui/command.js\":\"8b129d7dfb8c9c07\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"68e6b312d1890927\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c7d810ce3447260b\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"3d5f6fde3b1b0210\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"8169c6943a23f35b\",\"/knowledge-medium/src/components/ui/index.js\":\"f2ec504e10bc6b40\",\"/knowledge-medium/src/components/ui/input.js\":\"fc4ae0316422c930\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a13f5b26b41b643c\",\"/knowledge-medium/src/components/ui/label.js\":\"970e141d54bb227b\",\"/knowledge-medium/src/components/ui/textarea.js\":\"e5b38bec7d8e3e34\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f1664fa1998282dd\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"fb67a82b0e573606\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"e50bfb7c1b2b93df\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"8b42cc1e6435f0cd\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b7c5103ae8269605\",\"/knowledge-medium/src/components/util/error.js\":\"f2562a214c5bcb1e\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b662f9d216fd7e03\",\"/knowledge-medium/src/components/util/suspense.js\":\"0a8729703c55d657\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"93992ee1a70296aa\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"d5485f9ce50db21d\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"09072c42201aafbe\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"e5f05f9ea0558ff9\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"7ba6ba2609d4e3f1\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"fcb69a643f775b0a\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"d6935d010cadf467\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"8f92be86621db922\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"90ff598c13e3f736\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"81516250eb5a89cb\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"d48b8f3348911a9e\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"f7d0bb6ccc28160c\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"27d145cffb87ccd5\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"7d0bf8e8dc995de5\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"bd442397a68c3fe2\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"b7f460c33a5bfbc6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"71e73346e282d099\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"b25ac6654f53ebda\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"dfc900dc21398398\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"524c432245a71a09\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"00a5c6de0b1217ec\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"7c1c0c18dad45587\",\"/knowledge-medium/src/context/block.js\":\"3af6f9a106958666\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"2056e4cda47c8009\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"b4ca1990418bed82\",\"/knowledge-medium/src/context/repo.js\":\"518a70cafa53137f\",\"/knowledge-medium/src/data/aliasClaim.js\":\"c1692cd5fb05e70c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"653360bb7df0914b\",\"/knowledge-medium/src/data/api/blockData.js\":\"38ea8df0e1860409\",\"/knowledge-medium/src/data/api/blockType.js\":\"5a1b48d138b9eb8a\",\"/knowledge-medium/src/data/api/changeScope.js\":\"fc15afd2c5df6d7b\",\"/knowledge-medium/src/data/api/codecs.js\":\"6997a7e19922d167\",\"/knowledge-medium/src/data/api/derivedData.js\":\"784d8252b4bf4ba7\",\"/knowledge-medium/src/data/api/errors.js\":\"2f770505d0776e38\",\"/knowledge-medium/src/data/api/events.js\":\"1d4d9e88b6de106d\",\"/knowledge-medium/src/data/api/handle.js\":\"fc05f7be6662844a\",\"/knowledge-medium/src/data/api/index.js\":\"68d79c55c76c2768\",\"/knowledge-medium/src/data/api/mutator.js\":\"88c54099ba50c1be\",\"/knowledge-medium/src/data/api/processor.js\":\"99da06bacc607dd1\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"e0143f4519d9e4db\",\"/knowledge-medium/src/data/api/query.js\":\"53a71c132536c500\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"8fc627ba8ceba3a2\",\"/knowledge-medium/src/data/api/schema.js\":\"fc05f7be6662844a\",\"/knowledge-medium/src/data/api/tx.js\":\"fc05f7be6662844a\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"adf17afc2d1c652d\",\"/knowledge-medium/src/data/api/user.js\":\"df3b309d0c3c1709\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"ff89461228f26d55\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"f8f1c400c8a9bef9\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"1fe34bc2a34a53d6\",\"/knowledge-medium/src/data/block.js\":\"44446cf9aa913134\",\"/knowledge-medium/src/data/blockCache.js\":\"e62a010587c9029a\",\"/knowledge-medium/src/data/blockId.js\":\"2e14e0d18b1af74d\",\"/knowledge-medium/src/data/blockLiveness.js\":\"1327fefe361bb6a5\",\"/knowledge-medium/src/data/blockMerge.js\":\"fa6ca7a0e4f1acd3\",\"/knowledge-medium/src/data/blockSchema.js\":\"a3d990108afe0c31\",\"/knowledge-medium/src/data/blockTypes.js\":\"e24500a6acef4b33\",\"/knowledge-medium/src/data/clientContext.js\":\"39fa80c11dad0dc1\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"a2766a4e498a0110\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"526c99171277f53a\",\"/knowledge-medium/src/data/derivedIds.js\":\"9af2b10666061487\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"38ddc0cb13a49801\",\"/knowledge-medium/src/data/facetBridge.js\":\"449561421b0cdea3\",\"/knowledge-medium/src/data/facets.js\":\"ca38ac8dca1828f8\",\"/knowledge-medium/src/data/globalState.js\":\"24a60f511d1fff18\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ad44a6ad55235b3a\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"3bf6adbc43bb4a66\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e22fd2942d5ac556\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"4603be85ca82895f\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c863ada3b0f40cdd\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"20c8ce96c1db3bb3\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"5d313796e3acc81f\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ad2496eaca77325e\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"f4304e1ae83f1e22\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"b904b7965806f2ab\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"97b2196e8e85098b\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"dad9d9caaef4003c\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"111af7bb01294028\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"b024676276ccf574\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"3fed522b4e7206ae\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"e04f3551b19023f5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"3796c0c5ca698129\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"103d36b28c63a53a\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"750a56f0eb29f17c\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ffbab33805d12bcb\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"8d5a9c8f0633833d\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"802c2408bae85149\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"a77de58261765369\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"1acf9315d3743baa\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c9f72fa09d27e1d2\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"0ecfc683ee3c4c2f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"0b454b21ea54f113\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"fbaab30071b739be\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"4e1dcc2f49f615be\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"2528b1cc98532d6b\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"fd2cb441b45c1dbb\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"d3c3168281a0a7f3\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"7beb52127daf4c49\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"2ecc0d210c67b8f7\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"15937c63db8543b1\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cca66a7c74be3f83\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"30e751202ce90f2f\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5de51867a739e04f\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"438dc62c9a4344dc\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"fcb59af29b8ba4ec\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"38277dba74de5c19\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"e40b7792241e2af3\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"5ae0cef401efd987\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0ed2b250b7fed147\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"18855e490b63c2b7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"3ab351b32d7c6029\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"cad6c28f71066803\",\"/knowledge-medium/src/data/invalidation.js\":\"bf87fe13eb562691\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"6209efeec7c81ce3\",\"/knowledge-medium/src/data/kernelPage.js\":\"45e7c0fcfe900740\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"490f0064c2d71c5c\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"77bc2ed1cdd91e85\",\"/knowledge-medium/src/data/localDbStorage.js\":\"530183d7aab088bf\",\"/knowledge-medium/src/data/localDbVfs.js\":\"14a387be37e35c5b\",\"/knowledge-medium/src/data/localSchema.js\":\"f7531a1f9737f904\",\"/knowledge-medium/src/data/maintenance.js\":\"c694b41d0dfeca36\",\"/knowledge-medium/src/data/mergeProperties.js\":\"6490b4111476de9f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"175fee59d7d85ed4\",\"/knowledge-medium/src/data/migrationsPage.js\":\"0b76ecdcbe1f8215\",\"/knowledge-medium/src/data/mutators.js\":\"8ab1abaf857e4704\",\"/knowledge-medium/src/data/orderKey.js\":\"ab9b92e83623d62e\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"af4948fa2e220fc5\",\"/knowledge-medium/src/data/outlineSurface.js\":\"6a6fd8d9db341b41\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"716e636ba38a2fab\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"31a6881abd0a9864\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"d1f7a2c14e87cdf0\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"5ce59d1a5cd0eeca\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d14a3c17804caf31\",\"/knowledge-medium/src/data/properties.js\":\"3861d08f448929ad\",\"/knowledge-medium/src/data/propertiesPage.js\":\"d43938455eca0df8\",\"/knowledge-medium/src/data/propertyChildren.js\":\"6cdfe0554fb2872f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"488ef0ee59ca3bdc\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"a605ead03adbb564\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"5b5732eaa5c4a347\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"4b2cb298fd4f67c7\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"15cca9fdfe8cdc51\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ef2ba0ef00da93b3\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f7bb9e0fc121b1f8\",\"/knowledge-medium/src/data/recentsPage.js\":\"ddd886c9f389f6d7\",\"/knowledge-medium/src/data/referenceBlock.js\":\"9249010b6f1aa64a\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b07b62818419b22e\",\"/knowledge-medium/src/data/repo.js\":\"2a4c70a4249c78ea\",\"/knowledge-medium/src/data/repoProvider.js\":\"7d0846b4b934a37c\",\"/knowledge-medium/src/data/rowProperty.js\":\"565b5cf4afdc3553\",\"/knowledge-medium/src/data/searchFilter.js\":\"37aad737dcc22e5e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"a73421a66023cec4\",\"/knowledge-medium/src/data/stateBlocks.js\":\"7e91c15bb58ee24d\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"68f495ba34e130ea\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"c63dd0875fc45f72\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"24a6393f63011f01\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"9d638a48749abb62\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"f76e01d1103db808\",\"/knowledge-medium/src/data/targets.js\":\"4d39561bfce989eb\",\"/knowledge-medium/src/data/typeColors.js\":\"38ac3b9011b4c38b\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"5367c923394554f4\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"a2d772b57dba8b13\",\"/knowledge-medium/src/data/typeExtraction.js\":\"c2b7f4d347ad4699\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"ed46dac0126a7c31\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"00132890943a1cdc\",\"/knowledge-medium/src/data/typeSeeds.js\":\"66309d8fbab89e7f\",\"/knowledge-medium/src/data/typeTagger.js\":\"f8822ea62f5eaba3\",\"/knowledge-medium/src/data/typedRecords.js\":\"56027eadd0e76542\",\"/knowledge-medium/src/data/typesPage.js\":\"2e1d42521a57aea7\",\"/knowledge-medium/src/data/userPrefs.js\":\"411ea176202db73b\",\"/knowledge-medium/src/data/userSchemasService.js\":\"2d87012a76096203\",\"/knowledge-medium/src/data/userTypesService.js\":\"5df467148260db6b\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"da03708a78c8e7e6\",\"/knowledge-medium/src/data/visibleChildren.js\":\"0302001dcfc3a970\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"203a1d34ea919310\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"1ec4fffcdb3d7d47\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"3c20cb25aa61d081\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"e13d489fa107b117\",\"/knowledge-medium/src/data/workspaces.js\":\"afe9476c5627d10a\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"5153a6f3c6c25b50\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"82067a3a31c9c56c\",\"/knowledge-medium/src/editor/atTrigger.js\":\"f76fb5591e19ca90\",\"/knowledge-medium/src/editor/autocomplete.js\":\"b9dbfdff7fed9968\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"ce090c3b4904ab3f\",\"/knowledge-medium/src/editor/contentFlush.js\":\"2a0628ae5f7002bd\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"67b88c54fcb74515\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"8c40e2c5f98b4cac\",\"/knowledge-medium/src/editor/insertImage.js\":\"5cdb4e0a9cc26fe7\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"685c566883683a7a\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"b37872e9137653c7\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3690e49a12e12d02\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"879206f8acd42a53\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"b0fabc1bc35804b6\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"25974980bcb4bd15\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"a9ca8f7e0748aa29\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"023c21c478fcf3e3\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"e0566b2ea5abb320\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"fd5644e24a235919\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"5107481b73312b23\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"67aea065009a432d\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"423f6b77a1416b17\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"3e009b124b3c395a\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"e14b9d7c5757e318\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"46460375b2997c34\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"06c68e488e2c8d80\",\"/knowledge-medium/src/extensions/core.js\":\"8d50002b552c30c3\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"96f5675a9d1defbf\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8f02eb0afe22198e\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"2ea040e25853dbdf\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8728a2ac0f191707\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"61784352cae514fd\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"542b4504bad6921e\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"16ece962778a3060\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"2ef02dead5c0db7d\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"6f11ca39ea8e7d00\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"f0bec864b420352c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"d16ed06529395678\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b3ce1996b8d8c86e\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"d02ce3c231e91497\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"0decb7ae6d53d9df\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"ab0b2a9e6a94d7b0\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"122023f2e7d4ee0d\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"392f770b57236187\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"af9ee389391dab45\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"6d1fee1cb9195f7e\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"7353295fa1b0a4f5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"8ed5bbdbbef5b79b\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"6f251d6e52bb0e85\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"379ef4b6c610d522\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"306fb31b2a1b2b01\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"9fc456aa8ff081d7\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"1150606df7d58c72\",\"/knowledge-medium/src/facets/facet.js\":\"d0b1a35697c5b3a9\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"55e740bfb0519ed5\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"9892333b2e649adc\",\"/knowledge-medium/src/facets/togglable.js\":\"5b40b00a2d5226d4\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f907f02dde3fce1b\",\"/knowledge-medium/src/facets/verbFacet.js\":\"077d2be479542325\",\"/knowledge-medium/src/hooks/block.js\":\"33b9559e1669a939\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"5f516277075c9a96\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"ff1ed5e58027d42d\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"955b584353669b67\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"d30c8377ca365212\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"3f8d1793d1841818\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"e9a6e50aa1f20ca3\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"05b40cd8cae3f032\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"8aea31d8cf993ab1\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"14eca285cf892cd8\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"ce4fcb7ab5ad90d4\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"abb2c4056611a2b3\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"683b08b49079ead0\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"911b8e112515f04f\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"101faf5cc90851d7\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"c8728005440b496e\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"49485ceeaec59369\",\"/knowledge-medium/src/lib/utils.js\":\"ebb2030df5d079bf\",\"/knowledge-medium/src/main.js\":\"52625aca188cac32\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c58014285cb227fe\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2a5e67c569d71fb8\",\"/knowledge-medium/src/markdown/context.js\":\"02221242781d816a\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"59aadbf4b96846e1\",\"/knowledge-medium/src/markdown/extensions.js\":\"1bd327f0f4884656\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"af68cddab0032409\",\"/knowledge-medium/src/minimal-editor.js\":\"a8cbef78275e5fd3\",\"/knowledge-medium/src/paste/armedCut.js\":\"17a34f163835c0eb\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"eac5842c1ef4acbb\",\"/knowledge-medium/src/paste/clipboard.js\":\"8ba6daf89b590ff3\",\"/knowledge-medium/src/paste/decision.js\":\"401b5004ff64732c\",\"/knowledge-medium/src/paste/operations.js\":\"46b829c5d5c4e6a9\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"dfdcc686dd6b6b59\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"74d98c38b575b129\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f0829379e1fe8386\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"d0a8c9ac8ff6d54c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e283e5dc46c354e5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ad443c860fb0c49d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"62127cc86e7a88a4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"877aeaf8870973d8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"4156668865a7c65a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8f45d213ed167443\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"c326c8c4e037a6f8\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1f118f73640a8303\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3a83170d77ff52a6\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"8719f0752672befb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"84b89701898812c8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"123213081bb71203\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"ecdecdc1c1789c63\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"306b7c2481daca4d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"149bf4f5a111b7d0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"6fe30dc52836108d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"7feb90ff26c50016\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"e825628f1312db14\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5d0b94e7b0e1268d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"7d63966e281acc91\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"c33b03251dc0d4b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"eae166fe754cfa90\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"201501913b742ae2\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"91d6acb51682686e\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"4ffa8fdb49c81091\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"f0061807d4f02d62\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"dc0640036861e24f\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"78a73af01fd3054b\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"0901fee0ae471a68\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"9cee321803964cf5\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"9c9743a22c2dd7bd\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"264f71081836f174\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"e2c9433b451962a9\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"9511078e8d5f146b\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"75dd13d820bb5c2a\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"07417204d813b631\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"5e5d9f044fd22e8f\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"6536cd683dce1ec8\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"c87a2549862947c8\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"49d2686bc64d74f1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"e781b36513a17cab\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"e955c20d262f4753\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"82e2ab8f211a46d2\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"95c29a508a93d153\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"cfd280d9fa790e3f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"156543f461cf7635\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"8bb27cb710e852ec\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"b7eaec91c9b562cc\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"a41cde230e0f5761\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"712ee62535e1097f\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"d91a1ea0812a1e59\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"0358777d45961e6d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"fe6b5711a568b340\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"828d47ec3f0c0b0a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"d56f50c49bc3d4b8\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"51702b488b0e1d2d\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"631c76ae37eaa1d1\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"8ff7f0cff9909a64\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"f3d234756a906f99\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"701d3830248073ce\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"8cc5d312734e0959\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"614ffb6905780cd8\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"b8ddfd6a1d3e02a2\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ec3c53e400c34eeb\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"f42ca61b9760821a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"b8e9122a0b0abfa0\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"eec5f42f54f91888\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"b6c1a709ebe83223\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"7ccc8533de87ee2f\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"8d4083fe9a91c0b2\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"810686059c32a75b\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b58ed7874dc5ecf1\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"7b699fe9d26d4e88\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"fb4225f9296287ef\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"699fcf9717248107\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"39050f9dfa7864cf\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"20cd30a7b5e19bba\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"3594d42347530b6d\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"f378658b34bd9872\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"0eecfcdaa5cb2d7c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"b301b8623db961df\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"3f6af7d99a83cf29\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"10b6e842a66c5669\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6a3e4e6d6fb11d0e\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"3aa3cb2f372a0f64\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"364dbd0d0bd2cc85\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"44566a6f3d1793c6\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"08f57187cd890313\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"e05c2fa76035c52b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"ff0977835b024290\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c525eff65f99850d\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"00b2d72bbbecf0e3\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3580082fff85484d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"4d281cc699a9e532\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"7b7bb230608e9671\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"3827b8fa0841d2d9\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"7be8225ab6dcd398\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"22bdb6ef997bdaa3\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"ae059698c353bed9\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"707e807ec1a0f041\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7a46b9b0599ce6a1\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"4f992cd41d07c277\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"752ed8d8452d6e2f\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"a6db0799c5ebd239\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"5d7057d73b7b31a2\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"44dd4b90c963a2b3\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"74faae683fa01ee7\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4b53ef8134f5f804\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"74b9f5bf2ee9649d\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"2e2b812222e6022e\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"fc65558c70881f10\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"74204a54c23f5f70\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"9fe07bfb3204d589\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"c4d47bc4ee015b6b\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"941fdc32b1709005\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"b50af985d6b0a20e\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"cac9e7d1eeb9a240\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"3a0224d3a6319bf9\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"c4b2452590477cbc\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"403dedf9c4bcd30a\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"2e72d72d434d4df8\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"5d06c2e9203ef87b\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d80563d609741f92\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"e9ad90f4ee1741b9\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"17539d48f8ebc608\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"0cf10d282d03d86a\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"36d26a9413ecd976\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"393c806dcf95069d\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"bcec1a0f1b302fea\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"f43517465266c5de\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"b29de1ed823a9266\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"73e81b85cf6c362e\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"0caaf96657174727\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"61851bebe224321d\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"81580f6df7d0e6a5\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"ebbeaf84889cf146\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"bf85dd67f39591cd\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a0423c98699e3e41\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"81826efc320434b5\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ab1724331b646125\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"39a5e034a955d604\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"80a9fce15add318a\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0496fd71741c7883\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"2e101961379228ec\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"b05d32089f6deca0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"915b2fa2c1af39dd\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"52340a71950737c8\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"69998ed3e1f7e14a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"90c7c007436f8110\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"5af49326be36072e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"9b7a60bb297d6d17\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"29fe353f92d6a9bf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"dcf70e8b5e4d56dc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3a53a85e6cc09364\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"47fc14e855b01314\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"027920b1f66e4a4c\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"4e6acc3bd5b1d471\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"f0d9bb3aafb0d900\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"a4ff310dd5bac5d3\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"408ae8e2a1008cba\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"30ebc0308df2d291\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"9a54ea41df779a3b\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fac6fe37fd1e7350\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"254e06e728454e3f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"7292d468b5889822\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"e61c5d2cd64149e2\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"7653a4d21afb35d3\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"4596893170fca9db\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"1a1699330614ab9d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"59f961ae94abc7d5\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"67c54f806692895b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"ca526efe41ee116d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"43f73334a67dc917\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"1dfa4b9b80ae78aa\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"fd743c1e183c094c\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"4d7aaf48b209a54b\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c8b4df2b898cb567\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1578cc5befbe6589\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"e4a1e4b4b5920cb1\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"dce422dd495e5ce3\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"bc53ca04598aeaf2\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"21e235664637db0f\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"b857a752208f1ce7\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"87791bc66d739e1c\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8c83999f46a228c2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8fa59bb3f0f1f845\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"99a795f32a52776b\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3490ff84379127f1\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4a7acdf4e43cd0fb\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"fab938453e3ffc0c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c95983ba0a5f1398\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0e423e96b25733ea\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"581b1d5684199b42\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"bc021df483ed6031\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"fadbfc60ad59883e\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"faa683d54c16cc65\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"76678e0aa0259c7d\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"e1000ca540e4f138\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"75b69161b413dc61\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"e0f3bbf5b905fb8a\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"6bf98635f38786f9\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"35aed56923acba9e\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"2711cf712a788b62\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"396ba1b44a34d998\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b6d6b885d1da47f7\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"0b5b40c4c4b8c4d7\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"151dcb3d44951190\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"19e813736acac5a1\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"0b4034bb631a06dd\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"c0c76bc649448a09\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"3728981b868ffed5\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"90cc8d1a729df126\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"6802e5c4e6c691ea\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"6e1d479ddc7cd0b5\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"372bd610fd744075\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"c4053a24ea015911\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"bf82e06809efd38d\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"e79636f6c9f3ec41\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"25cc231738fdb1c5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"26f1631cca6b1404\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ff8e1315df13865e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"7c70766c1e3a3719\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e2bf9d16e18a7776\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b90d70b49061b8f9\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"264d14ecf22c6835\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"d66b5083523f211c\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d34019d4e809765e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"4eba8537aafd04e6\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"25acb6a6d03d7960\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ad6621870cdbf314\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"2da1ed95ff071c10\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"74fe3bc4145bcd3c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"14f98bfd95d75b14\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"88bc132e07c997a7\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"145cb24303db78b5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"aafa21a1cadc2394\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"0ee6f828018ff74b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"f19d9e3be414113d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"6803b5f6ca334c81\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"092b546202c9afd3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6ad5308f534a3bed\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"f36a39bc6a95e443\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"4ff3cee08f571d7f\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9cec2eac5fba52b5\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"87c2ac546d5fbd24\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"b78fa24f4fedfc50\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"a9fecb26f4026c73\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"03c74576e1235dec\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"35604d462fc93dfe\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"e8c505fcca6dbf5c\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"3e781349c7e1e0a6\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"ba5522bf89c07b77\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2e7033bf4dc59785\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"31c0626a6bb017fc\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"21773dc5e87bdd29\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"c78c4c6729df3a5f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"2142cbd2d10228fe\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"6f5af8c2f6e82463\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"b8ab56df14c90ffa\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"e549b63d305e6cee\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"04a6db7fe218dfab\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"70645c40f2966f8f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"46bb47bab9799af8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"092fb1aafb47b11c\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"95eba4944f558fac\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"91c1e479d2eb3ca0\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"866853b67f845799\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c2be3c7944460498\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"eefe378288f6d899\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"f330b047786aa0b4\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b1e9f7370e3b82ba\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"154abb056df7bbf3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"20ee08ab59807de2\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"ee51ae2b8a248d86\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"cf38929c16a9216a\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"4dc65f6fca4c0163\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"006a0be387ef0941\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"2a3aba9b2761813c\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"027e866fe501cb53\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"af9f8dab01d92542\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"7717c81119501435\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"9180800682848a5b\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"fa6839206a93be76\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"f50e0b6fcfe208ce\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e3bee4a577fdbb73\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"991159c6bfa9cdd7\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"01427c4175b4f1d8\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"3dbe7575b9f4cfa8\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"65fdffc153ec91cf\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e142cadc37dd0707\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6cd490cd42e86cca\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b42df6de13d90dcb\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"76fc2cd3f154a10e\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"2f17a3dd06f60d0c\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"c33cf6f03fa6c04f\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f4d92c3efe8277cb\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"526c6f6373af1834\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"c541ece0076ca323\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d5d5f4a220944185\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e74bb914d32da44f\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"1fae5f610259f05c\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"806b92b05ef60f92\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"93483460d8531c69\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"03457ea8b3b4c886\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ecdde94df460f39b\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"c7bf8ea4ed9baa1f\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"fc72656ed24996ee\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"1b0a385a7a87facf\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"09f2a777c0c3f2cf\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"53670dac8bbd0352\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"79565ad6f660688c\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"c60e010369d831c9\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"01236761c2bb4a4c\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"240f0f265b93b5f5\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"2dd283163a9c4c5d\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"6ea731543faf1f26\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"11a91e245ed09609\",\"/knowledge-medium/src/plugins/geo/index.js\":\"fd6f9f271b144de0\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"6ac4427e58a684e2\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"a6c3a97a3d2ac7f7\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"4fe6f86d73f7caa0\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"f7d92ceb651f1170\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"c6c190c9acfbbfe3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"c7885d7b86aafe56\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"935c36b5781c4f24\",\"/knowledge-medium/src/plugins/geo/query.js\":\"bfcdb51679b5afc5\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"1cdcf041deb241c3\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2662ccd3ad159739\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7ab5373832f847ee\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7731dcbf5ae07a33\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"d34776fbf163a848\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"9ecac2c056d2258b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"f839586f43bf41c8\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"b192df076e5ca39d\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"94ed7437c2663024\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fd0a18869ba9ed43\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"6dea9258900a6a4c\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"259af8bfa213ccb4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a849526b28e9e150\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b38f50be1a9fc1b4\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"a68ee5fc19558c1e\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4963302c6b2a8d6c\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"c6d078ef347ed697\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"9353d8873fdfb130\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"576b5aba05541415\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"28bbd0eb3b4388d0\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"b5c0fea15a81e845\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"7871197b92f7411c\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4a88503d6bf58179\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"2556ee6c8bff5152\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"364540650e64387e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"f3d216ac7558b012\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"b1d08694a562647c\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"cfb963336c3ce252\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"00375663f9a5951a\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"b07fae62292d6068\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"da1f01f756367986\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"61a2204d1b1bfbc4\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"b3870f3a2807287a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1417d0de480dc0ae\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ca4d31c97555fa5c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"37c97ded84c43063\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"aca1760ee0724ff0\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"af9f9d534b5845f9\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"ff9376529ad222e7\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"616b435123b81717\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"dec1d202971dd9fb\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"fb13d1c5740a7a2e\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1b5f20de971afdc5\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"67a41b2591fc37dc\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"f8e7f39b1f429f18\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"93c38a93fe608da0\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"34469fc49e242791\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"1258469202c01c02\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"36214573ce15fe2a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"d20cfef4c33c55c2\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"36ff5b0e79952b01\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"8e3f212dd457a459\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"ef3715dadf0ff78e\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"638e80468f3436d0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"476fd8013ba123e4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c8de4d0d10f5cd7c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9a7036c3dba9cffd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d69f71f4c96d1f17\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"d7948178e4391f8f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"17ac43e1d97fb750\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"63c30da6ca998cdb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3019f20a07504d98\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4a7817b7c555f93d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"214d8ca65d7993b3\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"36576f485a6e96d2\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a1f02d63eccfd831\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"a60ee77be72a9a40\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"2474659dcc97a0cf\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"0efd876f6e336857\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"ba594c1c26e50bbc\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"6b12794e39ab3c4e\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"84617c8ccd3689e9\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"ca10a40c40ecfb7e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"e4d5d8a12aa20385\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"ca742731e45d09e9\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8d2e5e2a8793f83a\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e2d7254d25a6c4e8\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"6e8fe97ddd98e59d\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"63fabed9a2dd7ba6\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"50f97f86b0c9bb6c\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f1f75e4c56cf7073\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c6f06d17f346261d\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"cfebb5b408ba7f3f\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"c8ae62bec1183fc9\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"70c7a60f12c222be\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"04e545a38e564bac\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5f4152754cae72f9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"9dc3cb5baecbf784\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"90e02658a01ce070\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"9fb99db7baf93e93\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"637a6feab9014e3c\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"b8395446993ebf65\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"73ab93c02993cab9\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"028bf430aa9756b1\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"698bc7bd21b507a7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"212a52d7df1ff0d8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"e1450b32f83a6822\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"9d3e14008e24269f\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c673cbff50c84c49\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"b44dee1eea93c816\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"627341b04679bd18\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"07932b9a38bc5c74\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"e0038f1e5871621f\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"620ffedfde165f25\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"81dea40b0cbd3b65\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"efc78a2115beec22\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"33bbac4da667c2f9\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8fb251da658a4a54\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"f5082edcc9e1c5b8\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"e95d14bce5808ded\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"40ad372375b01c21\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d3cc6c6ed04837ea\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"d7019a971755d7e7\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"5f0e5a7e16e2fd92\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"50ff3726aea9392c\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"ef41a8b6fa7867e2\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"10cd6d2cecddc609\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"50f30e7a6b7097d1\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"537259dfadb8bdb0\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"e46b2ce20d29d9f1\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0291e145335d466c\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"5924f2285d3f6e0c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"d4e56c35c375cc21\",\"/knowledge-medium/src/plugins/recents/target.js\":\"4542529826596363\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"35d2dd8e1251d072\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"04f91404953dfd21\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"70bec5e21ad8bb1f\",\"/knowledge-medium/src/plugins/references/index.js\":\"93faa63d3efc4472\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e7c1a1c8cbca6805\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"4adf578ae1021bff\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"067f80119a4ed307\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"d6f8dac21a53a1db\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d697146d9254c98a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"cda23a9716e213c7\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"bc853f7c12c59ecd\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4cf9a315debec185\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c7d135c7bfe67933\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"ca897ec9600b94f4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f7cb1e6ba5ef7246\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"faebceacb322092b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"a004837b58e60565\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"e6bda6e2a31f94cc\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"cc47ce577816661e\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f8fc817cfd78e3bd\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"0e8dfa09b57d0ce4\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"dd3242f73232876d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"aa0183e1dbea00a4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"1ca5dab0474322bf\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"64e57f11eb097cca\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2da2a3e6374a09e0\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"1b8aa41fa1e589fa\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"6a8b24c42d1042cd\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"cd8ae5f31cb3ac16\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"19ef5f6eb255e9af\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"5bc00b05ce80a3a8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"773283dd19a84b8a\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"129b041df915f6d8\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"a2c5cda28629b764\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"e3f83b5dd5f4ef3b\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"dce0d9dae5b3a174\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"636a977ad09ea384\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c00916c760051e49\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"db9a7e6b82fa9f89\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a0edce1bdf4718f5\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"594ec2c4bc2be033\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"95decdbcf665095d\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"30ccb1264feb3d4a\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"b888ccafaa24e767\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"091996d84afc7a57\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"af80ab32685af2df\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"6e7e19b87cce3e3d\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"55c02dced3daeee7\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"5ff0f436368e8396\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"10585e9d9cb13637\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"174e0ec37ef7d71d\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"639f3ec0d364bd03\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a5dcf4f82655425e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"baf6d241df49defc\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"e52af706a4ec2764\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d7c78041d1970928\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"9a7673e1a0d5f0f7\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"68ebe5702eb0eecd\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e3826c7f59662fd2\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"0e761993bf88b26b\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"c60c178c970757d0\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"c05079c8ab89b3a0\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"aeae5275cd7468c7\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"579c9ae2cab2274f\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"f510890e09c324ec\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ba1914fd36b696e0\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"37b566548a410e83\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"4197f075b0a3f584\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3b4fc95830d61a84\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"ed5a14019c26b13b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"e046b5c46dbca98a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"49ac8eb8a28cd1e8\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"890e3875d878bbc0\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"58501741623ce79c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"172adf03600b1c00\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"0890816316b00785\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a3a8606e01cbceec\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"537a1d22ffc1e745\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"06522b464c285e97\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"a463973fba66ed4b\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"48f85c6c67f16b80\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"c0d46de5c466dd1f\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"5f11294c58ed2719\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"3721777d52d97e4f\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"6166bf3e7ec298ba\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"3d1d783f970e5ee0\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"cf3c530d1e5e10bd\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"7aa5f19e44073117\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"9df028167bcad382\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e3e7006f67cf850d\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"664451ce6227b080\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"79c337a269788f1e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5392f6b0f6610b3e\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d074cb734dbcf6b6\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"b2335c5673b2957f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"9ac6de28b7b9efc3\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ceaa6a44dff77881\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"37ffe621e7416ec8\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"97940baaf075f493\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"31bfcc5706c4f1b4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7b7e7ec3cc9ef8c7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"40340c13c9040d0d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"a7b32fb2c8b2d800\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"64b285c6b495ea5e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"0078eba46c3500ff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"9d1065d734f9f190\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"81a2a15351c2eddc\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"1b4d1a31d6ee5b5e\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e3e76c8b3379ec38\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"7bb13660504295b6\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"ea53523a177a2bec\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b4a6892093c9135c\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"7a7bc5cc5823d6f4\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"c38454a150937bb8\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"9a5f2224c82fa171\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"908d7863a7b15d91\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"b685cd53b20ef981\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"52b506a07cae8bdf\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"4c79a41342b20cdc\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"bf0857c210c9b7ff\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"6ed6ef8b4c315e59\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"e297da0a2afdccae\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0f40b59cfa119ea9\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d284163cf6aaab43\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"72826fe67e726c06\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"052330332d69b6b5\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"9ac788533f22a166\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"c431c5a976c92990\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"1bc4e6b9f334a37b\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"603be0555079b67a\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"64dcbb956a20ae23\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"29a938b1e0feea98\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"41545d3c16ba2117\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"6edc640f63d93dd1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"2fece7e03302aee0\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"d3d2e81075502a9f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"693f260d7f16245f\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"c1b5904369636f6b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"d59d5e20ebc7510c\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"fa9edb69a6594290\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"41c99cd1dbc8bdeb\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e1259265e7e951e4\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"d2dbf0339c37fdbe\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"02f619ff27412149\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"312a869009b605a3\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"acb69433bd4a2c24\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"202ed21b091eb46d\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"cf762a75baa40e9d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e6d1ebf85abb8a7b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"ef9a1be350db704a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"2034ab3a761af969\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"0c8cadb88956ba67\",\"/knowledge-medium/src/registerServiceWorker.js\":\"22929f84de6e19ce\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"c2916c66ae6bc5ca\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"a9d85837529a76d2\",\"/knowledge-medium/src/services/authStorage.js\":\"9812d12639fb4d83\",\"/knowledge-medium/src/services/powersync.js\":\"b3a882185526c4dd\",\"/knowledge-medium/src/services/supabase.js\":\"abf82f6624da0b11\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"fd13f7f6547bd4c8\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"a2d0e6ee29ba2147\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"781280e6ceb752e4\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"b6389749fd5e3748\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"96c0edd54da09012\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"e493808a35305c8b\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"e16b231be4c00b60\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"7fe8cd5fe4f9a5c7\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"2a3bb2874096b644\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3cdf68b5d0878d30\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2cb32951ea23c5cd\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"74a1fa2643ae9c74\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e8b85db6140254d2\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"f3318c7ae5b7488b\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"420bf3cbbce950c5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"92f42db5dc242804\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"bbfd46d4be714965\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0dc92771cf1d4fe8\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"5d23e8eca1e6aeac\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"abca609467347659\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"81d2fb38ae70c577\",\"/knowledge-medium/src/shortcuts/types.js\":\"1266706f656e3c6a\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"fa606725335cd200\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a6f45eeb52098e7b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"5f6eabfa96b7102b\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"405a7ccf7c3f45d7\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"71be52f8587483b0\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d1e484e0ec022d59\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"6432796e46a041c5\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"1483b8096e2fab0e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"a5abcdc6e5884cab\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"76db0a0cfe3e8e20\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b34a9e23212d4d7c\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"1fc8fac3ed960147\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"9c5d6e012a5cde24\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"1ffd1299a5138be7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"6d4a91b9dd13fef9\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"1e2e6e1d878c0406\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"0ff67011ac61b124\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"95285efef2e2a223\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"a1b93ef94fdce8d9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"1a577d8822ea0dd9\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"b6742a15512c5907\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"0e07dd8adf9de215\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"53455ffbd9773fff\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"e4dbdfd101bb29fc\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5cc6a63878a1a4db\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"f3491d7588e47b77\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"b80443107bad3810\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"a4d735dbea96a452\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"cd008df6601efe32\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"0e10bc4fa29f5a1f\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"00c36b9d835a06f8\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f66baa016707c2fa\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"d4452769b13e0255\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"118d98dcf08a471a\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a629161d7588808c\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e52941c70af8866b\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"eab9de849ffd13e7\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"22d41cfc184e9a9b\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"e324959dec344836\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"2db15e624e950774\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"2d00bcad0bb5dfe9\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"a85385f79d9c6e6a\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"08d95e268a59254e\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a16ad77b71f37a2d\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c3f200268295a34e\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"710081a6d40f6009\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"502099c13b514d7b\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"e57ce8e778d01d31\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"63a7281c2b3649b6\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"30c8a27d2ac36e8c\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"ecc27f8b985325f7\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"0d6d63887ac8efaa\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"eb7e73be37cff6b8\",\"/knowledge-medium/src/sync/transform.js\":\"376eae4e4d5b028b\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d8c093dab58f8361\",\"/knowledge-medium/src/types.js\":\"85ff6fb057f763f8\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"f012c2d85fdef59f\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"ab6ba6300bf8ab05\",\"/knowledge-medium/src/utils/array.js\":\"e2b4864f37fb967d\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"0c4ffe9438f4fe6f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"74a09079d690b32d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"a87393bad7933d52\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"da89c8c5f74eeb02\",\"/knowledge-medium/src/utils/callbackSet.js\":\"35154d8684d4645c\",\"/knowledge-medium/src/utils/clientId.js\":\"45eaa5af18bf88df\",\"/knowledge-medium/src/utils/codemirror.js\":\"897f28036906f293\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"4958638d375419c3\",\"/knowledge-medium/src/utils/copy.js\":\"52be8c84daffba41\",\"/knowledge-medium/src/utils/dailyPage.js\":\"f0432bad8361ecaa\",\"/knowledge-medium/src/utils/dbForensics.js\":\"4cde21b2559c23da\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"7b3d2ec669555a8a\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"30cf4ff66413be28\",\"/knowledge-medium/src/utils/dialogs.js\":\"5f2b8ca8631fac88\",\"/knowledge-medium/src/utils/dom.js\":\"93a082f49dccf546\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"5bc18cbb425cd281\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"22e03756251094e6\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"d656967cc441a49c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"59f2616e0e0f3003\",\"/knowledge-medium/src/utils/fnv1a.js\":\"5f205190fcca251c\",\"/knowledge-medium/src/utils/formatBytes.js\":\"cdf16de2de0368a4\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"722a362d5deb3a2a\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"14b881e81b271acf\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"cf382968d8f4f1bc\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"4a9ce36fc1d5a7f3\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4da8e26b78e5ac3b\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"4a7262152caec4a2\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"5398dfe183ea99bf\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"4df4082d7c40fa6a\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"fa75fe3ea891517c\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"532830496cd32b62\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"c1e1bb8726cc264e\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"deacdbff3c3c44a5\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"a87c0bc55fe639c6\",\"/knowledge-medium/src/utils/markdownParser.js\":\"c7c291ad7e008e74\",\"/knowledge-medium/src/utils/memoize.js\":\"7ebefac5598d99ff\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"56ecdc1469083e7c\",\"/knowledge-medium/src/utils/nameList.js\":\"8ff378ae0d79f84b\",\"/knowledge-medium/src/utils/navigation.js\":\"941e43e6c9818349\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"9facd14df6c6ea1b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"5a7bb941c96dc40c\",\"/knowledge-medium/src/utils/panelClearance.js\":\"035fdc0ed47b0cde\",\"/knowledge-medium/src/utils/panelHistory.js\":\"5ccef9261d8f7275\",\"/knowledge-medium/src/utils/panelLanes.js\":\"3db703815ee7b4d5\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"06fa7fccfc2a46b9\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"aade10fe582240f0\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"15244d5b1e20ad71\",\"/knowledge-medium/src/utils/platform.js\":\"d86ce001a68ec972\",\"/knowledge-medium/src/utils/pluralize.js\":\"30e9d8fa65e52fb3\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"af92d66a2da87287\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"6151adc134f27619\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"c7b63947cf9273dd\",\"/knowledge-medium/src/utils/react.js\":\"bdda910322497c8a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"a26aa36766075148\",\"/knowledge-medium/src/utils/relativeTime.js\":\"11a1df2a0fbeef8a\",\"/knowledge-medium/src/utils/renderScope.js\":\"f98cf9d8703b2f07\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"ebb748842d16a0d5\",\"/knowledge-medium/src/utils/routing.js\":\"dfbae6b553f941e8\",\"/knowledge-medium/src/utils/safeMode.js\":\"87359d5686cffb38\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"2248687911b27d32\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"c3184141dcd4f0ce\",\"/knowledge-medium/src/utils/selection.js\":\"134192c8d772882b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a45b11a77f5ae62b\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"3058f07c8bc0d5aa\",\"/knowledge-medium/src/utils/state.js\":\"b9ac5bd90a29abd2\",\"/knowledge-medium/src/utils/string.js\":\"96972338c93323d7\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"05121e212d81d071\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"067df438fea5341f\",\"/knowledge-medium/src/utils/toast.js\":\"e2f3794367be9955\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0f6e867b7899504b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"565338f873179f27\",\"/knowledge-medium/src/utils/userActivity.js\":\"550f199e4a9eef2a\",\"/knowledge-medium/src/utils/viewTransition.js\":\"825cd4c20792fe91\",\"/knowledge-medium/src/utils/viewport.js\":\"0fba0e4597909c1d\",\"/knowledge-medium/src/utils/webLock.js\":\"5f1d260ff586e802\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"da058e4e357d9194\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"37850d969e7f3878\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"c52c5ee7aca8f632\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"c93dc14f33b1abe4\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"cae6221870d9ef92\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"3047a6de8c7c97bd\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e675303002a6c21f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"7461c6bfd085e5a6\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"818bac78832e0c82\",\"/knowledge-medium/src/vendor/react-dom.js\":\"433678d5aca5338a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"546f79d3db64f562\",\"/knowledge-medium/src/vendor/react.js\":\"51db197320be048e\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
