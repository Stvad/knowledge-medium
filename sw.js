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
		buildId: "3b30510a8dbf-2c8011d6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"b28f095af97a9869\",\"/knowledge-medium/index.html\":\"b28f095af97a9869\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BDPhr5j0.js\":\"8e9651ab89e4c225\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0490d3fffc6a97d3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DefgourV.js\":\"e91156dcf152f1f9\",\"/knowledge-medium/chunks/FacadeVFS-BdoD9E2v.js\":\"147ea7860b907766\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-TWtvntwL.js\":\"7f8ad0bd635c0997\",\"/knowledge-medium/chunks/MemoryVFS-B2QJOC_C.js\":\"a52d13120ba707cf\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Ltl_EO2o.js\":\"6d58da4e145ec893\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-C6tx404R.js\":\"7abc8e77ca33315e\",\"/knowledge-medium/chunks/Preview-vd79DqXM.js\":\"3a7d4db738594af5\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Dxhjfl70.js\":\"52d3b72205cb8bcc\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-EdGQUhV5.js\":\"37e44ae82663f019\",\"/knowledge-medium/chunks/freezeExtensionImports-B6vxbec0.js\":\"a71ddfd206f43bba\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-AHNNLGXF.js\":\"a58ad7229a95ddd4\",\"/knowledge-medium/chunks/react-B26DtUsC.js\":\"ca6310e2db6600cb\",\"/knowledge-medium/chunks/react-C-H6JGEa.js\":\"90ddc1b8f194adb0\",\"/knowledge-medium/chunks/react-C3yCwq1a.js\":\"60b4cce2b76dbb87\",\"/knowledge-medium/chunks/react-CQvxlBgu.js\":\"00873cec18d00877\",\"/knowledge-medium/chunks/react-Cauj6gwE.js\":\"c5e71bdb1be552f5\",\"/knowledge-medium/chunks/react-DOQNLpg7.js\":\"c815289f4cda0ddf\",\"/knowledge-medium/chunks/react-DnjrNGjG.js\":\"0253f9b3b39ff389\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-rk8rFZzt.js\":\"785d846f25695f88\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CVkEHP5q.js\":\"932c092a62fecc60\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Czs7J3As.js\":\"ace730bb1a50f4aa\",\"/knowledge-medium/chunks/server.browser-DYJGrfXZ.js\":\"50fbcb9611cdc240\",\"/knowledge-medium/chunks/textarea-CItGNrrA.js\":\"f693ec844a68c687\",\"/knowledge-medium/chunks/ui-CN1z1C8K.js\":\"a711deeaa33d1dd7\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"2bf49613bec1e083\",\"/knowledge-medium/src/appUpdate.js\":\"3db5caa16176454d\",\"/knowledge-medium/src/appVersion.js\":\"e31dfc15d4eb78e2\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"e027dbe5cf7a5b5b\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"7cc6025b046383d9\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"d6b5db979155a712\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e21b7a5c30134ab5\",\"/knowledge-medium/src/components/BlockComponent.js\":\"8f5607d584038410\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"f73316a12fa9e517\",\"/knowledge-medium/src/components/BlockEditor.js\":\"70c363afcdce1b75\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"45f12d1f133155bc\",\"/knowledge-medium/src/components/BlockProperties.js\":\"2a4d49a844bae560\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"85a2932cd7603889\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"76d11dedc929123d\",\"/knowledge-medium/src/components/DividerHandle.js\":\"73d3074b778eef48\",\"/knowledge-medium/src/components/DraftEditor.js\":\"433bcf6e2724d640\",\"/knowledge-medium/src/components/GutterPill.js\":\"6a792efd018ddf07\",\"/knowledge-medium/src/components/Header.js\":\"2c68b59f3c48daab\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"cfdf4f9ec17d6b94\",\"/knowledge-medium/src/components/Login.js\":\"ac8d7f44fde3f85d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f237c7d0f19fc9eb\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"ce4d02567814c6e4\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"767565848318b8f6\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4e66a0f2eb00307c\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"a50424c4eea8ca4c\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"210eee135f71d96b\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"1f27b4abfeb31f49\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"89f82c5fd7743bed\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"189fc345539d0c74\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5303c1d47af92e99\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"69bd3076fa58d800\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"5f92828eb13ba91a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"e29ce51333ff02df\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"4b8de69f18478ff8\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e25ca4bd44788a3d\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"1e6efc410e9801c3\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"6224e77b5852a27c\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"7a222c8d7d8c8e87\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"357622b4c027c6c6\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"bb60b009622b5b69\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"b90248a1c8835c39\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"37466273c4bdc10f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"dcbdaab20a6807cd\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"647e128f4752d0b6\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"5165fb676641ebff\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"5c9bdde3322dbebb\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"dbe5ad2f89c900c2\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6c62f1e9690fd730\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"5f9fc66aeff924e6\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"323089a95078d2ac\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"f25abc1873ad8e92\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"5003e3c02e314d58\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"5261e53839c3c7da\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d05dc8b9e633f081\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"5926f714950c33d2\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"3792c2aa550760ff\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"a8e961ac138aaa93\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"426aa5606817f939\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"537f55b1929b1023\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"56cf349d51c03f3d\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"677036e5a412f6f2\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1576d04a15d656ff\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"d63257032f007067\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"72ac33a01898220e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"52d093710f45998e\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"e4bf05a7765c3ee3\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"afbe1c2f84faec94\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"b13e5b80319e1c26\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"0467c79fcd7b6ccc\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"35b3b5588289bbcc\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"b68fe50fba473d1c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"fd3018ab9be856be\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"999f67e4d1f4b72b\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"fe90c43991566f31\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"0edccbef20e90a69\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"e0cb96f56b7dbf90\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"cb8dcae6cc4f6a09\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"f7191843998b9e8d\",\"/knowledge-medium/src/components/ui/button.js\":\"8aff905c55ca69bb\",\"/knowledge-medium/src/components/ui/card.js\":\"aad10a8803762ae3\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"151ac3048165a60f\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"c156bdeb5f5ea524\",\"/knowledge-medium/src/components/ui/command.js\":\"ef4bba8551d87a0d\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"f39d7ef9658f3917\",\"/knowledge-medium/src/components/ui/dialog.js\":\"4a14294148ed8f84\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c875da68c2e060f8\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"79350be48e258fd3\",\"/knowledge-medium/src/components/ui/index.js\":\"e5cdfbef301c2ccf\",\"/knowledge-medium/src/components/ui/input.js\":\"875e60340fbe86ea\",\"/knowledge-medium/src/components/ui/kbd.js\":\"195367837efeb543\",\"/knowledge-medium/src/components/ui/label.js\":\"62fa70bf82697b79\",\"/knowledge-medium/src/components/ui/textarea.js\":\"11340ad2f1fc9c5c\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"b5023bdbc57428c0\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"64d6aa406afdc17b\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"56ae609412b27650\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"5f283b7952f27ff4\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"2109b19d3d02d71f\",\"/knowledge-medium/src/components/util/error.js\":\"5ff214e46d8f94b9\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"1744b4297bec093f\",\"/knowledge-medium/src/components/util/suspense.js\":\"85b716668643116b\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"c998333cc96c171e\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"35442a6bbd153496\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"b211ac343757ec4c\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"574420c3668ef6d1\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"dc918e87ea93e362\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e63f3c8ff6c18337\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"c8c7e4d4e87b4cd4\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"22c65f99e105be48\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"a0cbaa4686afbe63\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"8f6aa926aa903996\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ffd6808732e2268f\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7324294804400abc\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4c3a15dc934d6dd3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3b0cd068216e5db2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"ff4af82ca21b1221\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"33087c673a3008b6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"503dd95c7458f684\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"4a99a442bc0e587b\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"adfc874c69601205\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"5b590268e999902f\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b62a8aaa142164f9\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"ebf6e08bea20708f\",\"/knowledge-medium/src/context/block.js\":\"9f36f44204cba7d4\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"46fc7519537a94ac\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"d12faa87a6d701c0\",\"/knowledge-medium/src/context/repo.js\":\"ee06d882f7567025\",\"/knowledge-medium/src/data/aliasClaim.js\":\"286dc6d8f4c73855\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"f87fc37a036b24ef\",\"/knowledge-medium/src/data/api/blockData.js\":\"55fbed7bd1fe2ec3\",\"/knowledge-medium/src/data/api/blockType.js\":\"cbc84f3a08a41885\",\"/knowledge-medium/src/data/api/changeScope.js\":\"a55dd7d80c1e1465\",\"/knowledge-medium/src/data/api/codecs.js\":\"f1db9405a16b6c06\",\"/knowledge-medium/src/data/api/derivedData.js\":\"bb9d48bbd93713c4\",\"/knowledge-medium/src/data/api/errors.js\":\"3dcfa8dc9e8f1b36\",\"/knowledge-medium/src/data/api/events.js\":\"dff3e0e01b936884\",\"/knowledge-medium/src/data/api/handle.js\":\"f0560e425ea0267e\",\"/knowledge-medium/src/data/api/index.js\":\"9537243709552071\",\"/knowledge-medium/src/data/api/mutator.js\":\"c8728e4120d85669\",\"/knowledge-medium/src/data/api/processor.js\":\"00be459350bd5d5c\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"11c9edea754ff455\",\"/knowledge-medium/src/data/api/query.js\":\"b089136e49b5b948\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"5c76ed5da9514cb5\",\"/knowledge-medium/src/data/api/schema.js\":\"f0560e425ea0267e\",\"/knowledge-medium/src/data/api/tx.js\":\"f0560e425ea0267e\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"b280253194294f4d\",\"/knowledge-medium/src/data/api/user.js\":\"f25f944f6fc93e5b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"578350e5a05f75e8\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"8a43c4dcd0757a4b\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"572965f760b229d1\",\"/knowledge-medium/src/data/block.js\":\"5c67ba177e70bc5d\",\"/knowledge-medium/src/data/blockCache.js\":\"1a7d65fe66a12c32\",\"/knowledge-medium/src/data/blockId.js\":\"6fa130c35524e76c\",\"/knowledge-medium/src/data/blockLiveness.js\":\"60b5eb5fc416cfb6\",\"/knowledge-medium/src/data/blockMerge.js\":\"94a559cf059f5f26\",\"/knowledge-medium/src/data/blockSchema.js\":\"9245e179016ffe02\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"20fc653969360e48\",\"/knowledge-medium/src/data/blockTypes.js\":\"973df93793bac765\",\"/knowledge-medium/src/data/childrenView.js\":\"775d15b44305be45\",\"/knowledge-medium/src/data/clientContext.js\":\"72764d4e2cc4cc0d\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"c5c418fc5e0032a6\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"82bc95bee51d107f\",\"/knowledge-medium/src/data/derivedIds.js\":\"6907292668dfc5a4\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"a157f0bbd247fbd6\",\"/knowledge-medium/src/data/facetBridge.js\":\"6598eb00422866fd\",\"/knowledge-medium/src/data/facets.js\":\"b61de3a589b7396c\",\"/knowledge-medium/src/data/globalState.js\":\"d44b23f97a5d9189\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"4f1b8473c81b04ee\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"555269a4cdc36a1e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"d2956c802914ed02\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"4fda0dfd65bd72f7\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"611ba070412bbb22\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"289e08bb7ea8e6f1\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"fe2c56f10baa5c86\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"1120cd51de19eebc\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"366210b2e9f6bfd0\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"5dcadb56c34c60e4\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"cdb9487dbf541f0e\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"3adbe595d1cf9d5b\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"338d5b738a6dd6c6\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"f50afacd24b683bf\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"8161d783e31303b0\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"6a793a878883951c\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"7e8a3fc9c5c51e91\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"311a630b5814b895\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"dfbbfdf29f7b21b0\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"93e12ffd5cf1e718\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"352dab397c92b644\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"c0def8243281ce30\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"b952773b3c976441\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"0c65984bacd50690\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"edbdea4aaa1811e4\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"0869e26ee69dfab7\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"ce0a3cc4ade62eff\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"46bcf8feb92597f7\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"c3aafa96250d0e65\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"d820f209ac037968\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e5b4002734da5330\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"0d1c4650ef566052\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"d1e512c8960b320b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"79c3a14a9061147c\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"b0f3e00d791843b7\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"341b54a712da9ff3\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"987a831f80969c3b\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"7d77c1035a2c6573\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e63fa9e490ba0b6f\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"548103c4b191e1b2\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"dc4fc0a1d5b7150d\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"acff9041813550c8\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d7d788232be05537\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"b970a63cc608e9c7\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"a1ee88918bbfc1b3\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"8e038beae20a80eb\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"8649510f403bf60c\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"b2ab22c640601209\",\"/knowledge-medium/src/data/invalidation.js\":\"1b193e1c2b083c54\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1d008be2c5ac913d\",\"/knowledge-medium/src/data/kernelPage.js\":\"b81661cf7a74ef82\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"2db62f9b95c35010\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"e0e5e3894534d753\",\"/knowledge-medium/src/data/localDbStorage.js\":\"a606747a842e475a\",\"/knowledge-medium/src/data/localDbVfs.js\":\"7eebb2b8218aa4ea\",\"/knowledge-medium/src/data/localSchema.js\":\"f96496fc5750ab31\",\"/knowledge-medium/src/data/maintenance.js\":\"7fb13544b18e7c6b\",\"/knowledge-medium/src/data/mergeProperties.js\":\"0e878b20ff4e49ee\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"865b049946703716\",\"/knowledge-medium/src/data/migrationsPage.js\":\"83efa956c1eee660\",\"/knowledge-medium/src/data/mutators.js\":\"8ea22e5064a8ce0f\",\"/knowledge-medium/src/data/orderKey.js\":\"c69d864dd171f0bd\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"b075c742b2b81c96\",\"/knowledge-medium/src/data/outlineSurface.js\":\"d8cc75e4c1e9e106\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"1168090081c73432\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"ae67674c3e613e07\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"f4dbf3e84fc35e48\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"a575adfadef2f02a\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"6be4ecf89c9ad217\",\"/knowledge-medium/src/data/properties.js\":\"0984c74b6329fbcf\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2a2fef32707938a8\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c59174d65e9d428a\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"5fdfae879959c4fe\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"76f3ddcb8c4fdb0b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ada501a1eb936b4f\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"71e75d3890cf2aee\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"6ef5995848c6a921\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"bedfbb1d7d89fe81\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2e6aa0b00a32866b\",\"/knowledge-medium/src/data/recentsPage.js\":\"d83f3530978d5caf\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"cbc61341a560d45e\",\"/knowledge-medium/src/data/referenceBlock.js\":\"4c419e3cd59b508c\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"23e05c86a184dd6f\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"3e0eaa78b65dfdc4\",\"/knowledge-medium/src/data/repo.js\":\"056c3d9bc2e4a819\",\"/knowledge-medium/src/data/repoProvider.js\":\"13239469804ad508\",\"/knowledge-medium/src/data/rowProperty.js\":\"172b763338ea46fe\",\"/knowledge-medium/src/data/searchFilter.js\":\"aaecb8059da95e57\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e932162090ea4740\",\"/knowledge-medium/src/data/stateBlocks.js\":\"725fb725c39279a8\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"a0c9f9c7134a89dc\",\"/knowledge-medium/src/data/structuralInsert.js\":\"9b49e88506f95399\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"572b7a2394a6e2ca\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"af3885a13e05bd3d\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"c6ddb62964c132b1\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"466214e2131dc58d\",\"/knowledge-medium/src/data/targets.js\":\"96960ef5515b804a\",\"/knowledge-medium/src/data/typeColors.js\":\"6c05e3c40569e6dd\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"8fec444c553b9cbc\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"24aa03d8f1c52ce9\",\"/knowledge-medium/src/data/typeExtraction.js\":\"0bee6f1c9c78ef5c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"9046a930030c0c57\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"fce259078b5a20f6\",\"/knowledge-medium/src/data/typeSeeds.js\":\"9dff13c6e1054943\",\"/knowledge-medium/src/data/typeTagger.js\":\"0ee2761734f0db70\",\"/knowledge-medium/src/data/typedRecords.js\":\"b35a39e14364b272\",\"/knowledge-medium/src/data/typesPage.js\":\"7e14f059cad475e2\",\"/knowledge-medium/src/data/userPrefs.js\":\"303d36bc06ff0b6b\",\"/knowledge-medium/src/data/userSchemasService.js\":\"6e819a87bab7b883\",\"/knowledge-medium/src/data/userTypesService.js\":\"db0348475738e84e\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"11c618167df09227\",\"/knowledge-medium/src/data/visibleChildren.js\":\"1d856c8a8aaf90ee\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"e518cda48b5127d7\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"df4b515a794e5d07\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e46e9417d98f7046\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"5db3c26c9ad5d239\",\"/knowledge-medium/src/data/workspaces.js\":\"5928cd7c1fd10665\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"fbe6a8ac07a045e6\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"0e2d6928728916b9\",\"/knowledge-medium/src/editor/atTrigger.js\":\"a30c1e06eab08f9b\",\"/knowledge-medium/src/editor/autocomplete.js\":\"5cdca86dcd497882\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"c80e381de6c0f892\",\"/knowledge-medium/src/editor/contentFlush.js\":\"bd6265c1a4be0911\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"9043e3d219f815fa\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"f37cc5f03f0e7410\",\"/knowledge-medium/src/editor/insertImage.js\":\"fabbee86710ac106\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"933e36c66015b7ed\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"7b394c489b238953\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3d0aba986dea2cd8\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"48345f03694d1119\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"330ea807b787a6dd\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"5d805e870da89d74\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"1e522fa28860d15a\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"71d98127648c6f7b\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"ef9d088796528fdb\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"e80b99159272f8ed\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"a2a30fe9879e9e30\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"80a35947e286c1f1\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b45ce3a0d6c77e11\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0b374daa8c0a95d9\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"4b2569ebfe5acb85\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"cb4195d9b881193f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"b251622a4f879ee2\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"741295727c5bdde2\",\"/knowledge-medium/src/extensions/core.js\":\"e24bdef282a375e2\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"5578cac4ba8c36c5\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"95259dc15eb32a94\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d7e8c5b99b4b7aa7\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"3a25640ec82801b6\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"bee515083a17e69c\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"b2cc01f45a1c017d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"8ec49237a2981360\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"40674e37cae807eb\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"cf7e7cc19a6d2e8d\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"05e49cc778c6d724\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"18a69ec703c8260c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"cb9e7bebbba9a620\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"282d9e49b52aa9c2\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"fb19f626da23fc90\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6556f44db09a263b\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"89603fdd57dea102\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"a24a3e209e34086a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"e6a08a0dd20ad061\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b504ac4bc96f7d7a\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"57568f6fa9f72eec\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"f01dc2f20d4fcc01\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"dddb74554dafdc0d\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"27a9832c7edd3f02\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"c0729ae31557bb69\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"70a5676ef0c3f334\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"00dd9da8497d8542\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"102094743c522541\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"f3981f40088bf0aa\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"c489bb0e978ab17f\",\"/knowledge-medium/src/facets/facet.js\":\"115d253d9d83de5d\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"67bf7c7b8db30d19\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"45a5b81004c5bcc5\",\"/knowledge-medium/src/facets/togglable.js\":\"a59acca6c6d7e42e\",\"/knowledge-medium/src/facets/variantFacet.js\":\"e417ee163f0741ae\",\"/knowledge-medium/src/facets/verbFacet.js\":\"1ad684754d895253\",\"/knowledge-medium/src/hooks/block.js\":\"dde54452b5519f74\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f894cbd799c84da3\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"90be82fe11ae9ed6\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"232ad65b0fc04bd3\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"bf4039ff4fc3d2f1\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"27b6dee427c19b96\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"75dbbb72f3254d0e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"ebabda04022172e2\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"755142a1f6eb0606\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"f4abda602082eae7\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"deb5f90d696c66e8\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"8af86ad641616249\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b545861173a141fa\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"57b7dac0c3382285\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d495b8ef91bc8759\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"780f06a9d6a17eb8\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"0e09b1f196a555e1\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"88408566518e862e\",\"/knowledge-medium/src/lib/utils.js\":\"16891584e401a369\",\"/knowledge-medium/src/main.js\":\"3542d2e0b7565d8f\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"fec98e5f11bedc42\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"4079af4904863f7b\",\"/knowledge-medium/src/markdown/context.js\":\"aaad24eb599ac6d0\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"79a77ff01a194525\",\"/knowledge-medium/src/markdown/extensions.js\":\"1c0394acb6c2bae4\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"4e0c7a56918df962\",\"/knowledge-medium/src/minimal-editor.js\":\"a2b5729772d23674\",\"/knowledge-medium/src/paste/armedCut.js\":\"a2eb5bfff4e34cd4\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"5b022ec85e40f36d\",\"/knowledge-medium/src/paste/clipboard.js\":\"0975f49b37059a88\",\"/knowledge-medium/src/paste/decision.js\":\"a0319647bacb2d4e\",\"/knowledge-medium/src/paste/operations.js\":\"22a1629f011efa55\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"50e0f9d72ae4d097\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"4d3d5c35b5bc3f80\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f43c703d457c34a6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"52d9562deb1d3b7e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e64e193edf6a2030\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c0ae32aeef504fa1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e83509b91622779c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6a0a46ef41033161\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"685588013be4f8be\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"70b1d874f94a6096\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"bdf2e72862f51047\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e9234e7c2d722056\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2a45e70d36e70107\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"76c52ce12273ee77\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"718ea66d3f86edb3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"f13b76f6fa19b250\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"ca38a09e119df007\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0a45aea674258b6c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"382cc5a112202afa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"df5b35b9724078df\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"513e0a92de36fbec\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"8a8314937b765800\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9018c34318621ace\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"283584533ace5fef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"6836c23cdf4b3737\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e504306f12d0c5eb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"955f05bcfebba130\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"c555fd2f930b98fc\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ad1b99a19a422e24\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"d9bfd179c88d2273\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"4dbeae4c52734425\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"c088bd4398329317\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"c64fb4283127e90d\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ef87add58b5ccddc\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"af4eee05a732c603\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"fccde31b6d98fb28\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"7f476300b38f7d8e\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"5e582907a2492387\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"fdd82f77e380a263\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"dd583f26396562b7\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"43bf82555ed844e7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"b544cd49eb4eb36a\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"31e1a7df24ee1080\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"9e46cf9991420efb\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"df42208a15c6a0cf\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"81fa35b0cb6fc296\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"b18f019a3f01bfeb\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"00e487a2fc92794b\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"15d1c57f2ff65095\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"499407d51ce40ac4\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"9d4dc96a59423920\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"a49b7a820cceb62a\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"3a5adc867fe05272\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"1418a85a3a3ca8c3\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"ac9a380880982a1f\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"ddbfd0f747c52bbf\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"89df20805100986d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"93cf5892b879dc48\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d5494ef7bca98359\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"0be3408f44a58fb3\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"493ba9c0cb2d03e0\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"1612eba752447bfd\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"74dfbcbd52712996\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"0c0f6a06251ee9d2\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"8ecf972fb6edacf9\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"a6cadba5c703789e\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"36fa91eae61c93ae\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"7518cfb8430166d1\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"5b961b762be2efb6\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"997cb379ce82cd85\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"dfafae287b0687c4\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"2bd12e8f36ab4d77\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"e4af3e3581bbafcc\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"a9efbc40c12b6f16\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"7c38186c855ad2be\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"46accbee21880810\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d0ff04028b10925a\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"4142a98800752d82\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"0b64e957540c9135\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e7eba19d5a6ae8d0\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"81adde4112d364f9\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"9a2e8df7b37405b7\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"24cc221fe4218dc5\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"ed3bb18227be6978\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"c8a7763a3a2609a1\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"884ee2a5951062dc\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"6c6602768036f5fa\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"6d83e633a17b35fb\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"4475e6c8178eca29\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"14af67fb291cb551\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"f6fdae6c4c3e5469\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d36e4384e349ab2b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"b985c5d78cb16239\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"0e94158f7c586111\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"153997aac7362f88\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"1027a081e4bf7ac9\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"42734cf5a0f1db54\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"4fd73ab45c970217\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"78bf38061fa6bca1\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"42414da25c525755\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"cb18e361307beaba\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"a8cbb73b9c6044c0\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"9f37366a8e4327c1\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"ca0ebe6891421ff6\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"962bf236aa61678b\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"85085afd1856216f\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"616430b28a5b2c2f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"e528938b81add7d0\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"238afef90d6f8d3d\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"de3f98a03ba3299d\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"109078bb6cf08842\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f16c14f4fa01e630\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"7680429cddeea54e\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"560ca01f8dfca154\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b548af1cf1aabcc9\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"59903c0ced9ffa55\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"2a6b6f8e2c98f138\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"3435106da6ef6bbc\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"44e12f44a3ac1f08\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"715b122557f916e9\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"1701310042f15790\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"5bfd5fd80063def3\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"93f99c4e9a5e868c\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"f1a1dc815f32c380\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"96681f5c731407b0\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"de194b9fef058c7a\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"aeb263585a7a5c1b\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"7925541ee3357ca7\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"21182ef707a30a52\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"fffc80f3096dbc7e\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"ec7f26cea903b503\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"3469275bb17fdb4f\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"df7277de81eebbfc\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"ebe61ac5f3651a63\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"b4e0b4892bed341c\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"ba1406dd162f281a\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"ecabce819fb1759a\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"c77c4891a794b2b4\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"69dde351047b6350\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"68178926347f3b93\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"677872c9d0a167db\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b363c553ae171313\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"49805fc3271b57d3\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"076633c51ce6c104\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"59f4c005db055367\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"81dc3362cea3131a\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"d2a8d1b7b78a5574\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c3257b3dbae86dce\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"e8b60325c9732636\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"e3234e127a53a9a7\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"95b3deead51ff31f\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"85539d8282c3edb3\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"beae299d603e9e2a\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"f29ae49d59a98d6e\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b94bf6739d56fc0f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"be38514fe79b2c25\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bae2eb6e22115e00\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"bba94a9a2a9a43cf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"07604c80131389a4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"84ec003b64938c4c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f7704602514edc1d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4c4e594d0b53001b\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"04ae30e38773ede2\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"5837918cc4211600\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1ccf4095eb082587\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"5bcba786228ac430\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"0df3e32ee7effde3\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"495c80b4ad48f94d\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"cbedeb48dab97c35\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"97d885c72a223d46\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5831c63b4375dffd\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"5256b0ea27ac6e1c\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"9718dd8ad665c237\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"0fc3c044cf427f1b\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"8df821e43586d31e\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b86eb86f8171f995\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"da5e749a13de57a5\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a0f4b84c49293145\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"dca11e81b3043d9f\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"3638b6f9d728505c\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d7490fe54558240e\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"ab722b77790a6ed3\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"b55f37ffad83a81d\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"e023c585f1f42068\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c915505ed39bcc2f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"890b25ed13a035f7\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"cbef7636ee71f08f\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"78d24f11927d953a\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"0aa9961a10242701\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"82d607a1623742dd\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"9864f41e6722582b\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"ed2f81400f32a21b\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"139ead8a6e2cba8b\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ff7b307361f383f7\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1590bd92398ee4e5\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8bf906d729c1ab79\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"615f123cfaf987d9\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"b47da6ce42dc3321\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2c9e358cc21e527e\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"713b20499dc3cfc2\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5b66c882665bf01a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d360e9480f7bf6c6\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"f4d5ffd5a3c89136\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"53671c9150d8231b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"9c60362598272628\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"8fd488db5cc63dd5\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"7c21d174fd77c3ff\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"168ebc958c27bc99\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"33dc6252545c7489\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"197e14154e668e4f\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5e6306797d01d925\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f784c1d4e71f3539\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"2e60fcc18a0c3851\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"5ef18f73a1809e01\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"60df3f2e36c5bf9f\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"8813b8657a9925ce\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"c1de967f0aca49c2\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"3f641c05277ef7e9\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d9bafc911afd7dab\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"902977d255a286ae\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"f73a1a181a9a237e\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4bf0d59b295b4348\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"96a463ab34e9f21b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"ddeac029ed31ea07\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"94b1623acb01baff\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"619cc860d57b9bd1\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"45c51d079de2e1d5\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ce05147466abf6bd\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a56bcdf3f7300267\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"2f4b0c98de0b49e8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"08ba4e88b4de86d4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"67d01e23cb7878c8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"1601a4ede250f853\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ee29efc869cdf97f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1a7704a577798457\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"9a8d5c6a441a38e5\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"61b0135bdbb6dc23\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7ecc14089d34b2e2\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a419f929f8d8c1a5\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"5372d5e0c2bbaeb5\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"e876703631f44bd0\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7da4cad92884bee8\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"daa0a335dc63be45\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"416046f95ba136cd\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e77c5e443a6db277\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"8adfaf2ee58ae97c\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"abacdfb9d08f6ba8\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"07645fc30550a1d5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"dcfc85bdbeca6a5e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"26795eddda1faccb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"89a79fc327027582\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"bee4680f4d7ce5b5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"469c54024277ce7d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"90787a128ba3b37e\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"7231da3384df4e0b\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a4b970803edeebed\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"f2462ad6c4adddae\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"3a8eeac2983c7386\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"34b036ad134e4bfc\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"f2e81c39c3b01cc2\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"56429d7247367f89\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"a47f71841baf5656\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"14c5a57419d674db\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"deb08e2fde7fa668\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"2e093bb6bb4b18da\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"e0515a3ecf961cba\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"53740bbb95a42642\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"00b8b2475fbb4471\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d8e8bdb255a90d15\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"8da91e3c5844053d\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"f9640188c9a099fc\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"f3b1a46048e457b3\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"66c3e02e4da6d783\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"62eae1ab18b5f63f\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"6973650bed26a2c5\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8effdba9078871ae\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"b9a4b2ba364d2a11\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"351bd54b95f11083\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"4099e248a5b06afd\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b9713eb49904750f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"8683a67ca4595c16\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"702059b8f3b04917\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"2192b3def0946850\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b08d212bfa80df95\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"61c2264feab1b1bb\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c7b5003fcb6e7659\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"e282b787ca7c6177\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"c64083c072c2a3c6\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4e98ef755afdb122\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"8ccb34de1d84c978\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"b99f604be7cc83e9\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"3958e667c3c3f1cf\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"f0588e2b67736bc5\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"6911ee2016fa8663\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"1cbbca1b16f3cff8\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"0d882c0b644b4fa3\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"930bf91dce6e410a\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5966856af35e6731\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"4eb1d16335c439af\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"30fcbdc1b9f1da4d\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"664d0a64b23abcf7\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"8739965db0dfc12e\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"9e8e15186460a1ae\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1fdc0a5c5491b28e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"63ae0055c3314ba6\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"f7efe56a1d7ececf\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"dab1e20a54587a21\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"210ac4a34f4c883c\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"40d7a6206c52021e\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f2787102a36b2b22\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6e856e7212e03ad3\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"90cbc46fca3b9cee\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"478d8735c0ab3547\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"da56f024469e0695\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"dbae08650af71ed9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"9e14cd6f78ed6784\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"37552ea974f09ae5\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"a4b278433b0ca7cb\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"9bd9694c0915d26d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"6b67b26439dcc8fe\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"54c004dc81679cbe\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"b7b142f60f6bd1f1\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"15749ec8004fe1c4\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"0a1b460dc2cfe753\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"374fdba205cc1dc8\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"19e2345139a1ec96\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"a6d761dcc12c1983\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"29f8b78cc70ffcac\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"a218b5701e2007f8\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"5eab5faeb6fb836e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"09460ab12c279b25\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"d87e23a131ccec2b\",\"/knowledge-medium/src/plugins/geo/index.js\":\"4e4123ff75d80f19\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"a01bc8c46d1ed841\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"6cdc6d17474295f7\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"8d838535726dd900\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"76efae6a62fe151a\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"bcfc3f8fdb6f40d2\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"d019ba4e38f0a203\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"2031766aa9f061fd\",\"/knowledge-medium/src/plugins/geo/query.js\":\"8ab45eb57b0bc5d5\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"9ca11aeb61d75426\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f945424a9958110d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a192ab7ab7014cf6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a90d4c2e6f034cf4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"9764aa8e28672382\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"2cdd8c9c7bebbb04\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"b1a13bac9f64844a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"d49340fd7b6c1fad\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"41deab3f591c729e\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d6db3aec62cad50f\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"222564b3b5f4c9e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"ce7a20ee3501655c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c5435d6c51747abe\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e82f83edabe6d1c0\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"f5be1e79f8492899\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4cce6af802ca5bd3\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"39b19dfdd4824347\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"945fa833618e76b1\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"ef99d8319b15e756\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"13e1c1e30e660f3e\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"a274e1c91b28ac4a\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"200c1603210e3454\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"53672d66cfbbbc8d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"72b0c337a6b5b7f5\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"92a1e6efe096ce47\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"108ca61724a9937b\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3de20f0e232c1f4e\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"51d74bdb9f2ea354\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"e4e5ece093fc53f5\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"6820d9149188b465\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"3f872815558b6fa1\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"a98a8bde769d7f0f\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"dce625977d975ce2\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"781b033b8c78914b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7ffd661ff7da4223\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"9e676d062de7fae0\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"8d3fe914970cc942\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"00c639854df1cd8a\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f0a78f4abf2d3fdc\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"288467757de7ce5b\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"5c8d45b602a71651\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"0efe5c6380891e79\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"780c9995f807fe9d\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"867dc735b73d4fff\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"18c85fcf54e88e69\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"5f5035fc89bd0577\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"ae14c7b71d036232\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"f06e9971f711b7c1\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"338f0f88b6ca0e98\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c40991f47bc70eb5\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"43764c1be9c1e895\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"d5d618508a9dcb4d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"935a64607f28014e\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"e3f37ab172de93b5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"026ae8800c3dd947\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77e58e4e288deb53\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a11f24ed5bc74785\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"498003d6f87e45b8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"68d0cd68d37fee04\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3fd90d50b72eb820\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"b1b9a9da60808fa3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8ba17224fc562f72\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c972f120b993b30e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"58f8905871fe7eab\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8118146bef9527e5\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6e7034b539f18503\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"c4bea68f57aed6cf\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"687282e524db1929\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"b3b3a15439919902\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"caba43e6b7581c11\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0b58f20dbff2e5c5\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"9eeb10a1d7d5d326\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"455806166829a61d\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"33e90210012a5531\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"4889d976e125a509\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"31b3301c1e1d1eab\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"cd1cfd3b38c344bf\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9fcf7a0d14aa9597\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"574f39456d6cb8b3\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"c5a6862f128d9cee\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c5969cb33266009e\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"e548d62089491b18\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"d002460c5bf1e94d\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"c2e457cf74e0b12f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7476e1d7eec6cd06\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"80814c8f8cabd002\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1e0d5b50d408f83a\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"006d945d31d7abf4\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"4761fd248647f7b0\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"16042f40f022724e\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"fba5aef3faefa413\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"2f7b726a9bb7d81f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"9453d90d793a99f3\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"3585dbe8cb7eaadd\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b5c1256effdbaf8a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"f4e434df9b8eda2e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"90e11c3f68f76638\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"c57dd7c375105449\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"8cf98491b6a2d907\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"79c24a77349a14f6\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1e923b9cef0b28d7\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"0b02b22854d32490\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"2890eef056244101\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"f5c0b20b50253aa1\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"1300c50db714ee33\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"366e706d6d7c9390\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6e9c8e8ccf056afd\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"cee9451369d98381\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"86fba012f8acb437\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"d3c270bad2398a04\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"0496fc93856bffad\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"3ae85079e0660d10\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"3da4c090c8db8018\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"661e898fa2ff1a2c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"d442558965b12019\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"1ac8edd6d58c7ce3\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"ff13c01e4b783b37\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"c5aa63a1304b9e79\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"6ac9bd565d8a0a0c\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a1021f7ce1957892\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dbb702b13454476c\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"0a3ec0ff1d4ac9c3\",\"/knowledge-medium/src/plugins/recents/index.js\":\"a75d360703cfb8bc\",\"/knowledge-medium/src/plugins/recents/target.js\":\"d718e52c4ce02b77\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"949b31111e600805\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"30ac0814c947c6a3\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"985f3c5631287427\",\"/knowledge-medium/src/plugins/references/index.js\":\"05ec7b52373dba81\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5381071bc62e3baa\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"80cb9fba8de3b061\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"91955efbfe6ec482\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"4d54a54933a21e23\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5e25b7bdf17f070e\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"35a9c9e4ef1cfc28\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"0a6ec8181ab02d64\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"768c81c7dc012f41\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"53b6bfa9ae3648bf\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"8b5e619a93992945\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"76db34f872496353\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"01fd2832237f724f\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"5aeca54c205ecbb7\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b0a975fb8af9f10d\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"3b2d7dc50026509a\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"3ef29855dbd46b2c\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"849a9150b2f15d46\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a1e6a9e7018fd24c\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"01a2976f8a4d04c4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"9d84ad5ac7249b7a\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"a3f599e07b10a353\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6abb2e32c4026d6c\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"ec69f0eafa524c3e\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"856e95e8ec224428\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"3b08954e0080b1f1\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e38d651d7d88363a\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"08167039c816c864\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"b5a688f223bfb3cc\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"b0c20ae70683f049\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"bbac538177755744\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"5cdc4d8ad5524662\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"2ef3e249fb7ade40\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"a588f9f76b70821f\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"9b040d7316c84c1b\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c39fe9157cee7536\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"43393ba766dfd430\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"a631a71988b6c530\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"3baa77c7eac76ab0\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"22dbcba065aad16c\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"d4deb2a09a5edc3c\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"d3c7c80054488f61\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ea186918818d5941\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"50d493bace89d42d\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"04a75e3b07e53cee\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ae959ecaa4703918\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"0f6b4d0064881188\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"21e961117bdcb1d6\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"9a9b44355e46b444\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"43449f09f07c07ec\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"a2be556de9403157\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"833441f08dfa5255\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"969b3f7a406da066\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"083e2b07122bf5f6\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"e5f56ba8fc8ee998\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b5f3efe4237d6457\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e6438cae1d163c44\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"9ca0b71cbe20d785\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"c79580b0ad5bd158\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4798af0f006cb78c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6bebc2c467f760a5\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"059d98740a86ea94\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ffcaea0183177a40\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"ecc900abbffaea54\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"bcb98d5660468a46\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ef469dc44a1ec273\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"b7f185fc0d84892d\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"a688ac3d540c2613\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9aac8c94353e2db3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"bdb24dea9d9d7a92\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e04d67c818aff970\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a3cd4fb695d08428\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"5a347d6749a46771\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"c8d62b00b1d650c0\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6d3620176f177d57\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"01c99bdf505faa06\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"ba244e8a35b63940\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4036c302d50f7f07\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b94a6bfa979bfb46\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"efb1304ee54c55c6\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"0816beb709ce2e69\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"d6de8606fa26bb72\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"674d5a052088085e\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"f57139b76e976b07\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"5d15aa4fdb27e028\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"c1b0e554330dcfbf\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"d694fe75849fa782\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"a4a8536f3cedd863\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"977a4b8beb3f08f2\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"2e0c47666e346c73\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"f3b98bae3daf854e\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"a40480ab76440aa5\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"919c1b2464616f38\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3a54a9b8824265a3\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"f2eb01433af9d2ee\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ceb905e0fca469e1\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"6bb671078afc323e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f4e43a4c90ac2a1c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"e2c1f8de844e60ef\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"af6ad6b25b2d73a2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"382a8101b2eaa807\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"c086df69cf74fdaf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"4f9d7914221a2323\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"743b6a0d8340857d\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"02327e6008819ea3\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"01f03e8638ecd8b8\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"8ed2cae64e47ef7c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"101a290f546e3277\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ed9d4726e97f74c8\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"1ea3e03d89c87942\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"08ffe68b927a1c99\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"4147bbb90e8690f8\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"fe8a27fea01f12b9\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"ec76a4df45671b54\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"572770b0787f8496\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"dc73fb80cacea51e\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"97e4f1b7a330e3d1\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"4047d2e940e4e922\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"2d05314924a96924\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"1d3bae9c19618ed6\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"98395608a3ab4ecf\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"026ce9222a636623\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"f79ee81c5ec5314c\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"a5c81af425d7f400\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"c94e5dbc1aa810f6\",\"/knowledge-medium/src/plugins/tables/index.js\":\"4f081c3bd4776186\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"07f461d6f3df6c9d\",\"/knowledge-medium/src/plugins/tables/model.js\":\"034019c7607ac7e4\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"d1b07e46861b5c44\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"073d8db6aa12cc36\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"09a374ed7248f562\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"775117612473184a\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"a7cd9df1a6288fdb\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"54287b6704a21aeb\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"6aacd8f18899aea2\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"3e4121ebf47c6956\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"c5112ec3c434e429\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"161bc396858775c2\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"49b9c806ad56eba4\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"6b18e29accfdc75c\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"b954a7c1c739b11c\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"9392453bc7c86eb8\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"558fc0b29484b777\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"3a4527540489e525\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"261d03e5f30554f4\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"edc75f24a41a410c\",\"/knowledge-medium/src/plugins/todo/index.js\":\"4f0c24684d9e9c74\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"ea21da9a876b2700\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e286ac03d4fe3e92\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"97e87c9f18cc0a67\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"68691f3454adec69\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"b2c014f67125532d\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"a31686efe980c994\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"ea6c8ceea6af488d\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"42cade923de433ea\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"0b09684b0bf034cc\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"9594396f2c54f921\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"dfbe60e9c772d1b2\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"864ae128947958e0\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"475d3b04d3949b0a\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"48b90f0e1ba072f8\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"4fb830509d434d07\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"0d9a5db272d016d7\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"0e2c0806cf1379e8\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"ee5e403a2bbb9017\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"57733303bb0ff0e1\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"d7fe35c1314752f3\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"99fdd4fee8cc4b39\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"6a219f4912c1301c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"e52d024d45adf8e3\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"800f98658f14227f\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"0344f1b0773fe588\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d9bf39800f5450fe\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"25f745332b877940\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"e06ef8efd5cb2994\",\"/knowledge-medium/src/registerServiceWorker.js\":\"41ef9f20a2540f2f\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"85151b1f8b37979f\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"c23480a3d374ad9e\",\"/knowledge-medium/src/services/authStorage.js\":\"019198b456aadc92\",\"/knowledge-medium/src/services/powersync.js\":\"78e655956a73c600\",\"/knowledge-medium/src/services/supabase.js\":\"6d4fc287b35770e2\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"e38fb7a97a3b1678\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"2a78c0d4909afdf4\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a8a6175ba08794ea\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"c2ca2b3d72c185e9\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"cdba9f9a00598061\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"630224ffec960da7\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a2b27156b75e32b7\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"61d6bcecdcb0da75\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"14712f6fa0708fc7\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"4feee317d2982d9e\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3a387d0b71bf60a6\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"b5d8a8161d783229\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"f1dcf22d656063df\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"eda24caf99311572\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"067dab0ec15f7fb3\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"1d2c3994f51701f0\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"c8a00c4a3bb14b3a\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"8cb6e7458247b1c4\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"c185cd9fb4c27bc3\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"756de18a7b6af523\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"8145ed4c561d1e0a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"ff1ff093cf91844a\",\"/knowledge-medium/src/shortcuts/types.js\":\"50ae9bef9432b1db\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"34457a8cd489cfae\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"624ad55a9827ddcf\",\"/knowledge-medium/src/shortcuts/utils.js\":\"7d74f8115d929acd\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"59841732f958721e\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"abe4fea103ca527a\",\"/knowledge-medium/src/sync/byteTransform.js\":\"45c93afecd0024a9\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"4d78fa00fcfca238\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"2e641e32955b615c\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"70d2041ea3ee1e8a\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"f4585b331d3a4f4b\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"751b0a09c0793769\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8ef8d28b247a3d71\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"c4016e4ffb94ee9d\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"ff1f152db6dbb4f2\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"32f981906e3c2138\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"5b3a7ec127888e6e\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"b6a1611e70bc458a\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"aa231f1b72f40d31\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"bbf65aa1909fc5db\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"a3a8a6a7f4272926\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"e99ef86fb61031b8\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4f4bc1f550fae7cf\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"741ed12a843dabf7\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"8a4b5283ca1b5533\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"119289dad3ea440d\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"164386564c984188\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a3b2e4028f874465\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"a7bd2bc6ac9434e3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"caf9d7b53e222062\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9ad4199dfa8e6c1d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"caf4e7efaf573783\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5053dd9b318a3d89\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"541c93a6ad1c2df7\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"2ee984a819b2957e\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"95e676fee0b93fac\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"18cf9cc6ace69b9e\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d64e3b50810ee574\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"401a9e938f049d29\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"5fa9b5eab9e16ace\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"ec98948a6318c371\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"5fcec127cc7b186c\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"bd6b411731ff8c64\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3b8aa2ee85e47dba\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"acfe275739c79768\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5a1e5f4cfec686f6\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b2271951a462eb4d\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"28d31fe4f45db8dc\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"9e5a68fa8a5a8f3a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"5415555a261f19ca\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"bb45c6f24710f185\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"b8dfffc431c17ad4\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"06bb4e89208477f1\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"30f12d82aee8ff59\",\"/knowledge-medium/src/sync/transform.js\":\"1a352fe09d0b3316\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ef7e9775ac16efbb\",\"/knowledge-medium/src/types.js\":\"bc3fb76f8d0ce5c3\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"13e9e4bc1fc8c5e8\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"8a2db9956ad45fa2\",\"/knowledge-medium/src/utils/array.js\":\"a6641e263242389e\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"e930f23fc6f70a38\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"03798bafc84c881b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"ee58432589515ebc\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"ad0d90bda4ccdb4f\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b035bf4f8681922d\",\"/knowledge-medium/src/utils/clientId.js\":\"de2885a4b430dfef\",\"/knowledge-medium/src/utils/codemirror.js\":\"ed74e4d012d7977d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"3e109bcfa3652acf\",\"/knowledge-medium/src/utils/copy.js\":\"c2f470ed93a559d1\",\"/knowledge-medium/src/utils/dailyPage.js\":\"37f0682878f546f6\",\"/knowledge-medium/src/utils/dbForensics.js\":\"a29e73fa3e5e1459\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a879c3a5da2c2edc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"05d52d3183cb5d1f\",\"/knowledge-medium/src/utils/dialogs.js\":\"db19d0666741423e\",\"/knowledge-medium/src/utils/dom.js\":\"3ffaaf628caa8e7d\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"a6306eafd95b7195\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"43b40b4870c7d1f3\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"0650e6deb4ef3481\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"23b8bacdbfbf6f63\",\"/knowledge-medium/src/utils/flipSlide.js\":\"56372b751d79aed5\",\"/knowledge-medium/src/utils/fnv1a.js\":\"9f3e643e6f76cee2\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0e90ae687d895c2c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"c57a8de4493eb0c0\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"260a09be053ff537\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"a49e8da608083eec\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"aa918af595b4f2bf\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"b93d2350b890ff74\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"4321351815df0792\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"3ffc967be1e94df3\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"734008e076a84b8c\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"68416db2a628b1aa\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"4a45aa3081d33dd9\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"076cab6a8b6632dd\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"77ec52188d861a84\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"456638d526c4eba9\",\"/knowledge-medium/src/utils/markdownParser.js\":\"929724b70999256b\",\"/knowledge-medium/src/utils/memoize.js\":\"ebc6b6322cff5a3b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"8d9d2707f351fbae\",\"/knowledge-medium/src/utils/nameList.js\":\"fbff333bef33e600\",\"/knowledge-medium/src/utils/navigation.js\":\"7d8def5157e94fc6\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"5681e5a33fb7a35f\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"493520b446fb83d4\",\"/knowledge-medium/src/utils/panelClearance.js\":\"86feed55c7e82757\",\"/knowledge-medium/src/utils/panelHistory.js\":\"8e911b49117e762a\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4363ee3362a7ece9\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"83c0103e920b1554\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"5251115205eb54ba\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"feb86273bae9272a\",\"/knowledge-medium/src/utils/platform.js\":\"e2c7a236d01521ca\",\"/knowledge-medium/src/utils/pluralize.js\":\"0df21c42bcf98e11\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"9e9acca250681258\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"999cfd257d81a880\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"a4b84aff540d8674\",\"/knowledge-medium/src/utils/react.js\":\"393aaf416859aa2d\",\"/knowledge-medium/src/utils/relativeDate.js\":\"f001b3cf92d593cf\",\"/knowledge-medium/src/utils/relativeTime.js\":\"29a903dd4dccd648\",\"/knowledge-medium/src/utils/renderScope.js\":\"35f78977158272d8\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"d42466c64f8e6975\",\"/knowledge-medium/src/utils/routing.js\":\"31a3958de1f94dd9\",\"/knowledge-medium/src/utils/safeMode.js\":\"f815e25a9e0e5360\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"2fbd5252909147d0\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"c8587911c4fc1132\",\"/knowledge-medium/src/utils/selection.js\":\"71f7942643c5c38e\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"14bdfde5c180d22f\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"bec77653d4121616\",\"/knowledge-medium/src/utils/state.js\":\"a9ed8cd61e04a288\",\"/knowledge-medium/src/utils/string.js\":\"0325239805ea6b78\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"9894f38413e2e9de\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f4cdf68412621eea\",\"/knowledge-medium/src/utils/toast.js\":\"05238514745b8be5\",\"/knowledge-medium/src/utils/toggleStore.js\":\"e766e46a871b1d41\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"ab294f016dd5234f\",\"/knowledge-medium/src/utils/userActivity.js\":\"76b61f4fe806fdb7\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f0e1062729927719\",\"/knowledge-medium/src/utils/viewport.js\":\"a8218e7f7ad8c5a9\",\"/knowledge-medium/src/utils/webLock.js\":\"0fc2e4fd5bf454b2\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"d3937187cb78044f\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"9d74e5d10a5cef21\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"20f5cfff2cb08334\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b5835468a4781b07\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a41fdc509ecf7f95\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"650fd78bc8709b8d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"0b70941d5a105885\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"af6703ac0fb6f562\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"2aaf2fd7d46074f0\",\"/knowledge-medium/src/vendor/react-dom.js\":\"8e4a8cfbfb4c56b5\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"40bf1ca484c5aebe\",\"/knowledge-medium/src/vendor/react.js\":\"cef183f1d51f90ab\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
