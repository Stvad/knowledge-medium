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
		buildId: "a482c9d65add-27af2db2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"5739f5a0447ff1e2\",\"/knowledge-medium/index.html\":\"5739f5a0447ff1e2\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CUWXVka6.js\":\"257ca48c221f1b4d\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c818159e4fb98bc4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CEoSrrlo.js\":\"c2ff7c638bf09364\",\"/knowledge-medium/chunks/FacadeVFS-CX9-aPCX.js\":\"cec5b8aad11e167c\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DLTEKvE5.js\":\"5086310f852b8b01\",\"/knowledge-medium/chunks/MemoryVFS-BmzluQdb.js\":\"8bc6f892ae0037a4\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BlMvwG82.js\":\"8de6fa87330d3d6f\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-B6zz6g5O.js\":\"09235e04e28d6ce9\",\"/knowledge-medium/chunks/Preview-Bro49PNQ.js\":\"fead40eb58899e45\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-rE3IuZSf.js\":\"fbd2551168283c17\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DwHkV0kN.js\":\"d7d75f50bf6140ee\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BDZy_fuz.js\":\"a1824daa42c828de\",\"/knowledge-medium/chunks/react-Bd8bVOQs.js\":\"337e6bcf04670bff\",\"/knowledge-medium/chunks/react-BzmJ6fzA.js\":\"5d2d7f73da16a207\",\"/knowledge-medium/chunks/react-C_uSnTtO.js\":\"26c2e66df120844b\",\"/knowledge-medium/chunks/react-CrDqyL4F.js\":\"ae80c4af99dd5642\",\"/knowledge-medium/chunks/react-CvFNP1yw.js\":\"088aae8af91b2b2b\",\"/knowledge-medium/chunks/react-DGB8u7A8.js\":\"c29a5be6e1c17e0b\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-3Lpuyj5Y.js\":\"26033d16b726edc1\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CwSriWD8.js\":\"fc16807e426ac4d7\",\"/knowledge-medium/chunks/react-dom-server.edge.production-ClGyPAnq.js\":\"b3d7fe9dc9be5461\",\"/knowledge-medium/chunks/react-tqztCcNf.js\":\"5b8de104b1f0b3d7\",\"/knowledge-medium/chunks/server.browser-H8_Vg-E6.js\":\"300a095360414cd7\",\"/knowledge-medium/chunks/textarea-CgVwJd5l.js\":\"f713025ba441af7f\",\"/knowledge-medium/chunks/ui-D4WMHsKI.js\":\"63ebc3864bcaee4d\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"37b9f1e05b0f7ce1\",\"/knowledge-medium/src/appUpdate.js\":\"da21bdff57c57afd\",\"/knowledge-medium/src/appVersion.js\":\"e66a8ac485cd6113\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"1db07535eb311771\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"755210a407432d37\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"fe1b864d5ce499c2\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"fe2f69d13c3bc384\",\"/knowledge-medium/src/components/BlockComponent.js\":\"fa5435f11638b046\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"588517cc4e0b7dbf\",\"/knowledge-medium/src/components/BlockEditor.js\":\"5ae7d6f8780b363d\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"c363e4018fab771c\",\"/knowledge-medium/src/components/BlockProperties.js\":\"c2b65046417692dd\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"95903949e877d08d\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"a6cb9ce802d676da\",\"/knowledge-medium/src/components/DividerHandle.js\":\"07d1aaeec9d06f0b\",\"/knowledge-medium/src/components/DraftEditor.js\":\"3560e81a75cc6a03\",\"/knowledge-medium/src/components/GutterPill.js\":\"f9f92a60f883e629\",\"/knowledge-medium/src/components/Header.js\":\"beea967f557a0ac6\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"1a48902d35132da3\",\"/knowledge-medium/src/components/Login.js\":\"e5d22f24522f111d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ce0e9c7e49cb785f\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"edc9e3916f938fc2\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fc6a6269267e8f30\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"64d5ade76e6aa143\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"35ea423d944d1296\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"0c7c563c3ce7dd52\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d9f2f1990ea904d7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"aaf453c444274171\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"00663379ea1b1196\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"2690e513e3e571c5\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"aca9103a7775685a\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"64a54f80917d77a8\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"c0ebc7b1e1f6d04a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"92aa9bcc54ee3eec\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"36bcf2aa5843ffe9\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"a88140954bf51bc0\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"8a842f6da7e334b8\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"9802a494fe59eb0c\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"3bb1283d5f479ac9\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a8b9c8c0273fab1d\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"1d244b746c8f8ec5\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"0a92456c053a7981\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e693b4f7b89ba8f7\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f200d7a98c4331bb\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"ee1854487912e89c\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"fdf996eca626ee4d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"c97b439ae838842f\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"8c7da3d05d138212\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"7153731d1fb993c7\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"331bafc80a3a7a5a\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"1a3f4c6f2c2005fd\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"4bc51fa5a28b3d6d\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"41ccc33737ae02a7\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"882c0bd74591bc2d\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"d3a0fb5d04ed4147\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"a69436389d955a5d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"45b7f17f85afd5af\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"66ba19b6aa2af998\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"945948568d4e19f1\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ac954858c7956e76\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"de25cc5946be1381\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b613271fc33b7118\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"2646f5eef020e370\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c996358a70db4d30\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"51948110c6761cdb\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"b81b03174d0cf3d5\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"fa785ea01a48fac3\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f72550bdf3eef283\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"bc6a3a7b8ec1abc7\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"83cf917c68f0aa78\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"1bda4c827d63fdfc\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"3a99100d46ce4ddc\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"5d49a1e3fe9dd6b5\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"85841d7d0ff04803\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"428fbf80f07c3a28\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"afe8c88fcbd4e208\",\"/knowledge-medium/src/components/ui/button.js\":\"8ea801c5dee05420\",\"/knowledge-medium/src/components/ui/card.js\":\"4d721d9ce5357379\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"914be3465593703a\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4a2557117d86e424\",\"/knowledge-medium/src/components/ui/command.js\":\"db8611c724d41d19\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"0ce46f5cc8024da0\",\"/knowledge-medium/src/components/ui/dialog.js\":\"9aa5818de56c648c\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"d3e01d38c01d268f\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"a5aecb781378d32d\",\"/knowledge-medium/src/components/ui/index.js\":\"d70f4bb43d7e4589\",\"/knowledge-medium/src/components/ui/input.js\":\"35138441bf197026\",\"/knowledge-medium/src/components/ui/kbd.js\":\"db5e19aa884c0a84\",\"/knowledge-medium/src/components/ui/label.js\":\"b553cbd362bb4e55\",\"/knowledge-medium/src/components/ui/textarea.js\":\"8dc9830a36d90142\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"d20fd1b0701cf808\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f913cd4a5715634f\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"985686dd5c7aaea9\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"d352753a101340c3\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"19a4e912c4e16e5d\",\"/knowledge-medium/src/components/util/error.js\":\"a0e57737d7b4e842\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"00548a78b93cdf02\",\"/knowledge-medium/src/components/util/suspense.js\":\"57c425a886f10cc0\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"be9c637aeb8f0b8b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"47fa5806faa724fd\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"38408bbf7d99fab8\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"865e558868928e42\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"769aebbcbf4bae53\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"934d9f9d0b258870\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f8a9e264c118793c\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"5551f694b0667f21\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7073df8141fce733\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"8cc5e1c2b8c7c604\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"cd728196fe425c85\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"27a993eafdcf166e\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"18d1c6017d43ffb9\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"d50e861c18459add\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"5a4be5c751f387f8\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"89f3a3d652a326eb\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"30da8b095f3207fd\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"cc8a9ba56f8437fe\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"d185ce396f2369dd\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"e27ad081152bee45\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"db6cbd09e8bb2c52\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"44b9b62f31c2d7b6\",\"/knowledge-medium/src/context/block.js\":\"c5822839a95751f7\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"64eb90f1068c370c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7386c392a430dfaf\",\"/knowledge-medium/src/context/repo.js\":\"dc4d1a29dc146a03\",\"/knowledge-medium/src/data/aliasClaim.js\":\"9f70e926ef938fde\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"38e5eff534bbc06c\",\"/knowledge-medium/src/data/api/blockData.js\":\"62339dcf1dd729c4\",\"/knowledge-medium/src/data/api/blockType.js\":\"741cbb7a2ae8216c\",\"/knowledge-medium/src/data/api/changeScope.js\":\"9ec04e7eef3eac11\",\"/knowledge-medium/src/data/api/codecs.js\":\"40e20f75c1a44d0c\",\"/knowledge-medium/src/data/api/derivedData.js\":\"9566d92952ef22bb\",\"/knowledge-medium/src/data/api/errors.js\":\"d6c251b7a480e3a6\",\"/knowledge-medium/src/data/api/events.js\":\"042c605ba0456b41\",\"/knowledge-medium/src/data/api/handle.js\":\"165cecd662795244\",\"/knowledge-medium/src/data/api/index.js\":\"a8cf7b4d6912f01b\",\"/knowledge-medium/src/data/api/mutator.js\":\"ae71902d76a9d731\",\"/knowledge-medium/src/data/api/processor.js\":\"f422b3e56997b025\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"6ff9d10c2fe323cc\",\"/knowledge-medium/src/data/api/query.js\":\"65c51c0b1e0f2a6f\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"511fad3054784b29\",\"/knowledge-medium/src/data/api/schema.js\":\"165cecd662795244\",\"/knowledge-medium/src/data/api/tx.js\":\"165cecd662795244\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"10a81504b3bc49d4\",\"/knowledge-medium/src/data/api/user.js\":\"2012f45cdaa8003e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"cca190519d1219ae\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"623607b618d31ffe\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"3213419d15078f94\",\"/knowledge-medium/src/data/block.js\":\"7f3f05945bbc5bf1\",\"/knowledge-medium/src/data/blockCache.js\":\"a660dce1fc8fd743\",\"/knowledge-medium/src/data/blockId.js\":\"e0645cd2d15baf08\",\"/knowledge-medium/src/data/blockLiveness.js\":\"4e1744db109ef5ca\",\"/knowledge-medium/src/data/blockMerge.js\":\"5ccd7ae956a4c9cd\",\"/knowledge-medium/src/data/blockSchema.js\":\"522456786a3cbf8f\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"749417bc40538c25\",\"/knowledge-medium/src/data/blockTypes.js\":\"ee64730f1b7674a8\",\"/knowledge-medium/src/data/clientContext.js\":\"3b0c7a380254c471\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ca5eb818eb95b9bf\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"10b6c2319b747198\",\"/knowledge-medium/src/data/derivedIds.js\":\"82053d5d173f0adb\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"f9709d7ade4cdeaa\",\"/knowledge-medium/src/data/facetBridge.js\":\"5be52b7dd263a2f0\",\"/knowledge-medium/src/data/facets.js\":\"f45c4b045f1ce792\",\"/knowledge-medium/src/data/globalState.js\":\"f891c9f62df15679\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"3e798772381a1cf0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8e1f0b821c36558b\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"d4157d7b272fd3af\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"21b8646a71125ff4\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"5107cea55d78d4c1\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"596a35404f55a43b\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"4d94dda93d0c8c45\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"eafb1e70cad0f81b\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"3359bb09c9c92739\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"1570c84fb2a32914\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e00efc8c25f4c947\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"c6a0f8db4aa20a31\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"80163fbc841e595e\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"bde14c31c9c8694a\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"3ee7a48f9bdab9d4\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"4cf9cd860f22e47e\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"cd49b2e9ae4bf95d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"d17ea9d5ade49a1b\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"0a7bd3769dde3c93\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"648c7472c588bb38\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"8f705e413838c916\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"848a73fdf974786e\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"183e16a8613115a3\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"1c76e9feae9babc1\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"16b1c5f4e15d08c2\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c56b1adf6d03c55c\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"2aadc570565742a1\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"1b1cb5f823c8b28d\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"b75bd6b0b0ed0ebd\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"3f4a1a409857dd08\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5b6851a4373691b2\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8d3c521baed41440\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"5c07e188aa65a1c2\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"fc2cdb8d04301b33\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"070ba2e76ff20887\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"b3e3b8f1eca5a1ca\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5636f7ba07df1089\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"c93803c0dc777c11\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"a1c2a36d9aa12d73\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"57edddb0e89798bf\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"c855e97f0e2d0269\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"70327f4dfe044f5b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"73feef272d65fb37\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"eb3198661471b7c6\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"394e41f4e5a51726\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"aecd1994eb0993df\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"74b94e02a0879df4\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"e5ccceb8ae69db18\",\"/knowledge-medium/src/data/invalidation.js\":\"884166a34299e59e\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"952737c8ff517e7e\",\"/knowledge-medium/src/data/kernelPage.js\":\"22f13906dfc82b2a\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"02aae8c0252e5e15\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"aabd3348c57bc3a3\",\"/knowledge-medium/src/data/localDbStorage.js\":\"9356c466c64b2e5c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"04d06e6f21cecf20\",\"/knowledge-medium/src/data/localSchema.js\":\"b3279979ec5d100a\",\"/knowledge-medium/src/data/maintenance.js\":\"6acc9b802ee18153\",\"/knowledge-medium/src/data/mergeProperties.js\":\"2aad6fe75f14217f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"aaadb21234227b6c\",\"/knowledge-medium/src/data/migrationsPage.js\":\"a4f4ad05262d5d12\",\"/knowledge-medium/src/data/mutators.js\":\"7c4a61fb4f2baeaa\",\"/knowledge-medium/src/data/orderKey.js\":\"6e7947bbea594438\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"a0359fdbd7f2f471\",\"/knowledge-medium/src/data/outlineSurface.js\":\"5f7b83cc8bd4057b\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"29d304cc5c705b41\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"ed291a4b21b9b5c5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"5a5e7540ddbd5919\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"6f191da39c86f470\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"3dd7f232c60c1896\",\"/knowledge-medium/src/data/properties.js\":\"30e60fc69a01634e\",\"/knowledge-medium/src/data/propertiesPage.js\":\"ccafd002d33f3f5a\",\"/knowledge-medium/src/data/propertyChildren.js\":\"1f629418cb45dd50\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"362165bf77c02ee3\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"08cda7050917c53d\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"6a6bb93fdaa30fd5\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"1086fb9ba1771640\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"1cd0a2c86d12d699\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"023a260febb83b40\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f26d6c332ebfb058\",\"/knowledge-medium/src/data/recentsPage.js\":\"2601655c4d78a2a5\",\"/knowledge-medium/src/data/referenceBlock.js\":\"ef11cae3cd627f05\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"bb672e89f103267e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"a17f1ca5197bf744\",\"/knowledge-medium/src/data/repo.js\":\"7ace59c8409c3e4b\",\"/knowledge-medium/src/data/repoProvider.js\":\"da1bc7f472e6a878\",\"/knowledge-medium/src/data/rowProperty.js\":\"373b6cb0a7a54547\",\"/knowledge-medium/src/data/searchFilter.js\":\"ccac649cad8f242a\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"6e8f51fbc3485f1d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"c5c04ab110294e0f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"d1b8045a12c8175f\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"e3844c4508673ea3\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"ddf2f3f12bd348fa\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"be8ffd7c29f006fa\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"b075a920d0ab4d1c\",\"/knowledge-medium/src/data/targets.js\":\"5e2f8102896d437b\",\"/knowledge-medium/src/data/typeColors.js\":\"003963aa6b589f54\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"9d922ce8f0a00ec9\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"73506dbbbfc16594\",\"/knowledge-medium/src/data/typeExtraction.js\":\"28ff7d8318e94240\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"2fa57907cb0971e3\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"28dcf7f07e458749\",\"/knowledge-medium/src/data/typeSeeds.js\":\"53600c437009ee6c\",\"/knowledge-medium/src/data/typeTagger.js\":\"8909bb8d41fdf468\",\"/knowledge-medium/src/data/typedRecords.js\":\"4b6c5f7a5a880b47\",\"/knowledge-medium/src/data/typesPage.js\":\"2334d34b2a24e6a6\",\"/knowledge-medium/src/data/userPrefs.js\":\"6392d57aab65b985\",\"/knowledge-medium/src/data/userSchemasService.js\":\"994651de95ec93aa\",\"/knowledge-medium/src/data/userTypesService.js\":\"6b71c07748ccbc8d\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6621ca8518356287\",\"/knowledge-medium/src/data/visibleChildren.js\":\"d23d1dbb85fec800\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"808039166317f00f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"5f32ce0424b68fa0\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b5b0fd1056b0ad61\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"67223fec251cb33d\",\"/knowledge-medium/src/data/workspaces.js\":\"0b3ca85ec229dd19\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"63aa80e52352aeed\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"8a40c178d71a4962\",\"/knowledge-medium/src/editor/atTrigger.js\":\"7d7a80001ba43fde\",\"/knowledge-medium/src/editor/autocomplete.js\":\"3e5136122c9b6108\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"b73c6a57bfe1b3b1\",\"/knowledge-medium/src/editor/contentFlush.js\":\"76a5991a974d83af\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"5b606ae82722bdf6\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"87a08c038930d21a\",\"/knowledge-medium/src/editor/insertImage.js\":\"23f40553d8a89b55\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"597c01eb33ff3f01\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"142955d0b4f2afef\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"e0d085ce9891043b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"fa859ed702001818\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"85ca757a75e1a32e\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"effd24f9fe47391f\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"c22cf382f44fffdc\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"84f37187a9c488c3\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"e0f89971379ed26c\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"b46dbae8d292add0\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"13745dc8b312c5c6\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"2bf9b7146af2c797\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"1625d2bfcc9685a9\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"354a3230e1f86f96\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"f015c7025ecd7eef\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"40fd2d83d9b1fb8b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"e753ad7eb3420658\",\"/knowledge-medium/src/extensions/core.js\":\"989b7a144aeb4898\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c0ba29b0b4594cec\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"9158b9afb20494c4\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"17bb0c1c0ebc72f0\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"bb172f21310937c3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"c7d14e5b880bf0a8\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"0389bda7b7d55625\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"0cd1932fe1595b04\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"b1ad3ec7c0d723cd\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"6a7c63b481bc6583\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"996958f4ff3f9038\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"2f983306cc574d75\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"fcd5d2e0a37c13f7\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"13eefd315bbde669\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6fa4bc0ad45b5fbe\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"f7b469225862d5a0\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"52818b4afd04d66c\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"7734b5460e7a3116\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"d6a33d723989778b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"43dfa8dbddf3377a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"61762518defd9f1b\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d0631a3734e31d3c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"fb3605b36a8e1eca\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"10c2a23c42f3541f\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"9b2b8c987e9f6fc5\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"de5480e20e2f36f0\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"4183e117f0688c39\",\"/knowledge-medium/src/facets/facet.js\":\"1c309405cb643480\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"98eef6986bf6d92d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"864b358c0e594ce3\",\"/knowledge-medium/src/facets/togglable.js\":\"ec5059be76252ab8\",\"/knowledge-medium/src/facets/variantFacet.js\":\"d517ed6db0d8f27b\",\"/knowledge-medium/src/facets/verbFacet.js\":\"c2783cad617517d4\",\"/knowledge-medium/src/hooks/block.js\":\"a20c25efe5d63e51\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"6e2504c60c6b2ec6\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"981574fb7a85df15\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"b2631a89aa6e5ce2\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"5ec93f0eacdbb7fb\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"efce69b2ddf9a8b7\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"af7ad37f9606d32d\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"5d8e460c1ab1a491\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"183947840e33a00f\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"1b8b42e67cb0a825\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"c9fa99627c453f5f\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"291148198d7b5bd0\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"b3671d45ab5e6ee8\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"82cee3960bc9500d\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e2d184dba9c681b8\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"fa958bb7ae62d5f4\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"f88e7e02c5768269\",\"/knowledge-medium/src/lib/utils.js\":\"60c04fa77432161c\",\"/knowledge-medium/src/main.js\":\"d1f47a351ab97cfb\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"398e43a70c293b00\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"f6a74ac21d1c2350\",\"/knowledge-medium/src/markdown/context.js\":\"c7636a047a6327dc\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"169113d7f61e088d\",\"/knowledge-medium/src/markdown/extensions.js\":\"236e7adaa9355a10\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"665c746e814ee845\",\"/knowledge-medium/src/minimal-editor.js\":\"766e967745b74bfc\",\"/knowledge-medium/src/paste/armedCut.js\":\"d318dd1b903a5534\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"9c65492713b5ba73\",\"/knowledge-medium/src/paste/clipboard.js\":\"fdc05c56ef84a89b\",\"/knowledge-medium/src/paste/decision.js\":\"d63233668ac9df36\",\"/knowledge-medium/src/paste/operations.js\":\"0faa3e98ad0e38d1\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"72e0cdbe2ea2a6a1\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"7d2be8610f402b9e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"329443ca3c97ab17\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"242d4052270b2dc5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a69aea7e2225e90e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5a1079dac85484b9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"6985280f19e5022b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"713151741e2fffa5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"e1d0693768578c51\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"461eba30499131c0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"321e81b1545d3f4d\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3dfe72ad9a611bfe\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7eab5ed69d87d55a\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"4e1f652a8ab1b325\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d80719002f441588\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"b60f366f33a6c279\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"f93326a815238043\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"22f4dc0e489d22e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"9392f8f1b02c3cd5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"4edef21e86b3d296\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"054b906fdd8570ec\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c736733ad45d8815\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"83461228a8884814\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"32b733f7d553237f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"8474f42d0fd92d31\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4d12ecfc414cf278\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"eea47f8ef3087bc3\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"65a670953dd994c8\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"a01b41c9a12544a4\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"8a8cb76f1cc348c1\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"5ccfeeff1acdb599\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"eb5897bfe3ace112\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9460acca1ba60c9d\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"70c58c9afc701d77\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"6b5215b79724d02c\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6a93e81d474f6c3d\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"3bf4b6a6964fc2ec\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"16d925dae4e8ed19\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"79c3d36af95dfd83\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"be69ac5ca03e254d\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"cc94338a2aec5934\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b22c8273d484ca2c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"e5c3f03b4bc1ad6f\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"39bf57c9ebc732be\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"9534397abc610096\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"12ed62883a292a19\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"f88d195623ab6b29\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"2c090d3748031ac9\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"f32997e227256c1d\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"9ac70d611254adbc\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"11877a672a6986f5\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"f9df590405c70406\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"4674fa874d5e9bbf\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"1989d57ec4020834\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"e09ac36b9ed006ba\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"b8de5aa747f5b2f2\",\"/knowledge-medium/src/plugins/alias/index.js\":\"06d83ab0115aa98b\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"046a4ce6a920dd82\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"65b35a8d0b384480\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"3f1a053f1d7964e4\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"081a1634636972a4\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"82f54e4f78b324de\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"1b04f91f62022bf3\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"232fb9a7f2cbe577\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"bf5134f18573e211\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"192645785cb22243\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"35e16ef3aec6b79e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"33822acbdd20bb1f\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"8b773194bc96c914\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"ce0d89e4e4d8835b\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"e27b3cb3d9371c1f\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2ff643e048fd637c\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"6aa1a5b6557eb954\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"0a7490e2f66043bd\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"728cfd35d768a009\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"7e7bef3b3bafe5dc\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"b940777bd76f2e55\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"3d34772946d2569f\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"055e4436abca0c9d\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"c9fc888e42492eaa\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"330f11e3e66c5894\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"c6bb5aeaa7aed024\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"53383725b6a5770d\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"2f3c639646bc4605\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"231ecf3a182a8812\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"ca3e72b39a36ab07\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"dcb399499f53cc39\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"954a148b7b49a1a4\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"67f82cd1e7b57a2e\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"7ed3cc31a7ae621f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"83951808950f46b6\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"d5fc7ae6b186107e\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"6a7e13fe48997a1b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"3fd15d6b0f2c692b\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"01ec4776110658d7\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9817081fc71d3ff4\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"df3040eaca448353\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"c5c431eacdf42738\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f5bfccb808478ab0\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"052ed23f033190bd\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"7a353acc33efbd4a\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"f8e6e35cb52d8814\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"bd815e6328189b4b\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"93bae2ee72049809\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"db06a06dc8080dee\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"a59dab59c9c38afa\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a4db8a5d3bb40ca9\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"297fb5527bdff277\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"9f04c8b89bef56d5\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"0ec9e167b0cc87d0\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"579bc8d9471774cf\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"c009075c42a260b0\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2ff9143d783b1229\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"37e242c67947da20\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"bcfea13171a15b91\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"6bdf5e147177d926\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"61d20769026b0c4d\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"1c58f811ba9e366f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"a8e3411545f63cbf\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"5b254597305123fb\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"63b25ef893031dd7\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"b5c60f742f3c8f87\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"593b5a2e197a618c\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"88e99e068065a217\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e1da7938b4d33e70\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"aa051e502c17e173\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"fc21c51b6e5671da\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"dc96525d30134fc2\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"b22b11903f8e921f\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"4002cba346e4a2d2\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"114171ecf7590fb7\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"a51064e00dc7e848\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"e8b32578bd6358fc\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"635f7dfae2a27211\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"6b88e033c4f6e92f\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"341aa5dff2cd2647\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"a16e0fcd3b8caa2e\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a5579813c20aeb66\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3dea4e24dd8fd5b8\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f960ccaf63635417\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"62434a3deb56c4cb\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"be90fbf43d05c99d\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"d432d23881763483\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7615b3d76569154d\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"f215db3ca370c875\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"d519763f546cc9d5\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4e2c7c91be29fd9b\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8b4557637c0ca9fe\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"4fec13be946ac1e0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"da88752fd640b9a8\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"e6046706603cd5ca\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"926126a55041e82e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"76c070733df79f49\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"3a1340bcbdf60dc3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"9e494f883bffbf2e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e69a44434f5515a6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"24cb43b6fecdb312\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e9cc9be1ab0a85dc\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"4afaa878927c7203\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"bdf18b616c55b23e\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"d3611f6bd6fc8dd0\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"c7ee6e639947ac55\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"84d6ee2d79480b6c\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"fec639c89b507d88\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"306e314896c1da62\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"68a8ef1e0f6b2b6d\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b9748a582e0d9645\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"a6c0a6b65d916308\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"52f75927cb603603\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"935a767d2a2facfd\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"37e9780c82624e74\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"21d95849c94166f0\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"40245f0f0df4cd02\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"da895bfa2ed9a1af\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"02e669fa6c22bbdd\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"b746098d764cb3c1\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"e7ea2b72bcf829bb\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"44c960bd91a0c0dd\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"e4e5af305831eadb\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e935587eb6819998\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"28b87eca9f09cb00\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"33f33e870adf8a1f\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"e0d01a34fad6e889\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"de2bdf4bd33e13b4\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"eeb399cc51334980\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"c7385f818e1630bc\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"1740e7bbbff4f722\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"7451474d37265fa4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9190277076aee7b2\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"62d8f6e76ddadd97\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c83a2585106c8663\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3a5328dc1982c709\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a74b55957576d852\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"647adfe0c90e53f7\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"151c57777846fe56\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"0aa6ffc4b086ad59\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"38f6c7574914c503\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ac99f2c139ee1d8a\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"5a643cf98834acbc\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"1ab9f7eecd3fabdd\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"06188e825768ad06\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"bbb3c6d937c4adba\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"633b4bd89414d5bf\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"c2c0ed18bc1396d5\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"4edc388152e2f874\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"4fee3abb5cbd667b\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"b98adbf916734755\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"7758807ecc04f02f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"eb38a88330fcda24\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"dfb48ac37ce86440\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"540ea1f0fda51966\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"6baa7be0b2be403f\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"8615719840650178\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f5218db522e411e4\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"a6c744b74f735945\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"89521203e3607640\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"e095e7a0a3e2b96a\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"4cc3367c579db773\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"f88c83bafe97ed72\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"d87c55744ff30232\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"d35eaf4efa047175\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"c77acc008ea4aeb3\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f2e6826d0e7fc99f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a322adadef8f5c52\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"60b4309d3da55ad4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"15d65d56822f1b38\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c1a68c1d65573990\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d65ad1849fdac9d2\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"d3afb5aea15098c5\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"91b5422ffe508281\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"be23c279831beca1\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a8f761219cd384d4\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"4fb1c55f228b49c5\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"f88be413e71ba14d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"ecf55c0953f573a1\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e54a5f22cd509c70\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"ebf3fda8fdebb0fb\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"0e22df2c8bcdf11d\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"480f160b3725ea23\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"67d2f6f0fc0a8cd8\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"162b724afafe7bc5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"bdd7ba510a5b4198\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"67ca521e2eb75e92\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bd24b213b784b996\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0d38160fe4468639\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"0b262b1920a34702\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"e6a41c603e89d021\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"c92b457d7d2bc68e\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3556963ae50b246e\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"082ec9cdbf44e5f9\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"1f77ae6fa6d5d3bd\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"85a9041e3ade5273\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"d513b1cce023b560\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"8870bb3a08de7c30\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"5d0f5b5caaab07ce\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3024210599c56de9\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a7ab7aedf40f59ad\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1ecf9177aabb51ff\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"fb7616cfce6fbebb\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"957fb832ed85e66e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"982024b29636cce4\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"5a87beac3ca6c43b\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"b4ec06bc1ccf2897\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"07bf49663c24eb39\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ccf0a030e2a81a24\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"30f14e29451e8c6e\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"4606abe42a9feff4\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"d04cd7fd177947ef\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"5097f504921de2a4\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"266e6442f489817e\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"74daa3d18731d17b\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"194cdd3e33a196a1\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"88c6725ca5cdef69\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"fdb2cbbe8b21c368\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c972a0fa50b15d26\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"065b350eb58ea0d5\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"0252e11a259338f1\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"e792b04faaa44e6a\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"2e88d1078f9fea9a\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"15490fff19060922\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"fe52bc0b5562c889\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"2b562779f9c10c98\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"2315a58df4cd147d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"de84f0b10d546ea5\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"f3b5f6958a631dbe\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"5b36c0ff065cffbc\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"34f36a811e0c0278\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"769aa5f4385cb4b8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"b0fd1bb4b8db2219\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"53ef381c35888018\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"27bd62bc0bdd7871\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"93447efe75b6b234\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c412b0c4bf577776\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"06e659020fe561ed\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"4bb3667a0a428c91\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"d3ca05504d50a1a0\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"51ea7033a6d9da8a\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"3c3116fbb7ac431b\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"4b499b570b246459\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"de0ec0ec71eb1093\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"9e5ee36753883a0f\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"d63b1a6c2c3af8dc\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e5f4131c02994408\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"54d20467acf73b81\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"f6f3b20cdf2590ba\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"d7a1a1509dbe30bb\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"a640cf47fe221070\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a4d5221f3579b8f0\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"889fdb0e712343eb\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"a00371082ec07111\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"bd4f882c5fe7d9c1\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4c8b44df654b9ec0\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"f0d882a7408f0020\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"dbdaf6498aec5b9b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"b02498789279df3c\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"cbb3d9255d47a1ec\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6663b203e9794005\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"df4805d360baf767\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"6ec6e00853b87eb2\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"3c158c1f63387b37\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3af29dca7a886967\",\"/knowledge-medium/src/plugins/geo/index.js\":\"ad67d6adf1dc262e\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"d07ab360bb5bf9f7\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"0fb3839988ca0e6b\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"3108c0823c4f9054\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"403f25b45a27cb5f\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"e90065cde4fe50f3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"2901177ab607a003\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"98db65a79532c98f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"13f5f7c6b8858242\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"e488b6690fecc010\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9794f9c83a1499e8\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cb5327a49b8498a2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b3145138874e0382\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"179d9807d436c5e4\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8a68585e10ca5230\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"242346c796738783\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2f8a5fd7af36a6d0\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"ed19e3cfba1fd4af\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"981c55fa351d2f82\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"13fe3306b45ea734\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"fda618f552d7fd71\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ce11bc4880762096\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b07dd0846137d2e0\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"c72ca574a231b57f\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"208fb95cbf44880e\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"b435ee66f5bec1e1\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"0387dc48ba8e101e\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c5d91964c89a2160\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"65562b1fa839b7bf\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"afbe505012a7fb91\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"15867b8cc1511aac\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"afaeebb57b720d2d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"93dd7df69a2017ee\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"cb7331ef3abd060f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"b7c9f67f986f17a3\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"0c05ff65528c8602\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"393b39e04538ef14\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"dce9798bf90a0c25\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"54ff6ae6dd569052\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"013463712285be61\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"c2b08a8dcaa148af\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"0935376ddbfc7d89\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c603ea8f1505909f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c18386abb24e3cf8\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"8a2f37294e23411f\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"eccee634113fe11f\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"742225f73f1eee6b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"ac80be3d0784560b\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"e24a2f1623913fa8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"74e2005428bb9a91\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"21d76fb47621ed34\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4dd1b6cde5f16e22\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"64fcc9d96c76d33e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"4c0b6a0015fdc4d3\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"6781b24586a80a3d\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"f680ee84c3413d21\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"93fcdb015fd728e2\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"e9f800c618034ebc\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"5588c1461cd737d4\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"54f302ece1f12233\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"948a7a6e7825b730\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"b9dfbfe23d4b656a\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"dea474be8a697419\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f3ecba816300c4fe\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d9825993437234ac\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"01ed83a40a02660b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b8c202b1b0bb4bf5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"9a1f9d57afd89c90\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"04fca9dbb52a006a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f9a6720f88b5d49d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7427ce9e6ca89ea8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dff7bea75ca750ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"dc05d431acebb307\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bb0910dacee494c7\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"eeeec1a763420eb9\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"28f0695940f88466\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"cbb432d69864f552\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"51ae273cf3389865\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"9aa0a242e15bbd1d\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"17591455469cb949\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"656a649440cadfc9\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"8d1feebdb84501d0\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"fc936e8d14e099c3\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9291e7b4b7a8e529\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"a8b772556deb0016\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"758be349bca5e36a\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"56d95607873b8b57\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"937ac3be07c96357\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"95fa9e0de22086ad\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a5f215dc5b143477\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d27e06f842dbdec9\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"284f9f58df442f77\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"c5a8842dfc9897f6\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"a326e092a43fff4b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"a41604bfbbe4769c\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1bbd0787bea0cba1\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"07519a525ffa768c\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"7de6c0bc47ab4075\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"864ed0b5577b5f85\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"8446cabfb3695b40\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"0e12c7c91b21619c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"5e4a757c83400ec1\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"d0c60e78d8cfb887\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"77bd2914f69c3420\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"09e5f5f018ac31e0\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"f87da57cd8ab0320\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"62e4569fec87a3ad\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"a212c0a299002823\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"7d98f25120226b36\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"0cfaabd3cfc62cda\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"5daa0aa75f3284b7\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"2e4f09aeeb5379f6\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ea6ab7f2ab7f2bd1\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"21e60cd86106073a\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"987c3d6d7e928180\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"89df79ae42071276\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d1dd097d4c9a5b92\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"68068ac81cbf95ea\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"8095494d132051d4\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"2aaa99875c03d3c5\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d04820d242cb814a\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"4f58ad302f3a5afc\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"1c441d3741b96830\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"73b54f23c9c87dbb\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"fb022c98ff987d73\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"fa9899779c1201f6\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"96c667b5ebe76b35\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"9cae5b5b82cdd0c5\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"190c46431a577f62\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"30124327eabf9c25\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"61fb09ab8c7498cf\",\"/knowledge-medium/src/plugins/recents/index.js\":\"8af3b6a44d364ab0\",\"/knowledge-medium/src/plugins/recents/target.js\":\"0279ce20288cd83f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"850c24cd859bdbdf\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"93aa85188b1ea8c6\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"2b1133237d801b7f\",\"/knowledge-medium/src/plugins/references/index.js\":\"83c297aa77cad9e2\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"42d5c08988542e92\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"35492c3dd64e2606\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"973f4bbc1545d2f0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"049e6e75cc9ab4e0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d799fa4c38b0f8ff\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"48ae8b50b1b9d5be\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"96112eeca84f8447\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d456a3f862c4ab19\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9d53a900e4efa030\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"54e7416ad9e32034\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"6b5185890437dd56\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0db23d609cda253b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"6500f167647eb5bd\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"71daca0e2918bf45\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"95fe37ff11d8bbf9\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"59f6b8aab51d00b8\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"178bed5d0f8d6662\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ef8273b869db40f3\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"380ef1f5ce46688e\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f0994c243e45f8ae\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"75b051b7b5ed5f57\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"33feaed21a3fc84e\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"ee57e4ef3fba23ba\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"246628aeac8fac4c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"fb37b1590e827e48\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"c88d55b20825b53a\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ebbecc61fe94dc8e\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"e7f83b3c1e565b1f\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"1aad1dc5953272b2\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"bc3795b2962891d3\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9ab6a9c42d3f41d5\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"6a39ca2b085927a9\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d02b8a40d14fd9eb\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"89b68dccd8aa49d5\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"9e233ec38e66be9b\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"92b3c0ee2842e399\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"ebd39675c6f49562\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"aa1e14b7452d7296\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"9208bc1494d78820\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"d1c80ec9f59c601f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a19a7528a4bc2e97\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"e29b8e8edbed78e6\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"465dea11d0cbae5c\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"7e5071343d87e00d\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"eec67822c5c0fa4d\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"9fa36452a07999fc\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0e296a2514d8b00e\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"9169e5dc463f9cba\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"13a41d6d3f735e94\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"456bf9c471277beb\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"c85644891a82b33d\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c63271e129cb6109\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"a332a8c79b6a0bf0\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c400987c45afbe44\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f145091dae8bc53d\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"165f23695975c22f\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"5eeef928359e883f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"5bea31f58cd4177f\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"ca8638b3a3a38875\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0e9637249e8cfdd1\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"69ae3c80be38e9b6\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b4785421e2e09e98\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"73136d6fca486f79\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"bd789b4ae98a414c\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c003ba30e4843497\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"af2b03be4567fbc9\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"38dd722cedd129db\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b942910631cf0997\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"de94f33b01640e32\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1c58b8251db05bbc\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b99b60c4ebc75a91\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"550c90aad56af716\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a732c91a488f8a3e\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b51233022740ee66\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"48ebb750f44ba5cb\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"8982e600a524d8d0\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"6a002e980cf4f2c8\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"ea7a821da4034f91\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"558db020efe62a6a\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"4d44a1741ae653a4\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"bee3f7143810019e\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"8c7d46ba890315b3\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"daf7b8fe8c13f2bd\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"07440bae110edcfd\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"49839604f1a125b9\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"d53f3f2b7b064ac0\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"23e824392ed28b09\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c4be5f7c1fd21122\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"641e2baac67417f5\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"69dddddd95453614\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"40c66c37eed38c7f\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"229de2abfc6bb83d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"2df23130122cb49b\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"c26c1ca2018f1f26\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"6a22cf7f1b3033ea\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"cee40dd291ebb61b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ce0f069330524805\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"bacbd0e8237763e5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"63421aa1e48d58ef\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"78f62824177ea159\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e5c68495a4b05cab\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"0ba4403ad2bbec1c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"252892ca3edba37c\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"5b3ab94460cefc33\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"8179c3e0f64722bb\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2c88e2ee981f7d81\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"5650f4ca700e684b\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d3075f540fc4831d\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"1edd4313ad2e1c62\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"70a4c0d48fbc1671\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"9121c938accbe7d0\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"04da07bf87ab7d29\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"80a54066472d06df\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"283e23fd3f32961c\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"fb5411eabf501dec\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"6e3b9c69f7a312a2\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"bb31a3c832214c4f\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"d38e5e9dba6e9a75\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"3d4bea395d9e79ec\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"51f924cf840591d8\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"0af2d7ee809710f7\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"bfbc706679b1519f\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"0fc16d8bd1c7a14b\",\"/knowledge-medium/src/plugins/tables/index.js\":\"e5efe1ef522693e0\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b6830cb2757a326c\",\"/knowledge-medium/src/plugins/tables/model.js\":\"a4f8c8d2e924c53f\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"73f385dfda7eac04\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"cdad699e7881a5f4\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ec05737e697adbd3\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"a764b30b84269b40\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"ee0fcd2897a66ff0\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"7d7d04446ebd9ea7\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"6e8b35cf6c0c44b2\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"40ab0d6ab431f6f4\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"dc32672d47af45b2\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c97884383a8dc724\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"93993ae0aaed7962\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"a2849f839a48fe26\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"f2880f56e614354d\",\"/knowledge-medium/src/plugins/todo/index.js\":\"001eded656aad32b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"1ccdb85e61ca55c1\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"82da9b7553c46b26\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"4df91302888fb482\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"84a5b01e4a9af042\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a68083d6fbf15138\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"05a111cb54d37f3a\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"1fa01c7f4dcf35ce\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cbafd3fb1e100f8f\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"78421f0ac8f10d7a\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"b3340f3ec61e6423\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"eb93b94da94d2a2e\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"dfec646d3a683598\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"57b79d39dc31d678\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"358fe0cf3ecbdc49\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"85af3146ccbd4553\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"46646c37853c797d\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"c7e512bf3e2197c3\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"bb20c4de303d9403\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"5a653bfb1a9b25be\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"1f2a462b712bfc57\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f05d3c1281010fb6\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"65d3b6145d8a75af\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"8d41405bfe40b94a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"8e329445d5967b11\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"7dac920af83144d7\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"5868147a8ec86792\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"37e30a801e269c5b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"9fd0ca2652e8434a\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4bfab61e2d98435e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"c40354c5b34fda47\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b4514ceb32a7031d\",\"/knowledge-medium/src/services/authStorage.js\":\"7313d67fcf933113\",\"/knowledge-medium/src/services/powersync.js\":\"caf68079eabbf786\",\"/knowledge-medium/src/services/supabase.js\":\"c2d8c58bda35ad52\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"5c6c2162ac8d6012\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"97d4865b7ca87350\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"2e6d9a932e92a2be\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"d276dd6ab32827b7\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"194d05eac771bb8e\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"23fff5514116bb29\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"19ef2241a2ad51c2\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"b30d1b8fa3907824\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"d95aea0f477d953d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"d6bef26c842b962f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"999e9cbc71ffba6d\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"8e9370cc7fd8f8c3\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"55b2157bbc49fe15\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"2ab3d7b073a17988\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"29b3f70f498579f5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"b4d45721b4c331c3\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"11c63aa9de334ad9\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"b40039270bd5e6c2\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"90d4652936d7ca93\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"eefecc42758eea55\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"bfd3046ebf536f37\",\"/knowledge-medium/src/shortcuts/types.js\":\"78216db6736e8fe6\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c2fd3fd4b6a68b37\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"9c62c1ffef4e033b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"a747d47fa52ae9be\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"8f9b388ed8322a19\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"9d800b14abd6c68d\",\"/knowledge-medium/src/sync/byteTransform.js\":\"44721276952b578e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"4383feab910f9459\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"542110eca00285fc\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"ea7069381c9e4c1d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8013ecd705e1accb\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"ec7fbaccd3e9800e\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"9d286f3c29c0c1b6\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"eb91fc0a9301f35c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"e2f78e168e35fae5\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"ec2a85e5ce1d1f98\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"5cc2c411058da5be\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"44a283308db0c3ca\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"348de0423dced3f9\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"9235928d23af764a\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"6a08c6c6040e5ece\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"4eece7b188c9a339\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"44ff62ba824b75fc\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"a4424ed36b88d661\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"36dfe0f75cd493b2\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"033b34a07cb5daf7\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"813bb7537740e9f4\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"e358138268e4ade1\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"e6731a073b5f2e28\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e17fd787a9c0bb8d\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9bf3e62d02bac681\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"c3f03ebbca56a457\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"1c5448f462bee321\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"406368e641ace974\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"10d2b671230e712c\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"5044408d58223708\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"0a83caf118d12794\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"419c2a31abeebea0\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"ad2280a7bd9bc3d6\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"a08024b33acee868\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"bde3832ebb56d319\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"4ca5428c0b87b304\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"7177bfc53e9d6681\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7a047c8cb0c8f35a\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"5257911ae5ec70b0\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a897176874973bdc\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7c792babd038ac2f\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"1205ec1afb5f6d45\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"fbf6d0ccee5c1cf7\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e430dd48d75f0ae9\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"ebb046b3157dd1d3\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"0c657bbe9ec01031\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"50986209f51018d0\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"44d438827cffb2ad\",\"/knowledge-medium/src/sync/transform.js\":\"1fbe271635e3e622\",\"/knowledge-medium/src/themeBootDefaults.js\":\"c9fd90b727574b84\",\"/knowledge-medium/src/types.js\":\"bec32f2c05933aed\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"ea786eeaa23b6d06\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"b411822478c1b09a\",\"/knowledge-medium/src/utils/array.js\":\"2aaa930ac896526a\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"87b95c653bd437d3\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"57360b1042d1e591\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"6e7a16034e3536fd\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d022e62bf143fe69\",\"/knowledge-medium/src/utils/callbackSet.js\":\"651872add56dbccd\",\"/knowledge-medium/src/utils/clientId.js\":\"f0b24c312c9c2fde\",\"/knowledge-medium/src/utils/codemirror.js\":\"c7710433cf8ed6fc\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7088d7d6ba26d29d\",\"/knowledge-medium/src/utils/copy.js\":\"770a3f3cdfa61055\",\"/knowledge-medium/src/utils/dailyPage.js\":\"da6eb63c6214bac7\",\"/knowledge-medium/src/utils/dbForensics.js\":\"85c1a8f304868c93\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"56a6fbdce104b5d2\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"a6582949fb263686\",\"/knowledge-medium/src/utils/dialogs.js\":\"39d607f7db08b6ac\",\"/knowledge-medium/src/utils/dom.js\":\"e8f9ff6c20204aed\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"50281c15cbc3088f\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"6bdd001b957fdff0\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c08334ad8208ee9c\",\"/knowledge-medium/src/utils/flipSlide.js\":\"6cf793c36434417d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"aedd1065306ae7b8\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7199ed97bd6f629d\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"28e2fd292a63583c\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"41a6ceade7af82b7\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"0563b84979a362fd\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"96fa86583e5d7aa1\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"24e9d1f9718aece4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"0f5d2f82054cb750\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"2576b32d9f1b2aa2\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"6d84a31aa0cde4d7\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"d2254793d07c39db\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"c3bfb7ad54de5654\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"b2b89f2fd2d4d3bc\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"69638d09ad2f2030\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"8e596438e98245e8\",\"/knowledge-medium/src/utils/markdownParser.js\":\"d595dfe7fe3def18\",\"/knowledge-medium/src/utils/memoize.js\":\"b223a2d9c3aa0c4f\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"07aecc06790b1ed8\",\"/knowledge-medium/src/utils/nameList.js\":\"c20e395a1cdbee01\",\"/knowledge-medium/src/utils/navigation.js\":\"8d937cb829977553\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"3408272f7dc973f5\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"15219571fe97849a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"bff2dc59146dda99\",\"/knowledge-medium/src/utils/panelHistory.js\":\"85b0688f07966539\",\"/knowledge-medium/src/utils/panelLanes.js\":\"820e8c37aea2f398\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"423de15f709f942c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"1d15c6bd8e4c943e\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"035049db4053ddef\",\"/knowledge-medium/src/utils/platform.js\":\"a9ef5161f0fb8e24\",\"/knowledge-medium/src/utils/pluralize.js\":\"e0ddacd5dadfcaca\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"dce57f3699b4d1d2\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"c7645dd2999cfa02\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"3b8d14ed6c879538\",\"/knowledge-medium/src/utils/react.js\":\"f43fd567c7f3c0da\",\"/knowledge-medium/src/utils/relativeDate.js\":\"796cc635e7c5d2d7\",\"/knowledge-medium/src/utils/relativeTime.js\":\"e770846ec99636b9\",\"/knowledge-medium/src/utils/renderScope.js\":\"0d21f023503cee48\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"2fdfc5d2ae2ed9fe\",\"/knowledge-medium/src/utils/routing.js\":\"72e5849517bd2235\",\"/knowledge-medium/src/utils/safeMode.js\":\"390732861077e230\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"6d29046c2fa2bac2\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"bd033eee7af54b6c\",\"/knowledge-medium/src/utils/selection.js\":\"86af676bca586943\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"5325986f9cc291a5\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"a57c4d9c002b1bb7\",\"/knowledge-medium/src/utils/state.js\":\"cfdd936bc7893ae9\",\"/knowledge-medium/src/utils/string.js\":\"c8fcf0bae1647635\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2378a8cdd7f7c5df\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"df4cf9b9fe4b3862\",\"/knowledge-medium/src/utils/toast.js\":\"5837f7bc308ac1f8\",\"/knowledge-medium/src/utils/toggleStore.js\":\"93844782cc1eeefd\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"62808e80ff8b93ab\",\"/knowledge-medium/src/utils/userActivity.js\":\"e3c840e86cce6c98\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f70c47a634124365\",\"/knowledge-medium/src/utils/viewport.js\":\"506d3ecdf1656a44\",\"/knowledge-medium/src/utils/webLock.js\":\"b7897b966bb15abc\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"72d79f283f228c20\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"7076647a21c01538\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"fb4ff83bb5c82ffe\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"9175bd8817a74bba\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"ed68e2cc237c74e5\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fd3ecb5e27ac422e\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"79acc4fe6df64bc0\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"a481cd7bc1de3c44\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"7f59e7aa2780d4f9\",\"/knowledge-medium/src/vendor/react-dom.js\":\"b9fe1ed58fd81efc\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"f6ffef61cff549f7\",\"/knowledge-medium/src/vendor/react.js\":\"6058be5d9408d7c2\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
