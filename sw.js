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
		buildId: "9c52d5b97e65-2adadcd1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"3edd4e2e3ab43d9e\",\"/knowledge-medium/index.html\":\"3edd4e2e3ab43d9e\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Bj39d0w4.js\":\"9031da29fa2753f3\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"7ba523ba28df9d93\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Ba33RBm6.js\":\"facb00382f767f75\",\"/knowledge-medium/chunks/FacadeVFS-DiCnrxh3.js\":\"b06b6b3cba00775a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D1NvDwz2.js\":\"a54ba10c4e23ac27\",\"/knowledge-medium/chunks/MemoryVFS-CrpLzdh-.js\":\"b462dcf47c4526db\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BOWhXHCI.js\":\"19a0a71c620d094d\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Dca656bH.js\":\"c437497c123a0595\",\"/knowledge-medium/chunks/Preview-DLUEqCF3.js\":\"dc54460e4b83fa09\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DGrcrL7l.js\":\"2634e027fe6437e3\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Bw5ulojj.js\":\"c3021ad960e33464\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-3ZDf3xvj.js\":\"f98d27fdc1e22208\",\"/knowledge-medium/chunks/react-B0gPPAu2.js\":\"351279a720cd7f56\",\"/knowledge-medium/chunks/react-B1NzTEpu.js\":\"ce3e85fa649d833e\",\"/knowledge-medium/chunks/react-B71v1cdZ.js\":\"2e5b1c73064a2f32\",\"/knowledge-medium/chunks/react-CrJSDTZq.js\":\"8d22a5c7e02f94d0\",\"/knowledge-medium/chunks/react-DRD1SPnC.js\":\"34e423d1dd225272\",\"/knowledge-medium/chunks/react-NsOoGiEW.js\":\"74078e8eca69caed\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-5C1rlZgk.js\":\"b46fcce135f0fce6\",\"/knowledge-medium/chunks/react-dom-server.browser.production-5UNLnlJK.js\":\"b41806038e6ce97e\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BCs-ZJ9T.js\":\"09c67fe4faa13993\",\"/knowledge-medium/chunks/react-iJ573AA3.js\":\"62b210ce9623719a\",\"/knowledge-medium/chunks/server.browser-C65FoOTt.js\":\"7505a2fe12910522\",\"/knowledge-medium/chunks/textarea-DwAG78ox.js\":\"736d9988c9b33ebf\",\"/knowledge-medium/chunks/ui-MBx2g7FG.js\":\"87868d99b6f33f93\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"7ea54da2ec9ae412\",\"/knowledge-medium/src/appUpdate.js\":\"2d711f14fbb4d894\",\"/knowledge-medium/src/appVersion.js\":\"36cfb941fdb321fc\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"121b718c380244c1\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"bfe40759cb38cf2d\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"06cd6941c48da80f\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"59236e567746603d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"f5788fadb5a6a036\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"587e98598f69d70e\",\"/knowledge-medium/src/components/BlockEditor.js\":\"5d9f21a1eb88126c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"6158a9096ad50f0a\",\"/knowledge-medium/src/components/BlockProperties.js\":\"664e3a45a4ae8c99\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"c07beaab1f16f2b3\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"aea6e2928edd5b07\",\"/knowledge-medium/src/components/DividerHandle.js\":\"e1657699c2b54acf\",\"/knowledge-medium/src/components/DraftEditor.js\":\"620fffdde3cab7da\",\"/knowledge-medium/src/components/GutterPill.js\":\"b7ec2f4e4d856be9\",\"/knowledge-medium/src/components/Header.js\":\"b5664d0e59296947\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"baba900015e57587\",\"/knowledge-medium/src/components/Login.js\":\"f7679374ba72a315\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"16f351b9b2547a82\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b579dde20095c5ff\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3b67b471ba1591e6\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2f2fbe050756ad97\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1b92f09a79bd13c4\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6efd9e233f8872f5\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"20d572edd0691da4\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"395606e1d5e195f0\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"931ecefc57ed4b20\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"bcbce2b312c88693\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"19db525f4d3c1ae4\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"26983ac170f52dcd\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"4ad733b99455fe3b\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"6f499145b19e442c\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e317086297a963e8\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"de768c294fc2c4aa\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"42667280919e9da3\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"dc3abbbf77aba39b\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"9a97ba926ecbfb19\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"6a0102c09ed1f5cf\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"9eca12f09df056fb\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"7d55074b773aea70\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"42d8bea504ad2de7\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"204da950845cec38\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"349cc6dfc1b6473e\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"48cf64a79c90cbeb\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"98370f754b1da9c6\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d16f13e1634e7cc8\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"427584b8b7c31b85\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"f122611334bedd17\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"5c914599ceab092d\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"17b9d7be583fdc4a\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"766d3028b49e9694\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"7988ffa27f2e92ba\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"5b26910b9f3c4987\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"f8ae6a6b6aebb956\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"97b22bd775ac6710\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"77e174ae6f9f557e\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"fcd98d0a64d830ac\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4e18616626a1a47c\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"e0f66a6a6b620820\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ddc1f1a7c04249a2\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e4fba68ef1713680\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"afd1065c8fffad9b\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"8a9125526f014efb\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"5c00aba270da6ab2\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"b572c0cc22f48426\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fbf22118b1eb6f94\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"4fc616d72583719b\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"b83e7851528feb79\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"35a1f9a7f7642fc4\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"8f8c436ee341c5da\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"bc1aca313e49f318\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"416fedc9bad0df00\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"7ec0fdd155b437b6\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"3a23705eba80a0c2\",\"/knowledge-medium/src/components/ui/button.js\":\"0fc805752618af88\",\"/knowledge-medium/src/components/ui/card.js\":\"c41ce1c4f5dd0e9b\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"1e759cf3baf050e7\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"82ae1d7621f28eaa\",\"/knowledge-medium/src/components/ui/command.js\":\"b260b13c1120d3c1\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"5f1464eb156a4c83\",\"/knowledge-medium/src/components/ui/dialog.js\":\"592648dd01ea7d6c\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"f1a3651e5cae72b4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"c4f1e5ca7edfc1a9\",\"/knowledge-medium/src/components/ui/index.js\":\"110e3137b18e9f6d\",\"/knowledge-medium/src/components/ui/input.js\":\"6b6e8803deded843\",\"/knowledge-medium/src/components/ui/kbd.js\":\"27fa000456bd5226\",\"/knowledge-medium/src/components/ui/label.js\":\"92bb129583940106\",\"/knowledge-medium/src/components/ui/textarea.js\":\"82fee56f71bcb281\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"59eb0d3a6babd5a0\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"96f5e933259ea116\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"e888bc6c1a20044c\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b1e62fab1c85a101\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"c271d07122e07199\",\"/knowledge-medium/src/components/util/error.js\":\"6eeef65656778689\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"5dd8ac8ede59f600\",\"/knowledge-medium/src/components/util/suspense.js\":\"1188a6a34417eb8f\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"f8e32f23d4b03a08\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"007bfe56e27ee932\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"690f4b1cf27d24e3\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"86470797251dd962\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"514d5ede9f0fdf8c\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"1171fb12730860b6\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"e4904a00fc89cc44\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"d1f3552d5d5817db\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"019dfc5f296540b6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"5fd480f8345eadd3\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"fdacda3bf3287616\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"370b2a11ed158af6\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2c733de4567bfabb\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"68f1623d169f3577\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"6e9d3b9f12c8f78d\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"243f50e04e4dc4f6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"6c1cc7ebe64aec02\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"cedea27413fcbf44\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"c70c32ab8cb9aeb4\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"2553ccd690992b62\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"4a8adf8c2d1c4848\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"2f50f171de2386fc\",\"/knowledge-medium/src/context/block.js\":\"dbf4bfcdb4524ac4\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"83d442c88199c336\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"f7cb7375a3b11f61\",\"/knowledge-medium/src/context/repo.js\":\"97ee27b740bbeba5\",\"/knowledge-medium/src/data/aliasClaim.js\":\"80cceb81391dbf2f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"61b2c8f5908b5e8b\",\"/knowledge-medium/src/data/api/blockData.js\":\"f81633cd32e199cf\",\"/knowledge-medium/src/data/api/blockType.js\":\"1a7fbc50c6b02291\",\"/knowledge-medium/src/data/api/changeScope.js\":\"2c4a143150b78e71\",\"/knowledge-medium/src/data/api/codecs.js\":\"7974d189d4677916\",\"/knowledge-medium/src/data/api/derivedData.js\":\"c3c04bf7d7527587\",\"/knowledge-medium/src/data/api/errors.js\":\"30dd529158cf44c8\",\"/knowledge-medium/src/data/api/events.js\":\"9cc76f497c7ed91f\",\"/knowledge-medium/src/data/api/handle.js\":\"e22efaf26fb210a7\",\"/knowledge-medium/src/data/api/index.js\":\"b3d8b89fbf3a14a2\",\"/knowledge-medium/src/data/api/mutator.js\":\"bc6ffcb5ae98ea8f\",\"/knowledge-medium/src/data/api/processor.js\":\"f2202fe500719049\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"ae754fd2fd8200be\",\"/knowledge-medium/src/data/api/query.js\":\"06f383f6ca1f9057\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3ebdf7641c3ff9f5\",\"/knowledge-medium/src/data/api/schema.js\":\"e22efaf26fb210a7\",\"/knowledge-medium/src/data/api/tx.js\":\"e22efaf26fb210a7\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"97d29e02db80c41f\",\"/knowledge-medium/src/data/api/user.js\":\"8a866318baf7d5da\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"9c516fdfbef142fe\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"6d52a6bc2412c81d\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"de544de90b6afd1e\",\"/knowledge-medium/src/data/block.js\":\"c88e576f672f5f9b\",\"/knowledge-medium/src/data/blockCache.js\":\"e6e5722fbcff37a9\",\"/knowledge-medium/src/data/blockId.js\":\"f38bf366ad91683a\",\"/knowledge-medium/src/data/blockLiveness.js\":\"23b7d922be970cf5\",\"/knowledge-medium/src/data/blockMerge.js\":\"e59c0bb53cbaa48f\",\"/knowledge-medium/src/data/blockSchema.js\":\"55e30d3a4ced05b5\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"904adb3436e5bc21\",\"/knowledge-medium/src/data/blockTypes.js\":\"a4b71f1719afda55\",\"/knowledge-medium/src/data/clientContext.js\":\"7a9ff89d9fa50cac\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ea951d81e43a967d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"b8e57a988bdd1bcd\",\"/knowledge-medium/src/data/derivedIds.js\":\"857af6ca027c6329\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"dd18582c9cbfc4e7\",\"/knowledge-medium/src/data/facetBridge.js\":\"92a80cdb6ffaf109\",\"/knowledge-medium/src/data/facets.js\":\"d2bae6fc70c5384a\",\"/knowledge-medium/src/data/globalState.js\":\"9d9617479812a041\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ac71c2cbd37ea857\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"ea02c95b2fb208de\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"86fbbccd92d57765\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"92b883f549d12995\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"76d619fa191d9e3d\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"8b4cc46e6356a75e\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"d365443d6d0abf7d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"aaefa4c9fca80d42\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"7b6d3f851341c7f8\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"5bad47841e883594\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"62ce6d0b766153a0\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"ae6c7ab5a4ec7fa0\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"c5d44269cc09cf64\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"28f6c666b8f85cbf\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2abfcaeb399f57d1\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"c72adc62f1211a91\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"268e1286c7c92c98\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"5cfb8b8182baef24\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"d4365bebed59ba9f\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"db2c0eb512aa78cd\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"f61a47845c008b4c\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"052dd735416e81d9\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"3d1bc9f59751fbb6\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"53498fa1c14eef15\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8541a947e2fabfda\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"326702dd91636911\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"e637d3fc2909afc2\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"853868baa17e9f77\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"5046832e92aca42c\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"887121ef5d0a5812\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"ca28a5595483c555\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"a8d57a092f85842e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"caa271bdb191813b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"88144ef539c29b79\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"4723edd300d1bc04\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"933e3e979f4bc731\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"202a01a47d096f96\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"3b9e3a3c702c7771\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"c58421b90a01e9f8\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"e5c2f88cc46f2a5b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"4a24ae25ef417b67\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"6f78878847990946\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"7abc6061662bc695\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"b7d76e0b331d2247\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"52c6d52e3487cd6b\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"d91ef66fa4227233\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0b526cd686c3989a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"6aefc1e94f46eac6\",\"/knowledge-medium/src/data/invalidation.js\":\"5a22dc3e5d3dc9bd\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"df17f5fbcc8ed431\",\"/knowledge-medium/src/data/kernelPage.js\":\"7e8286687992d1d1\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"6beb3f8626813b01\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"773ed344d14179ce\",\"/knowledge-medium/src/data/localDbStorage.js\":\"c200ad759fe8af56\",\"/knowledge-medium/src/data/localDbVfs.js\":\"36d1744de39bb20f\",\"/knowledge-medium/src/data/localSchema.js\":\"c6bd46e7cfe1c57f\",\"/knowledge-medium/src/data/maintenance.js\":\"1589fa1c7d8f9c84\",\"/knowledge-medium/src/data/mergeProperties.js\":\"0e373c2fcab753c1\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"33191cefacff3b34\",\"/knowledge-medium/src/data/migrationsPage.js\":\"ce10a7ceb61c245c\",\"/knowledge-medium/src/data/mutators.js\":\"45ee040e0a6674f5\",\"/knowledge-medium/src/data/orderKey.js\":\"41e1fcec3fce16cc\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"97959a5509536277\",\"/knowledge-medium/src/data/outlineSurface.js\":\"19a50f9e1612a604\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"7baf69c2f0b77058\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"c0008566f355a999\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"96442fc9e67aa11a\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"520b1ce6a32f2503\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"7d31259a6c2208ef\",\"/knowledge-medium/src/data/properties.js\":\"be8949e51ae65c06\",\"/knowledge-medium/src/data/propertiesPage.js\":\"b0ae9f6c96b5aff2\",\"/knowledge-medium/src/data/propertyChildren.js\":\"b7cab0f1f2180bd9\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"03521d67b5da8f0b\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"7ec419421e96672a\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"9af9ef7d38759e71\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"f85016c2c251ad58\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"e9d0ac6cd07622d8\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"3e2137006621666d\",\"/knowledge-medium/src/data/propertySeeds.js\":\"5dfefbc5b26c0272\",\"/knowledge-medium/src/data/recentsPage.js\":\"60026af7c43cbb8e\",\"/knowledge-medium/src/data/referenceBlock.js\":\"7fcb5b3adb2f951d\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"75d31dd909ed9eed\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"5fdc21e97f839b5a\",\"/knowledge-medium/src/data/repo.js\":\"7f8aa100866e7486\",\"/knowledge-medium/src/data/repoProvider.js\":\"450ca8b12a35a4da\",\"/knowledge-medium/src/data/rowProperty.js\":\"717d49ad9fe35b6b\",\"/knowledge-medium/src/data/searchFilter.js\":\"9d18c95c8bc34f84\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d2370000bb6ba18d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"096c7cd5e3c15a69\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"c7c64b7d9925077a\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"9ecab93eec90fc6d\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"6a800244908bc3ea\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"e3845ae9f9446d62\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"c49c4a6cf03222bc\",\"/knowledge-medium/src/data/targets.js\":\"70d7cec8c0adc60b\",\"/knowledge-medium/src/data/typeColors.js\":\"e0ed82c9ca0352aa\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"4809e7e6c252815d\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"ed91cd28fb5384db\",\"/knowledge-medium/src/data/typeExtraction.js\":\"9772a37f97797dcc\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"3d7e5741c56f8c66\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"472b5cfa695103e9\",\"/knowledge-medium/src/data/typeSeeds.js\":\"d3fafb7d0791f580\",\"/knowledge-medium/src/data/typeTagger.js\":\"8bbbd0ea21c69423\",\"/knowledge-medium/src/data/typedRecords.js\":\"a44cbaffc3614561\",\"/knowledge-medium/src/data/typesPage.js\":\"424eb790d9134339\",\"/knowledge-medium/src/data/userPrefs.js\":\"f1698f9b8c972b89\",\"/knowledge-medium/src/data/userSchemasService.js\":\"9f3be1f2d555000b\",\"/knowledge-medium/src/data/userTypesService.js\":\"4b752ad1fc435853\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6d0c5be4c50cad9c\",\"/knowledge-medium/src/data/visibleChildren.js\":\"10cc7845a0f3d81a\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"04c01dcfb2509042\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"561cfb0af826fc3a\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b903b6821bbd4e7f\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"91399fe076e93df5\",\"/knowledge-medium/src/data/workspaces.js\":\"7e92d2f114da93e5\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"a2fb98151bbda083\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"4e470117be1d8321\",\"/knowledge-medium/src/editor/atTrigger.js\":\"423682353f820020\",\"/knowledge-medium/src/editor/autocomplete.js\":\"d16738b130df770f\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"ccf39edc2737d865\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8188c791fc37430e\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"0a3d3cfa874e6a54\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"29df86d255be1bfd\",\"/knowledge-medium/src/editor/insertImage.js\":\"7fa31bef633b7af3\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"883a7cd6a2c29ee0\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"eecb9112e1266745\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"9110f9c03bc8de3a\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"0aabcbf72c6b59f8\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"c289b12d68ac6fde\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"4123378e23c23550\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"efa25d2450ea26c9\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"5242316cf4d65173\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"1e58b975d77be8c9\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"55493869f3080ea3\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"19f64f7b6005f41a\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b4b739005c2d1c69\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"24515fad128e1e4c\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"0ce41fc212913b3b\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"0b2b584e90441c69\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"1e92adde8d028443\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"e83f8d06f500c882\",\"/knowledge-medium/src/extensions/core.js\":\"c0f6ab6d52f24955\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"5b1996bd32f9f485\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"fca1b4ea9903db62\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"4f51451ca9adc6c0\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"4dad39b31ac76fba\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"27b435518b582c7c\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"ccfefaa49abb69dc\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"f613a60fe896d9c2\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"cbe0c2812cc3192b\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"c9ef72284e1e01cf\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"734e10eec80564d5\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"da32f5e3104d9d09\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"9c36fa6c966078ac\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"23f7fc9524ffa15c\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"f73f00dc3537719b\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"ab0381949e162091\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"2d66d23c1c248d42\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6562f41d6d7e509b\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"0d92cf2694d1ac16\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"33596e6a8c6d8e17\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"a50f7d93a905d3f5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"ed6c9184b4d8bc81\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"688c2206f267b746\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"68baee2014d59cf4\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"e705f05bfe9fd279\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"8f18f29255f21e78\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"86d953e886517c89\",\"/knowledge-medium/src/facets/facet.js\":\"bc41a169324ba022\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"3b301fc684c28b32\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"4f2e32732b882639\",\"/knowledge-medium/src/facets/togglable.js\":\"deb5f098c9e1f37c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"6679aaff70f88b2d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"601c254f11ac597b\",\"/knowledge-medium/src/hooks/block.js\":\"25a10fcfe42c9769\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"beaaaa4f5eafc25b\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"5fb0279687bf1515\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a2056b1df609539d\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"9b548c9f65fb7f80\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"68c25297800ecd54\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"0fabdd3a06967cee\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e1f022425a5f6be4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"041d6a8d1cf0ecab\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"35037eae94c16d53\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"0f7a1c9b9d642469\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"f675d4c97484c179\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"a73deff6fbc87302\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4560f92dd4c88d35\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"c773f29822091575\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"d2fe84ac2384349b\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"096757ddebf344f0\",\"/knowledge-medium/src/lib/utils.js\":\"9d49fa607c8abc35\",\"/knowledge-medium/src/main.js\":\"5714f5c3e03e212b\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"4e1d5927a28be531\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"a5e2611920b86ea5\",\"/knowledge-medium/src/markdown/context.js\":\"799345a217d844ce\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"658b55e26472c2d4\",\"/knowledge-medium/src/markdown/extensions.js\":\"69c61c8a2e32e459\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"a1b43ab095206065\",\"/knowledge-medium/src/minimal-editor.js\":\"df96f4cb1e5fdcd8\",\"/knowledge-medium/src/paste/armedCut.js\":\"968d891ed1bbe6fb\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"cae043a560dc946c\",\"/knowledge-medium/src/paste/clipboard.js\":\"959bcf5ffda90b12\",\"/knowledge-medium/src/paste/decision.js\":\"89f80ff1aba559f4\",\"/knowledge-medium/src/paste/operations.js\":\"775a2e15dd296ca4\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"6efedaf6d90f12c3\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"c20ff9a547be1fa6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"56fd1d77423591ac\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"3e85049e94f9afef\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"9ab53d0952a404df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"44ed1bacafd39320\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"4b6a3074853c9ef4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"286d34ef41a7d34a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"8cae3f1b892faddd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"af8d756f8ac25caa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"40a0937d1067e263\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e88e843734558c72\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f66a2dbef559ca58\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"af48d901540b8ba0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"fed2a571ea2b839c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"6817207f2bb04c19\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"549d2f0f0d10fbdf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"da7540d06605c7a9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"7aeb795526058fa3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"003f639bb5c7ad90\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"58a34874490000ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"09d270c6be65d83a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6128d0802c5b6fe7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"7d0105b5a6eda0c0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"150d4c7d206c6aec\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c406d13500ad42ac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"75b7cecd9b84f024\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"5e3f533060ba8888\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"841ae1ac3319bf95\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"4519dc983ad497a9\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"6848289a4eda3734\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"ae4ffa85ecd24745\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"acce31f443df14ee\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"b27a2dec10829e6c\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"ad2ffaf727dfc5a6\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6e34e27aef734232\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"6360d5710ceb9c82\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"765511c998ab8ed7\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"72927a6ac6290ba6\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"782a1e0fc008c2c5\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"d75ecc28de97798d\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"f5cd29b40eb92d5c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"5fc79b7b39b426ec\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b9425baca3317f31\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"6cdc3f0bac060be1\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"4c8adc36f229c88a\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"f8111ae4c6710e5a\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"9f6afa258867ce1f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"d60c8b89c0163ed3\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"627322adaa4fc080\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"cccbd19ec317a202\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"aa8dc451a7413879\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"3f9ac52fe320c091\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"319534ec2187c66b\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"aa35d05749f8a70a\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"8f2dc7cebc7e49ea\",\"/knowledge-medium/src/plugins/alias/index.js\":\"b23e7e57498d98c5\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"a4fe594490b6481b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"4f839bdc9a6befbb\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"8fd30a06486c8781\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"36c16d29e3bb758f\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"fb9af75aea9c024d\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e4933df21d1a8ca6\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7f536efa6965bb02\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"0d79803962b63140\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"c532875679620732\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"fdb0f7786e879c6a\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ca0d7f84102e6ef8\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a027f4e01d442f6a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"fb5879b45d46e45d\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"79c11d719f1768e2\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"6d3791af0436811f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"ef47a2771adbcb6a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"fd2659f857479625\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"e0dab8b4c1a25032\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"b855640e3bf21bdd\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"a67f930cf4ffb452\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e4cd7738147230b8\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"badd245d0a92cead\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"045923656d0277a6\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"37595365ebd4e98d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"5192847b9f8e3f5a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"cd8bdb004817aa2a\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"cd7bb8ad3c92b9d9\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"3e2b17e506e35288\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"8072e663dc75c34b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"155c11a3a4bb12de\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"5e97fb859b4176e9\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"13088101316e42c3\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"21d7ead62c20f37e\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"31657352bdd93443\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"c6f251b2b77c2fb4\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"4fb13a47615670c2\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"e3d76240ee63f825\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c0e4131288286bc8\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"8d211928425409d6\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"48fc0ec752735fe1\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6fb5f89241147a75\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"8c9c1f937aea629b\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"e991638b3ffc863f\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"b71f60ed7524a1b8\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"018b8bf87e426885\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"891681efcdd45f62\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"6af9c467199da246\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9c42c3198442ce66\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"b02a2742c065bb69\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0e2f2cf7fc4374fd\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"39c4a971686820d7\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"a26c0c4c7e36aa10\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"daca2c65cf5bd660\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"599b3f8498bcfcf6\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"bf6613538e3ae719\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"51ecc1247ad532a8\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"cf068dbb85314755\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"45230246a2c2f7b8\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"e5aab8a801c05fa6\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"25e5d43d04f455e2\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"3e6e5a07bc7f475b\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"625d2ead8b3bfe7b\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"9fea5a8824f7c051\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"8563fad81b6719b9\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"415f4dc1483c32a5\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"77577956e5b46f5e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"bbff75ca7f31942e\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"660981d926b131c4\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"93dc5abc86242e6f\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"4b40eb1a22d46282\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"4a8251872de5e504\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"d29d9eb28756bb64\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"6be1e59a75800449\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a089e5272c57a184\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"7fcc721bb4580193\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"6e3a9330afc91732\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"048f64cded168050\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"68753f7a81087bcc\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"4b6f775204b0bf35\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"01a56924061eb069\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"71ff8da6ee521583\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5007d2eb7c51656f\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"ea8e2f5d5765d2be\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"c82becce1c98180a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"a598fde6ba1b59aa\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"bc9cbe8dc22f0512\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6ec9e46cce67cade\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"3edfedba499f8ce6\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"81a7fef7d7d20482\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"28c6edc2b491d8d3\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"fa55cf67c19a2bfa\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"10e42296af31ccc8\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"d6bb9271a933b0da\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"678981fd7e613471\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"88489c404f945ea6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c71eb1ab3943cbc8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"0ce3bf950e376ed1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"32d341fddd55adb9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7adbfdfe1dca3e47\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"7acd1fbbc1ebef6c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"cf1ce529850d85aa\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"b40ba56637c04435\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"6cc6af7a0821dc27\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"bcb5fecf18e14f3e\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"8976ded7d21d1dd6\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"8ecbd3f2b80b19d5\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"6887238d6e93f224\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"60664660ad5e36d0\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"6209d5f9e3b2fade\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"86119699081f52e9\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"b39d5140645ae7da\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"32b5b3a9ecc0781d\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"bb55404942984753\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"a7c35a20ec4e9160\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"6a2fc10d2f985e95\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"600e5605b103b321\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"bc000ac93f716547\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"9e3d64d79573e037\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"a2b09d37070c95a4\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"b68522b6d2f409d1\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"81c47734562caad3\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"290298b286dd38fb\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"ce36762c062bfbc9\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d4d8878a7457de4a\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"8b87627855e70e2b\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"03393d55ad317edf\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e5acfe6f9e9a2e88\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"acc919c9ff3ab6f7\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"e486cdc458fb1700\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"53516dc54446902b\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"62d45c24c2fbdd6d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"94cf40181858ca08\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"32feff81d5988106\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6f24612f677eac8b\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1f31b0c2972177a6\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2d90842868e2f9e7\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"960ef01fc5e7cff3\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c2593b9b67886ceb\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"095a611f98d0c50a\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"07c0afc529dae9d1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"e3c393cddc9549de\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"bc3d26c008147d4b\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"9870e90e3bbd7204\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4d43fe952c827a3b\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"fb8d89a27bec7138\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"efca0c439b8301b2\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"b5efe445327cdb35\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"950350aaad3e45e2\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"bffb388b7504a1c2\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"83816cce32f1b11c\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b48806bae7a7b33e\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"f205e5e4feb87e62\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"8b6afdaa01f5fee6\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9a9e2e86c66e66ef\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"5695b3bfdc847b3f\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"1abbc29a9fe34f4f\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"254f4ba2cc451f8e\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"30fc199e11c28282\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f2a173195c5ce682\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"001a411dc637d5ca\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"421c9c4832d07445\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"dbe69c77fea5185a\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"23d62e5c73c1b792\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"3c96a76df8a74b93\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"932e3d0b957efea4\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a25cea0fd6458b33\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"01e5cfd1541ae0d1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2e45d8093a467a21\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"804ec965935735cf\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"24b8691a076c3e09\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e235ffa033b3181b\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"e91b4b8548fe10eb\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"f4d4af58aa597c9e\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1aba4113fb40fb7a\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"56db723227b798f9\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"4e2cf36892b12430\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ba815d9644daba2a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"74db79720b188d13\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"431ec319b9329327\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b95d8203206475f7\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"144aae9adb8a7ab3\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"6b61e081bbf5cc2b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"1c7cc5348a96bb17\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"907e6441a8df0ffb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8ccebbe47f49a744\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"6011f927f6ac44eb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"838950b6adbdb2de\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"aac4081d586e8e3b\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"a4b85e5321252f98\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"503c1ae80dd444c6\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9b052a3302ed7134\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"26b3d352e14ad1d2\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"7c824adb897e171f\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"3a41e7e58ad7697c\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"0f1fd83eb85e07f4\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"17b1de9fafb3c618\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"ce9701329e0973bc\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f535286628fa98a8\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"bb002a59a306e976\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"dda86733fefb36da\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"efad355209dc101c\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"3b02d5dbc8cdb56c\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"509453d54ce06bd1\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"ff803830bbc5314d\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8910db3890e23d16\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"38a44fc338f86a31\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"8b67635d7326cc05\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d2741239c7d2061b\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"62eb1e505525302e\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"12334f8f00e77bce\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"874145a6d001244b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"c4f0dcb5df4717bc\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"5e41393e4f276682\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"70b18248cb9cfc5f\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"e114b5afd02c4663\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"26ca123c2545e8f7\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"d790c9ebc79426b0\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"72b80d8ffea6ad64\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"b0ed8cb64d41405a\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"205bf0bb4030e236\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"51c0a71dec1522a1\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"6dcb6f5e4c578da1\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"b3fe5d7b4e5a7094\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"e42c95e255268c5a\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"aa1bfabc8a30106a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"385cea651c12800d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"29fc6b1870318861\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"7451a3896c8e54df\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"6a2c116e1483ab53\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"46638963987173e7\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"55225e33f8be58b8\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"cd4d9903f62f9f7b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"603fc457ed7e11fe\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"2bc43f85d4e6cd57\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"c8b025fd96f2ba1d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"afdef199879aa394\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f2969ead1528230e\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"ff55c4a30b0d078b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"93d6e30bd89de3b6\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"b3f4fff2df93ea62\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"1f34c77ddd0db997\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"6c3f02a28195ef14\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"00afc200d63050c8\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"0b2c98a5ec24888e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"2fb83af71a45f18c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"312768c8e6daa72c\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"d639dd904a68b289\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"f2446fc4101fc41e\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"7fa2467c38126e68\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0f4a5c5e60d00b4c\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"c3ca9400e06d3b6f\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ebd197e02facb1bc\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"79c348f5cbf6392c\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"dba34facad584f05\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"f4471ad5d2b3e00f\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"09c6ae934d37e6a4\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"ef7c6bf4ff8c13fc\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"312acb78544a0a87\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"10748db2dda21e4b\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"339ba48e9b36af9b\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"26877e20fd0f654d\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"ad54f1a2967781b4\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"e05b30684f69f91f\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"35a129c83e6aeea3\",\"/knowledge-medium/src/plugins/geo/index.js\":\"4d0a7dddb1d4fec4\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"4e2b41b5de63beff\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"ddd0d7a9062e1981\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"39abb5c744ec2b02\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"1f978df2cc147c74\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"6e6ed0caac0a41e9\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"00a3d7117c8d70c2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"422806f32f0d036b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"371e68feab3b091e\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"60546fcd1fae110f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7c8cdf903c124353\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f99c1691d2cbe0d0\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e727a4b77bf3318e\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"2fbcee27c5bfc5fd\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"9d39a37e99901a1e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"6116d64bb5aef181\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"236455c5c4d7d939\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"09735bc3e0112807\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ec7bda7b228e17cd\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"6ddff88156531fd2\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"fb261b7e4329d7b7\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4d2ff55557a4161a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f9f62fcaa332e669\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"323357a7a3f9d496\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"c6a0425775803031\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"fc1aed221f1d7c4e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"23d34707b0373630\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"fc413650242be38b\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"6d1d9de55c7ed352\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"13533a68bea91d62\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"ff32c63f1ee16177\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"fc2b53d70717a4ee\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b83d4552148b3d1e\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"fab75ca348ca690f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"0a53494daaf1cd86\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"53fe6d94ab0acb41\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"a2d041bd4859a3db\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"95044f4b34e41aab\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"a6847a1cd191d0ff\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"a2a3870e06f02d6f\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"a658f83df88704f9\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"ede070d7db336917\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fbee1928268a441d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"72d7a91162f65011\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"4dc51817354c67c3\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"280a58153001860f\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"a0adb66fd87b5a84\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"47523b82be2ebfd1\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"6a31e8f944c4bf11\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"40c8e41039a58ddd\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"2a9ed5bbbe35b372\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a00fd95d16e3e03b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"ccc7c9881c0fc5dd\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"fe1347c42ef2df93\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"fa49e72d2b357dad\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"07bdbf91cdb66074\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b0154b2b8d6bc2ec\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"f8b35da62d524336\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"a0fcd749415dcaf3\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"4b7a70ffa593193f\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"364832327aeebac8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"ca44e486437298c8\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"0d30be9806916168\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f5e311427487ea8d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77e26d3a53d5dc4d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b70dc26020d27b99\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d83e9d99c49a4b47\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"0cfcb7d069384041\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"af10350ba2679279\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"67128a947cc9bfe0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"aef92049763ec394\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7461da73f0dd2048\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"caa3cd8b724edd22\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f839dea2789bff34\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"68317817458bbcdb\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"846deccef78ffa53\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6d167504edce43d7\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"07925fa697e4eef5\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"a4931728c3800210\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"d46286765bc35665\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"0b0795bef8173757\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"1577032fc5e6aded\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"81c91da4416824bf\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"56d301b616f21aed\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"5100dbb38e58e1cb\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"58e6519a14c6eb4b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9ce1ecfb9bef7a0e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"d47ccbc19ccbcf18\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9321a4bdf3536724\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"360f4dc6f5331c4d\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"49c26756dd682a34\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"3978ed77db091a2e\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"36b6891fdb5adbaa\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"c9e2e5fe6bf6c9ba\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"70a01d509cb6ac00\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"04a49e1125658afb\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"43a156b430924fd5\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"9cb14af8084a4e95\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"883e7114a0ea7841\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"5e822c0e377b3726\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"bf839397b5f1692f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e315158fb5b43166\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"e4e7f3bff9f28214\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a74b83a217d775cc\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"e5af8811f0c998ba\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"8343469d389e7d0d\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0a3b1be961f3aa04\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"83a54e53d381e374\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"352a62db9e807712\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"ce8ae400974e1f02\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"f0f62c22766b6116\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"d0eba55a90c06285\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"521236bc11790251\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"cce5de97c805cd6a\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"3d294b7b1858258b\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"c1de7f87c74328f0\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"eb1c2553b4404b0d\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"bd29a4a0decbda4d\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"aadef4c3e03b4b47\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"614d9df2ed9cde8f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"0d583187983102fc\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"250953c255e63369\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"d6b24ad02018b5f7\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"df5e78c1a8f5525c\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"6f4159d5ee275c59\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"42f292d093793d77\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"3bb364ad24ae005f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"40e1ab4999b15778\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"97dac4f3b813ba5d\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ab6bfe13cb7a35d0\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"4fbd5801ee3369da\",\"/knowledge-medium/src/plugins/recents/index.js\":\"7674e06f05059f60\",\"/knowledge-medium/src/plugins/recents/target.js\":\"5cb1886e45768925\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"5804bfd758e00539\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"ead404c4b588691f\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0b9aba8ac1fa696f\",\"/knowledge-medium/src/plugins/references/index.js\":\"1258cef477db1a3c\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7d1e6e1b3e4990f7\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"5476435e1aa17f6a\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"2b2df0b5e7bba018\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"7a3fb36ac9821b03\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"457b58d67f8504a6\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"041a6e4f6c0973de\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"929f7cc4bb4f3a35\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e3ed907b2ab31a86\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c951f84f58b6cf58\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"7025e88e2e7239a1\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"eb9a7ae97a9063ad\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ecc43deb1ca37dbd\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"181a1a955aa741ef\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"d5955c4d9ad8861c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"686f20b8e03a62bc\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"941a9cf3f3164f78\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"dee029446d42aa5c\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"2494fdaa0b2d62fc\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"151dbc1591f010dd\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"fc204811e7775910\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"6ed84738c1ad4de5\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"369c80051c3a2696\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"45a5b63dcfceb863\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"abe68f0d38bc4fa7\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"ba9ad4ab3d9f38a7\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"461a6b5428f1e70a\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ab128f18d5faf1b4\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"ebab3f10a7b2b0de\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"f065e228ea736513\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"330d4a9dd3097ead\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"a8f0c4f2907bef45\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"c5c28a3da559f527\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"c17c33b56287c0e8\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c58c8fb633ed8330\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"f5271fc87cd85bb0\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"95754e630652ae77\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"99cec4c92ce36a43\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"6e6e15ec7a60f067\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"9cb3634e7c70aad9\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"b9dca10995b8e3d3\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"72b91d56039a3adc\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"6dd45ee502b10f58\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"1df65ae02e231c59\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1ba4d7cbb127c79f\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"71e72db8fd375b41\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"54795851416fd727\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ee6f981ed1da256d\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"20777ecd3438f425\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"971b1a1be09218e6\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"aceaf045c52120ca\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"893bf41f8b35fa0f\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9031a391ba315785\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"eecad86030c024e6\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"9216a1726302570b\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"382f2829aef7a8c3\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"9de13945c28527e8\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"8c7f53219f73802a\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"15a4658731a9944d\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"a87049ad7b78357d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"126a67d8af14811e\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"a928bafefe931646\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"4124128b8a851283\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"836fe36cbeb36454\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"c5d8f2f741b7c552\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c5df86628c2dac71\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"66a854e988f5a499\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"3cd798e37b507fd6\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"728e6f90c0b19d77\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"6189a3fb01f9c70a\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1d369dc480afd23e\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f983469e05a6185c\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"24ad1ad890e05deb\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"61dbf8a1003b82ac\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"245717ed1b75b5fa\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"41e9e7e8f3e67191\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"fd4de7121a63abf7\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"62c6412156c93821\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"3bb21bb1f63744a4\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"f3280f79cb363342\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"b3d5026fab709203\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"cebe09de51da6cd5\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"02d8830eb10c252d\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"2db5ee21f642ca80\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"0e10accc8a0d4162\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"8894a285e015269c\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"f05e6b04d614be9b\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"28706fab6733718b\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"d52b4172bea838c3\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"aec39bad22cab28c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"8e5d6255d853d0db\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"20d7bd69f5bf8cfd\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0d12d4bc50f449b8\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"b55292f8a9018228\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"caee83e0c64cea64\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"b4eb993f9ad0af63\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e1b0e4f36d58e77e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f5e495ef41766931\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"1a6c1f9591404ebe\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"6e52ef10f2164e22\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"327a4ea2c1db9982\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"2c0f5837612bac85\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"f8abe98c537123a7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"168cd158195e1ec2\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"9ac2470d2922e4cf\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"2c52723ef8093ca3\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"afc3878e44b6f64d\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"7f6d22f7856e2971\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7cb6b7ba5850d953\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"3bb00fa6a7943518\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"5a265df097c81a7c\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d21bcbdf1b9c292e\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a801d15f09aa901a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"067bc89bf351a91c\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"048624ff476c666d\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"b7c59d4b227a80ee\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"11204e258745e144\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"32465b453d84e940\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"17dbc2755b4d1b53\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"3a4296411c6103a1\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"377d6354ab08954a\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"b31d8a21b914591d\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"9e0bcacea1776e8b\",\"/knowledge-medium/src/plugins/tables/index.js\":\"4cc8e58a2b7b2a4e\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"fc9dd3f192f362b3\",\"/knowledge-medium/src/plugins/tables/model.js\":\"26c2d91889d39ec0\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5221e56ef918c94e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"2aaad7e8c0d432dd\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"ffbcee6e1aff4d08\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"10c0e4562cb6b68e\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d53e9a9fd97d79da\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"eee6dd010fb3c481\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"a9036eec521c0b3d\",\"/knowledge-medium/src/plugins/todo/index.js\":\"510a5dfb23dcd9c2\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"5d337667dc6e5ee2\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7c35a65138f9a075\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f0a2ed00a2d02b71\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"6a5a54303149ac47\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b89714e70a019b0e\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"86a4fb17aa3b5b74\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"17f19cb96d0f1457\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"8a9d2bb2496e0635\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"0bbb5798b1c6c9be\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"13d50bc58d483eba\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"ea39e1754e0aed92\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a80c2b4f981bee93\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5b3afac196956d22\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"761c7fab6ae2e60e\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"29a54ed7232eeb02\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"0abecfb6dd6a7889\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"2b0d05c52bfc7b73\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5bfedb205722b5dd\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"01c08ca2334c1567\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ce49801113d21960\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"47fabb3d4cb561be\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"de391fe3ab993122\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"5000479aded22558\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"3ead63622b0f9c60\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"8343589dc01cbbb0\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"de294411892fff8c\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"10b1cec3aabce149\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"b3230aa61a0a19bf\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0d0111a0d1f0e056\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"2b71106f0224976f\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"c5fa14ae914d72ca\",\"/knowledge-medium/src/services/authStorage.js\":\"c21f6e25964b7c62\",\"/knowledge-medium/src/services/powersync.js\":\"efab5ba90e558d0d\",\"/knowledge-medium/src/services/supabase.js\":\"5317b4fd4f408c8a\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"3e8221ba3787d0a1\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"9c89fc7f59fc91a0\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f8b3a90365ce1e03\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"0f02f1d1e55806cb\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"b2852ce9149c99b6\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"f2cad5c18f0d43bc\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"92a6d6198a77dcf7\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"658bf08131130f3d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"17a2d79176808cf1\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3baf26119d2cb074\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"08f89621cbdb4019\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"af899b56d7e26c5e\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"284665fa8999f7a0\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"3a3e5704fc0372f4\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"94630a37bdef8eb4\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"9befb58505679176\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"a9db6780889bcc2a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"f162ff043c015d12\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"eb7eae2143870339\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"c16ed5aab20ff735\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"4e0f2a93664bf5c4\",\"/knowledge-medium/src/shortcuts/types.js\":\"9147f4afa11e01df\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"73bcb63cdfdf0659\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"3de497e5cc17185d\",\"/knowledge-medium/src/shortcuts/utils.js\":\"6258460b237f5710\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"2e5c31067ee97420\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4b16131be987d54c\",\"/knowledge-medium/src/sync/byteTransform.js\":\"bc39ad32896f9ad2\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c82a673d1cace482\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"f18a2045cdcf81f9\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"8a370343a6f81f10\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"2525d190943e5279\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"161c1d57f7ad0447\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"44488aef5bfb2d94\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a70811c419f3500c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"1875b01f51c46bde\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"7fcd13f58fcfbe93\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"cb568b04bc5bbe8a\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"7600a472b47fb10e\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"fa7561af237f5fc9\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"d26ffa49cd5e2575\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"3c885a26b480c2ed\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a17102ca56f702f5\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"f5287f02aa03fcc7\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"8759e2daaf0ea508\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"9f500ff3f0cb9404\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"d47f14b4380dc5cf\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b305b3c121197ccc\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"9697ef48cadb7915\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"4eaba53276164d59\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"9c549f892957e563\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"d35f1c239e0ee459\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"3bdf00c94131289c\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"c7c2e9ba85438cbf\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"605bc725ac86ceca\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"8b56060dbece857f\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"13c0e1afdda58806\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"c1e0d88ee35724f6\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"2e8df363375e218c\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"9c2cd00fc6a6e30c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"78f324b3e891c1cc\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"fe79d509383c75ff\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"bceaaf3c250d2654\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"5f2ddcf7894fc442\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c400ec543505a7e0\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"d96ff08d2f2d1803\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"da182a4a92db619d\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cc1b6955848c7728\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"7caef5974d70a059\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"7d0ae3317f0c7a0f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"b99153153dfc6304\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"e416c1b298d2f3ba\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e9238a928d369609\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"29dc76aa695f725e\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"31360beb970b2f3d\",\"/knowledge-medium/src/sync/transform.js\":\"7fbd113c105f74c2\",\"/knowledge-medium/src/themeBootDefaults.js\":\"de27563cdd493d6a\",\"/knowledge-medium/src/types.js\":\"18b6a2fe35750aab\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"98e196bddaca6d6d\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"73a2ecdcb66fcd15\",\"/knowledge-medium/src/utils/array.js\":\"7b5d64655f0f54b7\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b88d08d84cc79404\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a647e61d52948bf6\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"dfad8694fd404d5a\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"5f99b2df936027f8\",\"/knowledge-medium/src/utils/callbackSet.js\":\"a61007214d6e75ad\",\"/knowledge-medium/src/utils/clientId.js\":\"62a05d3c80d5756c\",\"/knowledge-medium/src/utils/codemirror.js\":\"6005f2ff79cf9377\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"b9067b96017203fa\",\"/knowledge-medium/src/utils/copy.js\":\"c16d5c74b1d21743\",\"/knowledge-medium/src/utils/dailyPage.js\":\"a64c4cbd48e4cc9a\",\"/knowledge-medium/src/utils/dbForensics.js\":\"ddcbf37791e63fcd\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"fcedda8c00cdfc11\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"a27272b3db9bf2c9\",\"/knowledge-medium/src/utils/dialogs.js\":\"3db548b0dade3e20\",\"/knowledge-medium/src/utils/dom.js\":\"c73e25bcfcddd6e7\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"80d54475030cbf73\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"0ad5b506bb06ede5\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"5ae9944d4258e743\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cc9b325268df6ca4\",\"/knowledge-medium/src/utils/fnv1a.js\":\"76be455243fc9f37\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0d0e650ccd303f07\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"1ee92bb3ebbb1ca7\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"f5b96ca9b1e5c2b1\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"73c801d3ace15523\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"70787c14b74212d6\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f87e66b8b787dfa4\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"983342dee26e10a3\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"b6eeeebd399abd7c\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"ccc338d0f20a4185\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"8098e0436c85c00d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"5e624c019aecc935\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"1a33de059895ea1f\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"231fde2ea0111d8f\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4418b34af39069e1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9f7e2d1d092f1c5e\",\"/knowledge-medium/src/utils/memoize.js\":\"bd55d6441c61bede\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"771bfc6d35489bcb\",\"/knowledge-medium/src/utils/nameList.js\":\"dbef1b8b35b0e9e8\",\"/knowledge-medium/src/utils/navigation.js\":\"cde024bcb01deb08\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"b2a615e523aec058\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"e3c602dd40f393d1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"4d22f111c9dd4de6\",\"/knowledge-medium/src/utils/panelHistory.js\":\"f0a44440dac60751\",\"/knowledge-medium/src/utils/panelLanes.js\":\"9449a8b5a1e86030\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"62fd4f0099acf975\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"17f72e24088a1cd6\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"51a412ffd95c932f\",\"/knowledge-medium/src/utils/platform.js\":\"66aa484bf702cb9b\",\"/knowledge-medium/src/utils/pluralize.js\":\"08c5adf8f42791d9\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"98d143e4d0b43352\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"3808e93e4e5792e3\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"dc676ae88cb8a1a3\",\"/knowledge-medium/src/utils/react.js\":\"eff8aac6ff11b367\",\"/knowledge-medium/src/utils/relativeDate.js\":\"37c1fe23598b0bee\",\"/knowledge-medium/src/utils/relativeTime.js\":\"33635cbe241cd188\",\"/knowledge-medium/src/utils/renderScope.js\":\"82e705c51254258d\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"4c2b545ce890b4a5\",\"/knowledge-medium/src/utils/routing.js\":\"b9b50ebbff92b275\",\"/knowledge-medium/src/utils/safeMode.js\":\"fb70f9fb8309a631\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"25880582794e4104\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"f04ffd56bf737a60\",\"/knowledge-medium/src/utils/selection.js\":\"ecb7654068715e87\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"39666ce787be05d2\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4df9db2d226f74fc\",\"/knowledge-medium/src/utils/state.js\":\"c94b771f8b0596db\",\"/knowledge-medium/src/utils/string.js\":\"7a193afe64ba7b84\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"dc2a695f0b0ab9de\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"0cc25e71b2185b75\",\"/knowledge-medium/src/utils/toast.js\":\"141034f1f3cb0051\",\"/knowledge-medium/src/utils/toggleStore.js\":\"85463d42e6cb820f\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"7a81e5c964d1079d\",\"/knowledge-medium/src/utils/userActivity.js\":\"8b7547f16ed11e9d\",\"/knowledge-medium/src/utils/viewTransition.js\":\"e87841d750ab2202\",\"/knowledge-medium/src/utils/viewport.js\":\"31c1e1670c8e1fe5\",\"/knowledge-medium/src/utils/webLock.js\":\"d5d0bc2ab81cdc40\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"071a2a5fc369f156\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"20f0a181cd5b6fa8\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"701b24b9deb51eea\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b01957bc25abffbd\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"cde1c6014aab7695\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"bf5e940612973d1a\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"44df30d2a044074c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"92ce181336226b45\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"3fa1a79cb833aa9d\",\"/knowledge-medium/src/vendor/react-dom.js\":\"9b3949c4be216b51\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"26c4e4a78027c2de\",\"/knowledge-medium/src/vendor/react.js\":\"cfae1b8412fd1521\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
