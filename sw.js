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
		buildId: "33e5d431f938-236c1358",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"8da8a8bc6cef597a\",\"/knowledge-medium/index.html\":\"8da8a8bc6cef597a\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Cn0VZ6Vh.js\":\"1f110923d232f8ab\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"819fb298149caf14\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DPsFRShP.js\":\"af3a569ed650fdf9\",\"/knowledge-medium/chunks/FacadeVFS-sO93Wk6A.js\":\"18f03580a7d0dfb8\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-I3gNtOJW.js\":\"9abbe271ad5175f7\",\"/knowledge-medium/chunks/MemoryVFS-PgtoQnfk.js\":\"284dac2b9cef3def\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-ZuqwPud7.js\":\"27cfad6a55d8dfdf\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DzrlhJ2M.js\":\"23261a6b13cdb6d0\",\"/knowledge-medium/chunks/Preview-BSc5-Wks.js\":\"a586dd3cae242cf2\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CiOvXQ3p.js\":\"b9b59f0e885667c4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DP1F472g.js\":\"806a950ce79b1e31\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B1AtWED9.js\":\"6ec4c8c230f2d67a\",\"/knowledge-medium/chunks/react-BYK9LZm7.js\":\"2390751b6aa18bd9\",\"/knowledge-medium/chunks/react-C52ZhBEQ.js\":\"b186ca97ecb58376\",\"/knowledge-medium/chunks/react-CIy_MpZp.js\":\"36ba1dcfa7661626\",\"/knowledge-medium/chunks/react-CJIl63xf.js\":\"2d9f598ef98ace22\",\"/knowledge-medium/chunks/react-CKRL1iO1.js\":\"a578bb2e2f7be425\",\"/knowledge-medium/chunks/react-CqG6s7Xp.js\":\"dcdab413295c8300\",\"/knowledge-medium/chunks/react-Wacl2_tA.js\":\"849054ddb4bda376\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-COHn9oCW.js\":\"dbc8b274bcf2b57a\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C07YrbVc.js\":\"9cd7e0951aba9f9d\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BnVNecng.js\":\"328d632541872b5b\",\"/knowledge-medium/chunks/server.browser-l58FtBpa.js\":\"fda7b2d8e5d62c1d\",\"/knowledge-medium/chunks/textarea-kLdrr36i.js\":\"6038321a1670b9ab\",\"/knowledge-medium/chunks/ui-Bkn0v4w1.js\":\"55d7a4dc09311185\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"903b99b0de234b75\",\"/knowledge-medium/src/appUpdate.js\":\"29c05903df45b065\",\"/knowledge-medium/src/appVersion.js\":\"13e80c3d81f18e3e\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"70edad9dcbdfd224\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"399864ea635d9ec0\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"c789fb6a018e6553\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"586d457d0d6edffc\",\"/knowledge-medium/src/components/BlockComponent.js\":\"23374415c39444de\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"10c39e182f408fb8\",\"/knowledge-medium/src/components/BlockEditor.js\":\"862e230c59df90c4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a8c7569de8590cc6\",\"/knowledge-medium/src/components/BlockProperties.js\":\"47ed107b0d0b0f00\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a235e4806dd29ca9\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"fc18666019c137f7\",\"/knowledge-medium/src/components/DividerHandle.js\":\"192a11dce267c682\",\"/knowledge-medium/src/components/DraftEditor.js\":\"afb309a9a99444ec\",\"/knowledge-medium/src/components/GutterPill.js\":\"7c02cc030fba277d\",\"/knowledge-medium/src/components/Header.js\":\"f9d98ef46d4ca9e4\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"83fc06991e54916a\",\"/knowledge-medium/src/components/Login.js\":\"db1cc5df18fb713d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"8b5ca894ed68ccf0\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"0c50ccb3d7bda286\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"06447919f907338b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2e8812c0d64685af\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"f131efd3eee62f83\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"a71c02953582af49\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"9305eb0de6c6f4c5\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"f79f40936b9dacf6\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"2b16b15b18de9c29\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5e033c14f1c3ef19\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"df5f46e43a7a99d9\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b383fb4dd40f565d\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"ef58b82d4727b9d7\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"32617fc575620dd4\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"13665380cfd6ba7e\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"879029ee3dd8ac52\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"4d1c72f993f71727\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"1163b43bd7166b41\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"54a5b8430468910b\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"8b0d3fc8c840da1b\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"e409079935136cbb\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"4799569fc37fdd94\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d791b4400f1995a4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"9ea36d5c2cb5d8a6\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"b530eb793a7a7eb8\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"507f75fb78e63e0f\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"bc425752ac7a2b95\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"977907908e3ef7e2\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"150eaf98347b8372\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2aa69a792f5292e6\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"edb23d640bc4ea16\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"9d5eb7022a58db07\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a974cf9a4cb6d1c5\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"d6c610a5a2a3a124\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"e94b9575e456cde7\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"880d99201f602b9e\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"5640b5aec7a75cac\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"a0b93982c74651a9\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"e6cafcb251d3f200\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"eb38220b9dada515\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"56cea589c6546ecf\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"03523bb8b823adb4\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"b49aac1985e1c3ca\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c2164444206bf6f4\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"7a59da04807fe450\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"a78497d8e7eeb409\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"ca6906cf0aacdbc7\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cf025a1b9285fe3c\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"e0900ecf5fbe722b\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"f67fbd4816b505d9\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"5bf23e2efa214b88\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"c4759aec9ad33208\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"1d0bb920830babc1\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"e2d8f1b960ef3a4e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"5450d3cb628e7609\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"e4b7919dcf425b05\",\"/knowledge-medium/src/components/ui/button.js\":\"78139d95be8f9c10\",\"/knowledge-medium/src/components/ui/card.js\":\"b0915ca021f4c0a1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"9105e08e139bac66\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"7f3144b7fc74d35b\",\"/knowledge-medium/src/components/ui/command.js\":\"b19bac651fe0f6ed\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b61c9496f4386ccd\",\"/knowledge-medium/src/components/ui/dialog.js\":\"99a5675f86bc5b29\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c52d92bfe52cd606\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"39b24cc4b22cf095\",\"/knowledge-medium/src/components/ui/index.js\":\"bf465dc7b5eb8e23\",\"/knowledge-medium/src/components/ui/input.js\":\"8e99dbb14f41b617\",\"/knowledge-medium/src/components/ui/kbd.js\":\"226cca79b009fa0c\",\"/knowledge-medium/src/components/ui/label.js\":\"734c30d372248fe1\",\"/knowledge-medium/src/components/ui/textarea.js\":\"60bbb791c4711029\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f300ea9c0abb7bad\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"6d478675134471a0\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ba341868feae3695\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"db330835bcc5adc1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"54d646c78fa6fc47\",\"/knowledge-medium/src/components/util/error.js\":\"b5f7ec468789a2f8\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"64c551125b817f76\",\"/knowledge-medium/src/components/util/suspense.js\":\"5a9b66f0a591e677\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"6a572315a67a8491\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"150bc8153b8c1c27\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"44345eb62c457f78\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"a106ad539ccda855\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"d9dc7efedec48721\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e5aebbbaeaffd37d\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"a29d2e329722acc8\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"db43379dbea960ce\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"705b348a53712c32\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"913022f59103bcd5\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"f44c213ca73ba814\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"1262e60eb6b38586\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"82e6cac5f3c5e315\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"4bad8bbfd54c1e0c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"85ea9ffe3dce5f6a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c99820ae117a8f2a\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"c11b862a5cdbf46e\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"8794f3eade9b5df7\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"946f4351b19fa2aa\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"4459e7dbeb7bb495\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"3d4783b6c7b9b828\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"be5e78b708c0c835\",\"/knowledge-medium/src/context/block.js\":\"12319771bda92acd\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"10691103ffa873f0\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7402286da666c653\",\"/knowledge-medium/src/context/repo.js\":\"bd04c480441b3deb\",\"/knowledge-medium/src/data/aliasClaim.js\":\"08e5d859f5fc9263\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"db1a0cbe8923e412\",\"/knowledge-medium/src/data/api/blockData.js\":\"bf01e1c7d59f2b04\",\"/knowledge-medium/src/data/api/blockType.js\":\"27f983b18edb65ee\",\"/knowledge-medium/src/data/api/changeScope.js\":\"a958378c245de03d\",\"/knowledge-medium/src/data/api/codecs.js\":\"e4057c2cb27a841b\",\"/knowledge-medium/src/data/api/derivedData.js\":\"afcdc54899fc7f77\",\"/knowledge-medium/src/data/api/errors.js\":\"7c6e49c1466af7af\",\"/knowledge-medium/src/data/api/events.js\":\"d2c71609d35c7062\",\"/knowledge-medium/src/data/api/handle.js\":\"71cfa667873c07a4\",\"/knowledge-medium/src/data/api/index.js\":\"908cb05264f98e8f\",\"/knowledge-medium/src/data/api/mutator.js\":\"8d224cdfb4e8bf88\",\"/knowledge-medium/src/data/api/processor.js\":\"86d63bd9ebbda832\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"52e3e1f20ae72de5\",\"/knowledge-medium/src/data/api/query.js\":\"e1a5597d643e5b95\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"adf2b00d03c6dae9\",\"/knowledge-medium/src/data/api/schema.js\":\"71cfa667873c07a4\",\"/knowledge-medium/src/data/api/tx.js\":\"71cfa667873c07a4\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2336f676334b344c\",\"/knowledge-medium/src/data/api/user.js\":\"4be2280d66e7f68d\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"875bb6ba71fa0e56\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"53291deff78db7e6\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"ccce075694e258ca\",\"/knowledge-medium/src/data/block.js\":\"748c3951388fb9d9\",\"/knowledge-medium/src/data/blockCache.js\":\"eb35a47c538d4a78\",\"/knowledge-medium/src/data/blockId.js\":\"4fbeaa682eb0149f\",\"/knowledge-medium/src/data/blockLiveness.js\":\"da3040d2232df6b4\",\"/knowledge-medium/src/data/blockMerge.js\":\"2c7bedfdfbef3de0\",\"/knowledge-medium/src/data/blockSchema.js\":\"63cea289b56da1f6\",\"/knowledge-medium/src/data/blockTypes.js\":\"dca0a6c80afc26f2\",\"/knowledge-medium/src/data/clientContext.js\":\"180ea63dc92b6fc2\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"cc32472f51d5931e\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"0f9973e522b9da8f\",\"/knowledge-medium/src/data/derivedIds.js\":\"263a6dac5b12dab1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"1f2c2201ce1baf28\",\"/knowledge-medium/src/data/facetBridge.js\":\"99a94d58a3cb07f7\",\"/knowledge-medium/src/data/facets.js\":\"3584c59ef4cbefbf\",\"/knowledge-medium/src/data/globalState.js\":\"c42290177b4af553\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"f844c04a785e3806\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"4f1d31cf40941c76\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"86d97e6171f72416\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"11fca79215aed0b3\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"a88495ee50e25d12\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"f4fc0a601411f375\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"87ec82fc5da6e123\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"fadb221ae11aad3a\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"26a1b3f1f76eda63\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"92c69071d92744c0\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"046407ef15b7e6ae\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"00cc0aa5ba53b79a\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"b1da64fefcf43787\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"78f91382130756be\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"71fbc15389b24b1a\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"bac3b9f7f41266c5\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"c2b518255c89396d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"5542ed06fa0def37\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"cf3d8df917baa98c\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"8d1df5611e59c4ea\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"76fcd5974ca25cca\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"79f1a2b7d3f27740\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"fc8e11af64b67eb1\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"2b1c8ba8d8d14a9f\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"985de81f2010ef7c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"ada2f370cac6975e\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"592f93c179395989\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"a6df7a603b857036\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"0083220f6114b284\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"2142fc1addf5cd01\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"2f3828570ee55515\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"c95abb6512834e9f\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"984c8e6268086c31\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"7dcee829d9a61c81\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"743ac1136bc30788\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"ad4e8fa21b7eac85\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e151a23a247bee86\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"da6ddb0066b299f3\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"165694a64d41989e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"ed4c1d3e4a09c5c6\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"474061a89863addc\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"99c45da93b22dd45\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"65f37fe587179330\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"9d544bee7c61c344\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"166c8259e862a170\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"ba444259530eb514\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a99e986b482c4682\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"72e2e5513ce74f68\",\"/knowledge-medium/src/data/invalidation.js\":\"118fa75878661a1a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"83545f22cfeda12e\",\"/knowledge-medium/src/data/kernelPage.js\":\"0dc3ddd5ff7a8818\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"5ad6350760289820\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"36e21764a8b06d33\",\"/knowledge-medium/src/data/localDbStorage.js\":\"0f3f9b10ce07ad6c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"1d690c0d511ffdd7\",\"/knowledge-medium/src/data/localSchema.js\":\"e6467cebab7b15ea\",\"/knowledge-medium/src/data/maintenance.js\":\"3380263474bad4bd\",\"/knowledge-medium/src/data/mergeProperties.js\":\"9cba32daa9ddb33b\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"b45250071023cbda\",\"/knowledge-medium/src/data/migrationsPage.js\":\"a36f7e3b4d6e96a9\",\"/knowledge-medium/src/data/mutators.js\":\"6c906735e016dfda\",\"/knowledge-medium/src/data/orderKey.js\":\"44a1658c8b6cccb8\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"8a3efb9650a573cc\",\"/knowledge-medium/src/data/outlineSurface.js\":\"e62883f5b51d8c67\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"65dbc6762a36d2c6\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"a8a420e5124dc35d\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"c91d800f42199dcb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"4ac949088af50325\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"537f0136b7b13cf9\",\"/knowledge-medium/src/data/properties.js\":\"bc626bf819a176d1\",\"/knowledge-medium/src/data/propertiesPage.js\":\"558c913973a82de2\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c61190927b7bf2cd\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"641baf051e066000\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"e33cf2e47de823d4\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"3bf843fd3c2a0b71\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"87dd0e6cd6f91c95\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"2e0cbe0224e69c43\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a509c9f5eea107bb\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f51bc7d8801483b0\",\"/knowledge-medium/src/data/recentsPage.js\":\"ad2c10ddb5bf5692\",\"/knowledge-medium/src/data/referenceBlock.js\":\"5aaf4b953ef4121f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"644c480abab0c2e7\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"1b7a73e367bce8d6\",\"/knowledge-medium/src/data/repo.js\":\"2072f8888cf1d56b\",\"/knowledge-medium/src/data/repoProvider.js\":\"405f36415bdd3555\",\"/knowledge-medium/src/data/rowProperty.js\":\"3297a80620f36c5a\",\"/knowledge-medium/src/data/searchFilter.js\":\"6342697def9c27a0\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"444d0e6a6920364a\",\"/knowledge-medium/src/data/stateBlocks.js\":\"568a68940743cd34\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"0ff42707346e0c94\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"c35dc29703201c1b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"5b267bbd46e7a25a\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"79bd7ca18b02a499\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"e5e128700bc9c754\",\"/knowledge-medium/src/data/targets.js\":\"c52e7a650d3e27c7\",\"/knowledge-medium/src/data/typeColors.js\":\"cb97e7c93f19f664\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"3f078517617ef9f2\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"1e97cefbc44e5232\",\"/knowledge-medium/src/data/typeExtraction.js\":\"718d3d3c086dd4f0\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"6c56e8e12f4b58b6\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"d60e1a70d614ad82\",\"/knowledge-medium/src/data/typeSeeds.js\":\"16ab4a55dca16690\",\"/knowledge-medium/src/data/typeTagger.js\":\"fba3e701f4c6bdaf\",\"/knowledge-medium/src/data/typedRecords.js\":\"8b5a063fd960cf18\",\"/knowledge-medium/src/data/typesPage.js\":\"58414e78c363f7f5\",\"/knowledge-medium/src/data/userPrefs.js\":\"a6f69798ff02db4a\",\"/knowledge-medium/src/data/userSchemasService.js\":\"27094eda89a617d9\",\"/knowledge-medium/src/data/userTypesService.js\":\"2611254b2332ae24\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"354ec944703aa42b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"d8ebe2cce52921fe\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"632a9d2a9e166b45\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"017109fc88e2ed08\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"035669ff3cc09cb9\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"a970f9d1aeaac49f\",\"/knowledge-medium/src/data/workspaces.js\":\"2c83f2b6f0fa21e6\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"6aba63dfa86b7ef8\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"7871ae010dc188fa\",\"/knowledge-medium/src/editor/atTrigger.js\":\"ded44e6f9af9508c\",\"/knowledge-medium/src/editor/autocomplete.js\":\"69f606d013085b07\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"aa6cf803f4020be6\",\"/knowledge-medium/src/editor/contentFlush.js\":\"282057d3e519f902\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"3c208d5938a732e0\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"78da3a43165d1711\",\"/knowledge-medium/src/editor/insertImage.js\":\"10692ac2e29bba38\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8af4d4b3e1ce1063\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"f6941b0dc7d08f9d\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"2b86bd17bfa45a8b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1500a6437706e5e8\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"f970f9ad06541fc3\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"f46b398cf7a63261\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"60f922c7d1ddab0e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"b0bcee0da12fcbc8\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"fb11294c1a0444dc\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"f3c48bb0c8032993\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"4e15389a4ad42520\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"7a7d64a364a5829a\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"650f713a0b7cb8d7\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"95a4d1b53a4be12b\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"23035078db73483b\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"13d3d8769a24e1b3\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"483e665367232d9a\",\"/knowledge-medium/src/extensions/core.js\":\"b053931783ed554f\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"acc04fcb253df845\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d8ea31edcd9f49e2\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"caaf13e32a1d9ef8\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"9700f358715b3106\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"c0679efb5f8315d2\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"c3eadcb7ba26ee29\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"af066692a938b0ea\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"194831fcf4512677\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"9287fe8455bf450e\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"7b2173b1159162b0\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"05d2840f3b837893\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"e5a8f034a4c59977\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"7ac2117f299e6de2\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6fec77e266ed3b4d\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"3985631471e02096\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"0b3fbbcd9f752c7d\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"bddd86b3f3d7edf5\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"2c7fa5ff86e54f2b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"3df231130941e72a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"5cfe9a1cb0794c14\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d7a6d1e48041556a\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"de119fa12ea0831c\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"960440d4c2d1a63b\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"178f345bb362bac2\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"129ce0b5f96d6a0e\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"12f098421506bac7\",\"/knowledge-medium/src/facets/facet.js\":\"1aff7049f9d09d83\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"0f2bd2707e5b0b98\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"6b75567f4c87dfdc\",\"/knowledge-medium/src/facets/togglable.js\":\"c47c0779c2b28728\",\"/knowledge-medium/src/facets/variantFacet.js\":\"4f44980dab55c279\",\"/knowledge-medium/src/facets/verbFacet.js\":\"50942e4bd02b5f22\",\"/knowledge-medium/src/hooks/block.js\":\"e7f4d604ac71a953\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"d821ae717d3bba40\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"d6b80c3c4e9f1453\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"d491d719f3e797b1\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"da798c3525a1e8df\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"f2949da9ee1fbf74\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"355df07cf6f131f5\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e9a9b088eabf4f3a\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"6c6a8fdb1384c5fc\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"da43a4a7dca08d0f\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"e878828a9aff9099\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"fa0fb1480eca7a95\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"f300823bda92f4c6\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4b1db9f0ec7d1d7d\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"50bc628f66414496\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"39cc279a637f8105\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"e3fef432d186212c\",\"/knowledge-medium/src/lib/utils.js\":\"31e789b77a779855\",\"/knowledge-medium/src/main.js\":\"ca7e4f445966bcd0\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"926d26cfc91e48b1\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"7c303c41fcea8af4\",\"/knowledge-medium/src/markdown/context.js\":\"9b84dcd5c92ff707\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"92a425eeeced4fa3\",\"/knowledge-medium/src/markdown/extensions.js\":\"d08f8dd5426903d5\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"558731efdab332a5\",\"/knowledge-medium/src/minimal-editor.js\":\"ecd55e6a7717753d\",\"/knowledge-medium/src/paste/armedCut.js\":\"a7a01b87ca886840\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"2014d2932d68d128\",\"/knowledge-medium/src/paste/clipboard.js\":\"a49a93f82ab74bda\",\"/knowledge-medium/src/paste/decision.js\":\"d9147bcc71ac74c3\",\"/knowledge-medium/src/paste/operations.js\":\"274c9e65928a54ff\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"73ef26565402886f\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"5b1d5bf1c0f1e264\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e3f82fffd20f6529\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"5641245e5deea139\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d0587a681b0610de\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2b8e312752a8873b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"5557cdfa21e6ea4c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8a8faf95e8e0092b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"8d834d9fecac4ee8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e4de0ee5f754405a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4236ba9f52d3d694\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"361caaa765c6df0b\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"77ae08c7613dd9e1\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"ed4298de1604bc4d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"20f2645c867ea3ea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"62ec0d4d55968d90\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"bcf1566cfd850791\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4b5923215ffec166\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"af0823067c46d2fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"798b8dc9b061ac87\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"a39566c928753f15\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"8cfa6dcc847c056e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"732ce6541f10748b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"51db6f7add7c0de8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"02c896e5430f5859\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"55dcdf52fd79c19b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"45cc2a1c622b8492\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"93cb258b9eaca8f9\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"22901f0b72ff114d\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"2e6d66fa0ee31667\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"50ba04f3ff39ab50\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"7031797f8a00662f\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"b8dce8c6d98c2e6d\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"41adf1080d635473\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"bd56f52c85268531\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"97bcf1c330cffc27\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"702a33faeb3cf756\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"bb4de53683cafa33\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"ea2e2d1f9bb12e28\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"419b1e6f65029799\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"409730d3b84f97fc\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"74ba1c50f1fb67f0\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"0037c9d8d2df48b3\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"352e1bc0d248baac\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"492ff15b7979745a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"051336bf3aea058d\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"29ad2c8c59a1cdbe\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"8e0cfd9d9e1ea1b1\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"54f0ed968cb03845\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"63a97b49323a0e28\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e1d2c291b0d98ea1\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"947037f4c67a7b3e\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"07369b7e98767763\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"f72fece9a0461b3a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"ec1f1dcaabd7403a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"ec44d12bc7dfc767\",\"/knowledge-medium/src/plugins/alias/index.js\":\"9ddc18418b6a6c9d\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"81fd0c0fac586a5f\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"38aa34b1318b9c2d\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"c61d7b73baa6703a\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a6e3aa17e20f0051\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"2641e26e2516f8ef\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"70d70834ebf7a6df\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"41b58bf393a1b4e3\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"a1037c54e6b855a2\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"783f43df6742a201\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"6d83a73d654b8f95\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"e94b9ab014fbf774\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"1bc192649ad9c8a1\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7dc9d44686ac6e2a\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"4a878a1185c51547\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"a7e793680d40bb1a\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"31263d942a0b2afa\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"83b3bc47f36bf6a3\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a36f3f2a3d8987cb\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"6e27c3911f38f54b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"ecb1700694df287a\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"cc8831986f03b436\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"04495421e05b54e5\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"156edc89a338fe5b\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"46390d4fc9c1839e\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"308cb9591b69aafb\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"c8f5b4b3c7501fcc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"57d7ca9cbcf31674\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"3269fe37bf1b37cf\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"62ef4be476a8944d\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"292d65521535d489\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6bc230958ba0269d\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"365d75a478d3b56f\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d98b9e7c688cd6aa\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"390e110df803a6a1\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"293500062750a82c\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"c2210462ad0c4e1e\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"6e5f5c4000c38348\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2c68b4a6bdfd019a\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"ed6a106ff85c1eb5\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"395c4e4d79233344\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"7e0457bdfec8a012\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"79be0ced2b852ee1\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"80573b1e974c3629\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"15c07523ad8fe66d\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c64697e092cb54a6\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"1b6ece405c4d868f\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"4d062cb8284f8d2d\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"df9a8ff5192d692e\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"c14e8b44f650e1fe\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"16d58e78a61f7b8b\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"21e2892ec036b104\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"7d41bd2f05f4a756\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"aa413c5ec4e8ded5\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"378337215e24a062\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"523ea154ea60d67e\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"34dcad717603c8f0\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"67c3c90ab0afa525\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"8aaa69eb58d874e3\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"b2ac92489c6f6da2\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"f67944e1cc83a727\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"44b38568293bcb8c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"7c0d920f44aeafe9\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a07aec8e540be0a7\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"d269cc909265266f\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e9f3ed4872f0b98c\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"1af9cd7631abe490\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"004df9f3f8386218\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"d8f8cb2da1d26251\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3bbb55fa57b94fa3\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"bc541ee44375752e\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"8f99d29b19576652\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"3c63f4fa3b3e42d2\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"d1f789f089893ea5\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"ae1ea42ea74e5c51\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"3e97c1d8b7c3e737\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"0fafd897931bdf40\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1f71a04913fcac9d\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"8f1149b0be3748e0\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"a1c30bdcc92f3e79\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"f5198e6fb37e0a00\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"857ffc73181a3661\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b8ec0d5ef1c9a13e\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"5d7c3aa8ab3d033c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"5afba25a9ac2a342\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b3a65c193c7c48d6\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"0f8cf55b8a61ac74\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6cf04e4f060fa1e9\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"c45690f353afa2c0\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"b5814eaee4d2aff2\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5ee73cc2c586ccd8\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"445da763c53dbf28\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"340b415b412afd5f\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"4c92c9317038b847\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"6296b5052ab8c134\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"efa4e34ff69b993e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d084fe07f685d67d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"2df2976e622d7eba\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"33d947ec9f7a649c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ca4a29dca4a04690\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"1481a3770a6fe1b3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8040200cca3aeb18\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"c12356eaade52846\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"2d44364c57fed725\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"8b21a79b770dd8ef\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"ffbbede414ad2d4e\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"d80bd53553f533ec\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"5d0162a9cec6f8b4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"12e7ebe649236c1f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"7940e3c42ec5825f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"906847a52dd11ea6\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"f4ff3d53aea10043\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ee0eed49545d0359\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"4a43845690650ef8\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"d6b7b6378bc8382a\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"e129f3a78cf292c3\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"6c8d633af406028a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"2c11700a9242545f\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"0bf376d39618023d\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"f3b7049970acca20\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"139c147d5b7a4272\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"7d07878307a40a7e\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"31ed02f078407be3\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"0d223d514c635264\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c57109f6d3f93f53\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"07faed29e112ba65\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"feeb14d633cbe2c0\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"d4fb80c191e3a7ff\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"f58c7355e8d69df5\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"fe2827efd4f7995a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"82bb5ee64068c23a\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5a8651244db86f10\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d16d86aa358d30d2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9dae462687bc0fe1\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"237ec7bfd714959c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"883d9df0c72e96f0\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"41316274ff8c7e6b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"62e1e8d3599ab53b\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4945f0a1f195905b\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"7f0f28cb486b0f84\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d46b492983019801\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d19e1ddcafcdfaba\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3c3960b1309cee9b\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"fe096e9bc25fbb4d\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"af88ceace4ca469c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"590be7727028f211\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"75b9cf945b4fffb0\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"eaa3800663969478\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"6d21432b2f5f441b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"c6e70575d220b438\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"25de15e4e106cbb6\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6ce2d69f392bcdd0\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"a62f0e18d88b24c2\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"af875b750bea750e\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"4f3308cdb3b0e426\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"74c049efe4b61691\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"59f92d9758bcce86\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f1ea7375dcfeb610\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9fc09117f3b8e409\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"157103897237c048\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"24cda9d0e0e0243c\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"a23ac9230709955c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"73155d7d23f90779\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"1397c3c5c9eb25cc\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"c9294ea1a7b2c1a2\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"043aa5abc4743565\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"1fa64131a7b71d2f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"22b8f3ddcc9ace23\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8cac08c32245d5e7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"564f92cad1a35230\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"cda9f276ea07893b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f67b12a788c19a7b\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"6629c35b1ee0b276\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"f76f20c2ef8db59e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"26803bd28a87a431\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"3e11ab07d8749bae\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"d93b7f53f79a4fb4\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"4cf9d5d4541103f9\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"58737a97b8e78ec2\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2756ce4e4758e357\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"29d14a0913a0c0fd\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"431e0b5aec0c0552\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"499e40ce2f576cdd\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"2adbacfae6c5f68e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"c9978fa44ade60d2\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"60932e60e3c3ebdf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"7fa2a60a6d1f4e50\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"10fa4b5cd664fee8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a7a32ed01c57908d\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3efd0570a93a5946\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"5fe5843c29bf2ed7\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"3ec2100f2ed5897b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"5ed93f83df0c48a3\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2d57c96b8c6e2eb0\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"43351c9510eb8082\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"fa7447c623bdce74\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"fb9722fe9f6e791e\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"07959f0bf8ff3793\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"a4e25c4c0b06d4d1\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8ca4595be2953424\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"df3d80c587a0748a\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f60083b63af60b10\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"605b20c16e59e0e2\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"3c172e3a70da200a\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"c258eec43af164ea\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"ff05dfa0c7469df2\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"de158ac6fd779184\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"cb71527b5c95d876\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8cd524b7cfcbee1d\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"570cc500a9bda4ce\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"2a687c859dabaf14\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"d9302c32e3c5f2b3\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"1cc3f8c506654c87\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"d28e153a694fa0f3\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"0df9f08556ee0433\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"903c37737cc3df5b\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1ac0e0b0d7317b76\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"73854f17723c3daf\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b5ed95203c9ca3c2\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"a35ef60202285d5d\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"25c6f67461103555\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"b3b484a56136b736\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"1843fc2da933d3a0\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"b8d69cdd23773421\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"15ac04c2ec8ea89d\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"d74693b845edc14a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"99008e599afa6368\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"0e21279b728b0462\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"5c9061288cd9fb27\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4c21429f84ca9def\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"f64e6c9e9ee8095b\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"c46e80e103990ff4\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"e282f868910f1e8f\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"9b13838af976ff31\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"7662dad580e6edb1\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"b45ccdeabf67b9c0\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b1f464f54835a6c6\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9ee13cade988ac0c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"68c48e19a0011839\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"af09afc5d82acbf5\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"3db4171c8180f00c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"5bc8eacfc1dd9de2\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"e491a073338c684a\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bb7de21d18633c7f\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"41e974ca33e1e83c\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"3cedde81c992e657\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"500c4a75ee38f6b4\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"7e20aa0fc21d8e01\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"9676bcf1212dbd26\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"6fa4c2be8d4b5c64\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"264afdbb6476634d\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"7c78c7d8c568f271\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"6e48fad90ac31a2f\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"b3c00e3e3cb8fee3\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"46a2d8fb03b26146\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"c5891d2852bd66ea\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"c7bba99d44aafe2f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"d3955eb5502e3118\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"91dd46252ed39df3\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"110fb47e56d929b8\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"3976ff097af01e16\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"8762616a72526cbc\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"be53cf5fe0e895ec\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"b4b64df65ec68b95\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"87a7b006533b4d4f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"6bc0426f2d47005c\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"04b34f8113dc3bab\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"c6989d4efa65e94d\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"f89a490eb1e3a85c\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"d7c645321a44de51\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"4cfe9bee9b54ad80\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"2593998b225704d2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"fa29a62fed6674bc\",\"/knowledge-medium/src/plugins/geo/query.js\":\"54ed1e21ccb502e0\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"aa32f1c506dffc3c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"473fc584925c5d0e\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8b78a8d27980a7d2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b71c8540a1e479ed\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"4b4d0c7128b22ca3\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8b92dc4c6b6cfd49\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"56f50975cee736aa\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"7058804b28da5fdd\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"7ff1a269491a0b53\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bd9f665f3fc2bae0\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"2c65a5fe9191ba59\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"67f3b2a6bb8f87fe\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4a86f0d070522723\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"996307498be415b1\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"9895007b95aeb7bf\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"fd756c3d2b1161dc\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"dc17f17245c66ee2\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"fc2fa25921b157b9\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"41c933731928c0fc\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"dd8582ecc841daa9\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"54962800daddd841\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"7e52919ad0476b4e\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"015c46421256e6c9\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"7953a6fdcab34020\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"191b99dba406d676\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8e728929db383fa2\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"88d4942715ffa924\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"dd280e366a545138\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"b9e6090260ae28d7\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ddc18a42435b6be9\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"e9e5dbd2af876535\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"0fcccb64763997a1\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"60d79d9b9b3b4459\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7ec616eef98e2cf1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ae28db71febda900\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"59ebef5b5738cf5c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"fe91986f4d1a7bc9\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"6fd38497878ef4e5\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"84f598d0e6fab0f9\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"fbebcc0e03ed7f3c\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"7a5eb4a1ebe87dd4\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"64636f2e00ca7f5f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"606fb36c89e03fe6\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"4225d156a3ba922c\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"9b104551f87da51d\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b80cfc9de349b46e\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"bdf1d23abbdeaa4a\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"cde9dae82ff40271\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"514c06b928046253\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"0fabecbcdf159cec\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"f9ce97bb095ad7b9\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"54b58211c5d7d64d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d4bbbea4b2770a4d\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"fc483dd21b3c1222\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"7f66239650cbb664\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d4a28cf0deadc1ad\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9a75f1861a94df9d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"3cafea78387fd314\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"26e4d3b8c8a9549c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d72a222268efe21e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7176a39d6f8439de\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"da42f5ab5926bde1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e20db3d3d35fdca2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"2f0a1f32891fb612\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"05207f7411bdf524\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"51328f627ac2bc51\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"50141b2c9f8b1ce7\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"d79ab27acc4f7d06\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"dc404950d92b99d3\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d507fd0083d4a197\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"572bc0528953c467\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"ae96dda4ba953822\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"5be5864b33e3b92c\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"b4c60005f9e63cc6\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"88712fd49a384b4f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"1afde67495bd89cd\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"160eeb3355a09bd4\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"c81f14948e5e180e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"a29423112ab11ed7\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"64c543cd481c2c55\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a684d3ad44c68a67\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d1c3300cb31d1fb5\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"5437dd397d1e481d\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"7089ac1f780ebe6e\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"54b30d806459324f\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"66ee7699ee054452\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"7e3a9d129d68efa9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"3bef5f35bff49c14\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1bb0a706464a47e4\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d4401ef90b6db543\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"a75937fb277d8e10\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"ef3d837815fe698f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"d0c92af74839882b\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"ce6de5d3604ec24d\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9f6dfd26fdc79f6a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"4a4ebd870c0d070e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"1946e9244007f2e6\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"557acfaf2b4c8743\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"f458d38325b67ce6\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"d8898fded46b684a\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"3dec2ca0f1735ff8\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"26deda892d729e2e\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"051c4cc233416cf9\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"516ba7ebda194b8d\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"369f1afc83fcc2ab\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"cebbb93790ed1cdc\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"0ef3e8c530dc7ea4\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"e7bcdbeaa2e3bbb8\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"19655b3e2b0c0292\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"ab23b9554515dd3b\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"c860df0f727133c2\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d5560e3c0c723796\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"4d3fc74bebc201cb\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"8700da77d49d431a\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"01a9884a60abdcd3\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c931bfa6a83b1564\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"a3dbb9b51fa86305\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"11bca5bd2fd89a81\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"7cfc15f62ecd3737\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"f82166689eec6686\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"be079bb29f04b011\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"743d81376ace789c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"c8554d0c0799c876\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c9390ef5aa4a15e6\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"cbcf601530e5c968\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"3e0e315430b619a4\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0989395cfdb01064\",\"/knowledge-medium/src/plugins/references/index.js\":\"cd920d1644873118\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c3abfc3ffeed1c6a\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"38a1d204481482e0\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"8a51d39e3cfd240c\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"34b2fce5fdaa1cdb\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2bd3ff1c51216b26\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"dc64c0a85c419f94\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"163ad3e3766c3482\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5197680a63ad7f17\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e20bf2f8baf557ca\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"4bd70019bc9dabe2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ab138e17a90f69d6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7e0740c87a7b3bda\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"7a8b98ff09963e66\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"12e9efabbe94ad71\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"41e80ae35182f964\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"4031544c2b71c88e\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"a67acb7a2ae9f421\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f4cd739c8cffdb48\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"89d34d7c4557228b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"e2afcf8ac0ebb3f0\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"596687cc9ab34add\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5483f32f5c1e54ee\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"afe6de3ca479c472\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"dcea945dcc9e9f25\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"7a07bf6e9ae80c68\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"c32d7600fc6c4824\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"5c73279cd27fb323\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7c4dc15a947b87bd\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"213e8cdf8c682c87\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"f18a62a679bb779f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"2331f114dca7ee3e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"ecce214dc40892e7\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"34f922019867cd56\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b6e97928db690fca\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"abf5e3a79b3bfe80\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"bf0b26ac1c25a337\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"45800e2f22fa18a5\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"f3256aab741f71d4\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"09774d5a6a305ff0\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"8628b4330d43da3f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"1e19b40cca5252b2\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"a4a073b2711b46a3\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"42bb90af48416b1c\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"ef568ec409d491c7\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"776cc81a6571b8c0\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"ae29b9611a85625f\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8f34fc1c7780f9c6\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"4259645686e37732\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"ccb6994efcb52930\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"add5885d36b4b09b\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"4b29b8f836a6bfd0\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0d92679ea2b61734\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"c59e2a5abde5259d\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"ffc77899af888f56\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8ee13a4186ab4e5e\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"12cfaf11b54204fc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"14cc4a0f922e3a4d\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"1a22de39086f0565\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"2797d409d15b554f\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0d58d768684c23a8\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"dffcd345ba20e0db\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"5e1f653be10b06e5\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"3f50a7779b73007f\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"9f9149a4cae23a3b\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2a95502b1a963c53\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"94227995dec35ee5\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"9e9418d50d70c257\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2a42bf94dd7d2033\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"849ca2d6fa86c651\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2143535304fe693e\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f334db0e5860e8e9\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"b144a5b8e53a3621\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"2bcea8f08fa8fbf1\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"99c0f074d4167d0c\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"5f80be95da5cc3d7\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"3a6f2098f1009f3e\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"f235b952d48a63d4\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"313f2d35e1d96051\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0055f422dd84daf5\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"a59cb18c9c9c807f\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"3a703e0abfb106e7\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"0ee4b2582c624c90\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"8bda599b8769234f\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"baa82379acd7a635\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"7e4fe200c8b1af31\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e4b4801dd6073b6b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"98c8001e028a9ac1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"4beeb67f8b40b292\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"e61db3db7e9b1848\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"611100230a095185\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"743a732843e47697\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"7981871d92811111\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"07f39671bf38619f\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"92dbbef0a1a73000\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"70e70ce063301814\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"00cbba457990acb6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"43d30a0e5b898fc2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d892043d2a630bfa\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"cca7caeeca5c4f99\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"3d8ce8f5a8632063\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4e2274554766b8e1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"61d0e5404a6376b1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cef34a8e0e9d99ed\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"7593b8d323de6edd\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"3ae5e87010ff0f20\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"05529acdca44ba43\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"38c8ecd7edfb7dc8\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9b352988a741a9ef\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"41a47ee35d33c357\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"ae38a1bed586a0be\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"cc72916de99c6aca\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"cbcf80e88d0c90d4\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"d2bdaf0cf067bf19\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7176a2ab85c01682\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"ca224f236eee26de\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"2e17c96825cab3b6\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"ed75dbdcec641c6c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"22dffc5239dca8dd\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"4d84c4e22ab2a3ac\",\"/knowledge-medium/src/plugins/todo/index.js\":\"cd91219c81898081\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"298e4d15c4baa0e8\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0ac416496f1763e6\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"399a3bc821d773f4\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"f62fbff8bca83684\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"31a0b180bb942619\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"7295f653e455ac50\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"422ebd1243c37460\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"4685a134b1c27e1d\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"a0151954e08e96f5\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"34791823779a0a5f\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"be638f60a34f9bea\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"c3634bebfbd0b21f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"de41f1b59436d0a4\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"23a590593c550481\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"0495f39d20c4f2a0\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"417d519d31fd41ef\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"2cc4f3e2b3839be1\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"346d76c7ebd5ab94\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"0e347858b3144800\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"9354ed839eaecc3a\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"a6e6d6eb5cec545a\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"a4d252ee106851ae\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"9909588959d4e925\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"b759ab2a7de5dd02\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"a95e5b082504ed30\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d82462064cf7b5df\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"c4a66a78e4d11a4f\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"41ddf67a0d718ce3\",\"/knowledge-medium/src/registerServiceWorker.js\":\"e89d05ad03379d38\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"aa4ac082e67592a7\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"e0b1aa9d2b24983e\",\"/knowledge-medium/src/services/authStorage.js\":\"56c2b01ff2df0a05\",\"/knowledge-medium/src/services/powersync.js\":\"df56704da63cf9be\",\"/knowledge-medium/src/services/supabase.js\":\"b693798542fcbe88\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"89cd4aaa45748582\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"35f0bd93c51335db\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a9b47b8a4ba929d2\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"7aeb8b203c94f9bd\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"9d744f138e8fd2ab\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"c75ee7ac14545584\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"0425c257c1091126\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"c73adea678756199\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"1202c9ed65587955\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3676281b432c3532\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"d9ca3126fd3d6dbd\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"479c5cb2b37d12a0\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"bc1d84fc74d4c72c\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"4aed8dced61a0ff4\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"f3117ca5ccc069e5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"af9cafd41b188e25\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"2a9f91102b2e21fe\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d51a6c7ed7500edc\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"8b1e832df33d9b6f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"2f9188b1bef09422\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"75165080921cf19b\",\"/knowledge-medium/src/shortcuts/types.js\":\"766864d152b5ceb7\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"d0580744c37a0868\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"ca202da8974f9e4e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"e801b8c94bf569bf\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"f5d6170f33795e00\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"60f63642c30b0067\",\"/knowledge-medium/src/sync/byteTransform.js\":\"7a51a98bf17f36dc\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"57c2eca701dc1075\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"b72a567addacaff8\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"0480f5f1c1444a59\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"6a4110425085aee0\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"d6feeda29fff53b1\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d186107f4a047268\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"2c497e1b1a0a28b2\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"5120b6693dbfc156\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"96e9456d0f01972f\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"36a62a87c8b3b0d0\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"d62683557d5543ee\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"a5f007dd891386dd\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"dca629ca8c09e781\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"27c632591650228d\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"4a9a625d1c86aa14\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"a65b156e5a37b0c2\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d6db41cfede55ab2\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"44f4cc1544340060\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"ba19316205969417\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"fb6080f7d0e426fa\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"692f96de68f34d5e\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"576be258f183258f\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"1cf7b3d1ef063111\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9c305cdbc6ac3f2f\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"fecba809c346a2aa\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6cdf90cc492c6ce4\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"aeccc01191064304\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"372a9a725280f1b5\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"98319321d98ba710\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"d316ed890e2b520d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b4bee2da39a4db2c\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"b835f59e3e116d1a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"fe788b151ffe4573\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"06e051e5d9bfb616\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c8fd7b971af05637\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"b6832b98ec9fbbf7\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"72d0d11f30b827a3\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"7b5afa4b67c07eac\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f9c7d6e6a9956bc8\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"00210eadd1099b87\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"75327003bce635dd\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"6e255b0eb0b2fa9e\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"4edd83a8d0551667\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"862ae5904e509599\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"46ac9799f10a22a0\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"2786993c2cc89989\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"ef1677f8f0b16afa\",\"/knowledge-medium/src/sync/transform.js\":\"3a8beb1510ecb344\",\"/knowledge-medium/src/themeBootDefaults.js\":\"904386d9df941f46\",\"/knowledge-medium/src/types.js\":\"3944a6f4e9032d90\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"2c705175747b6133\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"8ae924f89e5c7566\",\"/knowledge-medium/src/utils/array.js\":\"603c6ba73c289d30\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"f8acf56394c4b5e7\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"e9b8534fbe24fcfa\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"298a10839aa8b3f7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"589259284bca44ba\",\"/knowledge-medium/src/utils/callbackSet.js\":\"624c622ec26785bf\",\"/knowledge-medium/src/utils/clientId.js\":\"434d79a03335fb6e\",\"/knowledge-medium/src/utils/codemirror.js\":\"ffbf2b6369b09f3d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7d981879dfaa382c\",\"/knowledge-medium/src/utils/copy.js\":\"e7d237e59ea9dc7b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"304fb795ddb38bba\",\"/knowledge-medium/src/utils/dbForensics.js\":\"30e7c5fedbc26a71\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"7e52c46d310ef848\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"3770b9d415b858e1\",\"/knowledge-medium/src/utils/dialogs.js\":\"d0d5ecd64df349eb\",\"/knowledge-medium/src/utils/dom.js\":\"642f9305a5226ca8\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"dbb56423ce0fef2d\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"e33e40925285c51a\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"3584d3f2c653693a\",\"/knowledge-medium/src/utils/flipSlide.js\":\"6ad2327bb667b2ee\",\"/knowledge-medium/src/utils/fnv1a.js\":\"84edcea7088af916\",\"/knowledge-medium/src/utils/formatBytes.js\":\"b25d5662c9fb9e22\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"401c01df6d8cda2e\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4099f881bae32a4a\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"a8209d5d16304f7f\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"1fd422add4cac0ea\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"425c59a4c999069c\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"d918babd0275c331\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"9cc939e8a34be05c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"7bef85bf6cd156df\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"4486d64508b503f9\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e727e3ac8e0f8d1a\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"b754fd36e91077bc\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"47ad9b1f0df5fc80\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"54ed06cfd3282c67\",\"/knowledge-medium/src/utils/markdownParser.js\":\"83b368ef05a31aed\",\"/knowledge-medium/src/utils/memoize.js\":\"450eb85a63f9753b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"cce56e73abc93f9f\",\"/knowledge-medium/src/utils/nameList.js\":\"afb58cc332500d36\",\"/knowledge-medium/src/utils/navigation.js\":\"3797dc6330bef29c\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"2a94515651be0a9b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"d7ab7eba1d7e61d7\",\"/knowledge-medium/src/utils/panelClearance.js\":\"89916bb4e111dc62\",\"/knowledge-medium/src/utils/panelHistory.js\":\"18f59fb3349d1a50\",\"/knowledge-medium/src/utils/panelLanes.js\":\"50a77631185a3e8e\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"0c2ffa7b3206867f\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"63a2dd1035a8b00b\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"36a63ed27bb2b890\",\"/knowledge-medium/src/utils/platform.js\":\"97c7ad9c53dba47e\",\"/knowledge-medium/src/utils/pluralize.js\":\"93d54814966079ab\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"a5566e701cdf31af\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"bd279e3a1c24862e\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"bbd9902547a44594\",\"/knowledge-medium/src/utils/react.js\":\"07b2abbb7ee6d115\",\"/knowledge-medium/src/utils/relativeDate.js\":\"db3b8c4866aaf8c2\",\"/knowledge-medium/src/utils/relativeTime.js\":\"2d67962a995672aa\",\"/knowledge-medium/src/utils/renderScope.js\":\"7fc6afd3f30f59a3\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"456a94fac38168a7\",\"/knowledge-medium/src/utils/routing.js\":\"d633e38f290b9662\",\"/knowledge-medium/src/utils/safeMode.js\":\"98b09447f12348aa\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"967ea0d54ddf6631\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"e402be574fc2b931\",\"/knowledge-medium/src/utils/selection.js\":\"5a1e999205970a83\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"7cc58e95114b1cda\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"89c2feaace9e9ca8\",\"/knowledge-medium/src/utils/state.js\":\"f995a40613ca4818\",\"/knowledge-medium/src/utils/string.js\":\"4b572bf75f205594\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"0bc1e745620ebb27\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f705c600772a8184\",\"/knowledge-medium/src/utils/toast.js\":\"9f91855747ad07a9\",\"/knowledge-medium/src/utils/toggleStore.js\":\"263ddd9006c42de3\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"ec4cc97c6fb6cca9\",\"/knowledge-medium/src/utils/userActivity.js\":\"a8ebffdb72356529\",\"/knowledge-medium/src/utils/viewTransition.js\":\"75c17a2b7630b467\",\"/knowledge-medium/src/utils/viewport.js\":\"9d32dd46267ff561\",\"/knowledge-medium/src/utils/webLock.js\":\"53c94cf5a34077c2\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"abb3f4ff3882eda3\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"8b3baed95af0cfca\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"8c81c5e8c777464a\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"6f18f36cc64977af\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"4a26adf52fe520b0\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"47f701fe0f8f2cb0\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e1abe62176f68f22\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"82fc47230f890f80\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"b343d0d9e8b91137\",\"/knowledge-medium/src/vendor/react-dom.js\":\"2b8b485055361b5a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"3b4c37f9b0fdd635\",\"/knowledge-medium/src/vendor/react.js\":\"1c4c1ffc1ece2185\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
