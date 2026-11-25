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
		buildId: "c04b8d8a8d07-48b867ca",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"6d47d5f6348e2867\",\"/knowledge-medium/index.html\":\"6d47d5f6348e2867\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BcDSW_65.js\":\"c50240fcce0147b6\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"668fa83bc516ae2b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-ChRRsHGk.js\":\"3bf3a4b2bbc084a2\",\"/knowledge-medium/chunks/FacadeVFS-D7Ulr4ay.js\":\"2e78d0cae8c84727\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-6GRczqZb.js\":\"2ca5358916324159\",\"/knowledge-medium/chunks/MemoryVFS-CcwIFZIL.js\":\"5df5bd8de35ff559\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-M5J_8Tn3.js\":\"bac4bd1a728971be\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CT68l0u4.js\":\"992ad4abea5582d6\",\"/knowledge-medium/chunks/Preview-Cdygzb1c.js\":\"50a245ddc4d39d12\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B5unNyq8.js\":\"47d2cac88be85db9\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CPwuqhRD.js\":\"18465a876da438ff\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BatAK3KX.js\":\"4913b8143410591d\",\"/knowledge-medium/chunks/react-CHn_L9aQ.js\":\"137bcf4aecd97a97\",\"/knowledge-medium/chunks/react-CI5V2uvr.js\":\"21aa99538e7cbe91\",\"/knowledge-medium/chunks/react-DKjr_caX.js\":\"5ff415ad92d94983\",\"/knowledge-medium/chunks/react-DXUSSS7R.js\":\"6ccdc7a5c0ee4d5f\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BsxIeG4I.js\":\"dd61413d594757d9\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CQNCNOW9.js\":\"091d3a2695d17232\",\"/knowledge-medium/chunks/react-dom-server.edge.production-A_lQtEYq.js\":\"483af31c7ffe5e7e\",\"/knowledge-medium/chunks/react-kYj-_0OS.js\":\"8a2e7914524c8112\",\"/knowledge-medium/chunks/react-p4-GBk8q.js\":\"fce18179aa5b360d\",\"/knowledge-medium/chunks/react-xmBslmis.js\":\"0b9c7f6a843a1b82\",\"/knowledge-medium/chunks/server.browser-DU5E9kl-.js\":\"5a216d610c0eb2e9\",\"/knowledge-medium/chunks/textarea-CsMeb795.js\":\"81224661a1953174\",\"/knowledge-medium/chunks/ui-DmWrjzrX.js\":\"ea2b38e70ab808e2\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"36c1bf79d99478d2\",\"/knowledge-medium/src/appUpdate.js\":\"ceb5faec2b758521\",\"/knowledge-medium/src/appVersion.js\":\"b9c973afd875a76b\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"8a77efbff873ecdc\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"f0268e46872889fd\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"4b7a63132ac379f7\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"c3f5366ecef403e0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"2adb5caa0f5d75e1\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"3aa37d4be96ca5fe\",\"/knowledge-medium/src/components/BlockEditor.js\":\"64801d52eb2e8dc6\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"7bb1454df3c434cf\",\"/knowledge-medium/src/components/BlockProperties.js\":\"369b5897b7e29f87\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"0a0db74e8c911573\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"c2d37c05c5221988\",\"/knowledge-medium/src/components/DividerHandle.js\":\"cd58b791ec2daaf8\",\"/knowledge-medium/src/components/DraftEditor.js\":\"e57d2897807a07d0\",\"/knowledge-medium/src/components/GutterPill.js\":\"b849935e68ba821b\",\"/knowledge-medium/src/components/Header.js\":\"0527d4db030d9998\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"8d21c5aaea611a12\",\"/knowledge-medium/src/components/Login.js\":\"a787105061d0bd1c\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"57ac2bab062561f8\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"14e181144af64055\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"cbea91b672b556a0\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1423d9e6b6b14400\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"8651c87a1ae088b9\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"49929c3ae2659f3f\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"c40ef14fa10d1917\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"5e49e5e9a0b3d4bc\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"8e55c43f61eb22fa\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"3fe71b6ee8e5b303\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"689823034c1c735e\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"1be568a2f05d4957\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"980473f9bd27b282\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"22daf7118bdf3cd4\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"5af5ec74fb3d2729\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c56c87ac43a11904\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"3f9de03a852b7010\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"9dd00dd3474db7e0\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a6c034939b1433c0\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"924be68dcfa10512\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"795f4b6c85fd63ea\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ede57a1f2250d96d\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d416826f70b67e72\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"e8d204115b82a9a1\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"dd29dc78c3922adc\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"01c149afc2cfdd65\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"8062318c370b3048\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"c3497aaca320f189\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"fd48721392466e03\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"cc950925dd2138a5\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"cf31f9957fb8a403\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"5e064d9afa875248\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"2c1dcb59950a1b29\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"dc9eda6f3d26fb87\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"b1c9ccf941b3c62d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ae36c994d1f49150\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"7606ce17ab9fd184\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"2343cdb4d93a3a9b\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"36d188692b27f558\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"830430cdb2c3066a\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"461c3da2a5d7903a\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"20cf47e7000b28d4\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"67116c144b5ae7e9\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8c071f216131b179\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"03153d17302d4391\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"8daa783ed25f63af\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"39173a437cb4a86a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"40f99d717bab2677\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"0450cc5fb368d305\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"704325e6cf8aa447\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"780bc447d9793d11\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"d173126be1db5458\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d56eb98531ed28d9\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"1c9255658fd8b4e8\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"540cb9e6c04e10b0\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"0e486e5cb959c708\",\"/knowledge-medium/src/components/ui/button.js\":\"1e6435de8afb87fb\",\"/knowledge-medium/src/components/ui/card.js\":\"9d3e4a4196076233\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8e6adb0234bc3dee\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"c29ec54bd2734a54\",\"/knowledge-medium/src/components/ui/command.js\":\"fd3002e1891260aa\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"fccad1b8e9e0212a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c62782f14078e893\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"4b53ed2dfe2b785e\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"44542405846c3767\",\"/knowledge-medium/src/components/ui/index.js\":\"27fc76b3a408dcd2\",\"/knowledge-medium/src/components/ui/input.js\":\"5941479d7dadca9a\",\"/knowledge-medium/src/components/ui/kbd.js\":\"8c5aa5939eb9df4a\",\"/knowledge-medium/src/components/ui/label.js\":\"5280f87df2e1b35f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"a94022d8e4dc6689\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"48b6e95a44c6ac7d\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"61475971fffd7284\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"93b58f5e1d718284\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"af076a6925c7cac2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"5ecd3909a856defc\",\"/knowledge-medium/src/components/util/error.js\":\"1536a7f421857eb5\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"882df04ddba5d415\",\"/knowledge-medium/src/components/util/suspense.js\":\"763fbeb72eb84cad\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"85e5ad8d955d4745\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"3a60541217b31aa9\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"8d08169d05ff08dc\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"86a4309087f2f5a5\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a2c8c70ae60f9b3f\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"ff83cc39500160cc\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"847b41d991770473\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"0b14dcfbb082cb79\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"188a2cfd47f02514\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ff190356e8af3f1b\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ed01f234c2b870d7\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"3a91bb79d81049df\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b3697f9a01d1defb\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"a79a8619de97f12f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"6b389e77ea7ae065\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"f9cbd4705b23dee0\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"cab0178c925840ee\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"48c4df88f035b433\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"cc0834a6d05e8a29\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"d3c144a63ee9528e\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b1f64fb7ca8c4d9d\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"5e411f2c1eb6dd59\",\"/knowledge-medium/src/context/block.js\":\"e74c052ba665ab3f\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"c021545bf92d4518\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"2fd7809b6f2bfcf9\",\"/knowledge-medium/src/context/repo.js\":\"c74cd3412a2bf98b\",\"/knowledge-medium/src/data/aliasClaim.js\":\"8a7acf16ea026de6\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"f98668a973dac04a\",\"/knowledge-medium/src/data/api/blockData.js\":\"88f9b449ea0a3cd9\",\"/knowledge-medium/src/data/api/blockType.js\":\"6719c0c9ad6f253d\",\"/knowledge-medium/src/data/api/changeScope.js\":\"e506088e02733586\",\"/knowledge-medium/src/data/api/codecs.js\":\"0b5b576d39fd7349\",\"/knowledge-medium/src/data/api/derivedData.js\":\"bb7e33683b557644\",\"/knowledge-medium/src/data/api/errors.js\":\"d7bc7506408d278c\",\"/knowledge-medium/src/data/api/events.js\":\"4c98c3a117b66133\",\"/knowledge-medium/src/data/api/handle.js\":\"29348bd59eb86aba\",\"/knowledge-medium/src/data/api/index.js\":\"dddd5e40240fdb70\",\"/knowledge-medium/src/data/api/mutator.js\":\"d21ca27247b169b9\",\"/knowledge-medium/src/data/api/processor.js\":\"1d16d25944cd7536\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"9e9a3ed5cf16f7c6\",\"/knowledge-medium/src/data/api/query.js\":\"bd731dbd4da3812a\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3ebd6cdfab76cdc7\",\"/knowledge-medium/src/data/api/schema.js\":\"29348bd59eb86aba\",\"/knowledge-medium/src/data/api/tx.js\":\"29348bd59eb86aba\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"b6cda220cf6ecdd6\",\"/knowledge-medium/src/data/api/user.js\":\"c009f99b6afe1970\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8f95cf44ec6d2905\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"b270e41c3e351721\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"4561d65c4eff7482\",\"/knowledge-medium/src/data/block.js\":\"f9a08678f5a026c7\",\"/knowledge-medium/src/data/blockCache.js\":\"17c54293b68b8099\",\"/knowledge-medium/src/data/blockId.js\":\"e4c8acc7b240aad4\",\"/knowledge-medium/src/data/blockLiveness.js\":\"27e3c4e5e5840412\",\"/knowledge-medium/src/data/blockMerge.js\":\"4b78156cc7391bc2\",\"/knowledge-medium/src/data/blockSchema.js\":\"19a94f4370a8a52c\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"b2b2140c8a335bce\",\"/knowledge-medium/src/data/blockTypes.js\":\"2555c835fe04cbde\",\"/knowledge-medium/src/data/childrenView.js\":\"9f43bb78338bc55b\",\"/knowledge-medium/src/data/clientContext.js\":\"1305f336d0b08878\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ba716007d8706fb1\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"305ee6a67f13ad44\",\"/knowledge-medium/src/data/derivedIds.js\":\"858d2bd67632a973\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"5b97a2aadca3f2af\",\"/knowledge-medium/src/data/facetBridge.js\":\"a8a7f75c0bfdb738\",\"/knowledge-medium/src/data/facets.js\":\"aa3cff0457271771\",\"/knowledge-medium/src/data/globalState.js\":\"29d6a525897f8009\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"a97745dc87ad69fc\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"f766e065a88cbac3\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"0208059680554b58\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"4e9afbd327f80b27\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"cd0ce04a1e352c2b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"4e2dda0dd79a7d15\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"d3627acdb893845f\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ea204553171d833c\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"a0e9be7c7d9362a4\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"416e1e0c7d0d13bb\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"37d252882e1f48df\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"0c7aed135989fbe9\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"dfd94a4a65cdb6ba\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"aba5e19dcf7def1d\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"852c4a476f1e167b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"cf3760836dc494be\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"141689681295010d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"b50808d02e7e6f6f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"79ce5599670082f5\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"97f460f1f8caf364\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"d92d55bf4314f9ae\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f8ed027252dc4dcd\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"a3f0f5874d20c032\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"0e3f9b99a00f52ab\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cf2bb89f68dbfc04\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"44ba4b86bcf4ab62\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"8f70582afb6be828\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"81265f2443ae8676\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"4fe6598a58584619\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"8f33cbaf02a20815\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"0fbd8219b964b391\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"2fc550df62904166\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"5b57c71b37d1294b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"5f11d0f573afca21\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"286f957eea1ade11\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"72446e17aba9c7c9\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4739a4c2499bf0ef\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"dae88a00b5d17465\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e28df89b11b20fee\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"0c70c0d67f1258e6\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"acbbc45a3115e1d7\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"b31a0035f17b3380\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"f43880878acfbe43\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d9b812bbebaf7a63\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"5cfbfb82fe16fa72\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"68f1cde67d51ae51\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"1439b3039a46c93e\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"633c9657d6a42833\",\"/knowledge-medium/src/data/invalidation.js\":\"a404c4574400b012\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"348f4badfa52e0fc\",\"/knowledge-medium/src/data/kernelPage.js\":\"fcc03a6d92a44dea\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"183c9ff58d680f51\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"3190661e2f28e114\",\"/knowledge-medium/src/data/localDbStorage.js\":\"c147eb2f7cb142ea\",\"/knowledge-medium/src/data/localDbVfs.js\":\"439f52aa0023aa7b\",\"/knowledge-medium/src/data/localSchema.js\":\"9f65b9eac8c5ce72\",\"/knowledge-medium/src/data/maintenance.js\":\"6eef2bf4c5b394c5\",\"/knowledge-medium/src/data/mergeProperties.js\":\"03c2503a0b3d20e4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"2950862f4f4b1a25\",\"/knowledge-medium/src/data/migrationsPage.js\":\"3edf3e10e7d3a8e1\",\"/knowledge-medium/src/data/mutators.js\":\"8ee2acf48c968d16\",\"/knowledge-medium/src/data/orderKey.js\":\"e13afda69460caba\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"83abd5031ce8a3e5\",\"/knowledge-medium/src/data/outlineSurface.js\":\"fd032e129bef1cba\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c3208abea5dabc5e\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"39854c095e78ccd8\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"dab1100274d5b3ef\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"4da3af09e17ac891\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"cd23d825dc77d1cc\",\"/knowledge-medium/src/data/properties.js\":\"08a81ae401baa07e\",\"/knowledge-medium/src/data/propertiesPage.js\":\"32791c7e36e30769\",\"/knowledge-medium/src/data/propertyChildren.js\":\"2176d59f33a1137f\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"250418a593b8b725\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8455cba3482270ae\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"7734b1fe24ef9a0f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"bb69d7b6698d085e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"1471f9a579d81405\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"a578255d597a8a8c\",\"/knowledge-medium/src/data/propertySeeds.js\":\"cc6f029e1cba71f6\",\"/knowledge-medium/src/data/recentsPage.js\":\"400bbdf2eee9d084\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"0cb7390b9a2171c8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"d42b3a5cc9ae9ad1\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"6d37802ac98c3364\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"540254348915517c\",\"/knowledge-medium/src/data/repo.js\":\"ba8c7ab6617115a4\",\"/knowledge-medium/src/data/repoProvider.js\":\"ea983560a75cc9d2\",\"/knowledge-medium/src/data/rowProperty.js\":\"c096e918f16e330a\",\"/knowledge-medium/src/data/searchFilter.js\":\"0b26e595cf1bf84c\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"d1f5f64933993970\",\"/knowledge-medium/src/data/stateBlocks.js\":\"26b06581efaedae9\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"bcdb4148170cc0d2\",\"/knowledge-medium/src/data/structuralInsert.js\":\"cc78b19742dad254\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"fcbe4f8cca538819\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"677f2049b8dea7b6\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"3a3da6269ac1527e\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"66af078f35102ba4\",\"/knowledge-medium/src/data/targets.js\":\"6393c72d47d31487\",\"/knowledge-medium/src/data/typeColors.js\":\"9bebeb7c84b8a53c\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"abdda14184dbf663\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"79541ef83b14c406\",\"/knowledge-medium/src/data/typeExtraction.js\":\"3f2d8af6ad295978\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"3e9180e606ffb878\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"8126cdcff156ecee\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a2eba87e5ce3570c\",\"/knowledge-medium/src/data/typeTagger.js\":\"ba15f768b3bdccdf\",\"/knowledge-medium/src/data/typedRecords.js\":\"f58eaff8c74d9201\",\"/knowledge-medium/src/data/typesPage.js\":\"ad8bdf1e887b3569\",\"/knowledge-medium/src/data/userPrefs.js\":\"866de6d0f4a88e63\",\"/knowledge-medium/src/data/userSchemasService.js\":\"87ce969a1272ba61\",\"/knowledge-medium/src/data/userTypesService.js\":\"418e033738856f78\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"8a9c154dbbe59bf3\",\"/knowledge-medium/src/data/visibleChildren.js\":\"1e7bee2871d52669\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"fdbc5ea211a70e7e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"e4005b45696010bd\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"3cc73cf8d397a691\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"fccf515cf78d43a6\",\"/knowledge-medium/src/data/workspaces.js\":\"09c22d9fc5cea470\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"9b983786742db00a\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"57c4e3cd92a72828\",\"/knowledge-medium/src/editor/atTrigger.js\":\"83e7f61dded34fa7\",\"/knowledge-medium/src/editor/autocomplete.js\":\"84e87da9c39dbda3\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"2e2935765f5eb299\",\"/knowledge-medium/src/editor/contentFlush.js\":\"4e4e0b65e677526a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"232eba6c5450d4e9\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"3e124d1c022ad91b\",\"/knowledge-medium/src/editor/insertImage.js\":\"e9eb97020439d780\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"c2988d220df9c131\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"ff6b38856d7b0da3\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"183c1d7380aea146\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"3bcd52b8916695e8\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"3c420e15c934bee1\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"354f11d79b92fa17\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"4fa1ce25189096a0\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"3d091bc2308613a6\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"cf8fe0eabd9fbcf4\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"4c272e457369398f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b90b6ea339c10063\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"9c16836097c97972\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"ddb08d576b4d6d0c\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"531a5cd078300f87\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"b059b87e28faa2f2\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e89967e80ea3af9f\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2a52d3e2357fca87\",\"/knowledge-medium/src/extensions/core.js\":\"6310ce39cbd6e8ba\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"23713da1befe67d5\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"7dccdc1e85ce1bbc\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"e147bf52f60b0edc\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"152b0c49369cccd1\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"9a1a9ac37017e9e7\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"8522595d9838a847\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"58543a1d9e643d7f\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"909652bc69ddb244\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"4b8f7e0bc2de6f3d\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"0432529eda82e2bd\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"fb16cbe627343c36\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"f8236febf5916166\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"29de93f7ef3732cc\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c0952a4fa6798bdb\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"e7ab9243adc86866\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3426a857676b7153\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"c530b4c4193d578f\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"93f3767e6b809977\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"dd2ca727392a2106\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"3a816ba2bf80760a\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"99acdc3f14210ee8\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"415cf94e73e54b5b\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"dfb1ead46f36ad04\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"c94aa93eacd3808a\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a7915598fc3c789f\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"daab3d00e2ad1ddb\",\"/knowledge-medium/src/facets/facet.js\":\"9f6f6cc661dc12f0\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"d2ba200cbd787f2c\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"188029bfba4e0f90\",\"/knowledge-medium/src/facets/togglable.js\":\"d2d15a01583d6205\",\"/knowledge-medium/src/facets/variantFacet.js\":\"8f5228f257122520\",\"/knowledge-medium/src/facets/verbFacet.js\":\"a4aa8c87ba68f1a6\",\"/knowledge-medium/src/hooks/block.js\":\"12bb05b0fb20f312\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"72aab552331e1433\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"67b6478be6bbe869\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"4938179a005eb1cb\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"dc2aa1058ee26c0a\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"01cfa93f060d7b57\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"ed8229ca7c831ef0\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"3addb9c990321be0\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"d7b74dc7997689b5\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"d64efe32346c269b\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"c009993d89fbb179\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"cf037e8eb1f77dda\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"5cc23aa4a28633d3\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"6acf45d87373814a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"79df3d0a2792ca99\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e677a184bd7fddfd\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"9d4d33dcf5751f08\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a10fad002378f80e\",\"/knowledge-medium/src/lib/utils.js\":\"ce3d3db9738c200f\",\"/knowledge-medium/src/main.js\":\"8cc0b10caf2580c4\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"4a5a7e1534251212\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"fc49c76cac1d2c9a\",\"/knowledge-medium/src/markdown/context.js\":\"adb5bcaa87cfcccd\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"27660ae75d341db1\",\"/knowledge-medium/src/markdown/extensions.js\":\"f79dc0a6a1035196\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"d7bf960ffef053ff\",\"/knowledge-medium/src/minimal-editor.js\":\"50d48562a1af9a4b\",\"/knowledge-medium/src/paste/armedCut.js\":\"22cde0df611fe049\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"6f93f606329dad0a\",\"/knowledge-medium/src/paste/clipboard.js\":\"3f7f18c71d7b02f4\",\"/knowledge-medium/src/paste/decision.js\":\"0670639d94256cc4\",\"/knowledge-medium/src/paste/operations.js\":\"9517e94a14328bca\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"9219261a36ab6cb2\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"30bfa17ae788d37b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4045ade6f16712ff\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"97a3471749c0d46e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"40d5033f050bf8be\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"90c7c2594ad0cb30\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9099a94b74bb111c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7030fdc4c399979f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"1f084b4b55985b40\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"46759db2d303e6a8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"96808c1c05a77c85\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8e66a651f2e0302c\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bc4a658dc2cc9e21\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"fb7b604108ae3086\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"08c92b21a4d30c1c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"2373eea610b5a15d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"7d42c82bb08228e9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a570c493d9f07c51\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"9ab0faf4ad4e3763\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"262ba38eec65c574\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"87037c6141d17482\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"fbde1f2ac9d51bbf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b2a01c9ce4fec2de\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"4ddd692112cef284\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"b29c4275f80a386d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5814fe6ac502e2e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"a4856584846f9955\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"ca3a1ab7b385cfef\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"a6950313ffe5f404\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"9deca4c97a74b233\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"01e47c7d98f6bb8b\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"005ae24d985e56f6\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"13b0f7466efce0f4\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"e2671de8e8cbb7e9\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"a5e1ddd9f8393156\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"cf1fcefd23303fe1\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"00a7272c12efb1dc\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7f636dfac61dd0cb\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"11c18455872bbff7\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"a5a8f21ed46bf330\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"7e168cc1acde4aad\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"11e1ffea1d9e657c\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"7c286b2d552447b7\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"4f06fee71ce57507\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9f9f96bb9e5defc3\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"fcb2dab89379524a\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"4f47460c9cfacf01\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"534368f054593571\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"b259b38a45d75774\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"92f3ba581a697797\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"1e5459246192bebc\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"5cfead1c3255ff85\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"24591e48526d2096\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"218ed02d549c9034\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"1703cc37c6845505\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"221e53c0bca4a638\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"d790e5569b9f7e72\",\"/knowledge-medium/src/plugins/alias/index.js\":\"95862b5773030f09\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"b7bbdf9f3e47a8bf\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"4e98b1ef9b348030\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"6a0bbbb9b74ac675\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"e5dc10aae6ca3a05\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"adf9cb5127035b42\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"73d71fd4b1661788\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"17c7fe56cca6451f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"a65091e0521aef6b\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"42a70fde18f0f99d\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"21c3d37bc947d29f\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"239d8ad6ce4d262a\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"64ad2425b7be12ba\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"2429570f97a452e8\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"ae25513d71af32bf\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"82e585081c6e7fcb\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"77ff09c220f00ae0\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"961abc006367cb18\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"5f54b2e059893ae2\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"60dfa4f14c1f8361\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"c2eab4f6ee230a14\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"29645b91e82a2cb2\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"a9ecf1b4b9d91e6a\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4873ad64baf70164\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"74ceca0a4307cfde\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"295aa7f067924e3e\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"d15fef4a7d7c99f4\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"9da0eba23267c0a4\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"28b254d5ade2f8cd\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"201da3a8da958258\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"7c15599646c0f89e\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"524c30456efd1d6a\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"6bb932e5f58e4201\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"36c514c294ce01c1\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"7360e349a111aa2f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0f6a78f3fba881b1\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"1e93cfeb53c4efba\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"78805be1a5beb6d0\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"111d8666b1bb6605\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c2bf9912260eb497\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"f488f022293eb3a1\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"c566219aa1cdd62b\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"e10692165c43de77\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"aa06178c38f52591\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"065fa82e86a63963\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"e7782287846e4233\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"c23c582ecf26c44a\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"f42e6b6f845588c0\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"9e4566846202e3ca\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d686a4bcc8a2cfac\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"ded462ec2ebc9bba\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5958dc85d03b6ad4\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"1f4cb45f445af310\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"263690f7b293640a\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"d00a56cb9315c165\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"3e2d9793b9232aa6\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"08e1082bbddc4b31\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"aba0cad269510758\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"8d95ce5861d30b4d\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"7545f7352a83fad2\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"95f9d74a0248226c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"0c9fa15abaabfb26\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"653741c5c86c3349\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"4dd00fb6d7b8ff66\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"58dca8c39038ab90\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c8ed54b47b35f122\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"69131867d9e88507\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"cdd8dbff165ac1d1\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"cff7fce3157de676\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6d6fabc628c6ee91\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"b7269488902d4c83\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"4c1c4b7b04ec5249\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"74dc0eed51e1d19b\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b5a5dba2e499f1c6\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"b660db32424f540f\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"9c6bdd8b21d20dac\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"e1e9d3ff6e118d15\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"3417744a43645c37\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"a38d585bada55682\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"f0d110a0857ca2c2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"d6ce62a172deaf50\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"5a9902d9f346431c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"46377f5cb6a9ab89\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"c3558b305465201b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f5776a60ab1f9bb9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"feea576a6bf76ae5\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"9670fa81b83ed959\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a45688344cb368cc\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"644366d599f117f9\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"a56266a953de7463\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"38da0ee99e605019\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"689a037aecb10e97\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"893f39f4998f2ef9\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0fa6efd057d198f9\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"0e3e8ba7be21378b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"0b2720e5725956aa\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"4aa9bc6c7631fda9\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"faf7c73525e7e2d3\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"d977df210ba4e647\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"55ec0d7d36b1cd25\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"e872a6f15a677ba2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"35222e41e8105017\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"188985b29f122bfc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"b588d64902ed423d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ee6d58d7389b98b6\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"e896a3ec7543c0fd\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"fbffca9d022029d5\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1f06ca9b354c4456\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"7abe07645e134225\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"602b83184c3e3ea1\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"120bc1bd6ed868d1\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"b8a434e953f77086\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"f51562d574c85585\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9d54ebb82885a7f2\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"1d0052937ad2ef30\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ce1a95617dea81c1\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"01937e6aab2ff563\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"1199c44ca7a66f44\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"4498d8607c431d5c\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"e726953898982863\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"57c9874eb26d01ba\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"37893db616108df2\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"1f2f065bd1f68362\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"049cc72910d8b595\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"835f80853d82a39f\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"b8ff38df86eb76cd\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"2bafcfecf524eff6\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5a0c3a59ddc3b8b6\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"601ceb2480bf49a7\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"61b05d23d02e0c97\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"4ca7a6640004f068\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"bcc86ed7c6e2387c\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"7bac40f9b929dbea\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"32c89e50b7387dd3\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5a79b170789b5541\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c984b6f21788cc84\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"08d28458828cfabe\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"aa2c2740042aef5e\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7282b6b7a35bbe97\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ef8cdfcc784d3e3f\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"1dc02057186e8c2a\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"27a9c65ced232afc\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"cea2f5e30953c653\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"beab219d8d19e8d1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"20afc4587b47fc35\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"bfcb0215a6c363a4\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"1982dde8838662cc\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"6daca97f1163f63d\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"91ebfd4af08d5c78\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"c4193698db69f371\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"6a6b758373176557\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"70cfc5093e37cb17\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"ab66c63ae69cece3\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"92e31078cd2a33d3\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"a83f8a363dafb5e7\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b485f7de0903b51a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ef097ee0a195c0c6\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"bd174fa1964efcea\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"1e13b85c66578281\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"66997cda21987285\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f016574d634ed251\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"fb7f5ad8cd002a52\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"1eaa24995de28abc\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"2128bc7fa0324e8e\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"cdd3458164f9ef3a\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"c109bef141d1f34d\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"5718036fed53d608\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"c2d27364ad23d0e2\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"e4858e6ad2e098af\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4c91be1e6917f610\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b91c2548ae7d0353\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"346c989addec0f2e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"d7f29b375eb9b814\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"15d90c29f8ecee08\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e8653b038e6e265f\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"0211edee459dc31f\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a595109c3bab9460\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1d310ec7a589c7a2\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"51147e8d9f63434a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"0507dcc7c444d78f\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"fad688ce036e6e33\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"43b691a65f00cf9f\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"e26ca5fb5eb93c74\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b7e59d8e5b1b56c4\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"bdcd08c8d9382e3f\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"18e3843d257d6155\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"b83f4ca45430ebab\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"c51fabe4668c173f\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"7bcab4ca9bfe9051\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8db71173e1d98ec0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"de0ff78a55952b32\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"98e9b690ec38a26b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4b9c52a995f9de2c\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"0c4103d582974baa\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"26225fa707bc61cb\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"97a2f0a7fbe75747\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"4f9aad45d2f9bc2c\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"fef28620cddb91ec\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"4ef941ee5743c323\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"8828316ad1db6983\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"44397220a6d6b64a\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"4cd1bc9ee43c253f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"5a73f1150f87bef0\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"62dd643c070cceda\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"bb84e63cd3e4621c\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b3b37cca5f029c19\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8b5b5936556ae0e7\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c212a16e0f9e8272\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"7045a5a16e447325\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"ebba7c7deac8f1d4\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"0c06eb03942bec2a\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"30b53daf8da319cf\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"2523e68851ba2de3\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4836a9e0687f10ce\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"92ff582a1d66dd25\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"c5ab2e6cd0f4690d\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"ad3d10da7e88af05\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8e9e0697d1a69bbf\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"487ed89761835ef2\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"07a8e00f0c97391d\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"d00296ff4658d5ec\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e477111a4a8f47af\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"e8373d9e7c92abf4\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"a0d84b8871a54233\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"96a5305d33242ee3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"c5adc2f56b4977cc\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"74425eaf0024cf69\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"d60edfcd1b9a5de9\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"ba8cf0a1a73814dd\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"cc9f4df23c93a580\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"d882ee96a19c35ed\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"4c25ada2a2023e4f\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"1172ac36ff488dc4\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"149bb9ae66eddeb6\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"e3704fa9a5fcb09d\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a282f08858d4b106\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"66ba1a0240c0c99e\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"06f1d6688ce3739e\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"caf972ae9918630f\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"5c1e7610296245e5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"6139f7fdf722b7f3\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"368c8429af59cadc\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"eea313a24d051d5f\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"5eba17870ed7cac1\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"e3c33602337b1370\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"0d49c6b99dad9750\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"7fdaf85cbb425259\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f1e1841aed6ee992\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f8ddbf185fe1cbb2\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"286b51c500e451de\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"4e8bd0d65e3df4c0\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ce44dcad0a103d0a\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"c5e55308b82b41e4\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"c075d1e33d2adea9\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"e36ded97f4375afe\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"f41832586118ff0b\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"5fe57b49159598d1\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d4c87c34bd4e7fbd\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"5c5e818360701a3a\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"8c1230161fd7ee03\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4a5bf75c8e91273e\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"33b0bda237936822\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"8dd283ffe59a164e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"273ed6fdf5defe9e\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"677dc89751db4826\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d93d0a6be18513f0\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1132986359fee134\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"e8f17efaf79e2ac9\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"d8b704c27d016217\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"0ebccfaf2c64d535\",\"/knowledge-medium/src/plugins/geo/index.js\":\"9a775db529aef63c\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"1b6881751be57317\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"599864788f851576\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"256c028ee5669f4b\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"e2c48e1e77596b7b\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"136622f59635eb0c\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"75b9afdb50afa5ba\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"40c3812267690741\",\"/knowledge-medium/src/plugins/geo/query.js\":\"7572aab41dd36029\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"1f3e3d04d88810ef\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4b3fdd2cba95296d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e3de667019f8bcb2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9732581cc8c905a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"2a548faf43f7256a\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"bfefebaf6c2a3e02\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"837a5ec9e666c70b\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"e8a8806a940e58a7\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c1023fcc304cb9c2\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b8093e58449a5411\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"664f6fb96daac300\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"c58ca3d947d27e87\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8aa2ca5a6d801871\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"094cb989e4a3ec6e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"a68a911e9a3dba6a\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"739476499b60d232\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"d3de65d958743b27\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"2f7ef38a2b694cdb\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"3b550b14df493a21\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"909e7b5ba47d001d\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"738564044cc5fb9d\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5783d6f9412df555\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"b7f3cf26c969d143\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"94e4ee1c9125fec1\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"31e4b03df5873118\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"5bda419d44621a90\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"197115c71316b991\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"4c7614a2ecfaa84e\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"8b6951f3caa9d82f\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"dfbc7785e9ee500d\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"18c411a121a40a06\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"88e6cd5f5242c143\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"d5553078d0dcd0ee\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b54a679ee1f157b9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8c4485e2c8b8464e\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"b98f51f96000e470\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"5eeaaea143163761\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"16d4ded0dcca0141\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"7b3f57701ca9a6d9\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"b2013888660b81b1\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"05f1ace2f97f4b66\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"208e67288c9b985f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dcccd71c4571e466\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"68ffbad44e732f3e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"f46f8916f7600ae8\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"3940ddc4217c9f5f\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"1d948775ca6ae3b8\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"3d98e0318f30b118\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"63bd15e64af7c004\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4cfb42c2a4e678ef\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"12ef209200abdd05\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"940613fea18ce22a\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"e1a6cd4ba45110d9\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"dc5f6d532d1de798\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"e2c2a3b21b8be831\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"79d2a12a8b2c78cd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4820f4c7374a9c04\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"09d56b2281f0142d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"ab4c39110cf6bc7e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f3cb847416d9f858\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f7b2fbaf4514ccba\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9ea632655c585a02\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ebb2e8625260e864\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"d646d46f6f21094a\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c36c14bb74a4fa82\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"88a2077969128b3a\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"9e4719e1e638948e\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"7e11b19c2f54d9fe\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"1658f2d2898b23cf\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"75dd462e29d96821\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"fbdbf7e10a85bc95\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"ccb67745698abf04\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"ee44400dda2c25e4\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"368eef01e616afad\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"da0b75f7d95e1f11\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"ce8057017dd7da3f\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"a08a20daec7841e0\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9445ecf9b492acbd\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"4224a00e1d89690b\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e7da2288ce3eaaff\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7163fe8e22a76b3d\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c4daf31e60b88339\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"3559e54f2d98c2ba\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"7c8b98908a2f1f4d\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"e7f02e9d4ffc97a2\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"4ecff56331623b63\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"7e81a75dff4fc060\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"422c4359126b2369\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"c6c4175a42d13278\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"3cb8095c7a4c27ed\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"5765d2b4aca82a62\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"063848fa3e4e2036\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ce9ad7bfdeb36b56\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"ce2f27b651501b1d\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5f3ca917a7989950\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"995d1d5d25eb3cee\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"84c35ab5a78ff33a\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"8e14d49e5c84034b\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"bb392086ed31aa1c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"b7ff579f7becb9f3\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"fca6c0f409a0321f\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"878a178054c54d31\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"e1a2461ab10914c9\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"f71018512ffd6340\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"4ade382432332807\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"515ba08b560389a5\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"cf6c6e82bf483dd9\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"3f7e01e23032ada1\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0a13627600fa2ead\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"5cb040a0ae041b6a\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"8e2dee335b6c4d11\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"60a7ae1533ae5114\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"bf9482a960fa6af1\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"bf1c406e2876fb36\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"7bb09a4929d8ab77\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"3507eaa47507b7a6\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"2d5d833ab98a573f\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"c83ad251a937aeee\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"edd12673e1be378c\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"b6acf0026886a282\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6bb47945ac0000d4\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"14c95ef5d0ebc0d0\",\"/knowledge-medium/src/plugins/recents/index.js\":\"1cc815cfeef18c3e\",\"/knowledge-medium/src/plugins/recents/target.js\":\"dd4f3e77b99dd614\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"0c56789d8ec578c4\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"7176e187eab4ba0b\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0aa5987afb3c0aa6\",\"/knowledge-medium/src/plugins/references/index.js\":\"5b11ef5e34ca4662\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2543587c5e27c088\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"3d6ca04b1d49d841\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d833307319c2851a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"d492857d6c84ad9c\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f330c142a7e98629\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"620df00f6ac3624a\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"7aa2cbd43de8abec\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ace05fa6b068d559\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"261a559bc2eeff56\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"634e7c70dc514601\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3f5cf36917154715\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a3fc38713700a69a\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"22fbb8c33b215f24\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"cfa38aaf88e33b39\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"bbd8492eaa9d78f8\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"05a349deba53a4bd\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"321b8dbd8277991b\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"721078f5355db55c\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"eb8e185cab024117\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"8435d6ad55d4db6b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"597421648a7a2548\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2209475cb27203c6\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"8c4ad8fb4341b005\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"399c812ebd92f6b1\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"c29c42658a469d9d\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ec2295b0666a72a3\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"925f9e64c6e0a01c\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"19c19b53f93fd0e9\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"7721b436a4c30f94\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"d5025dbfe4530e78\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9fac600b6cbf7eac\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"d2d7290d38001fce\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"cb55e689c85c01f3\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"8b1c6f2169e250ec\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"f279224225070503\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"253ac2ccf106f77c\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"5853971e455e2c6e\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"f1908165b1afc37b\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"b63d03c68a5d9f13\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a2665d1fb2b41c5e\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"4e2c7148ad4a35a6\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"d9fb877e992d54d2\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"4e75850934df611e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1e8ba0f29f76445b\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"3a1594ac875fed43\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"576e1306d757711c\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e02952e7f6269afb\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"192076cc02d17bfa\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"e8733210805421e4\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"4ec30e54da4b26c1\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"06d505844bf195b1\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d6597373e9c763b1\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"b8eb9cf76c3f4438\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"ecd9f02b4fe1b2ac\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"488937ed88477cbc\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a0a8c69c62ae0d7e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"35de004f75b43262\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"0a1375a88b54474a\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"cc4a38474f109a87\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"18885e2320892db2\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"6542f26aa3cc19ea\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e9ce3f72544b63b8\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"969b151aa86670d7\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"6ff11c83891c4f1b\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"cdcd2db1a86a9472\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"738764bfea275ca2\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"cd0585dbc0e8f1fc\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a4e6325b476e9684\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"6859b2cd1c357e0d\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e792fd269da7f4be\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c89a848b60848a7b\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"05ff4862de904d0f\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"ac33295d1117e8bd\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7d9067a471610a6d\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"b304ce441dbc456a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1fd409975a808ef1\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"9f8048ae2011f31c\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"fcff1a7effaed3a1\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"740ee39ef1cd109a\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"5dcecc804ecc8923\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"c1aafa1b2a2a416e\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"99573934c29f34db\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"8aa1854af0ddd961\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"c1ae23b63c6b6dc5\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"a6242f84cb3c1991\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"0ca509c9c0c3237f\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"ced6420066097772\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"6b8fe3f55724902e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"0e20c3f1db18a41a\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"41ef1bfa9937c95b\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"52712dc246023ade\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"8f703de4671ed62a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ab9c3df3f7c67c2d\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"6d895e7aa3dd6123\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"06455e6ad9468e44\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"a3bd19f37eb7018a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2d02fc9d5908ded2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ec28f3963e9a5a5c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"34f2db4b44357154\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"822a88dfe78de084\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"12858ef145b702cd\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"305b322c8257a50f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"698fc561215dd885\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"5c94153506369c01\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"af57601e5c997fe5\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"d3fcbd1a3e626753\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"d95f96f3c427fad7\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8ff53777a7cbaa6f\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"caef7f164f4af003\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"19a3d74f39c40988\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"083b6d0288aa5223\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"1399d96103edc5ba\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"46801e96994f9719\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"35adcb43ffb79e4f\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"51f64147f40e97d1\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"1bf5c4f74605be5b\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"590f8edfaefeef24\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"2c2cb0625e0cd416\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"bdce4c8809f3961c\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"9483c4181dc83d02\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"e98560a0e9bf56b5\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"e52f1e1d5f8cf73b\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"364504a8f50fc07e\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"ea0d6187ea4eb8d0\",\"/knowledge-medium/src/plugins/tables/index.js\":\"10f65f562395fbe6\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"0d88ca4ca7f3711f\",\"/knowledge-medium/src/plugins/tables/model.js\":\"fc97e93356e8f3b7\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"a5684982995dd659\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"ab9d11604cce9d96\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"dea3b855b6e68aa8\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"eb91feaceceeb222\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"7df65627d2eea78b\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"90083cde61c13ca2\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"3074c1b416f9422c\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"b42c29daafc4969c\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"ca166286df53324b\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"65e54420f80915b0\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"357b884809c2c591\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"aa6dfd642d336de5\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"ed71c96fb697eb22\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"ef2e6607e643a2b2\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"df1e478974a12f7e\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"4a73afefad68893f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"71c2938a0e24e214\",\"/knowledge-medium/src/plugins/todo/index.js\":\"765bc6f00bb6eb6b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"440b4f80b6c7bd17\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"25fcb7c7c20ccffb\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"846d16a76100fec2\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"9e93a90645f5045b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"5fe2bcad8e959e66\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"f9a57a7da49e750e\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"f488c998135396ae\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"6544c8e5e8365054\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"d9491dba76d99e41\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"77242fada26e7fbd\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"d7dd5e7128ac2ef8\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a69f594cba663203\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"be3ec87def11bba4\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"70b5850b60b7e39b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"58a1ab34931a4651\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"1103b957c12a0bde\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"25ea908df6ffdce5\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"cfb8c0e673b75d1b\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"f8b173f0ffc136c1\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"d77a32a1839f2365\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f0e8f7d3ab20124f\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"67bb98e846b60808\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"8e26c18fc65266eb\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"82905988ae7adf9f\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"a61eeb2e3c63be97\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"3d70d47399e657d5\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"1ca2cadb4dcbda7b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"14df70a0d2ef4024\",\"/knowledge-medium/src/registerServiceWorker.js\":\"b13ab9a3792646cb\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"09b91d09c2f672fd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"f1437b9714ef7c7b\",\"/knowledge-medium/src/services/authStorage.js\":\"244f9a465347b3f5\",\"/knowledge-medium/src/services/powersync.js\":\"a54e47dd54437d6b\",\"/knowledge-medium/src/services/supabase.js\":\"4c23eb1a8fe92b96\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"0537fa25f39089d2\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"1c1efe19307249d2\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e9ddca7fc1b54097\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"85fdc2ef5e6d1b05\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"3b4c22704001d77f\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"210608769a3e061a\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"e98d73cba22d8d52\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0de954bbd57b30ab\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"e37846e375f7cf22\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"c6750c9c90bfc094\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cc10ab7dcb4d1845\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"db3d95d9edc37d51\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"ad2e5093963e18c8\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"d2376e68cea53498\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"e491d1a13c96d06c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"3cea37a9b74c7990\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"3d377ad20cfbc7f9\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"614ec2b02d21ad7a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"5ea9b72c35a1fcfa\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"01b4ee388e3ed5fd\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a1f3187af3a8e1fa\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"311e39bbf18758b4\",\"/knowledge-medium/src/shortcuts/types.js\":\"d6e3a154fbd6afcf\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"5e3c1912c607efb9\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"0c2175ac4358e577\",\"/knowledge-medium/src/shortcuts/utils.js\":\"acfe6414b3b26b46\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"695474c98020d7f8\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"c2dd8073fbc6b94f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"fbd4ce03c17f473f\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"79c0417dd59b25d7\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"7f2b95de98b1880e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"0815a5e14249786f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"09fe727879f58aba\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"4e24fcf14fb37ad8\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"a3cc1bbb0435b0da\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a87f83a03c5c9047\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ea192a017a5daca9\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"3a0c29a4595f75c2\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"97e83f5c039b96ab\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"c2c1bbbb5eb8ebdc\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"3f9ae83dd1f1afd7\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"01526a6bf8fcca6e\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"a0aa8ea26b4b69e6\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"e1fa9a79d6fcd1d5\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"d6436fc6a526b2d8\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"07cd0f8a6391403f\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"b923d30c28f0fdd9\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"ca143bcc2dd9d7e2\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"2328df4bce41de92\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"913e0744a45edabb\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"1f71f193e7890491\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"20ad2562be2bc6c7\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9ec425906bb6297b\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"17c808d65672ad32\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"ada4f5e78f989aba\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"2e82f3da286146fa\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"25bc4fb84d73278f\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"1010aff20bb85ba1\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"1e573df680a98a9d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"48f19b8611f6c21f\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1766859a1d6f2856\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"546938d3b9afa70c\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"d0ca63676b74cea3\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"dd3be9bc8c49735f\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"9579faa9afc1cfdf\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3b37aa976ecc75ba\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"df276720f6d6d66f\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3e71f7ffe14393a4\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3cb80b3b163e550c\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"97262c18a33eca5f\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"00900bf04c02f65c\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e94ce07bb172c20d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"d341ae5f85f89233\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"b9cc216742f10685\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"e3d6a5a541244507\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5657ceea495a1677\",\"/knowledge-medium/src/sync/transform.js\":\"04b814a94773a7b8\",\"/knowledge-medium/src/themeBootDefaults.js\":\"6f1db9d80dd7c4fb\",\"/knowledge-medium/src/types.js\":\"f274619251267a2d\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"d53a58603b1e09d6\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"d8cc2af2d3066ada\",\"/knowledge-medium/src/utils/array.js\":\"e10715ee9dcda08b\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"325ef94b22e43f38\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"5a6357b8aae7d944\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"bb876935829d7aaa\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"8c9d4c9c8d18a52b\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f9ae9ff7e11e1d04\",\"/knowledge-medium/src/utils/clientId.js\":\"a5c37e4012452550\",\"/knowledge-medium/src/utils/codemirror.js\":\"ed633016a34fc0e2\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"a6614d3454086e56\",\"/knowledge-medium/src/utils/copy.js\":\"c0a21657ac245507\",\"/knowledge-medium/src/utils/dailyPage.js\":\"9cc5a6342a02b8b0\",\"/knowledge-medium/src/utils/dbForensics.js\":\"5497685e1193b242\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"3a82e25bcc135cd6\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"71507bcb8b311adb\",\"/knowledge-medium/src/utils/dialogs.js\":\"2416dfba7dc0b091\",\"/knowledge-medium/src/utils/dom.js\":\"c6c591694fa0beda\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"b85959c1b415dc51\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"254156dd854153d3\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"010e4d13f164df64\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"490311525273a109\",\"/knowledge-medium/src/utils/flipSlide.js\":\"466c225ab0b73092\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2c8232547864188b\",\"/knowledge-medium/src/utils/formatBytes.js\":\"dc9d5a4a90bedd42\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"eced5b5748bf4e94\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4761d473e1114acd\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"94805d6202f302b0\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"817b525a9aed17eb\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"7fbe48eb93a6c70f\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"518fd895c21a0d57\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"ec5c76c195eb7abb\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"86fc717310f9a595\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"1fcb32adf3792d46\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"32b994570744667b\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"9223bc382b72369c\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"d292d9fa6960bada\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"b6cc50ac81f5afe6\",\"/knowledge-medium/src/utils/markdownParser.js\":\"7c86c88869c0733e\",\"/knowledge-medium/src/utils/memoize.js\":\"1be6ba4c6276afb0\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3ceee72b54f60271\",\"/knowledge-medium/src/utils/nameList.js\":\"03019c56d739b22c\",\"/knowledge-medium/src/utils/navigation.js\":\"12f2fc78141dbaa8\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"5ab2312e26555c23\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"2b080eebd820fe21\",\"/knowledge-medium/src/utils/panelClearance.js\":\"bbb0e07236dafa32\",\"/knowledge-medium/src/utils/panelHistory.js\":\"5b9c618f566d56af\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e017ca354758d7f8\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"c9766f86492f1f4c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"4f360adb6985e3de\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a8ab33a8211d7bf3\",\"/knowledge-medium/src/utils/platform.js\":\"f43c4754ed84d602\",\"/knowledge-medium/src/utils/pluralize.js\":\"fbfbcb53b82e9207\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"592e1a4a518a6eef\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"1088cbe263a65454\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"2e92d930daf3d842\",\"/knowledge-medium/src/utils/react.js\":\"d47a6285c6798b70\",\"/knowledge-medium/src/utils/relativeDate.js\":\"aac0ef89e2c92162\",\"/knowledge-medium/src/utils/relativeTime.js\":\"b47c46ab52b1f86e\",\"/knowledge-medium/src/utils/renderScope.js\":\"e9f88e2d5c69a44d\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"36332740bcf4abfb\",\"/knowledge-medium/src/utils/routing.js\":\"7e97a2629422541d\",\"/knowledge-medium/src/utils/safeMode.js\":\"c6f12e38c7745988\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"a1bd367a777c5d33\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"419dd47fe0c827bf\",\"/knowledge-medium/src/utils/selection.js\":\"ead2831bf39c7bfc\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"eab3b33b6cf63300\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"d6a00f0199ef56c8\",\"/knowledge-medium/src/utils/state.js\":\"82d838fa8297692b\",\"/knowledge-medium/src/utils/string.js\":\"0c59b37acc14059f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"015622347b004f07\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f47a77655c5b7c6a\",\"/knowledge-medium/src/utils/toast.js\":\"4e8fc1ba410befab\",\"/knowledge-medium/src/utils/toggleStore.js\":\"37d930a43a9ae1b3\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"422dca6f483bf2a5\",\"/knowledge-medium/src/utils/userActivity.js\":\"ef5532914f712521\",\"/knowledge-medium/src/utils/viewTransition.js\":\"a94467e91d9543fe\",\"/knowledge-medium/src/utils/viewport.js\":\"0241f43c7243e079\",\"/knowledge-medium/src/utils/webLock.js\":\"b57b58112365f1bf\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"e2f3fea42744b4b9\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"2e8d84a399d3b37d\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"10f80da086adc5e2\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"3e7888c3c2238cb8\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"cb3101e4c2cf987b\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"1003b614e36e9097\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"11f9be451d91ad98\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"bc94d65f449d9b09\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"3be49b550ab94f75\",\"/knowledge-medium/src/vendor/react-dom.js\":\"42b8babea020b13a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"03d3de46258a0965\",\"/knowledge-medium/src/vendor/react.js\":\"645870543e98fcd6\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
