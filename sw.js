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
		buildId: "75224f0443b9-37cda7a0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"c66cf8dc88acfc57\",\"/knowledge-medium/index.html\":\"c66cf8dc88acfc57\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DbbtfP1u.js\":\"c959d706ad5420f4\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"d8abd1dd076c35ff\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Pxg4RdTO.js\":\"25fc49dd9f1e2f08\",\"/knowledge-medium/chunks/FacadeVFS-Ds6__9KH.js\":\"8aa64b309dfe1a8d\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-LUmPH8uW.js\":\"e1eca707624f0d78\",\"/knowledge-medium/chunks/MemoryVFS-BUfrXvT4.js\":\"fceca6961f81fb8e\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DrnLNPyu.js\":\"bce5ebc2f6fea127\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-W_mXKOk3.js\":\"6f636808f9235502\",\"/knowledge-medium/chunks/Preview-CFM8rw-f.js\":\"10a99ff1f2da7ea6\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-PRBldtZY.js\":\"d4653ccd1c092afd\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-2Fb1f4Sq.js\":\"5b948cfdc64e6d60\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-1hwO9Qen.js\":\"b7059c1630609a16\",\"/knowledge-medium/chunks/react-CDJf2_nL.js\":\"841aea50f9a335aa\",\"/knowledge-medium/chunks/react-CcwnaFQe.js\":\"f7a9abe4bb2897b8\",\"/knowledge-medium/chunks/react-CdnLDJ1t.js\":\"12beb96220d77af6\",\"/knowledge-medium/chunks/react-DOTnTEP-.js\":\"5bccff09ca06af4e\",\"/knowledge-medium/chunks/react-DsqD8pzW.js\":\"e3f4f74be1c97991\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-3YT4Im_A.js\":\"469f6ddd67463974\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CZbW4TVP.js\":\"c6d62fc20f9bf24f\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Cdvu9Q-H.js\":\"d28d62beb941e1ef\",\"/knowledge-medium/chunks/react-nCOn3jFf.js\":\"a7832935c75c4865\",\"/knowledge-medium/chunks/react-tz7qGGuF.js\":\"dde0fe9d41e2267c\",\"/knowledge-medium/chunks/server.browser-CFVOKNR4.js\":\"3e30031aa6e053a1\",\"/knowledge-medium/chunks/textarea-CEOK-mtl.js\":\"e9cabfd774918dea\",\"/knowledge-medium/chunks/ui-B1qhtWh8.js\":\"de914ee5be47e922\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"025622fabff7d1ec\",\"/knowledge-medium/src/appUpdate.js\":\"ad17c9d8ebfbcfd1\",\"/knowledge-medium/src/appVersion.js\":\"92e29434153ff06b\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"0000bffb212a7e9f\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"87a183d2eba13dc6\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"5003a9961bfc880d\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"57b1334dca6b9c5b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"ba3ad8990a1ef26e\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"6b1ff3622ec73575\",\"/knowledge-medium/src/components/BlockEditor.js\":\"43bf935b1a211bdf\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"980280d4f76df20b\",\"/knowledge-medium/src/components/BlockProperties.js\":\"83545e4ef2abcbcb\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"717b44d8c173a62e\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"d181b63abc35c727\",\"/knowledge-medium/src/components/DividerHandle.js\":\"f3e22ec597a9d520\",\"/knowledge-medium/src/components/DraftEditor.js\":\"d1dd6081450291de\",\"/knowledge-medium/src/components/GutterPill.js\":\"d1b6223f88d643c7\",\"/knowledge-medium/src/components/Header.js\":\"37ba7c04cb0dbab2\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"2e0b7ec1beb8a24d\",\"/knowledge-medium/src/components/Login.js\":\"cab3dae681357bdf\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"2f1f35644d87d3f6\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"a5ad19d153a83f69\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a33858d3abf2d47b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ce48b5f1af0807a4\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"bae3148cd27873e6\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"aef69f7a76b2c4a9\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"e30cd563207093a7\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"28ec33d23860cc74\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"ac12547dc8251abe\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"89a0e7a96599efa6\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"a29e0d364610a044\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"6703ecc98adb6d7b\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6d77f5f666b5f4f3\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"ed9e398932fca08e\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"bab79690d8364765\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c015dc4efcda5068\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"c532284a283bd3b0\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"e6db0852d1e99fc2\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"9eb7463c231d81ff\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a5c50388baf07b81\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"8c4a25bf39f03a10\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"90ccebe734a73970\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7df2abf2a9a76a25\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"63e3b5c022fa2135\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"68e68ebb40805988\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7696b3cf2e2d01dc\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"1486d66f730f48e5\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"5514de1980f1b1f5\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"7e8659bdb0d5890e\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"79f175075fb9b6b7\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"5fa9ce666968b940\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"556ebaa8954e48a2\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"2175a392c4d0dd2e\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"8e756398353e0ef4\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"19fec6ba6773cda3\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"342ed794cc9bd466\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"309855e96bb1b990\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"3e77c2eea8a54775\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"fe507aca5a43bf5d\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c0e48cc75b304ee6\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"8f8d3747a7c9d95d\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d46af2cc4baaba59\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"c8ed4348697fe6b7\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"bd74dca8d76772a8\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"d101d7ef885fe9ab\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f33bbe4171b564f9\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"2bc49e46a3af7cb0\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9356a6ee159182e7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"5582bc53d0caabf4\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"d87715311eecdb6f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"7a04f2c750b1c306\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"88e8097340e9dedb\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"cbb050fd9a9d8728\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"b94711f8561d1a86\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"261a3ad96cb05d0d\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"a719660c3963afd3\",\"/knowledge-medium/src/components/ui/button.js\":\"c08dd78f545d81f9\",\"/knowledge-medium/src/components/ui/card.js\":\"3e85e61d951ceb8b\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"31996770207955c5\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"05fa8ad52331f8d7\",\"/knowledge-medium/src/components/ui/command.js\":\"1c0ab5190d54842f\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"a711c08e3a617e1f\",\"/knowledge-medium/src/components/ui/dialog.js\":\"c8974e8014c274b9\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c2ea9c48a0fe2fb6\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"aab9e7b0905f869f\",\"/knowledge-medium/src/components/ui/index.js\":\"0a1bcc287e6cfb08\",\"/knowledge-medium/src/components/ui/input.js\":\"0764702c426a9356\",\"/knowledge-medium/src/components/ui/kbd.js\":\"9bf080d29463aaf4\",\"/knowledge-medium/src/components/ui/label.js\":\"6456ad349141c588\",\"/knowledge-medium/src/components/ui/textarea.js\":\"7f95eba79e49ef43\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"687ad6da7c45cd46\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"93872d3eb8d222dd\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"018ec0dc8cdb2d96\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"d6b2f781a453ea57\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"c3048bb0aa2a0c66\",\"/knowledge-medium/src/components/util/error.js\":\"32afc4592322d0f8\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"207f15a28b068def\",\"/knowledge-medium/src/components/util/suspense.js\":\"8d10b9e3fd5b2e44\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"db2b43320e5c6fc9\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"6edcb35fc1e34cb3\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"adf0332a412121ae\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"ccab13723dae50fe\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a852240705216a21\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"c076af2cd37dcd22\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"b7a90a1160174041\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"6740a17f76ffa66f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"83154db794c43c57\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d9eacccf7ae05cd4\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"d2993390f89ad567\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"e1e63487c71bcde4\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"625327a71e1fdb27\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"0032ba8b42fab7d2\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c3fb1889277f23eb\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"b6bdb2dc6c58279f\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"2ef2a2ca12a94e97\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"55fa49ed31603da3\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"e121caf87fb5b0fd\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"c148a357b4174963\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"d953acafb4ab4f85\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"9eb1ad9617579dc5\",\"/knowledge-medium/src/context/block.js\":\"e9aecc64b5e2703b\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"145cfa0c812793d1\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ffbd2aca9a3aa6df\",\"/knowledge-medium/src/context/repo.js\":\"1b109e32ca8a757f\",\"/knowledge-medium/src/data/aliasClaim.js\":\"8be4336a3774e277\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"79e95843e278f075\",\"/knowledge-medium/src/data/api/blockData.js\":\"69f74dc2fb3f7801\",\"/knowledge-medium/src/data/api/blockType.js\":\"5a1656071026dbb7\",\"/knowledge-medium/src/data/api/changeScope.js\":\"7da1fb1b92ec5cdb\",\"/knowledge-medium/src/data/api/codecs.js\":\"5d201b8994ff17da\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f6e2e6757514e043\",\"/knowledge-medium/src/data/api/errors.js\":\"8e67c7b4f7c1d404\",\"/knowledge-medium/src/data/api/events.js\":\"96a04d0652358dd5\",\"/knowledge-medium/src/data/api/handle.js\":\"6c30553faa26b38a\",\"/knowledge-medium/src/data/api/index.js\":\"1f2f142e30cedd0b\",\"/knowledge-medium/src/data/api/mutator.js\":\"edcafbb6eaa20445\",\"/knowledge-medium/src/data/api/processor.js\":\"ea6e08f4b9a857f2\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"03e05e956ab4b175\",\"/knowledge-medium/src/data/api/query.js\":\"31c66a7e19dbe5de\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"23694ca521e94e81\",\"/knowledge-medium/src/data/api/schema.js\":\"6c30553faa26b38a\",\"/knowledge-medium/src/data/api/tx.js\":\"6c30553faa26b38a\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"ed7d1a94a06081cd\",\"/knowledge-medium/src/data/api/user.js\":\"aec1030860339390\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"b7788a179ac276ec\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"4daee9cbe40a26dd\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"21f2c9ef7f174e20\",\"/knowledge-medium/src/data/block.js\":\"0211551acb8dc28b\",\"/knowledge-medium/src/data/blockCache.js\":\"a2d0baf46fd8b57d\",\"/knowledge-medium/src/data/blockId.js\":\"e627130f793f52cd\",\"/knowledge-medium/src/data/blockLiveness.js\":\"e70885fb39ec72e2\",\"/knowledge-medium/src/data/blockMerge.js\":\"0fac314a9c8282e4\",\"/knowledge-medium/src/data/blockSchema.js\":\"f7717f9c5791cab4\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"2561f99f4fc5c69e\",\"/knowledge-medium/src/data/blockTypes.js\":\"d1bf9f9e1c7f4e4f\",\"/knowledge-medium/src/data/clientContext.js\":\"a993fb4187cd5fa9\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"e622a63e9bd9f5ce\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"1fec053792c52e7d\",\"/knowledge-medium/src/data/derivedIds.js\":\"9cf008d4524ef58f\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"c17f9b3a7d559822\",\"/knowledge-medium/src/data/facetBridge.js\":\"46386e03ee7cf148\",\"/knowledge-medium/src/data/facets.js\":\"7c01570887ab7e2a\",\"/knowledge-medium/src/data/globalState.js\":\"151b17446caaac48\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"a1f5a6c4168b636f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"90b0aa154167ed69\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a95b56afe5f32727\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"71784d8a06b6bbae\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"76e6af48d4540140\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"3e0ba91d181378aa\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"d4a5ed044d14a25c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"372bebe34d41d4e8\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"2fb85feaa8902dd1\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"6f76e411746c6a29\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"170d7f81824a07e6\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"3d94d811714e0d13\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"c1ac773415eb1c6e\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a50cea479f178af1\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"2a4406622f26ecfa\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"ac8c55823bb6adca\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"dfb623d7c4861fd1\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"3f0d2b80f4d3219e\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"074c5356d296a722\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"8f5e5e6f769cb18c\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"21e0de3e294fce06\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"2ebce9a980ff7e6e\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"077eed777fcd963d\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"9cc5098060b9770e\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9a2564a583d0ed80\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"906034578532faeb\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"a35d94d16c98ab36\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"a26ff25e69c86c75\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"5244803568a12f6f\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"94445f71fb436ada\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"f9744650d9f734ac\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"54ee9b92d89f9163\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"8b7658966c613898\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"c1a5802aff746334\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"eb61f1f51525660f\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"2f71cb1d38e98192\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7cae9f5c48540cb7\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"f95f71c2a2f06820\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"717219d02049b8b3\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d2eeac610d91f9e1\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"d2fe09bce8772f5e\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"389655dabe654fce\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"1361e039dc8c4733\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d50690c360e095b8\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0db2b37eae370e32\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"9ff288fcd8f32df7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"41fbe85ce329b00a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"609c1b89a2296e26\",\"/knowledge-medium/src/data/invalidation.js\":\"23d80abd58e97ce8\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"fe707186aeebfe0a\",\"/knowledge-medium/src/data/kernelPage.js\":\"2bfc196bcd2eaaf6\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"69a591b4dfc833c7\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"32ca18efe8b3b149\",\"/knowledge-medium/src/data/localDbStorage.js\":\"846322c89c3b3c43\",\"/knowledge-medium/src/data/localDbVfs.js\":\"8288ef468315c1f9\",\"/knowledge-medium/src/data/localSchema.js\":\"38cec68338b8f5ef\",\"/knowledge-medium/src/data/maintenance.js\":\"980196ad3ed30240\",\"/knowledge-medium/src/data/mergeProperties.js\":\"16788f23f9b28579\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e31c49bc1130194d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e3d5b9510a72e02c\",\"/knowledge-medium/src/data/mutators.js\":\"b0f9b10bfdf1fe5f\",\"/knowledge-medium/src/data/orderKey.js\":\"c810447f88a4ef67\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"cd41978a27d4db37\",\"/knowledge-medium/src/data/outlineSurface.js\":\"5bd51e36cb4a8291\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"aefd424b013a87d2\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"90acdfd507af0430\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"bb32c9ba9ef93214\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"fce818330f24e6dd\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"b5730551c62962d6\",\"/knowledge-medium/src/data/properties.js\":\"7c0d70e90768b3fb\",\"/knowledge-medium/src/data/propertiesPage.js\":\"9a7db276aadc53b6\",\"/knowledge-medium/src/data/propertyChildren.js\":\"d8675b6400d36917\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"fad1923c1ba7a6f6\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8c2a68b7f761d61b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1cdfd52061178966\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"1963048606555606\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4153e139eccd3ea6\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d993fece1836ff1f\",\"/knowledge-medium/src/data/propertySeeds.js\":\"3b03df27068372f0\",\"/knowledge-medium/src/data/recentsPage.js\":\"7f316c580e9f19f1\",\"/knowledge-medium/src/data/referenceBlock.js\":\"52d182c7f8f18c1f\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"2d9922e678ca833c\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"fdada789f2d4a392\",\"/knowledge-medium/src/data/repo.js\":\"e83e0be4cfe724be\",\"/knowledge-medium/src/data/repoProvider.js\":\"c84785fb5121b87b\",\"/knowledge-medium/src/data/rowProperty.js\":\"26a53f6995f61cba\",\"/knowledge-medium/src/data/searchFilter.js\":\"8f05ab8482e030a5\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"2a39042883216b08\",\"/knowledge-medium/src/data/stateBlocks.js\":\"eecc07aa8b8097a6\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9e0b824f2743af3f\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"8af4dd9afd553fba\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"256d18da32e1d8e3\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"aae2145480febdc3\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"ca7f617abe8dd8d3\",\"/knowledge-medium/src/data/targets.js\":\"82e877537735fc94\",\"/knowledge-medium/src/data/typeColors.js\":\"d567dfc896e0f3d8\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"c0b09e31adf1958e\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"37fcfe63052ed095\",\"/knowledge-medium/src/data/typeExtraction.js\":\"ffc5519bcfef66fe\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"51e80c11b61f70fe\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"d8c923df4d1bd3e5\",\"/knowledge-medium/src/data/typeSeeds.js\":\"8d567090013f1bad\",\"/knowledge-medium/src/data/typeTagger.js\":\"80e7f5d02acecc71\",\"/knowledge-medium/src/data/typedRecords.js\":\"35832f27a30c56d3\",\"/knowledge-medium/src/data/typesPage.js\":\"b79b4c9b5db8616b\",\"/knowledge-medium/src/data/userPrefs.js\":\"fd70862c56747cab\",\"/knowledge-medium/src/data/userSchemasService.js\":\"53aba6058c6e3307\",\"/knowledge-medium/src/data/userTypesService.js\":\"108df7ef6d2ce5a5\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6dff658dcc254f58\",\"/knowledge-medium/src/data/visibleChildren.js\":\"902c677bcdd8c2e4\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1548d6504e47d0fa\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"4e30defd510d926d\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"51136da925f5d069\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"cfa3472a26018bd4\",\"/knowledge-medium/src/data/workspaces.js\":\"a211e1fefb93c8c5\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f538be1452172b47\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"68fc5969587a0635\",\"/knowledge-medium/src/editor/atTrigger.js\":\"e761056ec29b98dd\",\"/knowledge-medium/src/editor/autocomplete.js\":\"a524753f0e6acbd1\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"695c47fe36317534\",\"/knowledge-medium/src/editor/contentFlush.js\":\"4bd0e689358dfb34\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"769d5f214579082c\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"78b4f6f8bd3afeca\",\"/knowledge-medium/src/editor/insertImage.js\":\"43b42c7afa8af78d\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"5596718dffaf00d6\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c98460d2e73e2342\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"24ec2dae123eeaee\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"7ebf43c4a2fdebc5\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"204951f835197e23\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"801b1cc5f5b7aafd\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"af1676de6e6358c0\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"9464ee182dcf6a5a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"94ef258ba97338f7\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"00745537b8bc5a28\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"ebeb193c0d0bbe0f\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"35b03b8935236c6c\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"704bffba87e8872f\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"b785f92bb2d6088c\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9449ec844d645aeb\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"58b9ad82e1829b4e\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"4045b5e6b335204d\",\"/knowledge-medium/src/extensions/core.js\":\"097a3d82eef473ea\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"4fb5a160083dd60f\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"023ddc6249c1a738\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d2aafbb18c2f7b1b\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"e70e661a76c00f58\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"21942141e9d0dae2\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"4ab53b38e48c4f7d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"477313e8075b2e02\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"216f2f3da4f08591\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"8091951e22e2e372\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"80874a138541467e\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"7ba72974f9af64f7\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"cde8878496acb0e6\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"33012201920b8d79\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"3847a3d24b03e28c\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"0a0b183cc385f4c4\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"ad4bc4c0a2c59199\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"ef763297377dda30\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3909c8394bc9f4ae\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"18a15f721cb12e1a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"57bdc6119a1145ab\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"24683dc3dcc66777\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"69f3240cfd918be1\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"0c7f0b0f9d60671d\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"09ca915e58531dfe\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"f71f56f8e8802bc3\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"3db8e395e02f0664\",\"/knowledge-medium/src/facets/facet.js\":\"a335799398e6557e\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"69835b2e36035fc2\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"2308fe97a6d7cc65\",\"/knowledge-medium/src/facets/togglable.js\":\"75a186f148154289\",\"/knowledge-medium/src/facets/variantFacet.js\":\"345c297f41cd5313\",\"/knowledge-medium/src/facets/verbFacet.js\":\"e7a5e6fc3fd3a382\",\"/knowledge-medium/src/hooks/block.js\":\"791d34f1a60a164d\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"415535cfedadb968\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"5208d7cb8d3070d0\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"86080bfd538a5dd3\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"465788c7926a8452\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"03f3794ac53750f4\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"e2747209d5346c2e\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"431e96c9c9032f24\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"3eb74bd5d5ac5120\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"c2ba8ac7d0f636a5\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"93ec74e78f07173c\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"e3b9b8fecfda4a3b\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"e428da3c69de8ae2\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"149433056e7f08c9\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"452ac34b199c728d\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"5d249918c46742fc\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3d0f1f89a22437ef\",\"/knowledge-medium/src/lib/utils.js\":\"4f722ba409b2ed8e\",\"/knowledge-medium/src/main.js\":\"efba78c1fcc2ebac\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"aba8e15ff504b336\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"043943bce48f8ec2\",\"/knowledge-medium/src/markdown/context.js\":\"c8a8e05426f492fe\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"de2d455627ac9bbb\",\"/knowledge-medium/src/markdown/extensions.js\":\"4ddf173b15dac6da\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"9b05df47dd57e16a\",\"/knowledge-medium/src/minimal-editor.js\":\"bb8161d8000f7ccb\",\"/knowledge-medium/src/paste/armedCut.js\":\"7b7ea24b05ae8bac\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"bbf9bbd4e673e307\",\"/knowledge-medium/src/paste/clipboard.js\":\"1137c48a5936ab05\",\"/knowledge-medium/src/paste/decision.js\":\"408dd27c3f5c65ec\",\"/knowledge-medium/src/paste/operations.js\":\"f5dfc3bb1822c587\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"31ac6ebcbc6747bb\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"57d0e471ab9d3b20\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bbf032b2e5045fe3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"7095b8658e8dd98e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"84046a360e291665\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"787b985920a02c3a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"d0db9922ee7b4e39\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4b9c9a5ed8702783\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"66865a0b77b7d177\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"45f028d55fb303c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"d919b11f1acbd7b4\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f0ca8f49a46de7fa\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8c075021bf4ef4d2\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"0c3e761f4d13b68d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"534b2a432b4d9058\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"3e749d5290842fc2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"af5f25aca5a71e30\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"735b1fe19c2c1693\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"e69507d60c0e12e1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"e650dc313e437c39\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"802e686abe1ae071\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d6cb5bdba424c06e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"acc791cae608902e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"715896773462d80d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"bcb1dbe86e5bf648\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"bfbbe96172d3eb68\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"629ae2a53993af02\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e43cc006cab69e3d\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"c4d5eebf95b3ba43\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"34e16afd184fab53\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"69f875b32b9808dd\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"5b1ce060c29dc290\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"039fa0bdbfbb56c5\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"5794136dd57cb405\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"3b2fc3ffce729514\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"690f614fa81bd3e1\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"aab3a2b7d7ef39a9\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"e28db995739cb28e\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"e2bffa2c9f641e9c\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"113607fc6e4217d2\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"debfaa1481fcbd25\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"80eb23f2c7baaa1e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"b86778e3a9feddac\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"51c43cda07965587\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"50b140cf03659416\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"9462c1c66a23e8f8\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"433855209906335c\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"2667fc15008d4196\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"5c1488bc1363f921\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"db028ae9bcc90a67\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"11d79306c7369737\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"56cc6d0a7b65654b\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"991a71dd06dd7fee\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"7d16714b05b778c9\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"ed8778813db73aa0\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"bc89833a99844003\",\"/knowledge-medium/src/plugins/alias/index.js\":\"015da5910c4954dd\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"5a3ab7949e4c097a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"7aa6147bf56fec71\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d06529eb30882e56\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"89b1037bed6e670d\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"175c71b3952a4bf1\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"f84b7790775efea4\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"ef6b66066df82769\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"518cecb9fed6f04a\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f0497ef123526543\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"f911a43614f99f44\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"81f0251e7d54a147\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"9ad177aaaf2fb3f1\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"28290efb5947fc82\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"a11dda3401465412\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"08fff763265c8eec\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"c50781aadefd064a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"74579f7a968ad335\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"b442ec8f2ad89da9\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"fce36b7affdb9029\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"06adca8f69013e21\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e7be439404fb0fe9\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"79f8fafbd6751726\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"6a81d1cff1fa1d4a\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"f527cd687c437c29\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f934c12da672c1eb\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"a99b9a3d21089acc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"2e9bb58ed1d61ca1\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"ae2b6a28fbf6bfb0\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"01e1699002b5532d\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"7d052ea503d840c4\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ffa82e6844a1564a\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"55a9ffc9c4770942\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"8dfc33625e3e9b19\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"ded6dc38182234c7\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a79ccc20836ec48f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"199b4fa296236a58\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"b563109430fe9580\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"ee5e871b406e15f2\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"47dae83ca3773006\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"8b2768cd22c34d5c\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6c33b74f7fb6d2f8\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"5894996d5f2bb712\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d146afafd86c3bec\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f3919c1dcd282d6a\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"8bba4dd8a39d9571\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"6083e97876b065d4\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"202adb7a997b62da\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"09d1ba3b81f80ab9\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"a21bf058e973ab54\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"666d9a0045221ff3\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"d9ea8e1b378fbcc5\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"6d7bb29327a02034\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"8e6e54b2528d0f1e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"3b5e5bd3842dbf4c\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"1883317fd5a2b7e6\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3f431e23c3de3dfd\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"766c912a8fcdbee5\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"047e50ade6cb9341\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"f57cd74b13a7d803\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e00c3256d5dd2ba4\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"e0de978632dddc3f\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"af47c9003fc2810c\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"566d4ce11b8e880b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"ee8741c3cc7e20ce\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"285cab13e155506c\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"524426d853bebf26\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"3f299cf5f0f09b7e\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9765975d6b991d75\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"ae6e3c603243707b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"2125dd266b7cac84\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"c7c86e3a2e9262e7\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"b38aad2f2e3d8933\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"3a78ac82986f1570\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"75a8ebff4d5a1da7\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"1af6a9629b5eefdc\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"fbd7ea8579125a3b\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"4d2cb9e537f52ee5\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"f8560722b514313f\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"795819a67a020958\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"d5d45645f1b2de6c\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"f50b7cb403d7cbec\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"679873245a44c229\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c143eb708989b37b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"0e6f7f4c543b63b5\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"449a49d200b38732\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8393f2ab3235fa95\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"2171eceac3eed9a6\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"492edfda83477441\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"e6adccc41fcec5f0\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"95914d44e0767fde\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4a9d646c4fa74598\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"7d872cf3bfc41c8b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"57414fdf76322871\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"7837baf348694a25\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"dca7b8188be61377\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"5b879c72390e83c0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4134151f03c93747\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"429f96c68a746835\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"a60d433d9a0fb7d3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8cfb5362e95a2ecd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"fad12b43e15641d8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9cfb2dee0cc4bbba\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"65c79acf3f2c98c3\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"14c137e940cdef7f\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"fb5623908cba87d8\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"abb2cdaa63276906\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"e06a1370f020cf86\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"064053a9656cf7b1\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"6e643f63e2505c86\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"66d8dcae6d60543b\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4b4a013e5c956e78\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"f985a885af455f94\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"23c3a2b04cf5cd9d\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"4a56e3ef73ba546f\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"b980f6f65baa447d\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"51346a2bad4acf6e\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"f5c2d0075e9ee327\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"f5cf63856be8c4c8\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"3a8474c767b276e5\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"76a4e552cbedffd0\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c165379ee8996955\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"5796e25bd8b17a1e\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"039ffa56b79ae76c\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"0473132f8dace50a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ff39bc3aac853215\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"9c5e12abb00dd633\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8bfca3ea50a6bc7d\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"84d753594e4ef174\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"cbaf018de2e6600d\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"7f342def60de3e3e\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"afe4b44418486e7a\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5d844b9d834c0f17\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7d0a7a4cd4c32557\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e7c7914c77ccfae3\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f0283b71ae4ac8af\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"668be7dd00194912\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3e76ee3c0ad907a7\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"872beb9234efabfe\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"90044b8753364a39\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"d961f978e5a2f0ff\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3e5e0be21f9c7d57\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"5b2795071e943fd4\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"4beac08d1ee5d048\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"adae8c25f4e44a3b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"e83fd4b462a1aabd\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"7fe78bbacc352262\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"bcf83631cb177fbb\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"a823adabdbc70bb5\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"40f85af7bb375a1b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"99ef47c01266f467\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"2ad45d49b9c7822f\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d86361fff89337bf\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"8c305e57e67d98ac\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"915ca7b7d8744aa9\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"f8e7a46e9dca8188\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"30f99e7412ea122e\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"d251a3b18842e4a8\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"c2ae5aeed28d449c\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"8929bbbccb75ae5f\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"0ec56445435b17a0\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"bfddacae31643835\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b45993e16a9313fc\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"15288825520f21a3\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"1a5940e0315ea2d6\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"b691ef4b0f4acbb2\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"8c2c35cade4479c1\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"65bbdca8a3e7f9ec\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bb075997c74dd518\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"72c4d8c6c782853e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"847bba2b15edd207\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c92e18e2b2ff7544\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0ec57d5282a64a17\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"178cb64de27b6394\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"09534235c98cb8fa\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"38c639065b7356bf\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"90f00129b832fe15\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"a35c38261cec9257\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"f9d08144724f333d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"11e6cd8d2ace92d6\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d106b13911f1ed12\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"a028bb4cb47468b2\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"d108015f435b52de\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5bb1026b1a303f87\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"19a1ce2a4443eeac\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"e7b592919fa2ef85\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"35b60a0314895c38\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"be02ab7ef0ae982f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"70d5e50c368e3c5b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9612a70ffc30aa3c\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"d4cf62cd4e59a8bf\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"8707b39768f758b4\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"a2dee20d50c0b4e0\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"ad1c76d955c116b4\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"bd58514ef9d13fd2\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"26bbadc21f6036ad\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cc50278bfbfcad2f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"c4002f1d8d605fe2\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"1cb8606936d8cef3\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"fcf1df42bd2d090f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"4912da9cb91fe09c\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c034ca405f168a18\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"278e27ba840ae49e\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c86ccf0adbed433a\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"28e72a9b44b49464\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"419c8d07a9bd2cac\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"b5a7b2085f85cee8\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"97198b393945f938\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"322d4a1d12d74bf8\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fd3b9fa3b5310b3e\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"c14957083ec9b182\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"734767edb6107161\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"6b579383409af1b5\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"dd4d47c6e4be0836\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"3d83605fcada2c32\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"03e5a1de117b52f1\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"3a74ffe5ed713a4d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"95711db8b6400fb5\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"5d60ce8a62beb880\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"af7bbad30d97e537\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"382e27bf6aea9120\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"78fba32b842262b4\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"42c553339cd13fb5\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"a6dc09c938379726\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"019ed8a2f1b89fe2\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"94be316dc020d63e\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"63537aac9ed3e0cb\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"45ed30cc1947cb45\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"3f80d34479a30b85\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"dad95b3bc84e3f0c\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"23529a2ced5002cb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"75c0c80f775fe820\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"d8731ea0b5a92aa9\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"1f19cb444bff2f17\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"0e04ab69e2ba1cd1\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"ccd1ee3123245ce6\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"2c8d4c6841f4c140\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1d28b469bfe4a395\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"54def1561cdd9371\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"ad9a87c262640680\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"30314f96e2dbc48d\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"e73293b848912847\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"847436ec4cc9b7dd\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"cd93464cd7a17c55\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"01d5a105bf8b6261\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"abbc636d813c2557\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"3ca5fef276e30a25\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f134dd53611d3afe\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e0409a33cee7916b\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"c5b580632bdae3f8\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"e93e850406df3304\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"fcee295dd1088ee8\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"cab539ef89f0fdfb\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"788f8f5aca3090ea\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"db0985ccbd70696e\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"2ef0719e3177d359\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"be0704643a82dab5\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ab47fe0469e55235\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"a861f91b31be84a3\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"3a561d1cc0075679\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"62689126e4d92d06\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"51b3e7d1abdd8e31\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"321fd974205e84d2\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"9a3f5c8352c8ba1c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4515e1aa67c65bae\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e8fac9cc7b142cb2\",\"/knowledge-medium/src/plugins/geo/index.js\":\"07762aef4e44cdc2\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"5a749f6dac354c39\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"d24fd7e4d9b93fdc\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"487187231830c61f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"32db17311d8a2904\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"f5b4f8b7fe3a0f68\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"f519d1ea192c5b66\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"4d9e9e33e5e8d565\",\"/knowledge-medium/src/plugins/geo/query.js\":\"8e2931916b4e8c80\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"207520a01a478a4c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4c09d1eee7ad2ada\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"744b2395e2740937\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7ab46a2b8d7ba210\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"a4b2a0f6cdb96327\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"cf061867248d5076\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"6a5eeb41fee5dde3\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"9d8fcac21914a3ec\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"d90650d9f01b62e5\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"48a0a44276460eac\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"637792495805ab8e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"d22475088e0e07b4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1efbf949b5310fe3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9632d264b1929dfe\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"01e185b1a755f549\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"1b64dcf23c2598fd\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"13866fe55c03b430\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"b9f8cf23912246d8\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"14ab23982bd181c0\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"1e9272c8f544e3bd\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"9ade758cd9ff441a\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"22b3b3c00ba16532\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"f1484235f7162795\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"7e0cc66398cb6caa\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"ca17cdace5039239\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"5ea0688570e61f24\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"a966eb6fd1e84a18\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"f371763ce8bb1ad1\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"cc6986621274a4be\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"776ce0aeea39377c\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"ab56dd2d9fc83d5c\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"31687440ccacfc82\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"ab5a7455a20ce32b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9df9bef750c4fac5\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"913846213b83d6ea\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"e06772850a5e3677\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"14df38f1a22ecc0f\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"977f0f418d43e746\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"b356e28e322f2a0e\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"cc451d8a722d8c6b\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"ec73ab4b13f82ffd\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"0b689993e421d634\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"03b4be1418c58a34\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"c055ec83444ee7a3\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"1e29bcb800099f0f\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"2e61dfc3e7992f77\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7bcde2113384b934\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"eba5e355e271548e\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"3330746cc270bd7b\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"2448a1232792557b\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"7639a8e396ce1e26\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"e4cdf7989631aca1\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"1c141eca0094e0d4\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ec5303c8cef47018\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"86881b1d1fd71dd2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3d70e5f0f5b96c2d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8a07a58f2bdd0f0f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"aa3c746c92bb1763\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"a793e09c6b6b97f5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2097dabb78e21c33\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2db5236f80d23ede\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5f1b0b07c6d5bfac\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ad187e91349b7120\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"5c9ed5acd9c347d1\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"119b23e08d15fdf7\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d3b53a59988d7763\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"dc890714b800be77\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"3b325c7f8604fcd3\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"97a4a1db5c65cead\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"2445e0fa9d278dcd\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"2abbe3b1ae44c61d\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"0d54fdca41d12898\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"28ac16706525c23a\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"07a3765f86af1060\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"41fc615b87729070\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"feed7590bd826b36\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"25713bc8b880ac5d\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"806ae2b201104556\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"b5e5a34319b65287\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9a3fff5014c6c0cb\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"589855ef2b1e2c1f\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c6a4b6364f8a470f\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"99f468ea40d1fc34\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"677904908b23aad4\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"ef88567a969ef54b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"5d9a2d5ea26ebeb0\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"fdc3be4e9489af11\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"f804a3d4461bf6d2\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1289657ca15dea95\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"b6747e49742a4649\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"8898726db8233587\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"1113bd352a8ab309\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"bcd8c3221ef78abc\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"d2aa810084cda52e\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6b373be6b2cf5f6b\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"d7e705672e855750\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"51c9943b0081f5e9\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b3e2c8a55f1e590a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"a42438f2ebf30ae0\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"6c65820cc04fd3d2\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d6db0477fbff4426\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"ecedcf0c78f3ac4d\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"4954e2deecc789f6\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"c17e4c271a757872\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"0d29b981935ab201\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"f2cfea0811f2ef78\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"02b001ad9fd2e1e0\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6c3b599d0232c23b\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"f20fe15ae012f3ff\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9ef325ee125c8a36\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"747f9bb408ae6548\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"e4374273fd859508\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"dc1a8a57b1270a9c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b66a3600f97b589c\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"e9af3ef746dfd748\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"99026d9a1f7294b9\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"874878059ce69c17\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"b4beed521957c7ed\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"5e4ba217c1f206d1\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"36967185dfd27af3\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"05cba418091766f9\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"356594685ca330fe\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f7361765b2b03222\",\"/knowledge-medium/src/plugins/recents/target.js\":\"7971fddb42a6e060\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"0faf41a431026317\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"f8d96c566fd2405b\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0c28ffe15464c16e\",\"/knowledge-medium/src/plugins/references/index.js\":\"cf33867958d84b60\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"87fa89a31c47e4e3\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"ce4a71d593988b6e\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"40cab656d0b9e04f\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"6623be42e147f258\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6dd9627d08328219\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"99d83f2f9623f78d\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"dad209a023df138a\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a6bf38c2b357d75a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3239d507268be389\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"90c1768ff57aaf7f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"396a4eb99c85403e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3fe1afeba6058c9d\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c2a8f9a880630599\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b4a01f6fdb8b1086\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"baade0c0dc9207ae\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"199e6bec2ee202f4\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"cd88d8acf4606343\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"e71471925c97d548\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"7e96a7de65e8aa6d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"710ac5cbe471b7e8\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"ff7a67a7bc79a70e\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e50111f3fa299651\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"9fe4701737847e9d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"999c0c6740ec5920\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"05c53e24f81177fa\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"73a4028624285acc\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"0ef204d0fdb66295\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"d712f9b23985b25c\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"657d5082d839f458\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"9ec0f0dd9deb61b5\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"28628636b71b095e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"56decc569de87196\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"ac56d2fcea948f96\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"436c966e113c0550\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"e96a1db6c7682142\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"b2e73b3ff5eb561a\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"cda8ddcc530ae4ae\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"54cf7adfe86c90de\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"00237668ab123023\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"7d3ba0fb4481844f\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"e62d7dfe61dc845c\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"0bd4220e35bd6f9c\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a4394ad5b43e33bf\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"9ddd28e12fbfa007\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"40bf848a3a126f90\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"5fd50bfcaa46eb45\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b05dfaf9717b99c8\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"f2232ebde0cbc686\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"b45538507238f601\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"d6d418e2b49d01ce\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"465e1188f585ec75\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b6f58b9944671e00\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"50d871bcbdfb46c6\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"9c8924f1dc482887\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9b073d9a8271598f\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"06f404259ff241d3\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"db4bafa262083470\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"919a37dce195d5b4\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"362a7a9451309e42\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"378f025af74c5f52\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"15b7c668e7d7f53a\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"da016a97feb4b16f\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"32a1dcd1d36424b6\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"3eb690d662c14ec9\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"93addc4c5b0dbe0d\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e33d34373f215243\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"c7e9de6c12daab0c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3b24e665983d4f18\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"ae5068a2ba9ca885\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1a38c9c982b5e24c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d543bcef07f4db24\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"a495d413477b3098\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"97683019c6265ff5\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c40fce097b029571\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"92015a049bffa18d\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"8c2659c525db428d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"779efedfd8eec38c\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"402e4a77bbe4ce6e\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"4998718721163b29\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"83db86247d7b5cc3\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"40dcc059b6992c33\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"5c7363e517e56d8b\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"d9f69f7101fd742e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"de04abf75fd8ecb0\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"a11a62be520ba499\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e50b1bbc8b32e6f1\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"f085c8ebb4a943d1\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"f3a2728ab4813c6b\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"21adad4053392bf4\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"91df40a72446cde6\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"3e5a598f916d9645\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"6fc0e1b15ef1b8d3\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"64dfaef73e48c2d3\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"17e1dc1768f8fade\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"b1cd54362bb21f80\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"21a89b62ac998b73\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b66d4f194d5d7797\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"018093ed36278cef\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"d36afb765c4346c9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2518d3c9c5099a70\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"852f4b9ad06798b4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"416832b23a09e3d2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c6e4b02b76d187f4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"05c76c50da9285a8\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"a86a74b7634b4164\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"44a6998b158f5393\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"c707df02d7c2238f\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ca05e828ef449795\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"3940282050daa8be\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"a460cce628d40141\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"bb748f9d2c2e4207\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"babb619da4dfb376\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"23951620ca472372\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7d5cbe6daae1e407\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"8440cdc17e4f121e\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"6206e61faa92c906\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"46b2efe11f7de091\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"92afb3a66fa87891\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"cfbea77782688267\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"de61619b549f4489\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"4e53a088c320de3f\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"900b03e2c5144de9\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"f9a5e29e83cfe99e\",\"/knowledge-medium/src/plugins/tables/index.js\":\"542cd4d6fd0f14a7\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"032601ffbc803f91\",\"/knowledge-medium/src/plugins/tables/model.js\":\"ff38f2e23fc0bad0\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"7672cfc20736c38e\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"9c9d550f0eebb120\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"fa5239fd06cba013\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"14adce2088dd15be\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1d211ebdb7f5957e\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"5d2df30e1de63c66\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"a4d5533fed7d881a\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"ae79de6262132175\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"19e6514cf2c67eec\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"f40564bada59e679\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"60013ceefca9281b\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"9b191d319f0598d1\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"07dc6a84202f7864\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"4595a7e394194292\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"f938cbe92732533e\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"56f7129e1d0ee713\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0bc1e1add9afb37e\",\"/knowledge-medium/src/plugins/todo/index.js\":\"1a3413cb23258cde\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"b85292a192823729\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5f5f85493f02f00a\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"e813b2200d23facc\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"1de8942bb6903611\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a4882c3d805bd126\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"5f595a330f34494e\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"d585dd9794d0914a\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"0d3a33d9259884b3\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"e21eb114a28a6e21\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"74d779810b71af01\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"3ec541796211e781\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"e835dcc12ae1ffdf\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"ae8bb03974086b18\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"2257b4e39ef10e87\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"8efc3e2a72904bc1\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"1a519512d3be688d\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"c2e30706960767ca\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"e4b705530312d596\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"77f6ffef2c4ec3e9\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"6926723fd541b5b6\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"f521f4f99d53ce99\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"9a7930fc96361e64\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"2ba8fed710475b65\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"67e0034cabcf524b\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d99dbb8a9f7d9006\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"34129f684173e0b2\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"2054e226fc0c769d\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"1b57d56261ab14b4\",\"/knowledge-medium/src/registerServiceWorker.js\":\"c5bee82102d12dba\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"b621440dc87be65c\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"b95d445d250a72f6\",\"/knowledge-medium/src/services/authStorage.js\":\"24d4d793814be9ec\",\"/knowledge-medium/src/services/powersync.js\":\"9ac4ebc3163f5157\",\"/knowledge-medium/src/services/supabase.js\":\"ca5efcebefc42311\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"216a1f6da96e26b7\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7b59630476375730\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"9d69eb9c613ddbbd\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"82b76613250a0183\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2fedbad2ecfdf5c4\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"0af2d96fc4940845\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a5cee7fcf7ba01e2\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"6d6ebe4d848b7c07\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"cb1802cfcdf177ac\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"436fd8f5e53d0e57\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"9be7602d5ef337a1\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"e650d1ddd788abd1\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"304a2aaa6ca59502\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"950495cb309d4759\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"46258d12eacadefc\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"4382599b8ecab289\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"3fe4551c3b9fe899\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"2b52bf2f6c3ce8ed\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"ad32655a8a007daf\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"a3c42ac3fc5a34e0\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"9d6c36d056699d6b\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"f49ba568e5952626\",\"/knowledge-medium/src/shortcuts/types.js\":\"5563c3b5c826a3d8\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"43106bdc5037c246\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"1bb169b974143687\",\"/knowledge-medium/src/shortcuts/utils.js\":\"61349cfe1c8240b1\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"69b5fac632641af6\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"cff8220624a82a86\",\"/knowledge-medium/src/sync/byteTransform.js\":\"1dce35bb1b7b5f3a\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"3b05479b84985707\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"7933860a2a3b5b69\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"92ad4639d48df820\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"90abb9005d62c87e\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"534bdd93bb04bff1\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d1581f8c2b15720f\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5bd5d27b57a9c30b\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"54987459db01b7b1\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"1436307460d2da2c\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"5b1ab4ca10c8c29c\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"fb74b9eb1c1bead4\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"ece35c4cfef6ace3\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"2b752c3fa1911abd\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b3a78e6e71a15ed5\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"773a5fb3a4ded95a\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"2723fecbecb68997\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d4e92d6ff2ee1dea\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d4d439806cb75194\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"effbc9fff814eacd\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5a2eff576b381446\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"fef908fda1352ad0\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"54593175d64ee651\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"37cf2cb59a10127c\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"e73cf0110995a302\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"39bbf233838a12e1\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"c9d7ff257dba80e3\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"207d3aa46c8ff17f\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"faee696fef8e6779\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"cff7e85d8b9e7ed9\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"33909f7edf04a096\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"7e6814d3880a6737\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1fffb5cd9dbcb612\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"32863d8c07ff44ef\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"33bee813529267b4\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ef3d4863f01876bb\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"449514d64c1693e2\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a1be3c6f94e2ab49\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"1b2523be71ed9516\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"80fd53289b3d4bc4\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5c24d15c3620c84e\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"d0383a4a2b11812c\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"d59f0c4643d9c084\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"a8161d509d2cc6be\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"628300cf79e6c6ec\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"9114c00a933f8598\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"f24049bf2428861a\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"ea59ed1581deabe7\",\"/knowledge-medium/src/sync/transform.js\":\"95582fb7d39725b2\",\"/knowledge-medium/src/themeBootDefaults.js\":\"a1cd5de07ca796cf\",\"/knowledge-medium/src/types.js\":\"bccac7e5f9e049c7\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"7dc6012f75a18b4f\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"a972edc880847bab\",\"/knowledge-medium/src/utils/array.js\":\"92d4c65cb6f0fd84\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"79f6911ecc755742\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"6eb1c4931ccf9c7d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"4d0bd84d00db2259\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"359da0ebb0313dc4\",\"/knowledge-medium/src/utils/callbackSet.js\":\"92bb5ff6ddbcffd2\",\"/knowledge-medium/src/utils/clientId.js\":\"82498ffdad1d942e\",\"/knowledge-medium/src/utils/codemirror.js\":\"d9d3ee2fff3807ea\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7d8d57a875116025\",\"/knowledge-medium/src/utils/copy.js\":\"40ac3b01e7b79af0\",\"/knowledge-medium/src/utils/dailyPage.js\":\"c271ff9badcab1ba\",\"/knowledge-medium/src/utils/dbForensics.js\":\"b1c0b871a37261f2\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"68b0574f1e5a3ccc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"cfb976a90b6f0666\",\"/knowledge-medium/src/utils/dialogs.js\":\"fcbf873b4fa453e3\",\"/knowledge-medium/src/utils/dom.js\":\"9c6fd771cd335a44\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"039c925652e3c627\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"fb6b919c67380fc0\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"2a089fe0cb022496\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cdc8484e382a1d40\",\"/knowledge-medium/src/utils/fnv1a.js\":\"0674331390bd219e\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c92bd6d8a22a6137\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"42b20ea4dc8e4745\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"eb3c00d0cc0e3019\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"4c7fa17d257b6c97\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"660aa909b0540974\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"067cfbe5839fada7\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"1cad717c9306aac4\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"ab68913c5018ee13\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"3fcf20bbb57bb99f\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"b1e55bdfaa61a660\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"a5d2d640983d1d0d\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"eba9267e6dc49531\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"bf5639ede4404a03\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"5d5ed200e3610fef\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ab9eb993f7266185\",\"/knowledge-medium/src/utils/memoize.js\":\"b2b726086555fbcf\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"3f9b764b6223ee7f\",\"/knowledge-medium/src/utils/nameList.js\":\"a82573c23d29663c\",\"/knowledge-medium/src/utils/navigation.js\":\"f8255005a4f0f903\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"77b1d43e3f8b8816\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"873a120b86258069\",\"/knowledge-medium/src/utils/panelClearance.js\":\"1d3ecdd51926dfee\",\"/knowledge-medium/src/utils/panelHistory.js\":\"4840a6727149db53\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4514dd2244ffd0b5\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"5e558530f9e8e99c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"fff15968675fcd93\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"3f155f6ce156a27f\",\"/knowledge-medium/src/utils/platform.js\":\"0f8e45ad11872a99\",\"/knowledge-medium/src/utils/pluralize.js\":\"ad10248581cc12b6\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f756045a87a0066c\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"9e347fce02e3ec6a\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"a066abc63ce00dcd\",\"/knowledge-medium/src/utils/react.js\":\"167835d312d16717\",\"/knowledge-medium/src/utils/relativeDate.js\":\"8f58d36738d7064a\",\"/knowledge-medium/src/utils/relativeTime.js\":\"607d6849199693d3\",\"/knowledge-medium/src/utils/renderScope.js\":\"91b1e20782f3c80d\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"5c6026bc2e4626de\",\"/knowledge-medium/src/utils/routing.js\":\"abcf26c79b9d7781\",\"/knowledge-medium/src/utils/safeMode.js\":\"a188c8db9f29e869\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"3a85988746a5305c\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"4ef8a59986107021\",\"/knowledge-medium/src/utils/selection.js\":\"5e37ed6665e72ed9\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"5bade6986ba10d06\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"17ac8639e755f6d5\",\"/knowledge-medium/src/utils/state.js\":\"a84cd79205274e54\",\"/knowledge-medium/src/utils/string.js\":\"0015409e04d5bec4\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"517053278ec559fb\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"e7f35e26cbac77c0\",\"/knowledge-medium/src/utils/toast.js\":\"39b7e9382d45246d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"1f4671de97c584e5\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"e69812315aa0c0c7\",\"/knowledge-medium/src/utils/userActivity.js\":\"274fffd76d3bbf57\",\"/knowledge-medium/src/utils/viewTransition.js\":\"2c2701c7d3b61656\",\"/knowledge-medium/src/utils/viewport.js\":\"5020b86d56f3e08a\",\"/knowledge-medium/src/utils/webLock.js\":\"c84536c5786dd3a1\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"765df10921a763be\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"9c56ee05b538fd25\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"ddff949a63c0c9a8\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"af8d8d0a7d53c0a2\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"2f3f3db44be897e4\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"ff14288f45a76f29\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"613d60930d8073a0\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"72fc885d64a37fc5\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"184514f0a76e7a7f\",\"/knowledge-medium/src/vendor/react-dom.js\":\"f5d359cdce82da7f\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"e6c105956c9299c5\",\"/knowledge-medium/src/vendor/react.js\":\"e0ffc21166691e6c\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
